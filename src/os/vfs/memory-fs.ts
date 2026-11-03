import { basename, dirname, isInside, normalize } from "./path";
import { FsError, type Entry, type FsEvent, type FsListener, type Origin, type Stat } from "./types";

type Node = { kind: "dir"; mtime: number } | { kind: "file"; mtime: number; data: Uint8Array };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The project filesystem: the single source of truth that the editor reads and writes.
 * The runtime bridge mirrors it into the guest OS; persistence mirrors it into IndexedDB.
 */
export class MemoryFS {
  private nodes = new Map<string, Node>([["/", { kind: "dir", mtime: Date.now() }]]);
  private listeners = new Set<FsListener>();

  subscribe(listener: FsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: FsEvent) {
    for (const l of [...this.listeners]) l(event);
  }

  exists(path: string): boolean {
    return this.nodes.has(normalize(path));
  }

  stat(path: string): Stat | null {
    const n = this.nodes.get(normalize(path));
    if (!n) return null;
    return { kind: n.kind, size: n.kind === "file" ? n.data.length : 0, mtime: n.mtime };
  }

  readFile(path: string): Uint8Array {
    const n = this.nodes.get(normalize(path));
    if (!n) throw new FsError("ENOENT", path);
    if (n.kind === "dir") throw new FsError("EISDIR", path);
    return n.data.slice();
  }

  readText(path: string): string {
    return decoder.decode(this.readFile(path));
  }

  readdir(path: string): Entry[] {
    const dir = normalize(path);
    const n = this.nodes.get(dir);
    if (!n) throw new FsError("ENOENT", path);
    if (n.kind !== "dir") throw new FsError("ENOTDIR", path);
    const out: Entry[] = [];
    for (const [p, node] of this.nodes) {
      if (p !== dir && dirname(p) === dir) out.push(this.toEntry(p, node));
    }
    return out.sort((a, b) =>
      a.kind === b.kind ? basename(a.path).localeCompare(basename(b.path)) : a.kind === "dir" ? -1 : 1,
    );
  }

  /** All entries except the root, sorted by path. */
  list(): Entry[] {
    return [...this.nodes]
      .filter(([p]) => p !== "/")
      .map(([p, n]) => this.toEntry(p, n))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  mkdir(path: string, origin: Origin = "user"): void {
    const p = normalize(path);
    const existing = this.nodes.get(p);
    if (existing) {
      if (existing.kind === "file") throw new FsError("EEXIST", `${p} is a file`);
      return;
    }
    this.ensureParents(p, origin);
    this.nodes.set(p, { kind: "dir", mtime: Date.now() });
    this.emit({ type: "mkdir", path: p, origin });
  }

  writeFile(path: string, data: Uint8Array | string, origin: Origin = "user"): void {
    const p = normalize(path);
    if (p === "/") throw new FsError("EISDIR", "/");
    if (this.nodes.get(p)?.kind === "dir") throw new FsError("EISDIR", p);
    const bytes = typeof data === "string" ? encoder.encode(data) : data.slice();
    this.ensureParents(p, origin);
    this.nodes.set(p, { kind: "file", mtime: Date.now(), data: bytes });
    this.emit({ type: "write", path: p, origin });
  }

  /** Recursively removes a file or directory. */
  remove(path: string, origin: Origin = "user"): void {
    const p = normalize(path);
    if (p === "/") throw new FsError("EINVAL", "cannot remove root");
    if (!this.nodes.has(p)) throw new FsError("ENOENT", p);
    for (const key of [...this.nodes.keys()]) if (isInside(p, key)) this.nodes.delete(key);
    this.emit({ type: "remove", path: p, origin });
  }

  rename(from: string, to: string, origin: Origin = "user"): void {
    const src = normalize(from);
    const dst = normalize(to);
    if (src === "/" || dst === "/") throw new FsError("EINVAL", "cannot rename root");
    if (!this.nodes.has(src)) throw new FsError("ENOENT", src);
    if (this.nodes.has(dst)) throw new FsError("EEXIST", dst);
    if (isInside(src, dst)) throw new FsError("EINVAL", "cannot move a directory into itself");
    this.ensureParents(dst, origin);
    const moved = [...this.nodes].filter(([k]) => isInside(src, k));
    for (const [k] of moved) this.nodes.delete(k);
    for (const [k, node] of moved) this.nodes.set(dst + k.slice(src.length), node);
    this.emit({ type: "rename", path: dst, from: src, origin });
  }

  /** Replaces the whole tree without emitting events (used when loading persisted state). */
  load(entries: Array<{ path: string; kind: "file" | "dir"; data?: Uint8Array; mtime?: number }>): void {
    this.clear();
    for (const e of entries) {
      const p = normalize(e.path);
      if (p === "/") continue;
      const mtime = e.mtime ?? Date.now();
      this.nodes.set(p, e.kind === "dir" ? { kind: "dir", mtime } : { kind: "file", mtime, data: e.data ?? new Uint8Array() });
    }
    for (const p of [...this.nodes.keys()]) this.ensureParents(p, "init", true);
  }

  clear(): void {
    this.nodes = new Map([["/", { kind: "dir", mtime: Date.now() }]]);
  }

  private ensureParents(path: string, origin: Origin, silent = false) {
    const parts = normalize(path).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts.slice(0, -1)) {
      cur += "/" + part;
      const n = this.nodes.get(cur);
      if (n?.kind === "file") throw new FsError("ENOTDIR", cur);
      if (!n) {
        this.nodes.set(cur, { kind: "dir", mtime: Date.now() });
        if (!silent) this.emit({ type: "mkdir", path: cur, origin });
      }
    }
  }

  private toEntry(path: string, n: Node): Entry {
    return { path, kind: n.kind, size: n.kind === "file" ? n.data.length : 0, mtime: n.mtime };
  }
}

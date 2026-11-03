import type { MemoryFS } from "../vfs/memory-fs";
import { createIgnore, IGNORE_FILE, type IgnoreMatcher } from "../vfs/ignore";
import { isInside, normalize } from "../vfs/path";
import type { FsEvent } from "../vfs/types";
import type { GuestFS, GuestStat } from "./types";

export interface SyncOptions {
  /** How often the guest tree is scanned for changes made inside the OS. */
  pollMs?: number;
  /** Files larger than this are not mirrored into the editor. */
  maxFileBytes?: number;
  onError?: (error: unknown) => void;
}

/** Fingerprint used for both directions so a pushed file is not re-imported as a guest change. */
export function fingerprint(data: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${data.length}:${(h >>> 0).toString(16)}`;
}

/**
 * Keeps the project filesystem (editor side) and the guest's project directory (OS side)
 * identical. Editor -> guest is event driven; guest -> editor is detected by scanning.
 * Last writer wins; all operations are serialized so they never interleave.
 */
export class SyncEngine {
  /** What both sides agreed on after the last sync, by path. */
  private known = new Map<string, GuestStat>();
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  private ignoreText = "";
  private ignoreFn: IgnoreMatcher = createIgnore();
  private opts: Required<Omit<SyncOptions, "onError">> & Pick<SyncOptions, "onError">;

  constructor(
    private fs: MemoryFS,
    private guest: GuestFS,
    options: SyncOptions = {},
  ) {
    this.opts = { pollMs: 400, maxFileBytes: 4 * 1024 * 1024, ...options };
  }

  /** Makes the guest an exact copy of the project, then starts watching both sides. */
  async start(): Promise<void> {
    await this.enqueue(async () => {
      await this.pushAll();
    });
    this.unsubscribe = this.fs.subscribe((ev) => {
      if (ev.origin === "guest") return;
      // Snapshot now: by the time the queued job runs, the project may have changed again.
      const data = ev.type === "write" ? this.fs.readFile(ev.path) : undefined;
      void this.enqueue(() => this.applyToGuest(ev, data));
    });
    if (this.opts.pollMs > 0) this.timer = setInterval(() => void this.poll(), this.opts.pollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
  }

  /** Resolves when all queued syncing is finished. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Pull any changes made inside the guest into the project now. */
  poll(): Promise<void> {
    return this.enqueue(() => this.pullFromGuest());
  }

  /** Text of the project's ignore file; the matcher is rebuilt only when it changes. */
  private ignoreRules(): string {
    const text = this.fs.exists(IGNORE_FILE) ? this.fs.readText(IGNORE_FILE) : "";
    if (text !== this.ignoreText) {
      this.ignoreText = text;
      this.ignoreFn = createIgnore(text);
    }
    return text;
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        await job();
      } catch (e) {
        this.opts.onError?.(e);
      }
    });
    this.queue = run;
    return run;
  }

  private async pushAll(): Promise<void> {
    const existing = await this.guest.scan(this.ignoreRules());
    const wanted = new Set(this.fs.list().map((e) => e.path));
    // Remove guest leftovers that are not in the project (deepest first).
    for (const path of [...existing.keys()].sort().reverse()) {
      if (!wanted.has(path)) await this.guest.remove(path);
    }
    for (const entry of this.fs.list()) {
      if (entry.kind === "dir") await this.guest.mkdir(entry.path);
      else await this.guest.write(entry.path, this.fs.readFile(entry.path));
    }
    this.known = await this.guest.scan();
  }

  private async applyToGuest(ev: FsEvent, data?: Uint8Array): Promise<void> {
    switch (ev.type) {
      case "mkdir":
        await this.guest.mkdir(ev.path);
        await this.remember(ev.path);
        break;
      case "write":
        await this.guest.write(ev.path, data!);
        await this.remember(ev.path);
        break;
      case "remove":
        await this.guest.remove(ev.path);
        this.forget(ev.path);
        break;
      case "rename":
        await this.guest.rename(ev.from, ev.path);
        this.forget(ev.from);
        for (const [path, stat] of await this.guest.scan()) if (isInside(ev.path, path)) this.known.set(path, stat);
        break;
    }
  }

  private async remember(path: string) {
    const s = await this.guest.stat(path);
    if (s) this.known.set(normalize(path), s);
  }

  private forget(path: string) {
    for (const k of [...this.known.keys()]) if (isInside(path, k)) this.known.delete(k);
  }

  private async pullFromGuest(): Promise<void> {
    const now = await this.guest.scan(this.ignoreRules());
    const ignore = this.ignoreFn;

    // Deletions and kind changes first.
    for (const path of [...this.known.keys()].sort().reverse()) {
      const before = this.known.get(path)!;
      const after = now.get(path);
      if (!after && ignore(path, before.kind === "dir")) {
        // Newly ignored (or never scanned): not a deletion, just stop tracking it.
        this.known.delete(path);
        continue;
      }
      if ((!after || after.kind !== before.kind) && this.fs.exists(path)) this.fs.remove(path, "guest");
      if (!after) this.known.delete(path);
    }

    for (const path of [...now.keys()].sort()) {
      const cur = now.get(path)!;
      const before = this.known.get(path);
      if (before && before.kind === cur.kind && before.sig === cur.sig) continue;
      if (cur.kind === "dir") {
        this.fs.mkdir(path, "guest");
      } else if (cur.size <= this.opts.maxFileBytes) {
        this.fs.writeFile(path, await this.guest.read(path), "guest");
      }
      this.known.set(path, cur);
    }
  }
}

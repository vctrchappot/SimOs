import { basename, dirname, normalize } from "../vfs/path";
import { fingerprint } from "./sync";
import type { GuestFS, GuestStat } from "./types";

/** The subset of v86's in-memory 9p server (`emulator.fs9p`) used by the bridge. */
export interface Fs9p {
  SearchPath(path: string): { id: number; parentid: number; name: string };
  GetInode(id: number): Inode;
  CreateDirectory(name: string, parentid: number): number;
  CreateBinaryFile(name: string, parentid: number, data: Uint8Array): Promise<number>;
  set_data(id: number, data: Uint8Array): Promise<void>;
  Read(id: number, offset: number, count: number): Promise<Uint8Array | null>;
  Unlink(parentid: number, name: string): number;
  Rename(oldDir: number, oldName: string, newDir: number, newName: string): Promise<number>;
}

export interface Inode {
  mode: number;
  size: number;
  mtime: number;
  ctime: number;
  direntries: Map<string, number>;
}

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
/** Files up to this size are fingerprinted by content; larger ones by size and mtime. */
const HASH_LIMIT = 512 * 1024;

/** Project directory of a running v86 guest, exposed through the host side of its 9p device. */
export class V86GuestFS implements GuestFS {
  constructor(
    private fs9p: Fs9p,
    /** Absolute guest path of the project directory, e.g. /root/project. */
    private root: string,
  ) {}

  private abs(path: string): string {
    const p = normalize(path);
    return p === "/" ? this.root : normalize(this.root + p);
  }

  /** Creates the project root (and parents) if the guest image does not have it yet. */
  ensureRoot(): void {
    this.mkdirp(this.root);
  }

  private mkdirp(absPath: string): number {
    let id = 0;
    let cur = "";
    for (const part of normalize(absPath).split("/").filter(Boolean)) {
      cur += "/" + part;
      const hit = this.fs9p.SearchPath(cur);
      id = hit.id !== -1 ? hit.id : this.fs9p.CreateDirectory(part, hit.parentid);
    }
    return id;
  }

  async scan(): Promise<Map<string, GuestStat>> {
    const out = new Map<string, GuestStat>();
    const rootHit = this.fs9p.SearchPath(this.root);
    if (rootHit.id === -1) return out;
    const walk = async (id: number, prefix: string) => {
      const dir = this.fs9p.GetInode(id);
      for (const [name, childId] of dir.direntries) {
        if (name === "." || name === "..") continue;
        const path = `${prefix}/${name}`;
        const node = this.fs9p.GetInode(childId);
        const type = node.mode & S_IFMT;
        if (type === S_IFDIR) {
          out.set(path, { kind: "dir", size: 0, sig: "d" });
          await walk(childId, path);
        } else if (type === S_IFREG) {
          out.set(path, { kind: "file", size: node.size, sig: await this.signature(childId, node) });
        }
      }
    };
    await walk(rootHit.id, "");
    return out;
  }

  private async signature(id: number, node: Inode): Promise<string> {
    if (node.size > HASH_LIMIT) return `big:${node.size}:${node.mtime}`;
    if (node.size === 0) return fingerprint(new Uint8Array());
    return fingerprint((await this.fs9p.Read(id, 0, node.size)) ?? new Uint8Array());
  }

  async stat(path: string): Promise<GuestStat | null> {
    const hit = this.fs9p.SearchPath(this.abs(path));
    if (hit.id === -1) return null;
    const node = this.fs9p.GetInode(hit.id);
    if ((node.mode & S_IFMT) === S_IFDIR) return { kind: "dir", size: 0, sig: "d" };
    return { kind: "file", size: node.size, sig: await this.signature(hit.id, node) };
  }

  async read(path: string): Promise<Uint8Array> {
    const hit = this.fs9p.SearchPath(this.abs(path));
    if (hit.id === -1) throw new Error(`ENOENT: ${path}`);
    const node = this.fs9p.GetInode(hit.id);
    return (await this.fs9p.Read(hit.id, 0, node.size))?.slice() ?? new Uint8Array();
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const abs = this.abs(path);
    const hit = this.fs9p.SearchPath(abs);
    const copy = data.slice();
    if (hit.id !== -1) {
      const node = this.fs9p.GetInode(hit.id);
      if ((node.mode & S_IFMT) !== S_IFREG) throw new Error(`EISDIR: ${path}`);
      // Replace content in place so open file descriptors in the guest keep working.
      await this.fs9p.set_data(hit.id, copy);
      node.size = copy.length;
      node.mtime = node.ctime = Math.floor(Date.now() / 1000);
      return;
    }
    const parentId = this.mkdirp(dirname(abs));
    const id = await this.fs9p.CreateBinaryFile(basename(abs), parentId, copy);
    // Scripts with a shebang are created executable, like a developer would expect.
    if (copy[0] === 0x23 && copy[1] === 0x21) this.fs9p.GetInode(id).mode |= 0o111;
  }

  /** Sets permission bits (e.g. 0o755) on an existing file. */
  chmod(path: string, perm: number): void {
    const hit = this.fs9p.SearchPath(this.abs(path));
    if (hit.id === -1) return;
    const node = this.fs9p.GetInode(hit.id);
    node.mode = (node.mode & S_IFMT) | (perm & 0o7777);
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirp(this.abs(path));
  }

  async remove(path: string): Promise<void> {
    // v86's own DeleteNode() unlinks with an undefined name, so walk the tree ourselves.
    const hit = this.fs9p.SearchPath(this.abs(path));
    if (hit.id === -1) return;
    this.unlinkTree(hit.parentid, basename(this.abs(path)), hit.id);
  }

  private unlinkTree(parentId: number, name: string, id: number): void {
    const node = this.fs9p.GetInode(id);
    if ((node.mode & S_IFMT) === S_IFDIR) {
      for (const [child, childId] of [...node.direntries]) {
        if (child !== "." && child !== "..") this.unlinkTree(id, child, childId);
      }
    }
    const rc = this.fs9p.Unlink(parentId, name);
    if (rc < 0) throw new Error(`unlink ${name} failed (${rc})`);
  }

  async rename(from: string, to: string): Promise<void> {
    const src = this.fs9p.SearchPath(this.abs(from));
    if (src.id === -1) return;
    const dstParent = this.mkdirp(dirname(this.abs(to)));
    await this.fs9p.Rename(src.parentid, basename(from), dstParent, basename(to));
  }
}

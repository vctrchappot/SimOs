import { describe, expect, it } from "vitest";
import { createIgnore } from "@/os/vfs/ignore";
import { MemoryFS } from "@/os/vfs/memory-fs";
import { SyncEngine } from "@/os/runtime/sync";
import { V86GuestFS, type Fs9p, type Inode } from "@/os/runtime/v86-guest-fs";
import type { GuestFS, GuestStat } from "@/os/runtime/types";

describe("createIgnore", () => {
  it("always ignores node_modules and .git", () => {
    const ig = createIgnore("");
    expect(ig("/node_modules", true)).toBe(true);
    expect(ig("/a/node_modules/x/y.js")).toBe(true);
    expect(ig("/.git/HEAD")).toBe(true);
    expect(ig("/src/main.c")).toBe(false);
  });

  it("supports names, globs, dir-only and anchored rules, comments and blanks", () => {
    const ig = createIgnore("# build output\n\n*.o\nbuild/\n/dist\n/docs/*.tmp\nsecret.txt\n");
    expect(ig("/main.o")).toBe(true);
    expect(ig("/src/deep/main.o")).toBe(true);
    expect(ig("/main.c")).toBe(false);
    expect(ig("/build", true)).toBe(true);
    expect(ig("/build", false)).toBe(false); // a *file* called build is not a directory rule match
    expect(ig("/x/build/out.bin")).toBe(true);
    expect(ig("/dist")).toBe(true);
    expect(ig("/sub/dist")).toBe(false); // anchored
    expect(ig("/docs/a.tmp")).toBe(true);
    expect(ig("/other/a.tmp")).toBe(false);
    expect(ig("/a/b/secret.txt")).toBe(true);
    expect(ig("/mainXo")).toBe(false); // "." in globs is literal
  });
});

class FakeGuest implements GuestFS {
  files = new Map<string, string | "dir">();
  async scan(ignore?: string) {
    const skip = ignore === undefined ? undefined : createIgnore(ignore);
    const out = new Map<string, GuestStat>();
    for (const [p, v] of this.files) {
      if (skip?.(p, v === "dir")) continue;
      out.set(p, v === "dir" ? { kind: "dir", size: 0, sig: "d" } : { kind: "file", size: v.length, sig: v });
    }
    return out;
  }
  async stat(p: string) {
    return (await this.scan()).get(p) ?? null;
  }
  async read(p: string) {
    return new TextEncoder().encode(this.files.get(p) as string);
  }
  async write(p: string, d: Uint8Array) {
    this.files.set(p, new TextDecoder().decode(d));
  }
  async mkdir(p: string) {
    this.files.set(p, "dir");
  }
  async remove(p: string) {
    for (const k of [...this.files.keys()]) if (k === p || k.startsWith(p + "/")) this.files.delete(k);
  }
  async rename() {}
}

describe("SyncEngine with ignore rules", () => {
  it("never imports ignored guest files and does not mistake them for deletions", async () => {
    const fs = new MemoryFS();
    fs.writeFile("/keep.txt", "k", "init");
    const guest = new FakeGuest();
    const sync = new SyncEngine(fs, guest, { pollMs: 0 });
    await sync.start();

    guest.files.set("/node_modules", "dir");
    guest.files.set("/node_modules/pkg/index.js", "x");
    guest.files.set("/a.o", "obj");
    guest.files.set("/real.c", "int x;");
    fs.writeFile("/.simosignore", "*.o\n", "editor");
    await sync.idle();
    await sync.poll();

    expect(fs.exists("/real.c")).toBe(true);
    expect(fs.exists("/node_modules")).toBe(false);
    expect(fs.exists("/a.o")).toBe(false);

    // Ignoring a file that was already synced stops tracking it without deleting it from the editor.
    fs.writeFile("/old.o", "o", "editor");
    await sync.idle();
    await sync.poll();
    expect(fs.exists("/old.o")).toBe(true);
    await sync.poll();
    expect(fs.exists("/old.o")).toBe(true);
  });

  it("does not delete ignored guest files when pushing the project", async () => {
    const fs = new MemoryFS();
    const guest = new FakeGuest();
    guest.files.set("/node_modules/leftpad.js", "keep me");
    guest.files.set("/stale.txt", "gone");
    await new SyncEngine(fs, guest, { pollMs: 0 }).start();
    expect(guest.files.has("/node_modules/leftpad.js")).toBe(true);
    expect(guest.files.has("/stale.txt")).toBe(false);
  });
});

describe("V86GuestFS fingerprint cache", () => {
  /** A tiny stand-in for v86's 9p server with just enough behaviour for scan(). */
  function fake9p() {
    const inodes: Inode[] = [];
    const data = new Map<number, Uint8Array>();
    const mk = (mode: number, size = 0): number => {
      inodes.push({ mode, size, mtime: 1, ctime: 1, direntries: new Map() });
      return inodes.length - 1;
    };
    const root = mk(0x4000);
    const proj = mk(0x4000);
    inodes[root].direntries.set("project", proj);
    let reads = 0;
    const fs9p: Fs9p = {
      SearchPath: (p) => ({ id: p === "/project" ? proj : p === "/" ? root : -1, parentid: root, name: "" }),
      GetInode: (id) => inodes[id],
      CreateDirectory: () => 0,
      CreateBinaryFile: async () => 0,
      set_data: async () => {},
      Read: async (id) => {
        reads++;
        return data.get(id) ?? new Uint8Array();
      },
      Unlink: () => 0,
      Rename: async () => 0,
      Write: async (id, _o, _c, buf) => {
        data.set(id, buf ?? new Uint8Array());
      },
    };
    const addFile = (name: string, text: string) => {
      const b = new TextEncoder().encode(text);
      const id = mk(0x8000, b.length);
      data.set(id, b);
      inodes[proj].direntries.set(name, id);
      return id;
    };
    return { fs9p, addFile, reads: () => reads };
  }

  it("hashes unchanged files once, and re-hashes a same-size edit signalled by a guest write", async () => {
    const { fs9p, addFile, reads } = fake9p();
    const id = addFile("a.txt", "aaa");
    addFile("b.txt", "bbb");
    const guest = new V86GuestFS(fs9p, "/project");

    const first = await guest.scan();
    expect(reads()).toBe(2);
    await guest.scan();
    await guest.scan();
    expect(reads()).toBe(2); // nothing changed: no further reads

    // The guest overwrites a.txt with different content of the same length; v86 does not touch mtime.
    await fs9p.Write!(id, 0, 3, new TextEncoder().encode("ccc"));
    const after = await guest.scan();
    expect(reads()).toBe(3); // only the written inode is re-read
    expect(after.get("/a.txt")!.sig).not.toBe(first.get("/a.txt")!.sig);
    expect(after.get("/b.txt")!.sig).toBe(first.get("/b.txt")!.sig);
  });

  it("leaves out ignored entries", async () => {
    const { fs9p, addFile } = fake9p();
    addFile("a.txt", "a");
    const guest = new V86GuestFS(fs9p, "/project");
    expect([...(await guest.scan("a.txt")).keys()]).toEqual([]);
    expect([...(await guest.scan("")).keys()]).toEqual(["/a.txt"]);
  });
});

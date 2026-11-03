import { describe, expect, it } from "vitest";
import { MemoryFS } from "@/os/vfs/memory-fs";
import { fingerprint, SyncEngine } from "@/os/runtime/sync";
import type { GuestFS, GuestStat } from "@/os/runtime/types";
import { isInside, normalize } from "@/os/vfs/path";

/** An in-memory stand-in for the guest's project directory; it is what the OS "sees". */
class FakeGuest implements GuestFS {
  files = new Map<string, Uint8Array | "dir">();
  private sig(v: Uint8Array | "dir"): GuestStat {
    return v === "dir" ? { kind: "dir", size: 0, sig: "d" } : { kind: "file", size: v.length, sig: fingerprint(v) };
  }
  async scan() {
    return new Map([...this.files].map(([k, v]) => [k, this.sig(v)] as const));
  }
  async stat(path: string) {
    const v = this.files.get(normalize(path));
    return v ? this.sig(v) : null;
  }
  async read(path: string) {
    const v = this.files.get(normalize(path));
    if (!v || v === "dir") throw new Error("ENOENT");
    return v.slice();
  }
  async write(path: string, data: Uint8Array) {
    this.mkparents(path);
    this.files.set(normalize(path), data.slice());
  }
  async mkdir(path: string) {
    this.mkparents(path);
    this.files.set(normalize(path), "dir");
  }
  async remove(path: string) {
    for (const k of [...this.files.keys()]) if (isInside(path, k)) this.files.delete(k);
  }
  async rename(from: string, to: string) {
    this.mkparents(to);
    for (const [k, v] of [...this.files]) {
      if (!isInside(from, k)) continue;
      this.files.delete(k);
      this.files.set(normalize(to) + k.slice(normalize(from).length), v);
    }
  }
  private mkparents(path: string) {
    const parts = normalize(path).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts.slice(0, -1)) {
      cur += "/" + part;
      if (!this.files.has(cur)) this.files.set(cur, "dir");
    }
  }
  text(path: string) {
    const v = this.files.get(path);
    return v && v !== "dir" ? new TextDecoder().decode(v) : undefined;
  }
  put(path: string, text: string) {
    this.mkparents(path);
    this.files.set(path, new TextEncoder().encode(text));
  }
}

async function setup(initial: Record<string, string> = {}) {
  const fs = new MemoryFS();
  for (const [p, c] of Object.entries(initial)) fs.writeFile(p, c, "init");
  const guest = new FakeGuest();
  const errors: unknown[] = [];
  const sync = new SyncEngine(fs, guest, { pollMs: 0, onError: (e) => errors.push(e) });
  await sync.start();
  return { fs, guest, sync, errors };
}

describe("SyncEngine editor -> guest", () => {
  it("copies the whole project into the guest on start and removes leftovers", async () => {
    const fs = new MemoryFS();
    fs.writeFile("/a/b.sh", "echo b", "init");
    const guest = new FakeGuest();
    guest.put("/stale.txt", "old");
    const sync = new SyncEngine(fs, guest, { pollMs: 0 });
    await sync.start();
    expect(guest.text("/a/b.sh")).toBe("echo b");
    expect(guest.files.get("/a")).toBe("dir");
    expect(guest.files.has("/stale.txt")).toBe(false);
  });

  it("delivers editor writes, mkdirs, renames and deletes", async () => {
    const { fs, guest, sync, errors } = await setup({ "/x.txt": "1" });
    fs.writeFile("/x.txt", "2", "editor");
    fs.mkdir("/dir", "editor");
    fs.writeFile("/dir/new.sh", "echo hi", "editor");
    fs.rename("/dir", "/renamed", "editor");
    fs.writeFile("/tmp.txt", "t", "editor");
    fs.remove("/tmp.txt", "editor");
    await sync.idle();
    expect(guest.text("/x.txt")).toBe("2");
    expect(guest.text("/renamed/new.sh")).toBe("echo hi");
    expect(guest.files.has("/dir")).toBe(false);
    expect(guest.files.has("/tmp.txt")).toBe(false);
    expect(errors).toEqual([]);
  });
});

describe("SyncEngine guest -> editor", () => {
  it("imports files created, edited and deleted inside the guest", async () => {
    const { fs, guest, sync } = await setup({ "/keep.txt": "keep", "/del.txt": "bye" });
    guest.put("/made-in-shell.txt", "from bash");
    guest.put("/keep.txt", "edited in vim");
    guest.files.delete("/del.txt");
    guest.files.set("/newdir", "dir");
    await sync.poll();
    expect(fs.readText("/made-in-shell.txt")).toBe("from bash");
    expect(fs.readText("/keep.txt")).toBe("edited in vim");
    expect(fs.exists("/del.txt")).toBe(false);
    expect(fs.stat("/newdir")?.kind).toBe("dir");
  });

  it("handles directories removed in the guest", async () => {
    const { fs, guest, sync } = await setup({ "/d/a": "1", "/d/b/c": "2" });
    await guest.remove("/d");
    await sync.poll();
    expect(fs.list()).toEqual([]);
  });

  it("does not echo a change back to the side it came from", async () => {
    const { fs, guest, sync } = await setup();
    guest.put("/a.txt", "guest");
    const events: string[] = [];
    fs.subscribe((e) => events.push(`${e.type}:${e.path}:${e.origin}`));
    await sync.poll();
    await sync.poll(); // nothing new -> no further events
    expect(events).toEqual(["write:/a.txt:guest"]);
    fs.writeFile("/b.txt", "editor", "editor");
    await sync.poll();
    expect(events).toEqual(["write:/a.txt:guest", "write:/b.txt:editor"]);
  });

  it("keeps binary content intact in both directions", async () => {
    const { fs, guest, sync } = await setup();
    const bytes = new Uint8Array([0, 1, 254, 255, 10, 13]);
    fs.writeFile("/b.bin", bytes, "editor");
    await sync.idle();
    expect([...(await guest.read("/b.bin"))]).toEqual([...bytes]);
    await guest.write("/c.bin", bytes);
    await sync.poll();
    expect([...fs.readFile("/c.bin")]).toEqual([...bytes]);
  });

  it("an editor save followed by a guest edit converges on the guest version", async () => {
    const { fs, guest, sync } = await setup({ "/f": "v0" });
    fs.writeFile("/f", "v1", "editor");
    await sync.idle();
    guest.put("/f", "v2");
    await sync.poll();
    expect(fs.readText("/f")).toBe("v2");
    expect(guest.text("/f")).toBe("v2");
  });

  it("stops syncing after stop()", async () => {
    const { fs, guest, sync } = await setup();
    sync.stop();
    fs.writeFile("/late", "x", "editor");
    await sync.idle();
    expect(guest.files.has("/late")).toBe(false);
  });

  it("reports guest errors instead of throwing into the editor", async () => {
    const { fs, guest, sync, errors } = await setup();
    guest.write = async () => {
      throw new Error("disk full");
    };
    fs.writeFile("/x", "1", "editor");
    await sync.idle();
    expect(errors).toHaveLength(1);
  });
});

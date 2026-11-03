import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IdbProjectStore, MemoryProjectStore, PersistenceBinding, restoreProject } from "@/os/vfs/persistence";
import { MemoryFS } from "@/os/vfs/memory-fs";
import { FsError, type FsEvent } from "@/os/vfs/types";
import * as p from "@/os/vfs/path";

describe("paths", () => {
  it("normalizes and splits", () => {
    expect(p.normalize("a//b/./c/../d")).toBe("/a/b/d");
    expect(p.normalize("/../..")).toBe("/");
    expect(p.dirname("/a/b/c")).toBe("/a/b");
    expect(p.dirname("/a")).toBe("/");
    expect(p.basename("/a/b.txt")).toBe("b.txt");
    expect(p.isInside("/a", "/a/b")).toBe(true);
    expect(p.isInside("/a", "/ab")).toBe(false);
    expect(p.validateName("a/b")).not.toBeNull();
    expect(p.validateName("ok.txt")).toBeNull();
  });
});

describe("MemoryFS", () => {
  it("writes, reads and creates parent directories", () => {
    const fs = new MemoryFS();
    fs.writeFile("/a/b/c.txt", "hi");
    expect(fs.readText("/a/b/c.txt")).toBe("hi");
    expect(fs.stat("/a")?.kind).toBe("dir");
    expect(fs.stat("/a/b/c.txt")?.size).toBe(2);
    expect(fs.readdir("/a").map((e) => e.path)).toEqual(["/a/b"]);
  });

  it("sorts directories before files", () => {
    const fs = new MemoryFS();
    fs.writeFile("/z.txt", "");
    fs.writeFile("/a.txt", "");
    fs.mkdir("/m");
    expect(fs.readdir("/").map((e) => e.path)).toEqual(["/m", "/a.txt", "/z.txt"]);
  });

  it("returns copies, never live buffers", () => {
    const fs = new MemoryFS();
    const data = new Uint8Array([1, 2, 3]);
    fs.writeFile("/f", data);
    data[0] = 9;
    const read = fs.readFile("/f");
    read[1] = 9;
    expect([...fs.readFile("/f")]).toEqual([1, 2, 3]);
  });

  it("removes directories recursively", () => {
    const fs = new MemoryFS();
    fs.writeFile("/d/x/1", "1");
    fs.writeFile("/d/2", "2");
    fs.writeFile("/dd", "keep");
    fs.remove("/d");
    expect(fs.list().map((e) => e.path)).toEqual(["/dd"]);
  });

  it("renames files and whole directories", () => {
    const fs = new MemoryFS();
    fs.writeFile("/src/a.c", "a");
    fs.writeFile("/src/lib/b.c", "b");
    fs.rename("/src", "/code");
    expect(fs.exists("/src")).toBe(false);
    expect(fs.readText("/code/lib/b.c")).toBe("b");
    expect(() => fs.rename("/code", "/code/inner")).toThrow(FsError);
  });

  it("reports errors with codes", () => {
    const fs = new MemoryFS();
    fs.writeFile("/f", "x");
    fs.mkdir("/d");
    expect(() => fs.readFile("/nope")).toThrowError(/ENOENT/);
    expect(() => fs.readFile("/d")).toThrowError(/EISDIR/);
    expect(() => fs.writeFile("/d", "x")).toThrowError(/EISDIR/);
    expect(() => fs.writeFile("/f/g", "x")).toThrowError(/ENOTDIR/);
    expect(() => fs.rename("/f", "/d")).toThrowError(/EEXIST/);
    expect(() => fs.remove("/")).toThrowError(/EINVAL/);
  });

  it("emits events with their origin", () => {
    const fs = new MemoryFS();
    const events: FsEvent[] = [];
    fs.subscribe((e) => events.push(e));
    fs.writeFile("/a/b.txt", "x", "editor");
    fs.rename("/a/b.txt", "/a/c.txt", "guest");
    fs.remove("/a", "user");
    expect(events.map((e) => `${e.type}:${e.path}:${e.origin}`)).toEqual([
      "mkdir:/a:editor",
      "write:/a/b.txt:editor",
      "rename:/a/c.txt:guest",
      "remove:/a:user",
    ]);
  });
});

describe("persistence", () => {
  const sampleBytes = new Uint8Array([0, 255, 128, 7]);

  async function roundtrip(makeStore: () => MemoryProjectStore | IdbProjectStore) {
    const store = makeStore();
    const fs = new MemoryFS();
    const binding = new PersistenceBinding(fs, store, 5);
    fs.writeFile("/a/hello.txt", "hello");
    fs.writeFile("/bin.dat", sampleBytes);
    fs.mkdir("/empty");
    fs.writeFile("/old/x", "x");
    fs.rename("/old", "/new");
    fs.writeFile("/gone/y", "y");
    fs.remove("/gone");
    await binding.flush();

    const fresh = new MemoryFS();
    expect(await restoreProject(fresh, store)).toBe(true);
    expect(fresh.list().map((e) => e.path)).toEqual(["/a", "/a/hello.txt", "/bin.dat", "/empty", "/new", "/new/x"]);
    expect(fresh.readText("/a/hello.txt")).toBe("hello");
    expect([...fresh.readFile("/bin.dat")]).toEqual([...sampleBytes]);
    expect(fresh.stat("/empty")?.kind).toBe("dir");
  }

  it("round-trips a project through the in-memory store", () => roundtrip(() => new MemoryProjectStore()));

  it("round-trips through IndexedDB and survives reopening the database", async () => {
    const name = "test-" + Math.random();
    const first = new IdbProjectStore(name);
    const fs = new MemoryFS();
    const binding = new PersistenceBinding(fs, first, 5);
    fs.writeFile("/dir/file.sh", "echo persisted");
    fs.writeFile("/dir/sub/other", sampleBytes);
    fs.writeFile("/dir/sub/removed", "x");
    fs.remove("/dir/sub/removed");
    await binding.flush();

    const reopened = new IdbProjectStore(name); // a new connection, like a page reload
    const restored = new MemoryFS();
    expect(await restoreProject(restored, reopened)).toBe(true);
    expect(restored.readText("/dir/file.sh")).toBe("echo persisted");
    expect([...restored.readFile("/dir/sub/other")]).toEqual([...sampleBytes]);
    expect(restored.exists("/dir/sub/removed")).toBe(false);
  });

  it("deleting a directory in IndexedDB removes its children but not prefix siblings", async () => {
    const store = new IdbProjectStore("test-" + Math.random());
    const fs = new MemoryFS();
    const binding = new PersistenceBinding(fs, store, 5);
    fs.writeFile("/d/1", "1");
    fs.writeFile("/dd/2", "2");
    fs.remove("/d");
    await binding.flush();
    const restored = new MemoryFS();
    await restoreProject(restored, store);
    expect(restored.list().map((e) => e.path)).toEqual(["/dd", "/dd/2"]);
  });

  it("reports an empty store as not restored", async () => {
    expect(await restoreProject(new MemoryFS(), new IdbProjectStore("test-" + Math.random()))).toBe(false);
  });
});

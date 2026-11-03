import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { exportProject, importProject } from "@/os/project-archive";
import { MemoryFS } from "@/os/vfs/memory-fs";
import { crc32, createZip, isUnsafeZipPath, readZip } from "@/os/zip";

const enc = (s: string) => new TextEncoder().encode(s);

/** Builds a zip whose single entry is deflate-compressed, optionally lying about its sizes. */
function deflatedZip(name: string, content: Uint8Array, claim?: { size?: number; crc?: number }): Uint8Array {
  const body = deflateRawSync(content);
  const nameBytes = enc(name);
  const size = claim?.size ?? content.length;
  const crc = claim?.crc ?? crc32(content);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(8, 8, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, body.length, true);
  local.setUint32(22, size, true);
  local.setUint16(26, nameBytes.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true);
  central.setUint16(6, 20, true);
  central.setUint16(10, 8, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, body.length, true);
  central.setUint32(24, size, true);
  central.setUint16(28, nameBytes.length, true);
  const localLen = 30 + nameBytes.length + body.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + nameBytes.length, true);
  end.setUint32(16, localLen, true);
  return Buffer.concat([
    new Uint8Array(local.buffer),
    nameBytes,
    body,
    new Uint8Array(central.buffer),
    nameBytes,
    new Uint8Array(end.buffer),
  ]);
}

describe("zip", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips entries, including empty files, binary data and unicode names", async () => {
    const binary = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
    const zip = createZip([
      { path: "dir/", data: new Uint8Array() },
      { path: "dir/ümläut ✓.txt", data: enc("hallo") },
      { path: "empty", data: new Uint8Array() },
      { path: "bin.dat", data: binary },
    ]);
    const back = await readZip(zip);
    expect(back.map((e) => e.path)).toEqual(["dir/", "dir/ümläut ✓.txt", "empty", "bin.dat"]);
    expect(new TextDecoder().decode(back[1].data)).toBe("hallo");
    expect(back[2].data.length).toBe(0);
    expect([...back[3].data]).toEqual([...binary]);
  });

  it("reads deflate-compressed entries", async () => {
    const text = "compress me ".repeat(500);
    const [e] = await readZip(deflatedZip("a.txt", enc(text)));
    expect(new TextDecoder().decode(e.data)).toBe(text);
  });

  it("rejects unsafe paths, encrypted/garbage input and checksum mismatches", async () => {
    for (const bad of ["../evil.txt", "a/../../evil", "/abs.txt", "C:\\x.txt", "a\\..\\b"]) {
      expect(isUnsafeZipPath(bad)).toBe(true);
      await expect(readZip(createZip([{ path: bad, data: enc("x") }]))).rejects.toThrow(/unsafe path/);
    }
    expect(isUnsafeZipPath("ok/file..name.txt")).toBe(false);
    await expect(readZip(enc("definitely not a zip"))).rejects.toThrow(/Not a zip/);
    await expect(readZip(deflatedZip("a.txt", enc("abc"), { crc: 1 }))).rejects.toThrow(/corrupt/);
  });

  it("enforces size limits, including entries that expand beyond what they declare", async () => {
    const limits = { maxEntries: 2, maxEntryBytes: 1000, maxTotalBytes: 1500 };
    await expect(readZip(createZip([{ path: "big", data: new Uint8Array(2000) }]), limits)).rejects.toThrow(/larger than allowed|allowed size/);
    await expect(
      readZip(createZip(["a", "b", "c"].map((p) => ({ path: p, data: enc("x") }))), limits),
    ).rejects.toThrow(/too many entries/);
    await expect(
      readZip(createZip([{ path: "a", data: new Uint8Array(900) }, { path: "b", data: new Uint8Array(900) }]), limits),
    ).rejects.toThrow(/total size/);
    // A "bomb": declares 10 bytes but inflates to 50 KB.
    const bomb = deflatedZip("bomb.txt", new Uint8Array(50_000), { size: 10, crc: 0 });
    await expect(readZip(bomb, { ...limits, maxEntryBytes: 1000 })).rejects.toThrow(/larger than the allowed size/);
  });
});

describe("project import/export", () => {
  it("exports and re-imports a project exactly", async () => {
    const a = new MemoryFS();
    a.writeFile("/README.md", "# hi\n");
    a.writeFile("/src/deep/x.c", "int x;\n");
    a.writeFile("/data.bin", Uint8Array.from([0, 255, 1]));
    a.mkdir("/empty-dir");
    const b = new MemoryFS();
    const summary = await importProject(b, exportProject(a));
    expect(summary).toEqual({ files: 3, folders: 3, overwritten: 0 });
    expect(b.list().map((e) => `${e.kind}:${e.path}`)).toEqual(a.list().map((e) => `${e.kind}:${e.path}`));
    expect([...b.readFile("/data.bin")]).toEqual([0, 255, 1]);
  });

  it("overwrites same-named files, keeps everything else, and counts overwrites", async () => {
    const fs = new MemoryFS();
    fs.writeFile("/a.txt", "old");
    fs.writeFile("/keep.txt", "keep");
    const summary = await importProject(fs, createZip([{ path: "a.txt", data: enc("new") }]));
    expect(summary.overwritten).toBe(1);
    expect(fs.readText("/a.txt")).toBe("new");
    expect(fs.readText("/keep.txt")).toBe("keep");
  });

  it("imports nothing when the archive conflicts with the project (file vs folder)", async () => {
    const fs = new MemoryFS();
    fs.writeFile("/thing", "i am a file");
    const zip = createZip([
      { path: "fresh.txt", data: enc("x") },
      { path: "thing/", data: new Uint8Array() },
    ]);
    await expect(importProject(fs, zip)).rejects.toThrow(/thing/);
    expect(fs.exists("/fresh.txt")).toBe(false);
  });
});

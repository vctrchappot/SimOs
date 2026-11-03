/**
 * Minimal ZIP support for project import/export, with no dependencies.
 *  - writing: "stored" (uncompressed) entries, UTF-8 names
 *  - reading: stored and deflate entries (via the platform's DecompressionStream)
 * Reading is defensive: it refuses path traversal and enforces size limits (zip bombs).
 */
import { normalize } from "./vfs/path";

export interface ZipEntry {
  /** Path inside the archive, without a leading slash. Directories end with "/". */
  path: string;
  data: Uint8Array;
}

export interface ReadLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: ReadLimits = { maxEntries: 20_000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let crcTable: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(d.getFullYear(), 1980) - 1980 << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function createZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const { time, date } = dosDateTime(now);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = encoder.encode(e.path);
    const crc = crc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, e.data);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, e.data.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, name.length, true);
    // 0o40755 for directories, 0o100644 for files, in the Unix "external attributes" high word.
    c.setUint32(38, (e.path.endsWith("/") ? 0o040755 : 0o100644) * 0x10000, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + e.data.length;
  }

  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("A file in the zip is larger than the allowed size");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** True for archive names that could escape the project (absolute, drive letters, `..`). */
export function isUnsafeZipPath(name: string): boolean {
  if (name.includes("\0") || name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) return true;
  return name.split(/[\\/]/).includes("..");
}

export async function readZip(bytes: Uint8Array, limits: ReadLimits = DEFAULT_LIMITS): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (count > limits.maxEntries) throw new Error(`The zip has too many entries (${count})`);

  const out: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error("The zip is corrupt");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw new Error("Encrypted zips are not supported");
    if (isUnsafeZipPath(name)) throw new Error(`The zip contains an unsafe path: ${name}`);
    if (name.endsWith("/")) {
      out.push({ path: name, data: new Uint8Array() });
      continue;
    }
    if (size > limits.maxEntryBytes) throw new Error(`${name} is larger than the allowed size`);
    total += size;
    if (total > limits.maxTotalBytes) throw new Error("The zip is larger than the allowed total size");

    if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== 0x04034b50) throw new Error("The zip is corrupt");
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const raw = bytes.subarray(dataAt, dataAt + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw, Math.min(limits.maxEntryBytes, size + 1));
    else throw new Error(`${name}: unsupported compression method ${method}`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name} is corrupt (checksum mismatch)`);
    out.push({ path: name, data });
  }
  return out;
}

/** Project paths (leading slash, normalized) for each archive entry. */
export function toProjectPath(zipPath: string): string {
  return normalize("/" + zipPath.replace(/\\/g, "/"));
}

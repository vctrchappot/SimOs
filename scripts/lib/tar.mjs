// Helpers shared by the image build scripts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Downloads `url` once into `cacheDir/name` and returns its bytes (later calls read the cache). */
export async function download(cacheDir, url, name) {
  const file = resolve(cacheDir, name);
  if (existsSync(file)) return readFileSync(file);
  console.log("download", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

/** Minimal tar reader: ustar + GNU long names; skips pax extended headers. */
export function* tarEntries(buf) {
  let off = 0;
  let longName = null;
  const str = (a, b) => buf.toString("utf8", a, b).replace(/\0.*$/s, "");
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) {
      off += 512;
      continue;
    }
    let name = str(off, off + 100);
    const mode = parseInt(str(off + 100, off + 108), 8) || 0;
    const uid = parseInt(str(off + 108, off + 116), 8) || 0;
    const gid = parseInt(str(off + 116, off + 124), 8) || 0;
    const size = parseInt(str(off + 124, off + 136), 8) || 0;
    const mtime = parseInt(str(off + 136, off + 148), 8) || 0;
    const type = String.fromCharCode(buf[off + 156] || 48);
    const link = str(off + 157, off + 257);
    const prefix = str(off + 345, off + 500);
    if (prefix) name = `${prefix}/${name}`;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "x" || type === "g") continue;
    if (longName) {
      name = longName;
      longName = null;
    }
    yield { name, mode, uid, gid, size, mtime, type, link, data };
  }
}


import type { MemoryFS } from "./vfs/memory-fs";
import { createZip, readZip, toProjectPath, type ReadLimits, type ZipEntry } from "./zip";

/** Packs the whole project (every file and folder) into a zip. */
export function exportProject(fs: MemoryFS): Uint8Array {
  const entries: ZipEntry[] = fs.list().map((e) =>
    e.kind === "dir" ? { path: e.path.slice(1) + "/", data: new Uint8Array() } : { path: e.path.slice(1), data: fs.readFile(e.path) },
  );
  return createZip(entries);
}

export interface ImportSummary {
  files: number;
  folders: number;
  /** Existing files that were replaced. */
  overwritten: number;
}

/**
 * Unpacks a zip into the project. Existing files with the same path are overwritten;
 * nothing else is removed. Everything is validated before the first file is written, so a
 * bad archive never leaves the project half-imported.
 */
export async function importProject(fs: MemoryFS, zip: Uint8Array, limits?: ReadLimits): Promise<ImportSummary> {
  const entries = await readZip(zip, limits);
  const plan = entries.map((e) => ({ path: toProjectPath(e.path), dir: e.path.endsWith("/"), data: e.data }));

  for (const p of plan) {
    if (p.path === "/") continue;
    const existing = fs.stat(p.path);
    if (existing && (existing.kind === "dir") !== p.dir) {
      throw new Error(`${p.path} is a ${existing.kind === "dir" ? "folder" : "file"} in the project but the zip has a ${p.dir ? "folder" : "file"} there`);
    }
  }

  const summary: ImportSummary = { files: 0, folders: 0, overwritten: 0 };
  for (const p of plan) {
    if (p.path === "/") continue;
    if (p.dir) {
      fs.mkdir(p.path, "user");
      summary.folders++;
    } else {
      if (fs.exists(p.path)) summary.overwritten++;
      fs.writeFile(p.path, p.data, "user");
      summary.files++;
    }
  }
  return summary;
}

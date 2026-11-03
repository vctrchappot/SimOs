import type { GuestFS } from "./runtime/types";
import type { MemoryFS } from "./vfs/memory-fs";
import { isInside } from "./vfs/path";

/** Project folder whose contents are laid over the OS root filesystem at every boot. */
export const OVERLAY_DIR = "/system";

/**
 * Copies `<project>/system/**` onto the guest's root filesystem (system/etc/hostname becomes
 * /etc/hostname). This is how an OS is authored in the studio: the base image is fixed, the
 * overlay is yours and is persisted with the project. Returns the guest paths written.
 */
export async function applyOverlay(fs: MemoryFS, root: Pick<GuestFS, "write" | "mkdir">): Promise<string[]> {
  const written: string[] = [];
  if (fs.stat(OVERLAY_DIR)?.kind !== "dir") return written;
  for (const entry of fs.list()) {
    if (entry.path === OVERLAY_DIR || !isInside(OVERLAY_DIR, entry.path)) continue;
    const target = entry.path.slice(OVERLAY_DIR.length);
    if (entry.kind === "dir") await root.mkdir(target);
    else await root.write(target, fs.readFile(entry.path));
    written.push(target);
  }
  return written;
}

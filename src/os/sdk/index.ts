/**
 * SimOs SDK: the public surface for building on the studio.
 *
 *  - `OSProfile`   describes a bootable system (kernel, root filesystem, boot-time files, shell hooks).
 *                  A custom shell, boot sequence or desktop environment is a new profile.
 *  - `OSRuntime`   powers a profile on a machine and exposes its console and filesystem.
 *  - `GuestFS`     the guest-side view of the project directory.
 *  - `MemoryFS`    the project filesystem every tool (editor, explorer, sync) shares.
 *  - `Studio`      glues project, persistence and runtime together.
 */
export { Studio, type StudioOptions } from "../studio";
export { MemoryFS } from "../vfs/memory-fs";
export * as paths from "../vfs/path";
export { FsError, type Entry, type FsEvent, type Origin, type Stat } from "../vfs/types";
export {
  IdbProjectStore,
  MemoryProjectStore,
  PersistenceBinding,
  restoreProject,
  seedProject,
  type ProjectStore,
} from "../vfs/persistence";
export { SyncEngine, fingerprint, type SyncOptions } from "../runtime/sync";
export type { GuestFS, GuestStat, OSProfile, OSRuntime, RuntimeStatus } from "../runtime/types";
export { V86Runtime, type V86Environment } from "../runtime/v86-runtime";
export { V86GuestFS } from "../runtime/v86-guest-fs";
export { alpineProfile, buildrootProfile, defaultProfile, READY_MARKER } from "../runtime/profiles";
export { applyOverlay, OVERLAY_DIR } from "../overlay";
export { PROJECT_TEMPLATE } from "../template";

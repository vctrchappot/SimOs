import type { OSProfile, RuntimeStatus } from "./types";

export type FsTarget = "project" | "root";
export type FsMethod = "scan" | "stat" | "read" | "write" | "mkdir" | "remove" | "rename";

/** Main thread -> worker. */
export type ToWorker =
  | { t: "boot"; profile: OSProfile; sizes: Array<{ cols: number; rows: number } | undefined> }
  | { t: "prepared" }
  | { t: "prepare-failed"; error: string }
  | { t: "input"; data: string; terminal: number }
  | { t: "resize"; cols: number; rows: number; terminal: number }
  | { t: "fs"; id: number; target: FsTarget; method: FsMethod; args: unknown[] };

/** Worker -> main thread. */
export type FromWorker =
  | { t: "status"; status: RuntimeStatus; detail?: string }
  | { t: "output"; data: Uint8Array; terminal: number }
  | { t: "ready" }
  /** The guest filesystem exists; the main thread should copy the project in, then answer `prepared`. */
  | { t: "prepare" }
  | { t: "fs-result"; id: number; ok: true; value: unknown }
  | { t: "fs-result"; id: number; ok: false; error: string };

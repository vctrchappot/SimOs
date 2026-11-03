export type EntryKind = "file" | "dir";

export interface Stat {
  kind: EntryKind;
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
}

export interface Entry extends Stat {
  path: string;
}

/** Who caused a change; used to prevent sync echo loops. */
export type Origin = "editor" | "guest" | "init" | "user";

export type FsEvent =
  | { type: "write"; path: string; origin: Origin }
  | { type: "mkdir"; path: string; origin: Origin }
  | { type: "remove"; path: string; origin: Origin }
  | { type: "rename"; path: string; from: string; origin: Origin };

export type FsListener = (event: FsEvent) => void;

export class FsError extends Error {
  constructor(
    public code: "ENOENT" | "EEXIST" | "EISDIR" | "ENOTDIR" | "EINVAL",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FsError";
  }
}

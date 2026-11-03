/** Contracts between the studio and whatever machine is running the OS. */

export type RuntimeStatus = "stopped" | "booting" | "running" | "stopping" | "error";

export interface GuestStat {
  kind: "file" | "dir";
  size: number;
  /** Cheap content fingerprint; changes whenever the bytes change. */
  sig: string;
}

/**
 * A directory tree inside the guest, addressed relative to the project root ("/" = root).
 * Implemented over the emulator's 9p filesystem; mocked in unit tests.
 */
export interface GuestFS {
  /**
   * Every entry below the root, keyed by project path. Symlinks and special files are skipped.
   * `ignore` is the text of the project's ignore file; matching entries are left out and
   * matching directories are not entered. (Text, not a function, so it can cross a worker boundary.)
   */
  scan(ignore?: string): Promise<Map<string, GuestStat>>;
  stat(path: string): Promise<GuestStat | null>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface OSRuntime {
  readonly status: RuntimeStatus;
  /** Guest filesystem view; available only while running. */
  readonly guestFs: GuestFS | null;
  onStatus(cb: (status: RuntimeStatus, detail?: string) => void): () => void;
  /** Raw bytes from the guest's console (feed straight into a terminal). */
  onOutput(cb: (data: Uint8Array) => void): () => void;
  /** Called once the guest finished booting and its shell is ready for input. */
  onReady(cb: () => void): () => void;
  /**
   * Powers on the machine. `prepare` runs once the guest filesystem exists but before the
   * CPU starts: it receives the project directory and the guest's root, and is where the project
   * is copied in and the system overlay applied. Resolves once the shell is ready
   * (or the boot failed; check `status`).
   */
  boot(prepare?: (project: GuestFS, root: GuestFS) => Promise<void>): Promise<void>;
  /** Hard power-off of the virtual machine. */
  shutdown(): Promise<void>;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
}

/**
 * Describes an operating system image the studio can boot. New OS flavours (custom shells,
 * desktop environments, ...) are new profiles, not new runtimes.
 */
export interface OSProfile {
  id: string;
  name: string;
  description: string;
  memoryMB: number;
  /** Kernel command line. */
  cmdline: string;
  /** Where the guest's root directory lives inside the shared 9p filesystem ("/" if it is the share itself). */
  rootDir: string;
  /** Where the project directory lives inside the guest. */
  projectDir: string;
  /** Base URL for kernel/rootfs assets. */
  assets: {
    /** Linux kernel image (bzImage). */
    bzimage: string;
    /** Root filesystem manifest (fs.json) and the URL prefix of its file blobs, served on demand. */
    rootfs?: { manifest: string; baseUrl: string };
  };
  /** Files written into the guest root filesystem before it boots (path -> content/mode). */
  bootFiles: Record<string, { content: string; mode?: number }>;
  /** Text printed by the guest once the shell is ready. */
  readyMarker: string;
}

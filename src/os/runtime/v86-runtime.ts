import { V86GuestFS, type Fs9p } from "./v86-guest-fs";
import type { GuestFS, OSProfile, OSRuntime, RuntimeStatus } from "./types";

/** Minimal surface of a v86 emulator instance that the runtime relies on. */
interface Emulator {
  fs9p: Fs9p;
  add_listener(event: string, cb: (arg: never) => void): void;
  run(): Promise<void>;
  destroy(): Promise<void>;
  serial_send_bytes(serial: number, data: Uint8Array): void;
}

export interface V86Environment {
  /** Resolves the v86 constructor (a script URL in the browser, the npm package in Node). */
  loadV86(): Promise<new (options: Record<string, unknown>) => Emulator>;
  /** Machine options that depend on where assets live: wasm_path, bios, vga_bios, ... */
  machineOptions: Record<string, unknown>;
}

const encoder = new TextEncoder();
const BOOT_TIMEOUT_MS = 180_000;

/**
 * Runs an OSProfile on the v86 x86 emulator. The guest is a real Linux kernel; the project
 * directory is shared with the host through virtio-9p.
 */
export class V86Runtime implements OSRuntime {
  status: RuntimeStatus = "stopped";
  guestFs: GuestFS | null = null;

  private emulator: Emulator | null = null;
  private rootFs: V86GuestFS | null = null;
  private statusCbs = new Set<(s: RuntimeStatus, detail?: string) => void>();
  private outputCbs = new Set<(d: Uint8Array) => void>();
  private readyCbs = new Set<() => void>();
  private outBuf: number[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private tail = "";
  private generation = 0;
  private size: { cols: number; rows: number } | null = null;

  constructor(
    readonly profile: OSProfile,
    private env: V86Environment,
  ) {}

  onStatus(cb: (s: RuntimeStatus, detail?: string) => void) {
    this.statusCbs.add(cb);
    return () => void this.statusCbs.delete(cb);
  }
  onOutput(cb: (d: Uint8Array) => void) {
    this.outputCbs.add(cb);
    return () => void this.outputCbs.delete(cb);
  }
  onReady(cb: () => void) {
    this.readyCbs.add(cb);
    return () => void this.readyCbs.delete(cb);
  }

  private setStatus(s: RuntimeStatus, detail?: string) {
    this.status = s;
    for (const cb of [...this.statusCbs]) cb(s, detail);
  }

  async boot(prepare?: (project: GuestFS, root: GuestFS) => Promise<void>): Promise<void> {
    if (this.status === "booting" || this.status === "running") return;
    const gen = ++this.generation;
    this.setStatus("booting");
    this.tail = "";
    try {
      const V86 = await this.env.loadV86();
      const { assets } = this.profile;
      const options: Record<string, unknown> = {
        memory_size: this.profile.memoryMB * 1024 * 1024,
        vga_memory_size: 8 * 1024 * 1024,
        cmdline: this.profile.cmdline,
        autostart: false,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
        ...this.env.machineOptions,
      };
      if (assets.rootfs) {
        options.filesystem = { baseurl: assets.rootfs.baseUrl, basefs: { url: assets.rootfs.manifest } };
      } else {
        options.filesystem = {};
      }
      options.bzimage = { url: assets.bzimage };

      const emulator = new V86(options);
      this.emulator = emulator;
      await new Promise<void>((resolve) => emulator.add_listener("emulator-ready", () => resolve()));
      if (gen !== this.generation) return void (await emulator.destroy());

      emulator.add_listener("serial0-output-byte", ((byte: number) => this.onSerialByte(byte)) as (a: never) => void);

      this.rootFs = new V86GuestFS(emulator.fs9p, this.profile.rootDir);
      const project = new V86GuestFS(emulator.fs9p, this.profile.rootDir.replace(/\/$/, "") +this.profile.projectDir);
      project.ensureRoot();
      for (const [path, file] of Object.entries(this.profile.bootFiles)) {
        await this.rootFs.write(path, encoder.encode(file.content));
        this.rootFs.chmod(path, file.mode ?? 0o644);
      }
      this.writeSize();
      this.guestFs = project;
      await prepare?.(project, this.rootFs);
      if (gen !== this.generation) return void (await emulator.destroy());

      let offReady = () => {};
      let offStatus = () => {};
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        offReady = this.onReady(resolve);
        offStatus = this.onStatus((st) => (st === "error" || st === "stopped" ? resolve() : undefined));
        timeout = setTimeout(() => reject(new Error("The OS did not become ready within 3 minutes.")), BOOT_TIMEOUT_MS);
      });
      await emulator.run();
      try {
        await ready;
      } finally {
        clearTimeout(timeout);
        offReady();
        offStatus();
      }
    } catch (e) {
      this.setStatus("error", e instanceof Error ? e.message : String(e));
      await this.teardown();
    }
  }

  private onSerialByte(byte: number) {
    const { readyMarker } = this.profile;
    this.tail = (this.tail + String.fromCharCode(byte)).slice(-64);

    this.outBuf.push(byte);
    this.flushTimer ??= setTimeout(() => this.flushOutput(), 8);
    if (this.tail.endsWith(readyMarker) && this.status === "booting") {
      this.flushOutput(); // deliver the boot log before announcing readiness
      this.setStatus("running");
      for (const cb of [...this.readyCbs]) cb();
    }
  }

  private flushOutput() {
    this.flushTimer = null;
    if (!this.outBuf.length) return;
    const chunk = Uint8Array.from(this.outBuf);
    this.outBuf = [];
    for (const cb of [...this.outputCbs]) cb(chunk);
  }

  async shutdown(): Promise<void> {
    if (this.status === "stopped") return;
    this.generation++;
    this.setStatus("stopping");
    await this.teardown();
    this.setStatus("stopped");
  }

  private async teardown() {
    this.flushOutput();
    const emulator = this.emulator;
    this.emulator = null;
    this.guestFs = null;
    this.rootFs = null;
    if (emulator) {
      try {
        await emulator.destroy();
      } catch {
        /* already gone */
      }
    }
  }

  sendInput(data: string): void {
    if (!this.emulator || (this.status !== "running" && this.status !== "booting")) return;
    this.emulator.serial_send_bytes(0, encoder.encode(data));
  }

  /** The shell applies the new size at its next prompt (see the profile script). */
  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    this.writeSize();
  }

  private writeSize() {
    if (!this.rootFs || !this.size || this.status === "stopped") return;
    void this.rootFs.write("/etc/simos-size", encoder.encode(`rows ${this.size.rows} cols ${this.size.cols}\n`));
  }
}

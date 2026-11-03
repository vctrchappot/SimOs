import { DisplayAdapter, type AbsolutePointer, type DisplayFrame } from "./display";
import { networkDevice, type NetworkConfig } from "./network";
import { OutputHistory } from "./output-history";
import { endShell } from "./terminal-control";
import { TERMINAL_COUNT, type GuestFS, type OSProfile, type OSRuntime, type RuntimeStatus } from "./types";
import { V86GuestFS, type Fs9p } from "./v86-guest-fs";

/** Minimal surface of a v86 emulator instance that the runtime relies on. */
interface Emulator {
  fs9p: Fs9p;
  add_listener(event: string, cb: (arg: never) => void): void;
  run(): Promise<void>;
  destroy(): Promise<void>;
  serial_send_bytes(serial: number, data: Uint8Array): void;
  bus: { send(name: string, data: unknown): void };
}

/** The emulated video card, reached through v86's internals (it has no public hook for custom screens). */
interface VgaHolder {
  v86?: { cpu?: { devices?: { vga?: { screen: unknown; screen_fill_buffer(): void } } } };
}

export interface V86Environment {
  /** Resolves the v86 constructor (a script URL in the browser, the npm package in Node). */
  loadV86(): Promise<new (options: Record<string, unknown>) => Emulator>;
  /** Machine options that depend on where assets live: wasm_path, bios, vga_bios, ... */
  machineOptions: Record<string, unknown>;
}

const encoder = new TextEncoder();
const BOOT_TIMEOUT_MS = 180_000;
const terminals = Array.from({ length: TERMINAL_COUNT }, (_, i) => i);

/**
 * Runs an OSProfile on the v86 x86 emulator. The guest is a real Linux kernel; the project
 * directory is shared with the host through virtio-9p. Each of the four emulated serial ports
 * carries its own login shell.
 */
export class V86Runtime implements OSRuntime {
  status: RuntimeStatus = "stopped";
  guestFs: GuestFS | null = null;

  private emulator: Emulator | null = null;
  private rootFs: V86GuestFS | null = null;
  private statusCbs = new Set<(s: RuntimeStatus, detail?: string) => void>();
  private outputCbs = new Set<(d: Uint8Array, terminal: number) => void>();
  private readyCbs = new Set<() => void>();
  private outBuf: number[][] = terminals.map(() => []);
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private logs = new OutputHistory(TERMINAL_COUNT);
  private tail = "";
  private generation = 0;
  private sizes: Array<{ cols: number; rows: number } | undefined> = [];
  private display = this.newDisplay();
  private displayCbs = new Set<(f: DisplayFrame) => void>();
  private displayTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private profile: OSProfile,
    private env: V86Environment,
  ) {}

  private newDisplay() {
    const display = new DisplayAdapter();
    display.onFrame = (frame) => {
      for (const cb of [...this.displayCbs]) cb(frame);
    };
    return display;
  }

  onStatus(cb: (s: RuntimeStatus, detail?: string) => void) {
    this.statusCbs.add(cb);
    return () => void this.statusCbs.delete(cb);
  }
  onOutput(cb: (d: Uint8Array, terminal: number) => void) {
    this.outputCbs.add(cb);
    return () => void this.outputCbs.delete(cb);
  }
  onReady(cb: () => void) {
    this.readyCbs.add(cb);
    return () => void this.readyCbs.delete(cb);
  }
  onDisplay(cb: (f: DisplayFrame) => void) {
    this.displayCbs.add(cb);
    this.display.invalidate(); // the new viewer gets the whole picture
    this.startDisplayTimer();
    return () => {
      this.displayCbs.delete(cb);
      if (!this.displayCbs.size) this.stopDisplayTimer();
    };
  }

  /** Paints the guest's video memory into the adapter ~30x a second, but only while someone watches. */
  private startDisplayTimer() {
    if (this.displayTimer || !this.emulator || !this.displayCbs.size) return;
    this.displayTimer = setInterval(() => {
      const vga = (this.emulator as unknown as VgaHolder | null)?.v86?.cpu?.devices?.vga;
      vga?.screen_fill_buffer();
      this.display.flush();
    }, 33);
  }
  private stopDisplayTimer() {
    if (this.displayTimer) clearInterval(this.displayTimer);
    this.displayTimer = null;
  }

  /** Scancodes (set 1, as a PC keyboard sends them) for the guest's PS/2 keyboard. */
  sendKeys(codes: number[]): void {
    if (!this.emulator || this.status !== "running") return;
    for (const code of codes) this.emulator.bus.send("keyboard-code", code);
  }

  sendMouse(dx: number, dy: number, buttons: [boolean, boolean, boolean], abs?: AbsolutePointer): void {
    if (!this.emulator || this.status !== "running") return;
    if (abs) this.emulator.bus.send("mouse-absolute", [abs.x, abs.y, abs.width, abs.height]);
    if (dx || dy) this.emulator.bus.send("mouse-delta", [dx, -dy]);
    this.emulator.bus.send("mouse-click", buttons);
  }

  history(terminal: number) {
    return this.logs.get(terminal);
  }

  setNetwork(config: NetworkConfig) {
    this.profile = { ...this.profile, network: config };
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
    this.logs.clear();
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
        // Serial ports 1-3 become /dev/ttyS1-3: extra, fully independent consoles.
        uart1: true,
        uart2: true,
        uart3: true,
        ...this.env.machineOptions,
      };
      if (assets.rootfs) {
        options.filesystem = { baseurl: assets.rootfs.baseUrl, basefs: { url: assets.rootfs.manifest } };
      } else {
        options.filesystem = {};
      }
      options.bzimage = { url: assets.bzimage };
      if (assets.initrd) options.initrd = { url: assets.initrd };
      const net = networkDevice(this.profile.network);
      if (net) {
        options.net_device = net;
        options.cmdline = `${this.profile.cmdline} simos.net=1`; // tells init to bring eth0 up
      }

      const emulator = new V86(options);
      this.emulator = emulator;
      await new Promise<void>((resolve) => emulator.add_listener("emulator-ready", () => resolve()));
      if (gen !== this.generation) return void (await emulator.destroy());

      // Route the emulated video card into our DOM-free display (before the machine starts).
      const vga = (emulator as unknown as VgaHolder).v86?.cpu?.devices?.vga;
      this.display = this.newDisplay();
      if (vga) vga.screen = this.display;
      this.startDisplayTimer();

      for (const t of terminals) {
        emulator.add_listener(`serial${t}-output-byte`, ((byte: number) => this.onSerialByte(t, byte)) as (a: never) => void);
      }

      this.rootFs = new V86GuestFS(emulator.fs9p, this.profile.rootDir);
      const project = new V86GuestFS(emulator.fs9p, this.profile.rootDir.replace(/\/$/, "") + this.profile.projectDir);
      project.ensureRoot();
      for (const [path, file] of Object.entries(this.profile.bootFiles)) {
        await this.rootFs.write(path, encoder.encode(file.content));
        this.rootFs.chmod(path, file.mode ?? 0o644);
      }
      for (const t of terminals) this.writeSize(t);
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

  private onSerialByte(terminal: number, byte: number) {
    this.outBuf[terminal].push(byte);
    this.flushTimer ??= setTimeout(() => this.flushOutput(), 8);
    // The system console (terminal 0) announces readiness once its login shell has started.
    if (terminal !== 0) return;
    this.tail = (this.tail + String.fromCharCode(byte)).slice(-64);
    if (this.tail.endsWith(this.profile.readyMarker) && this.status === "booting") {
      this.flushOutput(); // deliver the boot log before announcing readiness
      this.setStatus("running");
      for (const cb of [...this.readyCbs]) cb();
    }
  }

  private flushOutput() {
    this.flushTimer = null;
    for (const t of terminals) {
      if (!this.outBuf[t].length) continue;
      const chunk = Uint8Array.from(this.outBuf[t]);
      this.outBuf[t] = [];
      this.logs.push(t, chunk);
      for (const cb of [...this.outputCbs]) cb(chunk, t);
    }
  }

  async shutdown(): Promise<void> {
    if (this.status === "stopped") return;
    this.generation++;
    this.setStatus("stopping");
    await this.teardown();
    this.setStatus("stopped");
  }

  private async teardown() {
    this.stopDisplayTimer();
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

  sendInput(data: string, terminal = 0): void {
    if (!this.emulator || (this.status !== "running" && this.status !== "booting")) return;
    this.emulator.serial_send_bytes(terminal, encoder.encode(data));
  }

  closeTerminal(terminal: number): void {
    if (terminal === 0) return;
    endShell((data) => this.sendInput(data, terminal));
    this.logs.clear(terminal);
  }

  /** The shell applies the new size at its next prompt (see the profile script). */
  resize(cols: number, rows: number, terminal = 0): void {
    this.sizes[terminal] = { cols, rows };
    this.writeSize(terminal);
  }

  private writeSize(terminal: number) {
    const size = this.sizes[terminal];
    if (!this.rootFs || !size || this.status === "stopped") return;
    void this.rootFs.write(`/etc/simos-size.${terminal}`, encoder.encode(`rows ${size.rows} cols ${size.cols}\n`));
  }
}

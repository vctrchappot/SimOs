/**
 * A bare PC: no Linux, no filesystem share, just BIOS, VGA, keyboard, mouse, a serial port and one
 * disk image that you built. This is where a home-made operating system boots.
 */
import { Breakpoints, readRegisters, type CpuLike, type DebugSnapshot } from "./debugger";
import { decode, nextAddresses, type StepContext } from "./x86";
import { DisplayAdapter, type DisplayFrame } from "./display";
import type { RuntimeStatus } from "./types";
import type { V86Environment } from "./v86-runtime";

export type DriveKind = "cdrom" | "fda" | "hda";

/** The spin lock written over code to park the CPU (`jmp $`). */
const SPIN = Uint8Array.of(0xeb, 0xfe);

/** Longest time a single step may take, for instructions that wait (BIOS keyboard calls, hlt). */
const STEP_TIMEOUT_MS = 3000;

/** A released breakpoint re-arms after this many 25 ms ticks (there is no single-step to do it sooner). */
const REARM_TICKS = 6;

/** Where the BIOS loads the boot sector. */
export const BOOT_ADDRESS = 0x7c00;

const FLOPPY_SIZES = [160, 180, 320, 360, 720, 1200, 1440, 2880].map((kb) => kb * 1024);

/** Which kind of drive an image should be attached as, from its name and size. */
export function driveFor(path: string, size: number): DriveKind {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "iso") return "cdrom";
  if (["flp", "fd", "vfd", "ima", "dsk"].includes(ext)) return "fda";
  if (ext === "img" && FLOPPY_SIZES.includes(size)) return "fda";
  return "hda";
}

/**
 * The emulator reads disks in blocks larger than a sector, so an image that ends mid-block makes it read past
 * the end. Zero-padding a hard-disk image to a whole number of 64 KiB blocks is invisible to a boot sector.
 */
export function padImage(image: Uint8Array, kind: DriveKind): Uint8Array {
  if (kind !== "hda") return image;
  const block = 64 * 1024;
  const size = Math.max(block, Math.ceil(image.length / block) * block);
  if (size === image.length) return image;
  const padded = new Uint8Array(size);
  padded.set(image);
  return padded;
}

/** Disk images the machine can boot: raw sector images from your build, by file extension. */
export function isBootImage(path: string): boolean {
  return /\.(img|bin|iso|flp|fd|vfd|ima|dsk)$/i.test(path);
}

interface Emulator {
  add_listener(event: string, cb: (arg: never) => void): void;
  run(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
  serial_send_bytes(serial: number, data: Uint8Array): void;
  bus: { send(name: string, data: unknown): void };
}
interface VgaHolder {
  v86?: { cpu?: CpuLike & { devices?: { vga?: { screen: unknown; screen_fill_buffer(): void } } } };
}

export interface DebugState {
  paused: boolean;
  hit: number | null;
}

export interface BareMetalBoot {
  image: Uint8Array;
  /** File name, used to pick the drive type. */
  name: string;
  memoryMB?: number;
  /**
   * Breakpoints (flat addresses). Those inside the boot sector (0x7C00-0x7DFD) are patched into the image itself, so
   * the machine stops even on the very first instructions, before anything could set a breakpoint in memory.
   */
  breakpoints?: number[];
}

export class BareMetalMachine {
  status: RuntimeStatus = "stopped";
  private emulator: Emulator | null = null;
  private display = this.newDisplay();
  private displayCbs = new Set<(f: DisplayFrame) => void>();
  private displayTimer: ReturnType<typeof setInterval> | null = null;
  private statusCbs = new Set<(s: RuntimeStatus, detail?: string) => void>();
  private serialCbs = new Set<(data: Uint8Array) => void>();
  private serialBuf: number[] = [];
  private serialTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private paused = false;
  private hit: number | null = null;
  private resumedTicks = 0;
  private debugTimer: ReturnType<typeof setInterval> | null = null;
  private debugCbs = new Set<(s: DebugState) => void>();
  private breakpoints = new Breakpoints(() => this.cpu());
  private stepping = false;

  constructor(private env: V86Environment) {}

  private newDisplay() {
    const d = new DisplayAdapter();
    d.onFrame = (frame) => {
      for (const cb of [...this.displayCbs]) cb(frame);
    };
    return d;
  }

  onStatus(cb: (s: RuntimeStatus, detail?: string) => void) {
    this.statusCbs.add(cb);
    return () => void this.statusCbs.delete(cb);
  }
  private setStatus(s: RuntimeStatus, detail?: string) {
    this.status = s;
    for (const cb of [...this.statusCbs]) cb(s, detail);
  }

  /** Bytes the guest writes to its first serial port (COM1, I/O port 0x3F8). */
  onSerial(cb: (data: Uint8Array) => void) {
    this.serialCbs.add(cb);
    return () => void this.serialCbs.delete(cb);
  }

  /** Called when the machine pauses (e.g. at a breakpoint) or resumes. */
  onDebugState(cb: (s: DebugState) => void) {
    this.debugCbs.add(cb);
    return () => void this.debugCbs.delete(cb);
  }
  private notifyDebug() {
    for (const cb of [...this.debugCbs]) cb({ paused: this.paused, hit: this.hit });
  }
  private cpu(): CpuLike | null {
    return ((this.emulator as unknown as VgaHolder | null)?.v86?.cpu as CpuLike | undefined) ?? null;
  }

  /** Stops the CPU; the screen and memory stay as they are until resume(). */
  async pause() {
    if (this.status !== "running" || this.paused || !this.emulator) return;
    await this.emulator.stop();
    this.paused = true;
    this.notifyDebug();
  }

  async resume(): Promise<void> {
    if (this.status !== "running" || !this.paused || !this.emulator) return;
    if (this.hit !== null) {
      // Execute the instruction under the breakpoint on its own, so the breakpoint is armed again before the
      // program can come back to it (this is what makes breakpoints in loops work).
      const at = this.hit;
      const result = await this.step();
      if (result === "hit") return; // stopped again, at another breakpoint
      if (result === "unsupported") this.breakpoints.release(at); // can't step it: run the real instruction, re-arm later
      // After a one-byte instruction the CPU sits inside the breakpoint's two bytes; step on until it is clear of them.
      for (let i = 0; i < 2 && result === "stepped" && this.breakpoints.waitingFor((this.cpu()?.instruction_pointer[0] ?? 0) >>> 0); i++) {
        if ((await this.step()) !== "stepped") break;
      }
      if (this.hit !== null) return;
    }
    this.hit = null;
    this.paused = false;
    this.resumedTicks = 0;
    this.notifyDebug();
    await this.emulator.run();
    this.flushKeys();
  }

  /** Registers and memory in the shape the decoder wants. */
  private stepContext(): StepContext | null {
    const cpu = this.cpu();
    if (!cpu) return null;
    return {
      reg: [...cpu.reg32],
      sreg: [...cpu.sreg],
      protectedMode: cpu.protected_mode[0] !== 0,
      bits: cpu.is_32[0] ? 32 : 16,
      read: (addr, length) => this.breakpoints.read(addr, length),
    };
  }

  /**
   * Runs exactly one instruction (calls, interrupts and repeated string operations count as one and run to
   * completion). Possible while paused. Finds the addresses execution can reach next with the decoder, parks
   * temporary spin locks there, and lets the CPU run until it lands on one.
   */
  async step(): Promise<"stepped" | "hit" | "unsupported" | "timeout"> {
    const cpu = this.cpu();
    const ctx = this.stepContext();
    if (this.status !== "running" || !this.paused || !this.emulator || !cpu || !ctx) return "unsupported";
    const ip = cpu.instruction_pointer[0] >>> 0;
    const insn = decode(ctx.read, ip, { bits: ctx.bits, csBase: ctx.protectedMode ? 0 : ctx.sreg[1] * 16 });
    const targets = insn && nextAddresses(insn, ctx);
    if (!targets) return "unsupported";

    if (this.hit !== null) this.breakpoints.release(this.hit);
    const parked = new Map<number, Uint8Array>();
    for (const t of new Set(targets)) {
      if (this.breakpoints.hitAt(t) !== null) continue; // an armed breakpoint stops it by itself
      parked.set(t, cpu.mem8.slice(t, t + 2));
      cpu.write_blob(SPIN, t);
    }
    const wanted = new Set(targets);
    this.stepping = true;
    this.hit = null;
    this.paused = false;
    let landed = false;
    try {
      await this.emulator.run();
      const deadline = Date.now() + STEP_TIMEOUT_MS;
      while (Date.now() < deadline && this.status === "running") {
        await new Promise((r) => setTimeout(r, 2));
        if (wanted.has(cpu.instruction_pointer[0] >>> 0)) {
          landed = true;
          break;
        }
      }
      if (this.status !== "running") return "timeout";
      await this.emulator.stop();
    } finally {
      for (const [addr, original] of parked) cpu.write_blob(original, addr);
      this.stepping = false;
    }
    const now = cpu.instruction_pointer[0] >>> 0;
    this.breakpoints.rearm(now);
    this.hit = this.breakpoints.hitAt(now);
    this.paused = true;
    this.notifyDebug();
    return landed ? (this.hit !== null ? "hit" : "stepped") : "timeout";
  }

  /** Flat addresses to break at (see debugger.ts for how this works and its limits). */
  setBreakpoints(addresses: number[]) {
    this.breakpoints.set(addresses);
    this.startDebugTimer();
  }

  /** Current registers, breakpoints and (optionally) a window of memory. */
  inspect(memory?: { addr: number; length: number }, codeLines = 0): DebugSnapshot {
    const cpu = this.cpu();
    const data = memory ? this.breakpoints.read(memory.addr, memory.length) : null;
    return {
      paused: this.paused,
      hit: this.hit,
      breakpoints: this.breakpoints.addresses,
      registers: cpu && this.status === "running" ? readRegisters(cpu) : null,
      memory: memory && data ? { addr: memory.addr, data } : null,
      code: codeLines > 0 ? this.disassemble(codeLines) : null,
    };
  }

  /** Instructions from the current instruction pointer on (the unambiguous direction: x86 can't be read backwards). */
  private disassemble(count: number): DebugSnapshot["code"] {
    const ctx = this.stepContext();
    const cpu = this.cpu();
    if (!ctx || !cpu || this.status !== "running") return null;
    const csBase = ctx.protectedMode ? 0 : ctx.sreg[1] * 16;
    const lines: NonNullable<DebugSnapshot["code"]> = [];
    let at = cpu.instruction_pointer[0] >>> 0;
    for (let i = 0; i < count; i++) {
      const insn = decode(ctx.read, at, { bits: ctx.bits, csBase });
      if (!insn) break;
      lines.push({ addr: insn.addr, length: insn.length, bytes: insn.bytes, text: insn.text });
      at += insn.length;
    }
    return lines;
  }

  /** Watches for the CPU parking on a breakpoint, and re-arms released ones once it has moved on. */
  private startDebugTimer() {
    if (this.debugTimer || !this.breakpoints.addresses.length) return;
    this.debugTimer = setInterval(() => {
      const cpu = this.cpu();
      if (!cpu || this.paused || this.stepping || this.hit !== null || this.status !== "running") return;
      const ip = cpu.instruction_pointer[0] >>> 0;
      const hit = this.breakpoints.hitAt(ip);
      if (hit !== null) {
        this.hit = hit;
        void this.emulator?.stop().then(() => {
          this.paused = true;
          this.notifyDebug();
        });
        return;
      }
      if (++this.resumedTicks >= REARM_TICKS) this.breakpoints.rearm(ip);
    }, 25);
  }
  private stopDebugTimer() {
    if (this.debugTimer) clearInterval(this.debugTimer);
    this.debugTimer = null;
  }

  onDisplay(cb: (f: DisplayFrame) => void) {
    this.displayCbs.add(cb);
    this.display.invalidate();
    this.startDisplayTimer();
    return () => {
      this.displayCbs.delete(cb);
      if (!this.displayCbs.size) this.stopDisplayTimer();
    };
  }
  private startDisplayTimer() {
    if (this.displayTimer || !this.emulator || !this.displayCbs.size) return;
    this.displayTimer = setInterval(() => {
      (this.emulator as unknown as VgaHolder | null)?.v86?.cpu?.devices?.vga?.screen_fill_buffer();
      this.display.flush();
    }, 33);
  }
  private stopDisplayTimer() {
    if (this.displayTimer) clearInterval(this.displayTimer);
    this.displayTimer = null;
  }

  async boot({ image, name, memoryMB = 64, breakpoints = [] }: BareMetalBoot): Promise<void> {
    if (this.status === "booting" || this.status === "running") return;
    const gen = ++this.generation;
    this.setStatus("booting");
    try {
      const V86 = await this.env.loadV86();
      const kind = driveFor(name, image.length);
      let bytes = padImage(image, kind);
      const preloaded: Array<[number, Uint8Array]> = [];
      if (breakpoints.length && kind !== "cdrom") {
        bytes = bytes === image ? image.slice() : bytes;
        for (const addr of breakpoints) {
          const at = addr - BOOT_ADDRESS;
          if (at < 0 || at + 2 > 510 || at + 2 > bytes.length) continue;
          preloaded.push([addr, bytes.slice(at, at + 2)]);
          bytes.set([0xeb, 0xfe], at);
        }
      }
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const options: Record<string, unknown> = {
        memory_size: memoryMB * 1024 * 1024,
        vga_memory_size: 8 * 1024 * 1024,
        autostart: false,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
        [kind]: { buffer },
        ...this.env.machineOptions,
      };
      // Floppy and hard-disk images are tried in v86's usual order; a CD boots from the CD drive.
      options.boot_order = options.cdrom ? 0x123 : options.fda ? 0x321 : 0x312;
      const emulator = new (V86 as unknown as new (o: Record<string, unknown>) => Emulator)(options);
      await new Promise<void>((resolve) => emulator.add_listener("emulator-ready", () => resolve()));
      if (gen !== this.generation) return void (await emulator.destroy());
      this.emulator = emulator;
      this.breakpoints = new Breakpoints(() => this.cpu());
      for (const [addr, original] of preloaded) this.breakpoints.preloaded(addr, original);
      this.startDebugTimer();
      this.display = this.newDisplay();
      const vga = (emulator as unknown as VgaHolder).v86?.cpu?.devices?.vga;
      if (vga) vga.screen = this.display;
      emulator.add_listener("serial0-output-byte", ((byte: number) => {
        this.serialBuf.push(byte);
        this.serialTimer ??= setTimeout(() => this.flushSerial(), 8);
      }) as (a: never) => void);
      await emulator.run();
      this.startDisplayTimer();
      this.setStatus("running");
    } catch (e) {
      this.setStatus("error", e instanceof Error ? e.message : String(e));
      await this.teardown();
    }
  }

  private flushSerial() {
    this.serialTimer = null;
    if (!this.serialBuf.length) return;
    const chunk = Uint8Array.from(this.serialBuf);
    this.serialBuf = [];
    for (const cb of [...this.serialCbs]) cb(chunk);
  }

  sendSerial(data: Uint8Array) {
    if (this.status === "running") this.emulator?.serial_send_bytes(0, data);
  }
  /** Keys typed while the machine is stopped wait here: delivering them would let the CPU take an interrupt and move. */
  private queuedKeys: number[] = [];

  sendKeys(codes: number[]) {
    if (this.status !== "running") return;
    if (this.paused || this.stepping) return void this.queuedKeys.push(...codes);
    for (const code of codes) this.emulator?.bus.send("keyboard-code", code);
  }
  private flushKeys() {
    const codes = this.queuedKeys;
    this.queuedKeys = [];
    for (const code of codes) this.emulator?.bus.send("keyboard-code", code);
  }
  sendMouse(dx: number, dy: number, buttons: [boolean, boolean, boolean]) {
    if (this.status !== "running" || this.paused || this.stepping) return;
    if (dx || dy) this.emulator?.bus.send("mouse-delta", [dx, -dy]);
    this.emulator?.bus.send("mouse-click", buttons);
  }

  async shutdown() {
    if (this.status === "stopped") return;
    this.generation++;
    this.setStatus("stopping");
    await this.teardown();
    this.setStatus("stopped");
  }

  private async teardown() {
    this.stopDisplayTimer();
    this.stopDebugTimer();
    this.breakpoints = new Breakpoints(() => this.cpu());
    this.paused = false;
    this.hit = null;
    this.queuedKeys = [];
    this.flushSerial();
    const emulator = this.emulator;
    this.emulator = null;
    if (emulator) {
      try {
        await emulator.destroy();
      } catch {
        /* already gone */
      }
    }
  }
}

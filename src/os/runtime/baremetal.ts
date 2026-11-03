/**
 * A bare PC: no Linux, no filesystem share, just BIOS, VGA, keyboard, mouse, a serial port and one
 * disk image that you built. This is where a home-made operating system boots.
 */
import { DisplayAdapter, type DisplayFrame } from "./display";
import type { RuntimeStatus } from "./types";
import type { V86Environment } from "./v86-runtime";

export type DriveKind = "cdrom" | "fda" | "hda";

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
  v86?: { cpu?: { devices?: { vga?: { screen: unknown; screen_fill_buffer(): void } } } };
}

export interface BareMetalBoot {
  image: Uint8Array;
  /** File name, used to pick the drive type. */
  name: string;
  memoryMB?: number;
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

  async boot({ image, name, memoryMB = 64 }: BareMetalBoot): Promise<void> {
    if (this.status === "booting" || this.status === "running") return;
    const gen = ++this.generation;
    this.setStatus("booting");
    try {
      const V86 = await this.env.loadV86();
      const kind = driveFor(name, image.length);
      const bytes = padImage(image, kind);
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
  sendKeys(codes: number[]) {
    if (this.status !== "running") return;
    for (const code of codes) this.emulator?.bus.send("keyboard-code", code);
  }
  sendMouse(dx: number, dy: number, buttons: [boolean, boolean, boolean]) {
    if (this.status !== "running") return;
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

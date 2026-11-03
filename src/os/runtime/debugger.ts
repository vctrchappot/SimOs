/**
 * Inspecting a running bare-metal machine: registers, memory, pause/resume and address breakpoints.
 *
 * The emulator has no single-step or breakpoint hook, so a breakpoint is a spin lock: the two bytes at the
 * address are replaced with `jmp $` (EB FE). When the CPU parks there the machine is paused, the original
 * bytes are put back, and resuming continues with the real instruction. The emulator offers no single-step, so
 * the breakpoint re-arms about 150 ms after Continue: it suits code that runs per event (a key press, an interrupt,
 * a command), not a tight loop, which runs through it many times before it is armed again. Put breakpoints on
 * the first byte of an instruction (two bytes get patched).
 */

export interface Registers {
  eax: number;
  ecx: number;
  edx: number;
  ebx: number;
  esp: number;
  ebp: number;
  esi: number;
  edi: number;
  /** Offset within CS. */
  eip: number;
  /** CS:eip as a flat address (what breakpoints and the memory view use). */
  linearIp: number;
  eflags: number;
  cs: number;
  ds: number;
  es: number;
  ss: number;
  fs: number;
  gs: number;
  protectedMode: boolean;
  cr0: number;
}

/** One disassembled instruction. */
export interface CodeLine {
  addr: number;
  length: number;
  bytes: number[];
  text: string;
}

export interface DebugSnapshot {
  paused: boolean;
  /** Address of the breakpoint that stopped the machine, if that is why it is paused. */
  hit: number | null;
  breakpoints: number[];
  registers: Registers | null;
  memory: { addr: number; data: Uint8Array } | null;
  /** Instructions starting at the current instruction pointer (when asked for). */
  code: CodeLine[] | null;
}

/** The slice of the emulator's CPU this module reads (v86 internals). */
export interface CpuLike {
  reg32: Int32Array;
  sreg: Uint16Array;
  instruction_pointer: Int32Array;
  protected_mode: Uint8Array;
  cr: Int32Array;
  mem8: Uint8Array;
  is_32: Uint8Array | Int32Array;
  get_eflags(): number;
  get_real_eip(): number;
  write_blob(blob: Uint8Array, offset: number): void;
}

const SPIN = Uint8Array.of(0xeb, 0xfe);

const covers = (addr: number, ip: number) => ip >= addr && ip < addr + SPIN.length;

export function readRegisters(cpu: CpuLike): Registers {
  const r = cpu.reg32;
  const u = (n: number) => n >>> 0;
  return {
    eax: u(r[0]),
    ecx: u(r[1]),
    edx: u(r[2]),
    ebx: u(r[3]),
    esp: u(r[4]),
    ebp: u(r[5]),
    esi: u(r[6]),
    edi: u(r[7]),
    eip: u(cpu.get_real_eip()),
    linearIp: u(cpu.instruction_pointer[0]),
    eflags: u(cpu.get_eflags()),
    es: cpu.sreg[0],
    cs: cpu.sreg[1],
    ss: cpu.sreg[2],
    ds: cpu.sreg[3],
    fs: cpu.sreg[4],
    gs: cpu.sreg[5],
    protectedMode: cpu.protected_mode[0] !== 0,
    cr0: u(cpu.cr[0]),
  };
}

/** Parses "0x7c00", "7c00h", "31744" or real-mode "0000:7c00" into a flat address. Returns null if invalid. */
export function parseAddress(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const num = (t: string): number | null => {
    const m = t.match(/^(?:0x([0-9a-f]+)|([0-9a-f]+)h|(\d+))$/);
    if (!m) return null;
    return m[1] !== undefined ? parseInt(m[1], 16) : m[2] !== undefined ? parseInt(m[2], 16) : parseInt(m[3], 10);
  };
  const seg = text.match(/^([^:]+):([^:]+)$/);
  if (seg) {
    const s = num(seg[1].startsWith("0x") || seg[1].endsWith("h") ? seg[1] : "0x" + seg[1]);
    const o = num(seg[2].startsWith("0x") || seg[2].endsWith("h") ? seg[2] : "0x" + seg[2]);
    return s === null || o === null || s > 0xffff || o > 0xffff ? null : s * 16 + o;
  }
  const n = num(text);
  return n === null || !Number.isSafeInteger(n) || n > 0xffffffff ? null : n;
}

/** Breakpoint bookkeeping on top of a CPU's memory. */
export class Breakpoints {
  private points = new Map<number, { original: Uint8Array; armed: boolean }>();

  constructor(private cpu: () => CpuLike | null) {}

  get addresses(): number[] {
    return [...this.points.keys()].sort((a, b) => a - b);
  }

  /** Registers a breakpoint that is already patched into the program (used for the boot sector, see baremetal.ts). */
  preloaded(addr: number, original: Uint8Array) {
    this.points.set(addr, { original, armed: true });
  }

  /** Replaces the set of breakpoints, arming new ones and disarming removed ones. */
  set(addresses: number[]): void {
    const want = new Set(addresses);
    for (const addr of [...this.points.keys()]) if (!want.has(addr)) this.remove(addr);
    for (const addr of want) if (!this.points.has(addr)) this.add(addr);
  }

  private add(addr: number) {
    const cpu = this.cpu();
    if (!cpu || addr + 2 > cpu.mem8.length) return;
    this.points.set(addr, { original: cpu.mem8.slice(addr, addr + 2), armed: false });
    this.arm(addr);
  }

  private remove(addr: number) {
    this.disarm(addr);
    this.points.delete(addr);
  }

  private arm(addr: number) {
    const p = this.points.get(addr);
    const cpu = this.cpu();
    if (!p || !cpu || p.armed) return;
    p.original = cpu.mem8.slice(addr, addr + 2); // the code may have been rewritten since
    cpu.write_blob(SPIN, addr);
    p.armed = true;
  }

  private disarm(addr: number) {
    const p = this.points.get(addr);
    const cpu = this.cpu();
    if (!p || !cpu || !p.armed) return;
    cpu.write_blob(p.original, addr);
    p.armed = false;
  }

  /** The armed breakpoint the CPU is parked on, if any. */
  hitAt(linearIp: number): number | null {
    const p = this.points.get(linearIp);
    return p?.armed ? linearIp : null;
  }

  /** Puts the original instruction back so execution can continue through it. */
  release(addr: number) {
    this.disarm(addr);
  }

  /**
   * Re-arms every released breakpoint the CPU has moved away from. The spin lock is two bytes long, so while the
   * CPU is on the second of them (after a one-byte instruction) the breakpoint has to wait.
   */
  rearm(linearIp: number) {
    for (const [addr, p] of this.points) if (!p.armed && !covers(addr, linearIp)) this.arm(addr);
  }

  /** True if a released breakpoint is waiting for the CPU to leave its two bytes. */
  waitingFor(linearIp: number): boolean {
    for (const [addr, p] of this.points) if (!p.armed && covers(addr, linearIp)) return true;
    return false;
  }

  get hasDisarmed(): boolean {
    return [...this.points.values()].some((p) => !p.armed);
  }

  /** Memory with armed breakpoints hidden, so the view shows the program, not the spin lock. */
  read(addr: number, length: number): Uint8Array | null {
    const cpu = this.cpu();
    if (!cpu || addr < 0 || addr >= cpu.mem8.length) return null;
    const end = Math.min(cpu.mem8.length, addr + length);
    const out = cpu.mem8.slice(addr, end);
    for (const [a, p] of this.points) {
      if (!p.armed) continue;
      for (let i = 0; i < 2; i++) if (a + i >= addr && a + i < end) out[a + i - addr] = p.original[i];
    }
    return out;
  }
}

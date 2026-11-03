/**
 * An x86 instruction decoder for the 16- and 32-bit modes: instruction length, Intel-syntax text, and
 * where execution goes next (for stepping). It covers the integer instruction set, the common 0F
 * extensions and the x87 escape bytes; anything else decodes as `db`, which stepping refuses.
 */

export type Flow =
  | { kind: "seq" }
  | { kind: "jump"; target: number }
  | { kind: "branch"; target: number }
  | { kind: "call"; target: number | null }
  | { kind: "ret"; far: boolean; iret: boolean; pop: number }
  | { kind: "indirect"; call: boolean; far: boolean; operand: Operand }
  | { kind: "int" }
  | { kind: "halt" }
  | { kind: "unknown" };

/** A register or memory operand taken from a ModRM byte, kept symbolic so stepping can evaluate it. */
export interface Operand {
  reg: number | null;
  mem: { base: number | null; index: number | null; scale: number; disp: number; wide: boolean; segment: number | null } | null;
}

export interface Insn {
  /** Flat address the instruction was read from. */
  addr: number;
  length: number;
  bytes: number[];
  text: string;
  flow: Flow;
}

export interface DecodeOptions {
  /** 16 or 32: the code segment's default operand size. */
  bits: 16 | 32;
  /** Flat address of the start of the code segment (CS << 4 in real mode, 0 when flat); branch targets use it. */
  csBase: number;
}

type Reader = (addr: number, length: number) => Uint8Array | null;

const R8 = ["al", "cl", "dl", "bl", "ah", "ch", "dh", "bh"];
const R16 = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"];
const R32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
const SEG = ["es", "cs", "ss", "ds", "fs", "gs", "?", "?"];
const ALU = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"];
const SHIFT = ["rol", "ror", "rcl", "rcr", "shl", "shr", "shl", "sar"];
const CC = ["o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g"];
const SEG_PREFIX: Record<number, number> = { 0x26: 0, 0x2e: 1, 0x36: 2, 0x3e: 3, 0x64: 4, 0x65: 5 };
const SIZE_NAME: Record<number, string> = { 8: "byte", 16: "word", 32: "dword" };

class Incomplete extends Error {}

const hex = (n: number) => "0x" + (n >>> 0).toString(16);
const signed = (n: number) => (n < 0 ? "-" + hex(-n) : "+" + hex(n));

class Cursor {
  pos = 0;
  constructor(
    private bytes: Uint8Array,
  ) {}
  peek(): number {
    if (this.pos >= this.bytes.length) throw new Incomplete();
    return this.bytes[this.pos];
  }
  u8(): number {
    if (this.pos >= this.bytes.length) throw new Incomplete();
    return this.bytes[this.pos++];
  }
  s8(): number {
    return (this.u8() << 24) >> 24;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  s16(): number {
    return (this.u16() << 16) >> 16;
  }
  u32(): number {
    return (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) >>> 0;
  }
  s32(): number {
    return this.u32() | 0;
  }
}

const MAX_LEN = 15;

/** Decodes the instruction at `addr`. Returns null when its bytes can't be read. */
export function decode(read: Reader, addr: number, opts: DecodeOptions): Insn | null {
  const bytes = read(addr, MAX_LEN);
  if (!bytes || !bytes.length) return null;
  const c = new Cursor(bytes);
  try {
    const insn = decodeAt(c, addr, opts);
    return { ...insn, addr, length: c.pos, bytes: [...bytes.slice(0, c.pos)] };
  } catch (e) {
    if (!(e instanceof Incomplete)) throw e;
    return { addr, length: 1, bytes: [bytes[0]], text: `db ${hex(bytes[0])}`, flow: { kind: "unknown" } };
  }
}

function decodeAt(c: Cursor, addr: number, opts: DecodeOptions): Omit<Insn, "addr" | "length" | "bytes"> {
  let opsize = false;
  let addrsize = false;
  let segment: number | null = null;
  let prefix = "";
  for (;;) {
    const b = c.peek();
    if (b === 0x66) opsize = true;
    else if (b === 0x67) addrsize = true;
    else if (b in SEG_PREFIX) segment = SEG_PREFIX[b];
    else if (b === 0xf0) prefix = "lock ";
    else if (b === 0xf2) prefix = "repne ";
    else if (b === 0xf3) prefix = "rep ";
    else break;
    c.u8();
    if (c.pos > 14) break;
  }
  const osz: 16 | 32 = (opts.bits === 32) !== opsize ? 32 : 16;
  const wide = (opts.bits === 32) !== addrsize; // 32-bit addressing
  const rname = (n: number, size: number) => (size === 8 ? R8[n] : size === 16 ? R16[n] : R32[n]);
  const imm = (size: number) => (size === 8 ? c.u8() : size === 16 ? c.u16() : c.u32());
  const simm = (size: number) => (size === 8 ? c.s8() : size === 16 ? c.s16() : c.s32());
  const offsetOf = (len: number) => addr - opts.csBase + len; // ip after the instruction, assuming `len` bytes
  const mask = osz === 32 ? 0xffffffff : 0xffff;
  const rel = (disp: number) => opts.csBase + (((offsetOf(c.pos) + disp) & mask) >>> 0);
  const out = (text: string, flow: Flow = { kind: "seq" }) => ({ text: prefix + text, flow });

  // ModRM: returns the operand text for r/m (sized) plus the symbolic operand.
  interface Modrm {
    mod: number;
    reg: number;
    rm: number;
    operand: Operand;
    text(size: number, showSize?: boolean): string;
  }
  const modrm = (): Modrm => {
    const b = c.u8();
    const mod = b >> 6;
    const reg = (b >> 3) & 7;
    const rm = b & 7;
    let operand: Operand;
    let memText = "";
    if (mod === 3) operand = { reg: rm, mem: null };
    else {
      let base: number | null = null;
      let index: number | null = null;
      let scale = 1;
      let disp = 0;
      const parts: string[] = [];
      if (wide) {
        if (rm === 4) {
          const sib = c.u8();
          scale = 1 << (sib >> 6);
          const idx = (sib >> 3) & 7;
          const bs = sib & 7;
          if (idx !== 4) index = idx;
          if (bs === 5 && mod === 0) disp = c.s32();
          else base = bs;
        } else if (rm === 5 && mod === 0) disp = c.s32();
        else base = rm;
        if (mod === 1) disp = c.s8();
        else if (mod === 2) disp = c.s32();
        if (base !== null) parts.push(R32[base]);
        if (index !== null) parts.push(R32[index] + (scale > 1 ? `*${scale}` : ""));
      } else {
        const table: Array<[number | null, number | null]> = [[3, 6], [3, 7], [5, 6], [5, 7], [6, null], [7, null], [5, null], [3, null]];
        if (rm === 6 && mod === 0) disp = c.u16();
        else [base, index] = table[rm];
        if (mod === 1) disp = c.s8();
        else if (mod === 2) disp = c.s16();
        if (base !== null) parts.push(R16[base]);
        if (index !== null) parts.push(R16[index]);
      }
      const absolute = parts.length === 0;
      let inner = parts.join("+");
      if (absolute) inner = hex(wide ? disp : disp & 0xffff);
      else if (disp) inner += signed(disp);
      memText = `${segment !== null ? SEG[segment] + ":" : ""}[${inner}]`;
      operand = { reg: null, mem: { base, index, scale, disp, wide, segment } };
    }
    return {
      mod,
      reg,
      rm,
      operand,
      text: (size, showSize = true) => (mod === 3 ? rname(rm, size) : (showSize ? SIZE_NAME[size] + " " : "") + memText),
    };
  };
  const regOf = (m: Modrm, size: number) => rname(m.reg, size);

  const op = c.u8();

  // ---- ALU block 00-3F ---------------------------------------------------------------------
  if (op < 0x40 && (op & 7) < 6) {
    const name = ALU[op >> 3];
    switch (op & 7) {
      case 0: { const m = modrm(); return out(`${name} ${m.text(8, false)}, ${regOf(m, 8)}`); }
      case 1: { const m = modrm(); return out(`${name} ${m.text(osz, false)}, ${regOf(m, osz)}`); }
      case 2: { const m = modrm(); return out(`${name} ${regOf(m, 8)}, ${m.text(8, false)}`); }
      case 3: { const m = modrm(); return out(`${name} ${regOf(m, osz)}, ${m.text(osz, false)}`); }
      case 4: return out(`${name} al, ${hex(c.u8())}`);
      default: return out(`${name} ${osz === 32 ? "eax" : "ax"}, ${hex(imm(osz))}`);
    }
  }
  if (op < 0x40) {
    switch (op) {
      case 0x06: case 0x0e: case 0x16: case 0x1e: return out(`push ${SEG[op >> 3]}`);
      case 0x07: case 0x17: case 0x1f: return out(`pop ${SEG[op >> 3]}`);
      case 0x27: return out("daa");
      case 0x2f: return out("das");
      case 0x37: return out("aaa");
      case 0x3f: return out("aas");
      case 0x0f: return decode0f(c, { osz, wide, rel, modrm, regOf, rname, out, hex });
    }
  }
  if (op >= 0x40 && op <= 0x47) return out(`inc ${rname(op & 7, osz)}`);
  if (op >= 0x48 && op <= 0x4f) return out(`dec ${rname(op & 7, osz)}`);
  if (op >= 0x50 && op <= 0x57) return out(`push ${rname(op & 7, osz)}`);
  if (op >= 0x58 && op <= 0x5f) return out(`pop ${rname(op & 7, osz)}`);
  if (op >= 0x70 && op <= 0x7f) {
    const d = c.s8();
    const t = rel(d);
    return out(`j${CC[op & 15]} ${hex(t)}`, { kind: "branch", target: t });
  }
  if (op >= 0x91 && op <= 0x97) return out(`xchg ${rname(op & 7, osz)}, ${osz === 32 ? "eax" : "ax"}`);
  if (op >= 0xb0 && op <= 0xb7) return out(`mov ${R8[op & 7]}, ${hex(c.u8())}`);
  if (op >= 0xb8 && op <= 0xbf) return out(`mov ${rname(op & 7, osz)}, ${hex(imm(osz))}`);
  if (op >= 0xd8 && op <= 0xdf) {
    const m = modrm();
    return out(`fpu ${hex(op)} /${m.reg} ${m.mod === 3 ? "st" + m.rm : m.text(32, false)}`);
  }

  switch (op) {
    case 0x60: return out(osz === 32 ? "pushad" : "pusha");
    case 0x61: return out(osz === 32 ? "popad" : "popa");
    case 0x62: { const m = modrm(); return out(`bound ${regOf(m, osz)}, ${m.text(osz, false)}`); }
    case 0x63: { const m = modrm(); return out(`arpl ${m.text(16, false)}, ${regOf(m, 16)}`); }
    case 0x68: return out(`push ${hex(imm(osz))}`);
    case 0x69: { const m = modrm(); return out(`imul ${regOf(m, osz)}, ${m.text(osz, false)}, ${hex(imm(osz))}`); }
    case 0x6a: return out(`push ${signed(c.s8()).replace("+", "")}`);
    case 0x6b: { const m = modrm(); return out(`imul ${regOf(m, osz)}, ${m.text(osz, false)}, ${signed(c.s8()).replace("+", "")}`); }
    case 0x6c: return out("insb");
    case 0x6d: return out(osz === 32 ? "insd" : "insw");
    case 0x6e: return out("outsb");
    case 0x6f: return out(osz === 32 ? "outsd" : "outsw");
    case 0x80: case 0x82: { const m = modrm(); return out(`${ALU[m.reg]} ${m.text(8)}, ${hex(c.u8())}`); }
    case 0x81: { const m = modrm(); return out(`${ALU[m.reg]} ${m.text(osz)}, ${hex(imm(osz))}`); }
    case 0x83: { const m = modrm(); return out(`${ALU[m.reg]} ${m.text(osz)}, ${signed(c.s8()).replace("+", "")}`); }
    case 0x84: { const m = modrm(); return out(`test ${m.text(8, false)}, ${regOf(m, 8)}`); }
    case 0x85: { const m = modrm(); return out(`test ${m.text(osz, false)}, ${regOf(m, osz)}`); }
    case 0x86: { const m = modrm(); return out(`xchg ${m.text(8, false)}, ${regOf(m, 8)}`); }
    case 0x87: { const m = modrm(); return out(`xchg ${m.text(osz, false)}, ${regOf(m, osz)}`); }
    case 0x88: { const m = modrm(); return out(`mov ${m.text(8, false)}, ${regOf(m, 8)}`); }
    case 0x89: { const m = modrm(); return out(`mov ${m.text(osz, false)}, ${regOf(m, osz)}`); }
    case 0x8a: { const m = modrm(); return out(`mov ${regOf(m, 8)}, ${m.text(8, false)}`); }
    case 0x8b: { const m = modrm(); return out(`mov ${regOf(m, osz)}, ${m.text(osz, false)}`); }
    case 0x8c: { const m = modrm(); return out(`mov ${m.text(m.mod === 3 ? osz : 16, false)}, ${SEG[m.reg]}`); }
    case 0x8d: { const m = modrm(); return out(`lea ${regOf(m, osz)}, ${m.text(osz, false)}`); }
    case 0x8e: { const m = modrm(); return out(`mov ${SEG[m.reg]}, ${m.text(m.mod === 3 ? osz : 16, false)}`); }
    case 0x8f: { const m = modrm(); return out(`pop ${m.text(osz)}`); }
    case 0x90: return out(prefix === "rep " ? "pause" : "nop");
    case 0x98: return out(osz === 32 ? "cwde" : "cbw");
    case 0x99: return out(osz === 32 ? "cdq" : "cwd");
    case 0x9a: {
      const off = imm(osz);
      const seg = c.u16();
      return out(`call ${hex(seg)}:${hex(off)}`, { kind: "call", target: opts.bits === 16 && osz === 16 ? seg * 16 + off : null });
    }
    case 0x9b: return out("wait");
    case 0x9c: return out(osz === 32 ? "pushfd" : "pushf");
    case 0x9d: return out(osz === 32 ? "popfd" : "popf");
    case 0x9e: return out("sahf");
    case 0x9f: return out("lahf");
    case 0xa0: return out(`mov al, ${segment !== null ? SEG[segment] + ":" : ""}[${hex(imm(wide ? 32 : 16))}]`);
    case 0xa1: return out(`mov ${osz === 32 ? "eax" : "ax"}, ${segment !== null ? SEG[segment] + ":" : ""}[${hex(imm(wide ? 32 : 16))}]`);
    case 0xa2: return out(`mov ${segment !== null ? SEG[segment] + ":" : ""}[${hex(imm(wide ? 32 : 16))}], al`);
    case 0xa3: return out(`mov ${segment !== null ? SEG[segment] + ":" : ""}[${hex(imm(wide ? 32 : 16))}], ${osz === 32 ? "eax" : "ax"}`);
    case 0xa4: return out("movsb");
    case 0xa5: return out(osz === 32 ? "movsd" : "movsw");
    case 0xa6: return out("cmpsb");
    case 0xa7: return out(osz === 32 ? "cmpsd" : "cmpsw");
    case 0xa8: return out(`test al, ${hex(c.u8())}`);
    case 0xa9: return out(`test ${osz === 32 ? "eax" : "ax"}, ${hex(imm(osz))}`);
    case 0xaa: return out("stosb");
    case 0xab: return out(osz === 32 ? "stosd" : "stosw");
    case 0xac: return out("lodsb");
    case 0xad: return out(osz === 32 ? "lodsd" : "lodsw");
    case 0xae: return out("scasb");
    case 0xaf: return out(osz === 32 ? "scasd" : "scasw");
    case 0xc0: { const m = modrm(); return out(`${SHIFT[m.reg]} ${m.text(8)}, ${hex(c.u8())}`); }
    case 0xc1: { const m = modrm(); return out(`${SHIFT[m.reg]} ${m.text(osz)}, ${hex(c.u8())}`); }
    case 0xc2: { const n = c.u16(); return out(`ret ${hex(n)}`, { kind: "ret", far: false, iret: false, pop: n }); }
    case 0xc3: return out("ret", { kind: "ret", far: false, iret: false, pop: 0 });
    case 0xc4: { const m = modrm(); return out(`les ${regOf(m, osz)}, ${m.text(osz, false)}`); }
    case 0xc5: { const m = modrm(); return out(`lds ${regOf(m, osz)}, ${m.text(osz, false)}`); }
    case 0xc6: { const m = modrm(); return out(`mov ${m.text(8)}, ${hex(c.u8())}`); }
    case 0xc7: { const m = modrm(); return out(`mov ${m.text(osz)}, ${hex(imm(osz))}`); }
    case 0xc8: { const size = c.u16(); const level = c.u8(); return out(`enter ${hex(size)}, ${hex(level)}`); }
    case 0xc9: return out("leave");
    case 0xca: { const n = c.u16(); return out(`retf ${hex(n)}`, { kind: "ret", far: true, iret: false, pop: n }); }
    case 0xcb: return out("retf", { kind: "ret", far: true, iret: false, pop: 0 });
    case 0xcc: return out("int3", { kind: "int" });
    case 0xcd: return out(`int ${hex(c.u8())}`, { kind: "int" });
    case 0xce: return out("into", { kind: "int" });
    case 0xcf: return out(osz === 32 ? "iretd" : "iret", { kind: "ret", far: true, iret: true, pop: 0 });
    case 0xd0: { const m = modrm(); return out(`${SHIFT[m.reg]} ${m.text(8)}, 1`); }
    case 0xd1: { const m = modrm(); return out(`${SHIFT[m.reg]} ${m.text(osz)}, 1`); }
    case 0xd2: { const m = modrm(); return out(`${SHIFT[m.reg]} ${m.text(8)}, cl`); }
    case 0xd3: { const m = modrm(); return out(`${SHIFT[m.reg]} ${m.text(osz)}, cl`); }
    case 0xd4: return out(`aam ${hex(c.u8())}`);
    case 0xd5: return out(`aad ${hex(c.u8())}`);
    case 0xd6: return out("salc");
    case 0xd7: return out("xlatb");
    case 0xe0: case 0xe1: case 0xe2: case 0xe3: {
      const name = ["loopne", "loope", "loop", wide ? "jecxz" : "jcxz"][op - 0xe0];
      const t = rel(c.s8());
      return out(`${name} ${hex(t)}`, { kind: "branch", target: t });
    }
    case 0xe4: return out(`in al, ${hex(c.u8())}`);
    case 0xe5: return out(`in ${osz === 32 ? "eax" : "ax"}, ${hex(c.u8())}`);
    case 0xe6: return out(`out ${hex(c.u8())}, al`);
    case 0xe7: return out(`out ${hex(c.u8())}, ${osz === 32 ? "eax" : "ax"}`);
    case 0xe8: { const t = rel(simm(osz)); return out(`call ${hex(t)}`, { kind: "call", target: t }); }
    case 0xe9: { const t = rel(simm(osz)); return out(`jmp ${hex(t)}`, { kind: "jump", target: t }); }
    case 0xea: {
      const off = imm(osz);
      const seg = c.u16();
      return out(`jmp ${hex(seg)}:${hex(off)}`, { kind: "jump", target: opts.bits === 16 && osz === 16 ? seg * 16 + off : 0 });
    }
    case 0xeb: { const t = rel(c.s8()); return out(`jmp short ${hex(t)}`, { kind: "jump", target: t }); }
    case 0xec: return out("in al, dx");
    case 0xed: return out(`in ${osz === 32 ? "eax" : "ax"}, dx`);
    case 0xee: return out("out dx, al");
    case 0xef: return out(`out dx, ${osz === 32 ? "eax" : "ax"}`);
    case 0xf1: return out("int1", { kind: "int" });
    case 0xf4: return out("hlt", { kind: "halt" });
    case 0xf5: return out("cmc");
    case 0xf6: case 0xf7: {
      const size = op === 0xf6 ? 8 : osz;
      const m = modrm();
      if (m.reg < 2) return out(`test ${m.text(size)}, ${hex(imm(size))}`);
      return out(`${["", "", "not", "neg", "mul", "imul", "div", "idiv"][m.reg]} ${m.text(size)}`);
    }
    case 0xf8: return out("clc");
    case 0xf9: return out("stc");
    case 0xfa: return out("cli");
    case 0xfb: return out("sti");
    case 0xfc: return out("cld");
    case 0xfd: return out("std");
    case 0xfe: {
      const m = modrm();
      if (m.reg > 1) return { text: "(bad)", flow: { kind: "unknown" } };
      return out(`${m.reg ? "dec" : "inc"} ${m.text(8)}`);
    }
    case 0xff: {
      const m = modrm();
      switch (m.reg) {
        case 0: return out(`inc ${m.text(osz)}`);
        case 1: return out(`dec ${m.text(osz)}`);
        case 2: return out(`call ${m.text(osz)}`, { kind: "indirect", call: true, far: false, operand: m.operand });
        case 3: return out(`call far ${m.text(osz)}`, { kind: "indirect", call: true, far: true, operand: m.operand });
        case 4: return out(`jmp ${m.text(osz)}`, { kind: "indirect", call: false, far: false, operand: m.operand });
        case 5: return out(`jmp far ${m.text(osz)}`, { kind: "indirect", call: false, far: true, operand: m.operand });
        case 6: return out(`push ${m.text(osz)}`);
        default: return { text: "(bad)", flow: { kind: "unknown" } };
      }
    }
  }
  return { text: `db ${hex(op)}`, flow: { kind: "unknown" } };
}

interface Ctx {
  osz: 16 | 32;
  wide: boolean;
  rel(disp: number): number;
  modrm(): { mod: number; reg: number; rm: number; operand: Operand; text(size: number, showSize?: boolean): string };
  regOf(m: { reg: number }, size: number): string;
  rname(n: number, size: number): string;
  out(text: string, flow?: Flow): { text: string; flow: Flow };
  hex(n: number): string;
}

function decode0f(c: Cursor, x: Ctx): { text: string; flow: Flow } {
  const { osz, rel, modrm, regOf, out, hex } = x;
  const op = c.u8();
  const unknown = { text: `db 0x0f, ${hex(op)}`, flow: { kind: "unknown" } as Flow };
  if (op >= 0x80 && op <= 0x8f) {
    const t = rel(osz === 32 ? c.s32() : c.s16());
    return out(`j${CC[op & 15]} ${hex(t)}`, { kind: "branch", target: t });
  }
  if (op >= 0x40 && op <= 0x4f) { const m = modrm(); return out(`cmov${CC[op & 15]} ${regOf(m, osz)}, ${m.text(osz, false)}`); }
  if (op >= 0x90 && op <= 0x9f) { const m = modrm(); return out(`set${CC[op & 15]} ${m.text(8, false)}`); }
  if (op >= 0xc8 && op <= 0xcf) return out(`bswap ${x.rname(op & 7, 32)}`);
  switch (op) {
    case 0x00: { const m = modrm(); const n = ["sldt", "str", "lldt", "ltr", "verr", "verw", "(bad)", "(bad)"][m.reg]; return out(`${n} ${m.text(16, false)}`); }
    case 0x01: { const m = modrm(); const n = ["sgdt", "sidt", "lgdt", "lidt", "smsw", "(bad)", "lmsw", "invlpg"][m.reg]; return out(`${n} ${m.text(m.reg === 4 || m.reg === 6 ? 16 : 32, false)}`); }
    case 0x02: { const m = modrm(); return out(`lar ${regOf(m, osz)}, ${m.text(16, false)}`); }
    case 0x03: { const m = modrm(); return out(`lsl ${regOf(m, osz)}, ${m.text(16, false)}`); }
    case 0x05: return out("syscall");
    case 0x06: return out("clts");
    case 0x07: return out("sysret");
    case 0x08: return out("invd");
    case 0x09: return out("wbinvd");
    case 0x0b: return out("ud2");
    case 0x18: { const m = modrm(); return out(`prefetch ${m.text(8, false)}`); }
    case 0x1f: { const m = modrm(); return out(`nop ${m.text(osz)}`); }
    case 0x20: { const m = modrm(); return out(`mov ${x.rname(m.rm, 32)}, cr${m.reg}`); }
    case 0x21: { const m = modrm(); return out(`mov ${x.rname(m.rm, 32)}, dr${m.reg}`); }
    case 0x22: { const m = modrm(); return out(`mov cr${m.reg}, ${x.rname(m.rm, 32)}`); }
    case 0x23: { const m = modrm(); return out(`mov dr${m.reg}, ${x.rname(m.rm, 32)}`); }
    case 0x30: return out("wrmsr");
    case 0x31: return out("rdtsc");
    case 0x32: return out("rdmsr");
    case 0x33: return out("rdpmc");
    case 0x34: return out("sysenter");
    case 0x35: return out("sysexit");
    case 0xa0: return out("push fs");
    case 0xa1: return out("pop fs");
    case 0xa2: return out("cpuid");
    case 0xa3: { const m = modrm(); return out(`bt ${m.text(osz, false)}, ${regOf(m, osz)}`); }
    case 0xa4: { const m = modrm(); return out(`shld ${m.text(osz, false)}, ${regOf(m, osz)}, ${hex(c.u8())}`); }
    case 0xa5: { const m = modrm(); return out(`shld ${m.text(osz, false)}, ${regOf(m, osz)}, cl`); }
    case 0xa8: return out("push gs");
    case 0xa9: return out("pop gs");
    case 0xaa: return out("rsm");
    case 0xab: { const m = modrm(); return out(`bts ${m.text(osz, false)}, ${regOf(m, osz)}`); }
    case 0xac: { const m = modrm(); return out(`shrd ${m.text(osz, false)}, ${regOf(m, osz)}, ${hex(c.u8())}`); }
    case 0xad: { const m = modrm(); return out(`shrd ${m.text(osz, false)}, ${regOf(m, osz)}, cl`); }
    case 0xae: { const m = modrm(); return out(`fence ${m.reg} ${m.text(8, false)}`); }
    case 0xaf: { const m = modrm(); return out(`imul ${regOf(m, osz)}, ${m.text(osz, false)}`); }
    case 0xb0: { const m = modrm(); return out(`cmpxchg ${m.text(8, false)}, ${regOf(m, 8)}`); }
    case 0xb1: { const m = modrm(); return out(`cmpxchg ${m.text(osz, false)}, ${regOf(m, osz)}`); }
    case 0xb2: { const m = modrm(); return out(`lss ${regOf(m, osz)}, ${m.text(osz, false)}`); }
    case 0xb3: { const m = modrm(); return out(`btr ${m.text(osz, false)}, ${regOf(m, osz)}`); }
    case 0xb4: { const m = modrm(); return out(`lfs ${regOf(m, osz)}, ${m.text(osz, false)}`); }
    case 0xb5: { const m = modrm(); return out(`lgs ${regOf(m, osz)}, ${m.text(osz, false)}`); }
    case 0xb6: { const m = modrm(); return out(`movzx ${regOf(m, osz)}, ${m.text(8)}`); }
    case 0xb7: { const m = modrm(); return out(`movzx ${regOf(m, osz)}, ${m.text(16)}`); }
    case 0xba: {
      const m = modrm();
      if (m.reg < 4) return unknown;
      return out(`${["bt", "bts", "btr", "btc"][m.reg - 4]} ${m.text(osz)}, ${hex(c.u8())}`);
    }
    case 0xbb: { const m = modrm(); return out(`btc ${m.text(osz, false)}, ${regOf(m, osz)}`); }
    case 0xbc: { const m = modrm(); return out(`bsf ${regOf(m, osz)}, ${m.text(osz, false)}`); }
    case 0xbd: { const m = modrm(); return out(`bsr ${regOf(m, osz)}, ${m.text(osz, false)}`); }
    case 0xbe: { const m = modrm(); return out(`movsx ${regOf(m, osz)}, ${m.text(8)}`); }
    case 0xbf: { const m = modrm(); return out(`movsx ${regOf(m, osz)}, ${m.text(16)}`); }
    case 0xc0: { const m = modrm(); return out(`xadd ${m.text(8, false)}, ${regOf(m, 8)}`); }
    case 0xc1: { const m = modrm(); return out(`xadd ${m.text(osz, false)}, ${regOf(m, osz)}`); }
  }
  return unknown;
}

// ---- stepping -------------------------------------------------------------------------------

/** What stepping needs from the CPU: registers and memory. */
export interface StepContext {
  /** General registers by x86 number (eax, ecx, edx, ebx, esp, ebp, esi, edi). */
  reg: number[];
  /** Segment registers (es, cs, ss, ds, fs, gs). */
  sreg: number[];
  protectedMode: boolean;
  bits: 16 | 32;
  read: Reader;
}

/**
 * Flat addresses where execution can continue after `insn`, stepping *over* calls, interrupts and repeated string
 * operations (they run freely and are caught when they return). Returns null when the next address can't be
 * worked out (unknown instruction, protected-mode far transfers).
 */
export function nextAddresses(insn: Insn, ctx: StepContext): number[] | null {
  const next = insn.addr + insn.length;
  const f = insn.flow;
  const csBase = ctx.protectedMode ? 0 : ctx.sreg[1] * 16;
  const word = (addr: number, size: 2 | 4): number | null => {
    const b = ctx.read(addr, size);
    if (!b || b.length < size) return null;
    return size === 2 ? b[0] | (b[1] << 8) : (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  };
  switch (f.kind) {
    case "unknown":
      return null;
    case "seq":
    case "halt":
    case "int":
      return [next];
    case "jump":
      return f.target ? [f.target] : null;
    case "branch":
      return f.target === next ? [next] : [next, f.target];
    case "call":
      return [next]; // step over
    case "ret": {
      const ssBase = ctx.protectedMode ? 0 : ctx.sreg[2] * 16;
      const sp = ctx.bits === 32 ? ctx.reg[4] >>> 0 : ctx.reg[4] & 0xffff;
      if (!f.far) {
        const v = ctx.bits === 32 ? word(ssBase + sp, 4) : word(ssBase + sp, 2);
        return v === null ? null : [csBase + v];
      }
      if (ctx.protectedMode || ctx.bits !== 16) return null;
      const ip = word(ssBase + sp, 2);
      const cs = word(ssBase + sp + 2, 2);
      return ip === null || cs === null ? null : [cs * 16 + ip];
    }
    case "indirect": {
      if (f.call) return [next]; // step over
      if (f.far && ctx.protectedMode) return null;
      const o = f.operand;
      const size = ctx.bits === 32 ? 4 : 2;
      let value: number | null;
      if (o.reg !== null) value = size === 4 ? ctx.reg[o.reg] >>> 0 : ctx.reg[o.reg] & 0xffff;
      else {
        const ea = effectiveAddress(o, ctx);
        if (ea === null) return null;
        value = word(ea.addr, size);
        if (f.far) {
          const seg = word(ea.addr + size, 2);
          return value === null || seg === null || ctx.bits !== 16 ? null : [seg * 16 + value];
        }
      }
      return value === null ? null : [csBase + value];
    }
  }
}

function effectiveAddress(o: Operand, ctx: StepContext): { addr: number } | null {
  const m = o.mem;
  if (!m) return null;
  const mask = m.wide ? 0xffffffff : 0xffff;
  const val = (n: number | null) => (n === null ? 0 : (ctx.reg[n] >>> 0) & mask);
  let off = (val(m.base) + val(m.index) * m.scale + m.disp) & mask;
  off >>>= 0;
  if (ctx.protectedMode) return { addr: off }; // assumes flat segments
  const bpBased = m.base === 5 || (m.wide && m.base === 4);
  const seg = m.segment ?? (bpBased ? 2 : 3);
  return { addr: ctx.sreg[seg] * 16 + off };
}

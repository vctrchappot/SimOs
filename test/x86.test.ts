import { describe, expect, it } from "vitest";
import { decode, nextAddresses, type StepContext } from "@/os/runtime/x86";

/** Decodes `bytes` placed at `addr`. */
function dis(bytes: number[], addr = 0x7c00, bits: 16 | 32 = 16, csBase = 0) {
  const mem = new Uint8Array(0x20000);
  mem.set(bytes, addr);
  const read = (a: number, n: number) => mem.slice(a, a + n);
  return decode(read, addr, { bits, csBase })!;
}

describe("x86 decoder", () => {
  it("decodes real-mode instructions with their length and Intel-syntax text", () => {
    expect(dis([0xb8, 0x01, 0x00])).toMatchObject({ length: 3, text: "mov ax, 0x1" });
    expect(dis([0x8b, 0x00])).toMatchObject({ length: 2, text: "mov ax, [bx+si]" });
    expect(dis([0x8b, 0x4e, 0xfe])).toMatchObject({ length: 3, text: "mov cx, [bp-0x2]" });
    expect(dis([0xc7, 0x06, 0x34, 0x12, 0x07, 0x00])).toMatchObject({ length: 6, text: "mov word [0x1234], 0x7" });
    expect(dis([0x66, 0xb8, 0x78, 0x56, 0x34, 0x12])).toMatchObject({ length: 6, text: "mov eax, 0x12345678" });
    expect(dis([0xcd, 0x10])).toMatchObject({ length: 2, text: "int 0x10" });
    expect(dis([0xf3, 0xa4])).toMatchObject({ length: 2, text: "rep movsb" });
    expect(dis([0x26, 0x8a, 0x07])).toMatchObject({ text: "mov al, es:[bx]" });
    expect(dis([0xee])).toMatchObject({ length: 1, text: "out dx, al" });
    expect(dis([0x0f, 0xb6, 0xc3])).toMatchObject({ length: 3, text: "movzx ax, bl" });
  });

  it("decodes protected-mode instructions with SIB bytes and 32-bit immediates", () => {
    expect(dis([0x8b, 0x44, 0x8b, 0x10], 0x1000, 32)).toMatchObject({ length: 4, text: "mov eax, [ebx+ecx*4+0x10]" });
    expect(dis([0x66, 0x89, 0xd8], 0x1000, 32)).toMatchObject({ text: "mov ax, bx" });
    expect(dis([0xa1, 0x78, 0x56, 0x34, 0x12], 0x1000, 32)).toMatchObject({ length: 5, text: "mov eax, [0x12345678]" });
    expect(dis([0x0f, 0x85, 0x10, 0x00, 0x00, 0x00], 0x1000, 32)).toMatchObject({ length: 6, text: "jne 0x1016" });
  });

  it("reports where control goes: jumps, branches, calls, returns", () => {
    expect(dis([0xeb, 0xfe]).flow).toEqual({ kind: "jump", target: 0x7c00 });
    expect(dis([0x74, 0x05]).flow).toEqual({ kind: "branch", target: 0x7c07 });
    expect(dis([0xe8, 0x10, 0x00]).flow).toEqual({ kind: "call", target: 0x7c13 });
    expect(dis([0xc3]).flow).toMatchObject({ kind: "ret", far: false });
    expect(dis([0xcf]).flow).toMatchObject({ kind: "ret", iret: true });
    expect(dis([0xcd, 0x13]).flow).toEqual({ kind: "int" });
    expect(dis([0x90]).flow).toEqual({ kind: "seq" });
  });

  it("computes relative targets from the code segment base", () => {
    const insn = dis([0xe9, 0x00, 0x01], 0x10000 + 0x20, 16, 0x10000);
    expect(insn.flow).toEqual({ kind: "jump", target: 0x10000 + 0x123 });
  });

  it("wraps 16-bit relative jumps within the segment", () => {
    const insn = dis([0xeb, 0x7f], 0xfff0, 16, 0);
    expect(insn.flow).toEqual({ kind: "jump", target: (0xfff0 + 2 + 0x7f) & 0xffff });
  });

  it("treats unreadable or unknown bytes as data rather than guessing", () => {
    expect(dis([0x0f, 0x0f, 0x00]).flow).toEqual({ kind: "unknown" });
    const truncated = decode(() => Uint8Array.of(0xb8, 0x01), 0, { bits: 16, csBase: 0 })!;
    expect(truncated).toMatchObject({ length: 1, flow: { kind: "unknown" } });
    expect(decode(() => null, 0, { bits: 16, csBase: 0 })).toBeNull();
  });
});

describe("nextAddresses (for stepping)", () => {
  const mem = new Uint8Array(0x20000);
  const ctx = (over: Partial<StepContext> = {}): StepContext => ({
    reg: [0, 0, 0, 0, 0xf000, 0, 0, 0],
    sreg: [0, 0, 0, 0, 0, 0],
    protectedMode: false,
    bits: 16,
    read: (a, n) => mem.slice(a, a + n),
    ...over,
  });
  const next = (bytes: number[], addr = 0x7c00, c = ctx()) => {
    mem.fill(0);
    mem.set(bytes, addr);
    return nextAddresses(dis(bytes, addr), c);
  };

  it("continues with the next instruction, and steps over calls and interrupts", () => {
    expect(next([0x90])).toEqual([0x7c01]);
    expect(next([0xe8, 0x00, 0x10])).toEqual([0x7c03]);
    expect(next([0xcd, 0x16])).toEqual([0x7c02]);
    expect(next([0xf3, 0xa4])).toEqual([0x7c02]);
  });

  it("offers both outcomes of a conditional branch and the target of a jump", () => {
    expect(next([0x74, 0x05])).toEqual([0x7c02, 0x7c07]);
    expect(next([0xeb, 0xfe])).toEqual([0x7c00]);
    expect(next([0xe2, 0xfc])).toEqual([0x7c02, 0x7bfe]);
  });

  it("reads the return address from the stack", () => {
    mem.fill(0);
    mem.set([0x34, 0x12], 0xf000);
    expect(nextAddresses(dis([0xc3]), ctx())).toEqual([0x1234]);
    // far return: ip then cs
    mem.set([0x00, 0x7c, 0x00, 0x10], 0xf000);
    expect(nextAddresses(dis([0xcb]), ctx())).toEqual([0x10000 + 0x7c00]);
  });

  it("evaluates indirect jumps from registers and memory", () => {
    const c = ctx({ reg: [0, 0, 0, 0x2000, 0xf000, 0, 0, 0] }); // bx = 0x2000
    expect(next([0xff, 0xe3], 0x7c00, c)).toEqual([0x2000]); // jmp bx
    mem.fill(0);
    mem[0x2000] = 0x78;
    mem[0x2001] = 0x56;
    expect(nextAddresses(dis([0xff, 0x27]), c)).toEqual([0x5678]); // jmp [bx]
    expect(next([0xff, 0xd3], 0x7c00, c)).toEqual([0x7c02]); // call bx: stepped over
  });

  it("gives up on instructions it cannot follow", () => {
    expect(next([0x0f, 0x0f])).toBeNull();
    expect(nextAddresses(dis([0xcb]), ctx({ protectedMode: true }))).toBeNull();
  });
});

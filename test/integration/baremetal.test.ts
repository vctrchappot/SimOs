/**
 * Boots a hand-assembled boot sector on a bare emulated PC (BIOS -> your code at 0x7C00) and
 * checks that it prints to the VGA screen and the serial port.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scancodes } from "@/os/keyboard";
import { BareMetalMachine } from "@/os/runtime/baremetal";
import type { DisplayFrame } from "@/os/runtime/display";
import { nodeEnv, root } from "./harness";

const hasBios = existsSync(resolve(root, "public/v86/seabios.bin"));

/** xor ax,ax; mov ds,ax; mov si,msg; print each byte via BIOS teletype and COM1; then halt. */
export function bootSector(message: string): Uint8Array {
  const code = [
    0x31, 0xc0, 0x8e, 0xd8, 0xbe, 0x19, 0x7c, // si = 0x7c19
    0xac, 0x08, 0xc0, 0x74, 0x0a, // loop: lodsb; or al,al; jz done
    0xb4, 0x0e, 0xcd, 0x10, // mov ah,0e; int 10h
    0xba, 0xf8, 0x03, 0xee, // mov dx,3f8h; out dx,al
    0xeb, 0xf1, // jmp loop
    0xf4, 0xeb, 0xfd, // done: hlt; jmp done
  ];
  const sector = new Uint8Array(512);
  sector.set(code, 0);
  sector.set([...new TextEncoder().encode(message), 0], code.length);
  sector[510] = 0x55;
  sector[511] = 0xaa;
  return sector;
}

describe.skipIf(!hasBios)("bare-metal machine", () => {
  const machine = new BareMetalMachine(nodeEnv);
  afterAll(() => machine.shutdown());

  it("boots a boot sector: output on the VGA screen and the serial port", async () => {
    let serial = "";
    machine.onSerial((d) => (serial += new TextDecoder().decode(d)));
    let frame: DisplayFrame | null = null;
    machine.onDisplay((f) => f.kind === "text" && (frame = f));

    await machine.boot({ image: bootSector("Hello from bare metal"), name: "boot.img" });
    expect(machine.status).toBe("running");

    const screen = () => {
      const f = frame as DisplayFrame | null;
      return f && f.kind === "text" ? String.fromCharCode(...f.chars) : "";
    };
    for (let i = 0; i < 200 && !(serial.includes("bare metal") && screen().includes("Hello from bare metal")); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(serial).toBe("Hello from bare metal");
    expect(screen()).toContain("Hello from bare metal");
  }, 30_000);

  it("can be powered off and booted again", async () => {
    await machine.shutdown();
    expect(machine.status).toBe("stopped");
    let serial = "";
    machine.onSerial((d) => (serial += new TextDecoder().decode(d)));
    await machine.boot({ image: bootSector("second boot"), name: "other.bin" });
    for (let i = 0; i < 200 && !serial.includes("second boot"); i++) await new Promise((r) => setTimeout(r, 50));
    expect(serial).toBe("second boot");
  }, 30_000);
});

/** Echoes every key to COM1: xor ah,ah; int 16h; mov dx,3f8h; out dx,al; jmp start. */
function echoSector(): Uint8Array {
  const sector = new Uint8Array(512);
  sector.set([0x30, 0xe4, 0xcd, 0x16, 0xba, 0xf8, 0x03, 0xee, 0xeb, 0xf6], 0);
  sector[510] = 0x55;
  sector[511] = 0xaa;
  return sector;
}

describe.skipIf(!hasBios)("bare-metal debugger", () => {
  const machine = new BareMetalMachine(nodeEnv);
  afterAll(() => machine.shutdown());
  const until = async (cond: () => boolean, ms = 10_000) => {
    for (let i = 0; i < ms / 25 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
    if (!cond()) throw new Error("condition not reached");
  };
  const type = (code: string) => {
    machine.sendKeys(scancodes(code, true)!);
    machine.sendKeys(scancodes(code, false)!);
  };

  it("stops at a breakpoint when the code gets there, shows registers and the original code, then continues", async () => {
    let serial = "";
    machine.onSerial((d) => (serial += new TextDecoder().decode(d)));
    let state = { paused: false, hit: null as number | null };
    machine.onDebugState((s) => (state = s));
    // 0x7c04 is `mov dx, 0x3f8`, reached once a key has been read; a breakpoint set before boot sits in the image
    await machine.boot({ image: echoSector(), name: "boot.img", breakpoints: [0x7c04] });
    await new Promise((r) => setTimeout(r, 2500)); // let the BIOS finish and our code reach int 16h
    expect(state.paused).toBe(false);

    type("KeyA");
    await until(() => state.paused);
    expect(state.hit).toBe(0x7c04);
    let snap = machine.inspect({ addr: 0x7c00, length: 10 });
    expect(snap.registers).toMatchObject({ eip: 0x7c04, linearIp: 0x7c04, cs: 0, protectedMode: false });
    expect(snap.registers!.eax & 0xff).toBe(0x61); // 'a' came back from the BIOS in al
    expect(serial).toBe("");
    // the view shows the program, not the spin lock patched over it
    expect([...snap.memory!.data]).toEqual([0x30, 0xe4, 0xcd, 0x16, 0xba, 0xf8, 0x03, 0xee, 0xeb, 0xf6]);

    await machine.resume();
    await until(() => serial === "a");
    expect(state.paused).toBe(false);

    // the breakpoint re-arms by itself and catches the next key
    await new Promise((r) => setTimeout(r, 400));
    type("KeyB");
    await until(() => state.paused);
    snap = machine.inspect();
    expect(snap.registers!.eax & 0xff).toBe(0x62);

    machine.setBreakpoints([]);
    await machine.resume();
    await until(() => serial === "ab");
    expect(machine.inspect().breakpoints).toEqual([]);
  }, 60_000);

  it("single-steps instructions, with disassembly, stepping over the lodsb loop body one instruction at a time", async () => {
    await machine.shutdown();
    let serial = "";
    machine.onSerial((d) => (serial += new TextDecoder().decode(d)));
    let state = { paused: false, hit: null as number | null };
    machine.onDebugState((s) => (state = s));
    await machine.boot({ image: bootSector("AB"), name: "boot.img", breakpoints: [0x7c00] }); // stop on the very first instruction
    await until(() => state.paused);
    expect(machine.inspect().registers).toMatchObject({ linearIp: 0x7c00 });

    const ip = () => machine.inspect().registers!.linearIp;
    expect(await machine.step()).toBe("stepped");
    expect(ip()).toBe(0x7c02); // xor ax, ax
    expect(await machine.step()).toBe("stepped");
    expect(ip()).toBe(0x7c04); // mov ds, ax
    expect(await machine.step()).toBe("stepped");
    expect(ip()).toBe(0x7c07); // mov si, 0x7c19
    expect(machine.inspect().registers!.esi).toBe(0x7c19);

    const code = machine.inspect(undefined, 4).code!;
    expect(code.map((l) => l.text)).toEqual(["lodsb", "or al, al", "je 0x7c16", "mov ah, 0xe"]);
    expect(code.map((l) => l.addr)).toEqual([0x7c07, 0x7c08, 0x7c0a, 0x7c0c]);

    await machine.step(); // lodsb
    expect(machine.inspect().registers).toMatchObject({ linearIp: 0x7c08, esi: 0x7c1a });
    expect(machine.inspect().registers!.eax & 0xff).toBe(0x41);
    await machine.step(); // or al, al
    await machine.step(); // jz (not taken)
    expect(ip()).toBe(0x7c0c);
    for (let i = 0; i < 4; i++) await machine.step(); // mov ah / int 10h (stepped over) / mov dx / out dx, al
    await until(() => serial === "A"); // the serial port flushes a few milliseconds later
    expect(ip()).toBe(0x7c14); // jmp back to the loop
    await machine.step();
    expect(ip()).toBe(0x7c07);
  }, 60_000);

  it("stops at a breakpoint inside a loop on every pass", async () => {
    await machine.shutdown();
    let serial = "";
    machine.onSerial((d) => (serial += new TextDecoder().decode(d)));
    let state = { paused: false, hit: null as number | null };
    machine.onDebugState((s) => (state = s));
    await machine.boot({ image: bootSector("ABC"), name: "boot.img", breakpoints: [0x7c07] }); // the lodsb at the top of the loop
    const seen: string[] = [];
    for (let pass = 0; pass < 3; pass++) {
      await until(() => state.paused && state.hit === 0x7c07);
      seen.push(serial);
      state = { paused: false, hit: null };
      await machine.resume();
    }
    expect(seen).toEqual(["", "A", "AB"]);
    await until(() => state.paused && state.hit === 0x7c07); // the fourth pass reads the terminating zero
    expect(serial).toBe("ABC");
  }, 60_000);

  it("holds keys typed while stopped until the machine runs again", async () => {
    await machine.shutdown();
    let serial = "";
    machine.onSerial((d) => (serial += new TextDecoder().decode(d)));
    let state = { paused: false, hit: null as number | null };
    machine.onDebugState((s) => (state = s));
    await machine.boot({ image: echoSector(), name: "boot.img", breakpoints: [0x7c04] });
    await new Promise((r) => setTimeout(r, 2500));
    type("KeyA");
    await until(() => state.paused);
    type("KeyB"); // typed while stopped at the breakpoint: delivering it would make the CPU take the keyboard interrupt
    await new Promise((r) => setTimeout(r, 400));
    expect(machine.inspect().registers!.linearIp).toBe(0x7c04);

    state = { paused: false, hit: null };
    await machine.resume();
    await until(() => state.paused && state.hit === 0x7c04); // 'b' arrives after 'a' was echoed
    expect(machine.inspect().registers!.eax & 0xff).toBe(0x62);
    await until(() => serial === "a");
    await machine.resume();
    await until(() => serial === "ab");
  }, 60_000);

  it("pauses and resumes on request", async () => {
    await machine.shutdown();
    let serial = "";
    machine.onSerial((d) => (serial += new TextDecoder().decode(d)));
    await machine.boot({ image: bootSector("xyz"), name: "boot.img" });
    await until(() => serial === "xyz");
    await machine.pause();
    expect(machine.inspect().paused).toBe(true);
    const ip = machine.inspect().registers!.linearIp;
    await new Promise((r) => setTimeout(r, 200));
    expect(machine.inspect().registers!.linearIp).toBe(ip); // frozen
    await machine.resume();
    expect(machine.inspect().paused).toBe(false);
  }, 60_000);
});

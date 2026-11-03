/**
 * Boots a hand-assembled boot sector on a bare emulated PC (BIOS -> your code at 0x7C00) and
 * checks that it prints to the VGA screen and the serial port.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

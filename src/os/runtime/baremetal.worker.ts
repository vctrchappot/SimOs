/// <reference lib="webworker" />
// Hosts a bare-metal machine off the main thread (see baremetal.ts).
import { BareMetalMachine } from "./baremetal";
import type { DisplayFrame } from "./display";
import { browserEnvironment } from "./browser";
import type { RuntimeStatus } from "./types";

export type BareToWorker =
  | { t: "boot"; image: Uint8Array; name: string; memoryMB?: number }
  | { t: "display-watch"; on: boolean }
  | { t: "keys"; codes: number[] }
  | { t: "mouse"; dx: number; dy: number; buttons: [boolean, boolean, boolean] }
  | { t: "serial-in"; data: Uint8Array };

export type BareFromWorker =
  | { t: "status"; status: RuntimeStatus; detail?: string }
  | { t: "display"; frame: DisplayFrame }
  | { t: "serial"; data: Uint8Array };

const post = (msg: BareFromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

const machine = new BareMetalMachine(browserEnvironment);
let offDisplay: (() => void) | null = null;
machine.onStatus((status, detail) => post({ t: "status", status, detail }));
machine.onSerial((data) => post({ t: "serial", data }, [data.buffer]));

self.onmessage = (ev: MessageEvent<BareToWorker>) => {
  const msg = ev.data;
  switch (msg.t) {
    case "boot":
      void machine.boot({ image: msg.image, name: msg.name, memoryMB: msg.memoryMB });
      break;
    case "display-watch":
      offDisplay?.();
      offDisplay = null;
      if (msg.on) {
        offDisplay = machine.onDisplay((frame) =>
          post({ t: "display", frame }, frame.kind === "graphic" ? frame.rects.map((r) => r.data.buffer) : []),
        );
      }
      break;
    case "keys":
      machine.sendKeys(msg.codes);
      break;
    case "mouse":
      machine.sendMouse(msg.dx, msg.dy, msg.buttons);
      break;
    case "serial-in":
      machine.sendSerial(msg.data);
      break;
  }
};

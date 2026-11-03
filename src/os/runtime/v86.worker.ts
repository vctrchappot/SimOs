/// <reference lib="webworker" />
// Hosts the emulator off the main thread. Everything that touches the guest (CPU, console,
// the 9p filesystem) lives here; the page talks to it through worker-protocol messages.
import { browserEnvironment } from "./browser";
import type { GuestFS } from "./types";
import { V86Runtime } from "./v86-runtime";
import type { FromWorker, ToWorker } from "./worker-protocol";

const post = (msg: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

let runtime: V86Runtime | null = null;
let targets: { project: GuestFS; root: GuestFS } | null = null;
let offDisplay: (() => void) | null = null;
let prepared: { resolve: () => void; reject: (e: Error) => void } | null = null;

async function handleFs(msg: Extract<ToWorker, { t: "fs" }>) {
  try {
    const target = targets?.[msg.target];
    if (!target) throw new Error("guest filesystem is not available");
    const fn = target[msg.method] as (...a: unknown[]) => Promise<unknown>;
    post({ t: "fs-result", id: msg.id, ok: true, value: await fn.apply(target, msg.args) });
  } catch (e) {
    post({ t: "fs-result", id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.t) {
    case "boot": {
      runtime = new V86Runtime(msg.profile, browserEnvironment);
      msg.sizes.forEach((size, terminal) => size && runtime!.resize(size.cols, size.rows, terminal));
      runtime.onStatus((status, detail) => post({ t: "status", status, detail }));
      runtime.onOutput((data, terminal) => post({ t: "output", data, terminal }, [data.buffer]));
      runtime.onReady(() => post({ t: "ready" }));
      offDisplay = null;
      void runtime.boot(async (project, root) => {
        targets = { project, root };
        await new Promise<void>((resolve, reject) => {
          prepared = { resolve, reject };
          post({ t: "prepare" });
        });
      });
      break;
    }
    case "prepared":
      prepared?.resolve();
      break;
    case "prepare-failed":
      prepared?.reject(new Error(msg.error));
      break;
    case "input":
      runtime?.sendInput(msg.data, msg.terminal);
      break;
    case "resize":
      runtime?.resize(msg.cols, msg.rows, msg.terminal);
      break;
    case "display-watch":
      offDisplay?.();
      offDisplay = null;
      if (msg.on && runtime) {
        offDisplay = runtime.onDisplay((frame) =>
          post({ t: "display", frame }, frame.kind === "graphic" ? frame.rects.map((r) => r.data.buffer) : []),
        );
      }
      break;
    case "keys":
      runtime?.sendKeys(msg.codes);
      break;
    case "mouse":
      runtime?.sendMouse(msg.dx, msg.dy, msg.buttons);
      break;
    case "fs":
      void handleFs(msg);
      break;
  }
};

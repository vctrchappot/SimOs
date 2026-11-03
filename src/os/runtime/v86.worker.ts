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
      if (msg.size) runtime.resize(msg.size.cols, msg.size.rows);
      runtime.onStatus((status, detail) => post({ t: "status", status, detail }));
      runtime.onOutput((data) => post({ t: "output", data }, [data.buffer]));
      runtime.onReady(() => post({ t: "ready" }));
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
      runtime?.sendInput(msg.data);
      break;
    case "resize":
      runtime?.resize(msg.cols, msg.rows);
      break;
    case "fs":
      void handleFs(msg);
      break;
  }
};

import type { BareFromWorker, BareToWorker } from "./baremetal.worker";
import type { DisplayFrame } from "./display";
import type { RuntimeStatus } from "./types";

/** Main-thread handle to a bare-metal machine running in its own worker. */
export class BareMetalRuntime {
  status: RuntimeStatus = "stopped";
  detail?: string;
  /** Name of the image that is (or was last) booted. */
  imageName: string | null = null;
  private worker: Worker | null = null;
  private statusCbs = new Set<(s: RuntimeStatus, detail?: string) => void>();
  private displayCbs = new Set<(f: DisplayFrame) => void>();
  private serialCbs = new Set<(d: Uint8Array) => void>();

  constructor(private createWorker: () => Worker) {}

  private send(msg: BareToWorker, transfer: Transferable[] = []) {
    this.worker?.postMessage(msg, transfer);
  }
  private setStatus(s: RuntimeStatus, detail?: string) {
    this.status = s;
    this.detail = detail;
    for (const cb of [...this.statusCbs]) cb(s, detail);
  }

  onStatus(cb: (s: RuntimeStatus, detail?: string) => void) {
    this.statusCbs.add(cb);
    return () => void this.statusCbs.delete(cb);
  }
  onSerial(cb: (d: Uint8Array) => void) {
    this.serialCbs.add(cb);
    return () => void this.serialCbs.delete(cb);
  }
  onDisplay(cb: (f: DisplayFrame) => void) {
    this.displayCbs.add(cb);
    if (this.displayCbs.size === 1 || this.worker) this.send({ t: "display-watch", on: true });
    return () => {
      this.displayCbs.delete(cb);
      if (!this.displayCbs.size) this.send({ t: "display-watch", on: false });
    };
  }

  /** Starts a fresh machine from the given image bytes. */
  boot(image: Uint8Array, name: string, memoryMB?: number): void {
    if (this.status === "booting" || this.status === "running") return;
    this.dispose();
    this.imageName = name;
    this.setStatus("booting");
    let worker: Worker;
    try {
      worker = this.createWorker();
    } catch (e) {
      return this.setStatus("error", e instanceof Error ? e.message : String(e));
    }
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent<BareFromWorker>) => {
      if (this.worker !== worker) return;
      const msg = ev.data;
      if (msg.t === "status") {
        if (msg.status === "stopped") return; // shutdown() owns that transition
        this.setStatus(msg.status, msg.detail);
        if (msg.status === "error") this.dispose();
      } else if (msg.t === "display") for (const cb of [...this.displayCbs]) cb(msg.frame);
      else for (const cb of [...this.serialCbs]) cb(msg.data);
    };
    worker.onerror = (ev) => {
      if (this.worker !== worker) return;
      this.setStatus("error", ev.message || "the machine's worker crashed");
      this.dispose();
    };
    if (this.displayCbs.size) this.send({ t: "display-watch", on: true });
    const copy = image.slice(); // the caller keeps its bytes
    this.send({ t: "boot", image: copy, name, memoryMB }, [copy.buffer]);
  }

  shutdown(): void {
    if (this.status === "stopped") return;
    this.dispose();
    this.setStatus("stopped");
  }

  private dispose() {
    this.worker?.terminate();
    this.worker = null;
  }

  sendKeys(codes: number[]) {
    if (this.status === "running") this.send({ t: "keys", codes });
  }
  sendMouse(dx: number, dy: number, buttons: [boolean, boolean, boolean]) {
    if (this.status === "running") this.send({ t: "mouse", dx, dy, buttons });
  }
  sendSerial(data: Uint8Array) {
    if (this.status === "running") this.send({ t: "serial-in", data });
  }
}

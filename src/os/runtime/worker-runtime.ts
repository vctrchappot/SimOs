import type { NetworkConfig } from "./network";
import { OutputHistory } from "./output-history";
import { endShell } from "./terminal-control";
import { TERMINAL_COUNT, type GuestFS, type GuestStat, type OSProfile, type OSRuntime, type RuntimeStatus } from "./types";
import type { FromWorker, FsMethod, FsTarget, ToWorker } from "./worker-protocol";

/** A GuestFS whose calls are executed next to the emulator, inside the worker. */
class RemoteGuestFS implements GuestFS {
  constructor(private call: (target: FsTarget, method: FsMethod, args: unknown[]) => Promise<unknown>, private target: FsTarget) {}
  scan(ignore?: string) {
    return this.call(this.target, "scan", [ignore]) as Promise<Map<string, GuestStat>>;
  }
  stat(path: string) {
    return this.call(this.target, "stat", [path]) as Promise<GuestStat | null>;
  }
  read(path: string) {
    return this.call(this.target, "read", [path]) as Promise<Uint8Array>;
  }
  async write(path: string, data: Uint8Array) {
    await this.call(this.target, "write", [path, data]);
  }
  async mkdir(path: string) {
    await this.call(this.target, "mkdir", [path]);
  }
  async remove(path: string) {
    await this.call(this.target, "remove", [path]);
  }
  async rename(from: string, to: string) {
    await this.call(this.target, "rename", [from, to]);
  }
}

/**
 * OSRuntime that runs the emulator in a Web Worker so that CPU-heavy guest work never competes
 * with rendering and typing on the page's main thread. A fresh worker is started for every boot
 * and terminated on shutdown, which also releases the guest's memory immediately.
 */
export class WorkerRuntime implements OSRuntime {
  status: RuntimeStatus = "stopped";
  guestFs: GuestFS | null = null;

  private worker: Worker | null = null;
  private statusCbs = new Set<(s: RuntimeStatus, detail?: string) => void>();
  private outputCbs = new Set<(d: Uint8Array, terminal: number) => void>();
  private logs = new OutputHistory(TERMINAL_COUNT);
  private readyCbs = new Set<() => void>();
  private sizes: Array<{ cols: number; rows: number } | undefined> = [];
  private nextCall = 1;
  private calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private profile: OSProfile,
    private createWorker: () => Worker,
  ) {}

  onStatus(cb: (s: RuntimeStatus, detail?: string) => void) {
    this.statusCbs.add(cb);
    return () => void this.statusCbs.delete(cb);
  }
  onOutput(cb: (d: Uint8Array, terminal: number) => void) {
    this.outputCbs.add(cb);
    return () => void this.outputCbs.delete(cb);
  }
  history(terminal: number) {
    return this.logs.get(terminal);
  }
  onReady(cb: () => void) {
    this.readyCbs.add(cb);
    return () => void this.readyCbs.delete(cb);
  }

  setNetwork(config: NetworkConfig) {
    this.profile = { ...this.profile, network: config };
  }

  private setStatus(s: RuntimeStatus, detail?: string) {
    if (s === this.status && detail === undefined) return; // e.g. the worker echoing "booting"
    this.status = s;
    for (const cb of [...this.statusCbs]) cb(s, detail);
  }

  private send(msg: ToWorker) {
    this.worker?.postMessage(msg);
  }

  private call = (target: FsTarget, method: FsMethod, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      if (!this.worker) return reject(new Error("the OS is not running"));
      const id = this.nextCall++;
      this.calls.set(id, { resolve, reject });
      this.send({ t: "fs", id, target, method, args });
    });

  async boot(prepare?: (project: GuestFS, root: GuestFS) => Promise<void>): Promise<void> {
    if (this.status === "booting" || this.status === "running") return;
    this.dispose(); // a worker left over from a failed boot
    this.logs.clear();
    this.setStatus("booting");
    let worker: Worker;
    try {
      worker = this.createWorker();
    } catch (e) {
      return this.setStatus("error", e instanceof Error ? e.message : String(e));
    }
    this.worker = worker;

    const settled = new Promise<void>((resolve) => {
      const off = this.onStatus((s) => {
        if (s === "booting") return;
        off();
        resolve();
      });
    });

    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      if (this.worker !== worker) return; // a worker from an earlier boot
      const msg = ev.data;
      switch (msg.t) {
        case "status":
          // The worker's "stopped" only means its machine halted; shutdown() owns that transition.
          if (msg.status === "stopped") break;
          this.setStatus(msg.status, msg.detail);
          if (msg.status === "error") this.dispose();
          break;
        case "output":
          this.logs.push(msg.terminal, msg.data);
          for (const cb of [...this.outputCbs]) cb(msg.data, msg.terminal);
          break;
        case "ready":
          for (const cb of [...this.readyCbs]) cb();
          break;
        case "prepare":
          this.guestFs = new RemoteGuestFS(this.call, "project");
          void (async () => {
            try {
              await prepare?.(this.guestFs!, new RemoteGuestFS(this.call, "root"));
              this.send({ t: "prepared" });
            } catch (e) {
              this.send({ t: "prepare-failed", error: e instanceof Error ? e.message : String(e) });
            }
          })();
          break;
        case "fs-result": {
          const pending = this.calls.get(msg.id);
          this.calls.delete(msg.id);
          if (msg.ok) pending?.resolve(msg.value);
          else pending?.reject(new Error(msg.error));
          break;
        }
      }
    };
    worker.onerror = (ev) => {
      if (this.worker !== worker) return;
      this.setStatus("error", ev.message || "the emulator worker crashed");
      this.dispose();
    };

    this.send({ t: "boot", profile: this.profile, sizes: this.sizes });
    await settled;
  }

  private dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.guestFs = null;
    for (const p of this.calls.values()) p.reject(new Error("the OS was powered off"));
    this.calls.clear();
  }

  async shutdown(): Promise<void> {
    if (this.status === "stopped") return;
    this.setStatus("stopping");
    this.dispose();
    this.setStatus("stopped");
  }

  sendInput(data: string, terminal = 0): void {
    if (this.status === "running" || this.status === "booting") this.send({ t: "input", data, terminal });
  }

  closeTerminal(terminal: number): void {
    if (terminal === 0) return;
    endShell((data) => this.sendInput(data, terminal));
    this.logs.clear(terminal);
  }

  resize(cols: number, rows: number, terminal = 0): void {
    this.sizes[terminal] = { cols, rows };
    this.send({ t: "resize", cols, rows, terminal });
  }
}

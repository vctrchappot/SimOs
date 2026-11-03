import { describe, expect, it } from "vitest";
import { buildrootProfile } from "@/os/runtime/profiles";
import type { FromWorker, ToWorker } from "@/os/runtime/worker-protocol";
import { WorkerRuntime } from "@/os/runtime/worker-runtime";

/** Plays the worker's side of the protocol without an emulator. */
class FakeWorker {
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  received: ToWorker[] = [];
  /** Files the "guest" holds; fs calls are answered from here. */
  files = new Map<string, Uint8Array>();

  emit(msg: FromWorker) {
    queueMicrotask(() => this.onmessage?.({ data: msg } as MessageEvent<FromWorker>));
  }

  postMessage(msg: ToWorker) {
    this.received.push(msg);
    switch (msg.t) {
      case "boot":
        this.emit({ t: "status", status: "booting" });
        this.emit({ t: "prepare" });
        break;
      case "prepared":
        this.emit({ t: "output", data: new TextEncoder().encode("login: ") });
        this.emit({ t: "status", status: "running" });
        this.emit({ t: "ready" });
        break;
      case "prepare-failed":
        this.emit({ t: "status", status: "error", detail: msg.error });
        break;
      case "fs":
        if (msg.method === "write") {
          this.files.set(msg.args[0] as string, msg.args[1] as Uint8Array);
          this.emit({ t: "fs-result", id: msg.id, ok: true, value: undefined });
        } else if (msg.method === "read") {
          const f = this.files.get(msg.args[0] as string);
          if (f) this.emit({ t: "fs-result", id: msg.id, ok: true, value: f });
          else this.emit({ t: "fs-result", id: msg.id, ok: false, error: "ENOENT" });
        }
        break;
    }
  }

  terminate() {
    this.terminated = true;
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const rt = new WorkerRuntime(buildrootProfile("k"), () => {
    const w = new FakeWorker();
    workers.push(w);
    return w as unknown as Worker;
  });
  return { rt, workers };
}

describe("WorkerRuntime", () => {
  it("boots: runs prepare with remote guest filesystems, then reports running", async () => {
    const { rt, workers } = setup();
    const statuses: string[] = [];
    rt.onStatus((s) => statuses.push(s));
    const out: string[] = [];
    rt.onOutput((d) => out.push(new TextDecoder().decode(d)));
    rt.resize(100, 30);

    await rt.boot(async (project, root) => {
      await project.write("/a.txt", new TextEncoder().encode("hi"));
      await root.write("/etc/x", new TextEncoder().encode("x"));
      expect(new TextDecoder().decode(await project.read("/a.txt"))).toBe("hi");
      await expect(project.read("/missing")).rejects.toThrow("ENOENT");
    });

    expect(rt.status).toBe("running");
    expect(statuses).toEqual(["booting", "running"]);
    expect(out).toEqual(["login: "]);
    expect(workers[0].received[0]).toMatchObject({ t: "boot", size: { cols: 100, rows: 30 } });
    expect(rt.guestFs).not.toBeNull();
  });

  it("forwards input and resize while running, and terminates the worker on shutdown", async () => {
    const { rt, workers } = setup();
    await rt.boot();
    rt.sendInput("ls\n");
    rt.resize(120, 40);
    expect(workers[0].received.slice(-2)).toEqual([
      { t: "input", data: "ls\n" },
      { t: "resize", cols: 120, rows: 40 },
    ]);
    await rt.shutdown();
    expect(rt.status).toBe("stopped");
    expect(workers[0].terminated).toBe(true);
    expect(rt.guestFs).toBeNull();
    rt.sendInput("ignored");
    expect(workers[0].received.at(-1)).not.toEqual({ t: "input", data: "ignored" });
  });

  it("a failing prepare ends in an error status and frees the worker", async () => {
    const { rt, workers } = setup();
    await rt.boot(async () => {
      throw new Error("overlay failed");
    });
    expect(rt.status).toBe("error");
    expect(workers[0].terminated).toBe(true);
  });

  it("every boot gets a fresh worker, and a stale worker's messages are ignored", async () => {
    const { rt, workers } = setup();
    await rt.boot();
    await rt.shutdown();
    await rt.boot();
    expect(workers).toHaveLength(2);
    workers[0].emit({ t: "status", status: "error", detail: "late" });
    await new Promise((r) => setTimeout(r, 5));
    expect(rt.status).toBe("running");
  });

  it("rejects in-flight filesystem calls when the OS is powered off", async () => {
    const { rt } = setup();
    let pending: Promise<unknown> | undefined;
    await rt.boot(async (project) => {
      pending = project.stat("/never-answered"); // the fake worker does not answer stat
    });
    const settled = expect(pending).rejects.toThrow("powered off");
    await rt.shutdown();
    await settled;
  });
});

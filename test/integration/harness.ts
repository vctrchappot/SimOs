import "fake-indexeddb/auto";
import { resolve } from "node:path";
import type { OSProfile } from "@/os/runtime/types";
import { V86Runtime, type V86Environment } from "@/os/runtime/v86-runtime";
import { Studio } from "@/os/studio";
import { IdbProjectStore } from "@/os/vfs/persistence";

export const root = resolve(__dirname, "../..");

/** Runs v86 inside Node, reading assets from disk instead of over HTTP. */
export const nodeEnv: V86Environment = {
  async loadV86() {
    const mod = await import("v86");
    return mod.V86 as never;
  },
  machineOptions: {
    wasm_path: resolve(root, "node_modules/v86/build/v86.wasm"),
    bios: { url: resolve(root, "public/v86/seabios.bin") },
    vga_bios: { url: resolve(root, "public/v86/vgabios.bin") },
  },
};

export function makeStudio(profile: OSProfile, dbName: string, template: Record<string, string>) {
  const runtime = new V86Runtime(profile, nodeEnv);
  const studio = new Studio({ runtime, store: new IdbProjectStore(dbName), template, sync: { pollMs: 0 } });
  let output = "";
  let all = "";
  runtime.onOutput((d) => {
    const text = new TextDecoder().decode(d);
    output += text;
    all += text;
  });

  /** Runs a command in the guest shell and returns its output and exit status. */
  async function sh(cmd: string, timeoutMs = 30_000): Promise<{ out: string; code: number }> {
    const token = Math.random().toString(36).slice(2, 8);
    output = "";
    // The markers are assembled by printf, so the terminal's echo of the command line never matches them.
    runtime.sendInput(`printf 'B%sB\\n' ${token}; ${cmd}; printf '\\nE%sE:%s\\n' ${token} $?\n`);
    const started = Date.now();
    const re = new RegExp(`B${token}B\\r?\\n([\\s\\S]*?)\\r?\\nE${token}E:(\\d+)`);
    for (;;) {
      const m = output.match(re);
      if (m) return { out: m[1].replace(/\r/g, ""), code: Number(m[2]) };
      if (Date.now() - started > timeoutMs) throw new Error(`timeout running: ${cmd}\n${output}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  return { studio, runtime, sh, transcript: () => output, bootLog: () => all };
}

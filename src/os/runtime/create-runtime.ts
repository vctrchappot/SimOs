import type { OSProfile, OSRuntime } from "./types";
import { browserEnvironment } from "./browser";
import { V86Runtime } from "./v86-runtime";
import { WorkerRuntime } from "./worker-runtime";

/**
 * Picks where the emulator runs in the browser: a Web Worker when available (keeps the UI
 * responsive while the guest computes), or on the main thread as a fallback. `?inline` in the
 * page URL forces the main-thread runtime, which is handy for comparing and debugging.
 */
export function createBrowserRuntime(profile: OSProfile): OSRuntime {
  const forceInline = new URLSearchParams(location.search).has("inline");
  if (typeof Worker !== "undefined" && !forceInline) {
    return new WorkerRuntime(profile, () => new Worker(new URL("./v86.worker.ts", import.meta.url), { type: "module" }));
  }
  return new V86Runtime(profile, browserEnvironment);
}

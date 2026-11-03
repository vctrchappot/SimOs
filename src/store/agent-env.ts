import type { AgentEnvironment } from "@/os/agent/tools";
import { useStudio } from "./studio";

/** Connects the agent's tools to the running studio. Read the store at call time, so it always sees the current state. */
export function studioEnvironment(): AgentEnvironment {
  const st = () => useStudio.getState();
  const studio = () => {
    const s = st().studio;
    if (!s) throw new Error("The studio is still loading.");
    return s;
  };
  const bare = () => {
    const b = st().bare;
    if (!b) throw new Error("The disk image machine is not available.");
    return b;
  };
  return {
    get fs() {
      return studio().fs;
    },
    get linux() {
      return studio().runtime;
    },
    async settle() {
      st().flushEditors();
      await studio().settle();
    },
    pull: () => studio().pull(),
    startLinux: () => st().run(),
    stopLinux: () => st().stop(),
    restartLinux: () => st().restart(),
    get image() {
      return bare();
    },
    imageLog: () => st().bareLog,
    bootImages: () => st().bootImages(),
    bootImage: (path) => st().bootImage(path),
    stopImage: () => st().stopImage(),
    breakpoints: () => st().breakpoints,
    setBreakpoints: (a) => st().setBreakpoints(a),
    debugState: () => ({ paused: st().debugPaused, hit: st().debugHit }),
    pauseImage: () => st().pauseImage(),
    resumeImage: () => st().resumeImage(),
    stepImage: () => st().stepImage(),
    network: () => st().network,
    setNetwork: (c) => st().setNetwork(c),
    openFile: (p) => st().openFile(p),
  };
}

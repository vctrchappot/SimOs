"use client";

import { create } from "zustand";
import { BareMetalRuntime } from "@/os/runtime/baremetal-runtime";
import { createBrowserRuntime } from "@/os/runtime/create-runtime";
import { DEFAULT_NETWORK, parseNetworkConfig, type NetworkConfig } from "@/os/runtime/network";
import { defaultProfile, profileFor, type SystemId } from "@/os/runtime/profiles";
import type { OSProfile } from "@/os/runtime/types";
import { TERMINAL_COUNT, type RuntimeStatus } from "@/os/runtime/types";
import { Studio } from "@/os/studio";
import { isBootImage } from "@/os/runtime/baremetal";
import { runCommandFor } from "@/os/run-command";
import type { SearchMatch } from "@/os/search";
import { PROJECT_TEMPLATE } from "@/os/template";
import { IdbProjectStore } from "@/os/vfs/persistence";

/** Pseudo terminal index of the Display tab. */
export const DISPLAY_TAB = -1;

const TABS_KEY = "simos.tabs.v1";
const NETWORK_KEY = "simos.network.v1";
const SYSTEM_KEY = "simos.system.v1";

function loadSystem(): SystemId {
  try {
    return localStorage.getItem(SYSTEM_KEY) === "alpine-desktop" ? "alpine-desktop" : "alpine";
  } catch {
    return "alpine";
  }
}

function loadNetwork(): NetworkConfig {
  try {
    return parseNetworkConfig(localStorage.getItem(NETWORK_KEY));
  } catch {
    return { ...DEFAULT_NETWORK };
  }
}

function loadTabs(): { open: string[]; active: string | null } {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable */
  }
  return { open: [], active: null };
}

function saveTabs(open: string[], active: string | null) {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ open, active }));
  } catch {
    /* storage unavailable */
  }
}

interface StudioState {
  studio: Studio | null;
  ready: boolean;
  status: RuntimeStatus;
  statusDetail?: string;
  /** Bumped on every project change so views re-read the tree. */
  rev: number;
  openTabs: string[];
  activePath: string | null;
  error: string | null;
  /** Short-lived informational message (e.g. a file changed inside the OS). */
  notice: string | null;
  /** Open terminal tabs (each is a serial console of the guest, 0 is the system console). */
  terminals: number[];
  activeTerminal: number;

  /** Which Linux system boots: the text one or the one with a framebuffer and an X desktop. */
  system: SystemId;
  profile: OSProfile;
  /** Switches the system. The page reloads, because the machine is built around its kernel. */
  setSystem(system: SystemId): void;
  /** Network for the next boot (off by default). */
  network: NetworkConfig;
  /** The network the running machine booted with, if any is running. */
  bootedNetwork: NetworkConfig | null;
  setNetwork(config: NetworkConfig): void;

  /** The bare-metal machine for disk images you built (separate from the Linux system). */
  bare: BareMetalRuntime | null;
  bareStatus: RuntimeStatus;
  bareDetail?: string;
  /** What the machine wrote to its serial port (last ~16 KB). */
  bareLog: string;
  /** Which machine the Display tab shows. */
  displaySource: "linux" | "image";
  setDisplaySource(source: "linux" | "image"): void;
  /** Disk images in the project that can be booted. */
  bootImages(): string[];
  bootImage(path: string): Promise<void>;
  stopImage(): void;
  /** Debugger: breakpoints (flat addresses) and whether the image is stopped, and where. */
  breakpoints: number[];
  debugPaused: boolean;
  debugHit: number | null;
  setBreakpoints(addresses: number[]): void;
  pauseImage(): void;
  resumeImage(): void;
  stepImage(): void;

  sidebar: "files" | "search" | "agent";
  /** A search hit the editor should scroll to (nonce makes repeated clicks on one hit work). */
  reveal: { path: string; line: number; column: number; length: number; nonce: number } | null;
  setSidebar(mode: "files" | "search" | "agent"): void;
  /** Saves what is open in the editors into the project. */
  flushEditors(): void;
  revealMatch(match: SearchMatch): void;

  openTerminal(): void;
  closeTerminal(index: number): void;
  setActiveTerminal(index: number): void;
  registerFlush(fn: () => void): void;
  setNotice(text: string): void;
  runFile(): Promise<void>;
  init(): Promise<void>;
  openFile(path: string): void;
  closeTab(path: string): void;
  setActive(path: string): void;
  createFile(path: string): void;
  createFolder(path: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  run(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  reset(): Promise<void>;
  dismissError(): void;
}

/** Ctrl-U: discards anything half-typed at the prompt. */
const CLEAR_LINE = String.fromCharCode(21);
let initStarted = false;
let flushEditors: (() => void) | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export const useStudio = create<StudioState>((set, get) => {
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  const guardAsync = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  const setTabs = (open: string[], active: string | null) => {
    saveTabs(open, active);
    set({ openTabs: open, activePath: active });
  };

  return {
    studio: null,
    ready: false,
    status: "stopped",
    rev: 0,
    openTabs: [],
    activePath: null,
    error: null,
    notice: null,
    network: { ...DEFAULT_NETWORK },
    system: "alpine",
    profile: defaultProfile,
    setSystem(system) {
      try {
        localStorage.setItem(SYSTEM_KEY, system);
      } catch {
        /* storage unavailable */
      }
      location.reload();
    },
    bare: null,
    bareStatus: "stopped",
    bareLog: "",
    displaySource: "linux",
    setDisplaySource: (displaySource) => set({ displaySource }),
    bootImages() {
      const { studio } = get();
      return studio ? studio.fs.list().filter((e) => e.kind === "file" && isBootImage(e.path)).map((e) => e.path) : [];
    },
    async bootImage(path) {
      const { studio, bare } = get();
      if (!studio || !bare) return;
      flushEditors?.();
      await studio.pull(); // an image the OS just built may not have been scanned yet
      await studio.settle();
      if (!studio.fs.exists(path)) return set({ error: `${path} no longer exists.` });
      set({ bareLog: "", displaySource: "image", activeTerminal: DISPLAY_TAB });
      bare.boot(studio.fs.readFile(path), path);
    },
    stopImage: () => get().bare?.shutdown(),
    breakpoints: [],
    debugPaused: false,
    debugHit: null,
    setBreakpoints(addresses) {
      const unique = [...new Set(addresses)].sort((a, b) => a - b);
      set({ breakpoints: unique });
      get().bare?.setBreakpoints(unique);
    },
    pauseImage: () => get().bare?.pause(),
    resumeImage: () => get().bare?.resume(),
    stepImage: () => get().bare?.step(),
    bootedNetwork: null,
    terminals: [0],
    activeTerminal: 0,
    sidebar: "files",
    reveal: null,

    setSidebar(mode) {
      set({ sidebar: mode });
    },

    revealMatch(match) {
      get().openFile(match.path);
      set({ reveal: { path: match.path, line: match.line, column: match.column, length: match.length, nonce: Date.now() } });
    },

    openTerminal() {
      const { terminals } = get();
      const free = Array.from({ length: TERMINAL_COUNT }, (_, i) => i).find((i) => !terminals.includes(i));
      if (free !== undefined) set({ terminals: [...terminals, free], activeTerminal: free });
    },

    closeTerminal(index) {
      const { terminals, activeTerminal, studio } = get();
      if (index === 0 || !terminals.includes(index)) return;
      studio?.runtime.closeTerminal(index);
      const next = terminals.filter((t) => t !== index);
      set({ terminals: next, activeTerminal: activeTerminal === index ? (next.at(-1) ?? 0) : activeTerminal });
    },

    setActiveTerminal(index) {
      set({ activeTerminal: index });
    },

    flushEditors() {
      flushEditors?.();
    },

    registerFlush(fn) {
      flushEditors = fn;
    },

    setNotice(text) {
      clearTimeout(noticeTimer);
      set({ notice: text });
      noticeTimer = setTimeout(() => set({ notice: null }), 4000);
    },

    async runFile() {
      const { studio, activePath } = get();
      if (!studio || get().status !== "running") return;
      const command = runCommandFor(activePath);
      if (!command) return set({ error: `Don’t know how to run ${activePath}. Open a .sh, .c or Makefile.` });
      flushEditors?.();
      await studio.settle();
      get().setActiveTerminal(0); // "Run file" always runs on the system console
      studio.runtime.sendInput(CLEAR_LINE + command + "\n", 0);
    },

    setNetwork(config) {
      set({ network: config });
      try {
        localStorage.setItem(NETWORK_KEY, JSON.stringify(config));
      } catch {
        /* storage unavailable */
      }
      get().studio?.runtime.setNetwork(config);
    },

    async init() {
      if (initStarted) return;
      initStarted = true;
      const system = loadSystem();
      const profile = profileFor(system);
      set({ system, profile });
      const runtime = createBrowserRuntime(profile);
      // The graphics system boots into its desktop, so show the screen as soon as the OS is up.
      if (system === "alpine-desktop") runtime.onReady(() => set({ displaySource: "linux", activeTerminal: DISPLAY_TAB }));
      const studio = new Studio({
        runtime,
        store: new IdbProjectStore("simos-project"),
        template: PROJECT_TEMPLATE,
        sync: {
          onError: (e) => {
            console.error("[sync]", e);
            set({ error: `Sync problem between editor and OS: ${e instanceof Error ? e.message : String(e)}` });
          },
        },
      });
      const network = loadNetwork();
      runtime.setNetwork(network);
      set({ network });
      const bare = new BareMetalRuntime(() => new Worker(new URL("../os/runtime/baremetal.worker.ts", import.meta.url), { type: "module" }));
      const decoder = new TextDecoder();
      bare.onStatus((bareStatus, bareDetail) => set({ bareStatus, bareDetail }));
      bare.onDebugState((s) => set({ debugPaused: s.paused, debugHit: s.hit }));
      bare.setBreakpoints(get().breakpoints);
      bare.onSerial((d) => set((s) => ({ bareLog: (s.bareLog + decoder.decode(d, { stream: true })).slice(-16384) })));
      set({ bare });
      runtime.onStatus((status, statusDetail) => {
        set({ status, statusDetail });
        if (status === "booting") set({ bootedNetwork: get().network });
        if (status === "stopped" || status === "error") set({ bootedNetwork: null });
      });
      await studio.init();
      studio.onChange(() => set((s) => ({ rev: s.rev + 1 })));

      const saved = loadTabs();
      const open = saved.open.filter((p) => studio.fs.stat(p)?.kind === "file");
      let active = saved.active && open.includes(saved.active) ? saved.active : (open[0] ?? null);
      if (!open.length && studio.fs.exists("/README.md")) {
        open.push("/README.md");
        active = "/README.md";
      }
      set({ studio, ready: true, openTabs: open, activePath: active });
      void get().run();
    },

    openFile(path) {
      const { openTabs } = get();
      setTabs(openTabs.includes(path) ? openTabs : [...openTabs, path], path);
    },

    closeTab(path) {
      const { openTabs, activePath } = get();
      const next = openTabs.filter((p) => p !== path);
      const idx = openTabs.indexOf(path);
      setTabs(next, activePath === path ? (next[Math.min(idx, next.length - 1)] ?? null) : activePath);
    },

    setActive(path) {
      setTabs(get().openTabs, path);
    },

    createFile(path) {
      guard(() => {
        const fs = get().studio!.fs;
        if (fs.exists(path)) throw new Error(`${path} already exists`);
        fs.writeFile(path, "", "user");
        get().openFile(path);
      });
    },

    createFolder(path) {
      guard(() => {
        const fs = get().studio!.fs;
        if (fs.exists(path)) throw new Error(`${path} already exists`);
        fs.mkdir(path, "user");
      });
    },

    rename(from, to) {
      guard(() => {
        get().studio!.fs.rename(from, to, "user");
        const { openTabs, activePath } = get();
        const remap = (p: string) => (p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : p);
        setTabs(openTabs.map(remap), activePath ? remap(activePath) : null);
      });
    },

    remove(path) {
      guard(() => {
        get().studio!.fs.remove(path, "user");
        const { openTabs, activePath } = get();
        const gone = (p: string) => p === path || p.startsWith(path + "/");
        const next = openTabs.filter((p) => !gone(p));
        setTabs(next, activePath && gone(activePath) ? (next[0] ?? null) : activePath);
      });
    },

    run: () => guardAsync(() => get().studio!.start()),
    stop: () => guardAsync(() => get().studio!.stop()),
    restart: () => guardAsync(() => get().studio!.restart()),
    async reset() {
      await guardAsync(() => get().studio!.reset());
      setTabs(["/README.md"], "/README.md");
      await get().run();
    },
    dismissError: () => set({ error: null }),
  };
});

"use client";

import { create } from "zustand";
import { createBrowserRuntime } from "@/os/runtime/create-runtime";
import { defaultProfile } from "@/os/runtime/profiles";
import type { RuntimeStatus } from "@/os/runtime/types";
import { Studio } from "@/os/studio";
import { runCommandFor } from "@/os/run-command";
import { PROJECT_TEMPLATE } from "@/os/template";
import { IdbProjectStore } from "@/os/vfs/persistence";

const TABS_KEY = "simos.tabs.v1";

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
      studio.runtime.sendInput(CLEAR_LINE + command + "\n");
    },

    async init() {
      if (initStarted) return;
      initStarted = true;
      const runtime = createBrowserRuntime(defaultProfile);
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
      runtime.onStatus((status, statusDetail) => set({ status, statusDetail }));
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

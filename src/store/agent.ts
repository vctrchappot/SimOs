"use client";

import { create } from "zustand";
import { repairHistory, runAgent } from "@/os/agent/agent";
import { createProvider, PROVIDER_DEFAULTS, validateConfig, type ProviderKind } from "@/os/agent/providers";
import { createTools, SYSTEM_PROMPT } from "@/os/agent/tools";
import type { AgentEvent, AgentMessage, ApprovalMode, ToolCall, ToolRisk } from "@/os/agent/types";
import { studioEnvironment } from "./agent-env";

const SETTINGS_KEY = "simos.agent.v1";
const KEY_KEY = "simos.agent.key.v1";

export interface AgentSettings {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  mode: ApprovalMode;
  /** Keep the API key in this browser across sessions (otherwise only until the tab closes). */
  remember: boolean;
}

/** One line of the conversation as shown in the panel. */
export type ChatItem =
  | { id: number; kind: "user" | "assistant" | "notice" | "error"; text: string }
  | { id: number; kind: "tool"; call: ToolCall; risk: ToolRisk | "unknown"; state: "running" | "done" | "error" | "denied"; result?: string };

const DEFAULTS: AgentSettings = { kind: "anthropic", baseUrl: PROVIDER_DEFAULTS.anthropic.baseUrl, model: PROVIDER_DEFAULTS.anthropic.model, mode: "ask", remember: false };

function loadSettings(): AgentSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<AgentSettings> | null;
    if (raw && (raw.kind === "anthropic" || raw.kind === "openai")) {
      return {
        kind: raw.kind,
        baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : DEFAULTS.baseUrl,
        model: typeof raw.model === "string" ? raw.model : DEFAULTS.model,
        mode: raw.mode === "project" || raw.mode === "all" ? raw.mode : "ask",
        remember: raw.remember === true,
      };
    }
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

function loadKey(remember: boolean): string {
  try {
    return (remember ? localStorage : sessionStorage).getItem(KEY_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveKey(key: string, remember: boolean) {
  try {
    // The key lives in exactly one place: the browser's local storage if asked, else this tab's session.
    localStorage.removeItem(KEY_KEY);
    sessionStorage.removeItem(KEY_KEY);
    if (key) (remember ? localStorage : sessionStorage).setItem(KEY_KEY, key);
  } catch {
    /* storage unavailable */
  }
}

type NewItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, "id"> : never) : never;

interface Pending {
  call: ToolCall;
  risk: ToolRisk;
}

interface AgentState {
  settings: AgentSettings;
  apiKey: string;
  items: ChatItem[];
  running: boolean;
  /** A tool call waiting for the user's yes or no. */
  pending: Pending | null;
  load(): void;
  configure(patch: Partial<AgentSettings>): void;
  setApiKey(key: string): void;
  send(text: string): Promise<void>;
  stop(): void;
  answer(allow: boolean): void;
  clear(): void;
  /** Why the current settings cannot be used, or null. */
  problem(): string | null;
}

let history: AgentMessage[] = [];
let controller: AbortController | null = null;
let resolveApproval: ((allow: boolean) => void) | null = null;
let nextId = 1;

export const useAgent = create<AgentState>((set, get) => {
  const push = (item: NewItem) => set((s) => ({ items: [...s.items, { ...item, id: nextId++ } as ChatItem] }));
  const patchTool = (callId: string, patch: Partial<Extract<ChatItem, { kind: "tool" }>>) =>
    set((s) => ({ items: s.items.map((i) => (i.kind === "tool" && i.call.id === callId ? { ...i, ...patch } : i)) }));

  const onEvent = (e: AgentEvent) => {
    if (e.type === "assistant") push({ kind: "assistant", text: e.text });
    else if (e.type === "notice") push({ kind: "notice", text: e.text });
    else if (e.type === "tool-start") push({ kind: "tool", call: e.call, risk: e.risk, state: "running" });
    else if (e.type === "tool-denied") patchTool(e.call.id, { state: "denied" });
    else patchTool(e.call.id, { state: e.isError ? "error" : "done", result: e.content });
  };

  return {
    settings: DEFAULTS,
    apiKey: "",
    items: [],
    running: false,
    pending: null,

    load() {
      const settings = loadSettings();
      set({ settings, apiKey: loadKey(settings.remember) });
    },

    configure(patch) {
      const settings = { ...get().settings, ...patch };
      if (patch.kind && patch.kind !== get().settings.kind) {
        // Switching provider brings that provider's usual address; the model is theirs to name.
        settings.baseUrl = PROVIDER_DEFAULTS[patch.kind].baseUrl;
        settings.model = PROVIDER_DEFAULTS[patch.kind].model;
      }
      set({ settings });
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); // never contains the key
      } catch {
        /* storage unavailable */
      }
      if (patch.remember !== undefined) saveKey(get().apiKey, settings.remember);
    },

    setApiKey(apiKey) {
      set({ apiKey });
      saveKey(apiKey, get().settings.remember);
    },

    problem() {
      const { settings, apiKey } = get();
      return validateConfig({ ...settings, apiKey });
    },

    async send(text) {
      const trimmed = text.trim();
      if (!trimmed || get().running) return;
      const problem = get().problem();
      if (problem) return void push({ kind: "error", text: problem });
      const { settings, apiKey } = get();
      controller = new AbortController();
      set({ running: true });
      push({ kind: "user", text: trimmed });
      history.push({ role: "user", content: trimmed });
      try {
        await runAgent(history, {
          provider: createProvider({ ...settings, apiKey }),
          tools: createTools(studioEnvironment()),
          system: SYSTEM_PROMPT,
          mode: settings.mode,
          signal: controller.signal,
          onEvent,
          approve: (call, risk) =>
            new Promise<boolean>((resolve) => {
              resolveApproval = resolve;
              set({ pending: { call, risk } });
            }),
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") push({ kind: "notice", text: "Stopped." });
        else push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
        repairHistory(history);
      } finally {
        resolveApproval?.(false);
        resolveApproval = null;
        controller = null;
        set({ running: false, pending: null });
      }
    },

    stop() {
      controller?.abort();
      resolveApproval?.(false);
    },

    answer(allow) {
      resolveApproval?.(allow);
      resolveApproval = null;
      set({ pending: null });
    },

    clear() {
      if (get().running) return;
      history = [];
      set({ items: [] });
    },
  };
});

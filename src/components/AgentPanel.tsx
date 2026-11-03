"use client";

import { useEffect, useRef, useState } from "react";
import { PROVIDER_DEFAULTS, type ProviderKind } from "@/os/agent/providers";
import type { ApprovalMode } from "@/os/agent/types";
import { useAgent, type ChatItem } from "@/store/agent";

const MODES: Array<{ id: ApprovalMode; label: string; hint: string }> = [
  { id: "ask", label: "Ask for every change", hint: "Reading is free; every edit, command or machine action needs your yes." },
  { id: "project", label: "Edit and run freely", hint: "Project edits and shell commands run without asking; machine control and deletions still ask." },
  { id: "all", label: "Everything except deletes", hint: "Only deleting and network changes ask." },
];

const inputClass = "h-7 w-full rounded border border-line bg-bg px-2 text-[12px] placeholder:text-faint focus:border-accent";

function Settings() {
  const { settings, apiKey, configure, setApiKey } = useAgent();
  const problem = useAgent((s) => s.problem());
  return (
    <div className="space-y-2 border-b border-line p-2 text-[11px] text-dim">
      <label className="block">
        Provider
        <select
          aria-label="Provider"
          value={settings.kind}
          onChange={(e) => configure({ kind: e.target.value as ProviderKind })}
          className={inputClass}
        >
          {(Object.keys(PROVIDER_DEFAULTS) as ProviderKind[]).map((k) => (
            <option key={k} value={k}>
              {PROVIDER_DEFAULTS[k].label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        Address
        <input aria-label="Provider address" value={settings.baseUrl} onChange={(e) => configure({ baseUrl: e.target.value })} spellCheck={false} className={inputClass} />
      </label>
      <label className="block">
        Model
        <input aria-label="Model" value={settings.model} onChange={(e) => configure({ model: e.target.value })} spellCheck={false} placeholder="model name" className={inputClass} />
      </label>
      <label className="block">
        API key
        <input
          aria-label="API key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          spellCheck={false}
          placeholder="your own key"
          className={inputClass}
        />
      </label>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={settings.remember} onChange={(e) => configure({ remember: e.target.checked })} />
        Remember the key in this browser
      </label>
      <label className="block">
        Approvals
        <select aria-label="Approval mode" value={settings.mode} onChange={(e) => configure({ mode: e.target.value as ApprovalMode })} className={inputClass} title={MODES.find((m) => m.id === settings.mode)?.hint}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <p className="leading-snug text-faint">
        Your key stays in this browser and is sent only to the address above, never to SimOs or into the project. Your messages, file contents and command output the agent reads go to that provider too.
      </p>
      {problem && apiKey === "" && <p className="text-warn">{problem}</p>}
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  if (item.kind === "user") return <div className="ml-6 whitespace-pre-wrap rounded bg-accent/15 px-2 py-1.5 text-fg">{item.text}</div>;
  if (item.kind === "assistant") return <div className="whitespace-pre-wrap px-1 text-fg">{item.text}</div>;
  if (item.kind === "notice") return <div className="px-1 text-faint">{item.text}</div>;
  if (item.kind === "error") return <div role="alert" className="rounded bg-bad/10 px-2 py-1.5 text-bad">{item.text}</div>;
  if (item.kind !== "tool") return null;
  const summary = Object.entries(item.call.input)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ·  ");
  const color = item.state === "error" || item.state === "denied" ? "text-bad" : item.state === "done" ? "text-ok" : "text-warn";
  return (
    <details className="rounded border border-line bg-raised px-2 py-1 font-mono text-[11px]">
      <summary className="cursor-pointer truncate">
        <span className={color}>{item.state === "running" ? "…" : item.state === "done" ? "✓" : item.state === "denied" ? "⊘" : "✗"}</span> {item.call.name}
        <span className="text-faint"> {summary.slice(0, 120)}</span>
      </summary>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-dim">{item.result ?? summary}</pre>
    </details>
  );
}

function Approval() {
  const pending = useAgent((s) => s.pending);
  const answer = useAgent((s) => s.answer);
  if (!pending) return null;
  return (
    <div role="alertdialog" aria-label="Approve action" className="space-y-1.5 border-t border-warn/40 bg-warn/10 p-2 text-[12px]">
      <div className="text-fg">
        The agent wants to run <span className="font-mono">{pending.call.name}</span> ({pending.risk})
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-dim">{JSON.stringify(pending.call.input, null, 2)}</pre>
      <div className="flex gap-2">
        <button onClick={() => answer(true)} className="h-7 rounded bg-accent px-3 text-[12px] text-bg">
          Allow
        </button>
        <button onClick={() => answer(false)} className="h-7 rounded border border-line px-3 text-[12px] text-dim hover:bg-hover">
          Deny
        </button>
      </div>
    </div>
  );
}

/** The built-in coding agent: bring your own provider and key, then ask it to work with the project and the machines. */
export function AgentPanel() {
  const items = useAgent((s) => s.items);
  const running = useAgent((s) => s.running);
  const { send, stop, clear, load } = useAgent.getState();
  const [text, setText] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const configured = useAgent((s) => s.problem() === null);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [items]);

  const submit = () => {
    if (!text.trim() || running) return;
    void send(text);
    setText("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Coding agent">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1 text-[11px]">
        <button onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings} className="text-dim hover:text-fg">
          {showSettings || !configured ? "Hide settings" : "Settings"}
        </button>
        <button onClick={clear} disabled={running || !items.length} className="ml-auto text-faint hover:text-dim disabled:opacity-40">
          New chat
        </button>
      </div>
      {(showSettings || !configured) && <Settings />}
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2 text-[12px]">
        {!items.length && (
          <p className="text-faint">
            Ask the agent to build something, fix a compile error, boot your image or find a bug with the debugger. It can use the project, the Linux shell, the disk-image machine, the debugger, the display and the keyboard.
          </p>
        )}
        {items.map((i) => (
          <Item key={i.id} item={i} />
        ))}
        {running && <div className="px-1 text-faint">Working…</div>}
        <div ref={end} />
      </div>
      <Approval />
      <div className="flex shrink-0 items-end gap-1 border-t border-line p-2">
        <textarea
          aria-label="Message to the agent"
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={configured ? "What should it do?" : "Enter your provider settings first"}
          className="min-w-0 flex-1 resize-none rounded border border-line bg-bg px-2 py-1 text-[12px] placeholder:text-faint focus:border-accent"
        />
        {running ? (
          <button onClick={stop} className="h-8 rounded border border-bad/50 px-3 text-[12px] text-bad hover:bg-bad/10">
            Stop
          </button>
        ) : (
          <button onClick={submit} disabled={!text.trim() || !configured} className="h-8 rounded bg-accent px-3 text-[12px] text-bg disabled:opacity-40">
            Send
          </button>
        )}
      </div>
    </div>
  );
}

"use client";

import { useStudio } from "@/store/studio";
import { Explorer } from "./Explorer";
import { AgentPanel } from "./AgentPanel";
import { SearchPanel } from "./SearchPanel";

const MODES = [
  { id: "files", label: "Files", hint: "Project files" },
  { id: "search", label: "Search", hint: "Search in all files (Ctrl+Shift+F)" },
  { id: "agent", label: "Agent", hint: "Coding agent (bring your own API key)" },
] as const;

/** Left column: switches between the file tree and project-wide search. */
export function Sidebar() {
  const sidebar = useStudio((s) => s.sidebar);
  const setSidebar = useStudio((s) => s.setSidebar);
  return (
    <aside className={`flex shrink-0 ${sidebar === "agent" ? "w-80" : "w-60"} flex-col border-r border-line bg-panel`}>
      <div role="tablist" aria-label="Sidebar" className="flex h-9 shrink-0 items-stretch border-b border-line">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={sidebar === m.id}
            title={m.hint}
            onClick={() => setSidebar(m.id)}
            className={`px-3 text-[12px] ${
              sidebar === m.id ? "text-fg shadow-[inset_0_-1px_0_var(--color-accent)]" : "text-faint hover:text-dim"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      {sidebar === "files" ? <Explorer /> : sidebar === "search" ? <SearchPanel /> : <AgentPanel />}
    </aside>
  );
}

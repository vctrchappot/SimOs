"use client";

import { useStudio } from "@/store/studio";
import { Explorer } from "./Explorer";
import { SearchPanel } from "./SearchPanel";

const MODES = [
  { id: "files", label: "Files", hint: "Project files" },
  { id: "search", label: "Search", hint: "Search in all files (Ctrl+Shift+F)" },
] as const;

/** Left column: switches between the file tree and project-wide search. */
export function Sidebar() {
  const sidebar = useStudio((s) => s.sidebar);
  const setSidebar = useStudio((s) => s.setSidebar);
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
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
      {sidebar === "files" ? <Explorer /> : <SearchPanel />}
    </aside>
  );
}

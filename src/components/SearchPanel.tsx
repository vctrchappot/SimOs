"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { searchProject, type SearchMatch } from "@/os/search";
import { IGNORE_FILE } from "@/os/vfs/ignore";
import { basename, dirname } from "@/os/vfs/path";
import { useStudio } from "@/store/studio";

function Toggle({ on, label, title, onClick }: { on: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      title={title}
      aria-pressed={on}
      onClick={onClick}
      className={`h-6 min-w-6 rounded px-1 text-[11px] ${on ? "bg-accent/20 text-accent" : "text-faint hover:bg-hover hover:text-dim"}`}
    >
      {label}
    </button>
  );
}

export function SearchPanel() {
  const studio = useStudio((s) => s.studio)!;
  const rev = useStudio((s) => s.rev);
  const revealMatch = useStudio((s) => s.revealMatch);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const result = useMemo(() => {
    const ignore = studio.fs.exists(IGNORE_FILE) ? studio.fs.readText(IGNORE_FILE) : "";
    return searchProject(studio.fs, debounced, { caseSensitive, regex, ignore });
    // `rev` re-runs the search when files change while the panel is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio, debounced, caseSensitive, regex, rev]);

  const groups = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const m of result.matches) (map.get(m.path) ?? map.set(m.path, []).get(m.path)!).push(m);
    return [...map];
  }, [result]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line p-2">
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search in files"
          spellCheck={false}
          aria-label="Search in files"
          className="h-7 min-w-0 flex-1 rounded border border-line bg-bg px-2 text-[12px] placeholder:text-faint focus:border-accent"
        />
        <Toggle on={caseSensitive} label="Aa" title="Match case" onClick={() => setCaseSensitive((v) => !v)} />
        <Toggle on={regex} label=".*" title="Regular expression" onClick={() => setRegex((v) => !v)} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2 text-[12px]">
        {result.error && <div className="px-3 py-2 text-bad">{result.error}</div>}
        {debounced && !result.error && !result.matches.length && <div className="px-3 py-2 text-faint">No results</div>}
        {result.matches.length > 0 && (
          <div className="px-3 py-1.5 text-faint">
            {result.matches.length}
            {result.truncated ? "+" : ""} results in {groups.length} files
          </div>
        )}
        {groups.map(([path, matches]) => (
          <div key={path}>
            <div className="flex items-baseline gap-2 truncate bg-raised px-3 py-1" title={path}>
              <span className="text-fg">{basename(path)}</span>
              <span className="truncate text-faint">{dirname(path) === "/" ? "" : dirname(path)}</span>
              <span className="ml-auto text-faint">{matches.length}</span>
            </div>
            {matches.map((m) => (
              <button
                key={`${m.line}:${m.column}`}
                onClick={() => revealMatch(m)}
                className="block w-full truncate px-3 py-0.5 pl-5 text-left font-mono text-[11px] text-dim hover:bg-hover"
                title={`${path}:${m.line}`}
              >
                <span className="text-faint">{m.line}</span>{" "}
                {m.preview.slice(0, m.previewAt)}
                <mark className="rounded-sm bg-accent/30 text-fg">{m.preview.slice(m.previewAt, m.previewAt + m.length)}</mark>
                {m.preview.slice(m.previewAt + m.length)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

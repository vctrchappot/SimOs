"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { basename, dirname, join, validateName } from "@/os/vfs/path";
import type { Entry } from "@/os/vfs/types";
import { useStudio } from "@/store/studio";

type Draft = { mode: "file" | "folder"; parent: string } | { mode: "rename"; path: string };

const icon = "size-3.5 shrink-0";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`${icon} text-faint transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 16 16" fill="currentColor">
      <path d="M6 3.5 10.5 8 6 12.5z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className={`${icon} text-faint`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M4 1.75h5l3 3v9.5H4z M9 1.75v3h3" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className={`${icon} text-dim`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M1.75 3.75h4l1.5 1.5h7v7.5h-12.5z" />
    </svg>
  );
}

function NameInput({
  initial,
  depth,
  onSubmit,
  onCancel,
}: {
  initial: string;
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div style={{ paddingLeft: 8 + depth * 12 }} className="py-0.5 pr-2">
      <input
        ref={ref}
        defaultValue={initial}
        spellCheck={false}
        onChange={(e) => setProblem(e.target.value ? validateName(e.target.value) : null)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter") {
            const v = e.currentTarget.value.trim();
            if (!v) return onCancel();
            if (validateName(v)) return;
            onSubmit(v);
          }
        }}
        className={`h-6 w-full rounded border bg-bg px-1.5 text-[12px] ${problem ? "border-bad" : "border-accent"}`}
      />
      {problem && <div className="px-1 pt-0.5 text-[11px] text-bad">{problem}</div>}
    </div>
  );
}

export function Explorer() {
  const studio = useStudio((s) => s.studio)!;
  const rev = useStudio((s) => s.rev);
  const activePath = useStudio((s) => s.activePath);
  const { openFile, createFile, createFolder, rename, remove } = useStudio.getState();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>("/");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const entries = useMemo(() => studio.fs.list(), [studio, rev]);
  const children = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of entries) {
      const parent = dirname(e.path);
      (map.get(parent) ?? map.set(parent, []).get(parent)!).push(e);
    }
    for (const list of map.values())
      list.sort((a, b) => (a.kind === b.kind ? basename(a.path).localeCompare(basename(b.path)) : a.kind === "dir" ? -1 : 1));
    return map;
  }, [entries]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const startCreate = (mode: "file" | "folder") => {
    const sel = studio.fs.stat(selected);
    const parent = sel?.kind === "dir" ? selected : dirname(selected);
    setExpanded((p) => new Set(p).add(parent));
    setDraft({ mode, parent });
  };

  const submit = (name: string) => {
    if (!draft) return;
    if (draft.mode === "rename") rename(draft.path, join(dirname(draft.path), name));
    else (draft.mode === "file" ? createFile : createFolder)(join(draft.parent, name));
    setDraft(null);
  };

  const renderLevel = (parent: string, depth: number): React.ReactNode => (
    <>
      {draft && draft.mode !== "rename" && draft.parent === parent && (
        <NameInput initial="" depth={depth} onSubmit={submit} onCancel={() => setDraft(null)} />
      )}
      {(children.get(parent) ?? []).map((e) => {
        const isDir = e.kind === "dir";
        const open = expanded.has(e.path);
        const renaming = draft?.mode === "rename" && draft.path === e.path;
        if (renaming) return <NameInput key={e.path} initial={basename(e.path)} depth={depth} onSubmit={submit} onCancel={() => setDraft(null)} />;
        return (
          <div key={e.path}>
            <div
              role="treeitem"
              aria-selected={activePath === e.path}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => {
                setSelected(e.path);
                setPendingDelete(null);
                if (isDir) toggle(e.path);
                else openFile(e.path);
              }}
              className={`group flex h-6 items-center gap-1.5 pr-1 ${
                activePath === e.path ? "bg-hover text-fg" : selected === e.path ? "bg-raised text-fg" : "text-dim hover:bg-raised"
              }`}
            >
              {isDir ? <Chevron open={open} /> : <span className={icon} />}
              {isDir ? <FolderIcon /> : <FileIcon />}
              <span className="min-w-0 flex-1 truncate">{basename(e.path)}</span>
              <span className="hidden gap-0.5 group-hover:flex" onClick={(ev) => ev.stopPropagation()}>
                {pendingDelete === e.path ? (
                  <button
                    className="rounded px-1.5 text-[11px] text-bad hover:bg-bad/15"
                    onClick={() => {
                      setPendingDelete(null);
                      remove(e.path);
                    }}
                  >
                    Delete?
                  </button>
                ) : (
                  <>
                    <button title="Rename" className="rounded px-1 text-faint hover:text-fg" onClick={() => setDraft({ mode: "rename", path: e.path })}>
                      ✎
                    </button>
                    <button title="Delete" className="rounded px-1 text-faint hover:text-bad" onClick={() => setPendingDelete(e.path)}>
                      ✕
                    </button>
                  </>
                )}
              </span>
            </div>
            {isDir && open && renderLevel(e.path, depth + 1)}
          </div>
        );
      })}
    </>
  );

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel" onMouseLeave={() => setPendingDelete(null)}>
      <div className="flex h-9 items-center justify-between px-3 text-[11px] font-medium uppercase tracking-wider text-faint">
        <span>Project</span>
        <span className="flex gap-1 normal-case">
          <button title="New file" className="rounded px-1.5 py-0.5 text-dim hover:bg-hover hover:text-fg" onClick={() => startCreate("file")}>
            + File
          </button>
          <button title="New folder" className="rounded px-1.5 py-0.5 text-dim hover:bg-hover hover:text-fg" onClick={() => startCreate("folder")}>
            + Dir
          </button>
        </span>
      </div>
      <div role="tree" className="min-h-0 flex-1 overflow-auto pb-2" onClick={(e) => e.target === e.currentTarget && setSelected("/")}>
        {renderLevel("/", 0)}
        {!entries.length && !draft && <div className="px-3 py-2 text-faint">Empty project</div>}
      </div>
    </aside>
  );
}

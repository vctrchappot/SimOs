"use client";

import Editor, { loader, type BeforeMount, type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useRef } from "react";
import { basename } from "@/os/vfs/path";
import { useStudio } from "@/store/studio";

loader.config({ paths: { vs: "/monaco/vs" } });

const SAVE_DELAY_MS = 250;
const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

type Monaco = Parameters<OnMount>[1];

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

const LANGUAGE_BY_NAME: Record<string, string> = { Makefile: "makefile", Dockerfile: "dockerfile" };

export function EditorPane() {
  const studio = useStudio((s) => s.studio)!;
  const rev = useStudio((s) => s.rev);
  const { openTabs, activePath } = useStudio();
  const { setActive, closeTab, registerFlush, setNotice } = useStudio.getState();
  const notice = useStudio((s) => s.notice);

  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const reveal = useStudio((s) => s.reveal);
  /** The text each file had the last time editor and project agreed. */
  const lastSynced = useRef(new Map<string, string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const save = useCallback(
    (path: string) => {
      const t = timers.current.get(path);
      if (t) clearTimeout(t);
      timers.current.delete(path);
      const monaco = monacoRef.current;
      const model = monaco?.editor.getModels().find((m: { uri: { path: string } }) => m.uri.path === path);
      if (!model || studio.fs.stat(path)?.kind !== "file") return;
      const text = model.getValue();
      if (text === lastSynced.current.get(path)) return;
      lastSynced.current.set(path, text);
      studio.fs.writeFile(path, text, "editor");
    },
    [studio],
  );

  const flushAll = useCallback(() => {
    for (const path of [...timers.current.keys()]) save(path);
  }, [save]);

  useEffect(() => registerFlush(flushAll), [flushAll, registerFlush]);

  useEffect(() => {
    window.addEventListener("beforeunload", flushAll);
    document.addEventListener("visibilitychange", flushAll);
    return () => {
      flushAll();
      window.removeEventListener("beforeunload", flushAll);
      document.removeEventListener("visibilitychange", flushAll);
    };
  }, [flushAll]);

  // Pull changes made elsewhere (terminal, other tools) into open editor models; drop models of closed tabs.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    for (const model of monaco.editor.getModels()) {
      const path = model.uri.path;
      if (!openTabs.includes(path)) {
        timers.current.delete(path);
        lastSynced.current.delete(path);
        model.dispose();
        continue;
      }
      if (studio.fs.stat(path)?.kind !== "file") continue;
      const bytes = studio.fs.readFile(path);
      if (isBinary(bytes) || bytes.length > MAX_EDITABLE_BYTES) continue;
      const text = new TextDecoder().decode(bytes);
      const known = lastSynced.current.get(path);
      if (known === undefined) lastSynced.current.set(path, text);
      else if (text !== known) {
        lastSynced.current.set(path, text);
        if (timers.current.has(path)) {
          // The user is mid-edit: never discard typing. Their pending save will replace the OS version.
          setNotice(`${basename(path)} changed in the OS; your unsaved edit will replace it`);
        } else if (model.getValue() !== text) {
          model.setValue(text);
          setNotice(`${basename(path)} updated from the OS`);
        }
      }
    }
  }, [rev, openTabs, studio, setNotice]);

  // Scroll to a search hit once the editor shows that file (switching models takes a few frames).
  useEffect(() => {
    if (!reveal || reveal.path !== activePath) return;
    let frames = 0;
    let id = 0;
    const tryReveal = () => {
      const editor = editorRef.current;
      if (editor?.getModel()?.uri.path === reveal.path) {
        const range = { startLineNumber: reveal.line, startColumn: reveal.column, endLineNumber: reveal.line, endColumn: reveal.column + reveal.length };
        editor.setSelection(range);
        editor.revealRangeInCenter(range);
        editor.focus();
      } else if (frames++ < 30) id = requestAnimationFrame(tryReveal);
    };
    id = requestAnimationFrame(tryReveal);
    return () => cancelAnimationFrame(id);
  }, [reveal, activePath]);

  const beforeMount: BeforeMount = (monaco) => {
    monaco.editor.defineTheme("simos", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#111113",
        "editorGutter.background": "#111113",
        "editor.lineHighlightBackground": "#18181b",
        "editorLineNumber.foreground": "#52525b",
        "editorLineNumber.activeForeground": "#a1a1aa",
        "editor.selectionBackground": "#2b3a67",
        "editorIndentGuide.background1": "#1f1f23",
        "scrollbarSlider.background": "#2a2a2f80",
      },
    });
  };

  const onMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco;
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const path = useStudio.getState().activePath;
      if (path) save(path);
    });
    // Models created before this point need their baseline recorded.
    for (const m of monaco.editor.getModels()) lastSynced.current.set(m.uri.path, m.getValue());
  };

  const active = activePath && studio.fs.stat(activePath)?.kind === "file" ? activePath : null;
  const bytes = active ? studio.fs.readFile(active) : null;
  const unsupported = bytes && (isBinary(bytes) ? "Binary file" : bytes.length > MAX_EDITABLE_BYTES ? "File too large to edit here" : null);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div role="tablist" className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel">
        {openTabs.map((path) => {
          const isActive = path === activePath;
          return (
            <div
              key={path}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(path)}
              onAuxClick={(e) => e.button === 1 && closeTab(path)}
              title={path}
              className={`group flex shrink-0 items-center gap-2 border-r border-line pl-3 pr-1.5 ${
                isActive ? "bg-[#111113] text-fg shadow-[inset_0_-1px_0_var(--color-accent)]" : "bg-panel text-faint hover:text-dim"
              }`}
            >
              <span className={studio.fs.exists(path) ? "" : "line-through"}>{basename(path)}</span>
              <button
                aria-label={`Close ${basename(path)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  save(path);
                  closeTab(path);
                }}
                className="rounded px-1 text-faint opacity-0 hover:bg-hover hover:text-fg group-hover:opacity-100"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        {notice && (
          <div className="pointer-events-none absolute bottom-3 right-4 z-10 rounded-md border border-line bg-raised px-3 py-1.5 text-[12px] text-dim shadow-lg">
            {notice}
          </div>
        )}
        {active && !unsupported ? (
          <Editor
            key="editor"
            path={active}
            defaultValue={new TextDecoder().decode(bytes!)}
            language={LANGUAGE_BY_NAME[basename(active)]}
            theme="simos"
            beforeMount={beforeMount}
            onMount={onMount}
            onChange={(value) => {
              if (value === undefined || !active) return;
              const t = timers.current.get(active);
              if (t) clearTimeout(t);
              timers.current.set(active, setTimeout(() => save(active), SAVE_DELAY_MS));
            }}
            options={{
              fontSize: 13,
              fontFamily: "ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              padding: { top: 12, bottom: 12 },
              renderLineHighlight: "line",
              smoothScrolling: true,
              automaticLayout: true,
              tabSize: 2,
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-faint">
            {unsupported ?? (openTabs.length ? "This file no longer exists" : "Open a file from the project to start editing")}
          </div>
        )}
      </div>
    </div>
  );
}

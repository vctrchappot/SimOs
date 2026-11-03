"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStudio } from "@/store/studio";
import { Explorer } from "./Explorer";
import { Toolbar } from "./Toolbar";

// Monaco and xterm touch `window`; load them on the client only.
const EditorPane = dynamic(() => import("./EditorPane").then((m) => m.EditorPane), { ssr: false });
const TerminalPane = dynamic(() => import("./TerminalPane").then((m) => m.TerminalPane), { ssr: false });

const SPLIT_KEY = "simos.split.v1";
const MIN = 0.2;

function loadSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    if (v >= MIN && v <= 1 - MIN) return v;
  } catch {
    /* storage unavailable */
  }
  return 0.5;
}

export function Workspace() {
  const init = useStudio((s) => s.init);
  const ready = useStudio((s) => s.ready);
  const error = useStudio((s) => s.error);
  const dismissError = useStudio((s) => s.dismissError);
  const [split, setSplit] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSplit(loadSplit());
    void init();
  }, [init]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging || !container.current) return;
      const rect = container.current.getBoundingClientRect();
      setSplit(Math.min(1 - MIN, Math.max(MIN, (e.clientX - rect.left) / rect.width)));
    },
    [dragging],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
    try {
      localStorage.setItem(SPLIT_KEY, String(splitRef.current));
    } catch {
      /* storage unavailable */
    }
  }, []);

  const splitRef = useRef(split);
  splitRef.current = split;

  return (
    <div className="flex h-screen flex-col bg-bg">
      <Toolbar />
      {error && (
        <div className="flex items-center justify-between border-b border-line bg-bad/10 px-4 py-1.5 text-bad">
          <span className="truncate">{error}</span>
          <button className="ml-4 px-2 text-dim hover:text-fg" onClick={dismissError}>
            Dismiss
          </button>
        </div>
      )}
      <div ref={container} className="flex min-h-0 flex-1" style={{ userSelect: dragging ? "none" : undefined }}>
        <section className="flex min-w-0 flex-col bg-panel" style={{ width: `${split * 100}%` }}>
          {ready ? (
            <div className="flex min-h-0 flex-1">
              <Explorer />
              <EditorPane />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-faint">Loading project…</div>
          )}
        </section>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panels"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => setSplit(0.5)}
          className={`group relative z-10 w-px shrink-0 cursor-col-resize bg-line ${dragging ? "bg-accent" : ""}`}
        >
          <div className="absolute inset-y-0 -left-1.5 w-3 group-hover:bg-accent/20" />
        </div>
        <section className="flex min-w-0 flex-1 flex-col bg-bg">
          {/* The iframe-free terminal still needs pointer events off while dragging over it. */}
          <div className="min-h-0 flex-1" style={{ pointerEvents: dragging ? "none" : undefined }}>
            {ready && <TerminalPane />}
          </div>
        </section>
      </div>
    </div>
  );
}

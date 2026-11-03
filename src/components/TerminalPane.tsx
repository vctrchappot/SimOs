"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { TERMINAL_COUNT } from "@/os/runtime/types";
import { DisplayView } from "./DisplayView";
import { DISPLAY_TAB, useStudio } from "@/store/studio";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** One xterm view bound to one serial console of the guest. */
function TerminalView({ index, active }: { index: number; active: boolean }) {
  const runtime = useStudio((s) => s.studio)!.runtime;
  const profileName = useStudio((s) => s.profile.name);
  const host = useRef<HTMLDivElement>(null);
  const refit = useRef<() => void>(() => {});
  const focus = useRef<() => void>(() => {});

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: "#0c0c0e",
        foreground: "#e4e4e7",
        cursor: "#e4e4e7",
        selectionBackground: "#2b3a67",
        black: "#18181b",
        brightBlack: "#52525b",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    const applySize = () => {
      if (!el.offsetParent) return; // hidden tab: nothing to measure
      try {
        fit.fit();
        runtime.resize(term.cols, term.rows, index);
      } catch {
        /* element not laid out yet */
      }
    };
    refit.current = applySize;
    focus.current = () => term.focus();
    applySize();
    const observer = new ResizeObserver(applySize);
    observer.observe(el);

    // Catch up on what this console already printed (a tab opened later, or after a reload of the view).
    const past = runtime.history(index);
    if (past.length) term.write(past);

    const note = (text: string) => term.write(`\r\n${DIM}[studio] ${text}${RESET}\r\n`);
    let last = runtime.status;
    if (index === 0 && last === "stopped") note("The OS is powered off. Press Power on to boot it.");

    const offStatus = runtime.onStatus((status, detail) => {
      if (status === "booting" && last !== "booting") {
        term.reset();
        if (index === 0) {
          note(`Powering on ${profileName}. System files are fetched on demand, so the first boot takes longer.`);
          term.write("\r\n");
        }
      } else if (index === 0 && status === "stopped") note("Machine powered off. Press Power on to boot it again.");
      else if (index === 0 && status === "error") note(`Boot failed: ${detail ?? "unknown error"}`);
      last = status;
    });
    const offOut = runtime.onOutput((data, terminal) => terminal === index && term.write(data));
    const input = term.onData((d) => runtime.sendInput(d, index));

    return () => {
      offStatus();
      offOut();
      input.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [runtime, index, profileName]);

  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      refit.current();
      focus.current();
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  return (
    <div
      ref={host}
      className="h-full w-full overflow-hidden"
      style={{ display: active ? "block" : "none" }}
      onClick={() => focus.current()}
    />
  );
}

export function TerminalPane() {
  const terminals = useStudio((s) => s.terminals);
  const activeTerminal = useStudio((s) => s.activeTerminal);
  const { openTerminal, closeTerminal, setActiveTerminal } = useStudio.getState();

  return (
    <div className="flex h-full flex-col">
      <div role="tablist" aria-label="Terminals" className="flex h-9 shrink-0 items-stretch border-b border-line bg-panel">
        {terminals.map((t) => (
          <div
            key={t}
            role="tab"
            aria-selected={t === activeTerminal}
            onClick={() => setActiveTerminal(t)}
            className={`group flex items-center gap-2 border-r border-line pl-3 pr-1.5 ${
              t === activeTerminal ? "bg-bg text-fg shadow-[inset_0_-1px_0_var(--color-accent)]" : "bg-panel text-faint hover:text-dim"
            }`}
          >
            <span>{t === 0 ? "Console" : `Terminal ${t + 1}`}</span>
            {t !== 0 && (
              <button
                aria-label={`Close terminal ${t + 1}`}
                title="Ends this shell"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(t);
                }}
                className="rounded px-1 text-faint opacity-0 hover:bg-hover hover:text-fg group-hover:opacity-100"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          aria-label="New terminal"
          title={terminals.length >= TERMINAL_COUNT ? "All four terminals are open" : "Open another shell"}
          disabled={terminals.length >= TERMINAL_COUNT}
          onClick={openTerminal}
          className="px-3 text-dim hover:text-fg disabled:opacity-30"
        >
          +
        </button>
        <div
          role="tab"
          aria-selected={activeTerminal === DISPLAY_TAB}
          onClick={() => setActiveTerminal(DISPLAY_TAB)}
          title="The machine's screen (VGA console, keyboard and mouse)"
          className={`ml-auto flex cursor-pointer items-center border-l border-line px-3 ${
            activeTerminal === DISPLAY_TAB ? "bg-bg text-fg shadow-[inset_0_-1px_0_var(--color-accent)]" : "bg-panel text-faint hover:text-dim"
          }`}
        >
          Display
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {terminals.map((t) => (
          <TerminalView key={t} index={t} active={t === activeTerminal} />
        ))}
        <DisplayView active={activeTerminal === DISPLAY_TAB} />
      </div>
    </div>
  );
}

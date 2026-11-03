"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { defaultProfile } from "@/os/runtime/profiles";
import { useStudio } from "@/store/studio";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function TerminalPane() {
  const runtime = useStudio((s) => s.studio)!.runtime;
  const host = useRef<HTMLDivElement>(null);

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
      try {
        fit.fit();
        runtime.resize(term.cols, term.rows);
      } catch {
        /* element not laid out yet */
      }
    };
    applySize();
    const observer = new ResizeObserver(applySize);
    observer.observe(el);

    const note = (text: string) => term.write(`\r\n${DIM}[studio] ${text}${RESET}\r\n`);
    let last = runtime.status;
    if (last === "stopped") note("The OS is powered off. Press Run to boot it.");

    const offStatus = runtime.onStatus((status, detail) => {
      if (status === "booting" && last !== "booting") {
        term.reset();
        note(`Powering on ${defaultProfile.name}. System files are fetched on demand, so the first boot takes longer.`);
        term.write("\r\n");
      } else if (status === "stopped") note("Machine powered off. Press Run to boot it again.");
      else if (status === "error") note(`Boot failed: ${detail ?? "unknown error"}`);
      last = status;
    });
    const offOut = runtime.onOutput((data) => term.write(data));
    const input = term.onData((d) => runtime.sendInput(d));
    term.focus();

    return () => {
      offStatus();
      offOut();
      input.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [runtime]);

  return <div ref={host} className="h-full w-full overflow-hidden" onClick={() => host.current?.querySelector("textarea")?.focus()} />;
}

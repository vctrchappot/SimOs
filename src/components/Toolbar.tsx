"use client";

import { useEffect, useState } from "react";
import { runCommandFor } from "@/os/run-command";
import { defaultProfile } from "@/os/runtime/profiles";
import type { RuntimeStatus } from "@/os/runtime/types";
import { ImageMenu } from "./ImageMenu";
import { NetworkMenu } from "./NetworkMenu";
import { useStudio } from "@/store/studio";

const STATUS: Record<RuntimeStatus, { label: string; dot: string }> = {
  stopped: { label: "Stopped", dot: "bg-faint" },
  booting: { label: "Booting", dot: "bg-warn animate-pulse" },
  running: { label: "Running", dot: "bg-ok" },
  stopping: { label: "Stopping", dot: "bg-warn animate-pulse" },
  error: { label: "Error", dot: "bg-bad" },
};

function Button({
  children,
  onClick,
  disabled,
  tone,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "danger" | "primary";
  title?: string;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`h-7 rounded-md border border-line px-3 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-35 ${
        tone === "danger"
          ? "text-bad hover:bg-bad/10"
          : tone === "primary"
            ? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
            : "text-fg hover:bg-hover"
      }`}
    >
      {children}
    </button>
  );
}

export function Toolbar() {
  const { status, statusDetail, ready, run, stop, restart, reset, runFile, activePath } = useStudio();
  const command = runCommandFor(activePath);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(t);
  }, [confirmReset]);

  const idle = status === "stopped" || status === "error";
  const busy = status === "stopping";
  const on = status === "booting" || status === "running";
  const s = STATUS[status];

  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-panel px-3">
      <div className="flex items-center gap-3">
        <span className="font-semibold tracking-tight">SimOs</span>
        <span className="text-faint">/</span>
        <span className="text-dim">{defaultProfile.name}</span>
        <span className="ml-2 flex items-center gap-1.5 text-[12px] text-dim" title={statusDetail}>
          <span className={`size-1.5 rounded-full ${s.dot}`} />
          {s.label}
          {status === "error" && statusDetail ? `: ${statusDetail.slice(0, 60)}` : ""}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          tone="primary"
          onClick={() => void runFile()}
          disabled={!ready || status !== "running" || !command}
          title={command ? `Run the open file in the terminal
${command}` : "Open a .sh, .c or Makefile to run it"}
        >
          Run file
        </Button>
        <span className="mx-1 h-4 w-px bg-line" />
        <NetworkMenu />
        <ImageMenu />
        <span className="mx-1 h-4 w-px bg-line" />
        <Button onClick={() => void run()} disabled={!ready || !idle} title="Boot the OS">
          Power on
        </Button>
        <Button onClick={() => void stop()} disabled={!ready || !on} title="Shut the OS down (your project is kept)">
          Power off
        </Button>
        <Button onClick={() => void restart()} disabled={!ready || busy || status === "stopped"} title="Power cycle the OS">
          Restart
        </Button>
        <span className="mx-1 h-4 w-px bg-line" />
        {confirmReset ? (
          <Button
            tone="danger"
            onClick={() => {
              setConfirmReset(false);
              void reset();
            }}
            title="Deletes your project files and restores the template"
          >
            Confirm reset
          </Button>
        ) : (
          <Button onClick={() => setConfirmReset(true)} disabled={!ready || busy} title="Restore the project to its initial state">
            Reset
          </Button>
        )}
      </div>
    </header>
  );
}

"use client";

import { useEffect, useState } from "react";
import { parseAddress, type DebugSnapshot, type Registers } from "@/os/runtime/debugger";
import { useStudio } from "@/store/studio";

const hex = (n: number, digits: number) => n.toString(16).toUpperCase().padStart(digits, "0");
const FLAGS: Array<[string, number]> = [["CF", 0], ["PF", 2], ["AF", 4], ["ZF", 6], ["SF", 7], ["TF", 8], ["IF", 9], ["DF", 10], ["OF", 11]];
const MEMORY_ROWS = 8;

function RegisterTable({ r }: { r: Registers }) {
  const general: Array<[string, number]> = [["EAX", r.eax], ["ECX", r.ecx], ["EDX", r.edx], ["EBX", r.ebx], ["ESP", r.esp], ["EBP", r.ebp], ["ESI", r.esi], ["EDI", r.edi]];
  const segs: Array<[string, number]> = [["CS", r.cs], ["DS", r.ds], ["ES", r.es], ["SS", r.ss], ["FS", r.fs], ["GS", r.gs]];
  return (
    <div className="font-mono text-[11px] leading-[1.35]" aria-label="Registers">
      <div className="text-faint">{r.protectedMode ? "protected mode" : "real mode"}</div>
      <div>
        <span className="text-faint">EIP </span>
        {hex(r.eip, 8)} <span className="text-faint">({hex(r.linearIp, 8)})</span>
      </div>
      {general.map(([n, v]) => (
        <div key={n}>
          <span className="text-faint">{n} </span>
          {hex(v, 8)}
        </div>
      ))}
      <div className="mt-1 flex flex-wrap gap-x-2">
        {segs.map(([n, v]) => (
          <span key={n}>
            <span className="text-faint">{n} </span>
            {hex(v, 4)}
          </span>
        ))}
      </div>
      <div className="mt-1">
        <span className="text-faint">FLAGS </span>
        {hex(r.eflags, 8)}{" "}
        <span className="text-dim">
          {FLAGS.filter(([, bit]) => r.eflags & (1 << bit))
            .map(([n]) => n)
            .join(" ") || "-"}
        </span>
      </div>
    </div>
  );
}

function MemoryDump({ snap }: { snap: DebugSnapshot["memory"] }) {
  if (!snap) return <p className="text-[11px] text-faint">Memory is not readable at this address.</p>;
  const rows = [];
  for (let off = 0; off < snap.data.length; off += 16) {
    const bytes = [...snap.data.slice(off, off + 16)];
    rows.push(
      <div key={off}>
        <span className="text-faint">{hex(snap.addr + off, 8)} </span>
        {bytes
          .map((b) => hex(b, 2))
          .join(" ")
          .padEnd(47, " ")}{" "}
        <span className="text-dim">{bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("")}</span>
      </div>,
    );
  }
  return (
    <div className="whitespace-pre font-mono text-[11px] leading-[1.35]" aria-label="Memory">
      {rows}
    </div>
  );
}

/** Registers, memory and breakpoints for the image running on the bare PC. */
export function DebugPanel() {
  const bare = useStudio((s) => s.bare);
  const status = useStudio((s) => s.bareStatus);
  const { breakpoints, debugPaused, debugHit, setBreakpoints, pauseImage, resumeImage } = useStudio();
  const [snap, setSnap] = useState<DebugSnapshot | null>(null);
  const [addrText, setAddrText] = useState("0x7c00");
  const [follow, setFollow] = useState(false);
  const [bpText, setBpText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const running = status === "running";

  const base = parseAddress(addrText);

  // Refresh while the machine runs (the CPU keeps moving) and again whenever it stops or continues.
  useEffect(() => {
    if (!bare || !running) {
      setSnap(null);
      return;
    }
    let alive = true;
    const refresh = async () => {
      let at = base ?? 0x7c00;
      if (follow) {
        const now = await bare.inspect();
        if (now?.registers) at = now.registers.linearIp;
      }
      const s = await bare.inspect({ addr: at, length: 16 * MEMORY_ROWS });
      if (alive) setSnap(s);
    };
    void refresh();
    const id = setInterval(() => void refresh(), debugPaused ? 1000 : 500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [bare, running, base, follow, debugPaused, debugHit]);

  const addBreakpoint = () => {
    const a = parseAddress(bpText);
    if (a === null) return setError("Enter an address like 0x7c04 or 0000:7c04.");
    setError(null);
    setBpText("");
    setBreakpoints([...breakpoints, a]);
  };

  return (
    <div
      className="grid shrink-0 grid-cols-[minmax(0,13rem)_1fr] gap-3 overflow-auto border-t border-line bg-bg p-3"
      style={{ maxHeight: "16rem" }}
      aria-label="Debugger"
    >
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2">
          {debugPaused ? (
            <button
              onClick={() => resumeImage()}
              disabled={!running}
              className="rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20 disabled:opacity-35"
            >
              Continue
            </button>
          ) : (
            <button
              onClick={() => pauseImage()}
              disabled={!running}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-fg hover:bg-hover disabled:opacity-35"
            >
              Pause
            </button>
          )}
          <span className="text-[11px] text-faint" aria-live="polite">
            {debugHit !== null ? `Stopped at breakpoint ${hex(debugHit, 4)}` : debugPaused ? "Paused" : running ? "Running" : "No image running"}
          </span>
        </div>
        {snap?.registers ? <RegisterTable r={snap.registers} /> : <p className="text-[11px] text-faint">Boot an image to see registers.</p>}
      </div>
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2 text-[11px]">
          <label className="flex items-center gap-1 text-dim">
            Memory at
            <input
              value={addrText}
              onChange={(e) => setAddrText(e.target.value)}
              disabled={follow}
              spellCheck={false}
              aria-label="Memory address"
              aria-invalid={base === null}
              className="h-6 w-24 rounded border border-line bg-panel px-1.5 font-mono text-fg outline-none focus:border-accent disabled:opacity-50"
            />
          </label>
          <label className="flex items-center gap-1 text-dim">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow EIP
          </label>
        </div>
        <MemoryDump snap={snap?.memory ?? null} />
        <div className="mt-2 border-t border-line pt-2">
          <div className="flex items-center gap-1 text-[11px]">
            <input
              value={bpText}
              onChange={(e) => setBpText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addBreakpoint()}
              placeholder="Breakpoint address, e.g. 0x7c04"
              aria-label="Breakpoint address"
              spellCheck={false}
              className="h-6 w-52 rounded border border-line bg-panel px-1.5 font-mono text-fg outline-none focus:border-accent"
            />
            <button onClick={addBreakpoint} className="rounded border border-line px-2 py-0.5 text-fg hover:bg-hover">
              Add
            </button>
          </div>
          {error ? <p className="mt-1 text-[11px] text-bad">{error}</p> : null}
          <div className="mt-1 flex flex-wrap gap-1">
            {breakpoints.map((a) => (
              <span key={a} className="flex items-center gap-1 rounded bg-panel px-1.5 py-0.5 font-mono text-[11px] text-dim">
                {hex(a, 4)}
                <button
                  aria-label={`Remove breakpoint ${hex(a, 4)}`}
                  onClick={() => setBreakpoints(breakpoints.filter((b) => b !== a))}
                  className="text-faint hover:text-fg"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <p className="mt-1 text-[10px] leading-snug text-faint">
            A breakpoint patches two bytes at that address, so put it on the start of an instruction. It stops the machine when the code gets
            there and re-arms shortly after Continue (the emulator has no single-step). Breakpoints in the boot sector (0x7C00 to 0x7DFD)
            also catch the very first instructions.
          </p>
        </div>
      </div>
    </div>
  );
}

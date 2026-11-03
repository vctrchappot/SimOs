"use client";

import { useEffect, useRef, useState } from "react";
import type { SystemId } from "@/os/runtime/profiles";
import { useStudio } from "@/store/studio";

const OPTIONS: Array<{ id: SystemId; title: string; text: string }> = [
  { id: "alpine", title: "Alpine Linux", text: "Text system. Fast to boot, with bash, make and a C compiler." },
  {
    id: "alpine-desktop",
    title: "Alpine Linux (graphics)",
    text: "Alpine's own kernel with a framebuffer and an X desktop (twm and a terminal) on the Display tab. Slower to boot and needs more memory.",
  },
];

/** Which Linux the machine runs. Switching reloads the page: the kernel and its drivers are part of the machine. */
export function SystemMenu() {
  const { system, profile, setSystem, status } = useStudio();
  const [open, setOpen] = useState(false);
  const [graphicsAvailable, setGraphicsAvailable] = useState<boolean | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch("/os/desktop/vmlinuz", { method: "HEAD" })
      .then((r) => alive && setGraphicsAvailable(r.ok))
      .catch(() => alive && setGraphicsAvailable(false));
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      alive = false;
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Choose which Linux system boots"
        className="flex items-center gap-1 rounded px-1 text-dim hover:text-fg"
      >
        {profile.name} <span className="text-[10px]">▾</span>
      </button>
      {open ? (
        <div role="dialog" aria-label="System" className="absolute left-0 top-8 z-30 w-80 rounded-lg border border-line bg-raised p-3 shadow-xl">
          <div role="radiogroup" className="flex flex-col gap-1">
            {OPTIONS.map((o) => {
              const unavailable = o.id === "alpine-desktop" && graphicsAvailable === false;
              return (
                <label
                  key={o.id}
                  className={`flex gap-2 rounded-md border p-2 ${unavailable ? "opacity-50" : "cursor-pointer"} ${system === o.id ? "border-accent/50 bg-accent/5" : "border-transparent hover:bg-hover"}`}
                >
                  <input
                    type="radio"
                    name="system"
                    className="mt-0.5"
                    checked={system === o.id}
                    disabled={unavailable}
                    onChange={() => {
                      if (o.id !== system) setSystem(o.id);
                    }}
                  />
                  <span>
                    <span className="block text-[12px] font-medium">{o.title}</span>
                    <span className="block text-[11px] leading-snug text-dim">{o.text}</span>
                    {unavailable ? <span className="block text-[11px] text-warn">Not built yet: run npm run build:os.</span> : null}
                  </span>
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-faint">
            {status === "running" || status === "booting" ? "Switching reloads the page and powers the machine off. Your project is kept." : "Switching reloads the page."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

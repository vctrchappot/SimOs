"use client";

import { useEffect, useRef, useState } from "react";
import { useStudio } from "@/store/studio";

/** Boot a disk image from the project on a bare PC (no Linux), e.g. an OS you assembled yourself. */
export function ImageMenu() {
  const { bootImages, bootImage, stopImage, bareStatus, bare, rev, ready } = useStudio();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const running = bareStatus === "booting" || bareStatus === "running";
  const images = open ? bootImages() : [];
  void rev; // re-list when the project changes

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={!ready}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Boot a disk image from your project on a bare PC"
        className="h-7 rounded-md border border-line px-3 text-[12px] font-medium text-fg transition-colors hover:bg-hover disabled:opacity-35"
      >
        Boot image
        {running ? <span className="ml-1.5 text-ok">●</span> : null}
      </button>
      {open ? (
        <div role="dialog" aria-label="Boot a disk image" className="absolute right-0 top-9 z-30 w-80 rounded-lg border border-line bg-raised p-3 shadow-xl">
          <p className="text-[11px] leading-snug text-dim">
            Starts a bare PC (BIOS, VGA, keyboard, serial) from a disk image in your project. No Linux is involved: your code runs at boot.
          </p>
          <div className="mt-2 flex flex-col gap-1">
            {images.length ? (
              images.map((path) => (
                <div key={path} className="flex items-center justify-between rounded-md px-2 py-1 hover:bg-hover">
                  <span className="truncate font-mono text-[12px]" title={path}>
                    {path}
                    {running && bare?.imageName === path ? <span className="ml-1.5 text-ok">●</span> : null}
                  </span>
                  <button
                    onClick={() => {
                      setOpen(false);
                      void bootImage(path);
                    }}
                    disabled={running}
                    className="ml-2 shrink-0 rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20 disabled:opacity-35"
                  >
                    Boot
                  </button>
                </div>
              ))
            ) : (
              <p className="rounded-md border border-dashed border-line p-2 text-[11px] leading-snug text-faint">
                No images yet. Build one in the OS terminal, e.g. <code className="text-dim">cd boot &amp;&amp; make</code>, or
                <code className="text-dim"> nasm -f bin boot.asm -o boot.img</code>.
                Files ending in .img, .bin, .iso or .flp show up here.
              </p>
            )}
          </div>
          {running ? (
            <button
              onClick={() => stopImage()}
              className="mt-2 h-7 w-full rounded-md border border-line text-[12px] text-bad hover:bg-bad/10"
            >
              Power off the image
            </button>
          ) : null}
          {bareStatus === "error" ? <p className="mt-2 text-[11px] text-bad">The image failed to boot.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

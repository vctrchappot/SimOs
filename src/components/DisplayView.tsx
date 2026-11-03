"use client";

import { useEffect, useRef, useState } from "react";
import { scancodes } from "@/os/keyboard";
import type { DisplayFrame } from "@/os/runtime/display";
import { CP437 } from "@/os/runtime/cp437";
import { DebugPanel } from "./DebugPanel";
import { useStudio } from "@/store/studio";

const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
const FONT = "16px ui-monospace, 'Cascadia Mono', Consolas, Menlo, monospace";

/** The machine's screen: VGA text console or graphics, with keyboard and mouse going to the guest. */
export function DisplayView({ active }: { active: boolean }) {
  const linux = useStudio((s) => s.studio)!.runtime;
  const bare = useStudio((s) => s.bare);
  const source = useStudio((s) => s.displaySource);
  const linuxStatus = useStudio((s) => s.status);
  const bareStatus = useStudio((s) => s.bareStatus);
  const bareLog = useStudio((s) => s.bareLog);
  const { setDisplaySource, stopImage } = useStudio.getState();
  // Everything below talks to whichever machine the tab is showing.
  const runtime = source === "image" && bare ? bare : linux;
  const status = source === "image" ? bareStatus : linuxStatus;
  const canvas = useRef<HTMLCanvasElement>(null);
  const graphic = useRef(false);
  const [live, setLive] = useState(false);
  const [focused, setFocused] = useState(false);
  const down = useRef(new Set<string>());
  const buttons = useRef<[boolean, boolean, boolean]>([false, false, false]);

  useEffect(() => {
    if (!active) return;
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const cell = (() => {
      ctx.font = FONT;
      return { w: Math.ceil(ctx.measureText("M").width), h: 18 };
    })();

    const paint = (frame: DisplayFrame) => {
      setLive(true);
      graphic.current = frame.kind === "graphic";
      if (frame.kind === "graphic") {
        if (el.width !== frame.width || el.height !== frame.height) {
          el.width = frame.width;
          el.height = frame.height;
        }
        for (const r of frame.rects) ctx.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), r.x, r.y);
        return;
      }
      const w = frame.cols * cell.w;
      const h = frame.rows * cell.h;
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
      }
      ctx.font = FONT;
      ctx.textBaseline = "middle";
      for (let row = 0; row < frame.rows; row++) {
        for (let col = 0; col < frame.cols; col++) {
          const i = row * frame.cols + col;
          ctx.fillStyle = hex(frame.bg[i]);
          ctx.fillRect(col * cell.w, row * cell.h, cell.w, cell.h);
          const ch = frame.chars[i];
          if (ch !== 32 && ch !== 0) {
            ctx.fillStyle = hex(frame.fg[i]);
            ctx.fillText(CP437[ch] ?? " ", col * cell.w, row * cell.h + cell.h / 2 + 1);
          }
        }
      }
      if (frame.cursor.visible && frame.cursor.row < frame.rows && frame.cursor.col < frame.cols) {
        ctx.fillStyle = "rgba(228,228,231,0.75)";
        ctx.fillRect(frame.cursor.col * cell.w, frame.cursor.row * cell.h + cell.h - 3, cell.w, 2);
      }
    };
    const off = runtime.onDisplay(paint);
    return () => {
      off();
      setLive(false);
    };
  }, [runtime, active]);

  // Switching machines (or powering one off) leaves a stale picture behind.
  useEffect(() => {
    setLive(false);
  }, [source]);

  // A powered-off machine has no signal.
  useEffect(() => {
    if (status === "stopped") setLive(false);
  }, [status]);

  const releaseAll = () => {
    for (const code of down.current) {
      const codes = scancodes(code, false);
      if (codes) runtime.sendKeys(codes);
    }
    down.current.clear();
  };

  const key = (down_: boolean) => (e: React.KeyboardEvent) => {
    const codes = scancodes(e.code, down_);
    if (!codes) return;
    e.preventDefault();
    e.stopPropagation();
    if (down_) down.current.add(e.code);
    else down.current.delete(e.code);
    runtime.sendKeys(codes);
  };

  /**
   * Sends the pointer to the guest both ways, like a real mouse adapter would: movement since the last event (for a
   * PS/2 mouse) and the position on the screen (for guests with a VMware-style absolute mouse, like Linux here).
   * The canvas letterboxes the picture, so positions are measured inside the picture, not the element.
   */
  const pointer = (e: React.MouseEvent<HTMLCanvasElement>, pressed: boolean | null) => {
    const el = canvas.current!;
    if (pressed !== null) {
      const i = e.button === 0 ? 0 : e.button === 2 ? 2 : 1;
      buttons.current[i] = pressed;
    }
    const box = el.getBoundingClientRect();
    const scale = Math.min(box.width / el.width, box.height / el.height) || 1;
    const left = box.left + (box.width - el.width * scale) / 2;
    const top = box.top + (box.height - el.height * scale) / 2;
    const x = Math.max(0, Math.min(el.width, (e.clientX - left) / scale));
    const y = Math.max(0, Math.min(el.height, (e.clientY - top) / scale));
    runtime.sendMouse(pressed === null ? e.movementX / scale : 0, pressed === null ? e.movementY / scale : 0, [...buttons.current], {
      x,
      y,
      width: el.width,
      height: el.height,
    });
  };

  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [bareLog]);

  return (
    <div className="relative flex h-full w-full flex-col bg-black" style={{ display: active ? "flex" : "none" }}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line bg-panel px-2 text-[12px]">
        {(["linux", "image"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setDisplaySource(k)}
            aria-pressed={source === k}
            className={`rounded px-2 py-0.5 ${source === k ? "bg-hover text-fg" : "text-faint hover:text-dim"}`}
          >
            {k === "linux" ? "Linux" : `Image${bare?.imageName ? `: ${bare.imageName.split("/").pop()}` : ""}`}
          </button>
        ))}
        {source === "image" && (bareStatus === "running" || bareStatus === "booting") ? (
          <button onClick={() => stopImage()} className="ml-auto rounded px-2 py-0.5 text-bad hover:bg-bad/10">
            Power off
          </button>
        ) : null}
      </div>
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label="Machine display"
        onKeyDown={key(true)}
        onKeyUp={key(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          releaseAll();
        }}
        onMouseDown={(e) => pointer(e, true)}
        onMouseUp={(e) => pointer(e, false)}
        onMouseMove={(e) => pointer(e, null)}
        onContextMenu={(e) => e.preventDefault()}
        className={`min-h-0 w-full flex-1 object-contain outline-none ${live ? "" : "invisible"} ${focused && graphic.current ? "cursor-none" : ""}`}
        style={{ imageRendering: "pixelated" }}
      />
      {!live ? (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-faint">
          {status === "running"
            ? "Waiting for the display…"
            : source === "image"
              ? "No image is running. Use Boot image in the toolbar."
              : "No signal: the OS is not running."}
        </div>
      ) : (
        <div className="shrink-0 border-t border-line bg-panel px-3 py-1 text-[11px] text-faint">
          {focused ? "Keyboard goes to the machine. Click elsewhere to leave." : "Click the screen to type into the machine."}
        </div>
      )}
      {source === "image" ? <DebugPanel /> : null}
      {source === "image" && bareLog ? (
        <pre ref={logRef} aria-label="Serial output" className="max-h-24 shrink-0 overflow-auto border-t border-line bg-bg px-3 py-1 font-mono text-[11px] text-dim">
          {bareLog}
        </pre>
      ) : null}
    </div>
  );
}

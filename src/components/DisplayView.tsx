"use client";

import { useEffect, useRef, useState } from "react";
import { scancodes } from "@/os/keyboard";
import type { DisplayFrame } from "@/os/runtime/display";
import { useStudio } from "@/store/studio";

/** Code page 437, the character set of the PC text console, as Unicode. */
const CP437 = (() => {
  const low = "\0☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼";
  const high =
    "⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
  let ascii = "";
  for (let c = 0x20; c < 0x7f; c++) ascii += String.fromCharCode(c);
  return [...(low + ascii + high)];
})();

const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
const FONT = "16px ui-monospace, 'Cascadia Mono', Consolas, Menlo, monospace";

/** The machine's screen: VGA text console or graphics, with keyboard and mouse going to the guest. */
export function DisplayView({ active }: { active: boolean }) {
  const runtime = useStudio((s) => s.studio)!.runtime;
  const status = useStudio((s) => s.status);
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

  const pointer = (e: React.MouseEvent<HTMLCanvasElement>, pressed: boolean | null) => {
    const el = canvas.current!;
    if (pressed !== null) {
      const i = e.button === 0 ? 0 : e.button === 2 ? 2 : 1;
      buttons.current[i] = pressed;
      if (pressed && graphic.current && document.pointerLockElement !== el) {
        // The guest sees a relative mouse; capture the pointer so it can move without leaving the screen (Esc frees it).
        void el.requestPointerLock?.();
      }
      runtime.sendMouse(0, 0, [...buttons.current]);
    } else if (document.pointerLockElement === el) {
      runtime.sendMouse(e.movementX, e.movementY, [...buttons.current]);
    }
  };

  return (
    <div className="relative flex h-full w-full flex-col bg-black" style={{ display: active ? "flex" : "none" }}>
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
        className={`min-h-0 w-full flex-1 object-contain outline-none ${live ? "" : "invisible"}`}
        style={{ imageRendering: "pixelated" }}
      />
      {!live ? (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-faint">
          {status === "running" ? "Waiting for the display…" : "No signal: the OS is not running."}
        </div>
      ) : (
        <div className="shrink-0 border-t border-line bg-panel px-3 py-1 text-[11px] text-faint">
          {focused ? "Keyboard goes to the OS. Click elsewhere to leave." : "Click the screen to type into the OS."}
        </div>
      )}
    </div>
  );
}

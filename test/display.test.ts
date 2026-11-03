import { describe, expect, it } from "vitest";
import { DisplayAdapter, type DisplayFrame } from "@/os/runtime/display";

function collect(d: DisplayAdapter) {
  const frames: DisplayFrame[] = [];
  d.onFrame = (f) => frames.push(f);
  return frames;
}

describe("DisplayAdapter", () => {
  it("builds a text frame from put_char calls and only emits when something changed", () => {
    const d = new DisplayAdapter();
    const frames = collect(d);
    d.set_mode(false);
    d.set_size_text(4, 2);
    d.put_char(0, 1, 72, 0, 0x000000, 0xffffff);
    d.update_cursor(1, 3);
    d.flush();
    d.flush(); // nothing new
    expect(frames).toHaveLength(1);
    const f = frames[0];
    if (f.kind !== "text") throw new Error("expected text");
    expect([f.cols, f.rows]).toEqual([4, 2]);
    expect(f.chars[1]).toBe(72);
    expect(f.fg[1]).toBe(0xffffff);
    expect(f.cursor).toMatchObject({ row: 1, col: 3 });
    d.put_char(5, 5, 1, 0, 0, 0); // out of range: ignored
    d.put_char(0, 0, 65, 0, 0, 0xaa0000);
    d.flush();
    expect(frames).toHaveLength(2);
  });

  it("copies changed pixel blocks in graphics mode and keeps a full picture for late viewers", () => {
    const d = new DisplayAdapter();
    const frames = collect(d);
    d.set_mode(true);
    d.set_size_graphical(4, 3);
    const pixels = new Uint8ClampedArray(4 * 3 * 4);
    pixels.fill(0, 0);
    // a 2x1 block at (1,1) in the source image
    for (let i = 0; i < 2; i++) pixels.set([255, 0, 0, 255], ((1 * 4 + 1 + i) * 4));
    d.flush(); // initial blank picture
    d.update_buffer([{ image_data: { data: pixels, width: 4 }, screen_x: 1, screen_y: 1, buffer_x: 1, buffer_y: 1, buffer_width: 2, buffer_height: 1 }]);
    d.flush();
    const last = frames.at(-1)!;
    if (last.kind !== "graphic") throw new Error("expected graphic");
    expect(last.rects).toHaveLength(1);
    expect(last.rects[0]).toMatchObject({ x: 1, y: 1, w: 2, h: 1 });
    expect([...last.rects[0].data]).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);

    const snap = d.snapshot()!;
    if (snap.kind !== "graphic") throw new Error("expected graphic");
    expect(snap.rects[0]).toMatchObject({ x: 0, y: 0, w: 4, h: 3 });
    const at = (x: number, y: number) => [...snap.rects[0].data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    expect(at(1, 1)).toEqual([255, 0, 0, 255]);
    expect(at(0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("clips blocks that stick out of the screen", () => {
    const d = new DisplayAdapter();
    d.set_mode(true);
    d.set_size_graphical(2, 2);
    const img = { data: new Uint8ClampedArray(8 * 8 * 4).fill(9), width: 8 };
    expect(() => d.update_buffer([{ image_data: img, screen_x: 1, screen_y: 1, buffer_x: 0, buffer_y: 0, buffer_width: 8, buffer_height: 8 }])).not.toThrow();
    const snap = d.snapshot()!;
    if (snap.kind !== "graphic") throw new Error("expected graphic");
    expect(snap.rects[0].data.length).toBe(2 * 2 * 4);
  });

  it("invalidate() makes the next flush resend everything", () => {
    const d = new DisplayAdapter();
    const frames = collect(d);
    d.set_mode(false);
    d.set_size_text(2, 1);
    d.flush();
    d.flush();
    d.invalidate();
    d.flush();
    expect(frames).toHaveLength(2);
  });
});

/**
 * The machine's display. The emulated VGA card calls into a "screen adapter"; this one has no DOM,
 * so it works inside the emulator's worker. It keeps the current picture and hands out frames
 * that the page paints on a canvas.
 */

export interface TextFrame {
  kind: "text";
  cols: number;
  rows: number;
  /** One code page 437 character per cell, row by row. */
  chars: Uint8Array;
  /** 0xRRGGBB per cell. */
  fg: Uint32Array;
  bg: Uint32Array;
  cursor: { row: number; col: number; visible: boolean };
}

export interface GraphicFrame {
  kind: "graphic";
  width: number;
  height: number;
  /** RGBA pixel blocks to paint; the first frame after a mode change (or a refresh) covers the whole screen. */
  rects: Array<{ x: number; y: number; w: number; h: number; data: Uint8ClampedArray }>;
}

export type DisplayFrame = TextFrame | GraphicFrame;

/** Where the pointer is on the screen, for guests whose mouse reports absolute positions (VMware-style). */
export interface AbsolutePointer {
  x: number;
  y: number;
  /** Size of the area x and y are measured in. */
  width: number;
  height: number;
}

/** What the VGA emulation hands over in graphics mode (matches the browser's ImageData). */
interface ImageLike {
  data: Uint8ClampedArray;
  width: number;
}
interface Layer {
  image_data: ImageLike;
  screen_x: number;
  screen_y: number;
  buffer_x: number;
  buffer_y: number;
  buffer_width: number;
  buffer_height: number;
}

export class DisplayAdapter {
  // Constants the VGA emulation reads off its screen.
  readonly FLAG_BLINKING = 1;
  readonly FLAG_FONT_PAGE_B = 2;

  private graphical = false;
  private cols = 0;
  private rows = 0;
  private chars = new Uint8Array(0);
  private fg = new Uint32Array(0);
  private bg = new Uint32Array(0);
  private cursor = { row: 0, col: 0, visible: true };
  private cursorShape = true;
  private width = 0;
  private height = 0;
  /** Everything painted so far, so a late viewer can be brought up to date. */
  private shadow = new Uint8ClampedArray(0);
  private pending: GraphicFrame["rects"] = [];
  private dirty = true;

  /** Called with each new picture, at most once per flush(). */
  onFrame: ((frame: DisplayFrame) => void) | null = null;

  // --- called by the VGA emulation ---------------------------------------------------------

  set_mode(graphical: boolean) {
    this.graphical = graphical;
    this.dirty = true;
  }
  set_size_text(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.chars = new Uint8Array(cols * rows).fill(32);
    this.fg = new Uint32Array(cols * rows).fill(0xaaaaaa);
    this.bg = new Uint32Array(cols * rows);
    this.dirty = true;
  }
  set_size_graphical(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.shadow = new Uint8ClampedArray(width * height * 4);
    this.pending = [{ x: 0, y: 0, w: width, h: height, data: this.shadow.slice() }];
    this.dirty = true;
  }
  put_char(row: number, col: number, chr: number, _flags: number, bg: number, fg: number) {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;
    const i = row * this.cols + col;
    this.chars[i] = chr;
    this.fg[i] = fg & 0xffffff;
    this.bg[i] = bg & 0xffffff;
    this.dirty = true;
  }
  update_cursor(row: number, col: number) {
    this.cursor.row = row;
    this.cursor.col = col;
    this.dirty = true;
  }
  update_cursor_scanline(_start: number, _end: number, visible: boolean) {
    this.cursorShape = visible;
    this.dirty = true;
  }
  update_buffer(layers: Layer[]) {
    for (const l of layers) {
      const w = Math.min(l.buffer_width, this.width - l.screen_x);
      const h = Math.min(l.buffer_height, this.height - l.screen_y);
      if (w <= 0 || h <= 0) continue;
      const src = l.image_data;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const from = ((l.buffer_y + y) * src.width + l.buffer_x) * 4;
        data.set(src.data.subarray(from, from + w * 4), y * w * 4);
        this.shadow.set(data.subarray(y * w * 4, (y + 1) * w * 4), ((l.screen_y + y) * this.width + l.screen_x) * 4);
      }
      this.pending.push({ x: l.screen_x, y: l.screen_y, w, h, data });
      this.dirty = true;
    }
  }
  clear_screen() {
    this.shadow.fill(0);
    this.pending = [{ x: 0, y: 0, w: this.width, h: this.height, data: this.shadow.slice() }];
    this.dirty = true;
  }
  clear_text_state() {}
  set_font_bitmap() {}
  set_font_page() {}
  set_scale() {}
  destroy() {}
  pause() {}
  continue() {}

  // --- used by the runtime ------------------------------------------------------------------

  /** The whole picture as it is right now. */
  snapshot(): DisplayFrame | null {
    if (this.graphical) {
      if (!this.width || !this.height) return null;
      return { kind: "graphic", width: this.width, height: this.height, rects: [{ x: 0, y: 0, w: this.width, h: this.height, data: this.shadow.slice() }] };
    }
    if (!this.cols || !this.rows) return null;
    return {
      kind: "text",
      cols: this.cols,
      rows: this.rows,
      chars: this.chars.slice(),
      fg: this.fg.slice(),
      bg: this.bg.slice(),
      cursor: { ...this.cursor, visible: this.cursorShape },
    };
  }

  /** Emits a frame if anything changed since the last one. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const rects = this.pending;
    this.pending = [];
    if (this.graphical) {
      if (!rects.length) return;
      this.onFrame?.({ kind: "graphic", width: this.width, height: this.height, rects });
      return;
    }
    const frame = this.snapshot();
    if (frame) this.onFrame?.(frame);
  }

  /** Marks the picture as unseen, so the next flush() sends all of it (a viewer just attached). */
  invalidate() {
    this.dirty = true;
    if (this.graphical && this.width && this.height) this.pending = [{ x: 0, y: 0, w: this.width, h: this.height, data: this.shadow.slice() }];
  }
}

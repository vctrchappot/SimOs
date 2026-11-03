/**
 * Remembers the most recent console output of each terminal, so a terminal view opened later
 * (or re-opened after a tab was closed) can catch up on what its shell already printed.
 */
export class OutputHistory {
  private chunks: Uint8Array[][];
  private sizes: number[];

  constructor(
    terminals: number,
    private capBytes = 256 * 1024,
  ) {
    this.chunks = Array.from({ length: terminals }, () => []);
    this.sizes = Array<number>(terminals).fill(0);
  }

  push(terminal: number, data: Uint8Array): void {
    const list = this.chunks[terminal];
    if (!list) return;
    list.push(data);
    this.sizes[terminal] += data.length;
    // Drop whole old chunks first; if one chunk alone is over the cap keep its tail.
    while (this.sizes[terminal] > this.capBytes && list.length > 1) this.sizes[terminal] -= list.shift()!.length;
    if (this.sizes[terminal] > this.capBytes) {
      const only = list[0].slice(list[0].length - this.capBytes);
      list[0] = only;
      this.sizes[terminal] = only.length;
    }
  }

  get(terminal: number): Uint8Array {
    const list = this.chunks[terminal] ?? [];
    const out = new Uint8Array(this.sizes[terminal] ?? 0);
    let at = 0;
    for (const c of list) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  clear(terminal?: number): void {
    const targets = terminal === undefined ? this.chunks.keys() : [terminal];
    for (const t of targets) {
      this.chunks[t] = [];
      this.sizes[t] = 0;
    }
  }
}

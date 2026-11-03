/** Runs commands on the guest's system console (terminal 0) and reads back their output and exit status. */

export interface ConsoleLike {
  onOutput(cb: (data: Uint8Array, terminal: number) => void): () => void;
  sendInput(data: string, terminal?: number): void;
}

export interface ExecResult {
  output: string;
  /** Exit status, or null if the command did not finish in time (it was interrupted). */
  code: number | null;
}

/** Ctrl-U discards a half-typed line; Ctrl-C interrupts the running command. */
const CLEAR_LINE = String.fromCharCode(21);
const INTERRUPT = String.fromCharCode(3);
/** The terminal's line buffer holds 4095 characters. */
export const MAX_COMMAND_CHARS = 2400;

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export class GuestShell {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private console: ConsoleLike) {}

  /** Runs one command at a time (they share one console). The shell keeps its state, e.g. the directory, between calls. */
  run(command: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<ExecResult> {
    const next = this.queue.then(() => this.exec(command, timeoutMs, signal));
    this.queue = next.catch(() => {});
    return next;
  }

  private async exec(command: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
    const encoded = toBase64(command);
    if (encoded.length > MAX_COMMAND_CHARS) {
      throw new Error("The command is too long for the terminal. Write it to a script file with write_file and run that.");
    }
    const token = Math.random().toString(36).slice(2, 8);
    let output = "";
    const decoder = new TextDecoder();
    const off = this.console.onOutput((d, terminal) => {
      if (terminal === 0) output += decoder.decode(d, { stream: true });
    });
    // The markers are assembled by printf, so the terminal's echo of the command line never matches them.
    // The command itself travels base64-encoded, so quotes, newlines and heredocs survive the terminal.
    const line = `printf 'B%sB\\n' ${token}; eval "$(echo ${encoded} | base64 -d)"; printf '\\nE%sE:%s\\n' ${token} $?\n`;
    this.console.sendInput(CLEAR_LINE + line, 0);
    const re = new RegExp(`B${token}B\\r?\\n([\\s\\S]*?)\\r?\\nE${token}E:(\\d+)`);
    const clean = (s: string) => s.replace(/\r/g, "").replace(ANSI, "");
    const started = Date.now();
    try {
      for (;;) {
        const m = output.match(re);
        if (m) return { output: clean(m[1]), code: Number(m[2]) };
        if (signal?.aborted) {
          this.console.sendInput(INTERRUPT, 0);
          throw new DOMException("Stopped", "AbortError");
        }
        if (Date.now() - started > timeoutMs) {
          this.console.sendInput(INTERRUPT, 0);
          const begin = output.indexOf(`B${token}B`);
          const partial = begin >= 0 ? output.slice(output.indexOf("\n", begin) + 1) : "";
          return { output: clean(partial), code: null };
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      off();
    }
  }
}

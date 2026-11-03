import { basename } from "./vfs/path";

/** Quotes a string for bash. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command the "Run file" button types into the terminal for the open file.
 * It is typed into the real shell (and echoed there), never run behind the user's back.
 * Returns null when nothing sensible can be run.
 */
export function runCommandFor(path: string | null): string | null {
  const cd = 'cd "$PROJECT" && ';
  if (!path) return `${cd}make`;
  const rel = shellQuote("." + path);
  const name = basename(path);
  if (name === "Makefile" || name.endsWith(".mk")) return `${cd}make`;
  if (name.endsWith(".sh") || name.endsWith(".bash")) return `${cd}bash ${rel}`;
  if (name.endsWith(".c")) return `${cd}tcc -run ${rel}`;
  return null;
}

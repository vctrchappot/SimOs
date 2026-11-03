const CTRL_C = String.fromCharCode(3);
const CTRL_U = String.fromCharCode(21);

/**
 * Ends the shell on a terminal: interrupt whatever runs, clear the half-typed line, then `exit`.
 * The tty driver discards pending input when it handles ^C, so `exit` must follow after a
 * short pause or its first characters are lost. init respawns a fresh login shell afterwards.
 */
export function endShell(send: (data: string) => void, pauseMs = 250): void {
  send(CTRL_C);
  setTimeout(() => send(CTRL_U + "exit\n"), pauseMs);
}

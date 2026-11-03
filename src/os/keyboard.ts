/** PC keyboard scancodes (set 1) for the guest's PS/2 keyboard, keyed by the physical key (KeyboardEvent.code). */

const BASE: Record<string, number> = {};
const put = (codes: string[], first: number) => codes.forEach((c, i) => (BASE[c] = first + i));
put(["Escape", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0", "Minus", "Equal", "Backspace", "Tab"], 0x01);
put(["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight", "Enter", "ControlLeft"], 0x10);
put(["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote", "Backquote", "ShiftLeft", "Backslash"], 0x1e);
put(["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma", "Period", "Slash", "ShiftRight", "NumpadMultiply", "AltLeft", "Space", "CapsLock"], 0x2c);
put(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "NumLock", "ScrollLock"], 0x3b);
put(["Numpad7", "Numpad8", "Numpad9", "NumpadSubtract", "Numpad4", "Numpad5", "Numpad6", "NumpadAdd", "Numpad1", "Numpad2", "Numpad3", "Numpad0", "NumpadDecimal"], 0x47);
BASE.IntlBackslash = 0x56;
BASE.F11 = 0x57;
BASE.F12 = 0x58;

/** Keys that send 0xE0 followed by the code. */
const EXTENDED: Record<string, number> = {
  NumpadEnter: 0x1c,
  ControlRight: 0x1d,
  NumpadDivide: 0x35,
  AltRight: 0x38,
  Home: 0x47,
  ArrowUp: 0x48,
  PageUp: 0x49,
  ArrowLeft: 0x4b,
  ArrowRight: 0x4d,
  End: 0x4f,
  ArrowDown: 0x50,
  PageDown: 0x51,
  Insert: 0x52,
  Delete: 0x53,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  ContextMenu: 0x5d,
};

const SHIFTED: Record<string, string> = {
  "!": "Digit1", "@": "Digit2", "#": "Digit3", $: "Digit4", "%": "Digit5", "^": "Digit6", "&": "Digit7", "*": "Digit8", "(": "Digit9", ")": "Digit0",
  _: "Minus", "+": "Equal", "{": "BracketLeft", "}": "BracketRight", ":": "Semicolon", '"': "Quote", "~": "Backquote", "|": "Backslash",
  "<": "Comma", ">": "Period", "?": "Slash",
};
const PLAIN: Record<string, string> = {
  "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", ";": "Semicolon", "'": "Quote", "`": "Backquote", "\\": "Backslash",
  ",": "Comma", ".": "Period", "/": "Slash", " ": "Space", "\n": "Enter", "\t": "Tab",
};

/** Scancodes that type the text on a US keyboard layout (characters without a key are skipped). */
export function keysForText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    let code: string | undefined;
    let shift = false;
    if (/[a-z]/.test(ch)) code = "Key" + ch.toUpperCase();
    else if (/[A-Z]/.test(ch)) (code = "Key" + ch), (shift = true);
    else if (/[0-9]/.test(ch)) code = "Digit" + ch;
    else if (ch in PLAIN) code = PLAIN[ch];
    else if (ch in SHIFTED) (code = SHIFTED[ch]), (shift = true);
    if (!code) continue;
    if (shift) out.push(...scancodes("ShiftLeft", true)!);
    out.push(...scancodes(code, true)!, ...scancodes(code, false)!);
    if (shift) out.push(...scancodes("ShiftLeft", false)!);
  }
  return out;
}

/** The bytes for pressing or releasing a key, or null for keys a PC keyboard doesn't have. */
export function scancodes(code: string, down: boolean): number[] | null {
  const release = down ? 0 : 0x80;
  if (code in BASE) return [BASE[code] | release];
  if (code in EXTENDED) return [0xe0, EXTENDED[code] | release];
  return null;
}

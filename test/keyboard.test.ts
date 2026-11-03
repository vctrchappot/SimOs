import { describe, expect, it } from "vitest";
import { scancodes } from "@/os/keyboard";

describe("scancodes (set 1)", () => {
  it("maps common keys to the codes a PC keyboard sends", () => {
    expect(scancodes("KeyA", true)).toEqual([0x1e]);
    expect(scancodes("KeyZ", true)).toEqual([0x2c]);
    expect(scancodes("Digit1", true)).toEqual([0x02]);
    expect(scancodes("Digit0", true)).toEqual([0x0b]);
    expect(scancodes("Enter", true)).toEqual([0x1c]);
    expect(scancodes("Space", true)).toEqual([0x39]);
    expect(scancodes("ShiftLeft", true)).toEqual([0x2a]);
    expect(scancodes("F10", true)).toEqual([0x44]);
    expect(scancodes("F12", true)).toEqual([0x58]);
    expect(scancodes("Numpad0", true)).toEqual([0x52]);
  });

  it("marks a release with bit 7 and prefixes extended keys with 0xE0", () => {
    expect(scancodes("KeyA", false)).toEqual([0x9e]);
    expect(scancodes("ArrowUp", true)).toEqual([0xe0, 0x48]);
    expect(scancodes("Delete", false)).toEqual([0xe0, 0xd3]);
    expect(scancodes("ControlRight", true)).toEqual([0xe0, 0x1d]);
  });

  it("ignores keys that have no PC scancode", () => {
    expect(scancodes("MediaPlayPause", true)).toBeNull();
    expect(scancodes("", true)).toBeNull();
  });

  it("gives every key a distinct code", () => {
    const seen = new Set<string>();
    const keys = ["Escape", "Tab", "KeyQ", "KeyP", "KeyA", "KeyL", "KeyZ", "KeyM", "F1", "F9", "Numpad7", "NumpadDecimal", "Home", "End", "Insert", "NumpadEnter", "Enter"];
    for (const k of keys) seen.add(scancodes(k, true)!.join());
    expect(seen.size).toBe(keys.length);
  });
});

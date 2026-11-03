import { describe, expect, it } from "vitest";
import { OutputHistory } from "@/os/runtime/output-history";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("OutputHistory", () => {
  it("keeps output per terminal in order", () => {
    const h = new OutputHistory(3);
    h.push(0, enc("a"));
    h.push(1, enc("x"));
    h.push(0, enc("b"));
    expect(dec(h.get(0))).toBe("ab");
    expect(dec(h.get(1))).toBe("x");
    expect(dec(h.get(2))).toBe("");
  });

  it("drops the oldest output beyond the cap, even within one big chunk", () => {
    const h = new OutputHistory(1, 10);
    h.push(0, enc("12345"));
    h.push(0, enc("67890"));
    h.push(0, enc("ABC"));
    expect(dec(h.get(0))).toBe("67890ABC");
    h.push(0, enc("0123456789ABCDEF"));
    expect(dec(h.get(0))).toBe("6789ABCDEF");
  });

  it("clears one terminal or all, and ignores unknown terminals", () => {
    const h = new OutputHistory(2);
    h.push(0, enc("a"));
    h.push(1, enc("b"));
    h.clear(0);
    expect(dec(h.get(0))).toBe("");
    expect(dec(h.get(1))).toBe("b");
    h.clear();
    expect(dec(h.get(1))).toBe("");
    h.push(7, enc("x"));
    expect(h.get(7).length).toBe(0);
  });
});

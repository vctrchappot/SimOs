import { describe, expect, it } from "vitest";
import { searchProject } from "@/os/search";
import { MemoryFS } from "@/os/vfs/memory-fs";

function project() {
  const fs = new MemoryFS();
  fs.writeFile("/a.sh", "#!/bin/sh\necho Hello\necho hello again\n");
  fs.writeFile("/src/main.c", "int main(void) {\n  return 0; // hello\n}\n");
  fs.writeFile("/bin.dat", new Uint8Array([104, 101, 108, 108, 111, 0, 1, 2]));
  fs.writeFile("/node_modules/pkg/i.js", "hello from a dependency");
  fs.writeFile("/build/out.txt", "hello build");
  return fs;
}

describe("searchProject", () => {
  it("finds case-insensitive matches with 1-based positions, in path order", () => {
    const { matches } = searchProject(project(), "hello", { ignore: "build/" });
    expect(matches.map((m) => `${m.path}:${m.line}:${m.column}`)).toEqual(["/a.sh:2:6", "/a.sh:3:6", "/src/main.c:2:16"]);
    expect(matches[0].preview).toBe("echo Hello");
    expect(matches[0].preview.slice(matches[0].previewAt, matches[0].previewAt + matches[0].length)).toBe("Hello");
  });

  it("can be case sensitive", () => {
    const { matches } = searchProject(project(), "Hello", { caseSensitive: true });
    expect(matches.map((m) => m.path)).toEqual(["/a.sh"]);
  });

  it("skips binary files, node_modules and ignored paths", () => {
    const paths = new Set(searchProject(project(), "hello").matches.map((m) => m.path));
    expect(paths.has("/bin.dat")).toBe(false);
    expect(paths.has("/node_modules/pkg/i.js")).toBe(false);
    expect(paths.has("/build/out.txt")).toBe(true);
    expect(new Set(searchProject(project(), "hello", { ignore: "build/" }).matches.map((m) => m.path)).has("/build/out.txt")).toBe(false);
  });

  it("treats special characters literally unless regex mode is on", () => {
    const fs = new MemoryFS();
    fs.writeFile("/x.txt", "a.c abc (x)\n");
    expect(searchProject(fs, "a.c").matches).toHaveLength(1);
    expect(searchProject(fs, "(x)").matches).toHaveLength(1);
    expect(searchProject(fs, "a.c", { regex: true }).matches).toHaveLength(2);
    expect(searchProject(fs, "a.c|\\(x\\)", { regex: true }).matches.map((m) => m.column)).toEqual([1, 5, 9]);
  });

  it("reports invalid regexes and never loops on empty matches", () => {
    const fs = new MemoryFS();
    fs.writeFile("/x.txt", "abc\n");
    expect(searchProject(fs, "(", { regex: true }).error).toBeTruthy();
    expect(searchProject(fs, "x*", { regex: true }).matches).toEqual([]);
    expect(searchProject(fs, "").matches).toEqual([]);
  });

  it("truncates at maxResults and windows very long lines around the match", () => {
    const fs = new MemoryFS();
    fs.writeFile("/many.txt", "a\n".repeat(50));
    const r = searchProject(fs, "a", { maxResults: 10 });
    expect(r.matches).toHaveLength(10);
    expect(r.truncated).toBe(true);

    fs.writeFile("/long.txt", "x".repeat(500) + "NEEDLE" + "y".repeat(500));
    const long = searchProject(fs, "NEEDLE", { maxResults: 5 }).matches[0];
    expect(long.preview.length).toBeLessThan(200);
    expect(long.preview.slice(long.previewAt, long.previewAt + 6)).toBe("NEEDLE");
  });

  it("handles CRLF files", () => {
    const fs = new MemoryFS();
    fs.writeFile("/w.txt", "one\r\ntwo needle\r\n");
    const m = searchProject(fs, "needle").matches[0];
    expect(m.line).toBe(2);
    expect(m.preview).toBe("two needle");
  });
});

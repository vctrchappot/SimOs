import { describe, expect, it } from "vitest";
import { applyOverlay } from "@/os/overlay";
import { runCommandFor, shellQuote } from "@/os/run-command";
import { PROJECT_TEMPLATE } from "@/os/template";
import { MemoryFS } from "@/os/vfs/memory-fs";

describe("applyOverlay", () => {
  function recorder() {
    const calls: string[] = [];
    return {
      calls,
      root: {
        async write(path: string, data: Uint8Array) {
          calls.push(`write ${path} ${new TextDecoder().decode(data)}`);
        },
        async mkdir(path: string) {
          calls.push(`mkdir ${path}`);
        },
      },
    };
  }

  it("maps system/** onto the OS root, parents first", async () => {
    const fs = new MemoryFS();
    fs.writeFile("/system/etc/hostname", "box\n");
    fs.writeFile("/system/etc/rc.d/10-a.sh", "echo a");
    fs.writeFile("/other/file.txt", "ignored");
    const { calls, root } = recorder();
    const written = await applyOverlay(fs, root);
    expect(calls).toEqual([
      "mkdir /etc",
      "write /etc/hostname box\n",
      "mkdir /etc/rc.d",
      "write /etc/rc.d/10-a.sh echo a",
    ]);
    expect(written).toEqual(["/etc", "/etc/hostname", "/etc/rc.d", "/etc/rc.d/10-a.sh"]);
  });

  it("does nothing without a system folder", async () => {
    const { calls, root } = recorder();
    expect(await applyOverlay(new MemoryFS(), root)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("the project template ships a working overlay", () => {
    const fs = new MemoryFS();
    for (const [p, c] of Object.entries(PROJECT_TEMPLATE)) fs.writeFile(p, c, "init");
    expect(fs.readText("/system/etc/hostname")).toBe("my-os\n");
    expect(fs.readText("/system/etc/rc.d/10-welcome.sh")).toMatch(/^#!\/bin\/sh/);
  });
});

describe("runCommandFor", () => {
  it("picks a command by file type, typed into the project directory", () => {
    expect(runCommandFor("/hello.sh")).toBe(`cd "$PROJECT" && bash './hello.sh'`);
    expect(runCommandFor("/scripts/a b.sh")).toBe(`cd "$PROJECT" && bash './scripts/a b.sh'`);
    expect(runCommandFor("/src/main.c")).toBe(`cd "$PROJECT" && tcc -run './src/main.c'`);
    expect(runCommandFor("/Makefile")).toBe(`cd "$PROJECT" && make`);
    expect(runCommandFor(null)).toBe(`cd "$PROJECT" && make`);
    expect(runCommandFor("/README.md")).toBeNull();
  });

  it("quotes hostile file names safely", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(runCommandFor("/x'; rm -rf ~; echo '.sh")).toBe(`cd "$PROJECT" && bash './x'\\''; rm -rf ~; echo '\\''.sh'`);
  });
});

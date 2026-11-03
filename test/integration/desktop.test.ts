/**
 * Boots the graphics system for real: Alpine's linux-virt kernel, the initramfs that loads the 9p and display
 * drivers, a framebuffer device, and an X server running twm and xterm. Then types into the desktop through the
 * emulated PS/2 keyboard and VMware-style absolute mouse. Needs `npm run build:os` (with the desktop packages).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scancodes } from "@/os/keyboard";
import type { DisplayFrame } from "@/os/runtime/display";
import { alpineDesktopProfile } from "@/os/runtime/profiles";
import { PROJECT_TEMPLATE } from "@/os/template";
import { makeStudio, root } from "./harness";

const osDir = resolve(root, "public/os").replaceAll("\\", "/");
const built = existsSync(resolve(osDir, "desktop/initramfs.gz")) && existsSync(resolve(osDir, "alpine/fs.json"));
const hasX = built && readFileSync(resolve(osDir, "alpine/fs.json"), "utf8").includes("simos-desktop");

describe.skipIf(!hasX)("graphics system (framebuffer + X desktop)", () => {
  const m = makeStudio(alpineDesktopProfile(osDir), "desktop-" + Math.random(), PROJECT_TEMPLATE);
  const { studio, sh, runtime } = m;
  let off = () => {};
  /** The latest full picture, kept as it is painted. */
  let size = { w: 0, h: 0 };
  let pixels = new Uint8ClampedArray(0);

  beforeAll(async () => {
    off = runtime.onDisplay((f: DisplayFrame) => {
      if (f.kind !== "graphic") return;
      if (f.width !== size.w || f.height !== size.h) {
        size = { w: f.width, h: f.height };
        pixels = new Uint8ClampedArray(f.width * f.height * 4);
      }
      for (const r of f.rects) for (let y = 0; y < r.h; y++) pixels.set(r.data.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((r.y + y) * size.w + r.x) * 4);
    });
    await studio.init();
    await studio.start();
  }, 240_000);

  afterAll(async () => {
    off();
    await studio.stop();
  });

  const count = (rgb: number) => {
    let n = 0;
    for (let i = 0; i < pixels.length; i += 4) if (((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]) === rgb) n++;
    return n;
  };
  const until = async (cond: () => boolean | Promise<boolean>, ms: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("condition not reached in time");
  };

  it("runs Alpine's own kernel, with a framebuffer device and input devices", async () => {
    expect((await sh("uname -r")).out.trim()).toMatch(/^6\.18\./);
    const { out } = await sh("cat /proc/fb; ls /dev/fb0 /dev/dri/card0; ls /dev/input");
    expect(out).toMatch(/bochs/i);
    expect(out).toContain("/dev/fb0");
    expect(out).toMatch(/event\d/);
  });

  it("starts an X desktop with twm and xterm, painted on the display", async () => {
    try {
      await until(async () => (await sh("ps | grep -c -E '[x]term|[t]wm'")).out.trim() === "2", 400_000);
    } catch (e) {
      const diag = await sh("ps | tail -6; tail -8 /tmp/simos-desktop.log; tail -6 /tmp/Xorg.0.log; free -m");
      throw new Error(`${(e as Error).message}
${diag.out}`);
    }
    await until(() => count(0x1c2b3a) > 100_000, 60_000); // the desktop background colour
    expect(size).toEqual({ w: 1024, h: 768 });
    expect((await sh("ps | grep -c '[X]org :0'")).out.trim()).not.toBe("0");
  }, 520_000);

  it("takes keyboard input and an absolute mouse position into the X desktop", async () => {
    // Point into the xterm, click to focus it, type a command. X is slow while it is still settling, so try a few times.
    const at = { x: 250, y: 200, width: 1024, height: 768 };
    const press = (code: string) => {
      runtime.sendKeys(scancodes(code, true)!);
      runtime.sendKeys(scancodes(code, false)!);
    };
    const keys = ["KeyT", "KeyO", "KeyU", "KeyC", "KeyH", "Space", "Slash", "KeyT", "KeyM", "KeyP", "Slash", "KeyF", "KeyR", "KeyO", "KeyM", "KeyX", "Digit1", "Digit1", "Enter"];
    let created = false;
    for (let attempt = 0; attempt < 4 && !created; attempt++) {
      runtime.sendMouse(0, 0, [false, false, false], at);
      await new Promise((r) => setTimeout(r, 2000));
      runtime.sendMouse(0, 0, [true, false, false], at);
      runtime.sendMouse(0, 0, [false, false, false], at);
      await new Promise((r) => setTimeout(r, 2000));
      for (const code of keys) {
        press(code);
        await new Promise((r) => setTimeout(r, 80));
      }
      try {
        await until(async () => (await sh("ls /tmp/fromx11 2>&1")).code === 0, 25_000);
        created = true;
      } catch {
        /* focus or timing: try again */
      }
    }
    expect(created).toBe(true);
  }, 240_000);
});

// Browser smoke test: boots the real Arch Linux guest in Edge/Chrome and drives the studio UI.
// Usage: node scripts/e2e.mjs [url]
// Without a URL it serves the production build itself (run `npm run build` first).
// E2E_CHANNEL picks the browser (default msedge; CI uses chrome).
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

let server;
process.on("exit", () => server?.kill());
process.on("uncaughtException", (e) => {
  console.error(e);
  server?.kill();
  process.exit(1);
});
let url = process.argv[2];
if (!url) {
  url = "http://localhost:3123";
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3123"], { stdio: "ignore" });
  for (let i = 0; ; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) break;
    if (i > 60) throw new Error("server did not start; did you run npm run build?");
    await new Promise((r) => setTimeout(r, 500));
  }
}
const channel = process.env.E2E_CHANNEL ?? "msedge";
const log = (...a) => console.log("[e2e]", ...a);

const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on("pageerror", (e) => log("PAGE ERROR", e.message, (e.stack ?? "").slice(0, 600)));
page.on("console", (m) => m.type() === "error" && log("console.error", m.text().slice(0, 200)));

// Only the visible terminal tab counts (inactive tabs stay mounted but hidden).
const termText = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".xterm")]
      .filter((x) => x.offsetParent)
      .flatMap((x) => [...x.querySelectorAll(".xterm-rows > div")])
      .map((d) => d.textContent)
      .join("\n"),
  );
async function waitTerm(re, ms = 300000) {
  const t0 = Date.now();
  for (;;) {
    const t = await termText();
    if (re.test(t)) return t;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}\n${t}`);
    await page.waitForTimeout(500);
  }
}
async function type(cmd) {
  await page.evaluate(() => [...document.querySelectorAll(".xterm")].find((x) => x.offsetParent)?.querySelector("textarea")?.focus());
  await page.keyboard.type(cmd + "\n", { delay: 5 });
}

const t0 = Date.now();
await page.goto(url);
await waitTerm(/Your project is/);
await waitTerm(/root@my-os/);
log(`booted in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await page.screenshot({ path: ".scratch/booted.png" });

await type("echo $BASH_VERSION; uname -sr; ls");
await waitTerm(/hello\.sh/);
await type("./hello.sh browser && make run");
await waitTerm(/Hello from C on Linux/);
log("script + gcc ok");

// guest -> editor
await type("echo 'created in bash' > from-bash.txt");
await page.getByText("from-bash.txt").first().waitFor({ timeout: 10000 });
log("guest file appeared in explorer");

// editor -> guest
await page.getByText("hello.sh", { exact: true }).first().click();
await page.locator(".monaco-editor").first().waitFor();
await page.locator(".monaco-editor .view-lines").first().click({ position: { x: 300, y: 100 } });
await page.keyboard.press("Control+End");
await page.keyboard.type('echo "edited in monaco"\n');
await page.waitForTimeout(800);
await page.screenshot({ path: ".scratch/editor.png" });
await page.getByRole("button", { name: "Run file" }).click();
await waitTerm(/edited in monaco/);
log("editor edit visible to guest");
await page.screenshot({ path: ".scratch/final.png" });

// a second terminal is a second, independent shell on another serial port
await page.getByRole("button", { name: "New terminal" }).click();
await waitTerm(/Your project is/);
await type("export WHO=two; tty; echo W=$WHO");
await waitTerm(/\/dev\/ttyS1[^]*W=two/);
await page.getByRole("tab", { name: "Console" }).click();
await type("echo W=${WHO:-none}");
await waitTerm(/W=none/);
log("independent terminals ok");

// search in all files (Ctrl+Shift+F) and jump to the hit
await page.keyboard.press("Control+Shift+F");
const searchBox = page.getByLabel("Search in files");
await searchBox.waitFor();
await searchBox.fill("created in bash");
const hit = page.getByTitle("/from-bash.txt:1");
await hit.waitFor({ timeout: 5000 });
await hit.click();
await page.getByRole("tab", { name: /from-bash\.txt/ }).waitFor();
log("project search ok");

// zip export, then import of the same archive
await page.getByRole("tab", { name: "Files" }).click();
const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export zip" }).click()]);
const zipPath = ".scratch/exported.zip";
await download.saveAs(zipPath);
const head = (await import("node:fs")).readFileSync(zipPath).subarray(0, 2).toString();
if (head !== "PK") throw new Error("exported file is not a zip");
await page.locator('input[type=file]').setInputFiles(zipPath);
await page.getByText(/Imported \d+ files/).waitFor({ timeout: 5000 });
log("zip export/import ok");

// keyboard navigation in the file tree: Home, Down, F2 opens the rename box, Escape closes it
await page.getByRole("tree", { name: "Project files" }).focus();
await page.keyboard.press("Home");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("F2");
await page.locator("[role=tree] input").waitFor({ timeout: 3000 });
await page.keyboard.press("Escape");
log("explorer keyboard ok");

await page.getByRole("tab", { name: "Search" }).click();
await page.getByLabel("Search in files").fill("echo");
await page.waitForTimeout(500);
await page.screenshot({ path: ".scratch/phase3.png" });

// the display: the VGA console shows a login shell, and keys typed there reach the guest
await page.getByRole("tab", { name: "Display" }).click();
const screen = page.getByLabel("Machine display");
await screen.waitFor({ state: "visible", timeout: 20000 });
await page.waitForFunction(
  () => {
    const c = document.querySelector('canvas[aria-label="Machine display"]');
    if (!c || !c.width) return false;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 100 || d[i + 1] > 100 || d[i + 2] > 100) return true;
    return false;
  },
  null,
  { timeout: 30000 },
);
await page.screenshot({ path: ".scratch/display.png" });
await screen.click();
await page.keyboard.type("touch from-display.txt\n", { delay: 20 });
await page.waitForTimeout(3000);
await page.screenshot({ path: ".scratch/display2.png" });
await page.getByRole("tab", { name: "Console" }).click();
await page.waitForTimeout(1000); // the emulated shell is slow to echo and run it
await type("ls from-display.txt");
await waitTerm(/^from-display.txt$/m);
log("display shows the VGA console and takes keyboard input");

// build the bootable OS from the template with nasm in the guest, then boot it on a bare PC
await type("cd boot && make && cd ..");
await waitTerm(/nasm -f bin boot\.asm -o boot\.img/);
await type("ls -l boot/boot.img");
await waitTerm(/ 512 .*boot\/boot\.img/);
await page.getByRole("button", { name: "Boot image" }).click();
const bootButton = page.getByRole("dialog", { name: "Boot a disk image" }).locator("div", { hasText: "/boot/boot.img" }).getByRole("button", { name: "Boot" }).last();
await bootButton.waitFor({ timeout: 20000 });
await bootButton.click();
const serialLog = page.getByLabel("Serial output");
await serialLog.getByText(/Hello from my own operating system!/).waitFor({ timeout: 60000 });
// debugger: break where a typed letter is echoed (0x7c1a is `call putc` in boot.asm), inspect, continue
const debug = page.getByLabel("Debugger");
await debug.getByLabel("Breakpoint address").fill("0x7c1a");
await debug.getByRole("button", { name: "Add", exact: true }).click();
await screen.click();
await page.keyboard.type("a", { delay: 50 });
await debug.getByText("Stopped at breakpoint 7C1A").waitFor({ timeout: 20000 });
await debug.getByLabel("Registers").getByText(/1E61/).waitFor({ timeout: 5000 }); // ah = scancode, al = 'a'
await page.screenshot({ path: ".scratch/debugger.png" });
await debug.getByLabel("Disassembly").getByText("call 0x7c").first().waitFor({ timeout: 5000 }); // the instruction we stopped on
await debug.getByRole("button", { name: "Step" }).click();
await debug.getByLabel("Registers").getByText(/00007C1D/).waitFor({ timeout: 10000 }); // call putc was stepped over: next is jmp .key
await debug.getByRole("button", { name: "Continue" }).click();
await page.waitForFunction(() => /Type something: a$/.test(document.querySelector('[aria-label="Serial output"]')?.textContent?.trim() ?? ""), null, { timeout: 15000 });
await debug.getByRole("button", { name: "Remove breakpoint 7C1A" }).click();
await screen.click();
await page.keyboard.type("bc", { delay: 50 });
await page.waitForFunction(() => /Type something: abc/.test(document.querySelector('[aria-label="Serial output"]')?.textContent ?? ""), null, { timeout: 15000 });
await page.screenshot({ path: ".scratch/baremetal.png" });
await page.getByRole("button", { name: "Power off", exact: true }).last().click();
await page.getByRole("tab", { name: "Console" }).click();
log("bare-metal image built with nasm, booted, and typed into");

// networking is off until chosen; switch on browser fetch, restart, and fetch this very page from inside the guest
await type("echo nonet=$(grep -c simos.net /proc/cmdline)");
await waitTerm(/nonet=0/);
await page.getByRole("button", { name: /^Network: Off/ }).click();
await page.getByRole("radio", { name: /Browser fetch/ }).check();
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Restart" }).click();
await waitTerm(/\[simos\] network: eth0 192\./);
await waitTerm(/Your project is/);
const port = new URL(url).port;
await type(`wget -qO- http://${port}.external/ | head -c 300 | grep -o -i '<html'`);
await waitTerm(/<html/i);
log("guest networking ok (DHCP + HTTP through the browser)");

// persistence: reload the page, a fresh machine boots from the stored project
await page.waitForTimeout(600);
await page.reload();
await waitTerm(/Your project is/);
await type("cat from-bash.txt; tail -1 hello.sh");
await waitTerm(/created in bash[^]*edited in monaco/);
log("project recovered after reload");
// the graphics system: Alpine's own kernel with a framebuffer and an X desktop, shown on the Display tab
await page.evaluate(() => localStorage.setItem("simos.system.v1", "alpine-desktop"));
await page.reload();
const desk = page.getByLabel("Machine display");
await desk.waitFor({ state: "visible", timeout: 300000 }); // the Display tab opens by itself once the OS is up
await page.waitForFunction(
  () => {
    const c = document.querySelector('canvas[aria-label="Machine display"]');
    if (!c || c.width !== 1024) return false;
    const [r, g, b] = c.getContext("2d").getImageData(900, 700, 1, 1).data; // the desktop background
    return r === 0x1c && g === 0x2b && b === 0x3a;
  },
  null,
  { timeout: 240000 },
);
await page.screenshot({ path: ".scratch/desktop.png" });
log("graphics system: X desktop is painted on the framebuffer display (keyboard/mouse into X is covered by the Node integration test only)");
await browser.close();
log("PASS");
server?.kill();
process.exit(0);

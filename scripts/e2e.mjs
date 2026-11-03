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
page.on("pageerror", (e) => log("PAGE ERROR", e.message));
page.on("console", (m) => m.type() === "error" && log("console.error", m.text().slice(0, 200)));

const termText = () => page.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((d) => d.textContent).join("\n"));
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
  await page.locator(".xterm-helper-textarea").focus();
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

// persistence: reload the page, a fresh machine boots from the stored project
await page.waitForTimeout(600);
await page.reload();
await waitTerm(/Your project is/);
await type("cat from-bash.txt; tail -1 hello.sh");
await waitTerm(/created in bash[^]*edited in monaco/);
log("project recovered after reload");
await browser.close();
log("PASS");
server?.kill();
process.exit(0);

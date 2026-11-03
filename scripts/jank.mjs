// Measures UI responsiveness while the guest is busy: runs a CPU-heavy shell loop and reports
// the worst gap between animation frames on the page's main thread.
// Usage: node scripts/jank.mjs [url]   (default: serves the production build itself)
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

let server;
let url = process.argv[2];
if (!url) {
  url = "http://localhost:3124";
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3124"], { stdio: "ignore" });
  for (let i = 0; ; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) break;
    if (i > 60) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const term = () => page.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((d) => d.textContent).join("\n"));
async function waitTerm(re, ms = 120000) {
  const t0 = Date.now();
  while (!re.test(await term())) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + re);
    await page.waitForTimeout(250);
  }
}

await page.goto(process.env.INLINE ? url + "/?inline" : url);
await waitTerm(/root@my-os/);
await page.evaluate(() => {
  window.__gaps = [];
  let last = performance.now();
  const tick = (now) => {
    window.__gaps.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.locator(".xterm-helper-textarea").focus();
await page.keyboard.type("i=0; while [ $i -lt 40000 ]; do i=$((i+1)); done; echo LOOP''DONE\n", { delay: 2 });
await waitTerm(/LOOPDONE/, 180000);
const gaps = await page.evaluate(() => window.__gaps);
const sorted = [...gaps].sort((a, b) => a - b);
console.log(
  JSON.stringify({
    frames: gaps.length,
    maxGapMs: Math.round(sorted.at(-1)),
    p95GapMs: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
    over100ms: gaps.filter((g) => g > 100).length,
  }),
);
await browser.close();
server?.kill();
process.exit(0);

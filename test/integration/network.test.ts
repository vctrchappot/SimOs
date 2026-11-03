/**
 * Boots the Alpine image with the browser-fetch network and talks to a real HTTP server on the
 * host through the guest's own network stack: virtio NIC -> DHCP (udhcpc) -> DNS -> TCP -> HTTP.
 */
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alpineProfile } from "@/os/runtime/profiles";
import { PROJECT_TEMPLATE } from "@/os/template";
import { makeStudio, root } from "./harness";

const osDir = resolve(root, "public/os").replaceAll("\\", "/");
const built = existsSync(resolve(osDir, "alpine/fs.json"));

describe.skipIf(!built)("guest networking (browser fetch)", () => {
  const seen: string[] = [];
  let server: Server;
  let port = 0;
  let m: ReturnType<typeof makeStudio>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.host}`);
      res.setHeader("content-type", "text/plain");
      res.end("hello from the host\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    m = makeStudio(
      { ...alpineProfile(osDir), network: { mode: "fetch", relayUrl: "" } },
      "net-" + Math.random(),
      PROJECT_TEMPLATE,
    );
    await m.studio.init();
    await m.studio.start();
  }, 170_000);

  afterAll(async () => {
    await m?.studio.stop();
    server?.close();
  });

  it("brings eth0 up through DHCP during boot", async () => {
    expect(m.bootLog()).toMatch(/\[simos\] network: eth0 192\.168\.\d+\.\d+/);
    const { out } = await m.sh("ip addr show eth0; ip route; cat /etc/resolv.conf");
    expect(out).toMatch(/inet 192\.168\.\d+\.\d+/);
    expect(out).toMatch(/default via/);
    expect(out).toMatch(/nameserver/);
  });

  it("fetches a page from a server on the host", async () => {
    const { out, code } = await m.sh(`wget -qO- http://${port}.external/some/path?q=1`, 40_000);
    expect(code).toBe(0);
    expect(out.trim()).toBe("hello from the host");
    expect(seen).toContain(`GET /some/path?q=1 localhost:${port}`);
  });

  it("reports failures like a real network would", async () => {
    const { code } = await m.sh("wget -qO- http://127.0.0.1:1/ -T 3", 20_000);
    expect(code).not.toBe(0);
  });
});

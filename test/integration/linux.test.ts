/**
 * Boots a real Linux kernel (Buildroot, i686) on the v86 emulator inside Node and verifies the
 * editor <-> OS bridge end to end: real shell commands, real files, real persistence.
 *
 * The kernel image is downloaded once into .cache/ (10 MB).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildrootProfile } from "@/os/runtime/profiles";
import { makeStudio as make, root } from "./harness";

const kernel = resolve(root, ".cache/buildroot-bzimage68.bin");
// The Buildroot image mounts the host 9p share at /mnt; the host's /project is /mnt/project.
const profile = { ...buildrootProfile(kernel), projectDir: "/project" };
const guestDir = "/mnt/project";
const template = { "/hello.sh": 'echo "hello from $(uname -s)"\n', "/lib/data.txt": "v1\n" };

beforeAll(async () => {
  if (existsSync(kernel)) return;
  mkdirSync(resolve(root, ".cache"), { recursive: true });
  const res = await fetch("https://i.copy.sh/buildroot-bzimage68.bin");
  writeFileSync(kernel, Buffer.from(await res.arrayBuffer()));
}, 120_000);

const makeStudio = (db: string) => make(profile, db, template);

describe("real Linux guest", () => {
  const dbName = "integration-" + Math.random();
  let a: ReturnType<typeof makeStudio>;

  beforeAll(async () => {
    a = makeStudio(dbName);
    await a.studio.init();
    await a.studio.start();
  }, 90_000);

  afterAll(async () => {
    await a.studio.stop();
  });

  it("boots a real kernel", async () => {
    expect(a.runtime.status).toBe("running");
    const { out, code } = await a.sh("uname -sm");
    expect(code).toBe(0);
    expect(out).toContain("Linux i686");
  });

  it("runs a script written in the editor with the real shell", async () => {
    const { out, code } = await a.sh(`sh ${guestDir}/hello.sh`);
    expect(code).toBe(0);
    expect(out.trim()).toBe("hello from Linux");
  });

  it("shows editor edits to already-read files immediately (no stale guest cache)", async () => {
    expect((await a.sh(`cat ${guestDir}/lib/data.txt`)).out.trim()).toBe("v1");
    a.studio.fs.writeFile("/lib/data.txt", "v2 edited in the editor\n", "editor");
    await a.studio.settle();
    expect((await a.sh(`cat ${guestDir}/lib/data.txt`)).out.trim()).toBe("v2 edited in the editor");
  });

  it("supports pipes, redirection, variables and scripts created from the terminal", async () => {
    const { out, code } = await a.sh(
      `cd ${guestDir} && X=world && printf 'b\\na\\nc\\n' | sort > sorted.txt && echo "hi $X" >> sorted.txt && cat sorted.txt | tr '\\n' ' '`,
    );
    expect(code).toBe(0);
    expect(out.trim()).toBe("a b c hi world");
    expect((await a.sh("false")).code).toBe(1);
    expect((await a.sh("nonexistent-command-xyz")).code).toBe(127);
  });

  it("imports files created by the guest into the editor's filesystem", async () => {
    await a.sh(`cd ${guestDir} && mkdir -p out/deep && echo '#!/bin/sh' > out/deep/run.sh && echo 'echo ran' >> out/deep/run.sh && chmod +x out/deep/run.sh`);
    await a.studio.settle();
    await a.studio["sync"]!.poll();
    expect(a.studio.fs.readText("/out/deep/run.sh")).toBe("#!/bin/sh\necho ran\n");
    expect(a.studio.fs.readText("/sorted.txt")).toBe("a\nb\nc\nhi world\n");
  });

  it("imports in-place edits and deletions made in the guest", async () => {
    await a.sh(`cd ${guestDir} && echo changed-in-shell > lib/data.txt && rm hello.sh`);
    await a.studio["sync"]!.poll();
    expect(a.studio.fs.readText("/lib/data.txt")).toBe("changed-in-shell\n");
    expect(a.studio.fs.exists("/hello.sh")).toBe(false);
  });

  it("delivers editor renames and deletes to the guest", async () => {
    a.studio.fs.writeFile("/tmp/x.txt", "x", "editor");
    a.studio.fs.rename("/tmp", "/moved", "editor");
    a.studio.fs.remove("/sorted.txt", "editor");
    a.studio.fs.writeFile("/tree/a/b/c.txt", "deep", "editor");
    a.studio.fs.writeFile("/tree/top.txt", "top", "editor");
    await a.studio.settle();
    expect((await a.sh(`cat ${guestDir}/tree/a/b/c.txt`)).out.trim()).toBe("deep");
    a.studio.fs.remove("/tree", "editor");
    await a.studio.settle();
    expect((await a.sh(`cat ${guestDir}/moved/x.txt`)).out.trim()).toBe("x");
    expect((await a.sh(`test -e ${guestDir}/tmp`)).code).not.toBe(0);
    expect((await a.sh(`test -e ${guestDir}/sorted.txt`)).code).not.toBe(0);
    expect((await a.sh(`test -e ${guestDir}/tree`)).code).not.toBe(0);
    expect(a.studio.syncErrors).toEqual([]);
  });

  it("restart keeps the project, power-cycling the OS", async () => {
    a.studio.fs.writeFile("/persist.txt", "still here\n", "editor");
    await a.studio.restart();
    expect(a.runtime.status).toBe("running");
    expect((await a.sh(`cat ${guestDir}/persist.txt`)).out.trim()).toBe("still here");
    expect((await a.sh(`cat ${guestDir}/lib/data.txt`)).out.trim()).toBe("changed-in-shell");
  }, 90_000);

  it("recovers the project from IndexedDB in a brand-new session", async () => {
    await a.sh(`echo from-the-last-session > ${guestDir}/last.txt`);
    await a.studio.stop(); // pulls guest edits in, persists, powers off

    const b = makeStudio(dbName); // same database, fresh machine and memory
    await b.studio.init();
    expect(b.studio.fs.readText("/persist.txt")).toBe("still here\n");
    expect(b.studio.fs.readText("/last.txt")).toBe("from-the-last-session\n");
    await b.studio.start();
    expect((await b.sh(`cat ${guestDir}/last.txt`)).out.trim()).toBe("from-the-last-session");
    await b.studio.stop();
    a = b;
  }, 120_000);

  it("reset restores the template", async () => {
    await a.studio.reset();
    expect(a.studio.fs.list().map((e) => e.path)).toEqual(["/hello.sh", "/lib", "/lib/data.txt"]);
    expect(a.runtime.status).toBe("stopped");
  });
});

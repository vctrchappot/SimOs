/**
 * Boots the actual product image (Linux kernel -> stage-1 handover -> Alpine init -> GNU bash)
 * on the emulator in Node and drives it like a user would. Requires `npm run build:os`.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alpineProfile } from "@/os/runtime/profiles";
import { PROJECT_TEMPLATE } from "@/os/template";
import { makeStudio, root } from "./harness";

const osDir = resolve(root, "public/os").replace(/\\/g, "/");
const built = existsSync(resolve(osDir, "alpine/fs.json"));
const guestDir = "/root/project";

describe.skipIf(!built)("Alpine Linux with bash", () => {
  const profile = alpineProfile(osDir);
  const m = makeStudio(profile, "alpine-" + Math.random(), PROJECT_TEMPLATE);
  const { studio, sh } = m;

  beforeAll(async () => {
    await studio.init();
    await studio.start();
  }, 170_000);

  afterAll(async () => {
    await studio.stop();
  });

  it("boots Alpine with its own init and lands in bash in the project directory", async () => {
    expect(m.runtime.status).toBe("running");
    expect((await sh("echo $BASH_VERSION")).out.trim()).toMatch(/^5\./);
    expect((await sh("pwd")).out.trim()).toBe(guestDir);
    expect((await sh("cat /etc/alpine-release; uname -sm; ps -o pid,args | head -3")).out).toMatch(/Linux i686[\s\S]*1 .*init/);
  });

  it("has the template project, with executable scripts", async () => {
    const { out } = await sh("ls");
    for (const f of ["README.md", "hello.sh", "hello.c", "Makefile", "scripts"]) expect(out).toContain(f);
    expect((await sh("./hello.sh tester")).out).toMatch(/Hello, tester! Running Linux .* as root\./);
    expect((await sh("./scripts/sysinfo.sh")).out).toMatch(/shell\s+: 5\./);
  });

  it("compiles and runs C with the installed toolchain", async () => {
    const r = await sh("make run", 60_000);
    expect(r.out).toContain("Hello from C on Linux");
    expect(r.code).toBe(0);
  });

  it("uses bash features: pipes, redirection, variables, functions, arrays, subshells", async () => {
    const r = await sh(
      `f() { echo "$1-$2"; }; arr=(c a b); printf '%s\\n' "\${arr[@]}" | sort > sorted.txt; echo "$(f x y) $(wc -l < sorted.txt) $(tr -d '\\n' < sorted.txt)"; (exit 3); echo rc=$?`,
    );
    expect(r.out).toContain("x-y 3 abc");
    expect(r.out).toContain("rc=3");
    expect((await sh("[[ -f sorted.txt && abc == a* ]] && echo yes")).out).toContain("yes");
  });

  it("persists shell environment between commands but not between boots", async () => {
    await sh("export FOO=bar");
    expect((await sh("echo $FOO")).out.trim()).toBe("bar");
  });

  it("edits made in the editor run immediately; scripts made in the shell show up in the editor", async () => {
    studio.fs.writeFile("/hello.sh", '#!/bin/bash\necho "v2 from editor"\n', "editor");
    await studio.settle();
    expect((await sh("./hello.sh")).out.trim()).toBe("v2 from editor");

    await sh(`printf '#!/bin/bash\\necho made in shell\\n' > tool.sh && chmod +x tool.sh`);
    await studio["sync"]!.poll();
    expect(studio.fs.readText("/tool.sh")).toBe("#!/bin/bash\necho made in shell\n");
    expect(studio.syncErrors).toEqual([]);
  });

  it("detects same-size edits made in the guest and keeps node_modules and ignored build output out of the editor", async () => {
    await sh("printf aaa > same.txt");
    await studio["sync"]!.poll();
    expect(studio.fs.readText("/same.txt")).toBe("aaa");
    await sh("printf bbb > same.txt");
    await studio["sync"]!.poll();
    expect(studio.fs.readText("/same.txt")).toBe("bbb");

    await sh("mkdir -p node_modules/pkg && echo x > node_modules/pkg/index.js && make hello >/dev/null && cp hello other.o");
    await studio["sync"]!.poll();
    expect(studio.fs.exists("/node_modules")).toBe(false);
    expect(studio.fs.exists("/hello")).toBe(false); // listed in the template's .simosignore
    expect(studio.fs.exists("/other.o")).toBe(false);
    expect((await sh("ls node_modules/pkg")).out.trim()).toBe("index.js"); // still there in the OS
  });

  it("offers independent terminals: separate shells on ttyS1..3, closable with a fresh shell afterwards", async () => {
    const seen = new Map<number, string>();
    m.runtime.onOutput((d, t) => seen.set(t, (seen.get(t) ?? "") + new TextDecoder().decode(d)));
    const until = async (t: number, re: RegExp) => {
      for (let i = 0; i < 600; i++) {
        if (re.test(seen.get(t) ?? "")) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`terminal ${t} never matched ${re}: ${seen.get(t)}`);
    };
    // Terminals 1-3 already have a login shell waiting (replayed from history).
    expect(new TextDecoder().decode(m.runtime.history(2))).toContain("Your project is");

    m.runtime.sendInput("export WHO=second; tty; echo W=$WHO\n", 2);
    await until(2, /\/dev\/ttyS2[\s\S]*W=second/);
    expect((await sh("tty; echo W=${WHO:-none}")).out).toMatch(/\/dev\/ttyS0\s+W=none/);

    seen.set(2, "");
    m.runtime.closeTerminal(2);
    await until(2, /Your project is/); // a brand-new login shell
    m.runtime.sendInput("echo W=${WHO:-fresh}\n", 2);
    await until(2, /W=fresh/);
    expect(seen.get(1) ?? "").not.toContain("W=");
  }, 90_000);

  it("applies the system overlay at boot: hostname, boot services and login-shell config", async () => {
    expect(m.bootLog()).toContain("[simos] starting 10-welcome.sh");
    expect(m.bootLog()).toContain("welcome service: starting on my-os");
    expect((await sh("cat /etc/hostname; hostname; cat /run/welcome")).out).toMatch(/^my-os\nmy-os\nbooted /);
    expect((await sh("type ll")).out).toContain("ls -alF");
  });

  it("edits to the overlay take effect after a restart, and runtime changes outside it do not survive", async () => {
    await sh("echo ephemeral > /etc/ephemeral");
    studio.fs.writeFile("/system/etc/rc.d/20-second.sh", "#!/bin/sh\necho second service v2\n", "editor");
    studio.fs.writeFile("/system/etc/hostname", "renamed\n", "editor");
    await studio.restart();
    expect(m.bootLog()).toContain("[simos] starting 20-second.sh");
    expect(m.bootLog()).toContain("second service v2");
    expect((await sh("hostname; test -e /etc/ephemeral && echo leaked")).out.trim()).toBe("renamed");
  }, 170_000);

  it("keeps the project across a power cycle and a new session", async () => {
    studio.fs.writeFile("/note.txt", "survives\n", "editor");
    await studio.restart();
    expect((await sh("cat note.txt tool.sh | head -2")).out).toContain("survives");
    expect((await sh("echo ${FOO:-unset}")).out.trim()).toBe("unset"); // a real reboot
  }, 170_000);
});

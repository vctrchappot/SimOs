/**
 * The agent's tools against the real thing: the Linux system boots, and the agent writes a program, builds and
 * runs it with run_command, and sees what it produced. A scripted "model" stands in for a provider.
 * Requires `npm run build:os`.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgent } from "@/os/agent/agent";
import { createTools, type AgentEnvironment } from "@/os/agent/tools";
import type { AgentMessage, ChatProvider, ProviderResponse } from "@/os/agent/types";
import { alpineProfile } from "@/os/runtime/profiles";
import { PROJECT_TEMPLATE } from "@/os/template";
import { makeStudio, root } from "./harness";

const osDir = resolve(root, "public/os").replaceAll("\\", "/");
const built = existsSync(resolve(osDir, "alpine/fs.json"));

describe.skipIf(!built)("coding agent on the real system", () => {
  const m = makeStudio(alpineProfile(osDir), "agent-" + Math.random(), PROJECT_TEMPLATE);
  const { studio, runtime } = m;

  beforeAll(async () => {
    await studio.init();
    await studio.start();
  }, 170_000);

  afterAll(async () => {
    await studio.stop();
  });

  const env = (): AgentEnvironment =>
    ({
      fs: studio.fs,
      linux: runtime,
      settle: () => studio.settle(),
      pull: () => studio.pull(),
      openFile: () => {},
      image: { status: "stopped", imageName: null },
    }) as unknown as AgentEnvironment;

  it("runs commands with exit status, multi-line scripts and quotes intact", async () => {
    const run = createTools(env()).find((t) => t.spec.name === "run_command")!.run;
    expect(await run({ command: "echo hello; false" })).toMatch(/hello\n\[exit status 1\]/);
    const out = await run({ command: "cd /tmp\nx='a \"b\" $HOME'\ncat <<'EOF'\nline $x\nEOF\npwd" });
    expect(out).toContain("line $x");
    expect(out).toContain("/tmp");
    expect(await run({ command: "pwd" })).toContain("/tmp"); // the shell keeps its state
    await run({ command: "cd /root/project" });
    expect(await run({ command: "sleep 30", timeout_seconds: 1 })).toMatch(/interrupted/);
    expect(await run({ command: "echo still alive" })).toMatch(/still alive/); // and it is usable afterwards
  }, 120_000);

  it("writes a C program, builds it, runs it and finds the result", async () => {
    const replies: Array<Partial<ProviderResponse>> = [
      { toolCalls: [{ id: "1", name: "write_file", input: { path: "/agent.c", content: '#include <stdio.h>\nint main(void){ puts("agent was here"); return 0; }\n' } }] },
      { toolCalls: [{ id: "2", name: "run_command", input: { command: "tcc agent.c -o agent && ./agent > out.txt; cat out.txt", timeout_seconds: 120 } }] },
      { toolCalls: [{ id: "3", name: "read_file", input: { path: "/out.txt" } }] },
      { text: "Built and ran it." },
    ];
    let i = 0;
    const provider: ChatProvider = { complete: async () => ({ text: "", toolCalls: [], truncated: false, ...replies[i++] }) };
    const history: AgentMessage[] = [{ role: "user", content: "write and run a C program" }];
    const answer = await runAgent(history, { provider, tools: createTools(env()), system: "", mode: "all", approve: async () => true });
    expect(answer).toBe("Built and ran it.");
    const results = history.filter((h) => h.role === "tool") as Array<{ content: string; isError?: boolean }>;
    expect(results.filter((r) => r.isError).map((r) => r.content)).toEqual([]);
    expect(results[1].content).toContain("agent was here");
    expect(results[1].content).toContain("[exit status 0]");
    expect(results[2].content).toContain("agent was here"); // out.txt came back from the OS into the project
  }, 240_000);
});

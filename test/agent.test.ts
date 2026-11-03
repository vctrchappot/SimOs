import { describe, expect, it, vi } from "vitest";
import { MAX_COMMAND_CHARS, GuestShell } from "@/os/agent/exec";
import { needsApproval, repairHistory, runAgent, truncate } from "@/os/agent/agent";
import { createProvider, normalizeBaseUrl, toAnthropicMessages, toOpenAIMessages, validateConfig, ProviderError } from "@/os/agent/providers";
import { createTools, type AgentEnvironment } from "@/os/agent/tools";
import type { AgentMessage, AgentTool, ChatProvider, ProviderResponse, ToolCall } from "@/os/agent/types";
import { keysForText, scancodes } from "@/os/keyboard";
import { frameText } from "@/os/runtime/cp437";
import { MemoryFS } from "@/os/vfs/memory-fs";

const call = (id: string, name: string, input: Record<string, unknown> = {}): ToolCall => ({ id, name, input });

function scripted(...replies: Array<Partial<ProviderResponse>>): ChatProvider & { seen: AgentMessage[][] } {
  const seen: AgentMessage[][] = [];
  let i = 0;
  return {
    seen,
    async complete(req) {
      seen.push(structuredClone(req.messages));
      const r = replies[Math.min(i++, replies.length - 1)];
      return { text: "", toolCalls: [], truncated: false, ...r };
    },
  };
}

const tool = (name: string, risk: AgentTool["spec"]["risk"], run: AgentTool["run"] = async () => "ok"): AgentTool => ({
  spec: { name, risk, description: name, inputSchema: { type: "object", properties: {} } },
  run,
});

describe("provider gateway", () => {
  it("only accepts https, or http on this machine", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeBaseUrl("http://api.example.com")).toBeNull();
    expect(normalizeBaseUrl("https://user:pw@api.example.com")).toBeNull();
    expect(normalizeBaseUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBaseUrl("nonsense")).toBeNull();
  });

  it("validates the settings", () => {
    const ok = { kind: "anthropic" as const, baseUrl: "https://api.anthropic.com", model: "m", apiKey: "k" };
    expect(validateConfig(ok)).toBeNull();
    expect(validateConfig({ ...ok, apiKey: "" })).toMatch(/key/i);
    expect(validateConfig({ ...ok, model: " " })).toMatch(/model/i);
    expect(validateConfig({ ...ok, baseUrl: "http://evil.example" })).toMatch(/https/);
    // a local model server needs no key
    expect(validateConfig({ kind: "openai", baseUrl: "http://localhost:11434/v1", model: "llama", apiKey: "" })).toBeNull();
  });

  it("talks the Anthropic Messages API, with the key only in the request header", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      void init;
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "Hi" }, { type: "tool_use", id: "t1", name: "list_files", input: { path: "/" } }], stop_reason: "tool_use" }),
        { status: 200 },
      );
    });
    const provider = createProvider({ kind: "anthropic", baseUrl: "https://api.anthropic.com/", model: "claude-x", apiKey: "sk-secret" }, fetchImpl as unknown as typeof fetch);
    const r = await provider.complete({ system: "sys", messages: [{ role: "user", content: "hello" }], tools: [tool("list_files", "read").spec] });
    expect(r).toEqual({ text: "Hi", toolCalls: [{ id: "t1", name: "list_files", input: { path: "/" } }], truncated: false });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-secret");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("claude-x");
    expect(body.system).toBe("sys");
    expect(body.tools[0]).toMatchObject({ name: "list_files", input_schema: expect.any(Object) });
    expect(init!.body as string).not.toContain("sk-secret");
  });

  it("talks the OpenAI chat completions API", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      void init;
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"/a"}' } }] } }] }),
        { status: 200 },
      );
    });
    const provider = createProvider({ kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "m", apiKey: "k" }, fetchImpl as unknown as typeof fetch);
    const r = await provider.complete({ system: "sys", messages: [{ role: "user", content: "x" }], tools: [tool("read_file", "read").spec] });
    expect(r.toolCalls).toEqual([{ id: "c1", name: "read_file", input: { path: "/a" } }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(init!.body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.tools[0].function.name).toBe("read_file");
  });

  it("survives broken tool arguments from a model", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "x", arguments: "{oops" } }] } }] }), { status: 200 });
    const provider = createProvider({ kind: "openai", baseUrl: "https://h.example/v1", model: "m", apiKey: "k" }, fetchImpl as unknown as typeof fetch);
    const r = await provider.complete({ system: "", messages: [], tools: [] });
    expect(r.toolCalls[0].input).toHaveProperty("__invalid_arguments");
  });

  it("explains failures without leaking the key", async () => {
    const provider = createProvider({ kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "m", apiKey: "sk-secret" }, (async () =>
      new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })) as unknown as typeof fetch);
    await expect(provider.complete({ system: "", messages: [], tools: [] })).rejects.toThrow(/401: invalid x-api-key/);
    const offline = createProvider({ kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "m", apiKey: "sk-secret" }, (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    const err = await offline.complete({ system: "", messages: [], tools: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/CORS/);
    expect(err.message).not.toContain("sk-secret");
  });

  it("merges tool results into one user message for Anthropic, one message each for OpenAI", () => {
    const history: AgentMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [call("a", "x"), call("b", "y")] },
      { role: "tool", callId: "a", name: "x", content: "1" },
      { role: "tool", callId: "b", name: "y", content: "2", isError: true },
    ];
    const a = toAnthropicMessages(history) as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(a).toHaveLength(3);
    expect(a[2].role).toBe("user");
    expect(a[2].content.map((b) => b.tool_use_id)).toEqual(["a", "b"]);
    expect(a[2].content[1].is_error).toBe(true);
    const o = toOpenAIMessages("sys", history) as Array<Record<string, unknown>>;
    expect(o.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
  });
});

describe("agent loop", () => {
  const base = { system: "s", mode: "all" as const, approve: async () => true };

  it("runs tools until the model answers", async () => {
    const run = vi.fn(async () => "file list");
    const provider = scripted({ toolCalls: [call("1", "list_files")] }, { text: "Done." });
    const history: AgentMessage[] = [{ role: "user", content: "look" }];
    const events: string[] = [];
    const answer = await runAgent(history, { ...base, provider, tools: [tool("list_files", "read", run)], onEvent: (e) => events.push(e.type) });
    expect(answer).toBe("Done.");
    expect(run).toHaveBeenCalledOnce();
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(provider.seen[1].at(-1)).toMatchObject({ role: "tool", content: "file list" });
    expect(events).toEqual(["tool-start", "tool-result", "assistant"]);
  });

  it("reports unknown tools and thrown errors to the model instead of failing", async () => {
    const provider = scripted({ toolCalls: [call("1", "nope"), call("2", "boom")] }, { text: "ok" });
    const history: AgentMessage[] = [{ role: "user", content: "x" }];
    await runAgent(history, {
      ...base,
      provider,
      tools: [
        tool("boom", "read", async () => {
          throw new Error("disk on fire");
        }),
      ],
    });
    const results = history.filter((m) => m.role === "tool") as Array<{ content: string; isError?: boolean }>;
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0].content).toMatch(/Unknown tool "nope"/);
    expect(results[1]).toMatchObject({ isError: true, content: "disk on fire" });
  });

  it("asks according to the mode, and always before dangerous tools", async () => {
    expect(needsApproval("ask", "read")).toBe(false);
    expect(needsApproval("ask", "write")).toBe(true);
    expect(needsApproval("ask", "exec")).toBe(true);
    expect(needsApproval("project", "write")).toBe(false);
    expect(needsApproval("project", "machine")).toBe(true);
    expect(needsApproval("project", "exec")).toBe(false);
    expect(needsApproval("all", "write")).toBe(false);
    expect(needsApproval("all", "machine")).toBe(false);
    for (const mode of ["ask", "project", "all"] as const) expect(needsApproval(mode, "danger")).toBe(true);
  });

  it("does not run a tool the user denied, and tells the model", async () => {
    const run = vi.fn(async () => "deleted");
    const provider = scripted({ toolCalls: [call("1", "delete_path")] }, { text: "ok, not deleting" });
    const history: AgentMessage[] = [{ role: "user", content: "clean up" }];
    const approve = vi.fn(async () => false);
    await runAgent(history, { ...base, provider, approve, tools: [tool("delete_path", "danger", run)] });
    expect(approve).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(history.find((m) => m.role === "tool")).toMatchObject({ isError: true, content: expect.stringMatching(/declined/) });
  });

  it("stops after the step limit", async () => {
    const provider = scripted({ toolCalls: [call("1", "t")] });
    const history: AgentMessage[] = [{ role: "user", content: "loop" }];
    const text = await runAgent(history, { ...base, provider, tools: [tool("t", "read")], maxSteps: 3 });
    expect(text).toMatch(/Stopped after 3 steps/);
    expect(provider.seen).toHaveLength(3);
  });

  it("can be aborted, and the history can be repaired afterwards", async () => {
    const ctl = new AbortController();
    const provider = scripted({ toolCalls: [call("1", "a"), call("2", "b")] });
    const history: AgentMessage[] = [{ role: "user", content: "x" }];
    const run = vi.fn(async () => {
      ctl.abort();
      return "ok";
    });
    await expect(runAgent(history, { ...base, provider, signal: ctl.signal, tools: [tool("a", "read", run), tool("b", "read", run)] })).rejects.toThrow("Stopped");
    expect(run).toHaveBeenCalledOnce();
    repairHistory(history);
    const ids = history.filter((m) => m.role === "tool").map((m) => (m as { callId: string }).callId);
    expect(ids).toEqual(["1", "2"]);
  });

  it("cuts long tool output in the middle", () => {
    const text = "a".repeat(100) + "b".repeat(100);
    const cut = truncate(text, 50);
    expect(cut.length).toBeLessThan(120);
    expect(cut.startsWith("a")).toBe(true);
    expect(cut.endsWith("b")).toBe(true);
    expect(cut).toMatch(/left out/);
    expect(truncate("short", 50)).toBe("short");
  });
});

describe("guest shell", () => {
  /** A console that behaves like the markers promise: it runs the line "for real" by echoing what printf would. */
  function fakeConsole(result: (command: string) => { out: string; code: number }) {
    const listeners = new Set<(d: Uint8Array, t: number) => void>();
    const sent: string[] = [];
    return {
      sent,
      onOutput(cb: (d: Uint8Array, t: number) => void) {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
      sendInput(data: string) {
        sent.push(data);
        const m = data.match(/printf 'B%sB\\n' (\w+); eval "\$\(echo (\S+) \| base64 -d\)"/);
        if (!m) return;
        const command = Buffer.from(m[2], "base64").toString("utf8");
        const r = result(command);
        const text = `$ ${data}\r\nB${m[1]}B\r\n${r.out}\r\nE${m[1]}E:${r.code}\r\n`;
        setTimeout(() => listeners.forEach((l) => l(new TextEncoder().encode(text), 0)), 5);
      },
    };
  }

  it("returns output and exit status, sending the command base64-encoded", async () => {
    const con = fakeConsole((c) => ({ out: `ran: ${c}`, code: 3 }));
    const r = await new GuestShell(con).run("echo 'quoted \"x\"'\nls");
    expect(r).toEqual({ output: "ran: echo 'quoted \"x\"'\nls", code: 3 });
    expect(con.sent[0]).not.toContain("quoted");
  });

  it("refuses commands that would overflow the terminal line", async () => {
    const con = fakeConsole(() => ({ out: "", code: 0 }));
    await expect(new GuestShell(con).run("x".repeat(MAX_COMMAND_CHARS))).rejects.toThrow(/too long/);
  });

  it("interrupts a command that does not finish", async () => {
    const con = { onOutput: () => () => {}, sent: [] as string[], sendInput(d: string) { this.sent.push(d); } };
    const r = await new GuestShell(con).run("sleep 100", 60);
    expect(r.code).toBeNull();
    expect(con.sent.at(-1)).toBe(String.fromCharCode(3));
  });

  it("runs commands one after the other", async () => {
    const order: string[] = [];
    const con = fakeConsole((c) => {
      order.push(c);
      return { out: c, code: 0 };
    });
    const shell = new GuestShell(con);
    const [a, b] = await Promise.all([shell.run("one"), shell.run("two")]);
    expect([a.output, b.output]).toEqual(["one", "two"]);
    expect(order).toEqual(["one", "two"]);
  });
});

describe("keyboard text and screen text", () => {
  it("types text on a US layout, shifting where needed", () => {
    const down = (c: string) => scancodes(c, true)![0];
    const up = (c: string) => scancodes(c, false)![0];
    expect(keysForText("a")).toEqual([down("KeyA"), up("KeyA")]);
    expect(keysForText("A")).toEqual([down("ShiftLeft"), down("KeyA"), up("KeyA"), up("ShiftLeft")]);
    expect(keysForText("1\n")).toEqual([down("Digit1"), up("Digit1"), down("Enter"), up("Enter")]);
    expect(keysForText("?")).toEqual([down("ShiftLeft"), down("Slash"), up("Slash"), up("ShiftLeft")]);
    expect(keysForText("é")).toEqual([]);
  });

  it("reads a VGA text frame as lines", () => {
    const cols = 6;
    const rows = 3;
    const chars = new Uint8Array(cols * rows).fill(32);
    "Hi".split("").forEach((c, i) => (chars[i] = c.charCodeAt(0)));
    chars[cols + 1] = 0xc9; // ╔
    const frame = { kind: "text" as const, cols, rows, chars, fg: new Uint32Array(cols * rows), bg: new Uint32Array(cols * rows), cursor: { row: 0, col: 0, visible: true } };
    expect(frameText(frame)).toEqual(["Hi", " ╔"]);
  });
});

describe("agent tools", () => {
  function setup() {
    const fs = new MemoryFS();
    fs.writeFile("/hello.c", "int main() {\n  return 0;\n}\n");
    fs.writeFile("/src/a.txt", "alpha\nbeta\n");
    const settle = vi.fn(async () => {});
    const opened: string[] = [];
    const env = {
      fs,
      settle,
      pull: async () => {},
      openFile: (p: string) => opened.push(p),
      linux: { status: "stopped" },
      image: { status: "stopped", imageName: null },
      network: () => ({ mode: "off", relayUrl: "" }),
      setNetwork: vi.fn(),
      bootImages: () => ["/boot/boot.img"],
      breakpoints: () => [0x7c1a],
      debugState: () => ({ paused: false, hit: null }),
    } as unknown as AgentEnvironment;
    const tools = new Map(createTools(env).map((t) => [t.spec.name, t]));
    const run = (name: string, input: Record<string, unknown> = {}) => tools.get(name)!.run(input);
    return { fs, run, tools, settle, opened, env };
  }

  it("has a risk class for every tool, and deletes and network changes are dangerous", () => {
    const { tools } = setup();
    expect(tools.get("delete_path")!.spec.risk).toBe("danger");
    expect(tools.get("set_network")!.spec.risk).toBe("danger");
    expect(tools.get("run_command")!.spec.risk).toBe("exec");
    expect(tools.get("read_file")!.spec.risk).toBe("read");
    expect(tools.get("write_file")!.spec.risk).toBe("write");
    expect(tools.get("boot_image")!.spec.risk).toBe("machine");
    for (const t of tools.values()) expect(t.spec.description.length).toBeGreaterThan(10);
  });

  it("lists, reads and searches the project", async () => {
    const { run } = setup();
    expect(await run("list_files")).toContain("/hello.c  (");
    expect(await run("list_files", { path: "/src" })).toBe("/src/a.txt  (11 bytes)");
    expect(await run("read_file", { path: "/hello.c", start_line: 2, end_line: 2 })).toBe("2\t  return 0;");
    expect(await run("search_files", { query: "beta" })).toBe("/src/a.txt:2: beta");
    expect(await run("search_files", { query: "zzz" })).toBe("No matches.");
    await expect(run("read_file", { path: "hello.c" })).rejects.toThrow(/absolute/);
    await expect(run("read_file", { path: "/missing" })).rejects.toThrow(/not a file/);
  });

  it("writes and edits files, and lets the OS see them", async () => {
    const { fs, run, settle, opened } = setup();
    await run("write_file", { path: "/new/dir/x.txt", content: "hi" });
    expect(fs.readText("/new/dir/x.txt")).toBe("hi");
    expect(opened).toContain("/new/dir/x.txt");
    expect(settle).toHaveBeenCalled();
    await run("edit_file", { path: "/src/a.txt", old_text: "beta", new_text: "gamma" });
    expect(fs.readText("/src/a.txt")).toBe("alpha\ngamma\n");
    await expect(run("edit_file", { path: "/src/a.txt", old_text: "nope", new_text: "x" })).rejects.toThrow(/not found/);
    fs.writeFile("/dup.txt", "a a");
    await expect(run("edit_file", { path: "/dup.txt", old_text: "a", new_text: "b" })).rejects.toThrow(/2 times/);
    expect(fs.readText("/dup.txt")).toBe("a a");
    // a replacement text with "$&" is literal
    await run("edit_file", { path: "/hello.c", old_text: "return 0;", new_text: "return $&;" });
    expect(fs.readText("/hello.c")).toContain("return $&;");
  });

  it("moves and deletes", async () => {
    const { fs, run } = setup();
    await run("move_path", { from: "/src/a.txt", to: "/src/b.txt" });
    expect(fs.exists("/src/b.txt")).toBe(true);
    await run("delete_path", { path: "/src" });
    expect(fs.exists("/src")).toBe(false);
  });

  it("reports machine state, and refuses to run commands on a stopped system", async () => {
    const { run } = setup();
    const status = await run("machine_status");
    expect(status).toContain("Linux system: stopped");
    expect(status).toContain("0x7C1A");
    expect(status).toContain("Network (next boot):");
    await expect(run("run_command", { command: "ls" })).rejects.toThrow(/not running/);
    await expect(run("debug_inspect")).rejects.toThrow(/No disk image/);
    expect(await run("list_boot_images")).toBe("/boot/boot.img");
  });

  it("validates addresses and relay urls", async () => {
    const { run, env } = setup();
    await expect(run("debug_set_breakpoints", { addresses: ["zzz"] })).rejects.toThrow(/not an address/);
    await expect(run("set_network", { mode: "relay", relay_url: "http://x" })).rejects.toThrow(/ws/);
    await run("set_network", { mode: "fetch" });
    expect(env.setNetwork).toHaveBeenCalledWith({ mode: "fetch", relayUrl: "" });
  });
});

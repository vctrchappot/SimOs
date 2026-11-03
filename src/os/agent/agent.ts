import type { AgentEvent, AgentMessage, AgentTool, ApprovalMode, ChatProvider, ToolCall, ToolRisk } from "./types";

export const MAX_STEPS = 25;
export const MAX_OUTPUT_CHARS = 20_000;

export interface AgentOptions {
  provider: ChatProvider;
  tools: AgentTool[];
  system: string;
  mode: ApprovalMode;
  /** Asked before a tool runs that the approval mode does not allow by itself. */
  approve(call: ToolCall, risk: ToolRisk): Promise<boolean>;
  onEvent?(event: AgentEvent): void;
  signal?: AbortSignal;
  maxSteps?: number;
}

/** Whether a tool of this risk may run without asking, in this mode. Dangerous tools always ask. */
export function needsApproval(mode: ApprovalMode, risk: ToolRisk): boolean {
  if (risk === "danger") return true;
  if (mode === "all") return false;
  if (risk === "read") return false;
  if (mode === "project") return risk === "machine";
  return true;
}

export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n[… ${text.length - max} characters left out …]\n${text.slice(-(max - head))}`;
}

/** After an interrupted turn, gives every tool call without an answer a result, so providers accept the history again. */
export function repairHistory(history: AgentMessage[]): void {
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role !== "assistant" || !m.toolCalls.length) continue;
    let end = i + 1;
    const answered = new Set<string>();
    while (end < history.length && history[end].role === "tool") answered.add((history[end++] as { callId: string }).callId);
    const missing = m.toolCalls.filter((c) => !answered.has(c.id));
    history.splice(end, 0, ...missing.map((c): AgentMessage => ({ role: "tool", callId: c.id, name: c.name, content: "Interrupted before it ran.", isError: true })));
  }
}

/**
 * Runs the conversation until the model answers without asking for a tool. `history` is extended in place
 * with every message of the turn. Returns the final answer.
 */
export async function runAgent(history: AgentMessage[], options: AgentOptions): Promise<string> {
  const { provider, tools, system, mode, approve, signal } = options;
  const emit = options.onEvent ?? (() => {});
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const specs = tools.map((t) => t.spec);
  const limit = options.maxSteps ?? MAX_STEPS;

  for (let step = 0; step < limit; step++) {
    if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
    const reply = await provider.complete({ system, messages: history, tools: specs, signal });
    history.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
    if (reply.text) emit({ type: "assistant", text: reply.text });
    if (reply.truncated) emit({ type: "notice", text: "The model's answer was cut off (token limit)." });
    if (!reply.toolCalls.length) return reply.text;

    for (const call of reply.toolCalls) {
      const tool = byName.get(call.name);
      const done = (content: string, isError: boolean) => {
        history.push({ role: "tool", callId: call.id, name: call.name, content: truncate(content), isError });
        emit({ type: "tool-result", call, content: truncate(content, 2000), isError });
      };
      if (!tool) {
        emit({ type: "tool-start", call, risk: "unknown" });
        done(`Unknown tool "${call.name}". Available: ${[...byName.keys()].join(", ")}.`, true);
        continue;
      }
      if ("__invalid_arguments" in call.input) {
        emit({ type: "tool-start", call, risk: tool.spec.risk });
        done("The arguments were not valid JSON.", true);
        continue;
      }
      emit({ type: "tool-start", call, risk: tool.spec.risk });
      if (needsApproval(mode, tool.spec.risk) && !(await approve(call, tool.spec.risk))) {
        emit({ type: "tool-denied", call });
        done("The user declined this action. Do not retry it; ask what they would like instead.", true);
        continue;
      }
      if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
      try {
        done(await tool.run(call.input, signal), false);
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        done(e instanceof Error ? e.message : String(e), true);
      }
    }
  }
  const text = `Stopped after ${limit} steps without a final answer. Say "continue" to go on.`;
  history.push({ role: "assistant", content: text, toolCalls: [] });
  emit({ type: "notice", text });
  return text;
}

/** Shared shapes for the coding agent: a provider-neutral conversation, tools, and the loop's events. */

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string; isError?: boolean };

/**
 * How much a tool can change.
 *  - read:    only looks (files, machine state, the screen)
 *  - write:   edits the project
 *  - exec:    runs a command inside the emulated OS
 *  - machine: powers machines on and off, boots images, drives the debugger and the keyboard
 *  - danger: deletes things or changes settings that affect what leaves the browser; always asks
 */
export type ToolRisk = "read" | "write" | "exec" | "machine" | "danger";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>;
  risk: ToolRisk;
}

export interface AgentTool {
  spec: ToolSpec;
  /** Runs the tool. Throw to report a failure to the model; the message is shown to it. */
  run(input: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

export interface ProviderRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  /** True when the model ran out of room mid-answer. */
  truncated: boolean;
}

export interface ChatProvider {
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

export type AgentEvent =
  | { type: "assistant"; text: string }
  | { type: "tool-start"; call: ToolCall; risk: ToolRisk | "unknown" }
  | { type: "tool-denied"; call: ToolCall }
  | { type: "tool-result"; call: ToolCall; content: string; isError: boolean }
  | { type: "notice"; text: string };

export type ApprovalMode = "ask" | "project" | "all";

import type { AgentMessage, ChatProvider, ProviderRequest, ProviderResponse, ToolCall } from "./types";

/**
 * The gateway to model providers. The user brings their own key; it is used only to call the provider they
 * configured, straight from the browser, and is never stored in the project or sent anywhere else.
 *  - "anthropic": the Messages API (Claude).
 *  - "openai": the Chat Completions API, which OpenAI, OpenRouter, Ollama, LM Studio and many others speak.
 */
export type ProviderKind = "anthropic" | "openai";

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const PROVIDER_DEFAULTS: Record<ProviderKind, { label: string; baseUrl: string; model: string }> = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
  openai: { label: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1", model: "" },
};

export class ProviderError extends Error {}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/**
 * A key must never travel over plain HTTP to a remote host, so the address has to be https:// (or a model on
 * this machine, like Ollama on localhost). Returns the normalized address without a trailing slash, or null.
 */
export function normalizeBaseUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) return null;
    if (url.username || url.password) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function validateConfig(c: ProviderConfig): string | null {
  const base = normalizeBaseUrl(c.baseUrl);
  if (!base) return "The address must start with https:// (http:// only for localhost).";
  if (!c.model.trim()) return "Enter a model name.";
  if (!c.apiKey.trim() && !isLocalHost(new URL(base).hostname)) return "Enter your API key.";
  return null;
}

type Fetch = typeof fetch;

export function createProvider(config: ProviderConfig, fetchImpl: Fetch = (...a) => fetch(...a)): ChatProvider {
  const base = normalizeBaseUrl(config.baseUrl);
  if (!base) throw new ProviderError("Invalid provider address.");
  return config.kind === "anthropic" ? anthropic(config, base, fetchImpl) : openai(config, base, fetchImpl);
}

async function post(fetchImpl: Fetch, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ProviderError(
      `Could not reach ${new URL(url).host}: ${(e as Error).message}. Check the address, and that the provider allows requests from web pages (CORS).`,
    );
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = (json as { error?: { message?: string } | string } | null)?.error;
    const message = typeof detail === "string" ? detail : (detail?.message ?? text.slice(0, 300));
    throw new ProviderError(`${new URL(url).host} answered ${res.status}: ${message}`);
  }
  if (!json) throw new ProviderError("The provider sent something that is not JSON.");
  return json as Record<string, unknown>;
}

// ---- Anthropic Messages API ----------------------------------------------------------------------

function anthropic(config: ProviderConfig, base: string, fetchImpl: Fetch): ChatProvider {
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      const json = await post(
        fetchImpl,
        `${base}/v1/messages`,
        {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          // Required by Anthropic for calls made straight from a browser with the user's own key.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        {
          model: config.model,
          max_tokens: 8192,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        },
        req.signal,
      );
      const blocks = (json.content as Array<Record<string, unknown>> | undefined) ?? [];
      return {
        text: blocks
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("\n")
          .trim(),
        toolCalls: blocks
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: String(b.id), name: String(b.name), input: (b.input as Record<string, unknown>) ?? {} })),
        truncated: json.stop_reason === "max_tokens",
      };
    },
  };
}

export function toAnthropicMessages(messages: AgentMessage[]): unknown[] {
  const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no answer)" }] });
    } else {
      // All results for one assistant turn go back in a single user message.
      const block = { type: "tool_result", tool_use_id: m.callId, content: m.content, is_error: m.isError ?? false };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

// ---- OpenAI-style Chat Completions ---------------------------------------------------------------

function openai(config: ProviderConfig, base: string, fetchImpl: Fetch): ChatProvider {
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      const headers: Record<string, string> = {};
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const json = await post(
        fetchImpl,
        `${base}/chat/completions`,
        headers,
        {
          model: config.model,
          messages: toOpenAIMessages(req.system, req.messages),
          tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
        },
        req.signal,
      );
      const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const message = (choice?.message as Record<string, unknown> | undefined) ?? {};
      const calls = (message.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
      const toolCalls: ToolCall[] = calls.map((c, i) => {
        const fn = (c.function as Record<string, unknown>) ?? {};
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(String(fn.arguments ?? "{}"));
          if (parsed && typeof parsed === "object") input = parsed;
        } catch {
          input = { __invalid_arguments: String(fn.arguments ?? "") };
        }
        return { id: String(c.id ?? `call_${i}`), name: String(fn.name ?? ""), input };
      });
      return { text: String(message.content ?? "").trim(), toolCalls, truncated: choice?.finish_reason === "length" };
    },
  };
}

export function toOpenAIMessages(system: string, messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
    } else out.push({ role: "tool", tool_call_id: m.callId, content: m.content });
  }
  return out;
}

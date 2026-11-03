/**
 * Guest networking. Off by default: a guest that can reach the internet can also leak to it,
 * so the user opts in and chooses the path out of the browser.
 *
 *  - "fetch": the guest's HTTP requests (port 80) are performed by the browser's fetch().
 *    No extra software needed, but HTTPS from the guest, raw TCP, UDP and ping don't work and
 *    the browser's CORS rules apply. `<port>.external` reaches a server on this machine.
 *  - "relay": raw Ethernet frames go to a Wisp relay you run (TCP and DNS work).
 */
export type NetworkMode = "off" | "fetch" | "relay";

export interface NetworkConfig {
  mode: NetworkMode;
  /** ws:// or wss:// address of a Wisp relay; only used in "relay" mode. */
  relayUrl: string;
}

export const DEFAULT_NETWORK: NetworkConfig = { mode: "off", relayUrl: "" };

/** Accepts only Wisp-style websocket URLs. Returns the normalized URL or null. */
export function normalizeRelayUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Reads a stored config defensively; anything unusable falls back to "off". */
export function parseNetworkConfig(raw: unknown): NetworkConfig {
  try {
    const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<NetworkConfig> | null;
    const relayUrl = typeof o?.relayUrl === "string" ? o.relayUrl : "";
    if (o?.mode === "fetch") return { mode: "fetch", relayUrl };
    if (o?.mode === "relay" && normalizeRelayUrl(relayUrl)) return { mode: "relay", relayUrl };
    return { mode: "off", relayUrl };
  } catch {
    return { ...DEFAULT_NETWORK };
  }
}

/** The emulator's `net_device` option for a config, or undefined when the guest gets no network card. */
export function networkDevice(config: NetworkConfig | undefined): Record<string, unknown> | undefined {
  if (!config || config.mode === "off") return undefined;
  if (config.mode === "fetch") return { type: "virtio", relay_url: "fetch" };
  const relay = normalizeRelayUrl(config.relayUrl);
  return relay ? { type: "virtio", relay_url: relay.replace(/^ws(s?):/, "wisp$1:") } : undefined;
}

export function describeNetwork(config: NetworkConfig): string {
  if (config.mode === "fetch") return "Browser fetch (HTTP)";
  if (config.mode === "relay") return "Relay";
  return "Off";
}

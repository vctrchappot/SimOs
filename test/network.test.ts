import { describe, expect, it } from "vitest";
import { networkDevice, normalizeRelayUrl, parseNetworkConfig } from "@/os/runtime/network";

describe("network config", () => {
  it("gives the guest no network card unless the user opted in", () => {
    expect(networkDevice(undefined)).toBeUndefined();
    expect(networkDevice({ mode: "off", relayUrl: "ws://localhost:8080/" })).toBeUndefined();
  });

  it("maps modes onto the emulator's net_device option", () => {
    expect(networkDevice({ mode: "fetch", relayUrl: "" })).toEqual({ type: "virtio", relay_url: "fetch" });
    expect(networkDevice({ mode: "relay", relayUrl: "ws://localhost:8080/" })).toEqual({
      type: "virtio",
      relay_url: "wisp://localhost:8080/",
    });
    expect(networkDevice({ mode: "relay", relayUrl: "wss://relay.example/wisp/" })?.relay_url).toBe("wisps://relay.example/wisp/");
    expect(networkDevice({ mode: "relay", relayUrl: "not a url" })).toBeUndefined();
  });

  it("only accepts websocket relay addresses", () => {
    expect(normalizeRelayUrl(" ws://127.0.0.1:9000 ")).toBe("ws://127.0.0.1:9000/");
    for (const bad of ["", "http://x.test", "javascript:alert(1)", "ftp://x", "ws://", "localhost:80"]) {
      expect(normalizeRelayUrl(bad)).toBeNull();
    }
  });

  it("falls back to off for corrupt or unusable stored values", () => {
    expect(parseNetworkConfig("{broken").mode).toBe("off");
    expect(parseNetworkConfig(null).mode).toBe("off");
    expect(parseNetworkConfig('{"mode":"relay","relayUrl":"http://x"}').mode).toBe("off");
    expect(parseNetworkConfig('{"mode":"bogus"}').mode).toBe("off");
    expect(parseNetworkConfig('{"mode":"fetch"}')).toEqual({ mode: "fetch", relayUrl: "" });
    expect(parseNetworkConfig({ mode: "relay", relayUrl: "ws://a.test/" }).mode).toBe("relay");
  });
});

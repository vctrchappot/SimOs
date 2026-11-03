"use client";

import { useEffect, useRef, useState } from "react";
import { describeNetwork, normalizeRelayUrl, type NetworkMode } from "@/os/runtime/network";
import { useStudio } from "@/store/studio";

const OPTIONS: Array<{ mode: NetworkMode; title: string; text: string }> = [
  { mode: "off", title: "Off", text: "The OS has no network. Nothing leaves your browser." },
  {
    mode: "fetch",
    title: "Browser fetch",
    text: "Plain HTTP (port 80) from the OS is sent by your browser, so websites must allow cross-origin requests. No HTTPS, ping or other protocols. Use http://3000.external/ to reach port 3000 on this computer.",
  },
  {
    mode: "relay",
    title: "Relay (Wisp)",
    text: "Full TCP and DNS through a Wisp relay that you run yourself. The relay sees all of the OS's traffic, so only use one you trust.",
  },
];

export function NetworkMenu() {
  const { network, bootedNetwork, setNetwork, status } = useStudio();
  const [open, setOpen] = useState(false);
  const [relay, setRelay] = useState(network.relayUrl);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const relayOk = normalizeRelayUrl(relay) !== null;
  const choose = (mode: NetworkMode) => {
    if (mode === "relay" && !relayOk) return setNetwork({ mode: "off", relayUrl: relay });
    setNetwork({ mode, relayUrl: relay });
  };
  const running = status === "running" || status === "booting";
  const stale = running && bootedNetwork && (bootedNetwork.mode !== network.mode || bootedNetwork.relayUrl !== network.relayUrl);

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Network settings for the OS"
        className="h-7 rounded-md border border-line px-3 text-[12px] font-medium text-fg transition-colors hover:bg-hover"
      >
        Network: {describeNetwork(network)}
        {stale ? <span className="ml-1.5 text-warn">•</span> : null}
      </button>
      {open ? (
        <div role="dialog" aria-label="Network settings" className="absolute right-0 top-9 z-30 w-80 rounded-lg border border-line bg-raised p-3 shadow-xl">
          <div role="radiogroup" className="flex flex-col gap-1">
            {OPTIONS.map((o) => (
              <label
                key={o.mode}
                className={`flex cursor-pointer gap-2 rounded-md border p-2 ${network.mode === o.mode ? "border-accent/50 bg-accent/5" : "border-transparent hover:bg-hover"}`}
              >
                <input type="radio" name="net-mode" className="mt-0.5" checked={network.mode === o.mode} onChange={() => choose(o.mode)} />
                <span>
                  <span className="block text-[12px] font-medium">{o.title}</span>
                  <span className="block text-[11px] leading-snug text-dim">{o.text}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="mt-2 block text-[11px] text-dim">
            Relay address
            <input
              value={relay}
              onChange={(e) => {
                setRelay(e.target.value);
                if (network.mode === "relay") setNetwork({ mode: normalizeRelayUrl(e.target.value) ? "relay" : "off", relayUrl: e.target.value });
              }}
              placeholder="ws://localhost:8080/"
              spellCheck={false}
              aria-invalid={relay !== "" && !relayOk}
              className="mt-1 h-7 w-full rounded-md border border-line bg-bg px-2 font-mono text-[12px] text-fg outline-none focus:border-accent"
            />
          </label>
          {relay !== "" && !relayOk ? <p className="mt-1 text-[11px] text-bad">Enter a ws:// or wss:// address.</p> : null}
          <p className="mt-2 text-[11px] text-faint">
            {stale ? "Restart the OS to apply this change." : "Takes effect the next time the OS boots."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

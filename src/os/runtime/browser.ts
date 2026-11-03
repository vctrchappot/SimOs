import type { V86Environment } from "./v86-runtime";

/** Where the browser build finds the self-hosted emulator assets (see scripts/copy-assets.mjs). */
export const browserEnvironment: V86Environment = {
  async loadV86() {
    // Loaded as a plain module from /public so the bundler never touches the emulator.
    const mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ "/v86/libv86.mjs" as string);
    return mod.V86;
  },
  machineOptions: {
    wasm_path: "/v86/v86.wasm",
    bios: { url: "/v86/seabios.bin" },
    vga_bios: { url: "/v86/vgabios.bin" },
  },
};

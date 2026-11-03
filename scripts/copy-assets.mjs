// Copies self-hosted runtime assets (Monaco, v86 WASM) into public/ so the studio works offline-first.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const copy = (from, to) => {
  const src = resolve(root, from);
  if (!existsSync(src)) return console.warn(`[assets] missing ${from}, skipped`);
  mkdirSync(dirname(resolve(root, to)), { recursive: true });
  cpSync(src, resolve(root, to), { recursive: true });
};
copy("node_modules/monaco-editor/min/vs", "public/monaco/vs");
copy("node_modules/v86/build/v86.wasm", "public/v86/v86.wasm");
copy("node_modules/v86/build/libv86.mjs", "public/v86/libv86.mjs");

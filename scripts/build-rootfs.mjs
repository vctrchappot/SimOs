// Builds the self-hosted OS image served from public/os/:
//   kernel.bin      Linux 6.8 (i686, virtio-9p built in) from the v86 project's Buildroot build
//   alpine/fs.json  manifest of an Alpine Linux userland (musl, busybox, GNU bash, nano, make, tcc)
//   alpine/blobs/*  file contents, fetched lazily by the emulator
// Everything is downloaded from official mirrors; nothing here is simulated.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "public/os");
const cache = resolve(root, ".cache");
const ALPINE = "https://dl-cdn.alpinelinux.org/alpine";
const BRANCH = "v3.24";
const MINIROOTFS = `${ALPINE}/${BRANCH}/releases/x86/alpine-minirootfs-3.24.3-x86.tar.gz`;
const KERNEL = "https://i.copy.sh/buildroot-bzimage68.bin";
// The package list lives in scripts/packages.txt so it can be edited without touching this script.
const WANTED = readFileSync(resolve(root, "scripts/packages.txt"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*/, "").trim())
  .filter(Boolean);
const REPOS = ["main", "community"];

mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });
mkdirSync(resolve(out, "alpine/blobs"), { recursive: true });

async function download(url, name) {
  const file = resolve(cache, name);
  if (existsSync(file)) return readFileSync(file);
  console.log("download", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

/** Minimal tar reader: ustar + GNU long names; skips pax extended headers. */
function* tarEntries(buf) {
  let off = 0;
  let longName = null;
  const str = (a, b) => buf.toString("utf8", a, b).replace(/\0.*$/s, "");
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) {
      off += 512;
      continue;
    }
    let name = str(off, off + 100);
    const mode = parseInt(str(off + 100, off + 108), 8) || 0;
    const uid = parseInt(str(off + 108, off + 116), 8) || 0;
    const gid = parseInt(str(off + 116, off + 124), 8) || 0;
    const size = parseInt(str(off + 124, off + 136), 8) || 0;
    const mtime = parseInt(str(off + 136, off + 148), 8) || 0;
    const type = String.fromCharCode(buf[off + 156] || 48);
    const link = str(off + 157, off + 257);
    const prefix = str(off + 345, off + 500);
    if (prefix) name = `${prefix}/${name}`;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "x" || type === "g") continue;
    if (longName) {
      name = longName;
      longName = null;
    }
    yield { name, mode, uid, gid, size, mtime, type, link, data };
  }
}

/** Virtual filesystem assembled from tarballs. */
const tree = new Map(); // path -> {kind, mode, uid, gid, mtime, data?, target?}
function addTar(buf, { skipDot = false } = {}) {
  for (const e of tarEntries(buf)) {
    let p = "/" + e.name.replace(/^\.?\/+/, "").replace(/\/$/, "");
    if (p === "/" || p === "/.") continue;
    if (skipDot && e.name.split("/").pop().startsWith(".")) continue;
    const base = { mode: e.mode & 0o7777, uid: e.uid, gid: e.gid, mtime: e.mtime };
    if (e.type === "5") tree.set(p, { ...base, kind: "dir" });
    else if (e.type === "2") tree.set(p, { ...base, kind: "symlink", target: e.link });
    else if (e.type === "1") {
      const src = tree.get("/" + e.link.replace(/^\.?\/+/, ""));
      if (src) tree.set(p, { ...src, ...base });
    } else if (e.type === "0" || e.type === "7") tree.set(p, { ...base, kind: "file", data: Buffer.from(e.data) });
  }
}

function parseIndex(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const o = {};
      for (const line of block.split("\n")) o[line[0]] = line.slice(2);
      return o;
    });
}
const tokenName = (t) => t.replace(/[<>=~].*$/, "");

// 1. Base userland.
addTar(gunzipSync(await download(MINIROOTFS, "alpine-minirootfs.tar.gz")));
const installedDb = tree.get("/lib/apk/db/installed").data.toString();
const installed = new Set();
for (const pkg of parseIndex(installedDb)) {
  installed.add(pkg.P);
  for (const p of (pkg.p ?? "").split(" ")) installed.add(tokenName(p));
}

// 2. Resolve and install extra packages.
const providers = new Map();
const byName = new Map();
for (const repo of REPOS) {
  const idx = gunzipSync(await download(`${ALPINE}/${BRANCH}/${repo}/x86/APKINDEX.tar.gz`, `APKINDEX-${repo}.tar.gz`));
  const entry = [...tarEntries(idx)].find((e) => e.name === "APKINDEX");
  for (const pkg of parseIndex(entry.data.toString())) {
    pkg.repo = repo;
    byName.set(pkg.P, pkg);
    for (const t of [pkg.P, ...(pkg.p ?? "").split(" ").filter(Boolean)]) if (!providers.has(tokenName(t))) providers.set(tokenName(t), pkg);
  }
}
const chosen = new Map();
function need(token) {
  if (token.startsWith("!")) return;
  const name = tokenName(token);
  if (installed.has(name)) return;
  const pkg = providers.get(name);
  if (!pkg) return console.warn("unresolved dependency:", token);
  if (installed.has(pkg.P) || chosen.has(pkg.P)) return;
  chosen.set(pkg.P, pkg);
  for (const d of (pkg.D ?? "").split(" ").filter(Boolean)) need(d);
}
WANTED.forEach(need);
console.log("installing:", [...chosen.keys()].join(" "));
for (const pkg of chosen.values()) {
  const apk = await download(`${ALPINE}/${BRANCH}/${pkg.repo}/x86/${pkg.P}-${pkg.V}.apk`, `${pkg.P}-${pkg.V}.apk`);
  addTar(gunzipSync(apk), { skipDot: true });
}

// 3. SimOs system configuration.
const put = (path, text, mode = 0o644) => tree.set(path, { kind: "file", mode, uid: 0, gid: 0, mtime: Math.floor(Date.now() / 1000), data: Buffer.from(text) });
const passwd = tree.get("/etc/passwd").data.toString().replace(/^root:([^:]*):0:0:root:\/root:.*$/m, "root:$1:0:0:root:/root:/bin/bash");
put("/etc/passwd", passwd);
// tcc looks for crt1.o in a multiarch directory that Alpine does not use.
tree.set("/usr/lib/i386-linux-gnu", { kind: "symlink", target: ".", mode: 0o777, uid: 0, gid: 0, mtime: Math.floor(Date.now() / 1000) });
put("/etc/shells", "/bin/sh\n/bin/ash\n/bin/bash\n");
put("/etc/hostname", "simos\n");
put("/etc/motd", "");
put("/etc/issue", "");
put("/etc/inittab", [
  "::sysinit:/etc/simos-init",
  ...[0, 1, 2, 3].map((n) => `ttyS${n}::respawn:/sbin/getty -n -l /etc/simos-login 115200 ttyS${n} vt100`),
  "::ctrlaltdel:/sbin/reboot",
  "::shutdown:/bin/sync",
  "",
].join("\n"));
put(
  "/etc/simos-login",
  `#!/bin/sh
# Auto-login: a bash login shell for root on the serial console.
export HOME=/root USER=root LOGNAME=root SHELL=/bin/bash TERM=xterm-256color
cd /root
exec /bin/bash -l
`,
  0o755,
);
put(
  "/etc/simos-init",
  `#!/bin/sh
# PID 1 runs this once. Real Alpine userland, real Linux kernel.
mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sysfs /sys
mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev
# Send init and service output to the serial console (only if the device can really be opened).
for tty in /dev/ttyS0 /dev/console; do
  if (: >"$tty") 2>/dev/null; then exec >"$tty" 2>&1 </dev/null; break; fi
done
echo "[simos] init: Alpine Linux $(cat /etc/alpine-release), kernel $(uname -r)"
mkdir -p /dev/pts /dev/shm
mountpoint -q /dev/pts || mount -t devpts devpts /dev/pts
mountpoint -q /run || mount -t tmpfs tmpfs /run
mountpoint -q /tmp || mount -t tmpfs tmpfs /tmp
hostname -F /etc/hostname
ip link set lo up
# v86 always has a network card; it is only wired to something when networking is switched on.
if grep -q simos.net=1 /proc/cmdline; then
  ip link set eth0 up
  if udhcpc -i eth0 -n -q -t 4 -T 1 >/dev/null 2>&1; then
    echo "[simos] network: eth0 $(ip addr show eth0 | sed -n 's/.*inet \\([0-9.]*\\).*/\\1/p')"
  else
    echo "[simos] network: no DHCP answer on eth0"
  fi
fi
mkdir -p /root/project
# User services: every file in /etc/rc.d runs once, in name order (executables run, others are sourced).
# They come from the project's system/etc/rc.d folder. Background long-running work with "&".
for svc in /etc/rc.d/*; do
  [ -f "$svc" ] || continue
  name=$(basename "$svc")
  echo "[simos] starting $name"
  if [ -x "$svc" ]; then "$svc"; else . "$svc"; fi || echo "[simos] $name failed with status $?"
done
echo "[simos] init: ready"
`,
  0o755,
);
put(
  "/root/.bashrc",
  `[ -z "$PS1" ] && return
PS1='\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ '
alias ls='ls --color=auto'
alias ll='ls -alF'
alias grep='grep --color=auto'
`,
);
put("/root/.bash_profile", "[ -f ~/.bashrc ] && . ~/.bashrc\n");
put("/etc/profile.d/color.sh", "export TERM=${TERM:-xterm-256color}\n");

// 4. Emit blobs + manifest.
const blobDir = resolve(out, "alpine/blobs");
const seen = new Set();
let totalSize = 0;
function blob(data) {
  const name = createHash("sha256").update(data).digest("hex").slice(0, 24) + ".bin";
  if (!seen.has(name)) {
    seen.add(name);
    writeFileSync(resolve(blobDir, name), data);
    totalSize += data.length;
  }
  return name;
}
const root_ = { children: new Map() };
for (const path of [...tree.keys()].sort()) {
  const node = tree.get(path);
  const parts = path.split("/").filter(Boolean);
  let dir = root_;
  for (const part of parts.slice(0, -1)) {
    if (!dir.children.has(part)) dir.children.set(part, { kind: "dir", mode: 0o755, uid: 0, gid: 0, mtime: 0, children: new Map() });
    dir = dir.children.get(part);
  }
  const name = parts.at(-1);
  if (node.kind === "dir") {
    const existing = dir.children.get(name);
    dir.children.set(name, { ...node, children: existing?.children ?? new Map() });
  } else dir.children.set(name, node);
}
function emit(children) {
  return [...children].map(([name, n]) => {
    if (n.kind === "dir") return [name, 4096, n.mtime, 0o40000 | n.mode, n.uid, n.gid, emit(n.children)];
    if (n.kind === "symlink") return [name, n.target.length, n.mtime, 0o120777, n.uid, n.gid, n.target];
    return [name, n.data.length, n.mtime, 0o100000 | n.mode, n.uid, n.gid, blob(n.data)];
  });
}
const manifest = { fsroot: emit(root_.children), version: 3, size: totalSize };
writeFileSync(resolve(out, "alpine/fs.json"), JSON.stringify(manifest));
writeFileSync(resolve(out, "kernel.bin"), await download(KERNEL, "buildroot-bzimage68.bin"));
console.log(`done: ${seen.size} blobs, ${(totalSize / 1e6).toFixed(1)} MB, ${tree.size} entries`);

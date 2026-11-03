// Builds the kernel and initramfs for the graphics-capable Alpine profile, into public/os/desktop/:
//   vmlinuz         Alpine's linux-virt kernel (framebuffer console, Bochs DRM driver, PS/2 mouse)
//   initramfs.gz    busybox + the modules needed to mount the 9p root filesystem and bring up the display
// The Linux userland is the same Alpine image as the text profile (public/os/alpine, see build-rootfs.mjs).
// Everything is downloaded from the official Alpine mirror.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { download as fetchCached, tarEntries } from "./lib/tar.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "public/os/desktop");
const cache = resolve(root, ".cache");
const ALPINE = "https://dl-cdn.alpinelinux.org/alpine";
const BRANCH = "v3.24";
const MINIROOTFS = `${ALPINE}/${BRANCH}/releases/x86/alpine-minirootfs-3.24.3-x86.tar.gz`;
const KERNEL_VERSION = "6.18.60-r0"; // pinned: the modules must match the kernel exactly
const KERNEL_APK = `${ALPINE}/${BRANCH}/main/x86/linux-virt-${KERNEL_VERSION}.apk`;
/** Modules to load before mounting the root filesystem, in this order (dependencies are added automatically). */
const MODULES = ["9pnet_virtio", "9p", "bochs", "evdev", "psmouse"];

mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });
const download = (url, name) => fetchCached(cache, url, name);

// ---- the kernel package ------------------------------------------------------------------------
const apk = gunzipSync(await download(KERNEL_APK, `linux-virt-${KERNEL_VERSION}.apk`));
const files = new Map();
for (const e of tarEntries(apk)) if (e.type === "0" || e.type === "7") files.set(e.name.replace(/^\.?\//, ""), Buffer.from(e.data));

const vmlinuz = files.get("boot/vmlinuz-virt");
if (!vmlinuz) throw new Error("vmlinuz-virt not found in the linux-virt package");
const moduleRoot = [...files.keys()].find((k) => k.endsWith("/modules.dep"))?.replace(/modules\.dep$/, "");
if (!moduleRoot) throw new Error("modules.dep not found in the linux-virt package");
const dep = new Map(); // "kernel/fs/9p/9p.ko.gz" -> ["kernel/net/9p/9pnet.ko.gz", ...]
for (const line of files.get(moduleRoot + "modules.dep").toString().split("\n")) {
  const m = line.match(/^(\S+):\s*(.*)$/); // "path:" has no trailing space when there are no dependencies
  if (m) dep.set(m[1], m[2].split(" ").filter(Boolean));
}
const byName = new Map([...dep.keys()].map((p) => [p.split("/").pop().replace(/\.ko(\.gz)?$/, ""), p]));

/** Modules in load order: each one after everything it depends on. */
const order = [];
function visit(path) {
  if (order.includes(path)) return;
  for (const d of dep.get(path) ?? []) visit(d);
  order.push(path);
}
for (const name of MODULES) {
  const path = byName.get(name);
  if (!path) throw new Error(`module ${name} is not in this kernel package`);
  visit(path);
}

// ---- userland for the initramfs: busybox and the musl loader it needs ----------------------------
const mini = new Map();
for (const e of tarEntries(gunzipSync(await download(MINIROOTFS, "alpine-minirootfs.tar.gz")))) {
  mini.set("/" + e.name.replace(/^\.?\/+/, "").replace(/\/$/, ""), e);
}
function content(path) {
  let e = mini.get(path);
  for (let i = 0; e && e.type === "2" && i < 8; i++) e = mini.get(e.link.startsWith("/") ? e.link : "/lib/" + e.link) ?? mini.get("/bin/" + e.link);
  if (!e || !e.data) throw new Error(`${path} is not in the minirootfs`);
  return Buffer.from(e.data);
}

// ---- cpio (newc) archive -------------------------------------------------------------------------
const entries = [];
const addDir = (name) => entries.push({ name, mode: 0o040755, data: Buffer.alloc(0) });
const addFile = (name, data, mode = 0o100644) => entries.push({ name, mode, data: Buffer.from(data) });
const addLink = (name, target) => entries.push({ name, mode: 0o120777, data: Buffer.from(target) });

for (const d of ["bin", "dev", "proc", "sys", "newroot", "lib", "lib/modules", "tmp"]) addDir(d);
addFile("bin/busybox", content("/bin/busybox"), 0o100755);
addFile("lib/ld-musl-i386.so.1", content("/lib/ld-musl-i386.so.1"), 0o100755);
for (const applet of ["sh", "mount", "umount", "mkdir", "insmod", "switch_root", "echo", "sleep", "ls", "cat", "dmesg"]) addLink(`bin/${applet}`, "busybox");

const loadList = [];
for (const path of order) {
  const base = path.split("/").pop().replace(/\.gz$/, "");
  const raw = path.endsWith(".gz") ? gunzipSync(files.get(moduleRoot + path)) : files.get(moduleRoot + path);
  addFile(`lib/modules/${base}`, raw);
  loadList.push(base);
}

addFile(
  "init",
  `#!/bin/sh
# Stage 1: load the drivers the kernel doesn't have built in, mount the Alpine root from the host (9p), hand over to its init.
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
/bin/mount -t devtmpfs devtmpfs /dev
for m in ${loadList.join(" ")}; do
  /bin/insmod /lib/modules/$m || echo "[initramfs] could not load $m"
done
/bin/mount -t 9p -o trans=virtio,version=9p2000.L,cache=mmap host9p /newroot || { echo "[initramfs] cannot mount the root filesystem"; exec /bin/sh; }
exec /bin/switch_root /newroot /sbin/init
`,
  0o100755,
);

function cpio(list) {
  const chunks = [];
  let ino = 1;
  const pad = (n) => (4 - (n % 4)) % 4;
  for (const e of [...list, { name: "TRAILER!!!", mode: 0, data: Buffer.alloc(0) }]) {
    const name = Buffer.from(e.name + "\0");
    const field = (n) => n.toString(16).padStart(8, "0");
    const header =
      "070701" +
      [ino++, e.mode, 0, 0, e.mode & 0o040000 ? 2 : 1, 0, e.data.length, 0, 0, 0, 0, name.length, 0].map(field).join("");
    chunks.push(Buffer.from(header), name, Buffer.alloc(pad(110 + name.length)), e.data, Buffer.alloc(pad(e.data.length)));
  }
  return Buffer.concat(chunks);
}

writeFileSync(resolve(out, "vmlinuz"), vmlinuz);
const initramfs = gzipSync(cpio(entries), { level: 9 });
writeFileSync(resolve(out, "initramfs.gz"), initramfs);
console.log(
  `desktop: kernel ${(vmlinuz.length / 1e6).toFixed(1)} MB, initramfs ${(initramfs.length / 1e6).toFixed(1)} MB (${loadList.length} modules: ${loadList.join(", ")})`,
);

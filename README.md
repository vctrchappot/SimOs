# SimOs Studio

A browser-based OS development studio. Edit a project on the left; on the right a **real Linux
system** runs, with a real kernel, real init, real GNU bash and a real C toolchain. Both sides work
on the same filesystem.

Nothing in the terminal is simulated: commands are executed by the guest's own `bash`, `busybox`,
`make` and `tcc`, on a Linux 6.8 kernel running on an x86 emulator ([v86](https://github.com/copy/v86)).

## What you can do

- **Run real shell commands** in a bash login shell on a real Linux kernel, and watch the real boot log.
- **Edit the project and the OS together.** `~/project` is shared with the editor in both directions.
- **Author the OS itself** in the `system/` folder: hostname, boot services (`/etc/rc.d`), shell
  configuration. It is laid over the OS at every boot and saved with the project.
- **Run file** executes the open `.sh`, `.c` or Makefile in the terminal, visibly, as if you typed it.
- **Keep build output out of the editor** with a `.simosignore` file (names, `*.o` globs, `dir/`,
  `/anchored`); `node_modules/` and `.git/` are always ignored. Ignored files stay inside the OS.
- **Up to four real terminals.** Each tab is its own serial console (`ttyS0`-`ttyS3`) with its own login
  shell; closing a tab ends that shell and a fresh one starts when you reopen it.
- **Search in all files** (Ctrl+Shift+F), with case and regex options; a hit opens the file at that line.
- **Import and export the project as a .zip** (no dependencies; unsafe paths and zip bombs are rejected).
- **Keyboard-driven file tree:** arrows, Enter, F2 (rename), Delete (press twice to confirm).
- **Optional networking** (off by default, toolbar *Network*): the OS gets a real virtio network card, DHCP and DNS.
  Choose *Browser fetch* (plain HTTP via your browser) or a *Wisp relay* you run yourself (TCP/DNS).
- **Boot your own operating system.** *Boot image* starts a bare PC (BIOS, VGA, keyboard, serial port, no Linux)
  from a disk image in your project. The template has a 512-byte OS in `boot/boot.asm`; build it with `nasm`
  in the Linux terminal (`cd boot && make`) and boot it, with a serial log below the screen.
- **A real display.** The *Display* tab shows the machine's VGA screen, with a login shell on `tty1`, and sends your
  keyboard (and mouse, in graphics modes) to the guest's PS/2 devices. Text and pixel modes both work, so a
  bare-metal OS or a framebuffer program has somewhere to draw.
- Power on / Power off / Restart / Reset the machine; the project survives all of them and page reloads.

## Quick start

```sh
npm install
npm run build:os     # one-time: downloads kernel + Alpine userland into public/os (~45 MB)
npm run dev          # http://localhost:3000
```

The OS boots automatically (about 7 s). Requires Node 20+. Try `./hello.sh`, `make run`, edit `hello.sh` in the editor and
run it again, or `echo hi > new.txt` in the terminal and watch it appear in the explorer.

| Command | Purpose |
| --- | --- |
| `npm test` | all tests (unit + real-Linux integration) |
| `npm run test:unit` | fast unit tests (filesystem, persistence, sync engine) |
| `npm run test:integration` | boots the real kernel inside Node and drives it |
| `npm run e2e` | boots the production build in Edge/Chrome via Playwright and drives the UI (run `npm run build` first; `E2E_CHANNEL=chrome` to pick the browser; or pass a URL) |
| `node scripts/jank.mjs` | measures frame gaps on the page while the guest runs a heavy loop (`INLINE=1` compares the no-worker mode) |
| `npm run typecheck` | TypeScript |

## Runtime decision

| Option | Verdict |
| --- | --- |
| **WebContainers** | Node.js only. Its shell (`jsh`) is not bash, there is no Linux kernel, no C toolchain, and it is licensed for commercial use. Rejected. |
| **JS reimplementation of bash** | A simulation. Rejected by the requirements. |
| **v86 (x86 emulator, WASM)** | Runs an unmodified Linux kernel and unmodified x86 binaries in the browser, with a 9p filesystem the host can read and write directly. **Chosen.** |
| Wasm-compiled Linux (e.g. RISC-V/Wasm) | Possible, but no maintained browser image with a shared filesystem. |

The guest is a Linux 6.8 kernel (from the v86 project's Buildroot build, 9p built in) with an
**Alpine Linux** userland assembled by `scripts/build-rootfs.mjs`: musl, busybox, GNU bash 5.3,
coreutils, make, tcc, nano. The kernel mounts the shared 9p filesystem as its root
(`rdinit=/nonexistent root=host9p`) and Alpine's `/sbin/init` (busybox init) becomes PID 1, so the
boot sequence is real.

### Genuine vs. simulated

Genuine: kernel, init, processes, signals, pipes, redirection, environment variables, job control,
scripts, the compiler, the filesystem semantics inside the guest.

Not simulated but constrained by the platform, so know the limits:

* **x86 emulation is slow** (roughly 20-50x slower than native). Compiling large programs takes a while.
* **Networking is opt-in and limited.** *Browser fetch* carries only plain HTTP on port 80 (no HTTPS, ping,
  UDP or other TCP), is subject to the browser's CORS rules, and reaches this computer via
  `http://<port>.external/`. A *Wisp relay* gives TCP and DNS, but the relay operator sees all guest traffic:
  run your own and never use one you don't trust. Neither supports `apk add` out of the box (Alpine's mirror
  sends no CORS headers; HTTPS needs the relay). The image is fixed at build time; add packages by
  adding them to `scripts/packages.txt` and running `npm run build:os` again.
* **The display follows the physical keys** you press and the guest uses a US layout (`loadkmap` can change
  that). The bundled kernel has no framebuffer or DRM driver, so Linux itself only draws the text console;
  graphics need a kernel with `vesafb`/`bochs-drm` or your own bootable system.
* **32-bit x86 (i686)** guest, 256 MB RAM.
* **Persistence covers the project directory** (`~/project`), not the rest of the OS. Installing
  or changing files outside `~/project` is lost on Stop/Restart. This is intentional: the OS image
  is a reproducible artifact, the project is your data.
* Terminals are serial consoles. Window-size changes reach the guest at the next prompt, so a full-screen
  program started before a resize keeps its old size until you restart it.
* File modes are not synced back to the editor. Files with a `#!` header are created executable.
* Files above 4 MB created in the guest are not mirrored into the editor, and files above 512 KB are
  change-detected by size and mtime rather than content.

## Architecture

```
src/os/                      framework-free, strongly typed, no React
  vfs/        MemoryFS        project filesystem, the editor's source of truth (+ change events)
              persistence     IndexedDB store, write-behind binding, restore
  runtime/    types           OSProfile, OSRuntime, GuestFS contracts
              sync            SyncEngine: editor <-> guest mirroring
              v86-guest-fs    the guest's 9p filesystem as a GuestFS
              v86-runtime     boots a profile on v86, console I/O, readiness detection
              profiles        Alpine profile (cmdline, boot files, shell hooks)
  studio.ts                   Studio: project + persistence + runtime (run/stop/restart/reset)
  sdk/index.ts                public surface for building on the platform
src/store/studio.ts          Zustand store for UI state
src/components/              Workspace, Toolbar, Explorer, EditorPane (Monaco), TerminalPane (xterm.js)
scripts/                     copy-assets, build-rootfs, e2e
test/                        unit tests + integration tests that boot real Linux
```

### How editor and OS stay in sync

`MemoryFS` is the editor-side truth and is persisted to IndexedDB (one record per path,
write-behind). The running guest's project directory is the same 9p tree the emulator exposes to JS
(`emulator.fs9p`). `SyncEngine` mirrors them:

* **Editor to guest:** every `MemoryFS` event (write, mkdir, rename, remove) is applied to the guest
  tree immediately, in order, with the data snapshotted at event time. The root is mounted with
  `cache=mmap`, so the guest sees the change on its next read (no stale page cache).
* **Guest to editor:** the guest tree is scanned every 400 ms. A scan is metadata-only: the 9p
  server is wrapped to learn which inodes were written, and only those are re-read and re-hashed.
  Ignored directories are not entered at all. Fingerprints identify creations, edits and deletions
  made by shell commands. Echo is suppressed with an origin tag and a
  "last agreed state" table, so neither side re-imports its own changes.
* Conflicts: last writer wins. Stopping the OS first pulls in pending guest changes.
* On boot, the project is copied into the guest before the CPU starts, so the first prompt already
  sees your files.

### Extending toward a desktop OS

An `OSProfile` describes a bootable system: kernel, root filesystem manifest, kernel command line,
boot-time files, readiness marker. A custom shell, boot sequence or service set is a new profile or
a different `bootFiles` set. The runtime exposes the console and guest filesystem through
`OSRuntime`; a graphical profile would add a framebuffer/input surface to that interface (v86
already emulates VGA and PS/2) and a desktop pane next to the terminal. The VFS, persistence, sync
and studio layers do not change.

The emulator runs in a **Web Worker** (`v86.worker.ts`); the page talks to it through typed messages
(`worker-protocol.ts`) and reaches the guest filesystem over an RPC proxy, so the same `SyncEngine`
works unchanged. In a heavy-loop test the worst frame gap dropped from 50 ms to 34 ms (headless
Edge); the gain is modest because the emulator already yields often. Add `?inline` to the page URL to
run it on the main thread instead, and browsers without workers fall back automatically.

Isolation: user code runs only inside the emulated machine (a WASM sandbox that has no network unless you
switch it on, and no access to the host page); the app talks to it solely through the console and the 9p tree.

## Configuration

Assets are self-hosted from `public/` (Monaco and v86 are copied there by `postinstall`;
the OS image by `npm run build:os`), so the studio works offline after the first build.

## Roadmap

Done: Phase 1 (editable OS overlay and boot services, Run file, visible sync errors and conflict notices),
Phase 2 (ignore rules, cheaper change detection, emulator in a Web Worker, CI) and Phase 3 (terminals,
project search, zip import/export, keyboard navigation, editable package list), optional guest networking
the display and bare-metal boot of your own images.

Deliberately not done: *fast resume* from a saved VM state. Boot takes about 7 s, while a saved state
would be hundreds of megabytes per project and tied to one exact image version.

Phase 4 added the display pane (VGA text and graphics, keyboard, mouse).

Phase 5 added bare-metal boot of your own disk images (nasm and binutils are in the Linux image).

Next: a kernel with framebuffer support for a desktop, and debugging aids for bare-metal work (register and
memory view, breakpoints).

## Third-party software

The studio itself is MIT licensed. The OS image it downloads and runs contains separately licensed
software: the Linux kernel (GPL-2.0, built by the v86 project), Alpine Linux packages (busybox, bash,
musl, tcc and others, each under its own license), and the [v86](https://github.com/copy/v86) emulator
(BSD-2-Clause). Editor and terminal use Monaco (MIT) and xterm.js (MIT).

## License

[MIT](LICENSE)

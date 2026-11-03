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
| `npm run e2e` | boots the OS in Edge/Chrome via Playwright and drives the UI (needs the dev server on :3123, or pass a URL) |
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
* **No networking** (no `apk add`, no `curl`). The image is fixed at build time; add packages by
  adding them to `WANTED` in `scripts/build-rootfs.mjs`.
* **32-bit x86 (i686)** guest, 256 MB RAM.
* **Persistence covers the project directory** (`~/project`), not the rest of the OS. Installing
  or changing files outside `~/project` is lost on Stop/Restart. This is intentional: the OS image
  is a reproducible artifact, the project is your data.
* The terminal is a serial console (`ttyS0`). Window-size changes reach the guest at the next prompt.
* File modes are not synced back to the editor. Files with a `#!` header are created executable.
* Files above 4 MB created in the guest are not mirrored into the editor.

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
* **Guest to editor:** the guest tree is scanned every 400 ms; content fingerprints identify
  creations, edits and deletions made by shell commands. Echo is suppressed with an origin tag and a
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

Isolation: user code runs only inside the emulated machine (a WASM sandbox with no network and no
access to the host page); the app talks to it solely through the console and the 9p tree.

## Configuration

Assets are self-hosted from `public/` (Monaco and v86 are copied there by `postinstall`;
the OS image by `npm run build:os`), so the studio works offline after the first build.

## Roadmap

Phase 1 (done): editable OS overlay and boot services, Run file, visible sync errors and edit-conflict notices.
Next: CI and sync scalability (ignore rules, worker-hosted emulator), multiple terminals and fast resume,
find-in-files and zip import/export, then a display pane for graphical systems.

## Third-party software

The studio itself is MIT licensed. The OS image it downloads and runs contains separately licensed
software: the Linux kernel (GPL-2.0, built by the v86 project), Alpine Linux packages (busybox, bash,
musl, tcc and others, each under its own license), and the [v86](https://github.com/copy/v86) emulator
(BSD-2-Clause). Editor and terminal use Monaco (MIT) and xterm.js (MIT).

## License

[MIT](LICENSE)

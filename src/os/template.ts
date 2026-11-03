/** Files a fresh project starts with. Paths are relative to the project root. */
export const PROJECT_TEMPLATE: Record<string, string> = {
  "README.md": `# My OS project

This directory is the same folder you see in the terminal on the right (\`~/project\`).
Edit files here, run them there. Everything below is a real Linux system, not a simulation.

\`\`\`sh
./hello.sh          # run a shell script
make run            # compile and run a C program with gcc
./scripts/sysinfo.sh
\`\`\`

Files you create or change in the terminal show up in the editor, and the other way round.

## Your own bootable OS

\`boot/\` holds a 512-byte operating system in assembly. Build it in the terminal, then boot it on a bare PC
(no Linux involved) with **Boot image** in the toolbar:

\`\`\`sh
cd boot && make     # nasm assembles boot.asm into boot.img
\`\`\`

Then choose \`boot/boot.img\` under **Boot image**. The Display tab shows the screen and takes your keyboard;
serial output (port 0x3F8) appears below it.

## Building the Linux system itself

The \`system/\` folder is laid over the operating system's root at every boot, and it is saved with
the project:

- \`system/etc/hostname\` becomes \`/etc/hostname\`
- \`system/etc/rc.d/*\` are boot services, run once in name order while the OS starts
- \`system/etc/profile.d/*.sh\` run for every login shell

Edit them, press **Restart**, and watch the boot log. Anything you change outside \`~/project\` while
the OS runs is gone after a restart, so put it in \`system/\`.
`,
  "hello.sh": `#!/bin/bash
# A plain bash script. Edit it, save, and run ./hello.sh in the terminal.
name="\${1:-world}"
echo "Hello, $name! Running $(uname -sr) as $(whoami)."
`,
  "hello.c": `#include <stdio.h>
#include <sys/utsname.h>

int main(void) {
    struct utsname u;
    uname(&u);
    printf("Hello from C on %s %s (%s)\\n", u.sysname, u.release, u.machine);
    return 0;
}
`,
  Makefile: `hello: hello.c
\ttcc -Wall -o hello hello.c

run: hello
\t./hello

clean:
\trm -f hello

.PHONY: run clean
`,
  "scripts/sysinfo.sh": `#!/bin/bash
set -euo pipefail
echo "kernel : $(uname -r)"
echo "shell  : $BASH_VERSION"
echo "memory : $(free -m | awk '/Mem:/ {print $2 " MB"}')"
echo "cpus   : $(nproc)"
echo "uptime : $(uptime -p)"
echo "files  : $(find . -type f | wc -l) in $(pwd)"
`,

  "boot/boot.asm": `; A complete 512-byte operating system: the BIOS loads this sector to 0x7C00 and jumps to it.
; It prints a banner, then echoes every key you type (on the screen and on serial port COM1).
bits 16
org 0x7c00

start:
    xor ax, ax
    mov ds, ax
    mov si, banner
    call print
.key:
    xor ah, ah              ; BIOS int 16h: wait for a key
    int 0x16
    cmp al, 13              ; Enter
    jne .show
    mov si, newline
    call print
    jmp .key
.show:
    call putc
    jmp .key

print:                      ; prints the zero-terminated string at ds:si
    lodsb
    or al, al
    jz .done
    call putc
    jmp print
.done:
    ret

putc:                       ; prints the character in al to the screen and to serial port COM1
    mov ah, 0x0e
    xor bx, bx
    int 0x10
    mov dx, 0x3f8
    out dx, al
    ret

banner  db "Hello from my own operating system!", 13, 10, "Type something: ", 0
newline db 13, 10, 0

times 510 - ($ - $$) db 0   ; pad to one sector
dw 0xaa55                   ; boot signature
`,
  "boot/Makefile": `boot.img: boot.asm
	nasm -f bin boot.asm -o boot.img

clean:
	rm -f boot.img
`,

  ".simosignore": `# Paths listed here stay inside the OS and never show up in the editor.
# node_modules/ and .git/ are always ignored. Supports names, *.glob, dir/ and /anchored.
hello
*.o
`,

  // The system/ folder is laid over the OS root at every boot: system/etc/hostname becomes /etc/hostname.
  "system/etc/hostname": "my-os\n",
  "system/etc/rc.d/10-welcome.sh": `#!/bin/sh
# A boot service. Every file in /etc/rc.d runs once at boot, in name order, as root.
# Edit it, then press Restart to watch it run in the boot log. Use "&" for long-running work.
echo "welcome service: starting on $(hostname)"
echo "booted $(date)" > /run/welcome
`,
  "system/etc/profile.d/20-shell.sh": `# Sourced by every login shell. Changes apply after Restart.
alias ll='ls -alF'
[ -r /run/welcome ] && echo "(this OS $(cat /run/welcome))"
`,
};

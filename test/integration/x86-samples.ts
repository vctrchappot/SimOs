/** Assembly the decoder is checked against: nasm assembles it, we must find the same instruction boundaries. */

export const SAMPLES_16 = `
bits 16
top:
mov ax, 1
mov al, 2
mov bx, [bx+si]
mov [bp+di+0x10], cx
mov byte [si], 5
mov word [0x1234], 7
mov ax, [0x1234]
mov cx, [bp]
mov dx, [bp-2]
mov si, [bx+0x1234]
add ax, bx
add al, 5
add ax, 0x1234
adc bl, cl
sbb [bx], ax
and ax, 0x00ff
or byte [di], 1
xor ax, ax
cmp ax, 5
cmp byte [bx+0x20], 0x7f
sub sp, 2
inc ax
dec bx
inc byte [bx]
dec word [bp+4]
push ax
pop bx
push es
pop ds
push word 0x1234
push cs
pusha
popa
pushf
popf
lea si, [bx+di+4]
xchg ax, bx
xchg [bx], cl
nop
jmp short top
je top
jne short top
call top
ret
retf
ret 4
loop top
jcxz top
int 0x10
int3
iret
hlt
cli
sti
cld
std
shl ax, 1
shr bl, cl
sar word [bx], 3
rol al, 1
rcl bx, 2
mul bx
div cl
neg ax
not byte [si]
imul bx
imul ax, bx, 5
test ax, bx
test al, 1
test word [bx], 0x100
in al, 0x60
out 0x60, al
in ax, dx
out dx, al
lodsb
stosw
movsb
rep movsw
repne scasb
cmpsb
mov ds, ax
mov ax, ds
mov es, [bx]
lds si, [bx]
les di, [bx+2]
xlatb
cbw
cwd
lahf
sahf
daa
aaa
jmp bx
jmp [bx]
call ax
call [si]
jmp far [bx]
call 0x1234:0x5678
jmp 0x0:0x7c00
mov eax, 0x12345678
mov ebx, [eax]
mov ecx, [eax+ebx*2+8]
add eax, ecx
push eax
movzx ax, bl
movsx eax, bx
bt ax, bx
bsf ax, bx
setz al
cmovne ax, bx
mov cr0, eax
mov eax, cr0
lgdt [0x1234]
lidt [bx]
cpuid
rdtsc
wbinvd
mov al, [es:bx]
mov [cs:0x100], al
mov ax, [ss:bp+2]
mov al, [0x10]
mov [0x20], ax
db 0x0f, 0x1f, 0x00
fld dword [bx]
fadd st0, st1
fnstsw ax
bswap eax
xadd [bx], ax
shld ax, bx, 3
lock inc word [bx]
enter 8, 0
leave
bound ax, [bx]
`;

export const SAMPLES_32 = `
bits 32
top:
mov eax, [ebx+ecx*4+0x10]
mov [esp+4], eax
mov ax, bx
lea eax, [eax*2+eax]
mov eax, [0x12345678]
add dword [ebp-8], 1
push dword 0x12345678
push 5
call top
jmp top
jne near top
je short top
movzx eax, byte [esi]
movsx ebx, word [edi+2]
bswap eax
xadd [eax], ebx
rep stosd
lock inc dword [eax]
mov byte [fs:0x10], 1
sub esp, 0x100
imul eax, [ebx], 7
imul ecx, edx
shld eax, ebx, 4
ret
leave
enter 8, 0
pushad
popad
iretd
lgdt [eax]
int 0x80
mov cr3, eax
mov eax, cr4
mov ax, [bx+si]
mov al, [esp]
mov ebx, [esp+ecx]
mov ecx, [ebp+0x100]
cmp dword [eax+0x12345678], 0x11223344
test byte [ebx], 0x80
xchg eax, ecx
cdq
cwde
mov eax, cs
mov ds, ax
push fs
pop gs
rdmsr
wrmsr
cpuid
hlt
nop
jmp eax
call [eax*4+0x1000]
jmp [ebx]
sidt [esp+8]
btr eax, 3
bts dword [ebx], eax
bsr ecx, [edx]
setne byte [eax]
cmovg eax, [ebx]
movsb
rep movsd
scasd
in eax, dx
out 0x80, al
sysenter
cmpxchg [ebx], ecx
`;

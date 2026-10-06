/*
 * tools/test-z80tools.js: checks tools/z80asm.js and tools/z80dis.js
 * against each other and against golden values.
 *
 * Usage (run from the project root):
 *   node tools/test-z80tools.js
 *
 * Each ROM in static/roms, every opcode with every prefix, and each
 * starter program's machine code are disassembled and assembled again,
 * which must give the same bytes back. ZOOM's code must assemble to the
 * bytes on the committed Demos cassette. A set of lines written in each
 * of the notations the assembler takes must give the bytes the Z80 manual
 * gives for them, and lines with a mistake in them must be refused, with
 * the source and the line named.
 */

import fs from 'fs';
import path from 'path';

import { assemble } from './z80asm.js';
import { disassemble } from './z80dis.js';
import { parseCassetteFile, parseHeader } from '../runtime/cassette.js';

let failures = 0;
function check(what, ok, detail = '') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${(!ok && detail) ? `: ${detail}` : ''}`);
    if (!ok) failures++;
}

const hex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');

/* `bytes` at `origin` disassembled and assembled again; the address of the
 * first difference, the end of the shorter where the lengths differ, or -1. */
function roundTrip(bytes, origin) {
    const lines = disassemble(bytes, { origin });
    const source = [`        ORG ${origin}`, ...lines.map(l => `        ${l.text}`)].join('\n');
    const back = assemble(source, 'round trip').bytes;
    for (let i = 0; i < bytes.length; i++) if (back[i] !== bytes[i]) return origin + i;
    if (back.length !== bytes.length) return origin + Math.min(back.length, bytes.length);
    return -1;
}

for (const rom of fs.readdirSync('static/roms').filter(f => f.endsWith('.rom'))) {
    const at = roundTrip(fs.readFileSync(path.join('static/roms', rom)), 0);
    check(`${rom} disassembles and assembles back`, at < 0, `differs at $${at.toString(16)}`);
}

const every = [];
for (let op = 0; op < 256; op++) {
    for (const prefix of [[], [0xcb], [0xed], [0xdd], [0xfd], [0xdd, 0xcb, 0x05], [0xfd, 0xcb, 0xfb]]) every.push(...prefix, op, 0x34, 0x12, 0x56);
}
check('every opcode disassembles and assembles back', roundTrip(Uint8Array.from(every), 0) < 0);

const manifest = JSON.parse(fs.readFileSync('starter/starter.json', 'utf8'));
for (const cassette of manifest.cassettes) {
    for (const program of cassette.programs.filter(p => p.code)) {
        const code = assemble(fs.readFileSync(path.join('starter', program.code.asm), 'utf8'), path.join('starter', program.code.asm));
        check(`${program.code.asm} disassembles and assembles back`, roundTrip(code.bytes, code.origin) < 0);
        // The golden value: the CODE block on the committed cassette.
        const tape = parseCassetteFile(new Uint8Array(fs.readFileSync(path.join('static/starter', cassette.file))));
        const blocks = tape.blocks || tape;
        let saved = null;
        blocks.forEach((block, i) => {
            const data = block.data || block;
            const header = (data[0] === 0) ? parseHeader(data) : null;
            if (header && (header.name || '').trim() === program.code.name) saved = (blocks[i + 1].data || blocks[i + 1]).slice(1, -1);
        });
        check(`${program.code.asm} assembles to the CODE on ${cassette.file}`, !!saved && (hex(saved) === hex(code.bytes)),
            saved ? 'the bytes differ' : `no CODE header named "${program.code.name}"`);
    }
}

// Lines in each notation, and the bytes the Z80 manual gives for them.
const NOTATION = [
    ['LD A,$FF', 'ld a,#ff', 'LD A,0xFF', 'LD A,0FFh', 'LD A,255', 'LD A,%11111111', 'LD A,0b11111111', 'LD A,11111111b', '3e ff'],
    ["LD A,'a'", 'LD A,"a"', 'LD A,97', '3e 61'],
    ["CP ' '", 'CP 32', 'fe 20'],
    ['LD HL,HIGH $1234 + (LOW $1234 << 8)', 'LD HL,$3412', '21 12 34'],
    ['LD A,7 MOD 4', 'LD A,7 % 4', 'LD A,3', '3e 03'],
    ['LD A,(1 < 2) + (2 == 2) + (3 != 3) + !0', 'LD A,3', '3e 03'],
    ['LD A,~0 & $0F | $30 ^ $01', 'LD A,~0 AND $0F OR $30 XOR $01', 'LD A,$3F', '3e 3f'],
    ['LD A,1 << 5 | $80 >> 3', 'LD A,1 SHL 5 OR $80 SHR 3', 'LD A,$20 + $10', '3e 30'],
    ['LD A,0 + (2 == 2) + (2 = 2) + (2 != 3) + (2 <> 3) + (1 < 2) + (2 <= 2) + (3 > 2) + (2 >= 2)', 'LD A,8', '3e 08'],
    ['LD A,0 + (2 EQ 2) + (2 NE 3) + (1 LT 2) + (2 LE 2) + (3 GT 2) + (2 GE 2)', 'LD A,6', '3e 06'],
    ['LD A,0 + (3 == 3) + (3 <> 3) + (3 LT 2) + (3 LE 2) + (2 GT 3) + (2 GE 3) + (2 EQ 3) + (2 NE 2)', 'LD A,1', '3e 01'],
    ['LD A,(1 && 2) + (1 && 0) + (0 || 3) + (0 || 0) + NOT 0 + NOT 5', 'LD A,3', '3e 03'],
    ['LD A,-128', 'LD A,128', 'LD A,$80', '3e 80'], ['LD A,-1', 'LD A,255', 'LD A,~0', '3e ff'],
    ['LD HL,-1', 'LD HL,65535', '21 ff ff'], ['LD HL,-32768', 'LD HL,$8000', '21 00 80'],
    ['LD A,LOW 70000', 'LD A,70000 & 255', 'LD A,$70', '3e 70'], ['LD A,HIGH $12345', 'LD A,$23', '3e 23'],
    ['IM 0', 'ed 46'], ['IM 1', 'ed 56'], ['IM 2', 'ed 5e'],
    ['JR $FFFF', 'JR -1', '18 fd'], ['DJNZ $FFFE', '10 fc'],
    ['EX AF,AF\'', 'EX AF,AF', '08'],
    ['JP (HL)', 'JP HL', 'e9'],
    ['JP (IX)', 'JP IX', 'dd e9'],
    ['ADD A,B', '80'], ['SUB B', 'SUB A,B', '90'],
    ['RST $38', 'RST 38h', 'ff'],
    ['LD I,A', 'ed 47'], ['LD A,R', 'ed 5f'], ['IN E,(C)', 'ed 58'], ['OUT (C),A', 'ed 79'],
    ['SRL (IX+5)', 'dd cb 05 3e'], ['RL (IY-1)', 'fd cb ff 16'], ['EX (SP),IX', 'dd e3'], ['LD SP,IY', 'fd f9'],
    ['CPIR', 'ed b1'], ['RLD', 'ed 6f'], ['OTIR', 'ed b3'],
];
for (const row of NOTATION) {
    const want = row[row.length - 1];
    for (const line of row.slice(0, -1)) {
        let got;
        try {
            got = hex(assemble(`        ORG 0\n        ${line}`, 'notation').bytes);
        } catch (err) {
            got = err.message;
        }
        check(`${line} gives ${want}`, got === want, got);
    }
}

// The directives.
const DIRECTIVES = `
; a comment, and a line with only a label on it
START
        ORG $8000
COUNT   EQU 3
size    = 2
size    = size + 1          ; a variable may change
first:  DB 1, 'A', "BC", 'de', "x;y,z" ; quotes keep ; and , in
        DEFB COUNT
        DEFM "OK"
        DW first, $1234
        DEFW $ - first
        DS 2
        DEFS 2, $AA
        .ALIGN 4, $EE
aligned:
        IF COUNT > 2
        DB $11
        IF 0
        DB $FF
        ELSE
        DB $22
        ENDIF
        ELSE
        DB $FF
        ENDIF
        IFDEF COUNT
        DB size
        ENDIF
        IFNDEF COUNT
        DB $FF
        ENDIF
        ORG $8020
        DB HIGH aligned, LOW aligned
        END
        DB $FF
`;
const d = assemble(DIRECTIVES, 'directives');
check('directives: the origin', d.origin === 0x8000, String(d.origin));
check('directives: the bytes',
    hex(d.bytes) === '01 41 42 43 64 65 78 3b 79 2c 7a 03 4f 4b 00 80 34 12 12 00 00 00 aa aa 11 22 03 00 00 00 00 00 80 18',
    hex(d.bytes));
check('directives: labels', (d.labels.ALIGNED === 0x8018) && (d.labels.START === 0) && (d.labels.SIZE === 3));

/* INCLUDE and INCBIN, reading ZOOM's source and the 48K ROM, which starts
 * F3 AF 11 FF FF C3 CB 11 and ends A1 99 42 3C. */
{
    const zoom = hex(assemble(fs.readFileSync('starter/zoom.asm', 'utf8'), 'starter/zoom.asm').bytes);
    const source = [
        '        INCLUDE "zoom.asm"', '        INCBIN "../static/roms/48.rom",0,4', "        .INCBIN '../static/roms/48.rom',5,3",
        '        INCBIN ../static/roms/48.rom,16380',
    ].join('\n');
    let got;
    try {
        got = hex(assemble(source, 'files', { dir: 'starter' }).bytes);
    } catch (err) {
        got = err.message;
    }
    check('INCLUDE and INCBIN', got === `${zoom} f3 af 11 ff c3 cb 11 a1 99 42 3c`, got);
}

// Whole sources, and the bytes they must give.
for (const [what, source, want] of [
    ['DEFL spelled out', 'N DEFL 1\nN DEFL N + 1\n DB N\nN .DEFL N * 3\n DB N', '02 06'],
    ['ORG from a label defined above', 'START EQU $8000\n ORG START\n JP LATER\nLATER: NOP', 'c3 03 80 00'],
    ['IFNDEF of a label defined below it, in both passes', ' ORG 0\n JP AFTER\n IFNDEF FOO\nFOO EQU 1\n NOP\n ENDIF\nAFTER: NOP', 'c3 04 00 00 00'],
    ['IFDEF of a label defined below it, in both passes', ' ORG 0\n IFDEF LATER\n DB 1\n ENDIF\nLATER: DB 2\n DW LATER', '02 00 00'],
    ['a DB string with a comment after it', ' DB "a;b", \'c\' ; "d', '61 3b 62 63'],
    ['code that ends at $FFFF', ' ORG $FFFE\n LD A,1', '3e 01'],
    ['labels named as word operators', ' ORG 0\n DW GT+1, low+1, (low), HIGH GT, LOW low, 2 GT 1, LOW (-1)\nGT EQU 5\nlow EQU $302',
        '06 00 03 03 02 03 00 00 02 00 01 00 ff 00'],
]) {
    let got;
    try {
        got = hex(assemble(source, what).bytes);
    } catch (err) {
        got = err.message;
    }
    check(`${what} gives ${want}`, got === want, got);
}

// The disassembler leaves an instruction cut off by the end of the bytes as DB.
for (const [bytes, want] of [[[0x01], 'DB $01'], [[0x00, 0x21, 0x34], 'NOP|DB $21,$34'], [[0xdd, 0xcb, 0x05], 'DB $DD,$CB,$05']]) {
    const got = disassemble(Uint8Array.from(bytes), { origin: 0xfffd }).map(l => l.text).join('|');
    check(`${hex(bytes)} at the end disassembles as ${want}`, got === want, got);
}

/* Errors the assembler must give rather than guess, each naming the source
 * and the line (none for an IF left open at the end). */
for (const [what, source, line] of [
    ['a label defined twice', 'A: NOP\nA: NOP', 2],
    ['an EQU changed', 'X EQU 1\nX EQU 2', 2],
    ['ORG going back', ' ORG 10\n NOP\n ORG 5', 3],
    ['an IF with no ENDIF', ' IF 1\n NOP', null],
    ['a relative jump too far', ' ORG 0\n JR 200', 2],
    ['a relative jump too far round $FFFF', ' ORG $FFF0\n JR $90', 2],
    ['an instruction it does not know', ' LD (BC),B', 1],
    ['ORG from a label defined below it', ' ORG START\n JP LATER\nLATER: NOP\nSTART EQU $8000', 1],
    ['ORG past $FFFF', ' ORG $10000', 1],
    ['IM 3', ' NOP\n IM 3', 2],
    ['IM -1', ' IM -1', 1],
    ['LD A,B,C', ' LD A,B,C', 1],
    ['PUSH BC,DE', ' PUSH BC,DE', 1],
    ['INC A,B', ' INC A,B', 1],
    ['RST 8,9', ' RST 8,9', 1],
    ['NOP 1', ' NOP 1', 1],
    ['JP (HL),5', ' JP (HL),5', 1],
    ['SET 0,(IX+1),B', ' SET 0,(IX+1),B', 1],
    ['RLC (IX+1),A', ' RLC (IX+1),A', 1],
    ['DB "abc unclosed', ' NOP\n DB "abc', 2],
    ['DB "abc ; with the quote unclosed before a comment', ' DB "abc ; x', 1],
    ['LD A,256', ' LD A,256', 1],
    ['LD A,-129', ' LD A,-129', 1],
    ['DB 300', ' DB 300', 1],
    ['DW 70000', ' DW 70000', 1],
    ['DS 2,256', ' DS 2,256', 1],
    ['IN A,(300)', ' IN A,(300)', 1],
    ['OUT (256),A', ' OUT (256),A', 1],
    ['LD (IX+1),256', ' LD (IX+1),256', 1],
    ['LD HL,70000', ' LD HL,70000', 1],
    ['JP -32769', ' JP -32769', 1],
    ['LD A,X with X 300, defined below', ' LD A,X\nX EQU 300', 1],
    ['code running past $FFFF', ' ORG $FFFE\n NOP\n LD A,1', 3],
    ['LD A, with its second operand missing', ' LD A,', 1],
    ['LD ,A with its first operand missing', ' LD ,A', 1],
    ['DB 1,,2 with an operand missing', ' DB 1,,2', 1],
]) {
    let message = null;
    try {
        assemble(source, 'bad.asm');
    } catch (err) {
        message = err.message;
    }
    const where = (line === null) ? 'bad.asm: ' : `bad.asm:${line}: `;
    check(`refuses ${what}`, !!message && message.startsWith(where), message || 'assembled');
}

console.log(failures ? `${failures} failed` : 'All passed');
process.exit(failures ? 1 : 0);

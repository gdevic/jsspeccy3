/*
 * tools/z80asm.js: a two-pass Z80 assembler for the machine code in the
 * starter programs (starter/*.asm), which tools/gen-starter.js saves on
 * their cassettes. tools/z80dis.js is its other half, and what it prints
 * this reads back.
 *
 * Usage, from the command line (run from the project root):
 *   node tools/z80asm.js <source.asm> [output.bin]
 * prints the origin, the length and the labels, and writes the bytes to
 * output.bin if one is named.
 *
 * The source is written as the common Z80 assemblers (pasmo, sjasmplus,
 * z88dk) take it:
 *
 *   Lines     [label[:]] [instruction or directive] [; comment]
 *             A label ends in a colon, or starts in the first column
 *             without one. Case does not matter, in labels or anywhere
 *             else. Instructions are the documented Z80 ones in their
 *             Zilog form: ADD A,B and SUB B, (IX+d) and (IY+d), EX AF,AF',
 *             and JP (HL) (also JP HL), each with just the operands it
 *             takes. A relative jump (JR, DJNZ) reaches from 128 bytes
 *             back to 127 on from the instruction after it, counting on
 *             round from $FFFF to $0000.
 *   Numbers   decimal 255; hex $FF, #FF, 0xFF or 0FFh; binary %1010,
 *             0b1010 or 1010b; a character 'A' or "A"; $ alone is the
 *             address of the line. A byte's value must be from -128 to
 *             255 and a word's from -32768 to 65535, and the code may not
 *             run on past $FFFF.
 *   Operators by precedence, highest first, as in C:
 *               unary - + ~ ! and HIGH, LOW, NOT
 *               * / % (MOD)
 *               + -
 *               << >> (SHL, SHR)
 *               < <= > >= (LT, LE, GT, GE)
 *               == != (also = and <>; EQ, NE)
 *               & (AND), then ^ (XOR), then | (OR)
 *               && then ||
 *             with brackets. A comparison is 1 when it holds and 0 when
 *             not. HIGH and LOW are the high and low bytes of a word.
 *             A word operator is an operator only where one can stand:
 *             between two operands for the binary ones (MOD, SHL, AND,
 *             GT, ...), and before an operand for HIGH, LOW and NOT.
 *             Anywhere else it is a label, as GT is in LD A,GT and LOW in
 *             LOW+1 (and so LOW -1 is the label LOW less 1, where
 *             LOW (-1) is 255).
 *   Directives, each also with a leading dot (.ORG):
 *     ORG n                  the address of what follows. The first ORG
 *                            starts the code; a later one may only move
 *                            on, and the gap is filled with zeros.
 *     label EQU n            a constant, which may not change
 *     label = n, DEFL n      a value that may be set again further on
 *     DB, DEFB, DEFM, DM     bytes: numbers, and strings in either quote
 *     DW, DEFW               16-bit words, low byte first
 *     DS, DEFS n[,fill]      n bytes of fill (0 if left out)
 *     ALIGN n[,fill]         fill up to the next multiple of n
 *     INCLUDE "file"         the lines of another source, here
 *     INCBIN "file"[,skip[,length]]  the bytes of a file
 *     IF n / IFDEF label / IFNDEF label, ELSE, ENDIF
 *                            assemble the lines up to ELSE or ENDIF only
 *                            if n is not 0 (or the label is defined);
 *                            n must be known when the IF is reached
 *     END                    the end of the source; the rest is ignored
 *   An ORG, EQU, DS, ALIGN, INCBIN or IF uses only labels already defined
 *   above it, and an IFDEF or IFNDEF sees only those.
 *
 * assemble(source, name, options) returns {origin, bytes, labels}, labels
 * in capitals. `name` names the source in errors, and the folder an
 * INCLUDE or INCBIN reads from is `options.dir`, or else name's own.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const R8 = { B: 0, C: 1, D: 2, E: 3, H: 4, L: 5, '(HL)': 6, A: 7 };
const RR = { BC: 0, DE: 1, HL: 2, SP: 3 };
const RR_PUSH = { BC: 0, DE: 1, HL: 2, AF: 3 };
const CC = { NZ: 0, Z: 1, NC: 2, C: 3, PO: 4, PE: 5, P: 6, M: 7 };
const ALU = { ADD: 0, ADC: 1, SUB: 2, SBC: 3, AND: 4, XOR: 5, OR: 6, CP: 7 };
const ROT = { RLC: 0, RRC: 1, RL: 2, RR: 3, SLA: 4, SRA: 5, SRL: 7 };
const SIMPLE = {
    NOP: [0x00], RLCA: [0x07], RRCA: [0x0f], RLA: [0x17], RRA: [0x1f], DAA: [0x27], CPL: [0x2f], SCF: [0x37],
    CCF: [0x3f], HALT: [0x76], EXX: [0xd9], DI: [0xf3], EI: [0xfb], RET: [0xc9], NEG: [0xed, 0x44],
    LDI: [0xed, 0xa0], LDIR: [0xed, 0xb0], LDD: [0xed, 0xa8], LDDR: [0xed, 0xb8], RETI: [0xed, 0x4d],
    RETN: [0xed, 0x45], CPI: [0xed, 0xa1], CPIR: [0xed, 0xb1], CPD: [0xed, 0xa9], CPDR: [0xed, 0xb9],
    RLD: [0xed, 0x6f], RRD: [0xed, 0x67], INI: [0xed, 0xa2], INIR: [0xed, 0xb2], IND: [0xed, 0xaa],
    INDR: [0xed, 0xba], OUTI: [0xed, 0xa3], OTIR: [0xed, 0xb3], OUTD: [0xed, 0xab], OTDR: [0xed, 0xbb],
};

class AsmError extends Error {}

// The word operators, as the symbols they stand for.
const WORD_OPS = {
    MOD: '%', SHL: '<<', SHR: '>>', AND: '&', OR: '|', XOR: '^', NOT: '!',
    EQ: '==', NE: '!=', LT: '<', LE: '<=', GT: '>', GE: '>=', HIGH: 'HIGH', LOW: 'LOW',
};

// Binary operators by precedence, lowest first.
const LEVELS = [
    ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!=', '=', '<>'], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%'],
];
const BINARY = new Set(LEVELS.flat());

const NUMBER = /^(?:0[xX][0-9A-Fa-f]+|\$[0-9A-Fa-f]+|#[0-9A-Fa-f]+|%[01]+|0[bB][01]+(?![0-9A-Za-z_])|[0-9][0-9A-Fa-f]*[hH](?![0-9A-Za-z_])|[01]+[bB](?![0-9A-Za-z_])|\d+(?![0-9A-Za-z_]))/;
const TOKEN = new RegExp(`'.'|".(?=")"|${NUMBER.source.slice(1)}|[A-Za-z_][A-Za-z0-9_]*|\\$|<<|>>|<=|>=|==|!=|<>|&&|\\|\\||[-+*/%()&|^~!<>=]`, 'g');

// The value of a number token.
function numberValue(t) {
    if (/^0[xX]/.test(t)) return parseInt(t.slice(2), 16);
    if ((t[0] === '$') || (t[0] === '#')) return parseInt(t.slice(1), 16);
    if (t[0] === '%') return parseInt(t.slice(1), 2);
    if (/^0[bB][01]+$/.test(t)) return parseInt(t.slice(2), 2);
    if (/[hH]$/.test(t)) return parseInt(t.slice(0, -1), 16);
    if (/^[01]+[bB]$/.test(t)) return parseInt(t.slice(0, -1), 2);
    return parseInt(t, 10);
}

// The value of expression `text` with the labels known, $ being `here`; null for a label not known yet.
function evaluate(text, labels, here) {
    const source = String(text).trim();
    const tokens = source.match(TOKEN) || [];
    const squeezed = source.replace(/'.'|".(?=")"|\s+/g, m => (/^\s/.test(m) ? '' : m));
    if (!tokens.length || (tokens.join('') !== squeezed)) throw new AsmError(`cannot read "${text}"`);
    let at = 0;
    let unknown = false;
    const peek = () => {
        const t = tokens[at];
        return (t && WORD_OPS[t.toUpperCase()]) || t;
    };
    const unary = () => {
        let op = peek();
        const t = tokens[at++];
        if (t === undefined) throw new AsmError(`"${text}" ends too soon`);
        /* A word operator with no operand after it is a label, as LOW is in
         * LOW+1. A word after it is an operand, as GT is in HIGH GT. */
        const next = tokens[at];
        if (/^[A-Za-z]/.test(t) && ((next === undefined) || (next === ')') || (BINARY.has(next) && !/^[A-Za-z]/.test(next)))) op = null;
        switch (op) {
            case '(': {
                const v = binary(0);
                if (tokens[at++] !== ')') throw new AsmError(`a bracket is not closed in "${text}"`);
                return v;
            }
            case '-': return -unary();
            case '+': return unary();
            case '~': return ~unary();
            case '!': return unary() ? 0 : 1;
            case 'HIGH': return (unary() >> 8) & 0xff;
            case 'LOW': return unary() & 0xff;
        }
        if ((t[0] === "'") || (t[0] === '"')) return t.charCodeAt(1);
        if (t === '$') return here;
        if (NUMBER.test(t) && (NUMBER.exec(t)[0] === t)) return numberValue(t);
        const key = t.toUpperCase();
        if (!/^[A-Z_]/.test(key)) throw new AsmError(`cannot read "${text}"`);
        if (!(key in labels)) {
            unknown = true;
            return 0;
        }
        return labels[key];
    };
    const apply = (op, a, b) => {
        switch (op) {
            case '||': return (a || b) ? 1 : 0;
            case '&&': return (a && b) ? 1 : 0;
            case '|': return a | b;
            case '^': return a ^ b;
            case '&': return a & b;
            case '==': case '=': return (a === b) ? 1 : 0;
            case '!=': case '<>': return (a !== b) ? 1 : 0;
            case '<': return (a < b) ? 1 : 0;
            case '<=': return (a <= b) ? 1 : 0;
            case '>': return (a > b) ? 1 : 0;
            case '>=': return (a >= b) ? 1 : 0;
            case '<<': return a << b;
            case '>>': return a >> b;
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '/': case '%':
                if (b === 0) {
                    if (unknown) return 0;
                    throw new AsmError(`division by zero in "${text}"`);
                }
                return (op === '/') ? Math.trunc(a / b) : (a % b);
        }
        throw new AsmError(`cannot read "${text}"`);
    };
    function binary(level) {
        if (level === LEVELS.length) return unary();
        let v = binary(level + 1);
        while (LEVELS[level].includes(peek())) {
            const op = peek();
            at++;
            v = apply(op, v, binary(level + 1));
        }
        return v;
    }
    const value = binary(0);
    if (at !== tokens.length) throw new AsmError(`cannot read "${text}"`);
    return unknown ? null : value;
}

/* The length of a quoted string or character constant starting at `i` in
 * `text`, or 0 if none starts there. A single quote straight after a
 * letter or digit is not one, so that AF' is still a register. */
function quotedAt(text, i) {
    const q = text[i];
    if ((q !== '"') && (q !== "'")) return 0;
    if ((q === "'") && (i > 0) && /[A-Za-z0-9_]/.test(text[i - 1])) return 0;
    const end = text.indexOf(q, i + 1);
    if (end < 0) throw new AsmError(`the quote ${q} at "${text.slice(i)}" is not closed`);
    return end - i + 1;
}

// `text` without its comment: a semicolon outside quotes and all after it.
function stripComment(text) {
    for (let i = 0; i < text.length; i++) {
        const q = quotedAt(text, i);
        if (q) i += q - 1;
        else if (text[i] === ';') return text.slice(0, i);
    }
    return text;
}

// Splits an operand list at its top-level commas; none is left empty.
function splitOperands(text) {
    const out = [];
    let depth = 0;
    let start = 0;
    const add = (operand) => {
        if (!operand) throw new AsmError(`an operand is missing in "${text.trim()}"`);
        out.push(operand);
    };
    for (let i = 0; i < text.length; i++) {
        const q = quotedAt(text, i);
        if (q) i += q - 1;
        else if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        else if ((text[i] === ',') && !depth) {
            add(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    const last = text.slice(start).trim();
    if (last || out.length) add(last);
    return out;
}

// Expression `text` with its value `v`, for an error, or the value alone where it is the text.
const valued = (v, text) => (String(text).trim() === String(v)) ? String(v) : `${String(text).trim()} (${v})`;

// Value `v` of expression `text` as a byte, which may be written signed: -128 to 255.
function byteOf(v, text) {
    if ((v < -128) || (v > 255)) throw new AsmError(`${valued(v, text)} does not fit in a byte`);
    return v & 0xff;
}

// Value `v` of expression `text` as a word, which may be written signed: -32768 to 65535.
function wordOf(v, text) {
    if ((v < -32768) || (v > 65535)) throw new AsmError(`${valued(v, text)} does not fit in a word`);
    return v & 0xffff;
}

// How many operands each instruction may have; one in SIMPLE (bar RET) has none.
const OPERANDS = {
    LD: [2], ADD: [1, 2], ADC: [1, 2], SUB: [1, 2], SBC: [1, 2], AND: [1, 2], XOR: [1, 2], OR: [1, 2], CP: [1, 2],
    INC: [1], DEC: [1], JR: [1, 2], DJNZ: [1], JP: [1, 2], CALL: [1, 2], RET: [0, 1], PUSH: [1], POP: [1], EX: [2],
    BIT: [2], SET: [2], RES: [2], RLC: [1], RRC: [1], RL: [1], RR: [1], SLA: [1], SRA: [1], SRL: [1],
    IN: [2], OUT: [2], RST: [1], IM: [1],
};

/* One instruction as its bytes. `value(expr)` evaluates an expression
 * (0 while a label is still unknown in the first pass), `here` is its
 * address, and `final` says whether this is the second pass, where a
 * relative jump must reach. */
function encode(op, operands, value, here, final) {
    const counts = OPERANDS[op] || ((op in SIMPLE) ? [0] : null);
    if (counts && !counts.includes(operands.length)) {
        const plural = (Math.max(...counts) === 1) ? '' : 's';
        throw new AsmError(`${op} takes ${counts.join(' or ')} operand${plural}, not ${operands.length}`);
    }
    const U = operands.map(o => o.toUpperCase().replace(/\s+/g, ''));
    const n8 = (e) => byteOf(value(e), e);
    const n16 = (e) => { const v = wordOf(value(e), e); return [v & 0xff, v >> 8]; };
    const mem = (o) => /^\(.*\)$/.test(o);
    const inner = (o) => o.trim().slice(1, -1);
    const index = (o) => {
        const m = o.toUpperCase().replace(/\s+/g, '').match(/^\((IX|IY)([+-].*)?\)$/);
        if (!m) return null;
        const d = m[2] ? value(m[2]) : 0;
        if ((d < -128) || (d > 127)) throw new AsmError(`index ${d} is out of range`);
        return { prefix: (m[1] === 'IX') ? 0xdd : 0xfd, d: d & 0xff };
    };
    const reg16x = (o) => ({ IX: 0xdd, IY: 0xfd })[o];
    // The distance counts on round from $FFFF to $0000, as the Z80's PC does: JR $FFFF at $0000 is a jump of -3.
    const rel = (e) => {
        if (!final) return 0;
        const d = (((wordOf(value(e), e) - (here + 2)) + 0x8000) & 0xffff) - 0x8000;
        if ((d < -128) || (d > 127)) throw new AsmError(`a relative jump of ${d} is too far`);
        return d & 0xff;
    };
    const [a, b] = U;
    const [ra, rb] = operands;
    if ((op in SIMPLE) && !operands.length) return SIMPLE[op];
    switch (op) {
        case 'LD': {
            if ((a in R8) && (b in R8) && !((a === '(HL)') && (b === '(HL)'))) return [0x40 | (R8[a] << 3) | R8[b]];
            const ia = index(ra);
            const ib = index(rb);
            if (ia && (b in R8) && (b !== '(HL)')) return [ia.prefix, 0x70 | R8[b], ia.d];
            if (ib && (a in R8) && (a !== '(HL)')) return [ib.prefix, 0x46 | (R8[a] << 3), ib.d];
            if (ia) return [ia.prefix, 0x36, ia.d, n8(rb)];
            if ((a === 'A') && (b === '(BC)')) return [0x0a];
            if ((a === 'A') && (b === '(DE)')) return [0x1a];
            if ((a === '(BC)') && (b === 'A')) return [0x02];
            if ((a === '(DE)') && (b === 'A')) return [0x12];
            if ((a === 'SP') && (b === 'HL')) return [0xf9];
            if ((a === 'SP') && reg16x(b)) return [reg16x(b), 0xf9];
            if ((a === 'I') && (b === 'A')) return [0xed, 0x47];
            if ((a === 'R') && (b === 'A')) return [0xed, 0x4f];
            if ((a === 'A') && (b === 'I')) return [0xed, 0x57];
            if ((a === 'A') && (b === 'R')) return [0xed, 0x5f];
            if ((a === 'A') && mem(rb)) return [0x3a, ...n16(inner(rb))];
            if (mem(ra) && (b === 'A')) return [0x32, ...n16(inner(ra))];
            if ((a === 'HL') && mem(rb)) return [0x2a, ...n16(inner(rb))];
            if (mem(ra) && (b === 'HL')) return [0x22, ...n16(inner(ra))];
            if (reg16x(a) && mem(rb)) return [reg16x(a), 0x2a, ...n16(inner(rb))];
            if (mem(ra) && reg16x(b)) return [reg16x(b), 0x22, ...n16(inner(ra))];
            if ((a in RR) && mem(rb)) return [0xed, 0x4b | (RR[a] << 4), ...n16(inner(rb))];
            if (mem(ra) && (b in RR)) return [0xed, 0x43 | (RR[b] << 4), ...n16(inner(ra))];
            if (a in RR) return [0x01 | (RR[a] << 4), ...n16(rb)];
            if (reg16x(a)) return [reg16x(a), 0x21, ...n16(rb)];
            if (a in R8) return [0x06 | (R8[a] << 3), n8(rb)];
            break;
        }
        case 'ADD': case 'ADC': case 'SUB': case 'SBC': case 'AND': case 'XOR': case 'OR': case 'CP': {
            if ((operands.length === 2) && (a === 'HL') && (b in RR)) {
                if (op === 'ADD') return [0x09 | (RR[b] << 4)];
                if (op === 'ADC') return [0xed, 0x4a | (RR[b] << 4)];
                if (op === 'SBC') return [0xed, 0x42 | (RR[b] << 4)];
            }
            if ((operands.length === 2) && reg16x(a) && (op === 'ADD')) {
                const rr = (b === a) ? 2 : RR[b];
                if ((rr !== undefined) && (b !== 'HL')) return [reg16x(a), 0x09 | (rr << 4)];
            }
            const src = (operands.length === 2) ? (a === 'A' ? rb : null) : ra;
            if (src === null) break;
            const s = src.toUpperCase().replace(/\s+/g, '');
            if (s in R8) return [0x80 | (ALU[op] << 3) | R8[s]];
            const is = index(src);
            if (is) return [is.prefix, 0x86 | (ALU[op] << 3), is.d];
            return [0xc6 | (ALU[op] << 3), n8(src)];
        }
        case 'INC': case 'DEC': {
            const dec = (op === 'DEC') ? 1 : 0;
            if (a in R8) return [0x04 | (R8[a] << 3) | dec];
            if (a in RR) return [0x03 | (RR[a] << 4) | (dec << 3)];
            if (reg16x(a)) return [reg16x(a), 0x23 | (dec << 3)];
            const ia = index(ra);
            if (ia) return [ia.prefix, 0x34 | dec, ia.d];
            break;
        }
        case 'JR':
            if (operands.length === 1) return [0x18, rel(ra)];
            if (CC[a] !== undefined && CC[a] < 4) return [0x20 | (CC[a] << 3), rel(rb)];
            break;
        case 'DJNZ':
            return [0x10, rel(ra)];
        case 'JP':
            if (operands.length === 2) {
                if (a in CC) return [0xc2 | (CC[a] << 3), ...n16(rb)];
                break;
            }
            if ((a === '(HL)') || (a === 'HL')) return [0xe9];
            if ((a === 'IX') || (a === 'IY')) return [reg16x(a), 0xe9];
            if ((a === '(IX)') || (a === '(IY)')) return [reg16x(inner(a)), 0xe9];
            return [0xc3, ...n16(ra)];
        case 'CALL':
            if (operands.length === 1) return [0xcd, ...n16(ra)];
            if (a in CC) return [0xc4 | (CC[a] << 3), ...n16(rb)];
            break;
        case 'RET':
            if (a in CC) return [0xc0 | (CC[a] << 3)];
            break;
        case 'PUSH': case 'POP': {
            const base = (op === 'PUSH') ? 0xc5 : 0xc1;
            if (a in RR_PUSH) return [base | (RR_PUSH[a] << 4)];
            if (reg16x(a)) return [reg16x(a), base | 0x20];
            break;
        }
        case 'EX':
            if ((a === 'DE') && (b === 'HL')) return [0xeb];
            if ((a === 'AF') && ((b === "AF'") || (b === 'AF'))) return [0x08];
            if ((a === '(SP)') && (b === 'HL')) return [0xe3];
            if ((a === '(SP)') && reg16x(b)) return [reg16x(b), 0xe3];
            break;
        case 'BIT': case 'SET': case 'RES': {
            const bit = value(ra);
            if ((bit < 0) || (bit > 7)) throw new AsmError(`bit ${bit} is out of range`);
            const base = { BIT: 0x40, RES: 0x80, SET: 0xc0 }[op] | (bit << 3);
            if (b in R8) return [0xcb, base | R8[b]];
            const ib = index(rb);
            if (ib) return [ib.prefix, 0xcb, ib.d, base | 6];
            break;
        }
        case 'RLC': case 'RRC': case 'RL': case 'RR': case 'SLA': case 'SRA': case 'SRL':
            if (a in R8) return [0xcb, (ROT[op] << 3) | R8[a]];
            {
                const ia = index(ra);
                if (ia) return [ia.prefix, 0xcb, ia.d, (ROT[op] << 3) | 6];
            }
            break;
        case 'IN':
            if ((a in R8) && (a !== '(HL)') && (b === '(C)')) return [0xed, 0x40 | (R8[a] << 3)];
            if ((a === 'A') && mem(rb) && (inner(rb).toUpperCase() !== 'C')) return [0xdb, n8(inner(rb))];
            break;
        case 'OUT':
            if ((a === '(C)') && (b in R8) && (b !== '(HL)')) return [0xed, 0x41 | (R8[b] << 3)];
            if (mem(ra) && (b === 'A') && (inner(ra).toUpperCase() !== 'C')) return [0xd3, n8(inner(ra))];
            break;
        case 'RST': {
            const n = value(ra);
            if ((n & ~0x38) !== 0) throw new AsmError(`RST ${n} is not a restart address`);
            return [0xc7 | n];
        }
        case 'IM': {
            const n = value(ra);
            if (![0, 1, 2].includes(n)) throw new AsmError(`IM ${n} is not an interrupt mode`);
            return [0xed, [0x46, 0x56, 0x5e][n]];
        }
    }
    throw new AsmError(`${op} ${operands.join(',')} is not an instruction this assembler knows`);
}

// Every instruction's name, for telling a label in the first column from an instruction there.
const MNEMONICS = new Set([
    ...Object.keys(SIMPLE), 'LD', 'ADD', 'ADC', 'SUB', 'SBC', 'AND', 'XOR', 'OR', 'CP', 'INC', 'DEC', 'JR', 'DJNZ',
    'JP', 'CALL', 'RET', 'PUSH', 'POP', 'EX', 'BIT', 'SET', 'RES', 'RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SRL',
    'IN', 'OUT', 'IM', 'RST',
]);

// Each directive under its other names.
const DIRECTIVES = {
    ORG: 'ORG', EQU: 'EQU', DEFL: 'DEFL', DB: 'DB', DEFB: 'DB', DEFM: 'DB', DM: 'DB', DW: 'DW', DEFW: 'DW',
    DS: 'DS', DEFS: 'DS', ALIGN: 'ALIGN', INCLUDE: 'INCLUDE', INCBIN: 'INCBIN', IF: 'IF', IFDEF: 'IFDEF',
    IFNDEF: 'IFNDEF', ELSE: 'ELSE', ENDIF: 'ENDIF', END: 'END',
};

// The directive `word` names, with or without its leading dot, or null.
function directive(word) {
    const key = word.toUpperCase().replace(/^\./, '');
    return DIRECTIVES[key] || null;
}

// A file name written in quotes, or bare.
const fileName = (text) => String(text).trim().replace(/^(["'])(.*)\1$/, '$2');

export function assemble(source, name = 'source', options = {}) {
    const dir = options.dir || path.dirname(name);
    const labels = {};
    const variables = new Set();  // labels set with = or DEFL, which may change
    const defined = new Set();  // the labels set so far in this pass
    const trail = [];  // each setting of a label in the first pass, in order: [name, value]
    let step = 0;  // how far the second pass is along `trail`
    let origin = null;
    let bytes = [];
    let pass = 1;
    let pc = 0;
    let ended = false;

    const emit = (out) => {
        if (origin === null) origin = pc;
        if ((pc + out.length) > 0x10000) throw new AsmError('the code runs on past $FFFF');
        for (const b of out) bytes.push(b);
        pc += out.length;
    };

    /* Sets label `key` to `v`. The second pass must set each label to what
     * the first set it to at the same place, or code assembled with a
     * label's first-pass value is wrong. */
    const define = (key, v) => {
        if (pass === 1) trail.push([key, v]);
        else {
            const [was, then] = trail[step++] || [];
            if ((was !== key) || (then !== v)) {
                const first = (was === undefined) ? 'nothing more' : `${was} to ${then}`;
                throw new AsmError(`phase error: the second pass sets ${key} to ${v} where the first set ${first}`);
            }
        }
        labels[key] = v;
        defined.add(key);
    };

    // The lines of `text`, named `file` in errors, assembled in turn.
    function run(text, file, depth) {
        if (depth > 16) throw new Error(`${file}: INCLUDE goes too deep`);
        const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
        const conditions = [];  // for each IF open: {on, seenElse, outer}
        const active = () => conditions.every(c => c.on);
        for (let i = 0; (i < lines.length) && !ended; i++) {
            const where = `${file}:${i + 1}`;
            try {
                line(lines[i], conditions, active, depth);
            } catch (err) {
                if (err instanceof AsmError) throw new Error(`${where}: ${err.message}`);
                throw err;
            }
        }
        if (conditions.length && !ended) throw new Error(`${file}: an IF has no ENDIF`);
    }

    function line(raw, conditions, active, depth) {
        let text = stripComment(raw).replace(/\s+$/, '');
        if (!text.trim()) return;

        // The label: NAME: anywhere, or NAME in the first column.
        let label = null;
        const colon = text.match(/^\s*([A-Za-z_.][A-Za-z0-9_.]*):(?!=)\s*(.*)$/);
        if (colon) {
            label = colon[1];
            text = colon[2];
        } else {
            const first = text.match(/^([A-Za-z_.][A-Za-z0-9_.]*)(?=\s|=|$)\s*(.*)$/);
            if (first && !MNEMONICS.has(first[1].toUpperCase()) && !directive(first[1])) {
                label = first[1];
                text = first[2];
            }
        }
        text = text.trim();

        const m = text.match(/^(\.?[A-Za-z]+|=)\s*(.*)$/);
        const word = m ? m[1] : '';
        const kind = (word === '=') ? 'DEFL' : directive(word);

        // The conditionals are followed even where the lines around them are left out.
        if ((kind === 'IF') || (kind === 'IFDEF') || (kind === 'IFNDEF')) {
            let on = false;
            if (active()) {
                if (kind === 'IF') {
                    const v = evaluate(m[2], labels, pc);
                    if (v === null) throw new AsmError(`IF ${m[2]} uses a label not known yet`);
                    on = (v !== 0);
                } else {
                    on = defined.has(m[2].trim().toUpperCase()) === (kind === 'IFDEF');
                }
            }
            conditions.push({ on, seenElse: false });
            return;
        }
        if (kind === 'ELSE') {
            const c = conditions[conditions.length - 1];
            if (!c || c.seenElse) throw new AsmError('ELSE without IF');
            c.seenElse = true;
            c.on = !c.on && conditions.slice(0, -1).every(x => x.on);
            return;
        }
        if (kind === 'ENDIF') {
            if (!conditions.length) throw new AsmError('ENDIF without IF');
            conditions.pop();
            return;
        }
        if (!active()) return;

        // A constant or variable: NAME EQU n, NAME = n, NAME DEFL n.
        if ((kind === 'EQU') || (kind === 'DEFL')) {
            if (!label) throw new AsmError(`${word} needs a label`);
            const key = label.toUpperCase();
            const v = evaluate(m[2], labels, pc);
            if (v === null) throw new AsmError(`${word} ${m[2]} uses a label not known yet`);
            if (kind === 'EQU') {
                if ((pass === 1) && (key in labels)) throw new AsmError(`${key} is defined twice`);
            } else {
                if ((pass === 1) && (key in labels) && !variables.has(key)) throw new AsmError(`${key} is defined twice`);
                variables.add(key);
            }
            define(key, v);
            return;
        }

        if (label) {
            const key = label.toUpperCase();
            if ((pass === 1) && (key in labels)) throw new AsmError(`${key} is defined twice`);
            define(key, pc);
        }
        if (!text) return;
        if (!m) throw new AsmError(`cannot read "${text}"`);

        const operands = splitOperands(m[2]);
        const value = (e) => {
            const v = evaluate(e, labels, pc);
            if (v === null) {
                if (pass === 2) throw new AsmError(`"${e}" uses a label never defined`);
                return 0;
            }
            return v;
        };
        const known = (e, what) => {
            const v = evaluate(e, labels, pc);
            if (v === null) throw new AsmError(`${what} ${e} uses a label not known yet`);
            return v;
        };

        switch (kind) {
            case 'ORG': {
                const to = known(operands[0], 'ORG');
                if ((to < 0) || (to > 0xffff)) throw new AsmError(`ORG ${valued(to, operands[0])} is outside $0000 to $FFFF`);
                if (origin === null) pc = to;
                else if (to < pc) throw new AsmError(`ORG ${operands[0]} goes back, to before what is already there`);
                else emit(new Array(to - pc).fill(0));
                return;
            }
            case 'DB':
                emit(operands.flatMap((o) => {
                    const q = quotedAt(o, 0);
                    if ((q === o.length) && (q !== 3)) return Array.from(o.slice(1, -1), c => c.charCodeAt(0));
                    return [byteOf(value(o), o)];
                }));
                return;
            case 'DW':
                emit(operands.flatMap((o) => { const v = wordOf(value(o), o); return [v & 0xff, v >> 8]; }));
                return;
            case 'DS': {
                const n = known(operands[0], 'DS');
                if (n < 0) throw new AsmError(`DS ${n} is negative`);
                emit(new Array(n).fill((operands.length > 1) ? byteOf(value(operands[1]), operands[1]) : 0));
                return;
            }
            case 'ALIGN': {
                const n = known(operands[0], 'ALIGN');
                if (n < 1) throw new AsmError(`ALIGN ${n} is not a size`);
                emit(new Array((n - (pc % n)) % n).fill((operands.length > 1) ? byteOf(value(operands[1]), operands[1]) : 0));
                return;
            }
            case 'INCLUDE': {
                const file = path.join(dir, fileName(m[2]));
                run(fs.readFileSync(file, 'utf8'), file, depth + 1);
                return;
            }
            case 'INCBIN': {
                const file = path.join(dir, fileName(operands[0]));
                const data = fs.readFileSync(file);
                const skip = (operands.length > 1) ? known(operands[1], 'INCBIN') : 0;
                const length = (operands.length > 2) ? known(operands[2], 'INCBIN') : (data.length - skip);
                emit(Array.from(data.subarray(skip, skip + length)));
                return;
            }
            case 'END':
                ended = true;
                return;
            case 'EQU': case 'DEFL': case null:
                break;
        }
        if (kind) throw new AsmError(`${word} is not used that way`);
        emit(encode(word.toUpperCase(), operands, value, pc, pass === 2));
    }

    for (pass = 1; pass <= 2; pass++) {
        pc = 0;
        bytes = [];
        origin = null;
        ended = false;
        defined.clear();
        step = 0;
        run(source, name, 0);
    }
    if (step !== trail.length) throw new Error(`${name}: phase error: the second pass does not set ${trail[step][0]}, which the first set`);
    return { origin: (origin === null) ? pc : origin, bytes: Uint8Array.from(bytes), labels };
}

function main(argv) {
    if (!argv.length) {
        console.log('Usage: node tools/z80asm.js <source.asm> [output.bin]');
        process.exit(1);
    }
    const { origin, bytes, labels } = assemble(fs.readFileSync(argv[0], 'utf8'), argv[0]);
    const hex = (n) => `$${n.toString(16).toUpperCase().padStart(4, '0')}`;
    console.log(`${argv[0]}: ${bytes.length} bytes at ${hex(origin)} (${origin}) to ${hex(origin + bytes.length - 1)}`);
    for (const [label, v] of Object.entries(labels).sort((a, b) => a[1] - b[1])) console.log(`  ${hex(v & 0xffff)}  ${label}`);
    if (argv[1]) fs.writeFileSync(argv[1], bytes);
}

if (process.argv[1] && (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) main(process.argv.slice(2));

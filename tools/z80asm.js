/*
 * tools/z80asm.js: a small two-pass Z80 assembler, enough for the machine
 * code in the starter programs (starter/*.asm), which tools/gen-starter.js
 * puts into a listing's DATA lines.
 *
 * A line is an optional label (ending in a colon, or before EQU), an
 * instruction or directive, and an optional comment after a semicolon.
 * The directives are ORG, EQU, DB and DW. Numbers are decimal, $hex or
 * %binary, and expressions take labels, + - * / and brackets; $ alone is
 * the address of the line. Instructions are the documented Z80 ones in
 * their usual Zilog form, with IX and IY as 16-bit registers and (IX+d)
 * and (IY+d) as operands; anything else is refused with its line.
 *
 * assemble(source, name) returns {origin, bytes, labels}.
 */

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
};

class AsmError extends Error {}

// The value of expression `text` with the labels known, $ being `here`; null for a label not known yet.
function evaluate(text, labels, here) {
    const tokens = text.match(/\$[0-9A-Fa-f]+|%[01]+|\d+|[A-Za-z_][A-Za-z0-9_]*|\$|[-+*/()]/g);
    if (!tokens || (tokens.join('') !== text.replace(/\s+/g, ''))) throw new AsmError(`cannot read "${text}"`);
    let at = 0;
    let unknown = false;
    const atom = () => {
        const t = tokens[at++];
        if (t === undefined) throw new AsmError(`"${text}" ends too soon`);
        if (t === '(') {
            const v = sum();
            if (tokens[at++] !== ')') throw new AsmError(`a bracket is not closed in "${text}"`);
            return v;
        }
        if (t === '-') return -atom();
        if (t === '+') return atom();
        if (t === '$') return here;
        if (t[0] === '$') return parseInt(t.slice(1), 16);
        if (t[0] === '%') return parseInt(t.slice(1), 2);
        if (/^\d/.test(t)) return parseInt(t, 10);
        const key = t.toUpperCase();
        if (!(key in labels)) {
            unknown = true;
            return 0;
        }
        return labels[key];
    };
    const product = () => {
        let v = atom();
        while ((tokens[at] === '*') || (tokens[at] === '/')) v = (tokens[at++] === '*') ? v * atom() : Math.trunc(v / atom());
        return v;
    };
    const sum = () => {
        let v = product();
        while ((tokens[at] === '+') || (tokens[at] === '-')) v = (tokens[at++] === '+') ? v + product() : v - product();
        return v;
    };
    const value = sum();
    if (at !== tokens.length) throw new AsmError(`cannot read "${text}"`);
    return unknown ? null : value;
}

// Splits an operand list at its top-level commas.
function splitOperands(text) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        else if ((text[i] === ',') && !depth) {
            out.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    const last = text.slice(start).trim();
    if (last) out.push(last);
    return out;
}

/* One instruction as its bytes. `value(expr)` evaluates an expression
 * (0 while a label is still unknown in the first pass), `here` is its
 * address, and `final` says whether this is the second pass, where a
 * relative jump must reach. */
function encode(op, operands, value, here, final) {
    const U = operands.map(o => o.toUpperCase().replace(/\s+/g, ''));
    const n8 = (e) => value(e) & 0xff;
    const n16 = (e) => { const v = value(e) & 0xffff; return [v & 0xff, v >> 8]; };
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
    const rel = (e) => {
        if (!final) return 0;
        const d = value(e) - (here + 2);
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
            if (a === '(HL)') return [0xe9];
            if (operands.length === 1) return [0xc3, ...n16(ra)];
            if (a in CC) return [0xc2 | (CC[a] << 3), ...n16(rb)];
            break;
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
            if ((a === 'AF') && (b === "AF'")) return [0x08];
            if ((a === '(SP)') && (b === 'HL')) return [0xe3];
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
            break;
        case 'IN':
            if ((a === 'A') && mem(rb) && (inner(rb).toUpperCase() !== 'C')) return [0xdb, n8(inner(rb))];
            break;
        case 'OUT':
            if (mem(ra) && (b === 'A') && (inner(ra).toUpperCase() !== 'C')) return [0xd3, n8(inner(ra))];
            break;
        case 'IM':
            return [0xed, [0x46, 0x56, 0x5e][value(ra)]];
    }
    throw new AsmError(`${op} ${operands.join(',')} is not an instruction this assembler knows`);
}

export function assemble(source, name = 'source') {
    const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
    const labels = {};
    let origin = null;
    let bytes = [];
    for (const pass of [1, 2]) {
        let pc = 0;
        bytes = [];
        origin = null;
        lines.forEach((raw, i) => {
            const where = `${name}:${i + 1}`;
            try {
                let text = raw.replace(/;.*$/, '').trim();
                if (!text) return;
                let label = null;
                const colon = text.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
                if (colon) {
                    label = colon[1].toUpperCase();
                    text = colon[2];
                } else {
                    const equ = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+EQU\s+(.*)$/i);
                    if (equ) {
                        const v = evaluate(equ[2], labels, pc);
                        if (v === null) throw new AsmError(`EQU ${equ[2]} uses a label not known yet`);
                        labels[equ[1].toUpperCase()] = v;
                        return;
                    }
                }
                if (label) {
                    if ((pass === 1) && (label in labels)) throw new AsmError(`${label} is defined twice`);
                    labels[label] = pc;
                }
                if (!text) return;
                const m = text.match(/^([A-Za-z]+)\s*(.*)$/);
                if (!m) throw new AsmError(`cannot read "${text}"`);
                const op = m[1].toUpperCase();
                const operands = splitOperands(m[2]);
                const value = (e) => {
                    const v = evaluate(e, labels, pc);
                    if (v === null) {
                        if (pass === 2) throw new AsmError(`"${e}" uses a label never defined`);
                        return 0;
                    }
                    return v;
                };
                if (op === 'ORG') {
                    pc = value(operands[0]);
                    if (origin === null) origin = pc;
                    else if (pc !== origin + bytes.length) throw new AsmError('ORG may only start the code');
                    return;
                }
                if (origin === null) origin = pc;
                let out;
                if (op === 'DB') out = operands.flatMap(o => /^".*"$/.test(o) ? Array.from(o.slice(1, -1), c => c.charCodeAt(0)) : [value(o) & 0xff]);
                else if (op === 'DW') out = operands.flatMap(o => { const v = value(o) & 0xffff; return [v & 0xff, v >> 8]; });
                else out = encode(op, operands, value, pc, pass === 2);
                bytes.push(...out);
                pc += out.length;
            } catch (err) {
                if (err instanceof AsmError) throw new Error(`${where}: ${err.message}`);
                throw err;
            }
        });
    }
    return { origin, bytes: Uint8Array.from(bytes), labels };
}

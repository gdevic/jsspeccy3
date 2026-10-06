/*
 * tools/z80dis.js: a Z80 disassembler, the other half of tools/z80asm.js,
 * for reading machine code such as the Spectrum's ROM routines that the
 * starter programs call (starter/*.asm), and for checking what the
 * assembler made.
 *
 * Usage (run from the project root):
 *   node tools/z80dis.js <file> [start] [count] [--origin n]
 *
 * <file> is a ROM or any binary, or one of rom48, rom128-0, rom128-1 for
 * the ROMs in static/roms. [start] is the address to start from and
 * [count] how many instructions to show (20 if left out); --origin is the
 * address of the file's first byte (0 if left out). Numbers are decimal or
 * $hex (0x hex also does, since a shell may read $).
 *
 * The output is assembly source, as tools/z80asm.js and the common Z80
 * assemblers read it: an ORG for the first address, then one instruction
 * a line in Zilog form, in capitals, numbers as $hex and every relative
 * jump shown with the address it reaches, and after each a comment with
 * its address and bytes:
 *
 *         ORG $1855
 *         LD BC,($5C49)               ; $1855  ED 4B 49 5C
 *
 * The documented instructions come out as instructions; anything else (the
 * IXH and IXL halves, SLL, an ED code with no instruction, a DD or FD
 * prefix with nothing to change, an instruction cut off by the end of the
 * bytes) comes out as DB, so that the text assembles back to the same
 * bytes. A relative jump that goes round from $FFFF to $0000 shows the
 * address it reaches, which tools/z80asm.js counts round the same way.
 *
 * disassemble(bytes, {origin, start, count, end}) returns one
 * {address, bytes, text} for each instruction from `start`, stopping after
 * `count` of them or at `end`, whichever comes first, or at the end of the
 * bytes. disassembleOne(read, address) returns {length, text} for the
 * instruction at `address`, `read(addr)` giving the byte there.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const R8 = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];
const RR = ['BC', 'DE', 'HL', 'SP'];
const RR_PUSH = ['BC', 'DE', 'HL', 'AF'];
const CC = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];
const ALU = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '];
const ROT = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', null, 'SRL'];
const ACC = ['RLCA', 'RRCA', 'RLA', 'RRA', 'DAA', 'CPL', 'SCF', 'CCF'];
const BLOCK = [
    ['LDI', 'CPI', 'INI', 'OUTI'], ['LDD', 'CPD', 'IND', 'OUTD'],
    ['LDIR', 'CPIR', 'INIR', 'OTIR'], ['LDDR', 'CPDR', 'INDR', 'OTDR'],
];

const hex2 = (n) => `$${n.toString(16).toUpperCase().padStart(2, '0')}`;
const hex4 = (n) => `$${n.toString(16).toUpperCase().padStart(4, '0')}`;

// An index register's operand, (IX+d) or (IY-d).
const indexed = (reg, d) => `(${reg}${(d < 0) ? '-' : '+'}${Math.abs(d)})`;

/* The instruction at `address`: {length, text}. `read(addr)` gives the byte
 * at addr (taken modulo 65536). */
export function disassembleOne(read, address) {
    let pc = address;
    const byte = () => read((pc++) & 0xffff);
    const word = () => { const lo = byte(); return lo | (byte() << 8); };
    const signed = () => { const v = byte(); return (v > 127) ? (v - 256) : v; };
    const done = (text) => ({ length: pc - address, text });
    const db = (count) => {
        pc = address;
        const bytes = Array.from({ length: count }, byte);
        return done(`DB ${bytes.map(hex2).join(',')}`);
    };

    let op = byte();
    let index = null;
    if ((op === 0xdd) || (op === 0xfd)) {
        index = (op === 0xdd) ? 'IX' : 'IY';
        op = byte();
        // A second prefix, or ED, makes this one do nothing.
        if ((op === 0xdd) || (op === 0xfd) || (op === 0xed)) return db(1);
    }

    if (op === 0xcb) {
        if (index) {
            const d = signed();
            const sub = byte();
            const x = sub >> 6, y = (sub >> 3) & 7, z = sub & 7;
            if (z !== 6) return db(4);  // the undocumented copies into a register
            const target = indexed(index, d);
            if (x === 0) return ROT[y] ? done(`${ROT[y]} ${target}`) : db(4);
            return done(`${['', 'BIT', 'RES', 'SET'][x]} ${y},${target}`);
        }
        const sub = byte();
        const x = sub >> 6, y = (sub >> 3) & 7, z = sub & 7;
        if (x === 0) return ROT[y] ? done(`${ROT[y]} ${R8[z]}`) : db(2);
        return done(`${['', 'BIT', 'RES', 'SET'][x]} ${y},${R8[z]}`);
    }

    if (op === 0xed) {
        const sub = byte();
        const x = sub >> 6, y = (sub >> 3) & 7, z = sub & 7, p = y >> 1, q = y & 1;
        if (x === 1) {
            switch (z) {
                case 0: return (y === 6) ? db(2) : done(`IN ${R8[y]},(C)`);
                case 1: return (y === 6) ? db(2) : done(`OUT (C),${R8[y]}`);
                case 2: return done(`${q ? 'ADC' : 'SBC'} HL,${RR[p]}`);
                case 3: {
                    // LD HL,(nn) has a shorter code of its own, so the ED form is left as bytes.
                    if (p === 2) return db(4);
                    const nn = hex4(word());
                    return done(q ? `LD ${RR[p]},(${nn})` : `LD (${nn}),${RR[p]}`);
                }
                case 4: return (y === 0) ? done('NEG') : db(2);
                case 5: return (y === 0) ? done('RETN') : (y === 1) ? done('RETI') : db(2);
                case 6: return [0, 2, 3].includes(y) ? done(`IM ${[0, null, 1, 2][y]}`) : db(2);
                default: return (y < 6) ? done(['LD I,A', 'LD R,A', 'LD A,I', 'LD A,R', 'RRD', 'RLD'][y]) : db(2);
            }
        }
        if ((x === 2) && (z <= 3) && (y >= 4)) return done(BLOCK[y - 4][z]);
        return db(2);
    }

    const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
    const hl = index || 'HL';
    // A register operand under an index prefix: H and L would be the undocumented halves.
    const halves = (r) => index && ((r === 4) || (r === 5));
    const usesHL = (r) => (r === 6);

    if (x === 1) {
        if (op === 0x76) return index ? db(1) : done('HALT');
        if (index && (usesHL(y) || usesHL(z))) {
            const d = signed();
            const target = indexed(index, d);
            return done(`LD ${usesHL(y) ? target : R8[y]},${usesHL(z) ? target : R8[z]}`);
        }
        if (halves(y) || halves(z) || index) return db(1);
        return done(`LD ${R8[y]},${R8[z]}`);
    }
    if (x === 2) {
        if (index && usesHL(z)) return done(`${ALU[y]}${indexed(index, signed())}`);
        if (index) return db(1);
        return done(`${ALU[y]}${R8[z]}`);
    }
    if (x === 0) {
        switch (z) {
            case 0: {
                if (index) return db(1);
                if (y === 0) return done('NOP');
                if (y === 1) return done("EX AF,AF'");
                const d = signed();
                const target = hex4((pc + d) & 0xffff);
                if (y === 2) return done(`DJNZ ${target}`);
                if (y === 3) return done(`JR ${target}`);
                return done(`JR ${CC[y - 4]},${target}`);
            }
            case 1:
                if (index && (p !== 2) && !q) return db(1);
                if (q) return done(`ADD ${hl},${(p === 2) ? hl : RR[p]}`);
                return done(`LD ${(p === 2) ? hl : RR[p]},${hex4(word())}`);
            case 2: {
                if (index && (p !== 2)) return db(1);
                if (p === 0) return done(q ? 'LD A,(BC)' : 'LD (BC),A');
                if (p === 1) return done(q ? 'LD A,(DE)' : 'LD (DE),A');
                const nn = hex4(word());
                if (p === 2) return done(q ? `LD ${hl},(${nn})` : `LD (${nn}),${hl}`);
                return done(q ? `LD A,(${nn})` : `LD (${nn}),A`);
            }
            case 3:
                if (index && (p !== 2)) return db(1);
                return done(`${q ? 'DEC' : 'INC'} ${(p === 2) ? hl : RR[p]}`);
            case 4: case 5: {
                const name = (z === 4) ? 'INC' : 'DEC';
                if (index && usesHL(y)) return done(`${name} ${indexed(index, signed())}`);
                if (index) return db(1);
                return done(`${name} ${R8[y]}`);
            }
            case 6: {
                if (index && usesHL(y)) {
                    const d = signed();
                    return done(`LD ${indexed(index, d)},${hex2(byte())}`);
                }
                if (index) return db(1);
                return done(`LD ${R8[y]},${hex2(byte())}`);
            }
            default:
                return index ? db(1) : done(ACC[y]);
        }
    }

    // x === 3
    switch (z) {
        case 0: return index ? db(1) : done(`RET ${CC[y]}`);
        case 1:
            if (q) {
                if (p === 0) return index ? db(1) : done('RET');
                if (p === 1) return index ? db(1) : done('EXX');
                if (p === 2) return done(`JP (${hl})`);
                return done(`LD SP,${hl}`);
            }
            if (index && (p !== 2)) return db(1);
            return done(`POP ${(p === 2) ? hl : RR_PUSH[p]}`);
        case 2: return index ? db(1) : done(`JP ${CC[y]},${hex4(word())}`);
        case 3:
            switch (y) {
                case 0: return index ? db(1) : done(`JP ${hex4(word())}`);
                case 2: return index ? db(1) : done(`OUT (${hex2(byte())}),A`);
                case 3: return index ? db(1) : done(`IN A,(${hex2(byte())})`);
                case 4: return done(`EX (SP),${hl}`);
                case 5: return index ? db(1) : done('EX DE,HL');
                case 6: return index ? db(1) : done('DI');
                default: return index ? db(1) : done('EI');
            }
        case 4: return index ? db(1) : done(`CALL ${CC[y]},${hex4(word())}`);
        case 5:
            if (q) return (p === 0) && !index ? done(`CALL ${hex4(word())}`) : db(1);
            if (index && (p !== 2)) return db(1);
            return done(`PUSH ${(p === 2) ? hl : RR_PUSH[p]}`);
        case 6: return index ? db(1) : done(`${ALU[y]}${hex2(byte())}`);
        default: return index ? db(1) : done(`RST ${hex2(y * 8)}`);
    }
}

/* The instructions in `bytes`, whose first byte is at `origin`, from
 * `start` on: [{address, bytes, text}]. */
export function disassemble(bytes, { origin = 0, start = origin, count = Infinity, end = origin + bytes.length } = {}) {
    const read = (addr) => {
        const i = addr - origin;
        return ((i >= 0) && (i < bytes.length)) ? bytes[i] : 0;
    };
    const out = [];
    let pc = start;
    const last = origin + bytes.length;
    const stop = Math.min(end, last);
    while ((out.length < count) && (pc < stop)) {
        let { length, text } = disassembleOne(read, pc);
        // An instruction cut off by the end of the bytes is left as the bytes there are.
        if ((pc + length) > last) {
            length = last - pc;
            text = `DB ${Array.from({ length }, (_, i) => hex2(read(pc + i))).join(',')}`;
        }
        out.push({ address: pc, bytes: Array.from({ length }, (_, i) => read(pc + i)), text });
        pc += length;
    }
    return out;
}

// A number as the command line gives it: decimal, $hex or 0x hex.
function readNumber(text) {
    const t = String(text).trim();
    if (/^\$[0-9A-Fa-f]+$/.test(t)) return parseInt(t.slice(1), 16);
    if (/^0x[0-9A-Fa-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    throw new Error(`cannot read the number "${text}"`);
}

const ROMS = { rom48: '48.rom', 'rom128-0': '128-0.rom', 'rom128-1': '128-1.rom' };

function main(argv) {
    const args = [];
    let origin = 0;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--origin') origin = readNumber(argv[++i]);
        else args.push(argv[i]);
    }
    if (!args.length) {
        console.log('Usage: node tools/z80dis.js <file|rom48|rom128-0|rom128-1> [start] [count] [--origin n]');
        process.exit(1);
    }
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const file = ROMS[args[0]] ? path.join(root, 'static/roms', ROMS[args[0]]) : args[0];
    const bytes = fs.readFileSync(file);
    const start = (args[1] !== undefined) ? readNumber(args[1]) : origin;
    const count = (args[2] !== undefined) ? readNumber(args[2]) : 20;
    console.log(`        ORG ${hex4(start)}`);
    for (const line of disassemble(bytes, { origin, start, count })) {
        const raw = line.bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        console.log(`        ${line.text.padEnd(28)}; ${hex4(line.address)}  ${raw}`);
    }
}

if (process.argv[1] && (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) main(process.argv.slice(2));

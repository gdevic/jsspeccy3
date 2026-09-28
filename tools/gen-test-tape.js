/*
 * tools/gen-test-tape.js: write a small TAP file with one of everything a
 * Spectrum saves from BASIC, for trying the tape recorder by hand: winding
 * into the middle of a block and playing, loading from wherever the tape
 * stands, recording over a block.
 *
 * Usage (run from the project root):
 *   node tools/gen-test-tape.js [output.tap]
 *
 * The default output is dist/_test/mixed.tap, which the local server serves
 * at /_test/mixed.tap and git ignores. The tape holds, each as a header and
 * a data block:
 *   MIXED   a BASIC program that loads the rest and prints from it
 *   NUMS    a number array a(5)
 *   STRS    a character array b$(3,8)
 *   BYTES   512 bytes of CODE for address 40000
 * so that LOAD "" from BASIC, or RUN after LOAD "", goes through them all.
 * The script prints where each block starts on the counter.
 */

import fs from 'fs';
import path from 'path';

import { writeCassetteTAP, blockMs } from '../runtime/cassette.js';

const outFile = process.argv[2] || 'dist/_test/mixed.tap';

const TAP_GAP_MS = 1000;  // the pause a TAP block is played with

// BASIC keyword tokens
const PRINT = 0xf5, LOAD = 0xef, DATA = 0xe4, CODE = 0xaf;

const ascii = (text) => Array.from(text, (c) => c.charCodeAt(0));

// A small whole number as BASIC keeps one in a line: its digits, then its 5-byte form.
const number = (n) => [...ascii(String(n)), 0x0e, 0x00, (n < 0) ? 0xff : 0x00, n & 0xff, (n >> 8) & 0xff, 0x00];

// A line of BASIC: its number, big-endian, the length of the rest, then the tokens and a carriage return.
function line(lineNumber, ...parts) {
    const body = [...parts.flat(), 0x0d];
    return [lineNumber >> 8, lineNumber & 0xff, body.length & 0xff, body.length >> 8, ...body];
}

const program = [
    ...line(10, PRINT, ascii('"MIXED TAPE"')),
    ...line(20, LOAD, ascii('""'), DATA, ascii('a()')),
    ...line(30, LOAD, ascii('""'), DATA, ascii('b$()')),
    ...line(40, LOAD, ascii('""'), CODE),
    ...line(50, PRINT, ascii('a('), number(1), ascii(');b$('), number(1), ascii(')')),
];

// A number as a 5-byte array element.
const element = (n) => [0x00, (n < 0) ? 0xff : 0x00, n & 0xff, (n >> 8) & 0xff, 0x00];
const numbers = [1, 0x05, 0x00, ...[10, 20, 30, 40, 50].flatMap(element)];

const strings = [2, 0x03, 0x00, 0x08, 0x00, ...ascii('SPECTRUM' + 'CASSETTE' + 'RECORDER')];

const bytes = Array.from({ length: 512 }, (_, i) => i & 0xff);

// A block as a TAP holds it: the flag byte, the bytes, and their parity.
function block(flag, body) {
    const data = new Uint8Array(body.length + 2);
    data[0] = flag;
    data.set(body, 1);
    let parity = 0;
    for (let i = 0; i < data.length - 1; i++) parity ^= data[i];
    data[data.length - 1] = parity;
    return { data };
}

/* A header block: the type (0 program, 1 number array, 2 character array,
 * 3 code), the name padded to 10 characters, the data's length and the two
 * parameters. For an array the second byte of param1 is the variable's
 * name. */
function header(type, name, length, param1, param2) {
    const body = [type, ...ascii(name.padEnd(10).slice(0, 10)), length & 0xff, length >> 8,
        param1 & 0xff, param1 >> 8, param2 & 0xff, param2 >> 8];
    return block(0x00, body);
}

const arrayName = (letter, isString) => (((letter.charCodeAt(0) & 0x1f) | (isString ? 0xc0 : 0x80)) << 8);

const blocks = [
    header(0, 'MIXED', program.length, 10, program.length), block(0xff, program),
    header(1, 'NUMS', numbers.length, arrayName('a', false), 0x8000), block(0xff, numbers),
    header(2, 'STRS', strings.length, arrayName('b', true), 0x8000), block(0xff, strings),
    header(3, 'BYTES', bytes.length, 40000, 0x8000), block(0xff, bytes),
];

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, writeCassetteTAP(blocks));

// Where each block starts and ends on the counter, as the TAP plays.
let ms = 0;
const names = ['MIXED', '', 'NUMS', '', 'STRS', '', 'BYTES', ''];
console.log(`${outFile}: ${blocks.length} blocks`);
blocks.forEach(({ data }, i) => {
    const length = blockMs(data);
    const label = names[i] ? `header ${names[i]}` : 'data';
    console.log(`  ${(ms / 1000).toFixed(2).padStart(6)} s  to ${((ms + length) / 1000).toFixed(2).padStart(6)} s  ${label} (${data.length} bytes)`);
    ms += length + TAP_GAP_MS;
});
console.log(`  ${(ms / 1000).toFixed(2).padStart(6)} s  end`);

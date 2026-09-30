/*
 * tools/zxheadless.js: a Spectrum 48K run in Node, without a page, from the
 * built core (dist/jsspeccy/jsspeccy-core.wasm, so `npm run build` first)
 * and the ROMs in static/roms. It is how tools/gen-starter.js makes the
 * starter programs: each line of a listing is entered through the ROM's own
 * editor, which checks it and adds its hidden numbers, and the ROM's own
 * SAVE and SAVE * write the tapes and Microdrive cartridges. It also runs a
 * program and answers it, for trying one out.
 *
 * What it gives, on the object createSpectrum() resolves to:
 *   frames(n)            run n frames (50 a second of Spectrum time)
 *   until(test, max)     run frames until test() holds; throws after max
 *   enter(bytes)         enter one line as the editor holds it once typed
 *                        (see tools/zxbasic.js); a line with a number goes
 *                        into the program, one without runs as a command
 *   enterListing(lines)  NEW, then every line of a parsed listing
 *   command(text)        a command typed as text, entered and run
 *   press(ch)            press the keys that type `ch`, as for an INPUT or
 *                        a program's INKEY$; '\n' is Enter
 *   type(text)           press(ch) for each character
 *   screen()             the screen as 24 lines of text (see below)
 *   report()             the ROM's report on the bottom line, or ''
 *   editor()             the line editor's state, as the worker gives it
 *   saved                blocks SAVE has written, as a TAP holds them
 *   printed              rows the ZX Printer has printed, 32 bytes each
 *   insertCartridge(drive, mdr) and cartridge(drive), for the Microdrives
 *
 * The screen is read cell by cell against the ROM's character set: a cell
 * that is not a character shows as # for a user-defined graphic or anything
 * else drawn, and a blank cell as a space.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { SPECCY, speccyKeysForChar } from '../runtime/keyboard.js';
import { editLine } from './zxbasic.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// System variables
const FLAGS = 0x5c3b, ERR_SP = 0x5c3d, MODE = 0x5c41, VARS = 0x5c4b, PROG = 0x5c53;
const E_LINE = 0x5c59, K_CUR = 0x5c5b, WORKSP = 0x5c61, STKBOT = 0x5c63, STKEND = 0x5c65;
const FLAGX = 0x5c71, DF_SZ = 0x5c6b;

const HOLD_FRAMES = 3;  // a key is held this many frames
const GAP_FRAMES = 7;  // and let go this many, so that the ROM takes the same key again

export async function createSpectrum(opts = {}) {
    const wasm = fs.readFileSync(path.join(ROOT, 'dist/jsspeccy/jsspeccy-core.wasm'));
    const { instance } = await WebAssembly.instantiate(wasm, {});
    const core = instance.exports;
    const memory = new Uint8Array(core.memory.buffer);
    const registers = new Uint16Array(core.memory.buffer, core.REGISTERS, 12);
    const rom = (name) => fs.readFileSync(path.join(ROOT, 'static/roms', name));
    const rom48 = rom('48.rom');
    memory.set(rom48, core.MACHINE_MEMORY + (10 * 0x4000));
    const if1 = rom('if1-2.rom');
    memory.set(if1, core.MACHINE_MEMORY + (14 * 0x4000));
    memory.set(if1, core.MACHINE_MEMORY + (14 * 0x4000) + 0x2000);

    core.setMachineType(48);
    core.reset();
    core.setTapeTraps(false);
    core.setSaveTraps(true);
    if (opts.interface1) core.setInterface1Enabled(true);
    if (opts.printer) {
        core.setPrinterEnabled(true);
        core.setPrinterPaper(1000000);
    }

    const peek = (addr) => core.peek(addr & 0xffff);
    const poke = (addr, value) => core.poke(addr & 0xffff, value & 0xff);
    const word = (addr) => peek(addr) | (peek(addr + 1) << 8);
    const setWord = (addr, value) => { poke(addr, value); poke(addr + 1, value >> 8); };

    const saved = [];
    const printed = [];
    const cartridgeBlocks = new Array(8).fill(0);

    // SA-BYTES about to save a block: taken all at once, as the worker does with instant loading.
    function trapSave() {
        const flag = registers[0] >> 8;
        const start = registers[8];
        const length = registers[2];
        const bytes = new Uint8Array(length + 2);
        bytes[0] = flag;
        let parity = flag;
        for (let i = 0; i < length; i++) {
            bytes[i + 1] = peek(start + i);
            parity ^= bytes[i + 1];
        }
        bytes[length + 1] = parity;
        saved.push(bytes);
        registers[8] = (start + length + 1) & 0xffff;
        registers[2] = 0xffff;
        registers[3] = 0x0000;
        registers[1] = 0x000e;
        registers[0] = 0x0051;
        core.setPC(0x053e);
    }

    function frame() {
        let status = core.runFrame();
        while (status) {
            if (status === 3) trapSave();
            else if (status !== 4) throw new Error(`The core stopped with status ${status} at ${core.getPC().toString(16)}`);
            status = core.resumeFrame();
        }
        if (opts.printer) {
            const count = core.getPrinterRowCount();
            for (let i = 0; i < count; i++) {
                const at = core.PRINTER_ROWS + (i * core.PRINTER_ROW_BYTES);
                printed.push(memory.slice(at, at + core.PRINTER_ROW_BYTES));
            }
            if (count) core.clearPrinterRows();
        }
    }

    function frames(n) {
        for (let i = 0; i < n; i++) frame();
    }

    function until(test, max = 3000, what = 'the Spectrum') {
        for (let i = 0; i < max; i++) {
            if (test()) return i;
            frame();
        }
        if (test()) return max;
        throw new Error(`Timed out waiting for ${what}\n${screen().join('\n')}`);
    }

    // The ROM's line editor waiting for a key, as runtime/worker.js's editorState tells it.
    function editor() {
        if (registers[9] !== 0x5c3a) return null;
        if (word(word(ERR_SP)) !== 0x107f) return null;
        const mode = peek(MODE);
        const keyword = (mode === 0) && !(peek(FLAGS) & 0x08);
        const input = !!(peek(FLAGX) & 0x20);
        const command = !input && (peek(word(E_LINE)) === 0x0d);
        return { keyword, input, command };
    }

    const keyDown = (keys) => keys.forEach(k => core.keyDown(k.row, k.mask));
    const keyUp = (keys) => keys.slice().reverse().forEach(k => core.keyUp(k.row, k.mask));
    function tap(keys) {
        keyDown(keys);
        frames(HOLD_FRAMES);
        keyUp(keys);
        frames(GAP_FRAMES);
    }

    function press(ch) {
        if (ch === '\n') return tap([SPECCY.ENTER]);
        if (/^[a-z]$/.test(ch)) return tap([SPECCY[ch.toUpperCase()]]);
        const keys = speccyKeysForChar(ch);
        if (!keys) throw new Error(`No key types ${JSON.stringify(ch)}`);
        tap(keys);
    }

    const type = (text) => { for (const ch of text) press(ch); };

    // Waits for the editor to wait for a command on an empty line.
    function ready(max = 3000) {
        until(() => { const e = editor(); return !!(e && e.command); }, max, 'the editor');
    }

    /* Puts `bytes` in the editor's line, as typing them would, and presses
     * Enter. Resolves once the editor waits again on an empty line; throws
     * with the line's text when the ROM keeps it, marking a mistake. A
     * command's own output is left on the screen for the caller. */
    function enter(bytes, where = 'a line', { wait = true } = {}) {
        ready();
        frames(GAP_FRAMES);  // the Microdrives run with interrupts off, so the last key may still count as held
        const eLine = word(E_LINE);
        if ((word(WORKSP) !== eLine + 2) || (word(STKBOT) !== word(WORKSP)) || (word(STKEND) !== word(STKBOT))) {
            throw new Error('The editor is not in the state a line goes into');
        }
        bytes.forEach((b, i) => poke(eLine + i, b));
        poke(eLine + bytes.length, 0x0d);
        poke(eLine + bytes.length + 1, 0x80);
        const end = eLine + bytes.length + 2;
        setWord(WORKSP, end);
        setWord(STKBOT, end);
        setWord(STKEND, end);
        setWord(K_CUR, eLine + bytes.length);
        tap([SPECCY.ENTER]);
        if (!wait) return;
        let waiting = 0;
        until(() => {
            const e = editor();
            if (!e) {
                waiting = 0;
                return false;
            }
            if (e.command || e.input) return true;
            return (++waiting > 50);
        }, 60000, `${where} to go in`);
        const e = editor();
        if (e && !e.command && !e.input) throw new Error(`${where}: the ROM refused the line, marking the mistake: ${markedLine()}`);
    }

    /* The line in the editor as the lower screen shows it, where the ROM
     * marks a mistake with a flashing ?. */
    function markedLine() {
        const rows = screen();
        let first = 23;
        while ((first > 0) && (rows[first - 1] !== '') && (first > 24 - peek(DF_SZ))) first--;
        return rows.slice(first).join('');
    }

    function enterListing(lines) {
        enter(Uint8Array.of(0xe6), 'NEW');  // NEW
        for (const line of lines) enter(line.bytes, line.where);
        return program();
    }

    // The program as it stands, PROG up to VARS.
    function program() {
        const prog = word(PROG);
        return Uint8Array.from({ length: word(VARS) - prog }, (_, i) => peek(prog + i));
    }

    const motorsOff = () => core.getMicrodriveMotors() === 0;

    /* The screen as 24 lines of text. */
    function screen() {
        const font = [];
        for (let c = 0; c < 96; c++) font.push(Array.from(rom48.subarray(0x3d00 + (c * 8), 0x3d00 + (c * 8) + 8)).join(','));
        const byGlyph = new Map();
        font.forEach((g, c) => { byGlyph.set(g, String.fromCharCode(32 + c)); });
        font.forEach((g, c) => {
            const inverse = g.split(',').map(v => 255 - Number(v)).join(',');
            if (!byGlyph.has(inverse)) byGlyph.set(inverse, String.fromCharCode(32 + c));
        });
        const lines = [];
        for (let row = 0; row < 24; row++) {
            let text = '';
            for (let col = 0; col < 32; col++) {
                const glyph = [];
                for (let y = 0; y < 8; y++) {
                    const addr = 0x4000 + ((row & 0x18) << 8) + ((row & 7) << 5) + (y << 8) + col;
                    glyph.push(peek(addr));
                }
                const key = glyph.join(',');
                text += byGlyph.has(key) ? (byGlyph.get(key) === '`' ? '£' : byGlyph.get(key)) : '#';
            }
            lines.push(text.replace(/\s+$/, ''));
        }
        return lines;
    }

    // The report on the bottom two lines, such as "0 OK, 30:1", or ''.
    function report() {
        const s = screen();
        const text = `${s[22]} ${s[23]}`.trim();
        return /^[0-9A-R] .*, \d+:\d+$/.test(text) ? text : '';
    }

    function command(text, opts) {
        return enter(editLine(text, text), text, opts);
    }

    // Waits for the editor on an empty line, with every Microdrive motor stopped.
    function settle(max = 20000, what = 'the Microdrives') {
        until(() => { const e = editor(); return !!(e && e.command) && motorsOff(); }, max, what);
    }

    function insertCartridge(drive, data) {
        const bytes = new Uint8Array(data);
        const blockLen = core.MICRODRIVE_BLOCK_LEN;
        let length = bytes.length;
        let writeProtect = false;
        if ((length % blockLen) === 1) {
            writeProtect = !!bytes[length - 1];
            length--;
        }
        const blocks = Math.floor(length / blockLen);
        const offset = core.MICRODRIVE_DATA + (drive * core.MICRODRIVE_DRIVE_BYTES);
        memory.fill(0xff, offset, offset + core.MICRODRIVE_DRIVE_BYTES);
        memory.set(bytes.subarray(0, blocks * blockLen), offset);
        core.insertMicrodrive(drive, blocks, writeProtect);
        cartridgeBlocks[drive] = blocks;
    }

    // The cartridge in `drive` as a .mdr file, with its write-protect byte.
    function cartridge(drive) {
        const length = cartridgeBlocks[drive] * core.MICRODRIVE_BLOCK_LEN;
        const offset = core.MICRODRIVE_DATA + (drive * core.MICRODRIVE_DRIVE_BYTES);
        const image = new Uint8Array(length + 1);
        image.set(memory.subarray(offset, offset + length));
        image[length] = core.getMicrodriveWriteProtect(drive) ? 1 : 0;
        return image;
    }

    // The 48K boots to its copyright message.
    until(() => { const e = editor(); return !!(e && e.command); }, 1000, 'the 48K to boot');

    return {
        core, peek, poke, word, setWord, frames, until, editor, ready, enter, enterListing, program, command, settle,
        press, type, tap, keyDown, keyUp, screen, report, saved, printed, insertCartridge, cartridge, motorsOff,
        SPECCY,
    };
}

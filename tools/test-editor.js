/*
 * tools/test-editor.js: checks the full-screen BASIC editor (starter/editor.asm)
 * in a Spectrum 48K run in Node (tools/zxheadless.js), against the ROM's own
 * editor as the golden value.
 *
 * Usage (run from the project root, after `npm run build`, whose core it
 * runs):
 *   node tools/test-editor.js [name ...]
 *
 * With names, only the checks whose names start with one of them run.
 *
 * The editor is assembled (tools/z80asm.js), poked in at its address
 * behind CLEAR 53247, and started as its loader starts it. Keys are then
 * pressed as a user presses them, and the editor's screen is read back
 * cell by cell against its own font. A program typed into the editor must
 * come out byte for byte as the same program entered through the ROM's
 * editor, which is how the starter programs are made.
 */

import fs from 'fs';
import path from 'path';

import { createSpectrum } from './zxheadless.js';
import { parseListing } from './zxbasic.js';
import { assemble } from './z80asm.js';

const SOURCE = 'starter/editor.asm';
const code = assemble(fs.readFileSync(SOURCE, 'utf8'), SOURCE);
const L = code.labels;
const STATE = L.STATE;

let failures = 0;
let checks = 0;
function check(what, ok, detail = '') {
    checks++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${(!ok && detail) ? `\n     ${String(detail).replace(/\n/g, '\n     ')}` : ''}`);
    if (!ok) failures++;
    return ok;
}

const hex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');

// The editor's font as the screen shows it: 8 rows of 6 bits for each character.
const glyphs = new Map();
for (let c = 0x20; c < 0x80; c++) {
    const rows = [];
    for (let r = 0; r < 7; r++) rows.push(code.bytes[(L.FONT - code.origin) + ((c - 0x20) * 7) + r] >> 2);
    rows.push(0);
    const ch = (c === 0x60) ? '£' : (c === 0x7f) ? '©' : (c === 0x5e) ? '↑' : String.fromCharCode(c);
    glyphs.set(rows.join(','), ch);
    const inverse = rows.map(v => v ^ 0x3f).join(',');
    if (!glyphs.has(inverse)) glyphs.set(inverse, ch);
}

/* The editor's screen as 24 lines of 42 characters, read against its font;
 * a cell that is no character shows as #. Trailing spaces are dropped. */
function editorScreen(zx) {
    const lines = [];
    for (let row = 0; row < 24; row++) {
        let text = '';
        for (let col = 0; col < 42; col++) {
            const x = col * 6;
            const rows = [];
            for (let y = 0; y < 8; y++) {
                const addr = 0x4000 + ((row & 0x18) << 8) + ((row & 7) << 5) + (y << 8) + (x >> 3);
                const pair = (zx.peek(addr) << 8) | zx.peek(addr + 1);
                rows.push((pair >> (10 - (x & 7))) & 0x3f);
            }
            const key = rows.join(',');
            text += glyphs.has(key) ? glyphs.get(key) : '#';
        }
        lines.push(text.replace(/\s+$/, ''));
    }
    return lines;
}

/* The cursor's place on the screen, found by its inverted cell: the cell
 * that matches a glyph only inverted. Not used for checks that need the
 * cursor hidden. */

// Keys, as the Spectrum's keys that give them.
function keysFor(zx, name) {
    const S = zx.SPECCY;
    const caps = (k) => [S.CAPS_SHIFT, k];
    const table = {
        LEFT: caps(S.FIVE), RIGHT: caps(S.EIGHT), UP: caps(S.SEVEN), DOWN: caps(S.SIX),
        DELETE: caps(S.ZERO), EDIT: caps(S.ONE), CAPSLOCK: caps(S.TWO), PGUP: caps(S.THREE),
        PGDN: caps(S.FOUR), GRAPHICS: caps(S.NINE), EXTEND: [S.CAPS_SHIFT, S.SYMBOL_SHIFT],
        BREAK: caps(S.BREAK_SPACE), ENTER: [S.ENTER],
    };
    return table[name];
}

// Waits until the editor waits for a key.
function idle(zx, max = 3000) {
    zx.until(() => zx.peek(STATE) === 1, max, 'the editor to wait for a key');
}

// Presses a named key (LEFT, ENTER, ...) once the editor waits for one.
function key(zx, name) {
    idle(zx);
    zx.tap(keysFor(zx, name));
}

// Types text, a character at a time, each once the editor waits; \n is ENTER.
function typeText(zx, text) {
    for (const ch of text) {
        idle(zx);
        if (ch === '\n') zx.tap(keysFor(zx, 'ENTER'));
        else zx.press(ch);
    }
    idle(zx);
}

// Types text as typeText does, but does not wait after the last key, which may run something.
function typeRun(zx, text) {
    for (const ch of text) {
        idle(zx);
        if (ch === '\n') zx.tap(keysFor(zx, 'ENTER'));
        else zx.press(ch);
    }
}

// EXTEND, then a letter.
function extend(zx, letter) {
    key(zx, 'EXTEND');
    idle(zx);
    zx.press(letter);
    idle(zx);
}

/* A Spectrum with the editor loaded and started. `program`, a parsed
 * listing, is entered first through the ROM, and kept (START) rather than
 * cleared (STARTNEW). */
async function withEditor({ program = null, interface1 = false } = {}) {
    const zx = await createSpectrum({ interface1 });
    if (program) zx.enterListing(program);
    zx.command('CLEAR 53247');
    code.bytes.forEach((b, i) => zx.poke(code.origin + i, b));
    zx.command(`RANDOMIZE USR ${program ? L.ENTRY : L.ENTRY + 3}`, { wait: false });
    idle(zx, 2000);
    return zx;
}

const listing = (file) => parseListing(fs.readFileSync(path.join('starter', file), 'utf8'), file);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('size', async () => {
    check(`the code (${code.bytes.length} bytes) ends below the buffers`, code.origin + code.bytes.length <= L.EDBUF,
        `ends at $${(code.origin + code.bytes.length).toString(16)}`);
    check(`the interrupt routine (${L.ISREND - L.ISRCODE} bytes) ends before the prompt`, L.ISRAT + (L.ISREND - L.ISRCODE) <= L.PBUF);
    check('the prompt ends before the UDGs', L.PBUF + L.PBUFMAX + 1 <= 0xff58, `ends at $${(L.PBUF + L.PBUFMAX + 1).toString(16)}`);
    // The buffers above the code, in order, none running into the next.
    const regions = [
        ['the line being edited', L.EDBUF, L.EDMAX], ['the screen map', L.ROWMAP, 23 * 3],
        ['the variables', L.VARBASE, L.VAREND - L.VARBASE], ['the row page', L.CELLPAGE, 256], ['the glyph table', L.GT, 0x3fc],
    ];
    regions.forEach(([name, at, size], i) => {
        const next = (i + 1 < regions.length) ? regions[i + 1][1] : L.IM2JUMP;
        check(`${name} ($${at.toString(16)}, ${size} bytes) ends before what follows it`, at + size <= next, `ends at $${(at + size).toString(16)}`);
    });
    const page = [['SLOTLO', L.SLOTLO, 42], ['FINDSTR', L.FINDSTR, 33], ['TOKIDX', L.TOKIDX, 24], ['LNDIGITS', L.LNDIGITS, 6], ['KQBUF', L.KQBUF, 16],
        ['SLOTHI', L.SLOTHI, 42], ['ROWBUF', L.ROWBUF, 42], ['DYNCODE', L.DYNCODE, L.DYNMAX], ['GLYPH', L.GLYPH, 8]];
    page.forEach(([name, at, size], i) => {
        const next = (i + 1 < page.length) ? page[i + 1][1] : L.CELLPAGE + 256;
        check(`the row page's ${name} ends before what follows it`, at + size <= next, `${name} ends at $${(at + size).toString(16)}`);
    });
    check('SLOTHI is SLOTLO with bit 7 set', L.SLOTHI === L.SLOTLO + 0x80);
    // Every message fits the status row, a number in it (byte 1) taken as 5 digits.
    for (const name of Object.keys(L).filter(n => /^M_/.test(n))) {
        let length = 0;
        for (let at = L[name] - code.origin; ; at++) {
            const b = code.bytes[at];
            length += ((b & 0x7f) === 1) ? 5 : 1;
            if (b & 0x80) break;
        }
        check(`the message ${name} (${length} characters) fits the status row`, length <= 42);
    }
    check('the row\'s own slots end below the IM 2 jump', L.GT + 0x380 + L.DYNSLOT + L.DYNMAX <= L.IM2JUMP);
});

/* A whole screen of TETRIS drawn again, as page up, page down and ENTER
 * draw it: in frames of 1/50 s. */
test('speed', async () => {
    const zx = await withEditor({ program: listing('tetris.bas') });
    extend(zx, 't');
    const r = L.RENDERALL;
    const stub = [0x00, 0x06, 10, 0xc5, 0xcd, r & 255, r >> 8, 0xc1, 0x10, 0xf9, 0x3e, 1, 0x32, 0x20, 0xfd, 0xfb, 0x76, 0x18, 0xfd];
    stub.forEach((b, i) => zx.poke(0xfd00 + i, b));
    zx.poke(0xfd20, 0);
    zx.core.setPC(0xfd00);
    let frames = 0;
    while ((zx.peek(0xfd20) !== 1) && (frames < 2000)) {
        zx.frames(1);
        frames++;
    }
    const each = frames / 10;
    check(`a full screen is drawn in ${each.toFixed(1)} frames (${(each * 20).toFixed(0)} ms), under 20`, each < 20);
});

test('start', async () => {
    const zx = await withEditor();
    const screen = editorScreen(zx);
    check('the status row shows the new line', /^New line/.test(screen[23]), screen[23]);
    check('the listing is empty', screen.slice(0, 23).every(l => l === ''), screen.join('\n'));
    check('IM 2 is on', zx.core.getIM() === 2, zx.core.getIM());
});

test('typing', async () => {
    const zx = await withEditor();
    typeText(zx, '10 print "hello"\n');
    const screen = editorScreen(zx);
    check('the line is listed', screen[0] === '  10 PRINT "hello"', screen.join('\n'));
    const golden = await createSpectrum();
    const want = golden.enterListing(parseListing('10 PRINT "hello"', 'golden'));
    check('the program is as the ROM makes it', hex(zx.program()) === hex(want), `${hex(zx.program())}\n${hex(want)}`);
});

// Where two programs first differ, for a failure's message.
function firstDiff(a, b) {
    let i = 0;
    while ((i < a.length) && (i < b.length) && (a[i] === b[i])) i++;
    return `differ at byte ${i}: ${hex(a.slice(Math.max(0, i - 8), i + 8))}\n          ROM: ${hex(b.slice(Math.max(0, i - 8), i + 8))}`;
}

const STARTERS = fs.readdirSync('starter').filter(f => f.endsWith('.bas')).sort();
const needsIF1 = (file) => /^(run|guess)\.bas$/.test(file);

/* Every line of every starter program, entered through the ROM, is taken
 * onto by the cursor, changed and changed back, and entered again with
 * ENTER: the program must not change by a byte. */
test('roundtrip', async () => {
    for (const file of STARTERS) {
        const program = listing(file);
        const zx = await withEditor({ program, interface1: needsIF1(file) });
        const golden = zx.program();
        extend(zx, 't');
        let missed = [];
        for (let i = 0; i < program.length; i++) {
            idle(zx);
            if (zx.word(L.CURLINE) !== program[i].number) missed.push(`${program[i].number} (on ${zx.word(L.CURLINE)})`);
            typeText(zx, 'x');
            key(zx, 'DELETE');
            key(zx, 'ENTER');
            key(zx, 'DOWN');
        }
        idle(zx);
        const got = zx.program();
        check(`${file}: the cursor went onto each of its ${program.length} lines`, !missed.length, missed.slice(0, 5).join(', '));
        check(`${file}: every line entered again unchanged`, hex(got) === hex(golden), firstDiff(got, golden));
    }
});

const rom = fs.readFileSync('static/roms/48.rom');
// The 48K's keywords as its table at $0096 has them, from RND ($A5) up.
const KEYWORD_TEXT = (() => {
    const out = [];
    let at = 0x96;
    for (let t = 0xa5; t <= 0xff; t++) {
        let text = '';
        for (;;) {
            const c = rom[at++];
            text += String.fromCharCode(c & 0x7f);
            if (c & 0x80) break;
        }
        out.push(text);
    }
    return out;
})();

/* A program line's bytes (from its number on) as LIST shows it: the number
 * padded to 4, the keywords spaced as PO-TOKENS spaces them, the hidden
 * numbers left out. This is the golden value for what the editor lists,
 * and the text a user reads off a listing. */
function listText(line) {
    const number = (line[0] << 8) | line[1];
    let text = String(number).padStart(4, ' ');
    let afterSpace = false;  // FLAGS bit 0
    for (let i = 4; i < line.length - 1; i++) {
        const b = line[i];
        if (b === 0x0e) {
            i += 5;
            continue;
        }
        if (b >= 0xa5) {
            const index = b - 0xa5;
            const word = KEYWORD_TEXT[index];
            if ((index >= 0x20) && (word[0] >= 'A') && !afterSpace) text += ' ';
            text += word;
            afterSpace = false;
            const last = word[word.length - 1];
            if (((last >= 'A') || (last === '$')) && (index >= 3)) {
                text += ' ';
                afterSpace = true;
            }
            continue;
        }
        if ((b >= 0x10) && (b <= 0x17)) {
            // A colour control and its parameters (two for AT and TAB) go through PO-TV, which leaves FLAGS alone.
            const count = (b >= 0x16) ? 2 : 1;
            text += String.fromCharCode(...line.slice(i, i + 1 + count));
            i += count;
            continue;
        }
        text += String.fromCharCode(b);
        if (b === 0x20) afterSpace = true;
        else if ((b < 0x80) || (b >= 0x90)) afterSpace = false;
    }
    return text;
}

// The lines of a program, PROG to VARS, each from its number to its ENTER.
function programLines(bytes) {
    const lines = [];
    let at = 0;
    while (at < bytes.length) {
        const length = bytes[at + 2] | (bytes[at + 3] << 8);
        lines.push(bytes.slice(at, at + 4 + length));
        at += 4 + length;
    }
    return lines;
}

/* Puts text into the editor's line, as typing it would, and presses ENTER:
 * quicker than typing for whole programs. The keys themselves have checks
 * of their own. */
function enterText(zx, text) {
    idle(zx);
    const bytes = Array.from(text, c => c.charCodeAt(0));
    bytes.forEach((b, i) => zx.poke(L.EDBUF + i, b));
    zx.setWord(L.EDLEN, bytes.length);
    zx.setWord(L.CURIDX, bytes.length);
    zx.poke(L.MODIFIED, 1);
    key(zx, 'ENTER');
    idle(zx);
}

/* Every line of every starter program, as LIST shows it, put into the
 * editor's new line and entered: the program must come out as the ROM
 * made it from the listing. */
test('typed', async () => {
    for (const file of STARTERS) {
        const program = listing(file);
        const goldenZx = await createSpectrum({ interface1: needsIF1(file) });
        const golden = goldenZx.enterListing(program);
        const zx = await withEditor({ interface1: needsIF1(file) });
        const refused = [];
        for (const line of programLines(golden)) {
            const text = listText(line);
            enterText(zx, text);
            if (zx.word(L.MSGPTR)) refused.push(text);
        }
        const got = zx.program();
        check(`${file}: no line refused`, !refused.length, refused.slice(0, 3).join('\n'));
        check(`${file}: the same program as the ROM's`, hex(got) === hex(golden), firstDiff(got, golden));
    }
});

/* What the editor lists, line by line, is what LIST shows, in 42 columns. */
test('listing', async () => {
    const program = listing('tetris.bas');
    const zx = await withEditor({ program });
    extend(zx, 't');
    const golden = programLines(zx.program()).map(listText);
    // the first screen of it
    const screen = editorScreen(zx);
    const want = [];
    for (const text of golden) {
        for (let i = 0; i < text.length; i += 42) want.push(text.slice(i, i + 42).replace(/\s+$/, ''));
        if (want.length >= 23) break;
    }
    const rows = want.slice(0, 23);
    const bad = rows.map((r, i) => (r === screen[i]) ? null : `row ${i}: ${JSON.stringify(screen[i])} not ${JSON.stringify(r)}`).filter(Boolean);
    check('the first screen of TETRIS is listed as LIST lists it', !bad.length, bad.slice(0, 4).join('\n'));
});

// The status row, the editor's bottom row.
const statusRow = (zx) => editorScreen(zx)[23];

/* A line the ROM refuses stays, with the cursor where the ROM stopped and
 * its report on the status row, and the program unchanged. */
test('refused', async () => {
    const zx = await withEditor();
    typeText(zx, '10 print "ok"\n');
    const before = zx.program();
    typeText(zx, '20 print +\n');
    check('the report shows', /^C Nonsense in BASIC/.test(statusRow(zx)), statusRow(zx));
    check('the program is unchanged', hex(zx.program()) === hex(before));
    check('the line stays to be put right', editorScreen(zx)[1] === '20 print +', editorScreen(zx)[1]);
    check('the cursor is where the ROM stopped, at the end', zx.word(L.CURIDX) === 10, zx.word(L.CURIDX));
    key(zx, 'DELETE');
    typeText(zx, '1\n');
    check('put right, it goes in', listText(programLines(zx.program())[1]) === '  20 PRINT 1', listText(programLines(zx.program())[1] || []));
});

/* A line without a number runs as a command, and the editor comes back. */
test('command', async () => {
    const zx = await withEditor();
    typeRun(zx, 'print 2+2\n');
    zx.until(() => zx.screen()[0] === '4', 500, 'PRINT to print');
    check('the command ran: 4 is printed', zx.screen()[0] === '4', zx.screen().join('\n'));
    check('its report is shown', zx.report() === '0 OK, 0:1', zx.report());
    zx.frames(20);
    check('the editor waits for a key first', zx.peek(STATE) !== 1);
    zx.press('a');
    idle(zx);
    check('a key brings the editor back', /^New line/.test(statusRow(zx)), statusRow(zx));
    typeRun(zx, 'let a=5\n');
    zx.frames(50);
    idle(zx);
    check('a command that prints nothing: its report is on the status row', /^0 OK, 0:1/.test(statusRow(zx)), statusRow(zx));
});

/* Keys pressed straight after a command, while the editor draws a long
 * listing again, are letters, not the keywords of the ROM's K mode. */
test('busykeys', async () => {
    const zx = await withEditor({ program: listing('tetris.bas') });
    typeRun(zx, 'print 1\n');
    zx.until(() => zx.report() !== '', 500, 'PRINT to finish');
    zx.press('a');
    zx.press('j');
    zx.press('k');
    idle(zx);
    const typed = Array.from({ length: zx.word(L.EDLEN) }, (_, i) => String.fromCharCode(zx.peek(L.EDBUF + i))).join('');
    check('keys pressed while the editor draws itself again are letters', typed === 'jk', JSON.stringify(typed));
});

/* A program runs, and the editor comes back however it stops. */
test('run', async () => {
    const zx = await withEditor();
    typeText(zx, '10 print "hi"\n');
    typeRun(zx, 'run\n');
    zx.until(() => zx.report() !== '', 500, 'the program to end');
    check('the program ran', zx.screen()[0] === 'hi', zx.screen()[0]);
    check('its report', zx.report() === '0 OK, 10:1', zx.report());
    zx.press(' ');
    idle(zx);
    check('the editor is back with the program', editorScreen(zx)[0] === '  10 PRINT "hi"', editorScreen(zx)[0]);
    // an error
    typeText(zx, '20 print x\n');
    typeRun(zx, 'run\n');
    zx.until(() => zx.report() !== '', 500, 'the program to stop');
    check('a program stopped by an error', zx.report() === '2 Variable not found, 20:1', zx.report());
    zx.press(' ');
    idle(zx);
    check('the editor is back after the error', /^\s+10 PRINT "hi"/.test(editorScreen(zx)[0]), editorScreen(zx)[0]);
    // BREAK
    typeText(zx, '20 go to 20\n');
    typeRun(zx, 'run\n');
    zx.frames(50);
    zx.keyDown(keysFor(zx, 'BREAK'));
    zx.until(() => zx.report() !== '', 500, 'BREAK to stop the program');
    zx.keyUp(keysFor(zx, 'BREAK'));
    check('a program stopped by BREAK', /^L BREAK into program, 20:1$/.test(zx.report()), zx.report());
    zx.frames(10);
    zx.press('a');
    idle(zx);
    check('the editor is back after BREAK', /^\s+10 PRINT "hi"/.test(editorScreen(zx)[0]), editorScreen(zx)[0]);
});

/* NEW and CLEAR leave the editor in charge. P_RAMT is held below the
 * editor while it is, so that the ROM's own CLEAR refuses to move RAMTOP
 * into it, typed or in a program, and is put back when it lets go. */
test('hook', async () => {
    const zx = await withEditor();
    check('P_RAMT is held below the editor', zx.word(0x5cb4) === L.PRAMTCAP, zx.word(0x5cb4));
    check('the real P_RAMT is kept', zx.word(L.ISRAT + L.ISRPRAMT - L.ISRCODE) === 0xffff, zx.word(L.ISRAT + L.ISRPRAMT - L.ISRCODE));
    typeText(zx, '10 rem a\n');
    typeRun(zx, 'new\n');
    idle(zx);
    check('NEW: the program is gone', zx.program().length === 0);
    check('NEW: still the editor', /^New line/.test(statusRow(zx)), statusRow(zx));
    typeRun(zx, 'clear 30000\n');
    zx.frames(30);
    if (zx.peek(STATE) !== 1) zx.press('a');
    idle(zx);
    check('CLEAR 30000: RAMTOP moved', zx.word(0x5cb2) === 30000, zx.word(0x5cb2));
    check('CLEAR 30000: still the editor', /^(New line|0 OK)/.test(statusRow(zx)), statusRow(zx));
    typeText(zx, 'clear 60000\n');
    check('CLEAR 60000 is refused', /^M RAMTOP no good/.test(statusRow(zx)), statusRow(zx));
    check('CLEAR 60000: RAMTOP stays', zx.word(0x5cb2) === 30000, zx.word(0x5cb2));
    typeText(zx, 'let b=1: clear 50000+15367\n');
    check('CLEAR 65367 as a second statement, from an expression, is refused', /^M RAMTOP no good, 0:2/.test(statusRow(zx)), statusRow(zx));
    check('CLEAR 65367 as a second statement: RAMTOP stays', zx.word(0x5cb2) === 30000, zx.word(0x5cb2));
    typeText(zx, '10 clear 65367\n');
    typeRun(zx, 'run\n');
    zx.frames(30);
    idle(zx);
    check('CLEAR 65367 in a program is refused', /^M RAMTOP no good, 10:1/.test(statusRow(zx)), statusRow(zx));
    check('CLEAR 65367 in a program: RAMTOP stays', zx.word(0x5cb2) === 30000, zx.word(0x5cb2));
    check('CLEAR 65367 in a program: the program stays', numbersOf(zx).join(',') === '10', numbersOf(zx).join(','));
    check('CLEAR 65367 in a program: still the editor', zx.peek(STATE) === 1 && zx.core.getIM() === 2, zx.core.getIM());
    // INPUT is the ROM's
    key(zx, 'BREAK');
    typeText(zx, '10 input a: print a*2\n');
    typeRun(zx, 'run\n');
    zx.until(() => zx.editor() && zx.editor().input, 500, 'INPUT');
    zx.type('21\n');
    zx.until(() => zx.report() !== '', 500, 'the program to end');
    check('INPUT works as the ROM\'s', zx.screen()[0] === '42', zx.screen()[0]);
    zx.press(' ');
    idle(zx);
    // let go, then come back
    typeRun(zx, `randomize usr ${L.ENTRY + 6}\n`);
    zx.until(() => { const e = zx.editor(); return !!(e && e.command); }, 500, 'the ROM\'s editor');
    zx.frames(50);
    check('UNHOOK: the ROM\'s editor stays', zx.peek(STATE) === 0 && !!zx.editor());
    check('UNHOOK: P_RAMT put back', zx.word(0x5cb4) === 0xffff, zx.word(0x5cb4));
    zx.command(`RANDOMIZE USR ${L.ENTRY}`, { wait: false });
    idle(zx);
    check('START again: the editor, with the program', editorScreen(zx)[0] === '  10 INPUT a: PRINT a*2', editorScreen(zx)[0]);
    check('START again: P_RAMT held down again', zx.word(0x5cb4) === L.PRAMTCAP, zx.word(0x5cb4));
    typeRun(zx, `randomize usr ${L.ENTRY}\n`);
    zx.frames(30);
    idle(zx);
    check('START while running: the real P_RAMT still kept', zx.word(L.ISRAT + L.ISRPRAMT - L.ISRCODE) === 0xffff, zx.word(L.ISRAT + L.ISRPRAMT - L.ISRCODE));
});

/* RAMTOP POKEd into the editor: the interrupt routine lets go of it at
 * once, and puts the real P_RAMT back. */
test('drop', async () => {
    const zx = await withEditor();
    zx.poke(0x5cb3, L.ENTRY >> 8);
    zx.frames(2);
    check('RAMTOP in the editor: IM 1 again', zx.core.getIM() === 1, zx.core.getIM());
    check('RAMTOP in the editor: P_RAMT put back', zx.word(0x5cb4) === 0xffff, zx.word(0x5cb4));
});

// A prompt answered: what it offers rubbed out, then text typed and ENTER.
function answer(zx, text) {
    for (let i = 0; i < 12; i++) key(zx, 'DELETE');
    typeText(zx, `${text}\n`);
}

const linesOf = (zx) => programLines(zx.program()).map(listText);
const numbersOf = (zx) => programLines(zx.program()).map(l => (l[0] << 8) | l[1]);

/* EXTEND R: the program as the ROM makes the renumbered listing. */
/* Renumbering with little room: the first line grows before the last
 * shrinks, so that it needs room part way that it does not need at its
 * end. Without the room, the program stays as it was. */
test('renumberroom', async () => {
    const program = parseListing([`1 ${Array(40).fill('GO TO 1').join(': ')}`, `9000 ${Array(80).fill('GO TO 9000').join(': ')}`].join('\n'), 'p');
    const zx = await withEditor({ program });
    const free = () => zx.word(0x5c3d) - zx.word(0x5c65);  // ERR_SP - STKEND
    typeText(zx, `dim a$(${free() - 130 - 6})\n`);
    check(`memory nearly full (${free()} bytes)`, (free() > 100) && (free() < 160), free());
    const before = hex(zx.program());
    extend(zx, 'r');
    answer(zx, '100,1');
    check('renumbered with no room: refused', /Out of memory/.test(statusRow(zx)), statusRow(zx));
    check('renumbered with no room: the program as it was', hex(zx.program()) === before);
    typeText(zx, 'clear\n');
    extend(zx, 'r');
    answer(zx, '100,1');
    const lines = programLines(zx.program()).map(listText);
    check('renumbered with room: the lines', numbersOf(zx).join(',') === '100,101', numbersOf(zx).join(','));
    check('renumbered with room: their GO TOs', lines[0].startsWith(' 100 GO TO 100: GO TO 100') && lines[1].startsWith(' 101 GO TO 101: GO TO 101'), lines.map(l => l.slice(0, 30)).join('|'));
});

test('renumber', async () => {
    const before = [
        '10 REM start',
        '20 GO TO 40',
        '30 GO SUB 50: PRINT "x"',
        '40 RESTORE 60: RUN 10',
        '50 RETURN',
        '60 DATA 1',
        '70 GO TO n*10',
        '80 LIST 30: LLIST 20',
        '90 SAVE "x" LINE 10',
        '100 IF a THEN GO TO 200',
        '110 GO TO 9',
    ];
    const after = [
        '100 REM start',
        '105 GO TO 115',
        '110 GO SUB 120: PRINT "x"',
        '115 RESTORE 125: RUN 100',
        '120 RETURN',
        '125 DATA 1',
        '130 GO TO n*10',
        '135 LIST 110: LLIST 105',
        '140 SAVE "x" LINE 100',
        '145 IF a THEN GO TO 200',
        '150 GO TO 100',
    ];
    const zx = await withEditor({ program: parseListing(before.join('\n'), 'before') });
    extend(zx, 'r');
    answer(zx, '100,5');
    const goldenZx = await createSpectrum();
    const golden = goldenZx.enterListing(parseListing(after.join('\n'), 'after'));
    check('the program is the renumbered listing, as the ROM makes it', hex(zx.program()) === hex(golden), firstDiff(zx.program(), golden));
    check('the GO TO it cannot follow is counted', /1 GO TO\/GO SUB not changed/.test(statusRow(zx)), statusRow(zx));
});

/* EXTEND A: each new line starts with the next number. */
test('auto', async () => {
    const zx = await withEditor();
    extend(zx, 'a');
    answer(zx, '100,10');
    check('the new line starts with 100', editorScreen(zx)[0] === '100', editorScreen(zx)[0]);
    typeText(zx, 'print 1\n');
    typeText(zx, 'print 2\n');
    check('the next new line starts with 120', editorScreen(zx)[2] === '120', editorScreen(zx).slice(0, 3).join('|'));
    extend(zx, 'a');
    check('auto off: the number goes', editorScreen(zx)[2] === '', editorScreen(zx)[2]);
    check('lines 100 and 110 went in', numbersOf(zx).join(',') === '100,110', numbersOf(zx).join(','));
    // a line entered by moving off it moves auto on, as ENTER does
    extend(zx, 'a');
    answer(zx, '200,10');
    typeText(zx, 'print 3');
    key(zx, 'UP');
    idle(zx);
    check('UP off an auto line: it goes in', numbersOf(zx).join(',') === '100,110,200', numbersOf(zx).join(','));
    extend(zx, 'b');
    check('EXTEND B: the new line offers the number after it', edText(zx) === '210 ', JSON.stringify(edText(zx)));
    check('EXTEND B: the cursor after the auto number', zx.word(L.CURIDX) === 4, zx.word(L.CURIDX));
    typeText(zx, 'print 4\n');
    check('typed there, it goes in after 200', numbersOf(zx).join(',') === '100,110,200,210', numbersOf(zx).join(','));
    key(zx, 'UP');
    key(zx, 'DOWN');
    idle(zx);
    check('DOWN onto the new line: the cursor after the auto number', (zx.word(L.CURLINE) === 0xffff) && (edText(zx) === '220 ') && (zx.word(L.CURIDX) === 4),
        `${zx.word(L.CURLINE)} ${JSON.stringify(edText(zx))} ${zx.word(L.CURIDX)}`);
});

// The text of the line being edited.
const edText = (zx) => String.fromCharCode(...Array.from({ length: zx.word(L.EDLEN) }, (_, i) => zx.peek(L.EDBUF + i)));

/* A line typed with a space before a keyword that LIST puts a space
 * before: LIST shows one space, and the text the editor keeps has two, so
 * that it gives back the same bytes. While the cursor is on the line, it
 * is shown as its text is, so that the cursor is where its text is. */
test('userspace', async () => {
    const zx = await withEditor();
    typeText(zx, '10 if a=1  then print 1\n20 print 2\n');
    check('the space is kept in the program', listText(programLines(zx.program())[0]) === '  10 IF a=1 THEN PRINT 1', listText(programLines(zx.program())[0]));
    key(zx, 'UP');
    key(zx, 'UP');
    idle(zx);
    check('on the line: it is shown as its text is', editorScreen(zx)[0] === edText(zx).replace(/\s+$/, ''), `${JSON.stringify(editorScreen(zx)[0])} ${JSON.stringify(edText(zx))}`);
    for (let i = 0; i < 15; i++) key(zx, 'RIGHT');
    idle(zx);
    const col = zx.peek(L.CXCOL);
    typeText(zx, 'z');
    check('a letter typed goes where the cursor is shown', editorScreen(zx)[0][col] === 'z', `${JSON.stringify(editorScreen(zx)[0])} at ${col}`);
    key(zx, 'BREAK');
    key(zx, 'DOWN');
    idle(zx);
    check('off the line, unchanged: the screen is the listing again', sameAsListing(zx), screenDiff(zx));
});

/* EXTEND G, F, N, X and D. */
test('commands', async () => {
    const program = parseListing([
        '10 REM one', '20 PRINT "hello"', '30 REM three', '40 PRINT "Hello again"', '50 REM five', '60 REM six',
    ].join('\n'), 'p');
    const zx = await withEditor({ program });
    extend(zx, 'g');
    answer(zx, '30');
    check('EXTEND G: to line 30', zx.word(L.CURLINE) === 30, zx.word(L.CURLINE));
    extend(zx, 'f');
    answer(zx, 'hello');
    check('EXTEND F: found in line 40, after the cursor', zx.word(L.CURLINE) === 40, zx.word(L.CURLINE));
    check('EXTEND F: the cursor on it', zx.word(L.CURIDX) === 12, zx.word(L.CURIDX));
    extend(zx, 'n');
    check('EXTEND N: round to line 20', zx.word(L.CURLINE) === 20, zx.word(L.CURLINE));
    extend(zx, 'x');
    check('EXTEND X: line 20 taken out', numbersOf(zx).join(',') === '10,30,40,50,60', numbersOf(zx).join(','));
    check('EXTEND X: the cursor on the line after', zx.word(L.CURLINE) === 30, zx.word(L.CURLINE));
    extend(zx, 'd');
    answer(zx, '35,50');
    zx.press('y');
    idle(zx);
    check('EXTEND D: lines 35 to 50 taken out', numbersOf(zx).join(',') === '10,30,60', numbersOf(zx).join(','));
    extend(zx, 't');
    check('EXTEND T: to the first line', zx.word(L.CURLINE) === 10, zx.word(L.CURLINE));
    extend(zx, 'b');
    check('EXTEND B: to the new line at the end', zx.word(L.CURLINE) === 0xffff, zx.word(L.CURLINE));
});

/* Numbers at a prompt past the highest a line can have go no higher, so
 * that no line is looked for in the variables. */
test('bignumbers', async () => {
    const program = parseListing(['10 REM one', '20 REM two', '30 REM three', '5000 REM four'].join('\n'), 'p');
    const zx = await withEditor({ program });
    extend(zx, 'g');
    answer(zx, '70000');
    check('EXTEND G 70000: to the new line after 5000', zx.word(L.CURLINE) === 0xffff, zx.word(L.CURLINE));
    typeText(zx, 'let a$="x": let a=7\n');
    const vars = () => hex(Array.from({ length: zx.word(0x5c59) - zx.word(0x5c4b) }, (_, i) => zx.peek(zx.word(0x5c4b) + i)));
    const before = vars();
    extend(zx, 'd');
    answer(zx, '20,99999');
    zx.press('y');
    idle(zx);
    check('EXTEND D 20,99999: lines 20 on taken out', numbersOf(zx).join(',') === '10', numbersOf(zx).join(','));
    check('EXTEND D 20,99999: the variables kept', vars() === before, `${vars()}\n${before}`);
    typeText(zx, '40 rem x\n50 rem y\n');
    extend(zx, 'd');
    answer(zx, '40,65535');
    zx.press('y');
    idle(zx);
    check('EXTEND D 40,65535: lines 40 on taken out', numbersOf(zx).join(',') === '10', numbersOf(zx).join(','));
    check('EXTEND D 40,65535: the variables kept', vars() === before, `${vars()}\n${before}`);
    check('EXTEND D 40,65535: the screen is the listing', sameAsListing(zx), screenDiff(zx));
});

/* The keys, pressed as on the Spectrum. */
test('keys', async () => {
    const zx = await withEditor();
    const S = zx.SPECCY;
    const tap = (...k) => {
        idle(zx);
        zx.tap(k);
    };
    // SYMBOL SHIFT keywords come as their letters
    typeText(zx, '10 if a');
    tap(S.SYMBOL_SHIFT, S.W);          // <>
    typeText(zx, 'b then for i=1');
    tap(S.SYMBOL_SHIFT, S.F);          // TO
    typeText(zx, '5: next i\n');
    check('SYMBOL SHIFT keywords', linesOf(zx)[0] === '  10 IF a<>b THEN FOR i=1 TO 5: NEXT i', linesOf(zx)[0]);
    // CAPS LOCK, and EXTEND for the symbols only E mode gives
    typeText(zx, '20 print "');
    key(zx, 'CAPSLOCK');
    typeText(zx, 'big');
    key(zx, 'CAPSLOCK');
    key(zx, 'EXTEND');
    tap(S.SYMBOL_SHIFT, S.F);          // {
    key(zx, 'EXTEND');
    tap(S.SYMBOL_SHIFT, S.P);          // ©
    typeText(zx, '"\n');
    check('CAPS LOCK and EXTEND symbols', linesOf(zx)[1] === '  20 PRINT "BIG{\u007f"', JSON.stringify(linesOf(zx)[1]));
    // graphics mode
    typeText(zx, '30 print "');
    key(zx, 'GRAPHICS');
    typeText(zx, '1');
    tap(S.CAPS_SHIFT, S.ONE);          // inverse: $8E
    typeText(zx, 'a');                 // the UDG A
    key(zx, 'GRAPHICS');
    typeText(zx, '"\n');
    check('graphics mode', hex(programLines(zx.program())[2].slice(4, 10)) === hex([0xf5, 0x22, 0x81, 0x8e, 0x90, 0x22]),
        hex(programLines(zx.program())[2]));
    // colour controls
    typeText(zx, '40 print "');
    key(zx, 'EXTEND');
    typeText(zx, '2');                 // PAPER 2
    typeText(zx, 'x"\n');
    check('EXTEND and a digit: a colour control', hex(programLines(zx.program())[3].slice(4, 10)) === hex([0xf5, 0x22, 0x11, 0x02, 0x78, 0x22]),
        hex(programLines(zx.program())[3]));
    // the cursor keys, DELETE, overtype, EDIT
    key(zx, 'UP');
    key(zx, 'UP');
    key(zx, 'UP');
    key(zx, 'UP');                     // line 10
    check('UP: onto line 10', zx.word(L.CURLINE) === 10, zx.word(L.CURLINE));
    extend(zx, 'e');                   // its end
    key(zx, 'LEFT');
    extend(zx, 'i');                   // overtype
    typeText(zx, 'j');                 // NEXT i -> NEXT j
    for (let i = 0; i < 9; i++) key(zx, 'LEFT');
    typeText(zx, '9');                 // TO 5 -> TO 9
    extend(zx, 'i');
    key(zx, 'LEFT');
    key(zx, 'DELETE');                 // the space before 9
    typeText(zx, ' ');
    key(zx, 'DOWN');                   // leaving the line puts it in
    check('the line changed and put in on leaving it', linesOf(zx)[0] === '  10 IF a<>b THEN FOR i=1 TO 9: NEXT j', linesOf(zx)[0]);
    check('DOWN: onto line 20', zx.word(L.CURLINE) === 20, zx.word(L.CURLINE));
    typeText(zx, 'zzz');
    key(zx, 'EDIT');
    check('EDIT: the change undone', zx.peek(L.MODIFIED) === 0 && !/zzz/.test(editorScreen(zx)[1]), editorScreen(zx)[1]);
});

/* The listing rows the screen should show: every line as LIST shows it,
 * in rows of 42, the new line as an empty row where it is, from the top
 * line and its row. */
function expectedRows(zx) {
    const rows = [];
    const slotBefore = zx.word(L.SLOTBEF);
    let top = -1;
    let slotDone = false;
    const lines = programLines(zx.program());
    const addSlot = () => {
        if (zx.word(L.TOPLINE) === 0xffff) top = rows.length;
        rows.push('');
        slotDone = true;
    };
    for (const line of lines) {
        const number = (line[0] << 8) | line[1];
        if (!slotDone && (number >= slotBefore)) addSlot();
        if (number === zx.word(L.TOPLINE)) top = rows.length;
        const text = listText(line);
        for (let i = 0; i < text.length; i += 42) rows.push(text.slice(i, i + 42).replace(/\s+$/, ''));
    }
    if (!slotDone) addSlot();
    top += zx.peek(L.TOPSKIP);
    const out = rows.slice(top, top + 23);
    while (out.length < 23) out.push('');
    return out;
}
const sameAsListing = (zx) => expectedRows(zx).every((r, i) => r === editorScreen(zx)[i]);
function screenDiff(zx) {
    const want = expectedRows(zx);
    const got = editorScreen(zx);
    return want.map((r, i) => (r === got[i]) ? null : `row ${i}: ${JSON.stringify(got[i])} not ${JSON.stringify(r)}`).filter(Boolean).slice(0, 4).join('\n');
}

/* A line number alone takes its line out, whether ENTER puts it in or the
 * cursor leaves it, the top line of the screen included. */
test('deleting', async () => {
    let zx = await withEditor();
    typeText(zx, '10 print\n');
    typeText(zx, '10');
    /* From ENTER going down to the editor waiting again: held until the
     * editor takes it from its queue, and let go then so that it does not
     * repeat. */
    const enterKeys = keysFor(zx, 'ENTER');
    const head = zx.peek(L.KQHEAD);
    zx.keyDown(enterKeys);
    let frames = 0;
    while ((zx.peek(L.KQHEAD) === head) && (frames < 3000)) {
        zx.frames(1);
        frames++;
    }
    zx.keyUp(enterKeys);
    while ((zx.peek(STATE) !== 1) && (frames < 3000)) {
        zx.frames(1);
        frames++;
    }
    check(`ENTER on 10 alone: the editor is back in ${frames} frames, under 25`, frames < 25);
    check('ENTER on 10 alone: the only line taken out', zx.program().length === 0, hex(zx.program()));
    check('ENTER on 10 alone: the editor waits on a new line', /^New line/.test(statusRow(zx)) && zx.word(L.CURLINE) === 0xffff, statusRow(zx));
    check('ENTER on 10 alone: the listing is empty', editorScreen(zx).slice(0, 23).every(l => l === ''), editorScreen(zx).join('\n'));
    const program = parseListing(['10 REM one', '20 REM two', '30 REM three', '40 REM four', '50 REM five', '60 REM six'].join('\n'), 'p');
    zx = await withEditor({ program });
    extend(zx, 'b');
    typeText(zx, '10\n');
    check('ENTER on 10 alone, the top line: taken out', numbersOf(zx).join(',') === '20,30,40,50,60', numbersOf(zx).join(','));
    check('ENTER on 10 alone: the cursor on a new line in its place', zx.word(L.CURLINE) === 0xffff && zx.word(L.SLOTBEF) === 11, zx.word(L.SLOTBEF));
    check('ENTER on 10 alone: the screen is the listing', sameAsListing(zx), screenDiff(zx));
    // the line cut down to its number, and left
    const toNumber = () => {
        extend(zx, 'e');
        while (zx.word(L.EDLEN) > 4) key(zx, 'DELETE');
    };
    extend(zx, 't');
    toNumber();
    key(zx, 'DOWN');
    idle(zx);
    check('DOWN from 20 alone, the top line: taken out', numbersOf(zx).join(',') === '30,40,50,60', numbersOf(zx).join(','));
    check('DOWN from 20 alone: onto the line after it', zx.word(L.CURLINE) === 30, zx.word(L.CURLINE));
    check('DOWN from 20 alone: the screen is the listing', sameAsListing(zx), screenDiff(zx));
    key(zx, 'DOWN');
    toNumber();
    key(zx, 'UP');
    idle(zx);
    check('UP from 40 alone: taken out', numbersOf(zx).join(',') === '30,50,60', numbersOf(zx).join(','));
    check('UP from 40 alone: onto the line before it', zx.word(L.CURLINE) === 30, zx.word(L.CURLINE));
    check('UP from 40 alone: the screen is the listing', sameAsListing(zx), screenDiff(zx));
    // and a prompt after it, given up
    toNumber();
    extend(zx, 'd');
    key(zx, 'BREAK');
    idle(zx);
    check('EXTEND D from 30 alone, given up: 30 taken out', numbersOf(zx).join(',') === '50,60', numbersOf(zx).join(','));
    check('EXTEND D from 30 alone: the screen is the listing', sameAsListing(zx), screenDiff(zx));
});

/* A long program: down to its end and back, and a page at a time. */
test('scrolling', async () => {
    const program = listing('tetris.bas');
    const zx = await withEditor({ program });
    extend(zx, 't');
    const numbers = numbersOf(zx);
    for (let i = 0; i < 40; i++) key(zx, 'DOWN');
    idle(zx);
    const row = zx.peek(L.CXROW);
    check('40 rows down: the cursor is on the screen', row < 23, row);
    const lineRow = editorScreen(zx).findIndex(r => r.startsWith(String(zx.word(L.CURLINE)).padStart(4, ' ')));
    check('and its line is listed where the cursor is', (lineRow >= 0) && (lineRow <= row), `${lineRow} ${row}`);
    check('the screen is the listing from its top line', sameAsListing(zx), screenDiff(zx));
    key(zx, 'PGDN');
    key(zx, 'PGDN');
    idle(zx);
    const top = zx.word(L.TOPLINE);
    check('two pages down: the top has moved on', numbers.indexOf(top) > 20, top);
    check('two pages down: the screen is the listing from its top line', sameAsListing(zx), screenDiff(zx));
    extend(zx, 'u');
    const upTop = zx.word(L.TOPLINE);
    check('EXTEND U: a page up', numbers.indexOf(upTop) < numbers.indexOf(top), `${upTop} after ${top}`);
    check('EXTEND U: the screen is the listing from its top line', sameAsListing(zx), screenDiff(zx));
    extend(zx, 'j');
    check('EXTEND J: a page down, back where it was', zx.word(L.TOPLINE) === top, `${zx.word(L.TOPLINE)} not ${top}`);
    check('EXTEND J: the screen is the listing from its top line', sameAsListing(zx), screenDiff(zx));
    extend(zx, 'b');
    check('EXTEND B: the new line at the end is on the screen', zx.peek(L.CXROW) < 23 && zx.word(L.CURLINE) === 0xffff);
    let pages = 0;
    for (let last = -1; (pages < 20) && ((zx.word(L.TOPLINE) !== last) || zx.peek(L.TOPSKIP)); pages++) {
        last = zx.word(L.TOPLINE);
        key(zx, 'PGUP');
        idle(zx);
    }
    check('pages up: back at the top', zx.word(L.TOPLINE) === numbers[0] && zx.peek(L.TOPSKIP) === 0, `${zx.word(L.TOPLINE)}/${zx.peek(L.TOPSKIP)}`);
    const screen = editorScreen(zx);
    check('the top of the listing is shown', screen[0] === listText(programLines(zx.program())[0]).slice(0, 42).replace(/\s+$/, ''), screen[0]);
    const start = zx.word(L.CURLINE);
    for (let i = 0; i < 30; i++) key(zx, 'DOWN');
    for (let i = 0; i < 30; i++) key(zx, 'UP');
    idle(zx);
    check('30 rows down and 30 up: back on the same line', zx.word(L.CURLINE) === start, `${zx.word(L.CURLINE)} not ${start}`);
    check('and the screen is the listing from its top line, as drawn whole', sameAsListing(zx), screenDiff(zx));
});

/* A line too long to edit is listed in full and can be passed, but not changed. */
test('longline', async () => {
    const long = 'x'.repeat(600);
    const zx = await withEditor({ program: parseListing(`10 REM ${long}\n20 PRINT 2`, 'p') });
    extend(zx, 't');
    check('the cursor on the long line: it cannot be edited', zx.peek(L.READONLY) === 1 && zx.word(L.CURLINE) === 10);
    check('it is listed in full while the cursor is on it', sameAsListing(zx), screenDiff(zx));
    const before = zx.program();
    typeText(zx, 'y');
    check('typing does not change it, and says why', (hex(zx.program()) === hex(before)) && /too long to edit/.test(statusRow(zx)), statusRow(zx));
    key(zx, 'DOWN');
    check('DOWN goes straight to the next line', zx.word(L.CURLINE) === 20, zx.word(L.CURLINE));
    key(zx, 'UP');
    check('UP comes back onto it', zx.word(L.CURLINE) === 10, zx.word(L.CURLINE));
});

/* A line too long for the screen's rows to be counted in a byte: it is
 * listed to MAXROWS rows, and the lines around it as they are. */
test('hugeline', async () => {
    const zx = await withEditor({ program: parseListing(`5 PRINT 5\n10 REM ${'x'.repeat(6000)}\n20 PRINT 2`, 'p') });
    extend(zx, 't');
    const screen = editorScreen(zx);
    check('the top: line 5, then the long line', (screen[0] === '   5 PRINT 5') && screen[1].startsWith('  10 REM xxx') && (screen[22] === 'x'.repeat(42)), screen.slice(0, 2).join('|'));
    check('the cursor on line 5', (zx.word(L.CURLINE) === 5) && (zx.peek(L.CXROW) === 0), zx.peek(L.CXROW));
    key(zx, 'DOWN');
    idle(zx);
    check('DOWN: onto the long line, which is shown', (zx.word(L.CURLINE) === 10) && (zx.peek(L.CXROW) < 23) && editorScreen(zx).some(r => r.startsWith('  10 REM')), zx.peek(L.CXROW));
    key(zx, 'DOWN');
    idle(zx);
    const after = editorScreen(zx);
    check('DOWN: onto the line after it, which is shown after its rows', (zx.word(L.CURLINE) === 20) && (zx.peek(L.CXROW) < 23) && after.includes('  20 PRINT 2') && (after[after.indexOf('  20 PRINT 2') - 1] === 'x'.repeat(42)),
        after.join('|'));
    check(`it is drawn in ${L.MAXROWS} rows`, zx.word(L.TOPLINE) === 10 && zx.peek(L.TOPSKIP) === L.MAXROWS - after.indexOf('  20 PRINT 2'), `${zx.word(L.TOPLINE)}/${zx.peek(L.TOPSKIP)}`);
});

/* Edges: a line numbered 0, a prompt filled past the status row, EXTEND F
 * for nothing, a nearly full line, and a line number above 9999. */
test('limits', async () => {
    const zx = await withEditor({ program: parseListing(`10 REM ${'x'.repeat(490)}`, 'p') });
    const S = zx.SPECCY;
    // 0 is not a line number: the ROM runs it as a command
    typeText(zx, '0 print 1');
    key(zx, 'UP');
    idle(zx);
    check('UP off a line numbered 0: it stays, as a command', /^No number/.test(statusRow(zx)) && (zx.word(L.CURLINE) === 0xffff), statusRow(zx));
    check('UP off a line numbered 0: no line 0', numbersOf(zx).join(',') === '10', numbersOf(zx).join(','));
    key(zx, 'BREAK');
    extend(zx, 'r');
    answer(zx, '0,10');
    check('EXTEND R from 0: from 1', numbersOf(zx).join(',') === '1', numbersOf(zx).join(','));
    // a prompt stops where the status row does
    extend(zx, 'r');
    typeText(zx, '1'.repeat(45));
    check('a prompt filled up: the cursor just after what is shown, on the row', (zx.peek(L.CXCOL) === statusRow(zx).length) && (zx.peek(L.CXCOL) <= 41) && statusRow(zx).startsWith('Renumber from,step:'),
        `${zx.peek(L.CXCOL)} ${JSON.stringify(statusRow(zx))}`);
    key(zx, 'BREAK');
    idle(zx);
    // EXTEND F for nothing: the cursor back on the listing
    extend(zx, 'f');
    answer(zx, '');
    check('EXTEND F for nothing: the cursor back on the listing', zx.peek(L.CXROW) < 23, zx.peek(L.CXROW));
    // a keyword or a colour control goes in whole, or not at all
    extend(zx, 't');
    extend(zx, 'e');
    while (zx.word(L.EDLEN) < 508) typeText(zx, 'x');
    idle(zx);
    zx.tap([S.SYMBOL_SHIFT, S.A]);     // STOP, with spaces: 6 bytes
    idle(zx);
    check('SYMBOL SHIFT keyword with 4 bytes of room: refused whole', (zx.word(L.EDLEN) === 508) && /line is full/.test(statusRow(zx)), `${zx.word(L.EDLEN)} ${statusRow(zx)}`);
    typeText(zx, 'xxx');
    key(zx, 'EXTEND');
    typeText(zx, '1');                 // PAPER 1: 2 bytes
    check('EXTEND colour with 1 byte of room: refused whole', (zx.word(L.EDLEN) === 511) && /line is full/.test(statusRow(zx)), `${zx.word(L.EDLEN)} ${statusRow(zx)}`);
    key(zx, 'BREAK');
    // a line number above 9999, as only POKE makes
    const prog = zx.word(0x5c53);
    zx.poke(prog, 12345 >> 8);
    zx.poke(prog + 1, 12345 & 255);
    extend(zx, 'b');
    extend(zx, 't');
    check('the status row gives a line number above 9999 in full', /^Line 12345/.test(statusRow(zx)), statusRow(zx));
});

/* EXTEND Q: back to the ROM's editor, which lists the program. */
test('quit', async () => {
    const zx = await withEditor({ program: parseListing('10 PRINT 1\n20 PRINT 2', 'p') });
    extend(zx, 'g');
    answer(zx, '20');
    key(zx, 'EXTEND');
    idle(zx);
    zx.press('q');
    zx.until(() => { const e = zx.editor(); return !!(e && e.command); }, 500, 'the ROM\'s editor');
    zx.frames(50);
    check('the ROM\'s editor waits, and stays', !!zx.editor() && (zx.peek(STATE) === 0));
    check('it lists the program, line 20 marked current', zx.screen()[1] === '  20>PRINT 2', zx.screen().slice(0, 2).join('|'));
});

/* EDITOR from the Projects cassette, as the starter programs give it:
 * LOAD "" loads the loader, which loads the code and starts the editor. */
test('cassette', async () => {
    const { parseCassetteFile, parseHeader } = await import('../runtime/cassette.js');
    const tape = parseCassetteFile(new Uint8Array(fs.readFileSync('static/starter/projects.tzx')));
    const blocks = tape.blocks.map(b => b.data);
    const at = blocks.findIndex(d => { const h = parseHeader(d); return h && (h.name === 'EDITOR'); });
    check('the cassette has EDITOR', at >= 0);
    const code = blocks[at + 3].slice(1, -1);
    const assembled = assemble(fs.readFileSync(SOURCE, 'utf8'), SOURCE).bytes;
    check('its CODE block is the code as it now assembles', hex(code) === hex(assembled), 'run node tools/gen-starter.js');
    const zx = await createSpectrum({ tape: blocks.slice(at, at + 4) });
    zx.command('LOAD ""', { wait: false });
    idle(zx, 5000);
    check('LOAD "" starts the editor', /^New line/.test(statusRow(zx)), statusRow(zx));
    check('on an empty program', zx.program().length === 0);
    typeText(zx, '10 print "ok"\n');
    check('and it works', editorScreen(zx)[0] === '  10 PRINT "ok"', editorScreen(zx)[0]);
});

const only = process.argv.slice(2);
for (const t of tests) {
    if (only.length && !only.some(o => t.name.startsWith(o))) continue;
    console.log(`-- ${t.name}`);
    try {
        await t.fn();
    } catch (err) {
        check(`${t.name} ran`, false, err.stack || err.message);
    }
}
console.log(failures ? `${failures} of ${checks} checks failed` : `All ${checks} checks passed`);
process.exit(failures ? 1 : 0);

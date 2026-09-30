/*
 * tools/gen-starter.js: make the starter cassettes and Microdrive cartridges
 * a first visit finds in the boxes, from the listings and trees in starter/.
 *
 * Usage (run from the project root, after `npm run build`, whose core it
 * runs):
 *   node tools/gen-starter.js
 *
 * starter/starter.json names each cassette and cartridge and what goes on
 * it. Each program's listing (see tools/zxbasic.js for how one is written) is
 * entered line by line into a Spectrum 48K run in Node (tools/zxheadless.js),
 * whose ROM checks every line as it would a typed one, and is saved from
 * there: with SAVE onto a cassette, or with the Interface 1's SAVE * onto a
 * cartridge. A guessing game's tree (see readTree below) goes onto a
 * cartridge as the character array the game loads. The results are written
 * to static/starter/: a .tzx file per cassette, labelled, a .mdr file per
 * cartridge, and index.json describing them all for the Starter programs
 * dialog (runtime/starter.js). They are committed, so the build only copies
 * them; run this again after changing anything in starter/.
 */

import fs from 'fs';
import path from 'path';

import { createSpectrum } from './zxheadless.js';
import { parseListing } from './zxbasic.js';
import { writeCassetteTAP, writeCassetteTZX, parseCassetteFile, blockMs, parseHeader } from '../runtime/cassette.js';
import * as mdr from '../runtime/mdr.js';

const SOURCE = 'starter';
const OUT = 'static/starter';

const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE, 'starter.json'), 'utf8'));

const listing = (file) => parseListing(fs.readFileSync(path.join(SOURCE, file), 'utf8'), file);

// Waits for SAVE's "Start tape, then press any key.", and presses one.
function startTape(zx) {
    zx.until(() => zx.screen().some(line => line.includes('press any key')), 500, 'SAVE to ask for the tape');
    zx.press('y');
    zx.ready();
}

// A program saved to tape as SAVE "name" LINE line saves it: its header and data blocks.
async function programBlocks(program) {
    const zx = await createSpectrum();
    zx.enterListing(listing(program.source));
    zx.command(`SAVE "${program.name}" LINE ${program.line}`, { wait: false });
    startTape(zx);
    if (zx.saved.length !== 2) throw new Error(`${program.source}: SAVE wrote ${zx.saved.length} blocks`);
    return zx.saved;
}

/* A guessing game's tree, written as indented lines: a question starts with
 * "?", and the two lines indented under it are its yes and its no answers,
 * each a question or a thing, which starts with "=". The first line is the
 * theme, starting with "T". Returns the rows of the game's array: the theme
 * as "T" + the number of rows used (3 digits) + the theme, then each node as
 * "Q" + the rows of its yes and no answers (3 digits each) + the question,
 * or "A" + the thing. */
function readTree(file, rows, width) {
    const text = fs.readFileSync(path.join(SOURCE, file), 'utf8').replace(/\r\n?/g, '\n');
    const lines = text.split('\n')
        .map((line, i) => ({ line, where: `${file}:${i + 1}` }))
        .filter(({ line }) => line.trim() && !line.trim().startsWith('#'));
    const first = lines.shift();
    if (!first || !first.line.startsWith('T ')) throw new Error(`${file}: the first line is the theme, "T ..."`);
    const theme = first.line.slice(2).trim();
    let at = 0;
    const nodes = [];
    const things = new Set();
    const check = (textPart, max, where) => {
        if (textPart.length > max) throw new Error(`${where}: "${textPart}" is longer than ${max} characters`);
        if (/["\\]/.test(textPart) || /[^\x20-\x7e]/.test(textPart)) throw new Error(`${where}: "${textPart}" has a character the game can't keep`);
    };
    // Reads the node at lines[at], indented by `indent`; returns its row.
    const node = (indent) => {
        const entry = lines[at];
        if (!entry) throw new Error(`${file}: the tree ends where an answer is missing`);
        const own = entry.line.length - entry.line.trimStart().length;
        if (own !== indent) throw new Error(`${entry.where}: expected indent ${indent}, found ${own}`);
        const body = entry.line.trim();
        at++;
        const row = nodes.length + 2;
        if (body.startsWith('= ')) {
            const thing = body.slice(2).trim();
            check(thing, width - 1, entry.where);
            if (things.has(thing.toLowerCase())) throw new Error(`${entry.where}: "${thing}" is in the tree twice`);
            things.add(thing.toLowerCase());
            nodes.push('A' + thing);
            return row;
        }
        if (!body.startsWith('? ')) throw new Error(`${entry.where}: a line is "? question" or "= thing"`);
        const question = body.slice(2).trim();
        check(question, width - 7, entry.where);
        if (!question.endsWith('?')) throw new Error(`${entry.where}: a question ends with "?"`);
        nodes.push(null);
        const yes = node(indent + 2);
        const no = node(indent + 2);
        nodes[row - 2] = 'Q' + String(yes).padStart(3, '0') + String(no).padStart(3, '0') + question;
        return row;
    };
    node(0);
    if (at < lines.length) throw new Error(`${lines[at].where}: this line is outside the tree`);
    const used = nodes.length + 1;
    if (used > rows) throw new Error(`${file}: the tree takes ${used} rows, the array has ${rows}`);
    check(theme, width - 4, first.where);
    return { rows: ['T' + String(used).padStart(3, '0') + theme, ...nodes], things: things.size, questions: nodes.length - things.size };
}

// A cartridge made by the Interface 1's own SAVE *, formatted with the cartridge's name.
async function makeCartridge(cartridge) {
    const zx = await createSpectrum({ interface1: true });
    zx.insertCartridge(0, mdr.quickFormat(mdr.MAX_BLOCKS, cartridge.name));
    const files = [];
    for (const file of cartridge.files) {
        zx.command('NEW');
        if (file.source) {
            zx.enterListing(listing(file.source));
            zx.command(`SAVE *"m";1;"${file.name}" LINE ${file.line}`);
            files.push({ name: file.name, about: file.about, loadCommand: `LOAD *"m";${cartridge.drive};"${file.name}"` });
        } else {
            const [rows, width] = file.dim;
            const tree = readTree(file.tree, rows, width);
            zx.command(`DIM t$(${rows},${width})`);
            tree.rows.forEach((row, i) => zx.command(`LET t$(${i + 1})="${row}"`));
            zx.command(`SAVE *"m";1;"${file.name}" DATA t$()`);
            console.log(`  ${file.name}: ${tree.questions} questions, ${tree.things} things, ${tree.rows.length} of ${rows} rows`);
            files.push({ name: file.name, about: file.about, loadCommand: `LOAD *"m";${cartridge.drive};"${file.name}" DATA t$()` });
        }
        zx.settle();
        const report = zx.report();
        if (!report.startsWith('0 OK')) throw new Error(`${cartridge.file}: saving ${file.name} gave "${report}"`);
    }
    const image = zx.cartridge(0);
    const split = mdr.splitMDRFile(image);
    const parsed = mdr.parse(split.data, false);
    const names = parsed.files.map(f => f.name).sort().join(',');
    const wanted = cartridge.files.map(f => f.name).sort().join(',');
    if (names !== wanted) throw new Error(`${cartridge.file}: CAT gives ${names}, expected ${wanted}`);
    return { image, files, freeK: Math.floor(parsed.freeSectors / 2) };
}

const index = { cassettes: [], cartridges: [] };
fs.mkdirSync(OUT, { recursive: true });

for (const cas of manifest.cassettes) {
    const blocks = [];
    for (const program of cas.programs) blocks.push(...await programBlocks(program));
    // Spaced as a TAP plays them, a second of blank tape after each block.
    const spaced = parseCassetteFile(writeCassetteTAP(blocks.map(data => ({ data })))).blocks;
    fs.writeFileSync(path.join(OUT, cas.file), writeCassetteTZX({ blocks: spaced, label: cas.label }));
    const programs = cas.programs.map((program, i) => {
        const header = parseHeader(spaced[2 * i].data);
        return { name: program.name, about: program.about, startMs: Math.round(spaced[2 * i].startMs), bytes: header.length };
    });
    const endMs = spaced.length ? spaced[spaced.length - 1].startMs + blockMs(spaced[spaced.length - 1].data) : 0;
    console.log(`${cas.file}: "${cas.label}", ${programs.length} programs, ${(endMs / 1000).toFixed(0)} s of tape`);
    programs.forEach(p => console.log(`  ${String(Math.floor(p.startMs / 1000)).padStart(4, '0')}  ${p.name.padEnd(10)} ${p.bytes} bytes`));
    index.cassettes.push({ file: cas.file, label: cas.label, colour: cas.colour, writeProtect: !!cas.writeProtect, about: cas.about, programs });
}

for (const cartridge of manifest.cartridges) {
    console.log(`${cartridge.file}: "${cartridge.name}"`);
    const made = await makeCartridge(cartridge);
    fs.writeFileSync(path.join(OUT, cartridge.file), made.image);
    console.log(`  ${made.files.map(f => f.name).join(', ')}; ${made.freeK}K free`);
    index.cartridges.push({ file: cartridge.file, name: cartridge.name, colour: cartridge.colour, drive: cartridge.drive, about: cartridge.about, files: made.files });
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2).replace(/\n/g, '\r\n') + '\r\n');
console.log(`Written to ${OUT}/`);

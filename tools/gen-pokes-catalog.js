/*
 * tools/gen-pokes-catalog.js — compile a directory tree of .pok files into the
 * compact JSON catalog shipped as static/pokes/pokes.json.
 *
 * Usage:
 *   node tools/gen-pokes-catalog.js <path-to-all-tipshop-pokes> [output.json]
 *
 * The input is a checkout of https://github.com/ladyeklipse/all-tipshop-pokes
 * (the complete Tipshop poke database, one .pok file per game, filenames in
 * TOSEC style: "Game Name (year)(Publisher).pok").
 *
 * .POK file format (worldofspectrum.net POKformat.txt):
 *   N<trainer name>          start of a trainer (cheat), name follows the N
 *   M <bank> <addr> <val> <orig>   a poke belonging to the trainer (more follow)
 *   Z <bank> <addr> <val> <orig>   the trainer's last poke
 *   Y                        end of file
 * bank: bit 3 set (value 8) = ignore bank / poke via current paging; 0-7 = a
 * specific 128K RAM bank. val 256 = ask the user for the value at apply time.
 *
 * Output JSON shape (arrays to keep the file small; decoded by pokes-db.js):
 *   { version, source, games: [ [name, year, publisher, [ [trainerName,
 *     [ [bank, addr, val, orig], ... ] ], ... ] ], ... ] }
 */

import fs from 'fs';
import path from 'path';

const srcDir = process.argv[2];
const outFile = process.argv[3] || 'static/pokes/pokes.json';

if (!srcDir) {
    console.error('Usage: node tools/gen-pokes-catalog.js <all-tipshop-pokes dir> [output.json]');
    process.exit(1);
}

const pokFiles = [];
const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '.git') continue;
            walk(full);
        } else if (entry.name.toLowerCase().endsWith('.pok')) {
            pokFiles.push(full);
        }
    }
};
walk(srcDir);
pokFiles.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

// "Game Name (1987)(Publisher)(extra…).pok" → [name, year, publisher]
const parseFilename = (filename) => {
    const base = path.basename(filename).replace(/\.pok$/i, '');
    const m = base.match(/^(.*?)\s*\((\d{4}|19xx|20xx)\)\(([^)]*)\)/);
    if (!m) return [base, 0, ''];
    const year = /^\d{4}$/.test(m[2]) ? parseInt(m[2], 10) : 0;
    return [m[1], year, m[3]];
};

let trainerCount = 0;
let pokeCount = 0;
let badLines = 0;

const parsePok = (text, filename) => {
    const trainers = [];
    let current = null;
    for (let rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/\s+$/, '');
        if (line === '') continue;
        const kind = line[0];
        if (kind === 'N') {
            current = [line.slice(1).trim(), []];
            trainers.push(current);
        } else if (kind === 'M' || kind === 'Z') {
            const parts = line.slice(1).trim().split(/\s+/).map(Number);
            const [bank, addr, val, orig] = parts;
            if (parts.length < 4 || parts.some(isNaN)
                || addr < 0x4000 || addr > 0xffff || val < 0 || val > 256 || orig < 0 || orig > 255) {
                console.warn(`bad poke line in ${path.basename(filename)}: "${line}"`);
                badLines++;
                continue;
            }
            if (current) {
                current[1].push([bank, addr, val, orig]);
                pokeCount++;
            }
        } else if (kind === 'Y') {
            break;
        } else {
            console.warn(`unrecognised line in ${path.basename(filename)}: "${line}"`);
            badLines++;
        }
    }
    // drop trainers that ended up with no valid pokes
    return trainers.filter(t => t[1].length > 0);
};

const games = [];
for (const file of pokFiles) {
    const [name, year, pub] = parseFilename(file);
    const trainers = parsePok(fs.readFileSync(file, 'latin1'), file);
    if (trainers.length === 0) continue;
    trainerCount += trainers.length;
    games.push([name, year, pub, trainers]);
}

const catalog = {
    version: 1,
    source: 'The Tipshop (www.the-tipshop.co.uk), via the all-tipshop-pokes database v2.5 by Lady Eklipse',
    games,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(catalog));
console.log(`${games.length} games, ${trainerCount} trainers, ${pokeCount} pokes -> ${outFile}`
    + ` (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`
    + (badLines ? `; ${badLines} bad line(s) skipped` : ''));

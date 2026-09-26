/*
 * tools/copy-static.js: copy the files that ship unchanged (the page, the
 * ROMs, the tape loaders, the pokes and PlayZX catalogs, the sql.js
 * WebAssembly and the documents) into dist/.
 *
 * Usage (run from the project root, as `npm run build:static` does):
 *   node tools/copy-static.js
 *
 * It is a Node script rather than a chain of shell commands so the build runs
 * the same from cmd and PowerShell as from a POSIX shell.
 */

import fs from 'fs';
import path from 'path';

// [source, destination]; a directory is copied with everything in it
const COPIES = [
    ['static/index.html', 'dist/index.html'],
    ['static/favicon.ico', 'dist/favicon.ico'],
    ['README.md', 'dist/README.md'],
    ['COPYING', 'dist/COPYING'],
    ['CHANGELOG.md', 'dist/CHANGELOG.md'],
    ['static/roms', 'dist/jsspeccy/roms'],
    ['static/tapeloaders', 'dist/jsspeccy/tapeloaders'],
    ['static/pokes/pokes.json', 'dist/jsspeccy/pokes/pokes.json'],
    ['static/zx_keyboard.png', 'dist/jsspeccy/zx_keyboard.png'],
    ['static/playzx', 'dist/jsspeccy/playzx'],
    ['node_modules/sql.js/dist/sql-wasm.wasm', 'dist/jsspeccy/sql-wasm.wasm'],
];

for (const [src, dest] of COPIES) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
}

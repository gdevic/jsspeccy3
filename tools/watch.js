/*
 * tools/watch.js: rebuild the parts of the site whose sources change.
 *
 * Usage (run from the project root, as `npm run watch` does):
 *   node tools/watch.js
 *
 * The "watch" section of package.json names the npm scripts to rerun and the
 * files that trigger each one: "patterns" are paths from the project root
 * whose file name may hold a * (any run of characters), and "extensions", when
 * given, limits them further. A full
 * build runs first, then watching starts. Scripts run one at a time, each
 * once the files have been quiet for a moment, so a burst of changes (an
 * editor saving several files, or one script writing a file another one
 * watches) runs each script once, and no script reads a file that another
 * one is still writing.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const SETTLE_MS = 200;

const globToRegExp = (glob) => new RegExp('^' + glob.split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*') + '$');

const tasks = Object.entries(JSON.parse(fs.readFileSync('package.json', 'utf8')).watch)
    .map(([script, { patterns, extensions }]) => ({
        script,
        patterns: [].concat(patterns),
        matchers: [].concat(patterns).map(globToRegExp),
        extensions: extensions === undefined ? null : [].concat(extensions),
    }));

const pending = new Set();
let lastChange = 0;
let busy = false;

const run = (script) => new Promise((resolve) => {
    console.log(`[watch] npm run ${script}`);
    spawn(`npm run ${script}`, { shell: true, stdio: 'inherit' }).on('exit', (code) => {
        if (code) console.log(`[watch] ${script} failed with exit code ${code}`);
        resolve();
    });
});

const settle = () => new Promise((resolve) => {
    const check = () => {
        const quiet = Date.now() - lastChange;
        if (quiet >= SETTLE_MS) resolve();
        else setTimeout(check, SETTLE_MS - quiet);
    };
    check();
});

const drain = async () => {
    busy = true;
    while (pending.size) {
        await settle();
        const [script] = pending;
        pending.delete(script);
        await run(script);
    }
    busy = false;
};

const changed = (file) => {
    for (const task of tasks) {
        if ((!task.extensions || task.extensions.includes(path.extname(file).slice(1))) && task.matchers.some(m => m.test(file))) {
            pending.add(task.script);
            lastChange = Date.now();
        }
    }
    if (pending.size && !busy) drain();
};

await run('build');

const dirs = [...new Set(tasks.flatMap(task => task.patterns.map(p => path.posix.dirname(p))))];
for (const dir of dirs) {
    fs.watch(dir, (event, name) => {
        if (name) changed(path.posix.join(dir, name.replaceAll('\\', '/')));
    });
}
console.log(`[watch] watching ${dirs.join(', ')}; press Ctrl+C to stop`);

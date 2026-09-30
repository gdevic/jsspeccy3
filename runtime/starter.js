/*
 * runtime/starter.js: the starter programs, cassettes and Microdrive
 * cartridges of original BASIC programs that a first visit finds in the
 * boxes, and File -> Starter programs…, which lists them and puts back
 * whatever is missing.
 *
 * tools/gen-starter.js makes them from the listings in starter/ and ships
 * them in static/starter/: a .tzx file for each cassette, an .mdr file for
 * each cartridge, and index.json describing them all. They are fetched only
 * when they are wanted.
 *
 * A first visit is one where both boxes are empty and localStorage has no
 * jsspeccy-starter entry. The boxes are filled then, the first cassette
 * goes into the recorder unless a tape is in it already, and each cartridge
 * into its drive if that is empty; the entry is then written, so it happens
 * once. The devices are left connected or not as they are, and nothing goes
 * into one that is disconnected.
 */

import { openDialog, h, button } from './dialog.js';
import { counterText } from './cassette.js';

const FIRST_VISIT_KEY = 'jsspeccy-starter';
const INDEX = 'starter/index.json';

function seeded() {
    try {
        return localStorage.getItem(FIRST_VISIT_KEY) !== null;
    } catch (e) {
        return true;  // without storage every visit would look like the first
    }
}

function markSeeded() {
    try {
        localStorage.setItem(FIRST_VISIT_KEY, JSON.stringify({ seeded: Date.now() }));
    } catch (e) { /* private browsing / quota / disabled storage */ }
}

/* The starter programs for a page with a tape recorder and Microdrives:
 * {seedIfFirstVisit, openDialog}. `scriptUrl` is where the emulator's
 * script came from, which static/starter/ sits beside. */
export function createStarter(ui, emu, { tapeDeck, microdriveDock, scriptUrl }) {
    const url = (path) => new URL(path, scriptUrl).href;

    // index.json, fetched once; a fetch that fails is forgotten, so the next one tries again.
    let indexPromise = null;
    function loadIndex() {
        if (!indexPromise) {
            indexPromise = fetch(url(INDEX)).then(resp => {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                return resp.json();
            }).catch(err => {
                indexPromise = null;
                throw err;
            });
        }
        return indexPromise;
    }

    async function fetchFile(file) {
        const resp = await fetch(url('starter/' + file));
        if (!resp.ok) throw new Error(`${file}: HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    /* Puts every starter cassette and cartridge the boxes lack into them,
     * then the first cassette into the recorder if it is connected and
     * empty, and each cartridge into its drive if the Microdrives are
     * connected and the drive is empty. A cassette or cartridge the box has
     * is found by its label, so that one from an earlier set of starter
     * programs, or the DATA cartridge the guessing game has saved onto, is
     * kept rather than added again; failing that by its bytes, as an import
     * finds it. Resolves to {added, kept, unstored}, counts of cassettes
     * and cartridges. */
    async function putInBoxes() {
        const index = await loadIndex();
        const counts = { added: 0, kept: 0, unstored: 0 };
        const tally = (result) => {
            if (!result.id) counts.unstored++;
            else if (result.added) counts.added++;
            else counts.kept++;
            return result.id;
        };

        const cassetteIds = [];
        const boxCassettes = await tapeDeck.cassettes();
        for (const cas of index.cassettes) {
            const named = boxCassettes.find(meta => meta.label === cas.label);
            if (named) {
                cassetteIds.push(tally({ id: named.id, added: false }));
                continue;
            }
            const data = await fetchFile(cas.file);
            cassetteIds.push(tally(await tapeDeck.addToBox(data, cas.file, { colour: cas.colour, writeProtect: cas.writeProtect })));
        }

        const cartridgeIds = [];
        const boxCartridges = await microdriveDock.cartridges();
        for (const cart of index.cartridges) {
            const named = boxCartridges.find(meta => meta.label === cart.name);
            if (named) {
                cartridgeIds.push(tally({ id: named.id, added: false }));
                continue;
            }
            const data = await fetchFile(cart.file);
            cartridgeIds.push(tally(await microdriveDock.addToBox(data, cart.colour)));
        }

        if (cassetteIds[0] && tapeDeck.isConnected() && tapeDeck.slotFree()) {
            await tapeDeck.rewind(cassetteIds[0]);
            await tapeDeck.insertFromBox(cassetteIds[0]);
        }
        if (microdriveDock.isConnected()) {
            for (let i = 0; i < index.cartridges.length; i++) {
                if (cartridgeIds[i]) await microdriveDock.insertFromBox(index.cartridges[i].drive - 1, cartridgeIds[i]);
            }
        }
        return counts;
    }

    /* On a first visit, once the recorder and the drives are back as they
     * were left (and whatever the page opened at startup is in), the boxes
     * are filled. */
    async function seedIfFirstVisit() {
        await Promise.all([tapeDeck.whenReady, microdriveDock.whenReady]);
        if (seeded()) return;
        const [cassettes, cartridges] = await Promise.all([tapeDeck.cassettes(), microdriveDock.cartridges()]);
        if (cassettes.length || cartridges.length) {
            markSeeded();
            return;
        }
        try {
            const counts = await putInBoxes();
            if (!counts.unstored) markSeeded();
        } catch (err) {
            console.warn('Could not put the starter programs in the boxes:', err);
        }
    }

    function swatch(colour) {
        const s = h('div', 'jsd-swatch static');
        s.style.background = colour;
        return s;
    }

    function card(colour, title, badge, about) {
        const c = h('div', 'jsd-card');
        const top = h('div', 'jsd-card-top');
        top.append(swatch(colour), h('span', 'jsd-row-title jsd-grow', { textContent: title }), h('span', 'jsd-badge', { textContent: badge }));
        c.append(top, h('div', 'jsd-note', { textContent: about }));
        return c;
    }

    function item(name, about, extra) {
        const row = h('div', 'jsd-starter-item');
        const head = h('div', 'jsd-card-row');
        if (extra) head.appendChild(h('span', 'jsd-badge', { textContent: extra }));
        head.appendChild(h('b', 'jsd-mono', { textContent: name }));
        row.append(head, h('div', 'jsd-row-meta', { textContent: about }));
        return row;
    }

    /* File -> Starter programs…: what is on each cassette and cartridge,
     * and a button that puts back whatever the boxes lack. */
    function openStarterDialog() {
        const dlg = openDialog(ui, emu, { id: 'starter', title: 'Starter programs', subtitle: 'Cassettes and Microdrive cartridges to try', width: 640, height: 660 });
        const bar = h('div', 'jsd-bar');
        const put = button('Put them in the boxes', { variant: 'primary', title: 'Add the starter cassettes and cartridges the boxes are missing' });
        bar.append(h('div', 'jsd-note jsd-grow', { textContent: 'They are in the tape cassette box and the Microdrive cartridge box. Anything taken out of the boxes can be put back from here.' }), put);
        const scroll = h('div', 'jsd-scroll');
        dlg.body.append(bar, scroll);
        put.disabled = true;
        dlg.setStatus('Loading the list…', 'busy');

        loadIndex().then(index => {
            if (dlg.closed) return;
            const grid = h('div', 'jsd-grid');
            for (const cas of index.cassettes) {
                const c = card(cas.colour, cas.label, 'Cassette', cas.about);
                cas.programs.forEach(p => c.appendChild(item(p.name, p.about, counterText(p.startMs))));
                grid.appendChild(c);
            }
            for (const cart of index.cartridges) {
                const c = card(cart.colour, cart.name, `Microdrive ${cart.drive}`, cart.about);
                cart.files.forEach(f => c.appendChild(item(f.name, f.about, null)));
                grid.appendChild(c);
            }
            const help = h('div', 'jsd-help');
            help.innerHTML = 'On a cassette, each program has its place on the tape counter. Click the recorder for the list of its parts: '
                + 'click one to wind there, then Type in puts <code>LOAD ""</code> into the Spectrum, in 48 BASIC, for you to press Enter.<br>'
                + 'With the HOME cartridge in Microdrive 1 and DATA in Microdrive 2, type <code>RUN</code> in 48 BASIC with no program in the '
                + 'Spectrum for the HOME cartridge\'s menu.<br>The printer programs want the ZX Printer connected.';
            scroll.append(grid, help);
            put.disabled = false;
            dlg.setStatus('', null);
        }).catch(err => {
            dlg.setStatus('Could not load the list of starter programs: ' + err.message, 'error');
        });

        put.addEventListener('click', async () => {
            put.disabled = true;
            dlg.setStatus('Putting them in the boxes…', 'busy');
            try {
                const counts = await putInBoxes();
                const parts = [];
                if (counts.added) parts.push(`${counts.added} put in the boxes`);
                if (counts.kept) parts.push(`${counts.kept} already there`);
                if (counts.unstored) parts.push(`${counts.unstored} the browser would not keep`);
                dlg.setStatus(parts.join(', ') + '.', counts.unstored ? 'error' : 'ok');
            } catch (err) {
                dlg.setStatus('Could not put them in the boxes: ' + err.message, 'error');
            }
            put.disabled = false;
        });
    }

    return { seedIfFirstVisit, openDialog: openStarterDialog };
}

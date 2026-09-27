/*
 * runtime/pokes.js — the "Pokes…" (game cheats) dialog.
 *
 * Exposes openPokesDialog(ui, emu): searches the Tipshop-derived pokes catalog
 * (pokes-db.js) for the currently loaded game, lists its trainers (cheats) and
 * applies/undoes them with checkboxes. Applying posts an 'applyPokes' message
 * to the worker, which writes the bytes into emulated memory (Multiface-style)
 * and returns the overwritten values so unchecking can restore them.
 *
 * Opens in the dialog window (dialog.js), which pauses the emulator while it
 * is open.
 */

import { PokesDatabase } from './pokes-db.js';
import { openDialog, h } from './dialog.js';

const SEARCH_DEBOUNCE_MS = 150;

// One catalog for the page lifetime — ~2 MB JSON, fetched on first open only.
const db = new PokesDatabase();

const trainerKey = (game, trainerIndex) => game.id + ':' + trainerIndex;

const trainerNeedsValue = (trainer) => trainer.pokes.some(p => p.value === 256);

const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

export function openPokesDialog(ui, emu) {
    const dialog = openDialog(ui, emu, {
        id: 'pokes', title: 'Pokes', subtitle: 'Game cheats: infinite lives, energy, time and more',
        width: 600, height: 640,
    });
    const setStatus = dialog.setStatus;

    /* ----- layout ----- */
    const bar = h('div', 'jsd-bar');
    const searchInput = h('input', 'jsd-input jsd-search jsd-grow', {
        type: 'search',
        placeholder: 'Type a game name…',
        autocomplete: 'off',
        spellcheck: false,
        value: emu.loadedGameName || '',
    });
    bar.appendChild(searchInput);
    bar.appendChild(h('div', 'jsd-note', {
        textContent: 'Tick a cheat to poke it into memory; untick it to put the original bytes back. '
            + 'Apply cheats once the game has finished loading, as loading would overwrite them.',
    }));

    const resultsBox = h('div', 'jsd-scroll');

    /* Detail line: the hovered/applied cheat's pokes, spelt out BASIC-style
     * ("POKE 35899,0"), so the user can see (or note down) the actual values. */
    const pokeDetailBar = h('div', 'jsd-detail jsd-mono');
    const detailHint = () => {
        pokeDetailBar.replaceChildren(h('span', 'jsd-faint', { textContent: 'Point at a cheat to see the pokes it makes.' }));
    };
    detailHint();

    /* Applied-cheats list: every trainer currently poked in, one per row with
     * its actual values, rebuilt from emu.activePokes after each change. */
    const appliedBox = h('div', 'jsd-applied');
    dialog.body.append(bar, resultsBox, pokeDetailBar, appliedBox);

    const credit = h('a', '', { href: 'https://www.the-tipshop.co.uk/', target: '_blank', rel: 'noopener', textContent: 'The Tipshop' });
    dialog.aside.append('Pokes courtesy of ', credit);

    function renderApplied() {
        appliedBox.replaceChildren();
        const show = db.games && (emu.activePokes.size > 0);
        appliedBox.style.display = show ? '' : 'none';
        if (!show) return;
        appliedBox.appendChild(h('div', 'jsd-row-title', { textContent: 'Applied cheats' }));
        for (const [key, active] of emu.activePokes) {
            const [gameId, trainerIndex] = key.split(':').map(Number);
            const game = db.games[gameId];
            const trainer = game && game.trainers[trainerIndex];
            if (!trainer) continue;
            const values = trainer.pokes.map((p, i) =>
                formatPoke(p, active.pokes[i].value, active.originals[i])).join('  •  ');
            appliedBox.appendChild(h('div', 'jsd-applied-item', { textContent: trainer.name + ': ' + values }));
        }
    }

    /* A byte read from memory is shown whatever it was, 0 included; the
     * catalog's original is shown only when not 0, which many .pok files
     * write for "not known". */
    function formatPoke(p, actualValue, actualOriginal) {
        const value = (actualValue !== undefined) ? actualValue : p.value;
        const original = (actualOriginal !== undefined) ? actualOriginal : (p.original || null);
        let s = 'POKE ' + p.address + ',' + (value === 256 ? '<value>' : value);
        if (!(p.bank & 0x08)) s = 'bank ' + (p.bank & 0x07) + ': ' + s;
        if (original !== null) s += ' (was ' + original + ')';
        return s;
    }

    function showPokeDetail(game, trainerIndex) {
        const trainer = game.trainers[trainerIndex];
        // For an applied cheat, show the values actually poked and the bytes
        // that were really there (more accurate than the catalog's data).
        const active = emu.activePokes.get(trainerKey(game, trainerIndex));
        const parts = trainer.pokes.map((p, i) => (active
            ? formatPoke(p, active.pokes[i].value, active.originals[i])
            : formatPoke(p)));
        pokeDetailBar.textContent = trainer.name + ': ' + parts.join('  •  ');
    }

    /* ----- apply / undo a trainer ----- */

    async function applyTrainer(game, trainerIndex, userValue) {
        const trainer = game.trainers[trainerIndex];
        const pokes = trainer.pokes.map(p => ({
            bank: p.bank,
            address: p.address,
            value: p.value === 256 ? userValue : p.value,
        }));
        const { originals, locations } = await emu.applyPokes(pokes);
        emu.activePokes.set(trainerKey(game, trainerIndex), { pokes, originals, locations });
        setStatus('Applied: ' + trainer.name, 'ok');
        renderApplied();
    }

    /* Unticking puts back, for each byte the trainer poked, what was there
     * before its first poke to it. Where a trainer ticked later poked the same
     * byte, that one keeps the byte, and takes over what to put back when it
     * is unticked in turn. emu.activePokes holds the trainers in the order
     * they were ticked. Bytes are told apart, and put back, by where in
     * memory each poke went, so a bank paged out since is still the one
     * restored. */
    async function undoTrainer(game, trainerIndex) {
        const key = trainerKey(game, trainerIndex);
        const active = emu.activePokes.get(key);
        if (!active) return;
        const entries = [...emu.activePokes.entries()];
        const later = entries.slice(entries.findIndex(([k]) => k === key) + 1).map(([, a]) => a);
        const restore = [];
        active.pokes.forEach((p, i) => {
            const location = active.locations[i];
            if (active.locations.indexOf(location) !== i) return;  // not its first poke to the byte
            const above = later.find(a => a.locations.includes(location));
            if (above) {
                above.originals[above.locations.indexOf(location)] = active.originals[i];
            } else {
                restore.push({ location, address: p.address, value: active.originals[i] });
            }
        });
        if (restore.length) await emu.applyPokes(restore);
        emu.activePokes.delete(key);
        setStatus('Restored: ' + game.trainers[trainerIndex].name
            + (restore.length ? ', ' + restore.map(p => 'POKE ' + p.address + ',' + p.value).join('  •  ') : ''));
        renderApplied();
    }

    /* ----- rendering ----- */

    // onToggled is called once a tick or untick has taken effect
    function makeTrainerRow(game, trainerIndex, onToggled) {
        const trainer = game.trainers[trainerIndex];
        const key = trainerKey(game, trainerIndex);
        const needsValue = trainerNeedsValue(trainer);

        const row = h('label', 'jsd-check');
        row.addEventListener('mouseenter', () => showPokeDetail(game, trainerIndex));

        const checkbox = h('input', '', { type: 'checkbox', checked: emu.activePokes.has(key) });
        const showTicked = () => row.classList.toggle('on', checkbox.checked);
        showTicked();
        row.appendChild(checkbox);

        row.appendChild(h('div', 'jsd-row-main', { textContent: trainer.name }));

        let valueInput = null;
        if (needsValue) {
            valueInput = h('input', 'jsd-input small', {
                type: 'number', min: '0', max: '255', placeholder: 'value', title: 'Value to poke (0-255)',
            });
            valueInput.style.width = '72px';
            const active = emu.activePokes.get(key);
            if (active) {
                const varPoke = trainer.pokes.findIndex(p => p.value === 256);
                if (varPoke !== -1) valueInput.value = active.pokes[varPoke].value;
            }
            // Clicking the input shouldn't toggle the surrounding label's checkbox.
            valueInput.addEventListener('click', (e) => e.preventDefault());
            row.appendChild(valueInput);
        }

        row.appendChild(h('span', 'jsd-badge', { textContent: plural(trainer.pokes.length, 'poke') }));

        checkbox.addEventListener('change', () => {
            checkbox.disabled = true;
            const done = () => {
                checkbox.disabled = false;
                showTicked();
                onToggled();
                showPokeDetail(game, trainerIndex);   // reflect actual poked/original values
            };
            if (checkbox.checked) {
                let userValue = 0;
                if (needsValue) {
                    userValue = parseInt(valueInput.value, 10);
                    if (isNaN(userValue) || userValue < 0 || userValue > 255) {
                        setStatus('Enter a value (0-255) for "' + trainer.name + '" first.', 'error');
                        checkbox.checked = false;
                        done();
                        valueInput.focus();
                        return;
                    }
                }
                applyTrainer(game, trainerIndex, userValue).then(done);
            } else {
                undoTrainer(game, trainerIndex).then(done);
            }
        });

        return row;
    }

    function makeGameSection(game, startExpanded) {
        const section = h('div', 'jsd-section');

        const header = h('div', 'jsd-section-head');
        header.appendChild(h('span', 'jsd-chevron', { textContent: '▸' }));
        const main = h('div', 'jsd-row-main');
        main.appendChild(h('div', 'jsd-row-title', { textContent: game.name }));
        const meta = [game.pub, game.year].filter(Boolean).join(', ');
        if (meta) main.appendChild(h('div', 'jsd-row-meta', { textContent: meta }));
        header.appendChild(main);
        // how many of its cheats are on, kept up to date as they are ticked
        const onBadge = h('span', 'jsd-badge accent');
        const countOn = () => {
            const on = game.trainers.filter((t, i) => emu.activePokes.has(trainerKey(game, i))).length;
            onBadge.textContent = on + ' on';
            onBadge.style.display = on ? '' : 'none';
        };
        countOn();
        header.appendChild(onBadge);
        header.appendChild(h('span', 'jsd-badge', { textContent: plural(game.trainers.length, 'cheat') }));
        section.appendChild(header);

        const list = h('div');
        section.appendChild(list);

        let expanded = false;
        function setExpanded(want) {
            expanded = want;
            section.classList.toggle('open', expanded);
            list.style.display = expanded ? 'block' : 'none';
            if (expanded && !list.childNodes.length) {
                game.trainers.forEach((t, i) => list.appendChild(makeTrainerRow(game, i, countOn)));
            }
        }
        header.addEventListener('click', () => setExpanded(!expanded));
        setExpanded(!!startExpanded);

        return section;
    }

    function empty(title, text) {
        const box = h('div', 'jsd-empty');
        box.appendChild(h('b', '', { textContent: title }));
        box.appendChild(document.createTextNode(text));
        return box;
    }

    function renderResults() {
        resultsBox.replaceChildren();
        if (!db.games) return;
        const query = searchInput.value;
        if (!query.trim()) {
            resultsBox.appendChild(empty('Find a game’s cheats', 'Load a game, or type its name above.'));
            return;
        }
        const matches = db.search(query);
        if (!matches.length) {
            resultsBox.appendChild(empty('No pokes found', 'Nothing in the catalog matches "' + query + '". Try fewer or different words.'));
            return;
        }
        // Expand the first match only when it's a clear winner shown on open.
        matches.forEach((game, i) => {
            resultsBox.appendChild(makeGameSection(game, i === 0 && matches.length <= 3));
        });
    }

    let debounceTimer = null;
    searchInput.addEventListener('input', () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(renderResults, SEARCH_DEBOUNCE_MS);
    });

    /* ----- boot ----- */
    renderApplied();
    setStatus('Loading the poke database…', 'busy');
    searchInput.focus();
    searchInput.select();
    db.load().then(() => {
        setStatus('');
        renderResults();
        renderApplied();   // cheats applied before the dialog was (re)opened
    }).catch((err) => {
        setStatus('Failed to load the poke database: ' + (err && err.message ? err.message : err), 'error');
    });
}

export default openPokesDialog;

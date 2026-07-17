/*
 * runtime/pokes.js — the "Pokes…" (game cheats) dialog.
 *
 * Exposes openPokesDialog(ui, emu): searches the Tipshop-derived pokes catalog
 * (pokes-db.js) for the currently loaded game, lists its trainers (cheats) and
 * applies/undoes them with checkboxes. Applying posts an 'applyPokes' message
 * to the worker, which writes the bytes into emulated memory (Multiface-style)
 * and returns the overwritten values so unchecking can restore them.
 *
 * Built with a plain-DOM + inline-style scaffold: pauses
 * the emulator while open, wraps ui.hideDialog so the X button and Esc both
 * restore the run state.
 */

import { PokesDatabase } from './pokes-db.js';

const SEARCH_DEBOUNCE_MS = 150;

// One catalog for the page lifetime — ~2 MB JSON, fetched on first open only.
const db = new PokesDatabase();

function el(tag, styles, props) {
    const e = document.createElement(tag);
    if (styles) Object.assign(e.style, styles);
    if (props) Object.assign(e, props);
    return e;
}

const trainerKey = (game, trainerIndex) => game.id + ':' + trainerIndex;

const trainerNeedsValue = (trainer) => trainer.pokes.some(p => p.value === 256);

export function openPokesDialog(ui, emu) {
    const wasRunning = emu.isRunning;
    emu.pause();

    const body = ui.showDialog();
    body.innerHTML = '';

    /* ----- close / restore plumbing ----- */
    const origHideDialog = ui.hideDialog;
    let isClosed = false;
    function close() {
        if (isClosed) return;
        isClosed = true;
        document.removeEventListener('keydown', onKeydown, true);
        delete ui.hideDialog;            // restore UIController.prototype.hideDialog
        origHideDialog.call(ui);
        if (wasRunning) emu.start();
        emu.focus();
    }
    ui.hideDialog = function () { close(); };

    function onKeydown(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    }
    document.addEventListener('keydown', onKeydown, true);

    /* ----- layout ----- */
    const root = el('div', { maxWidth: '100%', fontFamily: 'Arial, Helvetica, sans-serif', color: '#000' });
    body.appendChild(root);

    root.appendChild(el('h2', { margin: '4px 0 8px 0', fontSize: '18px' },
        { textContent: 'Pokes — game cheats' }));

    const searchInput = el('input', {
        width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '16px',
        border: '2px solid #888', borderRadius: '4px',
    }, {
        type: 'search',
        placeholder: 'Type a game name…',
        autocomplete: 'off',
        value: emu.loadedGameName || '',
    });
    root.appendChild(searchInput);

    const hint = el('div', { margin: '6px 0', color: '#666', fontSize: '90%' }, {
        textContent: 'Tick a cheat to poke it into memory; untick to restore the original bytes. '
            + 'Apply pokes after the game has finished loading (a tape load would overwrite them).',
    });
    root.appendChild(hint);

    const resultsBox = el('div', { marginTop: '8px' });
    root.appendChild(resultsBox);

    const statusBar = el('div', {
        marginTop: '10px', paddingTop: '6px', borderTop: '1px solid #ccc',
        minHeight: '1.2em', fontSize: '90%', color: '#333',
    });
    root.appendChild(statusBar);
    function setStatus(text) { statusBar.textContent = text || ''; }

    /* Applied-cheats list: every trainer currently poked in, one per row with
     * its actual values, rebuilt from emu.activePokes after each change. */
    const appliedBox = el('div', { marginTop: '4px', fontSize: '90%', color: '#333' });
    root.appendChild(appliedBox);

    function renderApplied() {
        appliedBox.innerHTML = '';
        if (!db.games || emu.activePokes.size === 0) return;
        appliedBox.appendChild(el('div', { fontWeight: 'bold', margin: '2px 0' },
            { textContent: 'Applied cheats:' }));
        for (const [key, active] of emu.activePokes) {
            const [gameId, trainerIndex] = key.split(':').map(Number);
            const game = db.games[gameId];
            const trainer = game && game.trainers[trainerIndex];
            if (!trainer) continue;
            const values = trainer.pokes.map((p, i) =>
                formatPoke(p, active.pokes[i].value, active.originals[i])).join('  •  ');
            appliedBox.appendChild(el('div', {
                padding: '1px 0 1px 12px', fontFamily: 'Consolas, Monaco, monospace',
                fontSize: '95%', overflowWrap: 'anywhere',
            }, { textContent: trainer.name + ': ' + values }));
        }
    }

    /* Detail line: the hovered/applied cheat's pokes, spelt out BASIC-style
     * ("POKE 35899,0"), so the user can see (or note down) the actual values. */
    const pokeDetailBar = el('div', {
        marginTop: '4px', minHeight: '1.2em', fontSize: '90%', color: '#555',
        fontFamily: 'Consolas, Monaco, monospace', overflowWrap: 'anywhere',
    });
    root.appendChild(pokeDetailBar);

    function formatPoke(p, actualValue, actualOriginal) {
        const value = (actualValue !== undefined) ? actualValue : p.value;
        const original = (actualOriginal !== undefined) ? actualOriginal : p.original;
        let s = 'POKE ' + p.address + ',' + (value === 256 ? '<value>' : value);
        if (!(p.bank & 0x08)) s = 'bank ' + (p.bank & 0x07) + ': ' + s;
        if (original) s += ' (was ' + original + ')';
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

    root.appendChild(el('div', { marginTop: '4px', color: '#888', fontSize: '80%' }, {
        textContent: 'Poke database courtesy of The Tipshop (www.the-tipshop.co.uk).',
    }));

    /* ----- apply / undo a trainer ----- */

    async function applyTrainer(game, trainerIndex, userValue) {
        const trainer = game.trainers[trainerIndex];
        const pokes = trainer.pokes.map(p => ({
            bank: p.bank,
            address: p.address,
            value: p.value === 256 ? userValue : p.value,
        }));
        const originals = await emu.applyPokes(pokes);
        emu.activePokes.set(trainerKey(game, trainerIndex), { pokes, originals });
        setStatus('');
        renderApplied();
    }

    async function undoTrainer(game, trainerIndex) {
        const key = trainerKey(game, trainerIndex);
        const active = emu.activePokes.get(key);
        if (!active) return;
        const restore = active.pokes.map((p, i) => ({
            bank: p.bank,
            address: p.address,
            value: active.originals[i],
        }));
        await emu.applyPokes(restore);
        emu.activePokes.delete(key);
        setStatus('Restored: ' + game.trainers[trainerIndex].name + ' — '
            + restore.map(p => 'POKE ' + p.address + ',' + p.value).join('  •  '));
        renderApplied();
    }

    /* ----- rendering ----- */

    function makeTrainerRow(game, trainerIndex) {
        const trainer = game.trainers[trainerIndex];
        const key = trainerKey(game, trainerIndex);
        const needsValue = trainerNeedsValue(trainer);

        const row = el('label', {
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '4px 4px 4px 24px', borderBottom: '1px solid #eee', cursor: 'pointer',
        });
        row.addEventListener('mouseenter', () => showPokeDetail(game, trainerIndex));

        const checkbox = el('input', { flex: '0 0 auto' },
            { type: 'checkbox', checked: emu.activePokes.has(key) });
        row.appendChild(checkbox);

        row.appendChild(el('div', { flex: '1 1 auto', overflowWrap: 'anywhere' },
            { textContent: trainer.name }));

        let valueInput = null;
        if (needsValue) {
            valueInput = el('input', {
                flex: '0 0 auto', width: '60px', padding: '2px 4px',
            }, { type: 'number', min: '0', max: '255', placeholder: 'value', title: 'Value to poke (0-255)' });
            const active = emu.activePokes.get(key);
            if (active) {
                const varPoke = trainer.pokes.findIndex(p => p.value === 256);
                if (varPoke !== -1) valueInput.value = active.pokes[varPoke].value;
            }
            // Clicking the input shouldn't toggle the surrounding label's checkbox.
            valueInput.addEventListener('click', (e) => e.preventDefault());
            row.appendChild(valueInput);
        }

        row.appendChild(el('div', { flex: '0 0 auto', color: '#888', fontSize: '80%' }, {
            textContent: trainer.pokes.length + (trainer.pokes.length === 1 ? ' poke' : ' pokes'),
        }));

        checkbox.addEventListener('change', () => {
            checkbox.disabled = true;
            const done = () => {
                checkbox.disabled = false;
                showPokeDetail(game, trainerIndex);   // reflect actual poked/original values
            };
            if (checkbox.checked) {
                let userValue = 0;
                if (needsValue) {
                    userValue = parseInt(valueInput.value, 10);
                    if (isNaN(userValue) || userValue < 0 || userValue > 255) {
                        setStatus('Enter a value (0-255) for "' + trainer.name + '" first.');
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
        const section = el('div', { borderBottom: '1px solid #ccc' });

        const header = el('div', {
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '6px 4px', cursor: 'pointer', fontWeight: 'bold',
        });
        const arrow = el('span', { flex: '0 0 auto', width: '1em', color: '#666' });
        header.appendChild(arrow);
        const title = game.name + (game.year ? ' (' + game.year + (game.pub ? ', ' + game.pub : '') + ')'
            : (game.pub ? ' (' + game.pub + ')' : ''));
        header.appendChild(el('div', { flex: '1 1 auto', overflowWrap: 'anywhere' }, { textContent: title }));
        header.appendChild(el('div', { flex: '0 0 auto', color: '#666', fontSize: '90%', fontWeight: 'normal' }, {
            textContent: game.trainers.length + (game.trainers.length === 1 ? ' cheat' : ' cheats'),
        }));
        section.appendChild(header);

        const list = el('div', {});
        section.appendChild(list);

        let expanded = false;
        function setExpanded(want) {
            expanded = want;
            arrow.textContent = expanded ? '▾' : '▸';
            list.style.display = expanded ? 'block' : 'none';
            if (expanded && !list.childNodes.length) {
                game.trainers.forEach((t, i) => list.appendChild(makeTrainerRow(game, i)));
            }
        }
        header.addEventListener('click', () => setExpanded(!expanded));
        header.addEventListener('mouseenter', () => { header.style.backgroundColor = '#e6e6e6'; });
        header.addEventListener('mouseleave', () => { header.style.backgroundColor = 'transparent'; });
        setExpanded(!!startExpanded);

        return section;
    }

    function renderResults() {
        resultsBox.innerHTML = '';
        if (!db.games) return;
        const query = searchInput.value;
        if (!query.trim()) {
            resultsBox.appendChild(el('p', { color: '#666', fontStyle: 'italic' },
                { textContent: 'Load a game, or type a game name to find its pokes.' }));
            return;
        }
        const matches = db.search(query);
        if (!matches.length) {
            resultsBox.appendChild(el('p', { color: '#666', fontStyle: 'italic' },
                { textContent: 'No pokes found for "' + query + '".' }));
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
    setStatus('Loading poke database…');
    db.load().then(() => {
        setStatus('');
        renderResults();
        renderApplied();   // cheats applied before the dialog was (re)opened
        searchInput.focus();
    }).catch((err) => {
        setStatus('Failed to load poke database: ' + (err && err.message ? err.message : err));
    });
}

export default openPokesDialog;

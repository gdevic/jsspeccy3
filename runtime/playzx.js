/*
 * runtime/playzx.js: the "PlayZX open…" dialog.
 *
 * Exposes openPlayZXDialog(ui, emu): browses the PlayZX game catalog (an SQLite
 * index shipped as jsspeccy/playzx/index_v3.db and queried in the browser via
 * sql.js), then fetches the chosen tape image from the PlayZX protocol and hands
 * it straight to the emulator as a TAP or TZX.
 */

import initSqlJs from 'sql.js';
import pako from 'pako';

import { TAPFile, TZXFile } from './tape.js';
import { playzxDecrypt, playzxSignRequest, makeNonce } from './playzx-crypto.js';
import { getSession, invalidateSession } from './playzx-session.js';
import { openDialog, h, button } from './dialog.js';

// Resolved against the jsspeccy script URL, like pokes-db.js.
const scriptUrl =
    (typeof document !== 'undefined' && document.currentScript)
        ? document.currentScript.src
        : (typeof import.meta !== 'undefined' ? import.meta.url : '');

const SQL_WASM_URL = 'sql-wasm.wasm';
const DB_URL = 'playzx/index_v3.db';

const SEARCH_DEBOUNCE_MS = 150;
const MAX_RESULTS = 100;
const DATA_URL = 'https://baltazarstudios.com/PlayZX/v2/data.php';

const NETWORK_ERROR = 'Network error , please try again.';
const UNSUPPORTED_ERROR = "This image format isn't supported by the emulator.";

const HELP_HTML =
    '<b>Type the start of a title</b> to find a game, then press <span class="jsd-kbd">Enter</span> '
    + 'or double-click it to load it; <span class="jsd-kbd">↑</span> <span class="jsd-kbd">↓</span> pick another.<br>'
    + 'Start with a <span class="jsd-kbd">space</span> to search by <b>publisher</b>.<br>'
    + 'End with <span class="jsd-kbd">?</span> for a <b>random pick</b>.<br>'
    + 'Start with <span class="jsd-kbd">=</span> for an SQL condition on <i>Name, Pub, Year, Duration, '
    + "Variation, Rating</i>, e.g. <code>=Year&lt;1985 AND Pub LIKE 'Domark%'</code>.<br>"
    + 'Shows up to ' + MAX_RESULTS + ' results.';

/* Single-quote escaping for the string literals we interpolate into LIKE
 * clauses (sql.js has no server to protect, but a quote in a title would
 * otherwise be a syntax error). */
function escapeSql(s) {
    return String(s).replace(/'/g, "''");
}

function rowToImage(row) {
    return {
        gid: row.Gid,
        name: row.Name,
        pub: row.Pub,
        year: row.Year,
        variation: row.Variation,
        duration: row.Duration,
        rating: row.Rating,
    };
}

/* Seconds → m:ss, blank for a missing or zero duration. */
function formatDuration(secs) {
    const t = Math.round(Number(secs) || 0);
    if (t <= 0) return '';
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}

/* 0 → "0-9", 1..26 → "A".."Z" */
function alphaLabel(index) {
    return (index === 0) ? '0-9' : String.fromCharCode(64 + index);
}

export class PlayZXDatabase {
    constructor() {
        this.db = null;
        this._loaded = false;
        this._loadingPromise = null;
    }

    async load() {
        if (this._loaded) return;
        if (this._loadingPromise) return this._loadingPromise;
        this._loadingPromise = this._doLoad();
        try {
            await this._loadingPromise;
        } finally {
            this._loadingPromise = null;
        }
    }

    async _doLoad() {
        const wasmUrl = new URL(SQL_WASM_URL, scriptUrl).href;
        const dbUrl = new URL(DB_URL, scriptUrl).href;
        const SQL = await initSqlJs({locateFile: () => wasmUrl});
        const response = await fetch(dbUrl);
        if (!response.ok) {
            throw new Error(
                `PlayZX: failed to fetch database (${response.status} ${response.statusText})`);
        }
        const data = await response.arrayBuffer();
        this.db = new SQL.Database(new Uint8Array(data));
        this._loaded = true;
    }

    // Whether the catalog is in, which every query below needs.
    get loaded() {
        return this._loaded;
    }

    count() {
        const stmt = this.db.prepare('SELECT COUNT(*) AS n FROM Images');
        try {
            stmt.step();
            return stmt.getAsObject().n;
        } finally {
            stmt.free();
        }
    }

    /* Distinct titles whose initial character falls in bucket `index`
     * (0 = digits, 1..26 = A..Z). */
    alphaNames(index) {
        let stmt;
        if (index === 0) {
            stmt = this.db.prepare(
                "SELECT DISTINCT Name FROM Images WHERE Name LIKE '0%' OR Name LIKE '1%'"
                + " OR Name LIKE '2%' OR Name LIKE '3%' OR Name LIKE '4%' OR Name LIKE '5%'"
                + " OR Name LIKE '6%' OR Name LIKE '7%' OR Name LIKE '8%' OR Name LIKE '9%'"
                + ' ORDER BY Name ASC');
        } else {
            const prefix = String.fromCharCode('a'.charCodeAt(0) + index - 1) + '%';
            stmt = this.db.prepare(
                'SELECT DISTINCT Name FROM Images WHERE Name LIKE ? ORDER BY Name ASC');
            stmt.bind([prefix]);
        }
        const names = [];
        try {
            while (stmt.step()) names.push(stmt.getAsObject().Name);
        } finally {
            stmt.free();
        }
        return names;
    }

    /* Every release carrying this exact title (re-releases, budget labels,
     * alternate loaders...), oldest first. */
    variations(name) {
        const stmt = this.db.prepare(
            'SELECT Gid,Name,Pub,Year,Variation,Duration,Rating FROM Images' + ' WHERE Name = ? ORDER BY Year');
        stmt.bind([name]);
        const rows = [];
        try {
            while (stmt.step()) rows.push(rowToImage(stmt.getAsObject()));
        } finally {
            stmt.free();
        }
        return rows;
    }

    /* Query box. Plain text matches a title prefix; a leading space matches a
     * publisher prefix; a leading '=' is spliced in as a raw WHERE condition; a
     * trailing '?' picks one row at random. Needs two characters to fire.
     * Returns [] for too-short input, or {error, detail} for bad SQL. */
    search(query, limit) {
        let max = Number.isFinite(limit) ? limit : MAX_RESULTS;
        if (max > MAX_RESULTS) max = MAX_RESULTS;
        if (max < 0) max = 0;

        let text = String(query == null ? '' : query);
        const trimmed = text.trim();
        let order = 'Name';
        let count = (trimmed.length > 1) ? max : 0;
        if (trimmed.endsWith('?')) {
            text = text.replace(/\?/g, '');
            count = 1;
            order = 'RANDOM()';
        }
        count = Math.max(0, Math.floor(count));
        if (count === 0) return [];

        const first = text.charAt(0);
        let sql;
        if (text.length > 1 && first === '=') {
            sql = `SELECT * FROM Images WHERE ${text.slice(1).trim()}`
                + ` ORDER BY ${order} LIMIT ${count}`;
        } else if (text.length > 1 && first === ' ') {
            sql = `SELECT * FROM Images WHERE Pub LIKE '${escapeSql(text.slice(1).trim())}%'`
                + ` ORDER BY ${order} LIMIT ${count}`;
        } else {
            sql = `SELECT * FROM Images WHERE Name LIKE '${escapeSql(text.trim())}%'`
                + ` ORDER BY ${order} LIMIT ${count}`;
        }

        try {
            return this._runSql(sql);
        } catch (e) {
            return {error: 'Invalid query', detail: (e && e.message) ? e.message : String(e)};
        }
    }

    _runSql(sql) {
        const stmt = this.db.prepare(sql);
        const rows = [];
        try {
            while (stmt.step()) rows.push(rowToImage(stmt.getAsObject()));
        } finally {
            stmt.free();
        }
        return rows;
    }
}

PlayZXDatabase.escape = escapeSql;

// One catalog for the page lifetime: 640 KB, fetched on first open only.
const db = new PlayZXDatabase();

/* Errors we raise ourselves carry a message meant for the status line; anything
 * else is reported as a generic network failure. */
class PlayZXError extends Error {}

/* Guards against a second Load click while one is in flight: the load in
 * flight, or null. Closing the dialog lets it go, and a load that finishes
 * after that leaves alone the guard of one started since. */
let loadInProgress = null;

async function decodeStoredImage(plaintext) {
    if (plaintext.length < 37) throw new PlayZXError('Invalid data.');
    const flags = plaintext[0];
    const rawLen = new DataView(plaintext.buffer, plaintext.byteOffset + 1, 4).getUint32(0, false);
    const sha256 = plaintext.subarray(5, 37);
    const zlibStream = plaintext.subarray(37);

    let inflated;
    try {
        inflated = pako.inflate(zlibStream);
    } catch (e) {
        throw new PlayZXError('Invalid data.');
    }
    if (inflated.length !== rawLen) throw new PlayZXError('Invalid data.');

    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', inflated));
    for (let i = 0; i < 32; i++) {
        if (digest[i] !== sha256[i]) throw new PlayZXError('Invalid data.');
    }

    const buffer = inflated.buffer.slice(inflated.byteOffset, inflated.byteOffset + inflated.byteLength);
    return {buffer, format: (flags & 2) ? 'tzx' : 'tap'};
}

async function fetchImage(gid) {
    for (let attempt = 1; ; attempt++) {
        const session = await getSession();
        const nonce = makeNonce();
        const mac = await playzxSignRequest(session.keyBytes, gid, nonce.hex);
        const url = DATA_URL + '?' + new URLSearchParams({g: gid, s: session.sid, n: nonce.hex, m: mac});

        let response;
        try {
            response = await fetch(url);
        } catch (e) {
            throw new PlayZXError(NETWORK_ERROR);
        }

        if (response.status === 401 && attempt === 1) {
            invalidateSession();
            continue;
        }
        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('Retry-After'), 10);
            throw new PlayZXError(
                (Number.isFinite(retryAfter) && retryAfter > 0)
                    ? 'Too many requests , please wait ' + retryAfter + ' seconds and try again.'
                    : 'Too many requests , please wait a moment and try again.');
        }
        if (response.status === 403) throw new PlayZXError('Access temporarily blocked.');
        if (response.status === 401) throw new PlayZXError('Could not verify this session , please retry.');
        if (!response.ok) throw new PlayZXError(NETWORK_ERROR);

        let responseBytes;
        try {
            responseBytes = new Uint8Array(await response.arrayBuffer());
        } catch (e) {
            throw new PlayZXError(NETWORK_ERROR);
        }
        let plaintext;
        try {
            plaintext = await playzxDecrypt(session.keyBytes, nonce.bytes, gid, responseBytes);
        } catch (e) {
            throw new PlayZXError('Invalid data.');
        }
        return decodeStoredImage(plaintext);
    }
}

/* Hand the tape to the emulator the same way a local file open would, then get
 * out of the way: the 'fileOpened' handler does the tape-loader autostart. */
async function insertTape(buffer, format, ui, emu, name) {
    // Named after the game, so a saved session keeps this tape.
    const fileName = (name || 'PlayZX game') + (format === 'tzx' ? '.tzx' : '.tap');
    let result;
    if (format === 'tzx') {
        if (!TZXFile.isValid(buffer)) throw new PlayZXError(UNSUPPORTED_ERROR);
        result = await emu.openTZXFile(buffer, { name: fileName });
    } else {
        if (!TAPFile.isValid(buffer)) throw new PlayZXError(UNSUPPORTED_ERROR);
        result = await emu.openTAPFile(buffer, { name: fileName });
    }
    // The emulator turned the tape away, and kept the one it had.
    if (result.error) throw new PlayZXError('The emulator could not read this tape: ' + result.error);
    // Let the Pokes dialog match trainers against the catalog title.
    if (name) emu.setLoadedGame(name);
    ui.hideDialog();
    emu.focus();
    if (emu.isInitiallyPaused) emu.start();
}

async function loadGame(gid, name, ui, emu, setStatus, isClosed) {
    const status = (typeof setStatus === 'function') ? setStatus : () => {};
    const closed = (typeof isClosed === 'function') ? isClosed : () => false;
    if (loadInProgress) return;
    const thisLoad = {};
    loadInProgress = thisLoad;
    status('Loading ' + (name || 'the game') + '…', 'busy');
    try {
        const {buffer, format} = await fetchImage(gid);
        if (closed()) return;
        await insertTape(buffer, format, ui, emu, name);
    } catch (e) {
        if (closed()) return;
        if (e instanceof PlayZXError) {
            status(e.message, 'error');
        } else if (e && e.code === 'origin_denied') {
            status('PlayZX is not available on this site.', 'error');
        } else if (e && e.code === 'unsupported_version') {
            status('Please update to continue using PlayZX.', 'error');
        } else if (e && e.message) {
            status(e.message, 'error');
        } else {
            status(NETWORK_ERROR, 'error');
        }
    } finally {
        if (loadInProgress === thisLoad) loadInProgress = null;
    }
}

/* What the search box is searching by, from how its text starts and ends:
 * [label, input class], or null for a plain title search. */
function searchMode(value) {
    if (value.trim().endsWith('?')) return ['Random pick', 'random'];
    if (value[0] === ' ') return ['By publisher', 'publisher'];
    if (value[0] === '=') return ['SQL condition', 'sql'];
    return null;
}

export function openPlayZXDialog(ui, emu) {
    const dialog = openDialog(ui, emu, {
        id: 'playzx', title: 'PlayZX', subtitle: 'Open a game from the PlayZX online catalog',
        width: 640, height: 680,
        onClose: () => { loadInProgress = null; },
    });
    const setStatus = dialog.setStatus;
    const load = (gid, name) => loadGame(gid, name, ui, emu, setStatus, () => dialog.closed);

    /* Tab strip, with the search box or the letters beside it */
    const bar = h('div', 'jsd-bar');
    const tabs = h('div', 'jsd-tabs');
    const searchTab = h('button', 'jsd-tab', {type: 'button', textContent: 'Search'});
    const allTab = h('button', 'jsd-tab', {type: 'button', textContent: 'Browse A-Z'});
    tabs.append(searchTab, allTab);
    bar.appendChild(tabs);

    const searchInput = h('input', 'jsd-input jsd-search jsd-grow', {
        type: 'search', placeholder: 'Type a game name…', autocomplete: 'off', spellcheck: false,
    });
    const modeBadge = h('span', 'jsd-badge warn');
    const alphaBar = h('div', 'jsd-letters');
    alphaBar.style.flexBasis = '100%';
    bar.append(searchInput, modeBadge, alphaBar);

    const searchPane = h('div', 'jsd-scroll');
    const allPane = h('div', 'jsd-scroll');
    dialog.body.append(bar, searchPane, allPane);

    function showTab(which) {
        const searching = (which === 'search');
        searchPane.style.display = searching ? '' : 'none';
        allPane.style.display = searching ? 'none' : '';
        searchInput.style.display = searching ? '' : 'none';
        alphaBar.style.display = searching ? 'none' : '';
        showMode();
        searchTab.classList.toggle('active', searching);
        allTab.classList.toggle('active', !searching);
        if (searching) {
            searchInput.focus();
            showCount(results.length, searchInput.value.trim() !== '');
        } else {
            dialog.aside.textContent = '';
        }
    }

    function showCount(n, searched) {
        dialog.aside.textContent = searched
            ? ((n >= MAX_RESULTS) ? `First ${MAX_RESULTS} results` : (n + (n === 1 ? ' result' : ' results')))
            : '';
    }

    /* One catalog row: title (optional), publisher/year, duration/variation,
     * and the Load button. A click selects the row, a double-click or its
     * Load button loads it. */
    function imageRow(image, opts) {
        const showName = (opts || {}).showName !== false;
        const row = h('div', 'jsd-row');
        const text = h('div', 'jsd-row-main');
        if (showName) text.appendChild(h('div', 'jsd-row-title', {textContent: image.name}));

        const publisher = (image.pub || 'Unknown publisher') + (image.year ? ', ' + image.year : '');
        text.appendChild(h('div', showName ? 'jsd-row-meta' : 'jsd-row-title', {textContent: publisher}));
        if (image.variation) text.appendChild(h('div', 'jsd-row-extra', {textContent: image.variation}));
        row.appendChild(text);

        const duration = formatDuration(image.duration);
        if (duration) row.appendChild(h('span', 'jsd-badge', {textContent: duration, title: 'Loading time'}));

        const loadButton = button('Load', {small: true, title: 'Load this tape into the emulator'});
        loadButton.addEventListener('click', (e) => {
            e.stopPropagation();
            load(image.gid, image.name);
        });
        row.appendChild(loadButton);
        row.addEventListener('dblclick', () => load(image.gid, image.name));
        return row;
    }

    /* A list of rows of which one at a time is selected, its Load button
     * then the primary one. Returns select(index). */
    function renderList(target, images, opts) {
        target.replaceChildren();
        if (!images.length) {
            const none = h('div', 'jsd-empty');
            none.appendChild(h('b', '', {textContent: 'No games found'}));
            none.appendChild(document.createTextNode('Check the spelling, or search by the start of the title.'));
            target.appendChild(none);
            return () => {};
        }
        const rows = images.map((image) => imageRow(image, opts));
        let selected = -1;
        const select = (index) => {
            if (selected >= 0) {
                rows[selected].classList.remove('selected');
                rows[selected].querySelector('.jsd-btn').classList.remove('primary');
            }
            selected = index;
            if (index < 0) return;
            rows[index].classList.add('selected');
            rows[index].querySelector('.jsd-btn').classList.add('primary');
            rows[index].scrollIntoView({block: 'nearest'});
        };
        rows.forEach((row, i) => {
            row.addEventListener('click', () => select(i));
            target.appendChild(row);
        });
        return select;
    }

    /* ---- Search tab ---- */
    const help = h('div', 'jsd-help');
    help.innerHTML = HELP_HTML;
    const searchResults = h('div');
    searchPane.append(help, searchResults);

    let results = [];
    let selectedResult = 0;
    let selectResult = () => {};
    let searchTimer = null;

    function runSearch() {
        const query = searchInput.value;
        results = [];
        selectedResult = 0;
        selectResult = () => {};
        searchResults.replaceChildren();
        // Blank box: show the help instead of every title in the catalog.
        if (query.trim() === '' && query[0] !== ' ' && query[0] !== '=') {
            help.style.display = '';
            showCount(0, false);
            return;
        }
        help.style.display = 'none';
        // until the catalog is in, the status says it is loading, and the search runs once it is
        if (!db.loaded) return;

        const found = db.search(query, MAX_RESULTS);
        if (found && !Array.isArray(found) && found.error) {
            const bad = h('div', 'jsd-empty');
            bad.appendChild(h('b', 'jsd-error-text', {textContent: found.error}));
            bad.appendChild(document.createTextNode('Check the condition after "=". ' + (found.detail || '')));
            searchResults.appendChild(bad);
            showCount(0, false);
            return;
        }
        results = Array.isArray(found) ? found : [];
        selectResult = renderList(searchResults, results, {showName: true});
        if (results.length) selectResult(0);
        showCount(results.length, true);
    }

    function showMode() {
        const mode = (searchInput.style.display === 'none') ? null : searchMode(searchInput.value);
        modeBadge.style.display = mode ? '' : 'none';
        if (mode) modeBadge.textContent = mode[0];
    }

    searchInput.addEventListener('input', () => {
        showMode();
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { searchTimer = null; runSearch(); }, SEARCH_DEBOUNCE_MS);
    });
    searchInput.addEventListener('keydown', (e) => {
        if ((e.key === 'ArrowDown') || (e.key === 'ArrowUp')) {
            e.preventDefault();
            if (!results.length) return;
            selectedResult = Math.min(results.length - 1, Math.max(0, selectedResult + ((e.key === 'ArrowDown') ? 1 : -1)));
            selectResult(selectedResult);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            // the results must be for what the box says now, not for a search still waiting to run
            if (searchTimer) {
                clearTimeout(searchTimer);
                searchTimer = null;
                runSearch();
            }
            const image = results[selectedResult];
            if (image) load(image.gid, image.name);
        }
    });
    // Picking a row with the mouse is what Enter then loads.
    searchResults.addEventListener('click', (e) => {
        const row = e.target.closest('.jsd-row');
        if (row) selectedResult = [...searchResults.children].indexOf(row);
    });

    /* ---- All tab: initial letter → title → variations ---- */
    const alphaList = h('div');
    allPane.appendChild(alphaList);

    let currentAlpha = null;

    function showVariations(name) {
        alphaList.replaceChildren();
        const heading = h('div', 'jsd-heading');
        const back = button('‹ ' + alphaLabel(currentAlpha), {small: true, title: 'Back to the titles'});
        back.addEventListener('click', () => showNames(currentAlpha));
        heading.append(back, h('h3', '', {textContent: name}));
        alphaList.appendChild(heading);

        const images = db.variations(name) || [];
        alphaList.appendChild(h('div', 'jsd-note', {
            textContent: (images.length === 1) ? 'One release:' : images.length + ' releases, oldest first:',
        }));
        const list = h('div');
        list.style.marginTop = '6px';
        alphaList.appendChild(list);
        const select = renderList(list, images, {showName: false});
        if (images.length) select(0);
        allPane.scrollTop = 0;
    }

    function showNames(index) {
        alphaList.replaceChildren();
        if (index === null) {
            const start = h('div', 'jsd-empty');
            start.appendChild(h('b', '', {textContent: 'Browse the catalog'}));
            start.appendChild(document.createTextNode('Pick a letter above to see every title that starts with it.'));
            alphaList.appendChild(start);
            return;
        }
        // the letter's titles come once the catalog is in
        if (!db.loaded) {
            alphaList.appendChild(h('div', 'jsd-empty', {textContent: 'The game database is still loading.'}));
            return;
        }
        const names = db.alphaNames(index) || [];
        alphaList.appendChild(h('div', 'jsd-note', {
            textContent: names.length
                ? names.length + ' titles starting with "' + alphaLabel(index) + '":'
                : 'No titles start with "' + alphaLabel(index) + '".',
        }));
        const list = h('div');
        list.style.marginTop = '6px';
        names.forEach((name) => {
            const row = h('div', 'jsd-row');
            row.append(h('div', 'jsd-row-main jsd-row-title', {textContent: name}), h('span', 'jsd-faint', {textContent: '›'}));
            row.addEventListener('click', () => showVariations(name));
            list.appendChild(row);
        });
        alphaList.appendChild(list);
        allPane.scrollTop = 0;
    }

    function selectAlpha(index, letter) {
        currentAlpha = index;
        for (const b of alphaBar.children) b.classList.toggle('active', b === letter);
        showNames(index);
    }

    for (let i = 0; i <= 26; i++) {
        const letter = h('button', 'jsd-letter', {type: 'button', textContent: alphaLabel(i)});
        letter.addEventListener('click', () => selectAlpha(i, letter));
        alphaBar.appendChild(letter);
    }

    searchTab.addEventListener('click', () => showTab('search'));
    allTab.addEventListener('click', () => showTab('all'));
    showTab('search');
    showNames(null);
    setStatus('Loading the game database…', 'busy');
    db.load().then(() => {
        setStatus('');
        dialog.setTitle('PlayZX', db.count().toLocaleString('en') + ' ZX Spectrum tapes, ready to load');
        runSearch();
        if (currentAlpha !== null) showNames(currentAlpha);
    }).catch((e) => {
        setStatus('Failed to load the game database: ' + ((e && e.message) ? e.message : e), 'error');
    });
}

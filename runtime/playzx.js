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

const INPUT_BG = '#ffffff';
const INPUT_BG_PUB = '#ffffcc';     // leading space: searching by publisher
const INPUT_BG_SQL = '#ccffff';     // leading '=': raw SQL condition

const NETWORK_ERROR = 'Network error , please try again.';
const UNSUPPORTED_ERROR = "This image format isn't supported by the emulator.";

const HELP_HTML =
    'Search by <b>name</b>, or start with a <b>space</b> to search by <b>publisher</b>.<br>'
    + 'Start with <b>=</b> for a raw SQL condition (fields: <i>Name, Pub, Year, Duration, '
    + "Variation, Rating</i>), e.g. <code>=Year&lt;1985 AND Pub LIKE 'Domark%'</code>.<br>"
    + 'End with <b>?</b> for a random pick. Max ' + MAX_RESULTS + ' results.';

function el(tag, styles, props) {
    const e = document.createElement(tag);
    if (styles) Object.assign(e.style, styles);
    if (props) Object.assign(e, props);
    return e;
}

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

/* Guards against a second Load click while one is in flight. */
let loadInProgress = false;

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
    if (format === 'tzx') {
        if (!TZXFile.isValid(buffer)) throw new PlayZXError(UNSUPPORTED_ERROR);
        await emu.openTZXFile(buffer);
    } else {
        if (!TAPFile.isValid(buffer)) throw new PlayZXError(UNSUPPORTED_ERROR);
        await emu.openTAPFile(buffer);
    }
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
    loadInProgress = true;
    status('Loading…');
    try {
        const {buffer, format} = await fetchImage(gid);
        if (closed()) return;
        await insertTape(buffer, format, ui, emu, name);
    } catch (e) {
        if (closed()) return;
        if (e instanceof PlayZXError) {
            status(e.message);
        } else if (e && e.code === 'origin_denied') {
            status('PlayZX is not available on this site.');
        } else if (e && e.code === 'unsupported_version') {
            status('Please update to continue using PlayZX.');
        } else if (e && e.message) {
            status(e.message);
        } else {
            status(NETWORK_ERROR);
        }
    } finally {
        loadInProgress = false;
    }
}

export function openPlayZXDialog(ui, emu) {
    const wasRunning = emu.isRunning;
    emu.pause();

    const dialogBody = ui.showDialog();
    dialogBody.innerHTML = '';
    const originalHideDialog = ui.hideDialog;
    let closed = false;

    const close = () => {
        if (closed) return;
        closed = true;
        loadInProgress = false;
        document.removeEventListener('keydown', onKeyDown, true);
        delete ui.hideDialog;
        originalHideDialog.call(ui);
        if (wasRunning) emu.start();
        emu.focus();
    };
    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    };
    const load = (gid, name) => loadGame(gid, name, ui, emu, setStatus, () => closed);

    ui.hideDialog = function () { close(); };
    document.addEventListener('keydown', onKeyDown, true);

    const container = el('div', {
        maxWidth: '100%', fontFamily: 'Arial, Helvetica, sans-serif', color: '#000',
    });
    dialogBody.appendChild(container);
    container.appendChild(el('h2',
        {margin: '4px 0 8px 0', fontSize: '18px'},
        {textContent: 'PlayZX: open a game'}));

    /* Tab strip */
    const tabs = el('div', {
        display: 'flex', gap: '4px', borderBottom: '2px solid #888', marginBottom: '8px',
    });
    container.appendChild(tabs);
    const allTab = el('button', {}, {type: 'button', textContent: 'All'});
    const searchTab = el('button', {}, {type: 'button', textContent: 'Search'});
    [allTab, searchTab].forEach((tab) => {
        Object.assign(tab.style, {
            padding: '6px 14px', border: '1px solid #888', borderBottom: 'none',
            borderTopLeftRadius: '4px', borderTopRightRadius: '4px', cursor: 'pointer',
        });
    });
    tabs.appendChild(allTab);
    tabs.appendChild(searchTab);

    const searchPane = el('div', {});
    const allPane = el('div', {display: 'none'});
    container.appendChild(searchPane);
    container.appendChild(allPane);

    /* Status line, shared by the catalog load and the download */
    const statusLine = el('div', {
        marginTop: '10px', paddingTop: '6px', borderTop: '1px solid #ccc',
        minHeight: '1.2em', fontSize: '90%', color: '#333',
    });
    function setStatus(text) {
        statusLine.textContent = text || '';
    }

    function showTab(which) {
        const searching = (which === 'search');
        searchPane.style.display = searching ? 'block' : 'none';
        allPane.style.display = searching ? 'none' : 'block';
        searchTab.style.backgroundColor = searching ? '#fff' : '#ddd';
        searchTab.style.fontWeight = searching ? 'bold' : 'normal';
        allTab.style.backgroundColor = searching ? '#ddd' : '#fff';
        allTab.style.fontWeight = searching ? 'normal' : 'bold';
        if (searching) searchInput.focus();
    }

    /* One catalog row: title (optional), publisher/year, duration/variation,
     * and the Load button. Clicking anywhere selects; only Load downloads. */
    function imageRow(image, selection, opts) {
        const showName = (opts || {}).showName !== false;
        const row = el('div', {
            display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 4px',
            borderBottom: '1px solid #ccc', cursor: 'pointer',
        });
        const text = el('div', {flex: '1 1 auto', minWidth: '0', overflowWrap: 'anywhere'});
        if (showName) text.appendChild(el('div', {fontWeight: 'bold'}, {textContent: image.name}));

        const publisher = (image.pub || 'Unknown') + (image.year ? ', ' + image.year : '');
        text.appendChild(el('div', {color: '#444', fontSize: '90%'}, {textContent: publisher}));

        const duration = formatDuration(image.duration);
        const detail = (duration ? '[' + duration + ']' : '')
            + (image.variation ? '  ' + image.variation : '');
        if (detail.trim()) {
            text.appendChild(el('div',
                {color: '#8a6d00', fontSize: '90%'}, {textContent: detail.trim()}));
        }
        row.appendChild(text);

        const loadButton = el('button',
            {flex: '0 0 auto', padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap'},
            {type: 'button', textContent: 'Load'});
        loadButton.addEventListener('click', (e) => {
            e.stopPropagation();
            load(image.gid, image.name);
        });
        row.appendChild(loadButton);

        row.addEventListener('click', () => {
            if (selection.selected && selection.selected !== row) {
                selection.selected.style.backgroundColor = 'transparent';
            }
            selection.selected = row;
            row.style.backgroundColor = '#c8c8c8';
        });
        row.addEventListener('mouseenter', () => {
            if (selection.selected !== row) row.style.backgroundColor = '#e6e6e6';
        });
        row.addEventListener('mouseleave', () => {
            if (selection.selected !== row) row.style.backgroundColor = 'transparent';
        });
        return row;
    }

    function renderList(target, images, opts) {
        target.innerHTML = '';
        const selection = {selected: null};
        if (!images.length) {
            target.appendChild(el('p',
                {color: '#666', fontStyle: 'italic'}, {textContent: 'No results.'}));
            return;
        }
        images.forEach((image) => target.appendChild(imageRow(image, selection, opts)));
    }

    container.appendChild(statusLine);
    allTab.addEventListener('click', () => showTab('all'));
    searchTab.addEventListener('click', () => showTab('search'));

    /* ---- Search tab ---- */
    const searchInput = el('input', {
        width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '16px',
        border: '2px solid #888', borderRadius: '4px', backgroundColor: INPUT_BG,
    }, {type: 'search', placeholder: 'Type a game name…', autocomplete: 'off'});
    searchPane.appendChild(searchInput);

    const help = el('div', {
        marginTop: '8px', padding: '8px', backgroundColor: '#f6f6f6',
        border: '1px solid #ddd', borderRadius: '4px', fontSize: '90%', lineHeight: '1.5',
    });
    help.innerHTML = HELP_HTML;
    searchPane.appendChild(help);

    const searchResults = el('div', {marginTop: '8px'});
    searchPane.appendChild(searchResults);

    let results = [];
    let searchTimer = null;

    function runSearch() {
        const query = searchInput.value;
        // Blank box: show the help instead of every title in the catalog.
        if (query.trim() === '' && query[0] !== ' ' && query[0] !== '=') {
            help.style.display = 'block';
            searchResults.innerHTML = '';
            results = [];
            return;
        }
        help.style.display = 'none';

        const found = db.search(query, MAX_RESULTS);
        if (found && !Array.isArray(found) && found.error) {
            results = [];
            searchResults.innerHTML = '';
            searchResults.appendChild(el('p',
                {color: '#a00', fontStyle: 'italic'},
                {textContent: found.error + '. Check the condition after "=".'}));
            return;
        }
        results = Array.isArray(found) ? found : [];
        renderList(searchResults, results, {showName: true});
    }

    searchInput.addEventListener('input', () => {
        const value = searchInput.value;
        searchInput.style.backgroundColor =
            (value[0] === ' ') ? INPUT_BG_PUB : ((value[0] === '=') ? INPUT_BG_SQL : INPUT_BG);
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
    });
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (results.length) load(results[0].gid, results[0].name);
        }
    });

    /* ---- All tab: initial letter → title → variations ---- */
    const alphaBar = el('div', {
        display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px',
    });
    allPane.appendChild(alphaBar);
    const alphaList = el('div', {});
    allPane.appendChild(alphaList);

    let currentAlpha = null;

    function showVariations(name) {
        alphaList.innerHTML = '';
        const back = el('button',
            {marginBottom: '8px', padding: '4px 10px', cursor: 'pointer'},
            {type: 'button', textContent: '‹ Back to "' + alphaLabel(currentAlpha) + '"'});
        back.addEventListener('click', () => showNames(currentAlpha));
        alphaList.appendChild(back);
        alphaList.appendChild(el('h3',
            {margin: '4px 0 8px 0', fontSize: '16px'}, {textContent: name}));

        const images = db.variations(name) || [];
        const list = el('div', {});
        alphaList.appendChild(list);
        renderList(list, images, {showName: false});
    }

    function showNames(index) {
        alphaList.innerHTML = '';
        const names = db.alphaNames(index) || [];
        alphaList.appendChild(el('div',
            {margin: '4px 0', color: '#666', fontSize: '90%'},
            {textContent: names.length
                ? 'Titles starting with "' + alphaLabel(index) + '", pick one:'
                : 'No titles starting with "' + alphaLabel(index) + '".'}));
        names.forEach((name) => {
            const row = el('div', {
                padding: '6px 4px', borderBottom: '1px solid #ccc', cursor: 'pointer',
                fontWeight: 'bold', overflowWrap: 'anywhere',
            }, {textContent: name});
            row.addEventListener('mouseenter', () => { row.style.backgroundColor = '#e6e6e6'; });
            row.addEventListener('mouseleave', () => { row.style.backgroundColor = 'transparent'; });
            row.addEventListener('click', () => showVariations(name));
            alphaList.appendChild(row);
        });
    }

    function selectAlpha(index, button) {
        currentAlpha = index;
        Array.from(alphaBar.children).forEach((b) => {
            b.style.backgroundColor = '#eee';
            b.style.fontWeight = 'normal';
        });
        if (button) {
            button.style.backgroundColor = '#fff';
            button.style.fontWeight = 'bold';
        }
        showNames(index);
    }

    for (let i = 0; i <= 26; i++) {
        const button = el('button', {
            minWidth: '30px', padding: '4px 6px', cursor: 'pointer',
            border: '1px solid #888', borderRadius: '3px', backgroundColor: '#eee',
        }, {type: 'button', textContent: alphaLabel(i)});
        button.addEventListener('click', () => selectAlpha(i, button));
        alphaBar.appendChild(button);
    }

    showTab('search');
    setStatus('Loading game database…');
    db.load().then(() => {
        setStatus('');
        runSearch();
        searchInput.focus();
    }).catch((e) => {
        setStatus('Failed to load game database: ' + ((e && e.message) ? e.message : e));
    });
}

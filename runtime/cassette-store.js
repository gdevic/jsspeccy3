/*
 * runtime/cassette-store.js: persistent storage for the tape recorder's cassettes.
 *
 * Cassettes (TZX images as runtime/cassette.js writes them, plus a label,
 * a label colour, whether the write-protect tab is out, and where the tape
 * was left) live in IndexedDB, so they survive a page reload. Whether the
 * recorder is connected, and which cassette is in it, is small enough to keep
 * in localStorage instead. Every access is wrapped defensively - a private-
 * browsing tab or a blocked/cleared origin should degrade to "the recorder
 * starts empty", never break the emulator.
 */

const DB_NAME = 'jsspeccy-cassettes';
const DB_VERSION = 1;
const STORE = 'cassettes';
const DECK_KEY = 'jsspeccy-tape-deck';

// Label colours, as the paper labels on blank cassettes came.
export const CASSETTE_COLOURS = ['#f1e7c6', '#f4f4f0', '#f2d74e', '#e0685a', '#7fb0e0', '#8fcf8a'];

export function isAvailable() {
    try {
        return typeof indexedDB !== 'undefined';
    } catch (e) {
        return false;
    }
}

let dbPromise = null;
function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (!isAvailable()) { reject(new Error('IndexedDB unavailable')); return; }
        let request;
        try {
            request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
            reject(e);
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return dbPromise;
}

function tx(storeMode) {
    return openDB().then(db => db.transaction(STORE, storeMode).objectStore(STORE));
}

/* Runs `fn(store)` in a read-write transaction and resolves with its
 * result once the transaction has committed. A write can still fail at the
 * commit (a full disk is reported only then), so this rejects if the
 * transaction aborts, rather than report a write that never landed. */
async function write(fn) {
    const db = await openDB();
    const transaction = db.transaction(STORE, 'readwrite');
    const committed = new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('The write was abandoned'));
    });
    committed.catch(() => {});  // reported by the await below
    const result = await fn(transaction.objectStore(STORE));
    await committed;
    return result;
}

function reqToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

const genId = () => {
    try {
        if (crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return 'cass-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
};

const toBuffer = (data) => (data instanceof ArrayBuffer) ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

/* Requests durable storage once there's something worth not losing. Silently
 * does nothing where the API or the permission isn't available. */
function requestPersistence() {
    try {
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch (e) { /* ignore */ }
}

/* Metadata for every stored cassette (no tape bytes - keeps the cassette
 * box cheap to list), newest-modified first. */
export async function list() {
    try {
        const store = await tx('readonly');
        const all = await reqToPromise(store.getAll());
        return all
            .map(({ data, ...meta }) => meta)
            .sort((a, b) => (b.modified || 0) - (a.modified || 0));
    } catch (e) {
        console.warn('Cassette box unavailable:', e);
        return [];
    }
}

/* The full record, including its TZX bytes (as a Uint8Array). */
export async function get(id) {
    if (!id) return null;
    try {
        const store = await tx('readonly');
        const record = await reqToPromise(store.get(id));
        if (!record) return null;
        return { ...record, data: new Uint8Array(record.data) };
    } catch (e) {
        console.warn('Could not read cassette', id, e);
        return null;
    }
}

function makeRecord({ id, label, colour, data, positionMs, writeProtect, created, modified }) {
    const now = Date.now();
    return {
        id: id || genId(),
        label: label || '',
        colour: colour || CASSETTE_COLOURS[0],
        data: toBuffer(data),
        positionMs: Number.isFinite(positionMs) ? positionMs : 0,
        writeProtect: !!writeProtect,
        created: created || now,
        modified: modified || now,
    };
}

/* Adds a new cassette to the box. Returns its id, or null if storage isn't
 * available (the caller should still let the cassette be used - it just
 * won't survive a reload). */
export async function create(fields) {
    const record = makeRecord({ ...fields, id: null, created: null, modified: null });
    try {
        await write(store => reqToPromise(store.put(record)));
        requestPersistence();
        return record.id;
    } catch (e) {
        console.warn('Could not save new cassette (it will not survive a reload):', e);
        return null;
    }
}

/* Stores a cassette under its own id, replacing any with that id: how a
 * restored session brings its cassette back. Returns the id, or null if
 * storage isn't available. */
export async function put(fields) {
    const record = makeRecord(fields);
    try {
        await write(store => reqToPromise(store.put(record)));
        requestPersistence();
        return record.id;
    } catch (e) {
        console.warn('Could not store cassette', record.id, e);
        return null;
    }
}

/* Merges the given fields into an existing record (e.g. after recording:
 * {data, positionMs, modified}; after a rename: {label}). */
export async function update(id, fields) {
    return (await updateIfUnchanged(id, fields)) === 'written';
}

/* As update(), but only if the record's `modified` is still
 * `expectedModified` (when given): another tab of the emulator may have
 * written the cassette since this one last read or wrote it. Returns
 * 'written', 'changed' (left alone, since it was changed elsewhere) or
 * 'failed' (not there, or storage failed). */
export async function updateIfUnchanged(id, fields, expectedModified) {
    if (!id) return 'failed';
    try {
        return await write(async (store) => {
            const existing = await reqToPromise(store.get(id));
            if (!existing) return 'failed';
            if ((expectedModified !== undefined) && ((existing.modified || 0) !== expectedModified)) return 'changed';
            const merged = { ...existing, ...fields, id };
            if (fields.data) merged.data = toBuffer(fields.data);
            await reqToPromise(store.put(merged));
            return 'written';
        });
    } catch (e) {
        console.warn('Could not update cassette', id, e);
        return 'failed';
    }
}

export async function remove(id) {
    try {
        await write(store => reqToPromise(store.delete(id)));
        return true;
    } catch (e) {
        console.warn('Could not delete cassette', id, e);
        return false;
    }
}

// A copy of a cassette, wound back to the start.
export async function duplicate(id) {
    const record = await get(id);
    if (!record) return null;
    return create({ label: record.label, colour: record.colour, data: record.data, writeProtect: record.writeProtect });
}

/* Whether the tape recorder is connected, and which cassette (by id, or
 * null) is in it - or waiting in it, disconnected, to go back in. On a first
 * visit, with nothing kept yet, the recorder is connected. */
export function getDeckState() {
    try {
        const parsed = JSON.parse(localStorage.getItem(DECK_KEY));
        if (!parsed) return { connected: true, cassette: null };
        return { connected: !!parsed.connected, cassette: (typeof parsed.cassette === 'string') ? parsed.cassette : null };
    } catch (e) {
        return { connected: false, cassette: null };
    }
}

export function setDeckState(state) {
    try {
        localStorage.setItem(DECK_KEY, JSON.stringify(state));
    } catch (e) { /* private browsing / quota / disabled storage: just don't persist it */ }
}

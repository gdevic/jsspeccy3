/*
 * runtime/microdrive-store.js — persistent storage for Microdrive cartridges.
 *
 * Cartridges (full .mdr images plus a label/colour) live in IndexedDB, so
 * they survive a page reload. The label is a copy of the name the cartridge
 * was formatted with ('' when unformatted), kept so the cartridge box can
 * list names without reading every image. Which cartridge (if any) is
 * inserted in each drive, and whether the Interface 1 is connected, is small
 * enough to keep in localStorage instead. Every access is wrapped defensively -
 * a private-browsing tab or a blocked/cleared origin should degrade to "the
 * dock starts empty", never break the emulator.
 */

const DB_NAME = 'jsspeccy-microdrive';
const DB_VERSION = 1;
const STORE = 'cartridges';
const DOCK_KEY = 'jsspeccy-microdrive-dock';

export const DRIVE_COUNT = 2; // Microdrives connected to the Interface 1

// A cartridge shell colour palette, echoing the real Microdrive's own
// (black, plus the handful of colours WHSmith/Sinclair sold). The UI cycles
// through these; stored as a plain CSS colour string.
export const CARTRIDGE_COLOURS = ['#2a2a2a', '#a33', '#369', '#3a6', '#c93', '#639'];

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
    return 'cart-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
};

/* Requests durable storage once there's something worth not losing. Silently
 * does nothing where the API or the permission isn't available. */
function requestPersistence() {
    try {
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch (e) { /* ignore */ }
}

/* Metadata for every stored cartridge (no cartridge bytes - keeps the
 * cartridge box's grid cheap to render), newest-modified first. */
export async function list() {
    try {
        const store = await tx('readonly');
        const all = await reqToPromise(store.getAll());
        return all
            .map(({ data, ...meta }) => meta)
            .sort((a, b) => (b.modified || 0) - (a.modified || 0));
    } catch (e) {
        console.warn('Microdrive cartridge library unavailable:', e);
        return [];
    }
}

/* The full record, including its .mdr bytes (as a Uint8Array). */
export async function get(id) {
    try {
        const store = await tx('readonly');
        const record = await reqToPromise(store.get(id));
        if (!record) return null;
        return { ...record, data: new Uint8Array(record.data) };
    } catch (e) {
        console.warn('Could not read cartridge', id, e);
        return null;
    }
}

/* Adds a new cartridge to the library. `data` is a full .mdr image
 * (ArrayBuffer or Uint8Array). Returns the new id, or null if storage isn't
 * available (the caller should still let the cartridge run - it just won't
 * survive a reload). */
export async function create({ label, colour, data }) {
    const id = genId();
    const now = Date.now();
    const record = {
        id,
        label: label || '',
        colour: colour || CARTRIDGE_COLOURS[0],
        data: data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        created: now,
        modified: now,
        exported: null,
    };
    try {
        const store = await tx('readwrite');
        await reqToPromise(store.put(record));
        requestPersistence();
        return id;
    } catch (e) {
        console.warn('Could not save new cartridge (it will not survive a reload):', e);
        return null;
    }
}

/* Merges the given fields into an existing record (e.g. after a worker
 * flush: {data, modified}; after a rename: {label}). */
export async function update(id, fields) {
    try {
        const store = await tx('readwrite');
        const existing = await reqToPromise(store.get(id));
        if (!existing) return false;
        const merged = { ...existing, ...fields, id };
        if (fields.data && !(fields.data instanceof ArrayBuffer)) {
            const d = fields.data;
            merged.data = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
        }
        await reqToPromise(store.put(merged));
        return true;
    } catch (e) {
        console.warn('Could not update cartridge', id, e);
        return false;
    }
}

export async function remove(id) {
    try {
        const store = await tx('readwrite');
        await reqToPromise(store.delete(id));
        return true;
    } catch (e) {
        console.warn('Could not delete cartridge', id, e);
        return false;
    }
}

export async function duplicate(id) {
    const record = await get(id);
    if (!record) return null;
    return create({ label: record.label, colour: record.colour, data: record.data });
}

/* Which cartridge (by id, or null) sits in each drive, and whether the
 * Interface 1 is connected. */
export function getDockState() {
    try {
        const raw = localStorage.getItem(DOCK_KEY);
        if (!raw) return { connected: false, drives: new Array(DRIVE_COUNT).fill(null) };
        const parsed = JSON.parse(raw);
        const drives = new Array(DRIVE_COUNT).fill(null);
        if (Array.isArray(parsed.drives)) {
            for (let i = 0; i < DRIVE_COUNT; i++) drives[i] = parsed.drives[i] || null;
        }
        return { connected: !!parsed.connected, drives };
    } catch (e) {
        return { connected: false, drives: new Array(DRIVE_COUNT).fill(null) };
    }
}

export function setDockState(state) {
    try {
        localStorage.setItem(DOCK_KEY, JSON.stringify(state));
    } catch (e) { /* private browsing / quota / disabled storage: just don't persist it */ }
}

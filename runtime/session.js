/*
 * runtime/session.js — saving and restoring a whole session as one file.
 *
 * A session is a snapshot in time of everything: the running machine
 * (memory, CPU, paging, sound chip), the machine and ROM chosen, the tape
 * and where it is parked, the Microdrive cartridge box and what is in each
 * drive, the printer's roll and printout, and the settings (joystick, tape
 * loading, keyboard, display size). It is saved as a ZIP of readable parts,
 * so each can also be used on its own:
 *
 *   session.json               what the session holds, and the settings
 *   machine.szx                the machine, as a standard SZX snapshot
 *   tape/<name>                the tape file as it was opened
 *   microdrive/<nn>-<name>.mdr every cartridge in the box
 *   printer/printout.bin       the printout, 32 bytes per dot row
 *   printer/printout.png       the printout as a picture
 *
 * The ZIP may also hold these inside a single folder, as happens when a
 * session is unpacked and packed again.
 */

import JSZip from 'jszip';
import { parseSZXFile, writeSZXFile } from './snapshot.js';
import { TAPFile, TZXFile } from './tape.js';
import { validateMDRFile } from './mdr.js';

const MANIFEST = 'session.json';
const FORMAT = 'jsspeccy-session';
const VERSION = 1;
const ROW_BYTES = 32;

const MACHINE_NAMES = { 48: 'Spectrum 48K', 128: 'Spectrum 128K', 5: 'Pentagon 128' };
const JOYSTICK_TYPES = ['none', 'kempston', 'cursor', 'sinclair1', 'sinclair2'];
const TAPE_AUTOLOAD_MODES = ['default', 'usr0'];

// A file name safe on every system, keeping it recognisable.
const safeName = (name, fallback) => (String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || fallback);

/* Where in the ZIP the session is: '' at the top, or 'folder/' when it is
 * inside a single folder; null if the ZIP holds no session. */
async function sessionRoot(zip) {
    const manifests = zip.file(/(^|\/)session\.json$/).filter(f => f.name.split('/').length <= 2);
    if (manifests.length !== 1) return null;
    try {
        const manifest = JSON.parse(await manifests[0].async('string'));
        if (manifest.format !== FORMAT) return null;
    } catch (e) {
        return null;
    }
    return manifests[0].name.slice(0, -MANIFEST.length);
}

// Whether an opened ZIP is a saved session.
export async function isSessionFile(zip) {
    return (await sessionRoot(zip)) !== null;
}

/* Builds the session file from its parts:
 *   snapshot     from Emulator.getSnapshot()
 *   settings     {machine, rom48, joystickType, joystickDevice, tapeTraps,
 *                 autoLoadTapes, tapeAutoLoadMode, keyboardShown, zoom}
 *   tape         {name, data, block} or null
 *   microdrives  {connected, drives: [id or null], cartridges: [{id, label,
 *                 colour, created, modified, data}]}
 *   printer      {connected, paper, saved, rows: [Uint8Array], scroll, picture: Blob or null}
 *   gameName     the loaded game's name, for the Pokes dialog
 *   power        'off' (never started), 'paused' or 'running'
 * Returns a Blob. */
export async function buildSessionFile(parts) {
    const zip = new JSZip();
    const { snapshot } = parts;

    zip.file('machine.szx', writeSZXFile(snapshot));

    let tape = null;
    if (parts.tape) {
        const file = 'tape/' + safeName(parts.tape.name, 'tape.tzx');
        zip.file(file, parts.tape.data);
        tape = { file, name: parts.tape.name, block: parts.tape.block };
    }

    const cartridges = parts.microdrives.cartridges.map((c, i) => {
        const file = `microdrive/${String(i + 1).padStart(2, '0')}-${safeName(c.label, 'blank')}.mdr`;
        zip.file(file, c.data);
        return { id: c.id, label: c.label, colour: c.colour, created: c.created, modified: c.modified, file };
    });

    const rows = parts.printer.rows;
    const printout = new Uint8Array(rows.length * ROW_BYTES);
    rows.forEach((row, i) => printout.set(row, i * ROW_BYTES));
    zip.file('printer/printout.bin', printout);
    if (parts.printer.picture) zip.file('printer/printout.png', parts.printer.picture);

    const manifest = {
        format: FORMAT,
        version: VERSION,
        saved: new Date().toISOString(),
        machine: {
            model: snapshot.model,
            name: MACHINE_NAMES[snapshot.model] || 'Spectrum',
            rom48: parts.settings.rom48,
            snapshot: 'machine.szx',
            // the printer's mechanism is not something SZX carries
            printerMechanism: snapshot.printer,
            // 'off' (never started), 'paused' or 'running'
            power: parts.power,
        },
        settings: parts.settings,
        tape,
        microdrives: { connected: parts.microdrives.connected, drives: parts.microdrives.drives, cartridges },
        printer: {
            connected: parts.printer.connected,
            paper: parts.printer.paper,
            saved: parts.printer.saved,
            printout: 'printer/printout.bin',
            // how far the printout is scrolled back, in dot rows
            scroll: parts.printer.scroll || 0,
        },
        gameName: parts.gameName || null,
    };
    zip.file(MANIFEST, JSON.stringify(manifest, null, 2));

    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// Only settings this version knows, with values it can use.
function checkedSettings(saved) {
    const s = (saved && typeof saved === 'object') ? saved : {};
    const settings = { rom48: s.rom48 === 'gw03' ? 'gw03' : 'standard' };
    if (JOYSTICK_TYPES.includes(s.joystickType)) settings.joystickType = s.joystickType;
    if (s.joystickDevice === null || typeof s.joystickDevice === 'string') settings.joystickDevice = s.joystickDevice;
    if (typeof s.tapeTraps === 'boolean') settings.tapeTraps = s.tapeTraps;
    if (typeof s.autoLoadTapes === 'boolean') settings.autoLoadTapes = s.autoLoadTapes;
    if (TAPE_AUTOLOAD_MODES.includes(s.tapeAutoLoadMode)) settings.tapeAutoLoadMode = s.tapeAutoLoadMode;
    if (typeof s.keyboardShown === 'boolean') settings.keyboardShown = s.keyboardShown;
    if (Number.isFinite(s.zoom) && s.zoom > 0 && s.zoom <= 8) settings.zoom = s.zoom;
    return settings;
}

/* Reads a session from an opened ZIP back into the parts buildSessionFile
 * takes, with the snapshot ready for Emulator.loadSnapshot(). Everything is
 * checked here, before anything is changed, so a damaged session is turned
 * away whole; throws with the reason. */
export async function readSessionFile(zip) {
    const root = await sessionRoot(zip);
    if (root === null) throw new Error('This ZIP file is not a saved session.');
    const manifest = JSON.parse(await zip.file(root + MANIFEST).async('string'));
    if (!(manifest.version <= VERSION)) throw new Error('This session was saved by a newer version of the emulator.');

    const need = async (path, type) => {
        const file = (typeof path === 'string') ? zip.file(root + path) : null;
        if (!file) throw new Error('The session is missing ' + path + '.');
        return file.async(type);
    };

    const machine = manifest.machine || {};
    const snapshot = parseSZXFile(await need(machine.snapshot, 'arraybuffer'));
    if (machine.printerMechanism) snapshot.printer = machine.printerMechanism;

    let tape = null;
    if (manifest.tape) {
        const name = safeName(manifest.tape.name, 'tape.tzx');
        const data = await need(manifest.tape.file, 'arraybuffer');
        const isTZX = name.toLowerCase().endsWith('.tzx');
        if (!(isTZX ? TZXFile.isValid(data) : TAPFile.isValid(data))) throw new Error('The tape in the session, ' + name + ', is damaged.');
        const block = Number.isInteger(manifest.tape.block) && manifest.tape.block >= 0 ? manifest.tape.block : 0;
        tape = { name, data, block, isTZX };
    }

    const saved = manifest.microdrives || {};
    const cartridges = [];
    for (const c of (Array.isArray(saved.cartridges) ? saved.cartridges : [])) {
        const data = new Uint8Array(await need(c.file, 'arraybuffer'));
        if (!validateMDRFile(data.buffer)) throw new Error('A cartridge in the session, ' + c.file + ', is damaged.');
        cartridges.push({
            id: typeof c.id === 'string' ? c.id : null,
            label: typeof c.label === 'string' ? c.label : '',
            colour: typeof c.colour === 'string' ? c.colour : undefined,
            created: Number.isFinite(c.created) ? c.created : undefined,
            modified: Number.isFinite(c.modified) ? c.modified : undefined,
            data,
        });
    }
    const drives = (Array.isArray(saved.drives) ? saved.drives : []).map(id => (typeof id === 'string') ? id : null);

    const printer = manifest.printer || {};
    const printout = new Uint8Array(await need(printer.printout, 'arraybuffer'));
    const rows = [];
    for (let i = 0; i + ROW_BYTES <= printout.length; i += ROW_BYTES) rows.push(printout.slice(i, i + ROW_BYTES));

    return {
        saved: manifest.saved,
        machineName: MACHINE_NAMES[snapshot.model] || 'Spectrum',
        snapshot,
        settings: checkedSettings(manifest.settings),
        tape,
        microdrives: { connected: !!saved.connected, drives, cartridges },
        printer: {
            connected: !!printer.connected,
            paper: Number.isFinite(printer.paper) ? printer.paper : 0,
            saved: !!printer.saved,
            rows,
            scroll: (Number.isFinite(printer.scroll) && printer.scroll > 0) ? printer.scroll : 0,
        },
        gameName: typeof manifest.gameName === 'string' ? manifest.gameName : null,
        power: ['off', 'paused', 'running'].includes(machine.power) ? machine.power : 'running',
    };
}

/* Asks before a restore replaces what is running, with a summary of the
 * session. Resolves true to go ahead. Keys typed while it has the focus stay
 * with it: Enter or Space presses the focused button, Esc cancels. */
export function confirmRestore(ui, session) {
    return new Promise((resolve) => {
        const card = document.createElement('div');
        Object.assign(card.style, {
            position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
            width: '300px', maxWidth: '90%', background: '#1c1e22', color: '#eee',
            border: '1px solid #444', borderRadius: '8px', boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
            fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px', zIndex: '130', overflow: 'hidden',
        });
        const header = document.createElement('div');
        Object.assign(header.style, { padding: '8px 10px', background: '#25282e', borderBottom: '1px solid #333', fontSize: '13px', fontWeight: 'bold' });
        header.textContent = 'Restore this session?';

        const body = document.createElement('div');
        Object.assign(body.style, { padding: '10px', lineHeight: '1.6' });
        const when = session.saved ? new Date(session.saved).toLocaleString() : 'unknown time';
        const count = session.microdrives.cartridges.length;
        const lines = [
            `Saved ${when}`,
            session.machineName + (session.gameName ? `, running ${session.gameName}` : '')
                + (session.power === 'off' ? ', switched off' : (session.power === 'paused' ? ', paused' : '')),
            session.tape ? `Tape: ${session.tape.name}` : 'No tape',
            `${count} Microdrive cartridge${count === 1 ? '' : 's'}`,
            session.printer.rows.length ? `Printout: ${(session.printer.rows.length * 92 / 2560).toFixed(1)} cm` : 'No printout',
        ];
        for (const text of lines) {
            const line = document.createElement('div');
            line.textContent = text;
            body.appendChild(line);
        }
        const note = document.createElement('div');
        Object.assign(note.style, { color: '#999', fontSize: '11px', marginTop: '8px' });
        note.textContent = 'This replaces the running machine, the tape, the printout and the settings. Its cartridges join your box: none are deleted, and where your box holds newer work on one of them, both are kept.';
        body.appendChild(note);

        const footer = document.createElement('div');
        Object.assign(footer.style, { display: 'flex', justifyContent: 'flex-end', gap: '6px', padding: '8px 10px', borderTop: '1px solid #333', background: '#1a1c20' });
        const button = (label, primary) => {
            const b = document.createElement('button');
            Object.assign(b.style, {
                border: 'none', borderRadius: '4px', padding: '4px 12px', cursor: 'pointer', fontSize: '12px',
                background: primary ? '#3a6' : '#333', color: primary ? '#fff' : '#ccc',
            });
            b.textContent = label;
            return b;
        };
        const cancel = button('Cancel', false);
        const restore = button('Restore', true);
        footer.append(cancel, restore);
        card.append(header, body, footer);

        const finish = (answer) => {
            card.remove();
            resolve(answer);
        };
        cancel.addEventListener('click', () => finish(false));
        restore.addEventListener('click', () => finish(true));
        // Keys go no further than the card, so they never reach the Spectrum.
        for (const type of ['keydown', 'keyup', 'keypress']) {
            card.addEventListener(type, (e) => {
                e.stopPropagation();
                if (type === 'keydown' && e.key === 'Escape') finish(false);
            });
        }
        ui.appContainer.appendChild(card);
        restore.focus();
    });
}

/* Asks where to save, with a Save As dialog where the browser has one. It
 * must be called straight from the click, before any slow work, since the
 * browser only opens it in response to the user. Resolves to a file
 * handle, to null for an ordinary download instead, or to false if the
 * user cancelled. */
export async function chooseSaveTarget(suggestedName) {
    if (!window.showSaveFilePicker) return null;
    try {
        return await window.showSaveFilePicker({
            suggestedName,
            types: [{ description: 'Spectrum session', accept: { 'application/zip': ['.zip'] } }],
        });
    } catch (e) {
        if (e && e.name === 'AbortError') return false;
        return null;  // not allowed here: download instead
    }
}

/* Writes the file to the chosen target, or downloads it. */
export async function writeSaveTarget(target, blob, suggestedName) {
    if (target) {
        const writable = await target.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

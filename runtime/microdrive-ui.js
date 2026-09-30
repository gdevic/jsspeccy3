/*
 * runtime/microdrive-ui.js — the Microdrive dock, drive panel and cartridge box.
 *
 * createMicrodriveDock(ui, emu) builds a two-drive dock standing to the left
 * of the Spectrum, joined to it by a ribbon (visible = connected: showing it plugs
 * in the Interface 1, hiding it unplugs it, but never ejects a cartridge -
 * see runtime/mdr.js and generator/core.ts.in for why that distinction
 * matters). Disconnecting or reloading the page never loses what's in a
 * drive.
 *
 * The UI splits using a cartridge from keeping one. A drive is where a
 * cartridge is used: clicking a drive opens its panel, which inserts a
 * cartridge into an empty drive, or for a loaded one shows the tape (a
 * tape-loop ring plus a CAT-style file list), formats a blank cartridge,
 * toggles write protection and ejects. The cartridge box (File menu) is
 * where cartridges are kept: a grid over every cartridge saved in
 * runtime/microdrive-store.js, to create, import, export, name, colour,
 * duplicate and delete them.
 */

import JSZip from 'jszip';
import * as mdr from './mdr.js';
import * as store from './microdrive-store.js';
import { boxCopyMovedOn } from './session.js';
import { openDialog, h, button, confirmButton } from './dialog.js';
import { makeMovable, makeDeviceMovable } from './movable.js';
import { makeCommandRow } from './type-in.js';

import ejectIcon from './icons/eject.svg';
import openIcon from './icons/open.svg';
import closeIcon from './icons/close.svg';

const DRIVE_COUNT = store.DRIVE_COUNT;

/* ---------- small DOM/SVG helpers (mirrors the plain-DOM style already used
 * in pokes.js/keyboard-overlay.js - no framework, no extra dependency) ---------- */
const SVG_NS = 'http://www.w3.org/2000/svg';
function el(tag, styles, props) {
    const e = document.createElement(tag);
    if (styles) Object.assign(e.style, styles);
    if (props) Object.assign(e, props);
    return e;
}
function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
}
const polar = (cx, cy, r, angle) => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];

function colourForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(hash) % 360}, 62%, 56%)`;
}

const fmtDate = (ms) => ms ? new Date(ms).toLocaleString() : '-';

// Whether two cartridge images hold the same bytes.
function sameBytes(a, b) {
    const x = new Uint8Array(a), y = new Uint8Array(b);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
}

/* Triggers a browser download of `bytes` as `filename`, with a brief pulse on
 * `flourishEl` (if given) standing in for a fuller "cartridge flies out to
 * the corner" animation - a first-cut simplification. */
function downloadBytes(bytes, filename, flourishEl) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { display: 'none' }, { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (flourishEl && flourishEl.animate) {
        flourishEl.animate(
            [{ transform: 'scale(1)' }, { transform: 'scale(1.15)' }, { transform: 'scale(1)' }],
            { duration: 320, easing: 'ease-out' }
        );
    }
}

const readFileAsArrayBuffer = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
});

/* ==================== the drive icon (dock art) ==================== */

/* Rainbow colours and slope taken from the keyboard image (zx_keyboard.png):
 * red, yellow, green, blue from left to right, each band leaning right as it
 * rises, about 0.33 across for every 1 up. */
const RAINBOW = ['#d0412e', '#e2b13c', '#5fa847', '#3a7cc4'];
const RAINBOW_SLOPE = 0.33;

/* One drive as seen from the front and above, drawn after the real ZX
 * Microdrive: a flat top whose rear third steps up into a raised band that
 * carries the SINCLAIR and ZX Microdrive lettering, the rainbow flash across
 * the front right corner of the top, and a shallow front face holding the
 * red LED and the cartridge slot. An inserted cartridge shows as its label
 * end pushed into the slot, standing slightly proud of the front face. */
export const DRIVE_W = 66, DRIVE_H = 72;
export const DOCK_SCALE = 1.2; // drawn size relative to the display, before the zoom factor
const TOP_Y = 1, STEP_Y = 25, FRONT_Y = 57, BOTTOM_Y = 70;

let driveArtId = 0;

function buildDriveIcon(driveIndex) {
    const W = DRIVE_W, H = DRIVE_H;
    const uid = 'mdart' + (driveArtId++);
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    svg.style.display = 'block';
    svg.style.overflow = 'visible';

    const defs = svgEl('defs');
    const grad = (id, stops) => {
        const g = svgEl('linearGradient', { id: uid + id, x1: 0, y1: 0, x2: 0, y2: 1 });
        stops.forEach(([offset, colour]) => g.appendChild(svgEl('stop', { offset, 'stop-color': colour })));
        defs.appendChild(g);
        return `url(#${uid + id})`;
    };
    const raisedFill = grad('r', [[0, '#3a3d42'], [1, '#26282c']]);
    const bevelFill = grad('b', [[0, '#141518'], [1, '#202226']]);
    const deckFill = grad('d', [[0, '#26282c'], [1, '#1d1f22']]);
    const frontFill = grad('f', [[0, '#17181b'], [1, '#0c0d0e']]);
    const deckClip = svgEl('clipPath', { id: uid + 'c' });
    deckClip.appendChild(svgEl('rect', { x: 1, y: STEP_Y + 4, width: W - 2, height: FRONT_Y - STEP_Y - 4 }));
    defs.appendChild(deckClip);
    svg.appendChild(defs);

    // Whole outline first, so the drag glow can trace it.
    const body = svgEl('rect', {
        x: 0.5, y: TOP_Y - 0.5, width: W - 1, height: BOTTOM_Y - TOP_Y + 1, rx: 4,
        fill: '#101113', stroke: '#050505', 'stroke-width': 1,
    });
    svg.appendChild(body);

    // Raised rear band, then its sloped front edge down to the deck.
    svg.appendChild(svgEl('rect', { x: 1, y: TOP_Y, width: W - 2, height: STEP_Y - TOP_Y + 2, rx: 3.5, fill: raisedFill }));
    svg.appendChild(svgEl('line', { x1: 3, y1: TOP_Y + 0.6, x2: W - 3, y2: TOP_Y + 0.6, stroke: '#55595f', 'stroke-width': 0.8 }));
    svg.appendChild(svgEl('rect', { x: 1, y: STEP_Y, width: W - 2, height: 4, fill: bevelFill }));
    svg.appendChild(svgEl('line', { x1: 1.5, y1: STEP_Y, x2: W - 1.5, y2: STEP_Y, stroke: '#4a4d53', 'stroke-width': 0.7 }));
    svg.appendChild(svgEl('rect', { x: 1, y: STEP_Y + 4, width: W - 2, height: FRONT_Y - STEP_Y - 4, fill: deckFill }));

    const sinclair = svgEl('text', {
        x: W / 2, y: 13, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 900,
        'font-family': '"Arial Black", "Helvetica Neue", Arial, sans-serif', 'letter-spacing': 0.6,
        fill: 'none', stroke: '#7d828a', 'stroke-width': 0.45,
    });
    sinclair.textContent = 'SINCLAIR';
    svg.appendChild(sinclair);
    const model = svgEl('text', {
        x: 5, y: 21.5, 'font-size': 4.6, 'font-family': 'Arial, Helvetica, sans-serif',
        fill: '#a3a8b0', 'font-style': 'italic',
    });
    model.textContent = 'ZX Microdrive';
    svg.appendChild(model);

    // Rainbow flash across the deck's front right corner, clipped by the
    // right edge the same way the keyboard's runs off the case.
    const rainbow = svgEl('g', { 'clip-path': `url(#${uid}c)` });
    const bandW = 3.4, rise = FRONT_Y - STEP_Y;
    RAINBOW.forEach((colour, i) => {
        const x0 = W - 19 + i * bandW;
        const x1 = x0 + rise * RAINBOW_SLOPE;
        rainbow.appendChild(svgEl('polygon', {
            points: `${x0},${FRONT_Y} ${x0 + bandW},${FRONT_Y} ${x1 + bandW},${STEP_Y} ${x1},${STEP_Y}`,
            fill: colour,
        }));
    });
    svg.appendChild(rainbow);

    // Front face: a highlight where the deck turns down, then the face. A
    // click on the face opens the drive's panel.
    const front = svgEl('g', { cursor: 'pointer' });
    svg.appendChild(front);
    front.appendChild(svgEl('path', {
        d: `M 1 ${FRONT_Y} H ${W - 1} V ${BOTTOM_Y - 3.5} Q ${W - 1} ${BOTTOM_Y} ${W - 4.5} ${BOTTOM_Y} H 4.5 Q 1 ${BOTTOM_Y} 1 ${BOTTOM_Y - 3.5} Z`,
        fill: frontFill,
    }));
    front.appendChild(svgEl('line', { x1: 1.5, y1: FRONT_Y + 0.4, x2: W - 1.5, y2: FRONT_Y + 0.4, stroke: '#3e4147', 'stroke-width': 0.8 }));

    // Cartridge slot, the cartridge's label end inside it, and the LED.
    const slotX = 23, slotW = 36;
    front.appendChild(svgEl('rect', { x: slotX, y: FRONT_Y + 3, width: slotW, height: 8.5, rx: 1, fill: '#030303' }));
    front.appendChild(svgEl('line', { x1: slotX + 0.5, y1: FRONT_Y + 11.8, x2: slotX + slotW - 0.5, y2: FRONT_Y + 11.8, stroke: '#34373c', 'stroke-width': 0.6 }));

    // The label carries the cartridge's name, handwritten, as a real owner
    // would have written it; blank until the cartridge is formatted.
    const cart = svgEl('g', { opacity: 0 });
    const cartBody = svgEl('rect', { x: slotX + 3, y: FRONT_Y + 4.5, width: slotW - 6, height: 8.5, rx: 0.8, fill: '#888', stroke: '#000', 'stroke-width': 0.4 });
    const labelBox = { x: slotX + 4.5, y: FRONT_Y + 5.6, width: slotW - 9, height: 5.8 };
    const cartLabel = svgEl('rect', { ...labelBox, rx: 0.5, fill: '#e8e8e4' });
    const labelClip = svgEl('clipPath', { id: uid + 'l' });
    labelClip.appendChild(svgEl('rect', labelBox));
    defs.appendChild(labelClip);
    const cartName = svgEl('text', {
        x: slotX + (slotW / 2), y: FRONT_Y + 10, 'text-anchor': 'middle', 'clip-path': `url(#${uid}l)`,
        'font-family': '"Segoe Script", "Bradley Hand", "Brush Script MT", "Comic Sans MS", cursive',
        fill: '#1f3a8a',
    });
    cart.append(cartBody, cartLabel, cartName);
    front.appendChild(cart);

    const led = svgEl('circle', { cx: 7, cy: FRONT_Y + 7.5, r: 1.6, fill: '#3a1210', stroke: '#000', 'stroke-width': 0.4 });
    front.appendChild(led);
    const number = svgEl('text', {
        x: 14.5, y: FRONT_Y + 9.3, 'text-anchor': 'middle', 'font-size': 5.5, 'font-weight': 'bold',
        'font-family': 'Arial, Helvetica, sans-serif', fill: '#5d6168',
    });
    number.textContent = String(driveIndex + 1);
    front.appendChild(number);

    return {
        element: svg,
        front,
        setLed(on) { led.setAttribute('fill', on ? '#ff3b30' : '#3a1210'); led.style.filter = on ? 'drop-shadow(0 0 2px #ff3b30)' : 'none'; },
        setCartridge(colour, name) {
            if (colour) {
                cart.setAttribute('opacity', '1');
                cartBody.setAttribute('fill', colour);
                name = name || '';
                cartName.textContent = name;
                cartName.setAttribute('font-size', (name.length <= 6) ? 4.6 : (name.length <= 8) ? 4 : 3.4);
            } else {
                cart.setAttribute('opacity', '0');
            }
        },
        setGlow(on) { body.setAttribute('stroke', on ? '#6cf' : '#050505'); body.setAttribute('stroke-width', on ? 2 : 1); },
    };
}

/* The Microdrive lead: a flat grey ribbon from the rear of drive 1 into the
 * side of the Spectrum, ending in a small black plug. RIBBON_PLUG_Y is the
 * plug's vertical centre in drive units, which the dock lines up with the
 * toolbar strip. draw(dx, dy) lays the ribbon to the drive's rear moved by
 * (dx, dy), its plug staying put; only the ribbon itself takes the
 * pointer, for the click that puts the drives back. */
export const RIBBON_W = 26;
const RIBBON_Y0 = 11, RIBBON_Y1 = 7, RIBBON_THICK = 9;
export const RIBBON_PLUG_Y = RIBBON_Y1 + (RIBBON_THICK / 2);

function buildRibbon() {
    const W = RIBBON_W, H = DRIVE_H;
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    Object.assign(svg.style, { display: 'block', overflow: 'visible', pointerEvents: 'none' });
    const y0 = RIBBON_Y0, y1 = RIBBON_Y1, thick = RIBBON_THICK, plugW = 5;
    const ribbon = svgEl('path', { fill: '#9c9ea3', stroke: '#6c6e73', 'stroke-width': 0.5 });
    ribbon.style.pointerEvents = 'visiblePainted';
    ribbon.style.cursor = 'pointer';
    svg.appendChild(ribbon);
    const lines = [];
    for (let i = 1; i < 6; i++) {
        lines.push(svgEl('path', { fill: 'none', stroke: '#85878c', 'stroke-width': 0.35 }));
        svg.appendChild(lines[i - 1]);
    }
    svg.appendChild(svgEl('rect', { x: W - plugW, y: y1 - 1.5, width: plugW, height: thick + 3, rx: 0.8, fill: '#151618', stroke: '#000', 'stroke-width': 0.4 }));
    function draw(dx, dy) {
        // Its bends stay in proportion however far it is stretched.
        const cx = (f) => dx + ((W - dx) * f);
        const edge = (y) => `M ${dx} ${y + dy} C ${cx(0.45)} ${y + dy + 7} ${cx(0.55)} ${y1 - y0 + y + 3} ${W - plugW} ${y1 - y0 + y}`;
        ribbon.setAttribute('d', `${edge(y0)} L ${W - plugW} ${y1 + thick} C ${cx(0.55)} ${y1 + thick + 3} ${cx(0.45)} ${y0 + dy + thick + 7} ${dx} ${y0 + dy + thick} Z`);
        lines.forEach((line, i) => line.setAttribute('d', edge(y0 + ((i + 1) * thick / 6))));
    }
    draw(0, 0);
    return { element: svg, draw };
}

/* A round lead for another device's cable SVG (the recorder's, the
 * printer's): the lead `width` wide in `colour`, a sheen `shine` wide in
 * `sheen` along its top, raised by `lift`, and a wider invisible stroke
 * that takes the pointer for the click that puts the device back. setPath(d)
 * lays all three along `d`. */
export function buildLead(colour, sheen, { width, shine, lift }) {
    const g = svgEl('g');
    const line = svgEl('path', { fill: 'none', stroke: colour, 'stroke-width': width, 'stroke-linecap': 'round' });
    const gloss = svgEl('path', { fill: 'none', stroke: sheen, 'stroke-width': shine, transform: `translate(0 ${-lift})` });
    const hit = svgEl('path', { fill: 'none', stroke: 'transparent', 'stroke-width': width + 6 });
    Object.assign(hit.style, { pointerEvents: 'stroke', cursor: 'pointer' });
    g.append(line, gloss, hit);
    return { g, setPath(d) { for (const p of [line, gloss, hit]) p.setAttribute('d', d); } };
}

/* ==================== the tape-loop ring ==================== */

function buildRing(size) {
    const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
    const cx = size / 2, cy = size / 2, r = size / 2 - 10;
    const track = svgEl('circle', { cx, cy, r, fill: 'none', stroke: '#333', 'stroke-width': 12 });
    svg.appendChild(track);
    const head = svgEl('circle', { cx, cy: cy - r, r: 4, fill: '#fff', stroke: '#000', 'stroke-width': 1 });
    svg.appendChild(head); // sector segments go in beneath it
    let segmentEls = [];

    function render(parsed) {
        segmentEls.forEach(s => s.remove());
        segmentEls = [];
        const n = parsed.blocks;
        if (!n) return;
        const gap = Math.min(0.04, (2 * Math.PI / n) * 0.25);
        const byFile = new Map();
        parsed.files.forEach(f => byFile.set(f.name, colourForName(f.name)));
        for (let i = 0; i < n; i++) {
            const s = parsed.sectors[i];
            let colour = '#3a3a3a'; // unformatted
            if (s.state === 'free') colour = '#5a5f66';
            else if (s.state === 'bad') colour = '#7a1f1f';
            else if (s.state === 'used') colour = byFile.get(s.fileName) || '#888';
            const a0 = (i / n) * 2 * Math.PI - Math.PI / 2 + gap;
            const a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2 - gap;
            const [x1, y1] = polar(cx, cy, r, a0);
            const [x2, y2] = polar(cx, cy, r, a1);
            const large = (a1 - a0) > Math.PI ? 1 : 0;
            const path = svgEl('path', {
                d: `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`,
                fill: 'none', stroke: colour, 'stroke-width': 11, 'stroke-linecap': 'butt',
                'data-file': s.fileName || '',
            });
            svg.insertBefore(path, head);
            segmentEls.push(path);
        }
    }
    function setHead(headPos, totalBytes) {
        const angle = totalBytes ? (headPos / totalBytes) * 2 * Math.PI - Math.PI / 2 : -Math.PI / 2;
        const [x, y] = polar(cx, cy, r, angle);
        head.setAttribute('cx', x);
        head.setAttribute('cy', y);
    }
    function highlightFile(name) {
        segmentEls.forEach(s => {
            const on = name && s.getAttribute('data-file') === name;
            s.setAttribute('stroke-width', on ? 15 : 11);
        });
    }
    return { element: svg, render, setHead, highlightFile };
}

/* ==================== controller: state shared by the drives and the box ==================== */

function createController(emu) {
    const state = {
        connected: false,
        // {id, label, colour, data (full .mdr Uint8Array), parsed} or null,
        // per drive. `label` is always the name on the tape itself ('' if
        // unformatted), re-read whenever the data changes.
        drives: new Array(DRIVE_COUNT).fill(null),
    };
    const listeners = new Set();
    const notify = () => listeners.forEach(fn => fn());

    const dataOf = (drive) => {
        const d = state.drives[drive];
        if (!d) return null;
        const split = mdr.splitMDRFile(d.data);
        return { blocks: split.blocks, writeProtect: split.writeProtect, blockBytes: split.data };
    };
    const reparse = (drive) => {
        const d = state.drives[drive];
        if (!d) return;
        const { blockBytes, writeProtect } = dataOf(drive);
        d.parsed = mdr.parse(blockBytes, writeProtect);
        d.label = d.parsed.cartridgeName || '';
    };

    function persistDockState() {
        store.setDockState({
            connected: state.connected,
            drives: state.drives.map(d => d ? d.id : null),
        });
    }

    /* The `modified` each stored cartridge had when this tab last read or
     * wrote it, by id: a flush overwrites the stored copy only if no other
     * tab of the emulator has written it since. */
    const known = new Map();

    async function insertRecord(drive, id, record) {
        if (state.drives[drive]) await flushIfDirty(drive); // shouldn't normally be dirty (the core flushes on eject/swap), but don't risk it
        if (id && (record.modified !== undefined)) known.set(id, record.modified);
        const seq = emu.insertMicrodrive(drive, record.data, id);
        state.drives[drive] = { id, seq, colour: record.colour, data: new Uint8Array(record.data) };
        reparse(drive);
        if (id && record.label !== state.drives[drive].label) store.update(id, { label: state.drives[drive].label });
        persistDockState();
        notify();
    }

    async function insertExisting(drive, id) {
        const record = await store.get(id);
        if (!record) return false;
        await insertRecord(drive, id, record);
        return true;
    }

    /* Adds `data` (a full .mdr image) to the box as a new cartridge and
     * inserts it. Used for a new blank cartridge made at a drive, and for
     * an opened or dropped .mdr file the box doesn't have yet. */
    async function insertNew(drive, data, colour) {
        const label = mdr.cartridgeName(data) || '';
        const id = await store.create({ label, colour, data });
        const record = await store.get(id) || { label, colour, data };
        await insertRecord(drive, id || null, record);
        return id;
    }

    /* The id of the cartridge in the box with the same bytes as `data` (a
     * full .mdr image), or null. One in a drive is compared as it is there,
     * with what was saved on it since it went in. Blank cartridges are all
     * alike, so a blank one is never taken for another. */
    async function findInBox(data) {
        if (mdr.cartridgeName(data) === null) return null;
        for (const meta of await store.list()) {
            const drive = driveOf(meta.id);
            const bytes = (drive >= 0) ? state.drives[drive].data : ((await store.get(meta.id)) || {}).data;
            if (bytes && sameBytes(bytes, data)) return meta.id;
        }
        return null;
    }

    /* Puts a cartridge file from the PC in `drive`: the cartridge in the box
     * with the same bytes if there is one, else a new one. One already in
     * the other drive stays there. */
    async function insertImported(drive, data) {
        const id = await findInBox(data);
        if (!id) return insertNew(drive, data);
        const inDrive = driveOf(id);
        if (inDrive < 0) await insertExisting(drive, id);
        else if (inDrive !== drive) alert(`This cartridge is already in drive ${inDrive + 1}.`);
        return id;
    }

    async function eject(drive) {
        emu.ejectMicrodrive(drive);
        state.drives[drive] = null;
        persistDockState();
        notify();
    }

    async function flushIfDirty() {
        // The core/worker do their own flushing on eject and on disconnect;
        // this is a hook point kept for symmetry/future use.
    }

    /* Renames the tape itself; the renamed image comes back through
     * onFlush, which updates the label and the stored copy. */
    function rename(drive, name) {
        if (state.drives[drive]) emu.renameMicrodrive(drive, name);
    }
    // Which drive (or -1) holds the cartridge with this id.
    const driveOf = (id) => state.drives.findIndex(d => d && d.id === id);

    async function setColour(id, colour) {
        await store.update(id, { colour });
        const drive = driveOf(id);
        if (drive >= 0) { state.drives[drive].colour = colour; notify(); }
    }

    /* Deletes a cartridge from the box, ejecting it first if it's in a drive. */
    async function remove(id) {
        const drive = driveOf(id);
        if (drive >= 0) await eject(drive);
        await store.remove(id);
    }
    /* The worker sends the image back with the new flag, which keeps it in
     * the box; until then the copy here shows it, with the flag's byte added
     * to an image that came without one. */
    function setWriteProtect(drive, value) {
        emu.setMicrodriveWriteProtect(drive, value);
        const d = state.drives[drive];
        if (d) {
            const blockBytes = mdr.splitMDRFile(d.data).data;
            const data = new Uint8Array(blockBytes.length + 1);
            data.set(blockBytes);
            data[blockBytes.length] = value ? 1 : 0;
            d.data = data;
            reparse(drive);
        }
        notify();
    }

    /* The format replaces what the cartridge held, so what the drive saved
     * before it, still on its way from the worker, is dropped. */
    async function quickFormat(drive, name) {
        const d = state.drives[drive];
        if (!d) return;
        superseded.add(d.seq);
        const blocks = mdr.splitMDRFile(d.data).blocks;
        const formatted = mdr.quickFormat(blocks, name);
        await insertRecord(drive, d.id, { label: name, colour: d.colour, data: formatted.buffer });
        const id = d.id;
        if (!id) return;
        const label = state.drives[drive].label;
        // in turn with the flushes, which compare against the stamp it leaves
        writes = writes.then(async () => {
            const modified = Date.now();
            if (await store.update(id, { data: formatted.buffer, label, modified })) known.set(id, modified);
        }).catch(err => console.warn(err));
        await writes;
    }

    /* A flush can arrive after its cartridge has left the drive (swapping
     * flushes the old one first), so the drive shows it only if it comes
     * from the insert the drive holds now, and it is stored by token, the
     * cartridge's id in the box, unless a format has replaced it since. The
     * stored copies are written one at a time, in the order the flushes
     * came. */
    let writes = Promise.resolve();
    const superseded = new Set();  // inserts whose later flushes are dropped
    function onFlush(drive, token, dataBuffer, seq) {
        if (superseded.has(seq)) return;
        const d = state.drives[drive];
        if (d && (seq === d.seq)) {
            d.data = new Uint8Array(dataBuffer);
            reparse(drive);
            notify();
        }
        if (token) writes = writes.then(() => keepFlushed(token, dataBuffer)).catch(err => console.warn(err));
    }
    emu.on('microdriveData', onFlush);

    /* Stores a flushed image over its cartridge in the box, unless another
     * tab has saved that cartridge since this one read it: then this image
     * joins the box as a cartridge of its own, and a drive holding it
     * carries on with that one, so neither tab's work is lost. */
    async function keepFlushed(token, dataBuffer) {
        const label = mdr.cartridgeName(dataBuffer) || '';
        const modified = Date.now();
        const result = await store.updateIfUnchanged(token, { data: dataBuffer, label, modified }, known.get(token));
        if (result === 'written') known.set(token, modified);
        if (result !== 'changed') return;
        const drive = driveOf(token);
        const colour = (drive >= 0) ? state.drives[drive].colour : undefined;
        const id = await store.create({ label, colour, data: dataBuffer });
        if (!id) return;
        const record = await store.get(id);
        if (record) known.set(id, record.modified);
        const now = driveOf(token);
        if (now >= 0) {
            state.drives[now].id = id;
            emu.setMicrodriveToken(now, token, id);
            persistDockState();
            notify();
        }
        alert(`The cartridge ${label ? '"' + label + '" ' : ''}was also saved to in another tab of the emulator, so what was saved to it here is kept as a separate cartridge in the box.`);
    }

    async function setConnected(connected) {
        state.connected = connected;
        emu.setInterface1(connected);
        persistDockState();
        notify();
    }
    // The emulator connects the Interface 1 itself for a snapshot taken inside its ROM.
    emu.on('setInterface1', (connected) => {
        if (connected === state.connected) return;
        state.connected = connected;
        persistDockState();
        notify();
    });

    /* Puts the drives back as they were left. A cartridge opened at startup
     * (the openUrl option) has gone in by now, and keeps its drive. */
    async function init() {
        const saved = store.getDockState();
        for (let d = 0; d < DRIVE_COUNT; d++) {
            if (saved.drives[d] && !state.drives[d] && (driveOf(saved.drives[d]) < 0)) await insertExisting(d, saved.drives[d]);
        }
        if (saved.connected) await setConnected(true);
        notify();
    }

    return {
        state, listeners,
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        dataOf, reparse, driveOf, insertExisting, insertNew, insertImported, findInBox, eject, remove, rename, setColour,
        setWriteProtect, quickFormat, setConnected, init,
    };
}

/* ==================== the drive panel ==================== */

/* Opens above a drive when it's clicked and covers everything done with a
 * drive and the cartridge in it. An empty drive offers the cartridges in
 * the box that aren't in a drive, plus a new blank one or one from the PC.
 * A loaded drive shows what's on the tape, formats a blank cartridge,
 * toggles write protection and ejects. Keeping cartridges (names, colours,
 * copies, files on the PC) is the cartridge box's job, which both open with
 * Cartridge box. */
function buildDrivePanel(emu, controller, driveIndex, openBox) {
    const panel = el('div', {
        position: 'absolute', width: '300px', background: '#1c1e22', color: '#eee',
        border: '1px solid #444', borderRadius: '8px', boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
        fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px', zIndex: '120',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
    });
    const footerStyle = {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px',
        borderTop: '1px solid #333', background: '#1a1c20',
    };
    const mkBtn = (icon, label) => {
        const b = el('button', {
            display: 'flex', alignItems: 'center', gap: '4px', border: 'none', background: '#333',
            color: '#ccc', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '11px',
        });
        if (icon) {
            const i = el('span'); i.innerHTML = icon; i.style.filter = 'invert(1)';
            i.firstChild.style.height = '13px'; i.firstChild.style.display = 'block';
            b.appendChild(i);
        }
        b.appendChild(el('span', {}, { textContent: label }));
        return b;
    };
    // Keys typed into a field must not reach the emulator's keyboard handler
    // on the document, which also cancels keypress (and with it the typed
    // character) while the emulator runs.
    const keepKeys = (input) => {
        for (const type of ['keydown', 'keyup', 'keypress']) input.addEventListener(type, (e) => e.stopPropagation());
    };

    const header = el('div', {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px',
        background: '#25282e', borderBottom: '1px solid #333',
    });
    const title = el('div', {
        flex: '1', minWidth: '0', fontSize: '13px', fontWeight: 'bold',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    });
    const wpBtn = el('button', {
        border: 'none', background: '#333', color: '#ccc', borderRadius: '4px',
        padding: '3px 6px', cursor: 'pointer', fontSize: '11px', flexShrink: '0',
    }, { textContent: 'WP' });
    wpBtn.title = 'Write protect';
    const closeBtn = el('button', { border: 'none', background: 'none', cursor: 'pointer', flexShrink: '0' });
    closeBtn.innerHTML = closeIcon;
    closeBtn.style.filter = 'invert(1)';
    closeBtn.firstChild.style.height = '14px';
    closeBtn.title = 'Close';
    header.append(title, wpBtn, closeBtn);

    /* ---------- a loaded drive ---------- */
    // what the drive shows, the one or the other, filling the panel below its header
    const part = { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '0' };
    const loaded = el('div', part);

    const body = el('div', { display: 'flex', gap: '10px', padding: '10px' });
    const ring = buildRing(120);
    ring.element.style.flexShrink = '0';
    ring.element.style.alignSelf = 'flex-start';
    // beside the ring: the files, and under them how many and the room left
    const side = el('div', { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column' });
    const fileList = el('div', { minWidth: '0', maxHeight: '160px', overflowY: 'auto' });
    const tapeInfo = el('div', { flexShrink: '0', paddingTop: '6px', color: '#999', fontSize: '11px' });
    side.append(fileList, tapeInfo);
    body.append(ring.element, side);

    const blankNotice = el('div', { padding: '10px', color: '#ccc', lineHeight: '1.5' });
    const formatRow = el('div', { display: 'flex', gap: '6px', marginTop: '6px' });
    const formatNameInput = el('input', {
        flex: '1', minWidth: '0', padding: '3px 6px', borderRadius: '4px', border: '1px solid #555',
        background: '#111', color: '#fff',
    }, { type: 'text', placeholder: 'Cartridge name', maxLength: 10 });
    keepKeys(formatNameInput);
    const formatBtn = el('button', {
        border: 'none', background: '#3a6', color: '#fff', borderRadius: '4px',
        padding: '4px 10px', cursor: 'pointer',
    }, { textContent: 'Format' });
    formatRow.append(formatNameInput, formatBtn);
    blankNotice.append(
        el('div', {}, { textContent: 'A blank cartridge. Format it to give it a name and use it.' }),
        formatRow,
        el('div', { color: '#888', fontSize: '11px', marginTop: '6px' },
            { textContent: 'In BASIC: FORMAT "m";' + (driveIndex + 1) + ';"name"' }),
    );

    const cmdRow = makeCommandRow(emu);

    const loadedFooter = el('div', footerStyle);
    const ejectBtn = mkBtn(ejectIcon, 'Eject');
    // the cartridge as the drive last saved it, which is the only copy of one the box couldn't keep
    const boxBtn = mkBtn(null, 'Cartridge box…');
    const savePcBtn = mkBtn(null, 'Save to PC');
    savePcBtn.title = 'The cartridge as an .mdr file';
    loadedFooter.append(ejectBtn, boxBtn, savePcBtn);

    loaded.append(body, blankNotice, cmdRow.element, loadedFooter);

    /* ---------- an empty drive ---------- */
    const empty = el('div', part);
    const listHeading = el('div', { padding: '8px 10px 2px', color: '#aaa' });
    const list = el('div', { maxHeight: '180px', overflowY: 'auto', padding: '4px 6px' });
    const emptyFooter = el('div', footerStyle);
    const newBtn = mkBtn(null, 'New blank');
    const pcBtn = mkBtn(openIcon, 'From PC…');
    const emptyBoxBtn = mkBtn(null, 'Cartridge box…');
    const fileInput = el('input', { display: 'none' }, { type: 'file', accept: '.mdr' });
    emptyFooter.append(newBtn, pcBtn, emptyBoxBtn, fileInput);
    empty.append(listHeading, list, emptyFooter);

    panel.append(header, loaded, empty);

    /* ---------- behaviour ---------- */
    let onClose = () => {};
    closeBtn.addEventListener('click', () => onClose());
    ejectBtn.addEventListener('click', () => controller.eject(driveIndex));
    boxBtn.addEventListener('click', () => openBox());
    emptyBoxBtn.addEventListener('click', () => openBox());
    savePcBtn.addEventListener('click', () => {
        const d = controller.state.drives[driveIndex];
        if (d) downloadBytes(d.data, (d.label || 'cartridge').replace(/[^\w-]+/g, '_') + '.mdr', savePcBtn);
    });
    wpBtn.addEventListener('click', () => {
        const d = controller.state.drives[driveIndex];
        if (d) controller.setWriteProtect(driveIndex, !mdr.splitMDRFile(d.data).writeProtect);
    });
    const format = () => {
        if (formatNameInput.value) controller.quickFormat(driveIndex, formatNameInput.value);
    };
    const setFormatEnabled = (enabled) => {
        formatBtn.disabled = !enabled;
        formatBtn.style.opacity = enabled ? '1' : '0.45';
        formatBtn.style.cursor = enabled ? 'pointer' : 'default';
    };
    setFormatEnabled(false);
    formatNameInput.addEventListener('input', () => setFormatEnabled(!!formatNameInput.value));
    formatNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') format(); });
    formatBtn.addEventListener('click', format);
    newBtn.addEventListener('click', () => controller.insertNew(driveIndex, mdr.createBlank(mdr.MAX_BLOCKS)));
    pcBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        const buf = await readFileAsArrayBuffer(file);
        if (!mdr.validateMDRFile(buf)) { alert('Invalid Microdrive cartridge (.mdr) file'); return; }
        controller.insertImported(driveIndex, buf);
    });

    // The selected file is kept by name, so it survives the file list being
    // rebuilt when the tape changes.
    let selectedName = null;
    function selectFile(file) {
        selectedName = file ? file.name : null;
        cmdRow.setCommand(file ? mdr.loadCommand(file, driveIndex) : null);
        ring.highlightFile(selectedName);
        for (const row of fileList.children) row.style.background = (row.dataset.file === selectedName) ? '#2a2d33' : '';
    }
    function renderFiles(parsed) {
        fileList.innerHTML = '';
        if (parsed.files.length === 0) {
            fileList.appendChild(el('div', { color: '#888', padding: '4px 0' }, { textContent: 'No files.' }));
        }
        parsed.files.forEach(file => {
            const row = el('div', { padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', marginBottom: '2px' });
            row.dataset.file = file.name;
            const typeLabel = file.isPrintFile && !file.header ? 'Print file'
                : (file.header ? file.header.typeName : (file.complete ? 'Data file' : 'Incomplete'));
            row.appendChild(el('div', { fontWeight: 'bold', overflowWrap: 'anywhere' }, { textContent: file.name || '(unnamed)' }));
            row.appendChild(el('div', { color: '#999', fontSize: '10px' },
                { textContent: `${typeLabel} · ${file.length} bytes${file.complete ? '' : ' · incomplete'}` }));
            row.addEventListener('mouseenter', () => { row.style.background = '#2a2d33'; ring.highlightFile(file.name); });
            row.addEventListener('mouseleave', () => {
                if (file.name !== selectedName) row.style.background = '';
                ring.highlightFile(selectedName);
            });
            row.addEventListener('click', () => selectFile(file.name === selectedName ? null : file));
            fileList.appendChild(row);
        });
        selectFile(parsed.files.find(f => f.name === selectedName) || null);
    }

    // The empty-drive list reads the box, so it's only rebuilt when what's
    // in the drives changes, not on every refresh.
    let listKey = null;
    let listGeneration = 0;
    async function loadList() {
        const generation = ++listGeneration;
        const inDrives = new Set(controller.state.drives.filter(Boolean).map(d => d.id));
        const cartridges = (await store.list()).filter(meta => !inDrives.has(meta.id));
        if (generation !== listGeneration) return;
        listHeading.textContent = cartridges.length ? 'Insert a cartridge from the box:' : 'No other cartridges in the box.';
        list.style.display = cartridges.length ? 'block' : 'none';
        list.replaceChildren(...cartridges.map(meta => {
            const row = el('div', {
                display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 6px',
                borderRadius: '4px', cursor: 'pointer',
            });
            row.appendChild(el('div', {
                width: '12px', height: '12px', borderRadius: '2px', flexShrink: '0',
                background: meta.colour, border: '1px solid #000',
            }));
            row.appendChild(el('div', {
                flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontWeight: meta.label ? 'bold' : 'normal', fontStyle: meta.label ? 'normal' : 'italic',
                color: meta.label ? '#eee' : '#999',
            }, { textContent: meta.label || 'Blank cartridge' }));
            row.appendChild(el('div', { color: '#777', fontSize: '10px', flexShrink: '0' },
                { textContent: meta.modified ? new Date(meta.modified).toLocaleDateString() : '' }));
            row.addEventListener('mouseenter', () => { row.style.background = '#2a2d33'; });
            row.addEventListener('mouseleave', () => { row.style.background = ''; });
            row.addEventListener('click', () => controller.insertExisting(driveIndex, meta.id));
            return row;
        }));
    }

    function refresh() {
        const d = controller.state.drives[driveIndex];
        loaded.style.display = d ? 'flex' : 'none';
        empty.style.display = d ? 'none' : 'flex';
        wpBtn.style.display = d ? '' : 'none';
        if (!d) {
            title.textContent = `Drive ${driveIndex + 1} is empty`;
            title.style.color = '#ccc';
            title.style.fontStyle = 'normal';
            const key = controller.state.drives.map(x => (x ? x.id : '')).join('|');
            if (key !== listKey) { listKey = key; loadList(); }
            return;
        }
        listKey = null;

        const { blockBytes, writeProtect } = controller.dataOf(driveIndex);
        const parsed = d.parsed || mdr.parse(blockBytes, writeProtect);
        d.parsed = parsed;
        const formatted = parsed.formatted;
        title.textContent = formatted ? (d.label || '(no name)') : 'Blank cartridge';
        title.style.color = formatted ? '#fff' : '#999';
        title.style.fontStyle = formatted ? 'normal' : 'italic';
        wpBtn.style.background = writeProtect ? '#a33' : '#333';
        wpBtn.style.color = writeProtect ? '#fff' : '#ccc';

        body.style.display = formatted ? 'flex' : 'none';
        blankNotice.style.display = formatted ? 'none' : 'block';
        formatNameInput.disabled = writeProtect;
        setFormatEnabled(!writeProtect && !!formatNameInput.value);
        if (formatted) {
            formatNameInput.value = '';
            ring.render(parsed);
            tick();
            renderFiles(parsed);
            const n = parsed.files.length;
            tapeInfo.textContent = `${n} file${n === 1 ? '' : 's'} · ${parsed.freeK}K free`;
        } else {
            cmdRow.setCommand(null);
            tapeInfo.textContent = '';
        }
    }

    // Called on every drive status update: only the head moves.
    function tick() {
        const d = controller.state.drives[driveIndex];
        if (!d || !d.parsed || !d.parsed.formatted) return;
        const headPos = emu.microdriveHeads ? emu.microdriveHeads[driveIndex] : 0;
        ring.setHead(headPos, d.parsed.blocks * mdr.BLOCK_LEN);
    }

    return {
        element: panel, header, refresh, tick,
        // what takes up the height of a resized panel: the tape's files, or the box's cartridges
        stretch: [body, fileList, list],
        dispose() { cmdRow.dispose(); },
        set onClose(fn) { onClose = fn; },
    };
}

/* ==================== the cartridge box ==================== */

/* The box of every cartridge you own, from File > Microdrive cartridges:
 * create, import and export them, and name, colour, copy, save or delete
 * each one. Using a cartridge happens at a drive (see buildDrivePanel). */
function openCartridgeBox(ui, emu, controller) {
    const dialog = openDialog(ui, emu, {
        id: 'cartridgeBox', title: 'Microdrive cartridges',
        subtitle: 'Your cartridge box. To use a cartridge, click an empty Microdrive'
            + (controller.state.connected ? '.' : ' (connect the Microdrives from the toolbar first).'),
        width: 780, height: 580,
    });

    const toolbar = h('div', 'jsd-bar');
    const newBtn = button('New cartridge…', { variant: 'primary', title: 'A blank cartridge, or one formatted with a name' });
    const importBtn = button('Import .mdr…', { icon: openIcon, title: 'A cartridge file from your PC' });
    const spacer = h('div', 'jsd-grow');
    const importBoxBtn = button('Import box…', { title: 'Cartridges from a box saved as a .zip' });
    const exportBoxBtn = button('Save box to PC', { title: 'Every cartridge in the box, as one .zip' });
    const fileInput = h('input', '', { type: 'file', accept: '.mdr' });
    const zipInput = h('input', '', { type: 'file', accept: '.zip' });
    fileInput.style.display = 'none';
    zipInput.style.display = 'none';
    toolbar.append(newBtn, importBtn, spacer, importBoxBtn, exportBoxBtn, fileInput, zipInput);

    const scroll = h('div', 'jsd-scroll');
    const grid = h('div', 'jsd-grid');
    scroll.appendChild(grid);
    dialog.body.append(toolbar, scroll);

    // Rendering awaits storage, so overlapping calls could interleave their
    // cards; each builds off-screen and only the latest one is shown.
    let renderGeneration = 0;
    async function renderGrid() {
        const generation = ++renderGeneration;
        const cards = document.createDocumentFragment();
        const cartridges = await store.list();
        if (cartridges.length === 0) {
            const none = h('div', 'jsd-empty');
            none.style.gridColumn = '1 / -1';
            none.appendChild(h('b', '', { textContent: 'The box is empty' }));
            none.appendChild(document.createTextNode('Create a new cartridge, or import an .mdr file from your PC.'));
            cards.appendChild(none);
        }
        for (const meta of cartridges) {
            // The name is read off the tape itself (the stored label is only
            // a copy, corrected here if it has drifted).
            const record = await store.get(meta.id);
            const name = record ? mdr.cartridgeName(record.data) : null;
            if (record && (name || '') !== meta.label) store.update(meta.id, { label: name || '' });
            const split = record ? mdr.splitMDRFile(record.data) : null;
            const parsed = split ? mdr.parse(split.data, split.writeProtect) : null;
            const writeProtect = split ? split.writeProtect : false;
            const insertedIn = controller.driveOf(meta.id);

            const card = h('div', 'jsd-card' + ((insertedIn >= 0) ? ' current' : ''));
            const top = h('div', 'jsd-card-top');
            const swatch = h('div', 'jsd-swatch', { title: 'Cartridge colour (click to change)' });
            swatch.style.background = meta.colour;
            swatch.addEventListener('click', async () => {
                const i = store.CARTRIDGE_COLOURS.indexOf(meta.colour);
                await controller.setColour(meta.id, store.CARTRIDGE_COLOURS[(i + 1) % store.CARTRIDGE_COLOURS.length]);
                renderGrid();
            });
            const label = h('input', 'jsd-label', {
                value: name || '', maxLength: 10, placeholder: (name === null) ? 'Blank cartridge' : '',
                disabled: (name === null) || writeProtect,
                title: (name === null) ? 'Format it in a drive to name it' : 'Cartridge name (click to change)',
            });
            label.addEventListener('keydown', (e) => { if (e.key === 'Enter') label.blur(); });
            label.addEventListener('change', async () => {
                if (insertedIn >= 0) {
                    controller.rename(insertedIn, label.value);
                } else {
                    const data = new Uint8Array(record.data);
                    mdr.setCartridgeName(mdr.splitMDRFile(data).data, label.value);
                    await store.update(meta.id, { data, label: mdr.cartridgeName(data) || '', modified: Date.now() });
                }
            });
            top.append(swatch, label);
            if (writeProtect) top.appendChild(h('span', 'jsd-badge warn', { textContent: 'Protected', title: 'Write-protected: nothing can be saved on it' }));
            card.appendChild(top);

            if (insertedIn >= 0) {
                const badges = h('div');
                badges.appendChild(h('span', 'jsd-badge accent', { textContent: `In drive ${insertedIn + 1}` }));
                card.appendChild(badges);
            }
            let status;
            if (parsed && parsed.formatted) {
                const n = parsed.files.length;
                status = `${n} file${n === 1 ? '' : 's'}, ${parsed.freeK}K free`;
            } else {
                status = 'Unformatted';
            }
            card.appendChild(h('div', 'jsd-row-meta', { textContent: status }));
            card.appendChild(h('div', 'jsd-faint', { textContent: `Modified ${fmtDate(meta.modified)}` }));

            const actions = h('div', 'jsd-card-actions');
            const saveBtn = button('Save to PC', { small: true, title: 'The cartridge as an .mdr file' });
            saveBtn.addEventListener('click', async () => {
                const record = await store.get(meta.id);
                if (record) downloadBytes(record.data, (record.label || 'cartridge').replace(/[^\w-]+/g, '_') + '.mdr', saveBtn);
            });
            const dupBtn = button('Duplicate', { small: true });
            dupBtn.addEventListener('click', async () => { await store.duplicate(meta.id); renderGrid(); });
            const delBtn = confirmButton('Delete', (insertedIn >= 0) ? 'Eject & delete?' : 'Really delete?',
                () => controller.remove(meta.id).then(renderGrid), { small: true });
            const row = h('div', 'jsd-card-row');
            row.append(saveBtn, dupBtn, h('div', 'jsd-grow'), delBtn);
            actions.appendChild(row);
            card.appendChild(actions);
            cards.appendChild(card);
        }
        if (generation === renderGeneration) {
            grid.replaceChildren(cards);
            dialog.aside.textContent = cartridges.length + (cartridges.length === 1 ? ' cartridge' : ' cartridges');
        }
    }

    // The form for a new cartridge, over the grid while it is open.
    let nameCard = null;
    newBtn.addEventListener('click', () => {
        if (nameCard) {
            nameCard.querySelector('input').focus();
            return;
        }
        nameCard = h('div', 'jsd-panel');
        const nameInput = h('input', 'jsd-input', { placeholder: 'Name (leave blank for an unformatted one)', maxLength: 10 });
        nameInput.style.flex = '1 1 220px';
        const lenSelect = h('select', 'jsd-input');
        lenSelect.appendChild(h('option', '', { value: '254', textContent: 'Standard: 254 sectors, about 127K' }));
        lenSelect.appendChild(h('option', '', { value: '180', textContent: 'Realistic: about 180 sectors, 90K' }));
        const createBtn = button('Create', { variant: 'primary' });
        createBtn.title = 'A named cartridge comes formatted with that name; without one it is blank, like a new cartridge out of the box.';
        const cancelBtn = button('Cancel', { variant: 'ghost' });
        const closeForm = () => {
            nameCard.remove();
            nameCard = null;
        };
        const create = async () => {
            const blocks = parseInt(lenSelect.value, 10);
            const name = nameInput.value;
            const data = name ? mdr.quickFormat(blocks, name) : mdr.createBlank(blocks);
            await store.create({ label: mdr.cartridgeName(data) || '', data: data.buffer });
            closeForm();
            dialog.setStatus(name ? `Created and formatted "${mdr.cartridgeName(data)}".` : 'Created a blank cartridge.', 'ok');
            renderGrid();
        };
        createBtn.addEventListener('click', create);
        cancelBtn.addEventListener('click', closeForm);
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
        nameCard.append(nameInput, lenSelect, createBtn, cancelBtn);
        scroll.insertBefore(nameCard, grid);
        scroll.scrollTop = 0;
        nameInput.focus();
    });

    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        const buf = await readFileAsArrayBuffer(file);
        if (!mdr.validateMDRFile(buf)) {
            dialog.setStatus(file.name + ' is not a Microdrive cartridge (.mdr) file.', 'error');
            return;
        }
        if (await controller.findInBox(buf)) {
            dialog.setStatus('That cartridge is already in the box.', 'ok');
            return;
        }
        await store.create({ label: mdr.cartridgeName(buf) || '', data: buf });
        dialog.setStatus('Imported ' + file.name + '.', 'ok');
        renderGrid();
    });

    exportBoxBtn.addEventListener('click', async () => {
        const zip = new JSZip();
        const manifest = { cartridges: [] };
        for (const meta of await store.list()) {
            const record = await store.get(meta.id);
            const safeName = (record.label || 'cartridge').replace(/[^\w-]+/g, '_') + '_' + meta.id.slice(0, 8) + '.mdr';
            zip.file(safeName, record.data);
            manifest.cartridges.push({ file: safeName, label: record.label, colour: record.colour });
        }
        zip.file('manifest.json', JSON.stringify(manifest, null, 2));
        const blob = await zip.generateAsync({ type: 'blob' });
        downloadBytes(blob, 'jsspeccy-microdrives.zip', exportBoxBtn);
    });

    importBoxBtn.addEventListener('click', () => zipInput.click());
    zipInput.addEventListener('change', async () => {
        const file = zipInput.files[0];
        zipInput.value = '';
        if (!file) return;
        let zip;
        try {
            zip = await JSZip.loadAsync(await readFileAsArrayBuffer(file));
        } catch (e) {
            dialog.setStatus(file.name + ' is not a ZIP file.', 'error');
            return;
        }
        let manifest = null;
        const manifestEntry = zip.file('manifest.json');
        if (manifestEntry) {
            try { manifest = JSON.parse(await manifestEntry.async('string')); } catch (e) { /* ignore: the manifest only adds colours */ }
        }
        const entries = [];
        zip.forEach((path, f) => { if (!f.dir && path.toLowerCase().endsWith('.mdr')) entries.push([path, f]); });
        let added = 0, already = 0;
        for (const [path, f] of entries) {
            const buf = await f.async('arraybuffer');
            if (!mdr.validateMDRFile(buf)) continue;
            if (await controller.findInBox(buf)) { already++; continue; }
            const info = manifest && Array.isArray(manifest.cartridges) && manifest.cartridges.find(c => c.file === path);
            await store.create({ label: mdr.cartridgeName(buf) || '', colour: info && info.colour, data: buf });
            added++;
        }
        const alreadyNote = already ? `, ${already} ${(already === 1) ? 'was' : 'were'} already in the box` : '';
        dialog.setStatus(`Imported ${added} of ${entries.length} cartridge${entries.length === 1 ? '' : 's'} from ${file.name}${alreadyNote}.`, (added || already) ? 'ok' : 'error');
        renderGrid();
    });

    renderGrid();
}

/* ==================== the dock ==================== */

export function createMicrodriveDock(ui, emu) {
    const controller = createController(emu);

    // Sits to the left of the Spectrum with the ribbon plugged in level with
    // the toolbar strip (the keyboard below it is optional, so it is no
    // anchor): drive 1 nearest the Spectrum and joined to it by the ribbon,
    // drive 2 abutting to its left, as with a real daisy chain. The drives
    // together are the body that can be dragged away from there.
    const element = el('div', { position: 'absolute', zIndex: '90', right: '100%', transformOrigin: '100% 0%', display: 'none' });
    const inner = el('div', { display: 'flex', flexDirection: 'row-reverse', alignItems: 'flex-end' });
    element.appendChild(inner);
    const ribbon = buildRibbon();
    inner.appendChild(ribbon.element);
    const body = el('div', { display: 'flex', flexDirection: 'row-reverse', alignItems: 'flex-end' });
    inner.appendChild(body);
    ui.appContainer.appendChild(element);

    // A small "recording light"-style indicator for fullscreen, where the
    // dock itself is hidden but a connected drive can still be spinning.
    const fsIndicator = el('div', {
        position: 'absolute', zIndex: '91', display: 'none', gap: '4px',
        right: '10px', bottom: '10px', pointerEvents: 'none',
    });
    ui.appContainer.appendChild(fsIndicator);

    const icons = [];
    let openPanel = null;
    let openPanelDrive = -1;

    // The panel is anchored by its bottom edge, so whenever its height
    // changes (formatting, ejecting, a file's LOAD line appearing) it is
    // re-placed.
    const panelResize = window.ResizeObserver ? ui.keepObserver(new ResizeObserver(() => positionPanel())) : null;

    function closePanel() {
        if (openPanel) {
            if (panelResize) panelResize.unobserve(openPanel.element);
            openPanel.dispose();
            openPanel.element.remove();
            openPanel = null;
            openPanelDrive = -1;
        }
    }

    function positionPanel() {
        if (!openPanel || openPanel.mover.place()) return;
        // Opens just above the drive it belongs to, left edges aligned, so
        // it's plain which drive it is about. The drive's on-screen box
        // already includes the dock's scale transform.
        const drive = icons[openPanelDrive].element.getBoundingClientRect();
        const container = ui.appContainer.getBoundingClientRect();
        const panelHeight = openPanel.element.offsetHeight || 260;
        const gap = 6;
        openPanel.element.style.left = (drive.left - container.left) + 'px';
        openPanel.element.style.top = (drive.top - container.top - panelHeight - gap) + 'px';
    }

    function openBox() {
        closePanel();
        openCartridgeBox(ui, emu, controller);
    }

    // Clicking a drive opens its panel, empty or not; clicking it again
    // closes it.
    function togglePanel(drive) {
        if (openPanelDrive === drive) { closePanel(); return; }
        closePanel();
        openPanel = buildDrivePanel(emu, controller, drive, openBox);
        openPanel.onClose = closePanel;
        openPanel.mover = makeMovable(openPanel.element, openPanel.header, ui.appContainer, {
            id: 'drive' + (drive + 1), resize: { minWidth: 260, minHeight: 160, stretch: openPanel.stretch }, onReset: positionPanel,
        });
        openPanelDrive = drive;
        ui.appContainer.appendChild(openPanel.element);
        openPanel.refresh();
        positionPanel();
        if (panelResize) panelResize.observe(openPanel.element);
    }

    for (let i = 0; i < DRIVE_COUNT; i++) {
        const icon = buildDriveIcon(i);
        icons.push(icon);
        body.appendChild(icon.element);
        icon.front.addEventListener('click', () => togglePanel(i));
        icon.element.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); icon.setGlow(true); });
        icon.element.addEventListener('dragleave', () => icon.setGlow(false));
        icon.element.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            icon.setGlow(false);
            const file = e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file) return;
            const buf = await readFileAsArrayBuffer(file);
            if (!mdr.validateMDRFile(buf)) { alert('Invalid Microdrive cartridge (.mdr) file'); return; }
            await controller.insertImported(i, buf);
            await controller.setConnected(true);
        });
    }

    let fullscreen = false;
    function applyVisibility() {
        const show = controller.state.connected && !fullscreen;
        element.style.display = show ? 'block' : 'none';
        fsIndicator.style.display = (controller.state.connected && fullscreen) ? 'flex' : 'none';
        if (!show) closePanel();
        ui.makeRoomOnLeft(element);
    }

    function reposition() {
        if (!emu.canvas) return;
        // Scaled about its top-right corner, so the ribbon plug lands
        // RIBBON_PLUG_Y * scale below the dock's top: place that on the
        // toolbar's vertical centre.
        const scale = DOCK_SCALE * (typeof ui.zoom === 'number' ? ui.zoom : 1);
        const bar = ui.toolbar.elem;
        element.style.top = (bar.offsetTop + (bar.offsetHeight / 2) - (RIBBON_PLUG_Y * scale)) + 'px';
        element.style.transform = `scale(${scale})`;
        mover.update();
        if (!mover.dragging()) ui.makeRoomOnLeft(element);
        positionPanel();
    }
    const mover = makeDeviceMovable(body, ribbon.element, { id: 'microdrives', draw: ribbon.draw, onMove: reposition });
    if (window.ResizeObserver) ui.keepObserver(new ResizeObserver(reposition)).observe(ui.appContainer);
    ui.on('setZoom', reposition);
    setTimeout(reposition, 0);

    controller.onChange(() => {
        applyVisibility();
        for (let i = 0; i < DRIVE_COUNT; i++) {
            const d = controller.state.drives[i];
            icons[i].setCartridge(d ? d.colour : null, d ? d.label : '');
        }
        if (openPanel) openPanel.refresh();
        reposition();
    });

    emu.on('microdriveStatus', () => {
        for (let i = 0; i < DRIVE_COUNT; i++) icons[i].setLed(!!(emu.microdriveMotors & (1 << i)));
        fsIndicator.innerHTML = '';
        for (let i = 0; i < DRIVE_COUNT; i++) {
            if (emu.microdriveMotors & (1 << i)) {
                fsIndicator.appendChild(el('div', {
                    width: '10px', height: '10px', borderRadius: '50%', background: '#ff3b30',
                    boxShadow: '0 0 4px #ff3b30',
                }));
            }
        }
        if (openPanel) openPanel.tick();
    });

    // A .mdr opened with nothing else listening (File -> Open, a URL, or a
    // drop straight onto the display rather than onto a specific drive icon)
    // lands here: add it to the box, unless the box has it already, and put
    // it wherever there's room. They go in one at a time, so that two opened
    // together find the drives as the one before left them.
    let opening = Promise.resolve();
    emu.on('microdriveImageOpened', ({ data }) => {
        opening = opening.then(async () => {
            let drive = controller.state.drives.findIndex(d => !d);
            if (drive < 0) drive = 0;
            await controller.insertImported(drive, data);
            await controller.setConnected(true);
        }).catch(err => console.warn('Could not insert the cartridge:', err));
    });

    // Settles once the drives are back as they were left, after any cartridge opened at startup.
    let settleReady;
    const whenReady = new Promise(resolve => { settleReady = resolve; });
    emu.onReady(() => {
        emu.startupOpened.then(() => opening).then(() => controller.init()).catch(() => {}).then(settleReady);
    });

    return {
        element,
        whenReady,
        toggle() { controller.setConnected(!controller.state.connected); },
        isConnected() { return controller.state.connected; },
        // The id of the cartridge in each drive, or null.
        drives() { return controller.state.drives.map(d => (d ? d.id : null)); },
        cartridges() { return store.list(); },

        /* A cartridge's .mdr bytes put in the box without going into a
         * drive, or the cartridge the box has with the same bytes: {id,
         * added}, id null when the box can't keep it. */
        async addToBox(data, colour) {
            const id = await controller.findInBox(data);
            if (id) return { id, added: false };
            const created = await store.create({ label: mdr.cartridgeName(data) || '', colour, data });
            return { id: created, added: !!created };
        },

        /* Puts the box's cartridge `id` in `drive` (0 or 1), unless the
         * drive holds one or the cartridge is in the other drive; resolves
         * to whether it went in. */
        async insertFromBox(drive, id) {
            if (controller.state.drives[drive] || (controller.driveOf(id) >= 0)) return false;
            return controller.insertExisting(drive, id);
        },
        setFullscreen(value) { fullscreen = value; applyVisibility(); },
        openBox,

        /* For a saved session: the whole cartridge box and what is in each
         * drive. `liveDrives` are the drives' images from the snapshot,
         * which may hold writes not flushed to the box yet. Which cartridge
         * is in which drive is taken as it is at the call, before anything
         * is awaited, so it matches the snapshot. A cartridge the box
         * couldn't store is still saved, under a made-up id. */
        async sessionSave(liveDrives) {
            const connected = controller.state.connected;
            // Two drives never share an id in the session, so neither's image stands in for the other's.
            const driveIds = [];
            controller.state.drives.forEach((d, i) => {
                driveIds.push(!d ? null : ((d.id && !driveIds.includes(d.id)) ? d.id : `unsaved-${i}`));
            });
            const driveColours = controller.state.drives.map(d => d ? d.colour : undefined);
            const live = new Map(liveDrives.map(d => [driveIds[d.drive] || `unsaved-${d.drive}`, d.data]));
            const cartridges = [];
            for (const meta of await store.list()) {
                const record = await store.get(meta.id);
                if (!record) continue;
                let data = record.data;
                let modified = record.modified;
                if (live.has(meta.id)) {
                    const newer = live.get(meta.id);
                    if (!sameBytes(newer, data)) {
                        data = newer;
                        modified = Date.now();
                    }
                    live.delete(meta.id);
                }
                cartridges.push({ id: meta.id, label: mdr.cartridgeName(data) || '', colour: record.colour, created: record.created, modified, boxModified: record.modified, data });
            }
            for (const [id, data] of live) {
                const drive = liveDrives.find(d => (driveIds[d.drive] || `unsaved-${d.drive}`) === id).drive;
                cartridges.push({ id, label: mdr.cartridgeName(data) || '', colour: driveColours[drive], modified: Date.now(), data });
            }
            return { connected, drives: driveIds, cartridges };
        },

        /* Restores a saved session's Microdrives. Its cartridges join the
         * box: one the box already holds unchanged is left as it is; one the
         * box holds other work on since the session was saved is added
         * beside it rather than over it (boxCopyMovedOn);
         * any other is stored under its own id. The drives and the
         * connection are then set as they were. Without storage, the
         * session's cartridges still go into the drives. */
        async sessionRestore(session) {
            closePanel();
            for (let d = 0; d < DRIVE_COUNT; d++) {
                if (controller.state.drives[d]) await controller.eject(d);
            }
            // Ejecting flushes what was in the drives; those writes are
            // queued ahead of the session's, which go in under the same ids.
            await emu.barrier();
            const box = [];
            for (const meta of await store.list()) {
                const record = await store.get(meta.id);
                if (record) box.push(record);
            }
            const ids = new Map();       // session id -> id in the box
            const unstored = new Map();  // session id -> cartridge, where storage failed
            // A cartridge in the box stands for one of the session's at most,
            // so two with the same bytes (two blanks) stay two.
            const claimed = new Set();
            const free = (r) => !claimed.has(r.id);
            for (const c of session.cartridges) {
                const sameId = c.id ? box.find(r => r.id === c.id) : null;
                const identical = (sameId && free(sameId) && sameBytes(sameId.data, c.data))
                    ? sameId : box.find(r => free(r) && sameBytes(r.data, c.data));
                if (identical) {
                    ids.set(c.id, identical.id);
                    claimed.add(identical.id);
                    continue;
                }
                const keepBoth = sameId && (!free(sameId) || boxCopyMovedOn(sameId, c));
                const ownId = (c.id && !c.id.startsWith('unsaved-') && !keepBoth) ? c.id : null;
                const id = await store.put({ ...c, id: ownId });
                if (id) {
                    ids.set(c.id, id);
                    claimed.add(id);
                } else {
                    unstored.set(c.id, c);
                }
            }
            for (let d = 0; d < DRIVE_COUNT; d++) {
                const key = session.drives[d];
                if (!key) continue;
                if (ids.has(key)) {
                    await controller.insertExisting(d, ids.get(key));
                } else if (unstored.has(key)) {
                    await controller.insertNew(d, unstored.get(key).data, unstored.get(key).colour);
                }
            }
            await controller.setConnected(!!session.connected);
        },
    };
}

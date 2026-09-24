/*
 * runtime/microdrive-ui.js — the Microdrive dock, label card and cartridge box.
 *
 * createMicrodriveDock(ui, emu) builds a two-drive dock standing to the left
 * of the Spectrum, joined to it by a ribbon (visible = connected: showing it plugs
 * in the Interface 1, hiding it unplugs it, but never ejects a cartridge -
 * see runtime/mdr.js and generator/core.ts.in for why that distinction
 * matters). Clicking a drive opens a "label card": a tape-loop ring plus a
 * CAT-style file list. The cartridge box (File menu, or clicking an empty
 * drive) is a grid over every cartridge saved in runtime/microdrive-store.js,
 * with insert/rename/duplicate/delete/export/import.
 *
 * The core addresses 8 drives; this dock only draws LEDs for drives 1-2
 * (the common case), but the cartridge box can insert into any of the 8, and
 * every one of them is tracked and persisted independently - disconnecting
 * or reloading the page never loses what's in drive 3-8 either.
 */

import JSZip from 'jszip';
import * as mdr from './mdr.js';
import * as store from './microdrive-store.js';

import ejectIcon from './icons/eject.svg';
import openIcon from './icons/open.svg';
import closeIcon from './icons/close.svg';

const DOCKED_DRIVES = 2; // how many of the 8 drives get a physical slot in the dock

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
const DRIVE_W = 66, DRIVE_H = 72;
const DOCK_SCALE = 1.2; // drawn size relative to the display, before the zoom factor
const TOP_Y = 1, STEP_Y = 25, FRONT_Y = 57, BOTTOM_Y = 70;

let driveArtId = 0;

function buildDriveIcon(driveIndex) {
    const W = DRIVE_W, H = DRIVE_H;
    const uid = 'mdart' + (driveArtId++);
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    svg.style.display = 'block';
    svg.style.cursor = 'pointer';
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

    // Front face: a highlight where the deck turns down, then the face.
    svg.appendChild(svgEl('path', {
        d: `M 1 ${FRONT_Y} H ${W - 1} V ${BOTTOM_Y - 3.5} Q ${W - 1} ${BOTTOM_Y} ${W - 4.5} ${BOTTOM_Y} H 4.5 Q 1 ${BOTTOM_Y} 1 ${BOTTOM_Y - 3.5} Z`,
        fill: frontFill,
    }));
    svg.appendChild(svgEl('line', { x1: 1.5, y1: FRONT_Y + 0.4, x2: W - 1.5, y2: FRONT_Y + 0.4, stroke: '#3e4147', 'stroke-width': 0.8 }));

    // Cartridge slot, the cartridge's label end inside it, and the LED.
    const slotX = 23, slotW = 36;
    svg.appendChild(svgEl('rect', { x: slotX, y: FRONT_Y + 3, width: slotW, height: 8.5, rx: 1, fill: '#030303' }));
    svg.appendChild(svgEl('line', { x1: slotX + 0.5, y1: FRONT_Y + 11.8, x2: slotX + slotW - 0.5, y2: FRONT_Y + 11.8, stroke: '#34373c', 'stroke-width': 0.6 }));

    const cart = svgEl('g', { opacity: 0 });
    const cartBody = svgEl('rect', { x: slotX + 3, y: FRONT_Y + 4.5, width: slotW - 6, height: 8.5, rx: 0.8, fill: '#888', stroke: '#000', 'stroke-width': 0.4 });
    const cartLabel = svgEl('rect', { x: slotX + 6, y: FRONT_Y + 6.3, width: slotW - 12, height: 4.2, rx: 0.5, fill: '#e8e8e4' });
    cart.append(cartBody, cartLabel);
    svg.appendChild(cart);

    const led = svgEl('circle', { cx: 7, cy: FRONT_Y + 7.5, r: 1.6, fill: '#3a1210', stroke: '#000', 'stroke-width': 0.4 });
    svg.appendChild(led);
    const number = svgEl('text', {
        x: 14.5, y: FRONT_Y + 9.3, 'text-anchor': 'middle', 'font-size': 5.5, 'font-weight': 'bold',
        'font-family': 'Arial, Helvetica, sans-serif', fill: '#5d6168',
    });
    number.textContent = String(driveIndex + 1);
    svg.appendChild(number);

    return {
        element: svg,
        setLed(on) { led.setAttribute('fill', on ? '#ff3b30' : '#3a1210'); led.style.filter = on ? 'drop-shadow(0 0 2px #ff3b30)' : 'none'; },
        setCartridge(colour) {
            if (colour) {
                cart.setAttribute('opacity', '1');
                cartBody.setAttribute('fill', colour);
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
 * toolbar strip. */
const RIBBON_W = 26;
const RIBBON_Y0 = 11, RIBBON_Y1 = 7, RIBBON_THICK = 9;
const RIBBON_PLUG_Y = RIBBON_Y1 + (RIBBON_THICK / 2);

function buildRibbon() {
    const W = RIBBON_W, H = DRIVE_H;
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    svg.style.display = 'block';
    svg.style.overflow = 'visible';
    const y0 = RIBBON_Y0, y1 = RIBBON_Y1, thick = RIBBON_THICK, plugW = 5;
    const edge = (y) => `M 0 ${y} C ${W * 0.45} ${y + 7} ${W * 0.55} ${y1 - y0 + y + 3} ${W - plugW} ${y1 - y0 + y}`;
    svg.appendChild(svgEl('path', {
        d: `${edge(y0)} L ${W - plugW} ${y1 + thick} C ${W * 0.55} ${y1 + thick + 3} ${W * 0.45} ${y0 + thick + 7} 0 ${y0 + thick} Z`,
        fill: '#9c9ea3', stroke: '#6c6e73', 'stroke-width': 0.5,
    }));
    for (let i = 1; i < 6; i++) {
        svg.appendChild(svgEl('path', { d: edge(y0 + i * thick / 6), fill: 'none', stroke: '#85878c', 'stroke-width': 0.35 }));
    }
    svg.appendChild(svgEl('rect', { x: W - plugW, y: y1 - 1.5, width: plugW, height: thick + 3, rx: 0.8, fill: '#151618', stroke: '#000', 'stroke-width': 0.4 }));
    return svg;
}

/* ==================== the tape-loop ring ==================== */

function buildRing(size) {
    const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
    const cx = size / 2, cy = size / 2, r = size / 2 - 10;
    const track = svgEl('circle', { cx, cy, r, fill: 'none', stroke: '#333', 'stroke-width': 12 });
    svg.appendChild(track);
    const head = svgEl('circle', { cx, cy: cy - r, r: 4, fill: '#fff', stroke: '#000', 'stroke-width': 1 });
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

/* ==================== controller: state shared by the dock and the box ==================== */

function createController(emu) {
    const state = {
        connected: false,
        // {id, label, colour, data (full .mdr Uint8Array), parsed} or null, per drive 0-7
        drives: new Array(8).fill(null),
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
    };

    function persistDockState() {
        store.setDockState({
            connected: state.connected,
            drives: state.drives.map(d => d ? d.id : null),
        });
    }

    async function insertRecord(drive, id, record) {
        if (state.drives[drive]) await flushIfDirty(drive); // shouldn't normally be dirty (the core flushes on eject/swap), but don't risk it
        emu.insertMicrodrive(drive, record.data, id);
        state.drives[drive] = { id, label: record.label, colour: record.colour, data: new Uint8Array(record.data) };
        reparse(drive);
        persistDockState();
        notify();
    }

    async function insertExisting(drive, id) {
        const record = await store.get(id);
        if (!record) return false;
        await insertRecord(drive, id, record);
        return true;
    }

    /* Adds `data` (a full .mdr image) to the library as a new cartridge and
     * inserts it. Used for an opened/dropped .mdr file and for "New
     * cartridge". */
    async function insertNew(drive, data, label, colour) {
        const id = await store.create({ label, colour, data });
        const record = await store.get(id) || { label, colour, data };
        await insertRecord(drive, id || null, record);
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

    async function rename(drive, label) {
        const d = state.drives[drive];
        if (!d) return;
        d.label = label;
        if (d.id) await store.update(d.id, { label });
        notify();
    }
    async function cycleColour(drive) {
        const d = state.drives[drive];
        if (!d) return;
        const i = store.CARTRIDGE_COLOURS.indexOf(d.colour);
        d.colour = store.CARTRIDGE_COLOURS[(i + 1) % store.CARTRIDGE_COLOURS.length];
        if (d.id) await store.update(d.id, { colour: d.colour });
        notify();
    }
    function setWriteProtect(drive, value) {
        emu.setMicrodriveWriteProtect(drive, value);
        // The core is authoritative for this while inserted; our cached copy
        // is only updated on the next flush/re-parse, so just re-derive the
        // in-memory record's flag for the card's immediate feedback.
        const d = state.drives[drive];
        if (d && d.data.length % mdr.BLOCK_LEN === 1) d.data[d.data.length - 1] = value ? 1 : 0;
        notify();
    }

    async function quickFormat(drive, name) {
        const d = state.drives[drive];
        if (!d) return;
        const blocks = mdr.splitMDRFile(d.data).blocks;
        const formatted = mdr.quickFormat(blocks, name);
        await insertRecord(drive, d.id, { label: d.label, colour: d.colour, data: formatted.buffer });
        if (d.id) await store.update(d.id, { data: formatted.buffer, modified: Date.now() });
    }

    function onFlush(drive, token, dataBuffer) {
        const d = state.drives[drive];
        if (!d) return;
        d.data = new Uint8Array(dataBuffer);
        reparse(drive);
        if (d.id) store.update(d.id, { data: dataBuffer, modified: Date.now() });
        notify();
    }
    emu.on('microdriveData', onFlush);

    async function setConnected(connected) {
        state.connected = connected;
        emu.setInterface1(connected);
        persistDockState();
        notify();
    }

    async function init() {
        const saved = store.getDockState();
        for (let d = 0; d < 8; d++) {
            if (saved.drives[d]) await insertExisting(d, saved.drives[d]);
        }
        if (saved.connected) await setConnected(true);
        notify();
    }

    return {
        state, listeners,
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        dataOf, reparse, insertExisting, insertNew, eject, rename, cycleColour,
        setWriteProtect, quickFormat, setConnected, init,
    };
}

/* ==================== the label card ==================== */

function buildCard(ui, emu, controller, driveIndex, onClose) {
    const card = el('div', {
        position: 'absolute', width: '300px', background: '#1c1e22', color: '#eee',
        border: '1px solid #444', borderRadius: '8px', boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
        fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px', zIndex: '120',
        overflow: 'hidden',
    });

    const header = el('div', {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px',
        background: '#25282e', borderBottom: '1px solid #333',
    });
    const swatch = el('div', {
        width: '16px', height: '16px', borderRadius: '3px', cursor: 'pointer', flexShrink: '0',
        border: '1px solid #000',
    });
    swatch.title = 'Cartridge colour';
    const nameInput = el('input', {
        flex: '1', minWidth: '0', background: 'transparent', border: 'none', color: '#fff',
        fontSize: '13px', fontWeight: 'bold', outline: 'none',
    }, { type: 'text' });
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    nameInput.addEventListener('keyup', (e) => e.stopPropagation());
    nameInput.addEventListener('change', () => controller.rename(driveIndex, nameInput.value || 'Untitled'));
    const wpBtn = el('button', {
        border: 'none', background: '#333', color: '#ccc', borderRadius: '4px',
        padding: '3px 6px', cursor: 'pointer', fontSize: '11px', flexShrink: '0',
    }, { textContent: 'WP' });
    wpBtn.title = 'Write protect';
    const closeBtn = el('button', { border: 'none', background: 'none', cursor: 'pointer', flexShrink: '0' });
    closeBtn.innerHTML = closeIcon;
    closeBtn.style.filter = 'invert(1)';
    closeBtn.firstChild.style.height = '14px';
    header.append(swatch, nameInput, wpBtn, closeBtn);

    const body = el('div', { display: 'flex', gap: '10px', padding: '10px' });
    const ring = buildRing(120);
    ring.element.style.flexShrink = '0';
    const fileList = el('div', { flex: '1', minWidth: '0', maxHeight: '160px', overflowY: 'auto' });
    body.append(ring.element, fileList);

    const blankNotice = el('div', { padding: '10px', color: '#ccc', lineHeight: '1.5' });
    const formatRow = el('div', { display: 'flex', gap: '6px', marginTop: '6px' });
    const formatNameInput = el('input', {
        flex: '1', minWidth: '0', padding: '3px 6px', borderRadius: '4px', border: '1px solid #555',
        background: '#111', color: '#fff',
    }, { type: 'text', placeholder: 'Cartridge name', maxLength: 10 });
    formatNameInput.addEventListener('keydown', (e) => e.stopPropagation());
    formatNameInput.addEventListener('keyup', (e) => e.stopPropagation());
    const formatBtn = el('button', {
        border: 'none', background: '#3a6', color: '#fff', borderRadius: '4px',
        padding: '4px 10px', cursor: 'pointer',
    }, { textContent: 'Quick format' });
    formatRow.append(formatNameInput, formatBtn);
    blankNotice.append(
        el('div', {}, { textContent: "This cartridge isn't formatted yet." }),
        el('div', { color: '#888', fontSize: '11px', marginTop: '4px' },
            { textContent: 'Real ZX Spectrum BASIC: FORMAT "m";' + (driveIndex + 1) + ';"name"' }),
        formatRow,
    );

    const cmdRow = el('div', {
        display: 'none', padding: '8px 10px', background: '#111', borderTop: '1px solid #333',
        fontFamily: 'Consolas, Monaco, monospace', fontSize: '12px', alignItems: 'center', gap: '8px',
    });
    const cmdText = el('span', { flex: '1', color: '#8f8', overflowWrap: 'anywhere' });
    const copyBtn = el('button', {
        border: 'none', background: '#333', color: '#ccc', borderRadius: '4px',
        padding: '3px 8px', cursor: 'pointer',
    }, { textContent: 'Copy' });
    copyBtn.addEventListener('click', () => {
        const text = cmdText.textContent;
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
    });
    cmdRow.append(cmdText, copyBtn);

    const footer = el('div', {
        display: 'flex', gap: '6px', padding: '8px 10px', borderTop: '1px solid #333', background: '#1a1c20',
    });
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
    const ejectBtn = mkBtn(ejectIcon, 'Eject');
    const saveBtn = mkBtn(openIcon, 'Save to PC');
    const boxBtn = mkBtn(null, 'Cartridge box…');
    footer.append(ejectBtn, saveBtn, boxBtn);

    card.append(header, body, blankNotice, cmdRow, footer);

    ejectBtn.addEventListener('click', async () => { await controller.eject(driveIndex); onClose(); });
    saveBtn.addEventListener('click', () => {
        const d = controller.state.drives[driveIndex];
        if (!d) return;
        downloadBytes(d.data, (d.label || 'cartridge').replace(/[^\w-]+/g, '_') + '.mdr', saveBtn);
    });
    boxBtn.addEventListener('click', () => { onClose(); openCartridgeBox(ui, emu, controller, driveIndex); });
    swatch.addEventListener('click', () => controller.cycleColour(driveIndex));
    wpBtn.addEventListener('click', () => {
        const d = controller.state.drives[driveIndex];
        if (!d) return;
        const split = mdr.splitMDRFile(d.data);
        controller.setWriteProtect(driveIndex, !split.writeProtect);
        refresh();
    });
    formatBtn.addEventListener('click', async () => {
        await controller.quickFormat(driveIndex, formatNameInput.value || 'UNTITLED');
        refresh();
    });
    closeBtn.addEventListener('click', onClose);

    let selectedFile = null;
    function renderFiles(parsed) {
        fileList.innerHTML = '';
        if (parsed.files.length === 0) {
            fileList.appendChild(el('div', { color: '#888', padding: '4px 0' }, { textContent: 'No files.' }));
        }
        parsed.files.forEach(file => {
            const row = el('div', {
                padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', marginBottom: '2px',
            });
            const typeLabel = file.isPrintFile && !file.header ? 'Print file'
                : (file.header ? file.header.typeName : (file.complete ? 'Data file' : 'Incomplete'));
            row.appendChild(el('div', { fontWeight: 'bold', overflowWrap: 'anywhere' }, { textContent: file.name || '(unnamed)' }));
            row.appendChild(el('div', { color: '#999', fontSize: '10px' },
                { textContent: `${typeLabel} · ${file.length} bytes${file.complete ? '' : ' · incomplete'}` }));
            row.addEventListener('mouseenter', () => { row.style.background = '#2a2d33'; ring.highlightFile(file.name); });
            row.addEventListener('mouseleave', () => { if (selectedFile !== file) row.style.background = ''; ring.highlightFile(selectedFile ? selectedFile.name : null); });
            row.addEventListener('click', () => {
                selectedFile = (selectedFile === file) ? null : file;
                cmdRow.style.display = selectedFile ? 'flex' : 'none';
                if (selectedFile) cmdText.textContent = mdr.loadCommand(file, driveIndex);
                ring.highlightFile(selectedFile ? selectedFile.name : null);
            });
            fileList.appendChild(row);
        });
    }

    function refresh() {
        const d = controller.state.drives[driveIndex];
        if (!d) { onClose(); return; }
        swatch.style.background = d.colour;
        if (document.activeElement !== nameInput) nameInput.value = d.label;
        const { blockBytes, writeProtect } = controller.dataOf(driveIndex);
        const parsed = d.parsed || mdr.parse(blockBytes, writeProtect);
        d.parsed = parsed;
        wpBtn.style.background = writeProtect ? '#a33' : '#333';
        wpBtn.style.color = writeProtect ? '#fff' : '#ccc';

        const formatted = parsed.formatted;
        body.style.display = formatted ? 'flex' : 'none';
        blankNotice.style.display = formatted ? 'none' : 'block';
        if (formatted) {
            ring.render(parsed);
            const motors = emu.microdriveMotors || 0;
            const headPos = emu.microdriveHeads ? emu.microdriveHeads[driveIndex] : 0;
            ring.setHead(headPos, parsed.blocks * mdr.BLOCK_LEN);
            renderFiles(parsed);
        } else {
            cmdRow.style.display = 'none';
        }
    }

    return { element: card, refresh };
}

/* ==================== the cartridge box ==================== */

function openCartridgeBox(ui, emu, controller, preferredDrive) {
    const wasRunning = emu.isRunning;
    emu.pause();
    const body = ui.showDialog();
    body.innerHTML = '';

    const origHideDialog = ui.hideDialog;
    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        delete ui.hideDialog;
        origHideDialog.call(ui);
        if (wasRunning) emu.start();
        emu.focus();
    }
    ui.hideDialog = function () { close(); };

    const root = el('div', { fontFamily: 'Arial, Helvetica, sans-serif', color: '#000' });
    body.appendChild(root);
    root.appendChild(el('h2', { margin: '4px 0 8px 0', fontSize: '18px' }, { textContent: 'Microdrive cartridges' }));
    root.appendChild(el('div', { color: '#666', fontSize: '90%', marginBottom: '8px' }, {
        textContent: 'Drives 1 and 2 show in the dock; drives 3-8 work the same but aren’t displayed there yet.',
    }));

    const toolbar = el('div', { display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' });
    const newBtn = el('button', { padding: '6px 10px' }, { textContent: 'New cartridge…' });
    const importBtn = el('button', { padding: '6px 10px' }, { textContent: 'Import .mdr…' });
    const importBoxBtn = el('button', { padding: '6px 10px' }, { textContent: 'Import box (.zip)…' });
    const exportBoxBtn = el('button', { padding: '6px 10px' }, { textContent: 'Save whole box to PC (.zip)' });
    const fileInput = el('input', { display: 'none' }, { type: 'file', accept: '.mdr' });
    const zipInput = el('input', { display: 'none' }, { type: 'file', accept: '.zip' });
    toolbar.append(newBtn, importBtn, importBoxBtn, exportBoxBtn, fileInput, zipInput);
    root.appendChild(toolbar);

    const grid = el('div', {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px',
    });
    root.appendChild(grid);

    const driveOptions = () => Array.from({ length: 8 }, (_, i) => i);

    async function renderGrid() {
        grid.innerHTML = '';
        const cartridges = await store.list();
        if (cartridges.length === 0) {
            grid.appendChild(el('div', { color: '#666', gridColumn: '1 / -1' }, { textContent: 'No cartridges yet - create or import one.' }));
        }
        for (const meta of cartridges) {
            const card = el('div', {
                border: '1px solid #ccc', borderRadius: '6px', padding: '8px', background: '#fafafa',
            });
            const top = el('div', { display: 'flex', alignItems: 'center', gap: '6px' });
            const swatch = el('div', {
                width: '14px', height: '14px', borderRadius: '3px', background: meta.colour, border: '1px solid #999', flexShrink: '0',
            });
            const label = el('input', { flex: '1', minWidth: '0', border: '1px solid transparent', font: 'inherit', background: 'transparent' }, { value: meta.label });
            label.addEventListener('change', () => store.update(meta.id, { label: label.value || 'Untitled' }));
            top.append(swatch, label);
            card.appendChild(top);
            const insertedIn = controller.state.drives.findIndex(d => d && d.id === meta.id);
            card.appendChild(el('div', { color: '#777', fontSize: '90%', margin: '4px 0' }, {
                textContent: `Modified ${fmtDate(meta.modified)}` + (insertedIn >= 0 ? ` · in drive ${insertedIn + 1}` : ''),
            }));

            const actions = el('div', { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' });
            const driveSelect = el('select', { padding: '2px' });
            driveOptions().forEach(d => driveSelect.appendChild(el('option', {}, { value: d, textContent: 'Drive ' + (d + 1) })));
            if (preferredDrive != null) driveSelect.value = preferredDrive;
            const insertBtn = el('button', {}, { textContent: 'Insert' });
            insertBtn.addEventListener('click', async () => {
                const drive = parseInt(driveSelect.value, 10);
                await controller.insertExisting(drive, meta.id);
                await controller.setConnected(true);
                renderGrid();
            });
            const saveBtn = el('button', {}, { textContent: 'Save to PC' });
            saveBtn.addEventListener('click', async () => {
                const record = await store.get(meta.id);
                if (record) downloadBytes(record.data, (record.label || 'cartridge').replace(/[^\w-]+/g, '_') + '.mdr', saveBtn);
            });
            const dupBtn = el('button', {}, { textContent: 'Duplicate' });
            dupBtn.addEventListener('click', async () => { await store.duplicate(meta.id); renderGrid(); });
            const delBtn = el('button', { color: '#a00' }, { textContent: 'Delete' });
            delBtn.addEventListener('click', () => {
                if (delBtn.dataset.confirm) {
                    store.remove(meta.id).then(renderGrid);
                } else {
                    delBtn.dataset.confirm = '1';
                    delBtn.textContent = 'Really delete?';
                    setTimeout(() => { delBtn.dataset.confirm = ''; delBtn.textContent = 'Delete'; }, 3000);
                }
            });
            actions.append(driveSelect, insertBtn, saveBtn, dupBtn, delBtn);
            card.appendChild(actions);
            grid.appendChild(card);
        }
    }

    newBtn.addEventListener('click', async () => {
        const nameCard = el('div', { padding: '10px', border: '1px solid #ccc', borderRadius: '6px', marginBottom: '10px', background: '#fff' });
        const nameInput = el('input', { marginRight: '6px' }, { placeholder: 'Cartridge name', maxLength: 10 });
        const lenSelect = el('select', { marginRight: '6px' });
        lenSelect.appendChild(el('option', {}, { value: '254', textContent: 'Standard (254 sectors, ~127K)' }));
        lenSelect.appendChild(el('option', {}, { value: '180', textContent: 'Realistic (~180 sectors, ~90K)' }));
        const createBtn = el('button', {}, { textContent: 'Create (blank, unformatted)' });
        createBtn.addEventListener('click', async () => {
            const blocks = parseInt(lenSelect.value, 10);
            const data = mdr.createBlank(blocks);
            await store.create({ label: nameInput.value || 'Untitled', data: data.buffer });
            nameCard.remove();
            renderGrid();
        });
        nameCard.append(nameInput, lenSelect, createBtn);
        root.insertBefore(nameCard, grid);
        nameInput.focus();
    });

    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        const buf = await readFileAsArrayBuffer(file);
        if (!mdr.validateMDRFile(buf)) { alert('Invalid Microdrive cartridge (.mdr) file'); return; }
        await store.create({ label: file.name.replace(/\.mdr$/i, ''), data: buf });
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
        const zip = await JSZip.loadAsync(await readFileAsArrayBuffer(file));
        let manifest = null;
        const manifestEntry = zip.file('manifest.json');
        if (manifestEntry) {
            try { manifest = JSON.parse(await manifestEntry.async('string')); } catch (e) { /* ignore, fall back to filenames */ }
        }
        const entries = [];
        zip.forEach((path, f) => { if (!f.dir && path.toLowerCase().endsWith('.mdr')) entries.push([path, f]); });
        for (const [path, f] of entries) {
            const buf = await f.async('arraybuffer');
            if (!mdr.validateMDRFile(buf)) continue;
            const info = manifest && manifest.cartridges.find(c => c.file === path);
            await store.create({ label: (info && info.label) || path.replace(/\.mdr$/i, ''), colour: info && info.colour, data: buf });
        }
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
    // further drives abutting to its left, as with a real daisy chain.
    const element = el('div', { position: 'absolute', zIndex: '90', right: '100%', transformOrigin: '100% 0%', display: 'none' });
    const inner = el('div', { display: 'flex', flexDirection: 'row-reverse', alignItems: 'flex-end' });
    element.appendChild(inner);
    const ribbon = buildRibbon();
    ribbon.style.pointerEvents = 'none';
    inner.appendChild(ribbon);
    ui.appContainer.appendChild(element);

    // A small "recording light"-style indicator for fullscreen, where the
    // dock itself is hidden but a connected drive can still be spinning.
    const fsIndicator = el('div', {
        position: 'absolute', zIndex: '91', display: 'none', gap: '4px',
        right: '10px', bottom: '10px', pointerEvents: 'none',
    });
    ui.appContainer.appendChild(fsIndicator);

    const icons = [];
    let openCard = null;
    let openCardDrive = -1;

    function closeCard() {
        if (openCard) { openCard.element.remove(); openCard = null; openCardDrive = -1; }
    }

    function positionCard() {
        if (!openCard) return;
        // Opens just above the drive it belongs to, left edges aligned, so
        // it's plain which drive is being edited. The drive's on-screen box
        // already includes the dock's scale transform.
        const drive = icons[openCardDrive].element.getBoundingClientRect();
        const container = ui.appContainer.getBoundingClientRect();
        const cardHeight = openCard.element.offsetHeight || 260;
        const gap = 6;
        openCard.element.style.left = (drive.left - container.left) + 'px';
        openCard.element.style.top = (drive.top - container.top - cardHeight - gap) + 'px';
    }

    function openCardFor(drive) {
        if (openCardDrive === drive) { closeCard(); return; }
        closeCard();
        if (!controller.state.drives[drive]) { openCartridgeBox(ui, emu, controller, drive); return; }
        openCard = buildCard(ui, emu, controller, drive, closeCard);
        openCardDrive = drive;
        ui.appContainer.appendChild(openCard.element);
        openCard.refresh();
        positionCard();
    }

    for (let i = 0; i < DOCKED_DRIVES; i++) {
        const icon = buildDriveIcon(i);
        icons.push(icon);
        inner.appendChild(icon.element);
        icon.element.addEventListener('click', () => openCardFor(i));
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
            await controller.insertNew(i, buf, file.name.replace(/\.mdr$/i, ''));
            await controller.setConnected(true);
        });
    }

    let fullscreen = false;
    function applyVisibility() {
        const show = controller.state.connected && !fullscreen;
        element.style.display = show ? 'block' : 'none';
        fsIndicator.style.display = (controller.state.connected && fullscreen) ? 'flex' : 'none';
        if (!show) closeCard();
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
        positionCard();
    }
    if (window.ResizeObserver) new ResizeObserver(reposition).observe(ui.appContainer);
    ui.on('setZoom', reposition);
    setTimeout(reposition, 0);

    controller.onChange(() => {
        applyVisibility();
        for (let i = 0; i < DOCKED_DRIVES; i++) {
            const d = controller.state.drives[i];
            icons[i].setCartridge(d ? d.colour : null);
        }
        if (openCard) openCard.refresh();
        reposition();
    });

    emu.on('microdriveStatus', () => {
        for (let i = 0; i < DOCKED_DRIVES; i++) icons[i].setLed(!!(emu.microdriveMotors & (1 << i)));
        fsIndicator.innerHTML = '';
        for (let i = 0; i < 8; i++) {
            if (emu.microdriveMotors & (1 << i)) {
                fsIndicator.appendChild(el('div', {
                    width: '10px', height: '10px', borderRadius: '50%', background: '#ff3b30',
                    boxShadow: '0 0 4px #ff3b30',
                }));
            }
        }
        if (openCard) { openCard.refresh(); positionCard(); }
    });

    // A .mdr opened with nothing else listening (File -> Open, a URL, or a
    // drop straight onto the display rather than onto a specific drive icon)
    // lands here: add it to the box and put it wherever there's room.
    emu.on('microdriveImageOpened', async ({ name, data }) => {
        let drive = controller.state.drives.findIndex(d => !d);
        if (drive < 0) drive = 0;
        await controller.insertNew(drive, data, name.replace(/\.mdr$/i, ''));
        await controller.setConnected(true);
    });

    emu.onReady(() => { controller.init(); });

    return {
        element,
        toggle() { controller.setConnected(!controller.state.connected); },
        setFullscreen(value) { fullscreen = value; applyVisibility(); },
        openBox() { openCartridgeBox(ui, emu, controller); },
    };
}

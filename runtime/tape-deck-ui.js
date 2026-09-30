/*
 * runtime/tape-deck-ui.js: the tape recorder, its panel and the cassette box.
 *
 * createTapeDeck(ui, emu) builds a portable cassette recorder standing to
 * the left of the Spectrum, above the Microdrives, joined to it by its EAR
 * and MIC leads. While it is connected, the tape slot is the recorder: an
 * opened tape (File > Open, a dropped file, Find games, PlayZX) goes into it
 * as a pre-recorded cassette, write-protected, and a cassette of your own
 * from the box can be recorded on - SAVE presses Record and Play by itself.
 * Its keys work as a real recorder's do, the reels turn as the tape moves,
 * and the counter counts the seconds along the tape. Disconnecting it keeps
 * your cassette in it, out of reach of SAVE and LOAD, and leaves an opened
 * tape to play as it did before.
 *
 * Clicking the cassette window opens the recorder's panel, which lists
 * what is on the tape, part by part, to wind to, and puts a cassette into an
 * empty recorder. The cassette box (File menu) is where cassettes are kept:
 * a grid over every cassette in runtime/cassette-store.js, to create,
 * import, export, name, colour, duplicate and delete them.
 */

import JSZip from 'jszip';
import * as cassette from './cassette.js';
import * as store from './cassette-store.js';
import { boxCopyMovedOn } from './session.js';
import { DOCK_SCALE, RIBBON_PLUG_Y, RIBBON_W, buildLead } from './microdrive-ui.js';
import { openDialog, h, button, confirmButton } from './dialog.js';
import { makeMovable, makeDeviceMovable } from './movable.js';

import ejectIcon from './icons/eject.svg';
import openIcon from './icons/open.svg';
import closeIcon from './icons/close.svg';

/* ---------- small DOM/SVG helpers (the plain-DOM style of the other docks) ---------- */
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

function colourForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(hash) % 360}, 62%, 56%)`;
}

const fmtDate = (ms) => ms ? new Date(ms).toLocaleString() : '-';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const baseName = (name) => String(name || '').split(/[\\/]/).pop().replace(/\.(tap|tzx|zip)$/i, '');
const safeFileName = (name, fallback) => (String(name || '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || fallback);

// Whether two images hold the same bytes.
function sameBytes(a, b) {
    const x = new Uint8Array(a), y = new Uint8Array(b);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
}

// Triggers a browser download of `bytes` as `filename`, with a brief pulse on `flourishEl`.
function downloadBytes(bytes, filename, flourishEl) {
    const blob = (bytes instanceof Blob) ? bytes : new Blob([bytes], { type: 'application/octet-stream' });
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

const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// A blank C60, as stored.
const blankCassette = () => cassette.writeCassetteTZX({ blocks: [] });

/* A tape file as a cassette for the box: {data, label}, with the data in
 * the form the recorder writes. Throws with a message for the user. */
function cassetteFromFile(buffer, fileName) {
    const parsed = cassette.parseCassetteFile(buffer);
    return {
        data: cassette.writeCassetteTZX({ blocks: parsed.blocks }),
        label: (parsed.label || baseName(fileName)).slice(0, 24),
    };
}

/* ==================== the recorder (dock art) ==================== */

/* The recorder drawn after a portable cassette recorder of the time, in
 * grey plastic: a speaker grille across the top, the cassette door with a
 * window onto the cassette, the tape counter, the record light, and a row
 * of piano keys along the bottom. As wide as the two Microdrives below it. */
const DECK_W = 132, DECK_H = 180;
const DECK_GAP = 4;  // between the recorder and the Microdrives
const DOOR = { x: 8, y: 50, w: 116, h: 76 };  // hinged along its bottom edge
const WIN = { x: 18, y: 61, w: 96, h: 44 };
const HUB_L = { x: 46, y: 86 }, HUB_R = { x: 86, y: 86 };
const HUB_HOLE_R = 7.2;
const PACK_HUB = 6.2, PACK_FULL = 22;  // a pack of tape's radius, empty to full
const KEY_X = 6, KEY_Y = 157, KEY_W = 18.8, KEY_PITCH = 20, KEY_H = 14;
const KEYS = [
    { key: 'record', label: 'Record' },
    { key: 'play', label: 'Play' },
    { key: 'rewind', label: 'Rewind' },
    { key: 'ffwd', label: 'F Fwd' },
    { key: 'stop', label: 'Stop' },
    { key: 'eject', label: 'Eject' },
];
const COUNTER_X = 13.5, COUNTER_Y = 132.5, WHEEL_W = 6.6, WHEEL_PITCH = 7.6, WHEEL_H = 8.5;
const RAINBOW = ['#d0412e', '#e2b13c', '#5fa847', '#3a7cc4'];

// How big a pack of tape is with `fraction` of the tape wound onto it.
const packRadius = (fraction) => Math.sqrt((PACK_HUB * PACK_HUB) + (((PACK_FULL * PACK_FULL) - (PACK_HUB * PACK_HUB)) * clamp(fraction, 0, 1)));

let deckArtId = 0;

function buildDeckArt() {
    const W = DECK_W, H = DECK_H;
    const uid = 'tdart' + (deckArtId++);
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    Object.assign(svg.style, { display: 'block', overflow: 'visible', userSelect: 'none' });

    const defs = svgEl('defs');
    svg.appendChild(defs);
    const grad = (id, stops, x2, y2) => {
        const g = svgEl('linearGradient', { id: uid + id, x1: 0, y1: 0, x2: x2 ?? 0, y2: y2 ?? 1 });
        stops.forEach(([offset, colour]) => g.appendChild(svgEl('stop', { offset, 'stop-color': colour })));
        defs.appendChild(g);
        return `url(#${uid + id})`;
    };
    const bodyFill = grad('body', [[0, '#d6d8da'], [0.55, '#c4c6c9'], [1, '#a8aaad']]);
    const doorFill = grad('door', [[0, '#2a2b2e'], [1, '#141517']]);
    const keyFill = grad('key', [[0, '#3b3c3f'], [1, '#1d1e20']]);
    const keyDownFill = grad('keyd', [[0, '#222325'], [1, '#131415']]);
    const lipFill = grad('lip', [[0, '#a3a5a9'], [1, '#6c6e72']]);
    const glassFill = grad('glass', [[0, 'rgba(255,255,255,0.18)'], [0.45, 'rgba(255,255,255,0.03)'], [1, 'rgba(255,255,255,0.07)']], 1, 1);
    const metalFill = grad('metal', [[0, '#e6e8ea'], [1, '#8a8d91']]);
    const grille = svgEl('pattern', { id: uid + 'g', width: 3.2, height: 3.2, patternUnits: 'userSpaceOnUse' });
    grille.appendChild(svgEl('circle', { cx: 1.6, cy: 1.6, r: 0.85, fill: '#2b2c2e' }));
    defs.appendChild(grille);
    const winClip = svgEl('clipPath', { id: uid + 'w' });
    winClip.appendChild(svgEl('rect', { x: WIN.x, y: WIN.y, width: WIN.w, height: WIN.h }));
    defs.appendChild(winClip);

    // The body, lit from above, and the speaker grille.
    svg.appendChild(svgEl('rect', { x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 5, fill: bodyFill, stroke: '#7b7d80', 'stroke-width': 1 }));
    svg.appendChild(svgEl('line', { x1: 5, y1: 1.4, x2: W - 5, y2: 1.4, stroke: '#f2f3f4', 'stroke-width': 0.8 }));
    svg.appendChild(svgEl('rect', { x: 9, y: 7, width: W - 18, height: 36.8, fill: `url(#${uid}g)` }));

    // Behind the door: the compartment, seen as the door swings open.
    svg.appendChild(svgEl('rect', { x: DOOR.x, y: DOOR.y, width: DOOR.w, height: DOOR.h, rx: 2, fill: '#070708' }));
    svg.appendChild(svgEl('line', { x1: DOOR.x + 2, y1: DOOR.y + 1, x2: DOOR.x + DOOR.w - 2, y2: DOOR.y + 1, stroke: '#3a3b3e', 'stroke-width': 0.8 }));

    const door = svgEl('g', { cursor: 'pointer' });  // a click on the door opens the recorder's panel
    door.appendChild(svgEl('rect', { x: DOOR.x, y: DOOR.y, width: DOOR.w, height: DOOR.h, rx: 2, fill: doorFill, stroke: '#0b0b0c', 'stroke-width': 0.8 }));
    door.appendChild(svgEl('rect', { x: DOOR.x + 2.5, y: DOOR.y + 2.5, width: DOOR.w - 5, height: DOOR.h - 5, rx: 1.5, fill: 'none', stroke: '#8a8c90', 'stroke-width': 0.45 }));
    const brand = svgEl('text', {
        x: 25, y: 57.6, 'font-size': 5.2, 'font-weight': 'bold', 'font-style': 'italic',
        'font-family': 'Arial, Helvetica, sans-serif', fill: '#d8392e',
    });
    brand.textContent = 'JSSpeccy';
    const model = svgEl('text', { x: 52.5, y: 57.6, 'font-size': 4.3, 'font-family': 'Arial, Helvetica, sans-serif', fill: '#e8e8e8' });
    model.textContent = 'DR-60 Data Recorder';
    door.append(brand, model);

    // The window, and what shows through it: the recorder's own spindles
    // and heads when it is empty, otherwise the cassette.
    const view = svgEl('g', { 'clip-path': `url(#${uid}w)` });
    view.appendChild(svgEl('rect', { x: WIN.x, y: WIN.y, width: WIN.w, height: WIN.h, fill: '#08090a' }));
    const inside = svgEl('g');
    inside.appendChild(svgEl('rect', { x: 58, y: 98, width: 16, height: 7, rx: 1, fill: metalFill }));
    inside.appendChild(svgEl('circle', { cx: 50, cy: 101.5, r: 1.2, fill: metalFill }));
    inside.appendChild(svgEl('circle', { cx: 82, cy: 101.5, r: 2.6, fill: '#1c1c1d', stroke: '#333', 'stroke-width': 0.4 }));
    const spindle = (hub) => {
        const g = svgEl('g');
        g.appendChild(svgEl('circle', { cx: hub.x, cy: hub.y, r: 3.2, fill: '#d9d8d2' }));
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * 2 * Math.PI;
            g.appendChild(svgEl('line', {
                x1: hub.x + (2.4 * Math.cos(a)), y1: hub.y + (2.4 * Math.sin(a)),
                x2: hub.x + (4.2 * Math.cos(a)), y2: hub.y + (4.2 * Math.sin(a)),
                stroke: '#d9d8d2', 'stroke-width': 1,
            }));
        }
        g.appendChild(svgEl('circle', { cx: hub.x, cy: hub.y, r: 1, fill: '#555' }));
        return g;
    };
    inside.append(spindle(HUB_L), spindle(HUB_R));
    view.appendChild(inside);

    const cas = svgEl('g');
    const packL = svgEl('circle', { cx: HUB_L.x, cy: HUB_L.y, r: PACK_FULL, fill: '#3c2416', stroke: '#26160c', 'stroke-width': 0.4 });
    const packR = svgEl('circle', { cx: HUB_R.x, cy: HUB_R.y, r: PACK_HUB, fill: '#3c2416', stroke: '#26160c', 'stroke-width': 0.4 });
    cas.append(packL, packR);
    const hole = (hub, r) => `M ${hub.x - r} ${hub.y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
    cas.appendChild(svgEl('path', {
        d: `M 14 63 H 118 V 110 H 14 Z M 55 79 H 77 V 93 H 55 Z ${hole(HUB_L, HUB_HOLE_R)} ${hole(HUB_R, HUB_HOLE_R)}`,
        'fill-rule': 'evenodd', fill: '#2b2c2f',
    }));
    cas.appendChild(svgEl('line', { x1: 14, y1: 63.4, x2: 118, y2: 63.4, stroke: '#4a4b4f', 'stroke-width': 0.6 }));
    cas.appendChild(svgEl('rect', { x: 55, y: 79, width: 22, height: 14, fill: 'none', stroke: '#555', 'stroke-width': 0.4 }));
    // the write-protect tabs' holes, open once the tabs are broken out
    const tabs = svgEl('g', { opacity: 0 });
    tabs.appendChild(svgEl('rect', { x: 22, y: 63, width: 5, height: 2.6, fill: '#050505' }));
    tabs.appendChild(svgEl('rect', { x: 105, y: 63, width: 5, height: 2.6, fill: '#050505' }));
    cas.appendChild(tabs);
    // the label
    const labelTop = svgEl('rect', { x: 20, y: 65.5, width: 92, height: 11.5, rx: 1 });
    const labelBottom = svgEl('rect', { x: 20, y: 95, width: 92, height: 12, rx: 1 });
    const rules = svgEl('g');
    rules.appendChild(svgEl('line', { x1: 30, y1: 74.6, x2: 108, y2: 74.6, stroke: 'rgba(60,60,120,0.25)', 'stroke-width': 0.35 }));
    const side = svgEl('text', { x: 23.5, y: 72.8, 'font-size': 5, 'font-weight': 'bold', 'font-family': 'Arial, Helvetica, sans-serif' });
    side.textContent = 'A';
    const stripes = svgEl('g');
    RAINBOW.forEach((colour, i) => stripes.appendChild(svgEl('rect', { x: 20, y: 99 + (i * 1.5), width: 92, height: 1.5, fill: colour })));
    const title = svgEl('text', { x: 68, y: 73.6, 'text-anchor': 'middle' });
    cas.append(labelTop, labelBottom, rules, stripes, side, title);
    // the reels' hubs, which turn; blurred into discs when turning fast
    const hub = (centre) => {
        const g = svgEl('g');
        const teeth = svgEl('g');
        teeth.appendChild(svgEl('circle', { cx: centre.x, cy: centre.y, r: 5.6, fill: '#e9e5da' }));
        teeth.appendChild(svgEl('circle', { cx: centre.x, cy: centre.y, r: 3.9, fill: '#161616' }));
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * 2 * Math.PI;
            teeth.appendChild(svgEl('line', {
                x1: centre.x + (2.5 * Math.cos(a)), y1: centre.y + (2.5 * Math.sin(a)),
                x2: centre.x + (4.2 * Math.cos(a)), y2: centre.y + (4.2 * Math.sin(a)),
                stroke: '#e9e5da', 'stroke-width': 1.2,
            }));
        }
        const blur = svgEl('circle', { cx: centre.x, cy: centre.y, r: 4.6, fill: '#bdb8ad', opacity: 0 });
        g.append(teeth, blur);
        return { g, teeth, blur };
    };
    const hubL = hub(HUB_L), hubR = hub(HUB_R);
    cas.append(hubL.g, hubR.g);
    view.appendChild(cas);
    view.appendChild(svgEl('rect', { x: WIN.x, y: WIN.y, width: WIN.w, height: WIN.h, fill: glassFill }));
    door.appendChild(view);
    door.appendChild(svgEl('rect', { x: WIN.x, y: WIN.y, width: WIN.w, height: WIN.h, fill: 'none', stroke: '#000', 'stroke-width': 0.8 }));

    // "Auto Stop"
    door.appendChild(svgEl('rect', { x: 40, y: 110.5, width: 34, height: 3.3, fill: '#ececea' }));
    door.appendChild(svgEl('polygon', { points: '74,113.8 97,108.2 97,113.8', fill: '#ececea' }));
    const autoStop = svgEl('text', { x: 57, y: 113.1, 'text-anchor': 'middle', 'font-size': 2.8, 'font-family': 'Arial, Helvetica, sans-serif', fill: '#111' });
    autoStop.textContent = 'Auto Stop';
    door.appendChild(autoStop);
    svg.appendChild(door);

    // The tape counter: four wheels of digits behind a window. A click on it, with the tape standing still, asks where to wind to; with no tape in, says to insert one.
    const counter = svgEl('g', { cursor: 'pointer' });
    // its face, the whole of what shows: the wheels' strips of digits reach far outside their windows
    const counterFace = svgEl('rect', { x: 10, y: 130, width: 36, height: 13.5, rx: 1.5, fill: '#e0e1df', stroke: '#707275', 'stroke-width': 0.6 });
    counter.appendChild(counterFace);
    counter.appendChild(svgEl('rect', { x: 12.5, y: 132, width: 31, height: 9.5, fill: '#f6f6f1', stroke: '#2a2a2a', 'stroke-width': 0.5 }));
    svg.appendChild(counter);
    const wheels = [];
    for (let i = 0; i < 4; i++) {
        const x = COUNTER_X + (i * WHEEL_PITCH);
        const clip = svgEl('clipPath', { id: `${uid}c${i}` });
        clip.appendChild(svgEl('rect', { x, y: COUNTER_Y, width: WHEEL_W, height: WHEEL_H }));
        defs.appendChild(clip);
        const holder = svgEl('g', { 'clip-path': `url(#${uid}c${i})` });
        holder.appendChild(svgEl('rect', { x, y: COUNTER_Y, width: WHEEL_W, height: WHEEL_H, fill: '#fbfbf7' }));
        const strip = svgEl('g');
        for (let d = 0; d <= 10; d++) {
            const t = svgEl('text', {
                x: x + (WHEEL_W / 2), y: COUNTER_Y + 6.9 + (d * WHEEL_H), 'text-anchor': 'middle',
                'font-size': 7.4, 'font-weight': 'bold', 'font-family': 'Consolas, "Courier New", monospace', fill: '#1d1d1d',
            });
            t.textContent = String(d % 10);
            strip.appendChild(t);
        }
        holder.appendChild(strip);
        // shading at the wheel's top and bottom, as it curves away
        holder.appendChild(svgEl('rect', { x, y: COUNTER_Y, width: WHEEL_W, height: 1.6, fill: 'rgba(0,0,0,0.18)' }));
        holder.appendChild(svgEl('rect', { x, y: COUNTER_Y + WHEEL_H - 1.6, width: WHEEL_W, height: 1.6, fill: 'rgba(0,0,0,0.18)' }));
        counter.appendChild(holder);
        wheels.push(strip);
    }

    // The microphone, the record light, the vents.
    svg.appendChild(svgEl('circle', { cx: 58, cy: 136.5, r: 1.3, fill: '#111' }));
    const micLabel = svgEl('text', { x: 66, y: 135.5, 'font-size': 3, 'font-family': 'Arial, Helvetica, sans-serif', fill: '#3a3b3d' });
    micLabel.textContent = 'Condenser Microphone';
    svg.appendChild(micLabel);
    const recLabel = svgEl('text', { x: 97, y: 143.2, 'text-anchor': 'end', 'font-size': 3, 'font-family': 'Arial, Helvetica, sans-serif', fill: '#3a3b3d' });
    recLabel.textContent = 'Record';
    svg.appendChild(recLabel);
    const led = svgEl('circle', { cx: 101, cy: 142.2, r: 1.7, fill: '#3a1210', stroke: '#000', 'stroke-width': 0.4 });
    svg.appendChild(led);
    for (let x = 108; x <= 122; x += 2.4) {
        svg.appendChild(svgEl('line', { x1: x, y1: 129, x2: x, y2: 146.5, stroke: '#8c8e91', 'stroke-width': 1.1 }));
    }

    // The keys, under their names.
    svg.appendChild(svgEl('rect', { x: 5, y: 148, width: W - 10, height: 7, rx: 1, fill: '#1b1c1e' }));
    svg.appendChild(svgEl('rect', { x: 5, y: 155.5, width: W - 10, height: 22, rx: 1, fill: '#0f1011' }));
    const keys = {};
    KEYS.forEach(({ key, label }, i) => {
        const x = KEY_X + (i * KEY_PITCH);
        const name = svgEl('text', {
            x: x + (KEY_W / 2), y: 153.2, 'text-anchor': 'middle', 'font-size': 3.3,
            'font-family': 'Arial, Helvetica, sans-serif', fill: (key === 'record') ? '#ff5144' : '#e6e6e6',
        });
        name.textContent = label;
        svg.appendChild(name);
        const g = svgEl('g', { cursor: 'pointer' });
        const face = svgEl('rect', { x, y: KEY_Y, width: KEY_W, height: KEY_H, rx: 1.2, fill: keyFill });
        const lip = svgEl('rect', { x, y: KEY_Y + KEY_H - 0.5, width: KEY_W, height: 4.8, rx: 1, fill: lipFill });
        g.append(lip, face);
        const cx = x + (KEY_W / 2), cy = KEY_Y + 7;
        const mark = { fill: '#8f9195' };
        const tri = (dx, dir) => svgEl('polygon', { ...mark, points: `${cx + dx - (dir * 2)},${cy - 2.3} ${cx + dx + (dir * 2)},${cy} ${cx + dx - (dir * 2)},${cy + 2.3}` });
        if (key === 'record') g.appendChild(svgEl('circle', { cx, cy, r: 2.7, fill: '#e3281c' }));
        else if (key === 'play') g.appendChild(tri(0.6, 1));
        else if (key === 'rewind') g.append(tri(-1.8, -1), tri(2, -1));
        else if (key === 'ffwd') g.append(tri(-2, 1), tri(1.8, 1));
        else if (key === 'stop') g.appendChild(svgEl('rect', { ...mark, x: cx - 2.1, y: cy - 2.1, width: 4.2, height: 4.2 }));
        else g.append(svgEl('polygon', { ...mark, points: `${cx - 2.6},${cy + 0.6} ${cx},${cy - 2.6} ${cx + 2.6},${cy + 0.6}` }),
            svgEl('rect', { ...mark, x: cx - 2.6, y: cy + 1.5, width: 5.2, height: 1.2 }));
        svg.appendChild(g);
        keys[key] = { g, face, down: false };
    });

    let door0 = -1, lift0 = -1;
    return {
        element: svg,
        door,
        keys,
        counter,
        counterFace,
        // Which keys show down: a Set of names.
        setKeysDown(down) {
            for (const key in keys) {
                const k = keys[key];
                const isDown = down.has(key);
                if (isDown === k.down) continue;
                k.down = isDown;
                k.g.setAttribute('transform', isDown ? 'translate(0 2.4)' : '');
                k.face.setAttribute('fill', isDown ? keyDownFill : keyFill);
            }
        },
        // A key that won't stay down goes half way and springs back.
        bounce(key) {
            const k = keys[key];
            if (!k || !k.g.animate || k.down) return;
            k.g.animate([{ transform: 'translate(0px, 0px)' }, { transform: 'translate(0px, 1.3px)' }, { transform: 'translate(0px, 0px)' }], { duration: 220, easing: 'ease-out' });
        },
        setLed(on) {
            led.setAttribute('fill', on ? '#ff3b30' : '#3a1210');
            led.style.filter = on ? 'drop-shadow(0 0 2px #ff3b30)' : 'none';
        },
        /* The cassette seen through the window: {kind: 'cassette' or 'game',
         * label, colour, writeProtect}, or null for none. */
        setCassette(info) {
            cas.setAttribute('display', info ? 'inline' : 'none');
            inside.setAttribute('display', info ? 'none' : 'inline');
            if (!info) return;
            const game = info.kind === 'game';
            const paper = game ? '#161616' : (info.colour || store.CASSETTE_COLOURS[0]);
            labelTop.setAttribute('fill', paper);
            labelBottom.setAttribute('fill', paper);
            rules.setAttribute('display', game ? 'none' : 'inline');
            stripes.setAttribute('display', game ? 'inline' : 'none');
            side.setAttribute('fill', game ? '#e6e6e6' : '#555');
            tabs.setAttribute('opacity', info.writeProtect ? 1 : 0);
            let text = String(info.label || '');
            if (text.length > 24) text = text.slice(0, 23) + '…';
            title.textContent = text;
            const size = (text.length <= 10) ? 6.4 : ((text.length <= 16) ? 5 : 3.9);
            title.setAttribute('font-size', game ? (size * 0.85) : size);
            title.setAttribute('font-family', game ? '"Arial Black", Arial, Helvetica, sans-serif'
                : '"Segoe Script", "Bradley Hand", "Brush Script MT", "Comic Sans MS", cursive');
            title.setAttribute('font-weight', game ? 'bold' : 'normal');
            title.setAttribute('fill', game ? '#ffffff' : '#1f3a8a');
        },
        /* The door, 0 closed to 1 open, swinging out on its bottom hinge; and
         * the cassette in it, 0 out to 1 seated. */
        setDoor(open, seated) {
            if (open !== door0) {
                door0 = open;
                const hinge = DOOR.y + DOOR.h;
                door.setAttribute('transform', open ? `translate(0 ${hinge}) scale(1 ${1 - (0.16 * open)}) translate(0 ${-hinge})` : '');
            }
            if (seated !== lift0) {
                lift0 = seated;
                cas.setAttribute('transform', (seated < 1) ? `translate(0 ${-16 * (1 - seated)})` : '');
                cas.setAttribute('opacity', seated);
            }
        },
        // The reels turned to these angles (radians), with packs of tape this big.
        setReels(angleL, angleR, radiusL, radiusR, blur) {
            packL.setAttribute('r', radiusL);
            packR.setAttribute('r', radiusR);
            hubL.teeth.setAttribute('transform', `rotate(${angleL * 180 / Math.PI} ${HUB_L.x} ${HUB_L.y})`);
            hubR.teeth.setAttribute('transform', `rotate(${angleR * 180 / Math.PI} ${HUB_R.x} ${HUB_R.y})`);
            hubL.blur.setAttribute('opacity', blur);
            hubR.blur.setAttribute('opacity', blur);
        },
        /* The counter at `seconds`. The last wheel turns over in the last
         * moments of each second, carrying into the wheels before it the way
         * an odometer's do. */
        setCounter(seconds) {
            const v = Math.max(0, seconds);
            const whole = Math.floor(v);
            const roll = clamp(((v - whole) - 0.8) / 0.2, 0, 1);
            let power = 1;
            for (let i = 3; i >= 0; i--) {
                const digit = Math.floor(whole / power) % 10;
                const carrying = (whole % power) === (power - 1);
                const value = digit + (carrying ? roll : 0);
                wheels[i].setAttribute('transform', `translate(0 ${-value * WHEEL_H})`);
                power *= 10;
            }
        },
    };
}

/* The EAR and MIC leads: a grey and a black lead, jacked into sockets on
 * the recorder's side, hanging in a loop down to the side of the Spectrum,
 * above where the Microdrive ribbon goes in. draw(width, dx, dy) lays them
 * across a column `width` wide, from the recorder's side moved by (dx, dy)
 * to the Spectrum's, where their jacks stay put; a wider invisible stroke
 * along each takes the pointer, for the click that puts the recorder
 * back. */
function buildLeads() {
    const svg = svgEl('svg', { width: RIBBON_W, height: DECK_H, viewBox: `0 0 ${RIBBON_W} ${DECK_H}` });
    Object.assign(svg.style, { display: 'block', overflow: 'visible', pointerEvents: 'none' });
    const leads = [];
    const lead = (y0, y1, colour, sheen) => {
        const { g, setPath } = buildLead(colour, sheen, { width: 2.2, shine: 0.5, lift: 0.5 });
        // a jack plug at each end: its body, and the metal tip going in
        const jack = () => {
            const tip = svgEl('rect', { width: 1.8, height: 1.6, fill: '#c9cbce' });
            const shell = svgEl('rect', { width: 5, height: 3.8, rx: 0.8, fill: colour, stroke: '#000', 'stroke-width': 0.3 });
            g.append(tip, shell);
            return (x, tipX, y) => {
                tip.setAttribute('x', tipX);
                tip.setAttribute('y', y - 0.8);
                shell.setAttribute('x', x);
                shell.setAttribute('y', y - 1.9);
            };
        };
        const nearJack = jack();
        const farJack = jack();
        leads.push((width, dx, dy) => {
            const sx = 5 + dx, sy = y0 + dy, ex = width - 5, span = ex - sx;
            setPath(`M ${sx} ${sy} C ${sx + (span * 0.9)} ${sy + 6} ${sx} ${y1 - 30} ${ex} ${y1}`);
            nearJack(dx + 0.6, dx - 1.2, sy);
            farJack(width - 5.6, width - 0.6, y1);
        });
        return g;
    };
    svg.appendChild(lead(26, 118, '#8e9094', '#c3c5c8'));
    svg.appendChild(lead(32, 125, '#161618', '#46464b'));
    function draw(width, dx, dy) {
        svg.setAttribute('width', width);
        svg.setAttribute('viewBox', `0 0 ${width} ${DECK_H}`);
        leads.forEach(l => l(width, dx, dy));
    }
    draw(RIBBON_W, 0, 0);
    return { element: svg, draw };
}

/* ==================== controller: the recorder's state, shared with the box ==================== */

function createController(emu) {
    const state = {
        connected: false,
        /* The cassette of yours in the recorder - or waiting in it while
         * it is disconnected: {id, label, colour, writeProtect}, plus its
         * data and position when it couldn't be stored. */
        cassette: null,
    };
    const listeners = new Set();
    const notify = () => listeners.forEach(fn => fn());
    const persist = () => store.setDeckState({ connected: state.connected, cassette: (state.cassette && state.cassette.id) || null });
    const keepMeta = (record) => ({ id: record.id || null, label: record.label || '', colour: record.colour, writeProtect: !!record.writeProtect });

    /* Each insert has its own number, handed to the worker and back with
     * the cassette's bytes and when it leaves: a late message about an
     * earlier insert, even of the same cassette, is then told apart from one
     * about the cassette in the recorder now. */
    let insertSeq = 0;
    let currentSeq = null;
    const inserting = new Set();  // inserts not yet answered
    let insertsSettled = Promise.resolve();  // resolves once every insert so far is answered

    /* The `modified` each stored cassette had when this tab last read or
     * wrote it, by id: recordings are written over the stored copy only if
     * no other tab of the emulator has written it since. */
    const known = new Map();

    async function insertRecord(record) {
        if (record.id && (record.modified !== undefined)) known.set(record.id, record.modified);
        const previous = { cassette: state.cassette, seq: currentSeq };
        const seq = ++insertSeq;
        currentSeq = seq;
        inserting.add(seq);
        state.cassette = keepMeta(record);
        if (!record.id) {
            state.cassette.data = new Uint8Array(record.data);
            state.cassette.positionMs = record.positionMs || 0;
        }
        persist();
        notify();
        const opening = emu.insertCassette(record.data, { token: record.id || null, seq, positionMs: record.positionMs || 0, writeProtect: record.writeProtect });
        insertsSettled = Promise.all([insertsSettled, opening]).catch(() => {});
        const opened = await opening;
        inserting.delete(seq);
        if (opened && opened.error) {
            alert('Could not put the cassette in: ' + opened.error);
            // the worker kept what it had
            if (currentSeq === seq) {
                state.cassette = previous.cassette;
                currentSeq = previous.seq;
                persist();
            }
        }
        notify();
    }

    /* Connecting and disconnecting take turns: each waits for the one before
     * it, so two quick clicks can't put the cassette in twice. */
    let connecting = Promise.resolve();
    function setConnected(connected, opts) {
        const next = connecting.then(() => applyConnected(connected, opts));
        connecting = next.catch(() => {});
        return next;
    }

    async function applyConnected(connected, opts) {
        if (!connected) {
            // A cassette still on its way in is in the recorder once it lands, so it comes out too.
            await insertsSettled;
            if (emu.tapeKind === 'cassette') {
                emu.ejectTape('parked');
                // What the eject sends back is kept before the box is read again, by a reconnect.
                await emu.barrier();
                await writes;
            }
            state.connected = false;
            emu.setTapeDeck(false);
            persist();
            notify();
            return;
        }
        state.connected = true;
        emu.setTapeDeck(true);
        persist();
        notify();
        if (opts && opts.noInsert) return;
        // Nothing goes in while a tape is on its way in: it is what the recorder will hold.
        const slotFree = () => !emu.tapeKind && !emu.tapeOpening;
        if (slotFree() && state.cassette) {
            // The cassette waiting in the recorder is back in reach.
            const waiting = state.cassette;
            await writes;
            const record = waiting.id ? await store.get(waiting.id) : (waiting.data ? { ...waiting } : null);
            if (!state.connected || (state.cassette !== waiting) || !slotFree()) return;  // things moved on meanwhile
            if (record) {
                await insertRecord(record);
            } else {
                state.cassette = null;
                persist();
                notify();
            }
        } else if (emu.tapeKind === 'game' && state.cassette) {
            // An opened tape is in the recorder; the cassette stays in the box.
            state.cassette = null;
            persist();
            notify();
        }
    }

    async function insertFromBox(id) {
        if (inserting.size) return;
        const record = await store.get(id);
        if (!record) return;
        if (!state.connected) await setConnected(true, { noInsert: true });
        await insertRecord(record);
    }

    /* Tells, once, that the box can't keep cassettes in this browser, so
     * one made here lasts only while it is in the recorder. */
    let storageWarned = false;
    function warnUnstored() {
        if (storageWarned) return;
        storageWarned = true;
        alert('This browser isn’t letting the emulator keep cassettes, so this one lasts only until it is ejected or the page is reloaded. Use Save to PC in the recorder’s window to keep what you record on it.');
    }

    /* Adds a cassette to the box and puts it in the recorder: a new blank
     * one, or a tape file from the PC. */
    async function insertNew(data, label, colour) {
        if (inserting.size) return null;
        const id = await store.create({ label, colour, data, positionMs: 0 });
        if (!id) warnUnstored();
        const record = (id && await store.get(id)) || { id: null, label, colour, data, positionMs: 0 };
        if (!state.connected) await setConnected(true, { noInsert: true });
        await insertRecord(record);
        return id;
    }

    /* The bytes of the cassette of yours in the recorder as they are now,
     * recordings not yet kept included; null if none is in. */
    async function currentData() {
        if (emu.tapeKind !== 'cassette' || !state.cassette) return null;
        emu.flushCassette();
        await emu.barrier();
        if (!state.cassette) return null;
        if (!state.cassette.id) return state.cassette.data || null;
        const record = await store.get(state.cassette.id);
        return record ? record.data : null;
    }

    function eject() {
        if (emu.tapeKind) emu.ejectTape('eject');
    }

    const inRecorder = (id) => !!(state.cassette && id && state.cassette.id === id && (emu.tapeKind === 'cassette'));

    async function rename(id, label) {
        await store.update(id, { label });
        if (state.cassette && state.cassette.id === id) {
            state.cassette.label = label;
            notify();
        }
    }

    async function setColour(id, colour) {
        await store.update(id, { colour });
        if (state.cassette && state.cassette.id === id) {
            state.cassette.colour = colour;
            notify();
        }
    }

    async function setWriteProtect(id, value) {
        if (inRecorder(id) || (state.cassette && !state.cassette.id && !id)) emu.setCassetteWriteProtect(value);
        if (id) await store.update(id, { writeProtect: value });
        if (state.cassette && state.cassette.id === id) {
            state.cassette.writeProtect = value;
            notify();
        }
    }

    // Deletes a cassette from the box, taking it out of the recorder first.
    async function remove(id) {
        if (state.cassette && state.cassette.id === id) {
            if (inRecorder(id)) emu.ejectTape('eject');
            state.cassette = null;
            persist();
            await emu.barrier();
        }
        await store.remove(id);
        notify();
    }

    /* After recording, the cassette's bytes come back to be kept. They are
     * matched by token, so a late one after the cassette was swapped still
     * lands on the right record; one that couldn't be stored is matched by
     * its insert. */
    const isCurrent = (seq) => (seq !== null) && (seq === currentSeq);
    let writes = Promise.resolve();  // recordings are kept one at a time, in the order they came
    emu.on('cassetteData', ({ token, seq, data, positionMs, writeProtect }) => {
        if (token) {
            writes = writes.then(() => keepRecording(token, seq, data, positionMs, writeProtect)).then(notify, err => console.warn(err));
        } else if (isCurrent(seq) && state.cassette && !state.cassette.id) {
            state.cassette.data = new Uint8Array(data);
            state.cassette.positionMs = positionMs;
        }
    });

    /* Stores a cassette's bytes over it in the box, unless another tab has
     * recorded on it since this one read it: then these bytes join the box
     * as a cassette of their own, and the recorder, if it still holds this
     * one, carries on with that, so neither tab's recordings are lost. */
    async function keepRecording(token, seq, data, positionMs, writeProtect) {
        const modified = Date.now();
        const result = await store.updateIfUnchanged(token, { data, positionMs, writeProtect, modified }, known.get(token));
        if (result === 'written') known.set(token, modified);
        if (result !== 'changed') return;
        const original = await store.get(token);
        const label = ((original && original.label) || 'Cassette') + ' (copy)';
        const id = await store.create({ label, colour: original && original.colour, data, positionMs, writeProtect });
        if (!id) return;
        const record = await store.get(id);
        if (record) known.set(id, record.modified);
        if (isCurrent(seq) && state.cassette && (state.cassette.id === token)) {
            state.cassette.id = id;
            state.cassette.label = label;
            emu.setCassetteToken(seq, id);
            persist();
        }
        alert(`The cassette ${(original && original.label) ? '"' + original.label + '" ' : ''}was also recorded on in another tab of the emulator, so what was recorded on it here is kept as a separate cassette in the box, "${label}".`);
    }

    emu.on('cassetteEjected', ({ token, seq, positionMs, reason }) => {
        if (token) {
            // after the recording the worker sent ahead of it
            writes = writes.then(() => store.update(token, { positionMs })).then(notify, err => console.warn(err));
        } else if (isCurrent(seq) && state.cassette && !state.cassette.id) {
            state.cassette.positionMs = positionMs;
        }
        if (isCurrent(seq)) {
            currentSeq = null;
            if (reason !== 'parked') {
                state.cassette = null;
                persist();
            }
        }
        notify();
    });

    /* The tape's position is kept with the cassette whenever it comes to
     * rest somewhere new: after the keys come up, or after an instant LOAD
     * has moved it on. */
    let kept = { id: null, positionMs: 0 };
    emu.on('tapeDeckStatus', (s) => {
        if (s.kind !== 'cassette' || s.mode !== 'stop' || !state.cassette || !state.cassette.id) return;
        if ((kept.id === state.cassette.id) && (Math.abs(s.positionMs - kept.positionMs) < 250)) return;
        kept = { id: state.cassette.id, positionMs: s.positionMs };
        store.update(kept.id, { positionMs: s.positionMs });
    });

    /* Puts the recorder back as it was left. A tape opened at startup (the
     * openUrl option) goes in first, and keeps its place in the recorder. */
    async function init() {
        await emu.startupOpened;
        const saved = store.getDeckState();
        if (saved.cassette) {
            const record = await store.get(saved.cassette);
            if (record && !state.cassette) state.cassette = keepMeta(record);
        }
        if (saved.connected) await setConnected(true);
        else notify();
    }

    return {
        state,
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        busy: () => inserting.size > 0,
        notify, persist, keepMeta, insertRecord, setConnected, insertFromBox, insertNew, eject, inRecorder,
        rename, setColour, setWriteProtect, remove, init, currentData, warnUnstored,
    };
}

/* ==================== the recorder's panel ==================== */

/* Opens beside the recorder when its window is clicked. With a tape in, it
 * shows what is on it: a map of the whole tape and a list of the parts on
 * it, each at its place on the counter, to wind to; for one of your own
 * cassettes, where the blank tape after them starts, and the LOAD that
 * reads a part back. An empty recorder offers the cassettes in the box, a
 * new blank one, or a tape file from the PC. */
function buildPanel(emu, controller, openBox) {
    const panel = el('div', {
        position: 'absolute', width: '300px', background: '#1c1e22', color: '#eee',
        border: '1px solid #444', borderRadius: '8px', boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
        fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px', zIndex: '120', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
    });
    const footerStyle = {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px',
        borderTop: '1px solid #333', background: '#1a1c20',
    };
    const mkBtn = (icon, label) => {
        const b = el('button', {
            display: 'flex', alignItems: 'center', gap: '4px', border: 'none', background: '#333',
            color: '#ccc', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '11px', whiteSpace: 'nowrap',
        });
        if (icon) {
            const i = el('span'); i.innerHTML = icon; i.style.filter = 'invert(1)';
            i.firstChild.style.height = '13px'; i.firstChild.style.display = 'block';
            b.appendChild(i);
        }
        b.appendChild(el('span', {}, { textContent: label }));
        return b;
    };
    // Keys typed into a field must not reach the emulator's keyboard handler.
    const keepKeys = (input) => {
        for (const type of ['keydown', 'keyup', 'keypress']) input.addEventListener(type, (e) => e.stopPropagation());
    };

    /* ---------- header ---------- */
    const header = el('div', {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px',
        background: '#25282e', borderBottom: '1px solid #333',
    });
    const swatch = el('div', {
        width: '14px', height: '14px', borderRadius: '3px', border: '1px solid #000', flexShrink: '0', cursor: 'pointer',
    }, { title: 'Label colour (click to change)' });
    swatch.dataset.noDrag = '';  // a click, not a hold on the title bar (see movable.js)
    const title = el('div', {
        flex: '0 1 auto', minWidth: '0', fontSize: '13px', fontWeight: 'bold',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    });
    // As wide as the label, so the rest of the title bar is left to drag the panel by.
    const nameInput = el('input', {
        flex: '0 1 auto', minWidth: '0', fontSize: '13px', fontWeight: 'bold', color: '#fff', background: 'transparent',
        border: '1px solid transparent', borderRadius: '3px', padding: '1px 3px', font: 'inherit',
    }, { type: 'text', maxLength: 24, placeholder: 'Unnamed cassette', title: 'Cassette label (click to change)' });
    nameInput.style.fontWeight = 'bold';
    const fitName = () => { nameInput.size = Math.max(3, (nameInput.value || nameInput.placeholder).length); };
    keepKeys(nameInput);
    nameInput.addEventListener('input', fitName);
    nameInput.addEventListener('focus', () => { nameInput.style.border = '1px solid #555'; nameInput.style.background = '#111'; });
    nameInput.addEventListener('blur', () => { nameInput.style.border = '1px solid transparent'; nameInput.style.background = 'transparent'; });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
    const spacer = el('div', { flex: '1', alignSelf: 'stretch' });
    const wpBtn = el('button', {
        border: 'none', background: '#333', color: '#ccc', borderRadius: '4px',
        padding: '3px 6px', cursor: 'pointer', fontSize: '11px', flexShrink: '0',
    }, { textContent: 'WP' });
    const closeBtn = el('button', { border: 'none', background: 'none', cursor: 'pointer', flexShrink: '0' });
    closeBtn.innerHTML = closeIcon;
    closeBtn.style.filter = 'invert(1)';
    closeBtn.firstChild.style.height = '14px';
    closeBtn.title = 'Close';
    header.append(swatch, title, nameInput, spacer, wpBtn, closeBtn);

    /* ---------- a tape in the recorder ---------- */
    // what the recorder shows, the one or the other, filling the panel below its header
    const part = { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '0' };
    const loaded = el('div', part);
    // the map is as wide as the panel, less its margins (see fitMap)
    const MAP_H = 26;
    let mapW = 278;
    const map = svgEl('svg', { width: mapW, height: MAP_H, viewBox: `0 0 ${mapW} ${MAP_H}` });
    Object.assign(map.style, { display: 'block', margin: '8px 10px 2px', cursor: 'pointer' });
    const mapDefs = svgEl('defs');
    const hatch = svgEl('pattern', { id: 'tdhatch', width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.appendChild(svgEl('rect', { width: 4, height: 4, fill: '#7a1f1f' }));
    hatch.appendChild(svgEl('rect', { width: 2, height: 4, fill: '#c44' }));
    mapDefs.appendChild(hatch);
    map.appendChild(mapDefs);
    const mapTrack = svgEl('rect', { x: 0, y: 4, width: mapW, height: 12, rx: 2, fill: '#101113', stroke: '#333', 'stroke-width': 1 });
    map.appendChild(mapTrack);
    const mapParts = svgEl('g');
    const mapTicks = svgEl('g');
    const headMark = svgEl('g');
    headMark.appendChild(svgEl('line', { x1: 0, y1: 2, x2: 0, y2: 18, stroke: '#fff', 'stroke-width': 1.5 }));
    headMark.appendChild(svgEl('polygon', { points: '-3,0 3,0 0,3.5', fill: '#fff' }));
    map.append(mapParts, mapTicks, headMark);
    const mapLegend = el('div', { display: 'flex', justifyContent: 'space-between', color: '#777', fontSize: '10px', padding: '0 10px' });

    const list = el('div', { maxHeight: '170px', overflowY: 'auto', padding: '4px 6px' });

    const cmdRow = el('div', {
        display: 'none', padding: '8px 10px', background: '#111', borderTop: '1px solid #333',
        fontFamily: 'Consolas, Monaco, monospace', fontSize: '12px', alignItems: 'center', gap: '8px',
    });
    const cmdText = el('span', { flex: '1', color: '#8f8', overflowWrap: 'anywhere' });
    const copyBtn = el('button', {
        border: 'none', background: '#333', color: '#ccc', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer',
    }, { textContent: 'Copy' });
    copyBtn.addEventListener('click', () => {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cmdText.textContent).catch(() => {});
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
    });
    cmdRow.append(cmdText, copyBtn);

    const notice = el('div', {
        display: 'none', padding: '8px 10px', background: '#2b2618', borderTop: '1px solid #333',
        color: '#e8d9a8', lineHeight: '1.4', alignItems: 'center', gap: '8px',
    });
    const noticeText = el('span', { flex: '1' });
    const undoBtn = el('button', {
        border: 'none', background: '#554a2a', color: '#fff', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer',
    }, { textContent: 'Undo' });
    notice.append(noticeText, undoBtn);

    const loadedFooter = el('div', footerStyle);
    const ejectBtn = mkBtn(ejectIcon, 'Eject');
    const boxBtn = mkBtn(null, 'Cassette box…');
    const saveBtn = mkBtn(null, 'Save to PC');
    saveBtn.title = 'The whole cassette as a .tzx file, every recording at its place on the tape';
    loadedFooter.append(ejectBtn, boxBtn, saveBtn);
    loaded.append(map, mapLegend, list, cmdRow, notice, loadedFooter);

    /* ---------- an empty recorder ---------- */
    const empty = el('div', part);
    const listHeading = el('div', { padding: '8px 10px 2px', color: '#aaa' });
    const boxList = el('div', { maxHeight: '180px', overflowY: 'auto', padding: '4px 6px' });
    const emptyFooter = el('div', footerStyle);
    const newBtn = mkBtn(null, 'New blank C60');
    const pcBtn = mkBtn(openIcon, 'From PC…');
    const fileInput = el('input', { display: 'none' }, { type: 'file', accept: '.tap,.tzx' });
    emptyFooter.append(newBtn, pcBtn, fileInput);
    empty.append(listHeading, boxList, emptyFooter);

    panel.append(header, loaded, empty);

    /* ---------- behaviour ---------- */
    let onClose = () => {};
    let hint = null;  // {kind: 'recordedOver', names, canUndo}
    closeBtn.addEventListener('click', () => onClose());
    ejectBtn.addEventListener('click', () => { controller.eject(); emu.focus(); });
    boxBtn.addEventListener('click', () => openBox());
    saveBtn.addEventListener('click', async () => {
        const c = own();
        const data = c && await controller.currentData();
        if (data) downloadBytes(cassette.relabel(data, c.label), safeFileName(c.label, 'cassette') + '.tzx', saveBtn);
    });
    const own = () => (emu.tapeKind === 'cassette') && controller.state.cassette;
    wpBtn.addEventListener('click', () => {
        const c = own();
        if (c) controller.setWriteProtect(c.id, !c.writeProtect);
    });
    swatch.addEventListener('click', () => {
        const c = own();
        if (!c || !c.id) return;
        const i = store.CASSETTE_COLOURS.indexOf(c.colour);
        controller.setColour(c.id, store.CASSETTE_COLOURS[(i + 1) % store.CASSETTE_COLOURS.length]);
    });
    nameInput.addEventListener('change', () => {
        const c = own();
        if (c && c.id) controller.rename(c.id, nameInput.value.trim());
    });
    undoBtn.addEventListener('click', () => {
        emu.undoCassetteRecording();
        hint = null;
        refresh();
    });
    newBtn.addEventListener('click', () => controller.insertNew(blankCassette(), '', undefined));
    pcBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        try {
            const { data, label } = cassetteFromFile(await readFileAsArrayBuffer(file), file.name);
            await controller.insertNew(data, label, undefined);
        } catch (err) {
            alert((err && err.message) || err);
        }
    });
    map.addEventListener('click', (e) => {
        const lengthMs = emu.tapeLengthMs;
        if (!emu.tapeKind || !lengthMs || justLoaded()) return;
        const box = map.getBoundingClientRect();
        emu.windTape(clamp((e.clientX - box.left) / box.width, 0, 1) * lengthMs);
        emu.focus();
    });

    // The selected part is kept by where it starts, so it survives the list being rebuilt.
    let selectedStart = null;
    function selectPart(part) {
        selectedStart = part ? part.startMs : null;
        const command = part && part.loadCommand;
        cmdRow.style.display = command ? 'flex' : 'none';
        if (command) cmdText.textContent = command;
        for (const row of list.children) row.style.background = (row.dataset.start === String(selectedStart)) ? '#2a2d33' : '';
    }

    function renderMap(segments, lengthMs, blankFrom, isOwn) {
        mapParts.replaceChildren();
        mapTicks.replaceChildren();
        for (const seg of segments) {
            const x = (seg.startMs / lengthMs) * mapW;
            const w = Math.max(1.5, (seg.durationMs / lengthMs) * mapW);
            const r = svgEl('rect', {
                x, y: 5, width: w, height: 10, rx: 1,
                fill: seg.damaged ? 'url(#tdhatch)' : colourForName(seg.name || seg.typeName || seg.label || ''),
            });
            const tip = svgEl('title');
            tip.textContent = `${cassette.counterText(seg.startMs)}  ${seg.name || seg.typeName || seg.label}`;
            r.appendChild(tip);
            mapParts.appendChild(r);
        }
        const minutes = lengthMs / 60000;
        const step = (minutes >= 30) ? 5 : 1;
        for (let m = step; m < minutes; m += step) {
            const x = (m / minutes) * mapW;
            mapTicks.appendChild(svgEl('line', { x1: x, y1: 17, x2: x, y2: (m % (step * 2)) ? 19 : 21, stroke: '#555', 'stroke-width': 1 }));
        }
        mapLegend.replaceChildren(
            el('span', {}, { textContent: '0000' }),
            el('span', {}, { textContent: `${segments.length} part${segments.length === 1 ? '' : 's'}` + (isOwn ? `, blank from ${cassette.counterText(blankFrom)}` : '') }),
            el('span', {}, { textContent: `${Math.round(minutes)} min` }),
        );
    }

    function renderList(segments, isOwn) {
        list.replaceChildren();
        const row = (counterMs, name, detail, damaged) => {
            const r = el('div', {
                display: 'flex', gap: '8px', alignItems: 'baseline', padding: '4px 6px', borderRadius: '4px',
                cursor: 'pointer', marginBottom: '2px', borderLeft: '3px solid transparent',
            });
            r.appendChild(el('span', { fontFamily: 'Consolas, Monaco, monospace', color: '#8cf', flexShrink: '0' },
                { textContent: cassette.counterText(counterMs) }));
            const text = el('div', { flex: '1', minWidth: '0' });
            text.appendChild(el('div', { fontWeight: 'bold', overflowWrap: 'anywhere' }, { textContent: name }));
            const line = el('div', { color: '#999', fontSize: '10px' }, { textContent: detail });
            if (damaged) line.appendChild(el('span', { color: '#f77' }, { textContent: ' · damaged' }));
            text.appendChild(line);
            r.appendChild(text);
            r.addEventListener('mouseenter', () => { if (r.dataset.start !== String(selectedStart)) r.style.background = '#25282d'; });
            r.addEventListener('mouseleave', () => { if (r.dataset.start !== String(selectedStart)) r.style.background = ''; });
            list.appendChild(r);
            return r;
        };
        if (!segments.length) {
            list.appendChild(el('div', { color: '#888', padding: '4px 6px' }, { textContent: isOwn ? 'Nothing recorded yet.' : 'Nothing on this tape.' }));
        }
        segments.forEach((seg) => {
            const size = (seg.length !== undefined) ? `${seg.length} bytes` : `${Math.round((seg.bytes || 0) / 1024)}K`;
            const seconds = `${Math.max(1, Math.round(seg.durationMs / 1000))} s`;
            const detail = (isOwn && !seg.sound) ? `${seg.typeName} · ${size} · ${seconds}` : seconds;
            const name = seg.sound ? seg.typeName : (isOwn ? (seg.name || '(no name)') : (seg.name || seg.label.split('  @')[0]));
            const r = row(seg.startMs, name, detail, seg.damaged);
            r.dataset.start = String(seg.startMs);
            r.dataset.end = String(seg.startMs + seg.durationMs);
            r.addEventListener('click', () => {
                if (justLoaded()) return;
                selectPart(seg);
                // A game tape's part is loaded as the toolbar's counter does it.
                if (isOwn) emu.windTape(seg.startMs); else emu.seekTape(seg.index, false, seg.startMs);
                emu.focus();
            });
        });
        if (isOwn) {
            const blankFrom = emu.tapeBlankFromMs;
            const target = segments.length ? Math.min(emu.tapeLengthMs, blankFrom + 1000) : 0;
            const r = row(target, 'Blank tape', `to ${cassette.counterText(emu.tapeLengthMs)}` + (segments.length ? ' · wind here to SAVE after the rest' : ''), false);
            r.firstChild.nextSibling.firstChild.style.fontWeight = 'normal';
            r.firstChild.nextSibling.firstChild.style.fontStyle = 'italic';
            r.dataset.start = 'blank';
            r.addEventListener('click', () => { if (justLoaded()) return; selectPart(null); emu.windTape(target); emu.focus(); });
        }
        selectPart(segments.find(s => s.startMs === selectedStart) || null);
    }

    // The empty recorder's list reads the box, so it's only rebuilt when asked.
    let listGeneration = 0;
    async function loadBoxList() {
        const generation = ++listGeneration;
        const cassettes = await store.list();
        if (generation !== listGeneration) return;
        listHeading.textContent = cassettes.length ? 'Put in a cassette from the box:' : 'No cassettes in the box yet.';
        boxList.style.display = cassettes.length ? 'block' : 'none';
        boxList.replaceChildren(...cassettes.map(meta => {
            const r = el('div', {
                display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 6px', borderRadius: '4px', cursor: 'pointer',
            });
            r.appendChild(el('div', { width: '12px', height: '12px', borderRadius: '2px', flexShrink: '0', background: meta.colour, border: '1px solid #000' }));
            r.appendChild(el('div', {
                flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontWeight: meta.label ? 'bold' : 'normal', fontStyle: meta.label ? 'normal' : 'italic', color: meta.label ? '#eee' : '#999',
            }, { textContent: meta.label || 'Unnamed cassette' }));
            r.appendChild(el('div', { color: '#777', fontSize: '10px', flexShrink: '0', fontFamily: 'Consolas, Monaco, monospace' },
                { textContent: cassette.counterText(meta.positionMs || 0) + (meta.writeProtect ? ' · WP' : '') }));
            r.addEventListener('mouseenter', () => { r.style.background = '#2a2d33'; });
            r.addEventListener('mouseleave', () => { r.style.background = ''; });
            r.addEventListener('click', () => controller.insertFromBox(meta.id));
            return r;
        }));
    }

    /* A double click on the empty recorder's list puts a cassette in with its
     * first click; its second then lands on the list of parts, and is let go. */
    let loadedAt = 0;
    const justLoaded = () => (performance.now() - loadedAt) < 400;

    let emptyShown = false;
    function refresh() {
        const kind = emu.tapeKind;
        loaded.style.display = kind ? 'flex' : 'none';
        empty.style.display = kind ? 'none' : 'flex';
        const c = own();
        swatch.style.display = c ? '' : 'none';
        wpBtn.style.display = c ? '' : 'none';
        saveBtn.style.display = c ? '' : 'none';
        nameInput.style.display = c ? '' : 'none';
        title.style.display = c ? 'none' : '';
        if (!kind) {
            title.textContent = 'The recorder is empty';
            title.style.color = '#ccc';
            if (!emptyShown) loadBoxList();
            emptyShown = true;
            cmdRow.style.display = 'none';
            return;
        }
        if (emptyShown) loadedAt = performance.now();
        emptyShown = false;
        if (c) {
            swatch.style.background = c.colour;
            if (document.activeElement !== nameInput) nameInput.value = c.label || '';
            fitName();
            wpBtn.style.background = c.writeProtect ? '#a33' : '#333';
            wpBtn.style.color = c.writeProtect ? '#fff' : '#ccc';
            wpBtn.title = c.writeProtect ? 'Write-protected: the tabs are out. Click to cover the holes.' : 'Write protect: break out the tabs';
        } else {
            title.textContent = gameLabel(emu) + ' (pre-recorded)';
            title.style.color = '#fff';
        }
        const isOwn = kind === 'cassette';
        const segments = emu.tapeSegments || [];
        renderMap(segments, emu.tapeLengthMs || cassette.CASSETTE_MS, emu.tapeBlankFromMs, isOwn);
        renderList(segments, isOwn);
        const showNotice = isOwn && hint && hint.kind === 'recordedOver';
        notice.style.display = showNotice ? 'flex' : 'none';
        if (showNotice) {
            noticeText.textContent = recordedOverText(hint.names);
            undoBtn.style.display = hint.canUndo ? '' : 'none';
        }
        tick(emu.tapePositionMs);
    }

    // Moves the head on the map and marks the part the tape is at, as the tape moves.
    let tickedPart = null;
    function tick(positionMs) {
        if (!emu.tapeKind) return;
        const lengthMs = emu.tapeLengthMs || cassette.CASSETTE_MS;
        headMark.setAttribute('transform', `translate(${clamp(positionMs / lengthMs, 0, 1) * mapW} 0)`);
        let current = null;
        for (const row of list.children) {
            if (row.dataset.end !== undefined && positionMs < Number(row.dataset.end)) { current = row; break; }
        }
        if (!current) current = [...list.children].find(r => r.dataset.start === 'blank') || null;
        if (current !== tickedPart) {
            for (const row of list.children) row.style.borderLeftColor = (row === current) ? '#3a6' : 'transparent';
            tickedPart = current;
        }
    }

    // The map fills the panel's width, less its 10-pixel margins and border.
    function fitMap() {
        const width = panel.clientWidth - 20;
        if ((width <= 0) || (width === mapW)) return;
        mapW = width;
        map.setAttribute('width', mapW);
        map.setAttribute('viewBox', `0 0 ${mapW} ${MAP_H}`);
        mapTrack.setAttribute('width', mapW);
        if (emu.tapeKind) refresh();
    }
    if (window.ResizeObserver) new ResizeObserver(fitMap).observe(panel);

    return {
        element: panel, header, refresh, tick,
        // the lists that take up the height of a resized panel
        stretch: [list, boxList],
        setHint(h) { hint = h; refresh(); },
        refreshBox() { if (!emu.tapeKind) loadBoxList(); },
        set onClose(fn) { onClose = fn; },
    };
}

const gameLabel = (emu) => baseName((emu.tapeFile && emu.tapeFile.name) || emu.loadedGameName || 'Tape');

const recordedOverText = (names) => {
    const named = (names || []).filter(Boolean).map(n => `"${n}"`);
    return named.length ? `Recorded over ${named.join(', ')}.` : 'Recorded over part of an earlier recording.';
};

/* ==================== the cassette box ==================== */

/* Every cassette you own, from File > Tape cassettes: create, import and
 * export them, and name, colour, protect, copy, save or delete each one.
 * Using a cassette happens at the recorder. */
function openCassetteBox(ui, emu, controller) {
    const dialog = openDialog(ui, emu, {
        id: 'cassetteBox', title: 'Tape cassettes',
        subtitle: 'Blank 60-minute cassettes to SAVE onto, and tapes imported from your PC. To use one, put it in the tape recorder'
            + (controller.state.connected ? '.' : ' (connect it from the toolbar).'),
        width: 820, height: 620,
        onClose: () => unsubscribe(),
    });
    const close = dialog.close;

    const toolbar = h('div', 'jsd-bar');
    const newBtn = button('New blank C60', { variant: 'primary', title: 'A blank 60-minute cassette to SAVE onto' });
    const importBtn = button('Import .tap/.tzx…', { icon: openIcon, title: 'Tape files from your PC, each as a cassette' });
    const spacer = h('div', 'jsd-grow');
    const importBoxBtn = button('Import box…', { title: 'Cassettes from a box saved as a .zip' });
    const exportBoxBtn = button('Save box to PC', { title: 'Every cassette in the box, as one .zip' });
    const fileInput = h('input', '', { type: 'file', accept: '.tap,.tzx', multiple: true });
    const zipInput = h('input', '', { type: 'file', accept: '.zip' });
    fileInput.style.display = 'none';
    zipInput.style.display = 'none';
    toolbar.append(newBtn, importBtn, spacer, importBoxBtn, exportBoxBtn, fileInput, zipInput);

    const scroll = h('div', 'jsd-scroll');
    const grid = h('div', 'jsd-grid');
    scroll.appendChild(grid);
    dialog.body.append(toolbar, scroll);

    // Rendering awaits storage, so each render builds off-screen and only the latest is shown.
    let renderGeneration = 0;
    async function renderGrid() {
        const generation = ++renderGeneration;
        await flushed;
        const cards = document.createDocumentFragment();
        const cassettes = await store.list();
        if (cassettes.length === 0) {
            const none = h('div', 'jsd-empty');
            none.style.gridColumn = '1 / -1';
            none.appendChild(h('b', '', { textContent: 'The box is empty' }));
            none.appendChild(document.createTextNode('Make a blank cassette to SAVE onto, or import a tape from your PC.'));
            cards.appendChild(none);
        }
        for (const meta of cassettes) {
            const record = await store.get(meta.id);
            let parts = [];
            let blankFrom = 0;
            try {
                const blocks = cassette.parseCassetteFile(record.data).blocks;
                parts = cassette.describeParts(blocks);
                blankFrom = cassette.blankFromMs(blocks);
            } catch (e) { /* shown as empty */ }
            const inRecorder = controller.inRecorder(meta.id);
            const waiting = !inRecorder && controller.state.cassette && controller.state.cassette.id === meta.id;

            const card = h('div', 'jsd-card' + (inRecorder ? ' current' : ''));
            const top = h('div', 'jsd-card-top');
            const swatch = h('div', 'jsd-swatch', { title: 'Label colour (click to change)' });
            swatch.style.background = meta.colour;
            swatch.addEventListener('click', async () => {
                const i = store.CASSETTE_COLOURS.indexOf(meta.colour);
                await controller.setColour(meta.id, store.CASSETTE_COLOURS[(i + 1) % store.CASSETTE_COLOURS.length]);
                renderGrid();
            });
            const label = h('input', 'jsd-label', {
                value: meta.label || '', maxLength: 24, placeholder: 'Unnamed cassette', title: 'Cassette label (click to change)',
            });
            label.addEventListener('keydown', (e) => { if (e.key === 'Enter') label.blur(); });
            label.addEventListener('change', () => controller.rename(meta.id, label.value.trim()));
            top.append(swatch, label);
            if (meta.writeProtect) top.appendChild(h('span', 'jsd-badge warn', { textContent: 'Protected', title: 'Write-protected: SAVE cannot record on it' }));
            card.appendChild(top);

            const badges = h('div');
            if (inRecorder) badges.appendChild(h('span', 'jsd-badge accent', { textContent: 'In the recorder' }));
            else if (waiting) badges.appendChild(h('span', 'jsd-badge', { textContent: 'In the recorder, switched off' }));
            if (badges.childNodes.length) card.appendChild(badges);

            const status = [];
            status.push(parts.length ? `${parts.length} part${parts.length === 1 ? '' : 's'}, blank from ${cassette.counterText(blankFrom)}` : 'Blank');
            status.push(`counter at ${cassette.counterText(inRecorder ? emu.tapePositionMs : (meta.positionMs || 0))}`);
            card.appendChild(h('div', 'jsd-row-meta', { textContent: status.join(' · ') }));
            if (parts.length) {
                const names = parts.slice(0, 4).map(p => p.name || p.typeName).join(', ') + ((parts.length > 4) ? ', …' : '');
                const list = h('div', 'jsd-faint jsd-mono', { textContent: names, title: parts.map(p => p.name || p.typeName).join('\n') });
                Object.assign(list.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
                card.appendChild(list);
            }
            card.appendChild(h('div', 'jsd-faint', { textContent: `Modified ${fmtDate(meta.modified)}` }));

            const actions = h('div', 'jsd-card-actions');
            const useRow = h('div', 'jsd-card-row');
            const saveRow = h('div', 'jsd-card-row');
            if (!inRecorder) {
                const insertBtn = button('Put in recorder', { small: true, variant: 'accent' });
                insertBtn.addEventListener('click', async () => { await controller.insertFromBox(meta.id); close(); });
                useRow.appendChild(insertBtn);
            }
            const wpBtn = button(meta.writeProtect ? 'Allow recording' : 'Write-protect', { small: true });
            wpBtn.addEventListener('click', async () => { await controller.setWriteProtect(meta.id, !meta.writeProtect); renderGrid(); });
            const tzxBtn = button('.tzx', { small: true, title: 'Save to PC as .tzx: the whole cassette, every recording at its place on the tape' });
            tzxBtn.addEventListener('click', async () => {
                const r = await store.get(meta.id);
                if (r) downloadBytes(cassette.relabel(r.data, r.label), safeFileName(r.label, 'cassette') + '.tzx', tzxBtn);
            });
            const tapBtn = button('.tap', { small: true, title: 'Save to PC as .tap: the recordings one after another, without the blank tape between them' });
            tapBtn.addEventListener('click', async () => {
                const r = await store.get(meta.id);
                if (r) downloadBytes(cassette.writeCassetteTAP(cassette.parseCassetteFile(r.data).blocks), safeFileName(r.label, 'cassette') + '.tap', tapBtn);
            });
            const dupBtn = button('Duplicate', { small: true });
            dupBtn.addEventListener('click', async () => { await store.duplicate(meta.id); renderGrid(); });
            const delBtn = confirmButton('Delete', inRecorder ? 'Eject & delete?' : 'Really delete?',
                () => controller.remove(meta.id).then(renderGrid), { small: true });
            useRow.append(wpBtn, dupBtn);
            saveRow.append(h('span', 'jsd-faint', { textContent: 'Save to PC' }), tzxBtn, tapBtn, h('div', 'jsd-grow'), delBtn);
            actions.append(useRow, saveRow);
            card.appendChild(actions);
            cards.appendChild(card);
        }
        if (generation === renderGeneration) {
            grid.replaceChildren(cards);
            dialog.aside.textContent = cassettes.length + (cassettes.length === 1 ? ' cassette' : ' cassettes');
        }
    }
    const unsubscribe = controller.onChange(() => renderGrid());
    // The cassette in the recorder may hold recordings not yet in the box: they go in first.
    const flushed = (async () => {
        emu.flushCassette();
        await emu.barrier();
    })();
    const notStored = () => dialog.setStatus('This browser isn’t letting the emulator keep cassettes, so the cassette box can’t take any.', 'error');

    newBtn.addEventListener('click', async () => {
        if (!(await store.create({ label: '', data: blankCassette(), positionMs: 0 }))) notStored();
        else dialog.setStatus('Added a blank cassette.', 'ok');
        renderGrid();
    });

    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const files = Array.from(fileInput.files);
        fileInput.value = '';
        const failed = [];
        let added = 0;
        for (const file of files) {
            try {
                const { data, label } = cassetteFromFile(await readFileAsArrayBuffer(file), file.name);
                if (!(await store.create({ label, data, positionMs: 0 }))) { notStored(); break; }
                added++;
            } catch (err) {
                failed.push(file.name + ': ' + ((err && err.message) || err));
            }
        }
        if (failed.length) dialog.setStatus(failed.join('; '), 'error');
        else if (added) dialog.setStatus(`Imported ${added} tape${added === 1 ? '' : 's'}.`, 'ok');
        renderGrid();
    });

    exportBoxBtn.addEventListener('click', async () => {
        const zip = new JSZip();
        const manifest = { cassettes: [] };
        for (const meta of await store.list()) {
            const record = await store.get(meta.id);
            if (!record) continue;
            const file = safeFileName(record.label, 'cassette') + '_' + meta.id.slice(0, 8) + '.tzx';
            zip.file(file, cassette.relabel(record.data, record.label));
            manifest.cassettes.push({ file, label: record.label, colour: record.colour, writeProtect: !!record.writeProtect, positionMs: record.positionMs || 0 });
        }
        zip.file('manifest.json', JSON.stringify(manifest, null, 2));
        downloadBytes(await zip.generateAsync({ type: 'blob' }), 'jsspeccy-cassettes.zip', exportBoxBtn);
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
            try { manifest = JSON.parse(await manifestEntry.async('string')); } catch (e) { /* ignore: the manifest only adds colours and positions */ }
        }
        const entries = [];
        zip.forEach((path, f) => { if (!f.dir && /\.(tap|tzx)$/i.test(path)) entries.push([path, f]); });
        let added = 0;
        for (const [path, f] of entries) {
            try {
                const imported = cassetteFromFile(await f.async('arraybuffer'), path);
                const saved = manifest && Array.isArray(manifest.cassettes) && manifest.cassettes.find(c => c.file === path);
                if (await store.create({
                    label: (saved && typeof saved.label === 'string') ? saved.label : imported.label,
                    colour: saved && saved.colour,
                    writeProtect: !!(saved && saved.writeProtect),
                    positionMs: (saved && Number.isFinite(saved.positionMs)) ? clamp(saved.positionMs, 0, cassette.CASSETTE_MS) : 0,
                    data: imported.data,
                })) added++;
            } catch (err) { /* a tape that can't be a cassette is left out */ }
        }
        dialog.setStatus(`Imported ${added} of ${entries.length} cassette${entries.length === 1 ? '' : 's'} from ${file.name}.`, added ? 'ok' : 'error');
        renderGrid();
    });

    renderGrid();
}

/* ==================== the recorder ==================== */

/* How the reels are drawn turning: the tape runs at 4.76 cm/s past the head,
 * and a reel turns faster the less tape is on it. Past MAX_DRAWN_SPIN
 * (radians a second) the teeth would only flicker, so the drawn speed stops
 * there and the hubs blur instead. */
const TAPE_MM_PER_S = 47.625;
const UNITS_PER_MM = 0.58;
const MAX_DRAWN_SPIN = 14;

export function createTapeDeck(ui, emu) {
    const controller = createController(emu);

    // Stands to the left of the Spectrum above the Microdrives, level with
    // them: the recorder over the two drives, its leads where the drives'
    // ribbon runs below. The recorder is the body that can be dragged away
    // from there.
    const element = el('div', { position: 'absolute', zIndex: '90', right: '100%', transformOrigin: '100% 0%', display: 'none' });
    const inner = el('div', { display: 'flex', flexDirection: 'row-reverse', alignItems: 'flex-start' });
    element.appendChild(inner);
    const leads = buildLeads();
    inner.appendChild(leads.element);
    const art = buildDeckArt();
    const body = el('div', {});
    body.appendChild(art.element);
    inner.appendChild(body);
    ui.appContainer.appendChild(element);

    // The recorder's light in fullscreen, where the recorder itself is hidden.
    const fsIndicator = el('div', {
        position: 'absolute', zIndex: '91', display: 'none', left: '10px', bottom: '10px',
        width: '10px', height: '10px', borderRadius: '50%', pointerEvents: 'none',
    });
    ui.appContainer.appendChild(fsIndicator);

    // A hint above the recorder: why a key won't go down, or why LOAD is waiting.
    const bubble = el('div', {
        position: 'absolute', zIndex: '95', display: 'none', maxWidth: '240px', padding: '6px 9px',
        background: '#1c1e22', color: '#eee', border: '1px solid #555', borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.45)', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px',
        lineHeight: '1.35', transition: 'opacity 0.3s', opacity: '0',
    });
    ui.appContainer.appendChild(bubble);
    let bubbleTimer = null;
    let bubbleAction = null;  // the action the bubble showing offers, if any
    function showBubble(text, action) {
        bubbleAction = action || null;
        bubble.replaceChildren(el('span', {}, { textContent: text }));
        if (action) {
            const b = el('button', {
                marginLeft: '8px', border: 'none', background: '#3a6', color: '#fff', borderRadius: '4px',
                padding: '2px 8px', cursor: 'pointer', fontSize: '11px',
            }, { textContent: action.label });
            b.addEventListener('click', () => { action.run(); hideBubble(); });
            bubble.appendChild(b);
        }
        if (element.style.display === 'none') return;
        bubble.style.display = 'block';
        positionBubble();
        requestAnimationFrame(() => { bubble.style.opacity = '1'; });
        clearTimeout(bubbleTimer);
        bubbleTimer = setTimeout(hideBubble, action ? 8000 : 5000);
    }
    function hideBubble() {
        bubbleAction = null;
        clearTimeout(bubbleTimer);
        bubble.style.opacity = '0';
        bubbleTimer = setTimeout(() => { bubble.style.display = 'none'; }, 300);
    }
    function positionBubble() {
        if (bubble.style.display === 'none') return;
        // Above the recorder, or over its speaker grille where the page has no room above it.
        const box = art.element.getBoundingClientRect();
        const container = ui.appContainer.getBoundingClientRect();
        bubble.style.left = (box.left - container.left) + 'px';
        bubble.style.top = Math.max(4 - container.top, box.top - container.top - bubble.offsetHeight - 6) + 'px';
    }

    /* A click on the counter, with the tape standing still, asks where to
     * wind to: a reading in seconds as the counter shows it, or minutes and
     * seconds. Enter winds there, the reels turning as for a key; Escape, or
     * leaving the box, gives up. With no tape in, a note in the same place
     * says to insert one; with a tape moving, the click does nothing. */
    const COUNTER_BOX_STYLE = {
        position: 'absolute', zIndex: '95', display: 'none', padding: '5px 7px',
        background: '#1c1e22', color: '#eee', border: '1px solid #555', borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.45)', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px',
        lineHeight: '1.35', whiteSpace: 'nowrap',
    };
    const counterEntry = el('div', COUNTER_BOX_STYLE);
    counterEntry.appendChild(el('span', { marginRight: '6px' }, { textContent: 'Wind to' }));
    const counterInput = el('input', {
        width: '4.5em', padding: '1px 4px', border: '1px solid #666', borderRadius: '3px', background: '#f6f6f1',
        color: '#1d1d1d', fontFamily: 'Consolas, "Courier New", monospace', fontSize: '13px', textAlign: 'right',
    }, { type: 'text', maxLength: 7, spellcheck: false, title: 'A counter reading, 0000 to 3600, or minutes:seconds' });
    counterEntry.appendChild(counterInput);
    counterEntry.appendChild(el('span', { marginLeft: '6px', color: '#999', fontSize: '11px' }, { textContent: 'or m:ss' }));
    ui.appContainer.appendChild(counterEntry);
    for (const type of ['keydown', 'keyup', 'keypress']) counterInput.addEventListener(type, (e) => e.stopPropagation());
    const counterNote = el('div', COUNTER_BOX_STYLE, { textContent: 'Insert a tape first.' });
    ui.appContainer.appendChild(counterNote);
    let counterNoteTimer = null;

    // Whether the counter takes a click now: a tape in, standing still, no load or save under way.
    function counterTakesClick() {
        const s = emu.deckStatus;
        return !!(s && s.connected && emu.tapeKind && (s.mode === 'stop') && !s.loading && !s.saving && !anim.jump);
    }
    function showCounterEntry() {
        counterInput.value = cassette.counterText(livePosition(performance.now()));
        counterInput.style.borderColor = '#666';
        counterEntry.style.display = 'block';
        positionCounterBoxes();
        counterInput.focus();
        counterInput.select();
    }
    function hideCounterEntry() {
        counterEntry.style.display = 'none';
    }
    function showCounterNote() {
        counterNote.style.display = 'block';
        positionCounterBoxes();
        clearTimeout(counterNoteTimer);
        counterNoteTimer = setTimeout(hideCounterNote, 4000);
    }
    function hideCounterNote() {
        clearTimeout(counterNoteTimer);
        counterNote.style.display = 'none';
    }
    function positionCounterBoxes() {
        // Always right beside the counter: to its right, level with it.
        const box = art.counterFace.getBoundingClientRect();
        const container = ui.appContainer.getBoundingClientRect();
        for (const shown of [counterEntry, counterNote]) {
            if (shown.style.display === 'none') continue;
            shown.style.left = (box.right - container.left + 6) + 'px';
            shown.style.top = (box.top - container.top + ((box.height - shown.offsetHeight) / 2)) + 'px';
        }
    }
    // The reading typed, in ms along the tape, or null for one that makes no sense.
    function parseCounterEntry(text) {
        const t = text.trim();
        let seconds;
        const clock = /^(\d{1,3}):(\d{1,2})$/.exec(t);
        if (clock) seconds = (Number(clock[1]) * 60) + Number(clock[2]);
        else if (/^\d{1,4}$/.test(t)) seconds = Number(t);
        else return null;
        return clamp(seconds * 1000, 0, emu.tapeLengthMs || cassette.CASSETTE_MS);
    }
    counterInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideCounterEntry();
            emu.focus();
        } else if (e.key === 'Enter') {
            const ms = parseCounterEntry(counterInput.value);
            if (ms === null) {
                counterInput.style.borderColor = '#e3281c';
                counterInput.select();
                return;
            }
            hideCounterEntry();
            if (counterTakesClick()) emu.windTape(ms);
            emu.focus();
        }
    });
    counterInput.addEventListener('blur', hideCounterEntry);

    /* ---------- the panel ---------- */
    let panel = null;
    function closePanel() {
        if (!panel) return;
        panel.element.remove();
        panel = null;
    }
    function positionPanel() {
        if (!panel || panel.mover.place()) return;
        // Beside the recorder, on its left if there is room there, so the
        // reels stay in view while it winds; otherwise over the display.
        const box = art.element.getBoundingClientRect();
        const container = ui.appContainer.getBoundingClientRect();
        const width = panel.element.offsetWidth || 300;
        const left = (box.left >= (width + 12)) ? (box.left - width - 8) : (container.left + 8);
        panel.element.style.left = (left - container.left) + 'px';
        panel.element.style.top = Math.max(-container.top + 4, box.top - container.top) + 'px';
    }
    function togglePanel() {
        if (panel) { closePanel(); return; }
        panel = buildPanel(emu, controller, () => openBox());
        panel.onClose = closePanel;
        panel.mover = makeMovable(panel.element, panel.header, ui.appContainer, {
            id: 'recorder', resize: { minWidth: 260, minHeight: 180, stretch: panel.stretch }, onReset: positionPanel,
        });
        ui.appContainer.appendChild(panel.element);
        panel.refresh();
        positionPanel();
    }
    function openBox() {
        closePanel();
        openCassetteBox(ui, emu, controller);
    }

    /* ---------- showing, hiding, placing ---------- */
    let fullscreen = false;
    function applyVisibility() {
        const show = controller.state.connected && !fullscreen;
        const was = element.style.display !== 'none';
        element.style.display = show ? 'block' : 'none';
        if (!show) {
            closePanel();
            hideBubble();
            hideCounterEntry();
            hideCounterNote();
            ui.makeRoomOnLeft(element);
        }
        if (show && !was) {
            reposition();
            snapAnimation();
        }
        updateIndicator();
    }

    function reposition() {
        if (!emu.canvas || element.style.display === 'none') return;
        // The Microdrives' dock top, as microdrive-ui.js places it, whether or
        // not they are connected, so the recorder never moves.
        const scale = DOCK_SCALE * (typeof ui.zoom === 'number' ? ui.zoom : 1);
        const bar = ui.toolbar.elem;
        const drivesTop = bar.offsetTop + (bar.offsetHeight / 2) - (RIBBON_PLUG_Y * scale);
        const bottom = drivesTop - (DECK_GAP * scale);
        const container = ui.appContainer.getBoundingClientRect();
        const screenTop = emu.canvas.getBoundingClientRect().top - container.top;
        // Normally drawn at the drives' scale; smaller only if it wouldn't fit below the top of the screen.
        const fit = clamp((bottom - screenTop) / DECK_H, 0.2, scale);
        // The leads' column stays as wide as the drives' ribbon, so the recorder stays over the drives.
        leadsWidth = (RIBBON_W * scale) / fit;
        element.style.top = (bottom - (DECK_H * fit)) + 'px';
        element.style.transform = `scale(${fit})`;
        mover.update();
        if (!mover.dragging()) ui.makeRoomOnLeft(element);
        positionPanel();
        positionBubble();
        positionCounterBoxes();
    }
    let leadsWidth = RIBBON_W;
    const mover = makeDeviceMovable(body, leads.element, {
        id: 'tapeRecorder', draw: (dx, dy) => leads.draw(leadsWidth, dx, dy), onMove: reposition,
    });
    if (window.ResizeObserver) ui.keepObserver(new ResizeObserver(reposition)).observe(ui.appContainer);
    ui.on('setZoom', reposition);
    setTimeout(reposition, 0);

    /* ---------- animation ---------- */
    const anim = {
        raf: 0,
        lastTime: null,
        shownMs: 0,       // the position the counter and reels are drawn at
        angleL: 0,
        angleR: 0,
        jump: null,       // an instant SAVE or LOAD's jump: {from, to, start, duration, kind}
        door: 1,          // 0 closed to 1 open
        seated: 0,        // the cassette, 0 out to 1 in
        shown: null,      // the cassette drawn: {key, info}
        held: null,       // the key held down under the pointer
    };

    // What is in the recorder, as drawn, and a key that tells one from another.
    function currentCassette() {
        const kind = emu.tapeKind;
        if (!kind) return null;
        const c = controller.state.cassette;
        const info = (kind === 'game')
            ? { kind, label: gameLabel(emu), colour: null, writeProtect: true }
            : { kind, label: c ? c.label : '', colour: c ? c.colour : undefined, writeProtect: emu.tapeWriteProtect };
        return { key: `${kind}|${info.label}|${info.colour}|${info.writeProtect}|${c ? c.id : ''}`, info, identity: `${kind}|${c ? c.id : ''}|${kind === 'game' ? info.label : ''}` };
    }

    function livePosition(now) {
        const s = emu.deckStatus;
        if (!s || !emu.tapeKind) return anim.shownMs;
        let pos = s.positionMs;
        if (s.speed && emu.deckDriven) pos += s.speed * Math.min(150, now - emu.deckStatusTime);
        return clamp(pos, 0, s.lengthMs || emu.tapeLengthMs || pos);
    }

    function keysDown() {
        const down = new Set();
        const s = emu.deckStatus;
        if (s && s.connected && emu.tapeKind) {
            if (s.mode === 'record') { down.add('record'); down.add('play'); }
            else if (s.mode !== 'stop') down.add(s.mode);
            if (s.loading || (anim.jump && anim.jump.kind === 'load')) down.add('play');
            if (anim.jump && anim.jump.kind === 'save') { down.add('record'); down.add('play'); }
        }
        if (anim.held) down.add(anim.held);
        return down;
    }

    // Draws everything as it is now, without easing into it: when first shown.
    function snapAnimation() {
        anim.shownMs = livePosition(performance.now());
        anim.jump = null;
        const now = currentCassette();
        anim.shown = now;
        anim.door = now ? 0 : 1;
        anim.seated = now ? 1 : 0;
        art.setCassette(now ? now.info : null);
        draw(0);
    }

    function draw(dt) {
        const lengthMs = emu.tapeLengthMs || (emu.deckStatus && emu.deckStatus.lengthMs) || cassette.CASSETTE_MS;
        const s = emu.deckStatus;
        const now = performance.now();
        let pos = livePosition(now);
        if (anim.jump) {
            const f = (now - anim.jump.start) / anim.jump.duration;
            if (f >= 1) {
                anim.jump = null;
            } else {
                const eased = 0.5 - (0.5 * Math.cos(Math.PI * f));
                pos = anim.jump.from + ((anim.jump.to - anim.jump.from) * eased);
            }
        }
        const delta = pos - anim.shownMs;
        anim.shownMs = pos;

        const fraction = clamp(pos / lengthMs, 0, 1);
        const radiusL = packRadius(1 - fraction), radiusR = packRadius(fraction);
        const mm = (delta / 1000) * TAPE_MM_PER_S * UNITS_PER_MM;
        let turnL = mm / radiusL, turnR = mm / radiusR;
        let blur = 0;
        if (dt > 0) {
            const spin = Math.max(Math.abs(turnL), Math.abs(turnR)) / (dt / 1000);
            if (spin > MAX_DRAWN_SPIN) {
                const cut = MAX_DRAWN_SPIN / spin;
                turnL *= cut;
                turnR *= cut;
                blur = clamp((spin - MAX_DRAWN_SPIN) / (MAX_DRAWN_SPIN * 2), 0, 0.85);
            }
        }
        anim.angleL += turnL;
        anim.angleR += turnR;
        art.setReels(anim.angleL, anim.angleR, radiusL, radiusR, blur);
        art.setCounter(pos / 1000);
        art.setKeysDown(keysDown());
        art.setLed(!!(s && s.connected && emu.tapeKind && ((s.mode === 'record') || (anim.jump && anim.jump.kind === 'save'))));
        if (panel) panel.tick(pos);

        // The door and the cassette: out with the old, then in with the new.
        const cur = currentCassette();
        const swapping = anim.shown && cur && (anim.shown.identity !== cur.identity);
        const present = !!cur && !swapping;
        const step = reduceMotion() ? 1 : (dt / 240);
        if (present) {
            if (!anim.shown || anim.seated === 0) { anim.shown = cur; art.setCassette(cur.info); }
            else if (anim.shown.key !== cur.key) { anim.shown = cur; art.setCassette(cur.info); }
            // the cassette drops into the open door, then the door closes on it
            anim.seated = Math.min(1, anim.seated + step);
            if (anim.seated >= 1) anim.door = Math.max(0, anim.door - step);
        } else {
            anim.door = Math.min(1, anim.door + step);
            if (anim.door >= 0.9) anim.seated = Math.max(0, anim.seated - step);
            if (anim.seated === 0 && anim.shown && (!cur || swapping)) {
                anim.shown = null;
                art.setCassette(null);
            }
        }
        art.setDoor(anim.door, anim.seated);
        return !!(s && s.speed && emu.deckDriven) || !!anim.jump || (present ? (anim.seated < 1 || anim.door > 0) : (anim.door < 1 || anim.seated > 0)) || swapping;
    }

    function frame(now) {
        anim.raf = 0;
        if (element.style.display === 'none') return;
        const dt = (anim.lastTime === null) ? 0 : Math.min(100, now - anim.lastTime);
        anim.lastTime = now;
        if (draw(dt)) anim.raf = requestAnimationFrame(frame);
        else anim.lastTime = null;
    }
    function kick() {
        if (anim.raf || element.style.display === 'none') return;
        anim.raf = requestAnimationFrame(frame);
    }

    function updateIndicator() {
        const s = emu.deckStatus;
        const moving = s && s.connected && emu.tapeKind && (s.mode !== 'stop');
        fsIndicator.style.display = (controller.state.connected && fullscreen && moving) ? 'block' : 'none';
        if (!moving) return;
        const colour = (s.mode === 'record') ? '#ff3b30' : ((s.mode === 'play') ? '#3c3' : '#f5a623');
        fsIndicator.style.background = colour;
        fsIndicator.style.boxShadow = `0 0 4px ${colour}`;
    }

    /* ---------- keys and clicks ---------- */
    function pressKey(key) {
        if (key === 'eject') {
            // An empty recorder's Eject opens it to take a cassette.
            if (emu.tapeKind) controller.eject(); else if (!panel) togglePanel();
        } else {
            emu.deckKey(key);
        }
        emu.focus();
    }
    for (const { key } of KEYS) {
        const g = art.keys[key].g;
        g.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (g.setPointerCapture) g.setPointerCapture(e.pointerId);
            anim.held = key;
            art.setKeysDown(keysDown());
        });
        g.addEventListener('pointerup', (e) => {
            e.stopPropagation();
            if (anim.held !== key) return;
            anim.held = null;
            const box = g.getBoundingClientRect();
            const over = (e.clientX >= box.left) && (e.clientX <= box.right) && (e.clientY >= box.top) && (e.clientY <= box.bottom);
            if (over) pressKey(key);
            art.setKeysDown(keysDown());
            kick();
        });
        g.addEventListener('pointercancel', () => { anim.held = null; art.setKeysDown(keysDown()); });
        g.addEventListener('click', (e) => e.stopPropagation());
    }
    art.door.addEventListener('click', () => togglePanel());
    // The counter: a click asks where to wind to, while the tape stands still, or says to insert a tape; another click takes either back.
    art.counter.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    art.counter.addEventListener('click', (e) => {
        e.stopPropagation();
        if (counterEntry.style.display !== 'none') { hideCounterEntry(); emu.focus(); return; }
        if (counterNote.style.display !== 'none') { hideCounterNote(); return; }
        if (!controller.state.connected) return;
        if (!emu.tapeKind) { showCounterNote(); return; }
        if (counterTakesClick()) showCounterEntry();
    });
    art.element.addEventListener('pointerdown', (e) => e.preventDefault());

    /* ---------- following the emulator ---------- */
    controller.onChange(() => {
        applyVisibility();
        if (panel) panel.refresh();
        kick();
    });

    emu.on('tapeDeckStatus', (s) => {
        if (s.jump && element.style.display !== 'none' && !reduceMotion()) {
            const distance = Math.abs(s.jump.toMs - anim.shownMs);
            anim.jump = { from: anim.shownMs, to: s.jump.toMs, start: performance.now(), duration: clamp(distance / 20, 250, 600), kind: s.jump.kind };
        }
        // A tape set moving while the counter's question is open takes the question away.
        if ((counterEntry.style.display !== 'none') && !counterTakesClick()) hideCounterEntry();
        updateIndicator();
        kick();
    });
    const tapeChanged = () => {
        if (emu.tapeKind) hideCounterNote();
        if (panel) panel.refresh();
        kick();
    };
    emu.on('tapeInfo', tapeChanged);
    emu.on('tapeEjected', tapeChanged);
    // A hint, and an Undo offered with it, are about the tape that was in.
    const tapeLeft = () => {
        hideBubble();
        hideCounterEntry();
        if (panel) panel.setHint(null);
    };
    emu.on('tapeEjected', tapeLeft);
    emu.on('cassetteEjected', tapeLeft);
    emu.on('start', kick);

    const bounceFor = (hint) => {
        if (hint.key) art.bounce(hint.key);
    };
    // A refusal on its own, or as the reason a SAVE isn't being recorded.
    const because = (hint, reason) => hint.save ? `SAVE isn’t being recorded: ${reason}` : (reason.charAt(0).toUpperCase() + reason.slice(1));
    emu.on('deckHint', (hint) => {
        if (!controller.state.connected) return;
        switch (hint.kind) {
            case 'noCassette':
                bounceFor(hint);
                showBubble(hint.save ? because(hint, 'there is no cassette in the tape recorder.') : 'Put a cassette in first: click the recorder’s window.');
                break;
            case 'gameTape':
                bounceFor(hint);
                showBubble(because(hint, 'a pre-recorded tape can’t be recorded on. Put in one of your own cassettes.'));
                break;
            case 'writeProtected': {
                bounceFor(hint);
                // for the cassette the hint is about, and only while it is still in
                const id = controller.state.cassette && controller.state.cassette.id;
                showBubble(because(hint, 'this cassette is write-protected.'), id
                    ? { label: 'Allow recording', run: () => { if (controller.inRecorder(id)) controller.setWriteProtect(id, false); } } : null);
                break;
            }
            case 'nothingAhead':
                showBubble(`LOAD is waiting: there is nothing on the tape after ${cassette.counterText(hint.positionMs)}. Rewind, or pick a part from the recorder’s window.`);
                break;
            case 'endOfTape':
                showBubble('End of tape.');
                break;
            case 'recordedOver':
                if (panel) panel.setHint(hint);
                showBubble(recordedOverText(hint.names), hint.canUndo ? { label: 'Undo', undo: true, run: () => { emu.undoCassetteRecording(); if (panel) panel.setHint(null); } } : null);
                break;
            case 'undoGone':
                // A newer recording, or the undo itself, has taken the undo away: it isn't offered any more.
                if (panel) panel.setHint(null);
                if (bubbleAction && bubbleAction.undo) hideBubble();
                break;
        }
    });

    emu.onReady(() => { controller.init(); });

    return {
        element,
        toggle() { controller.setConnected(!controller.state.connected); },
        isConnected() { return controller.state.connected; },
        setFullscreen(value) { fullscreen = value; applyVisibility(); },
        openBox,

        /* For a page's script (see runtime/script-api.js): the recorder and
         * the cassette box, worked as the toolbar, the panel and the box work
         * them. A new or imported cassette goes into the box and the
         * recorder, and resolves to its id in the box. */
        setConnected(connected) { return controller.setConnected(connected); },
        newCassette(label) { return controller.insertNew(blankCassette(), label || '', undefined); },
        importCassette(data, fileName) {
            const imported = cassetteFromFile(data, fileName || '');
            return controller.insertNew(imported.data, imported.label, undefined);
        },
        insertFromBox(id) { return controller.insertFromBox(id); },
        eject() { controller.eject(); },
        cassettes() { return store.list(); },
        cassetteInRecorder() {
            const c = controller.state.cassette;
            return (c && (emu.tapeKind === 'cassette')) ? controller.keepMeta(c) : null;
        },
        currentData() { return controller.currentData(); },
        setWriteProtect(value) {
            const c = controller.state.cassette;
            return c ? controller.setWriteProtect(c.id, !!value) : Promise.resolve();
        },

        /* For a saved session: the whole cassette box, whether the recorder
         * is connected, and which cassette of yours is in it (or waiting in
         * it while it is off). `live` is the cassette in the recorder as the
         * snapshot has it, which may hold recordings not yet in the box.
         * What is in the recorder is taken as it is at the call, before
         * anything is awaited, so it matches the snapshot. A cassette the
         * box couldn't store is still saved, under a made-up id. */
        async sessionSave(live) {
            const connected = controller.state.connected;
            const c = controller.state.cassette ? { ...controller.state.cassette } : null;
            const inRecorder = c ? (c.id || 'unsaved-cassette') : (live ? (live.token || 'unsaved-cassette') : null);
            const cassettes = [];
            let liveSaved = false;
            for (const meta of await store.list()) {
                const record = await store.get(meta.id);
                if (!record) continue;
                let { data, positionMs, writeProtect, modified } = record;
                if (live && live.token === meta.id) {
                    if (!sameBytes(live.data, data)) {
                        data = live.data;
                        modified = Date.now();
                    }
                    ({ positionMs, writeProtect } = live);
                    liveSaved = true;
                }
                cassettes.push({
                    id: meta.id, label: record.label, colour: record.colour, writeProtect: !!writeProtect,
                    positionMs: positionMs || 0, created: record.created, modified, boxModified: record.modified, data,
                });
            }
            const unstored = live && !liveSaved ? live : ((!live && c && !c.id && c.data) ? c : null);
            if (unstored) {
                cassettes.push({
                    id: inRecorder, label: c ? c.label : '', colour: c ? c.colour : undefined,
                    writeProtect: !!unstored.writeProtect, positionMs: unstored.positionMs || 0,
                    modified: Date.now(), data: unstored.data,
                });
            }
            return { connected, parked: !!c && !live, cassette: inRecorder, cassettes };
        },

        /* Restores a saved session's tape recorder. Its cassettes join the
         * box: one the box holds unchanged is left as it is; one the box
         * holds other work on since the session was saved is added beside it
         * rather than over it (boxCopyMovedOn); any other is stored under its
         * own id. The cassette that was in the
         * recorder then goes back in at the place it was left, connected or
         * not as it was. A blank cassette is told from another by its label
         * as well, since every blank one holds the same bytes. */
        async sessionRestore(saved) {
            closePanel();
            // Whatever left the recorder before this is accounted for first.
            await emu.barrier();
            const box = [];
            for (const meta of await store.list()) {
                const r = await store.get(meta.id);
                if (r) box.push(r);
            }
            const ids = new Map();       // session id -> id in the box
            const unstored = new Map();  // session id -> cassette, where storage failed
            for (const c of saved.cassettes) {
                const sameId = c.id ? box.find(r => r.id === c.id) : null;
                const identical = (sameId && sameBytes(sameId.data, c.data)) ? sameId
                    : box.find(r => sameBytes(r.data, c.data) && ((r.label || '') === (c.label || '')));
                if (identical) {
                    ids.set(c.id, identical.id);
                    continue;
                }
                const keepBoth = sameId && boxCopyMovedOn(sameId, c);
                const ownId = (c.id && !c.id.startsWith('unsaved-') && !keepBoth) ? c.id : null;
                const id = await store.put({ ...c, id: ownId });
                if (id) ids.set(c.id, id); else unstored.set(c.id, c);
            }
            let record = null;
            const inRecorder = saved.cassette ? saved.cassettes.find(c => c.id === saved.cassette) : null;
            if (inRecorder && ids.has(inRecorder.id)) {
                // The place on the tape is the session's, as the rest of the machine is.
                const id = ids.get(inRecorder.id);
                await store.update(id, { positionMs: inRecorder.positionMs, writeProtect: inRecorder.writeProtect });
                record = await store.get(id);
            } else if (inRecorder && unstored.has(inRecorder.id)) {
                record = { ...inRecorder, id: null };
            }
            controller.state.cassette = record ? controller.keepMeta(record) : null;
            if (record && !record.id) {
                controller.state.cassette.data = new Uint8Array(record.data);
                controller.state.cassette.positionMs = record.positionMs || 0;
            }
            if (saved.connected) {
                // An opened tape from the session is in the recorder already; otherwise the cassette goes in.
                await controller.setConnected(true, { noInsert: true });
                if (record && !emu.tapeKind) await controller.insertRecord(record);
                else if (emu.tapeKind === 'game') controller.state.cassette = null;
            } else {
                await controller.setConnected(false);
            }
            controller.persist();
            controller.notify();
            // Without storage only the cassette in the recorder can be kept, and only while it is in.
            const recorderUnstored = !!(inRecorder && unstored.has(inRecorder.id));
            const dropped = unstored.size - (recorderUnstored ? 1 : 0);
            if (dropped) {
                alert(`This browser isn’t letting the emulator keep cassettes, so ${dropped} of the session’s cassettes ${dropped === 1 ? 'was' : 'were'} left out`
                    + (recorderUnstored ? ', and the one in the recorder lasts only until it is ejected or the page is reloaded.' : '.')
                    + ' Restore the session where the browser allows site storage to keep them all.');
            } else if (recorderUnstored) {
                controller.warnUnstored();
            }
        },
    };
}

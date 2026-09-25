/*
 * runtime/printer-ui.js — the ZX Printer beside the Spectrum.
 *
 * createPrinter(ui, emu) builds the printer standing to the right of the
 * Spectrum, joined to it by its cable, with the printout rising out of it up
 * to the top of the screen (visible = connected). Clicking the printer opens
 * its panel: the paper left on the roll, loading a new roll, and tearing off
 * or saving the printout. The FEED button on the printer feeds paper while
 * it is held down. The printer itself is emulated in generator/core.ts.in;
 * this side keeps the printout and measures the paper.
 */

import { DOCK_SCALE, RIBBON_PLUG_Y } from './microdrive-ui.js';
import closeIcon from './icons/close.svg';

const STATE_KEY = 'jsspeccy-zxprinter';
const ROLL_KEY = 'jsspeccy-zxprinter-roll';

/* The paper is 100mm wide and the 256 dots span the middle 92mm, so a dot is
 * 92/256mm across; each pass of the stylus feeds the paper one dot's height,
 * so a printed row is that tall too. A roll holds about 20m. */
const DOT_MM = 92 / 256;
const MARGIN_DOTS = 11;                     // the 4mm of paper beside the print
const PAPER_DOTS = 256 + (2 * MARGIN_DOTS); // 100mm
const ROLL_ROWS = Math.round(20000 / DOT_MM);
const LEAD_ROWS = Math.round(10 / DOT_MM);  // pulled through when a roll is loaded
const ROW_BYTES = 32;
const BLANK_ROW = new Uint8Array(ROW_BYTES);

/* The printer as seen from the front, two Microdrives wide and drawn in the
 * same units, scaled with them. The roll sits between the two side towers,
 * the paper leaves through a slot behind the smoked cutter bar, and FEED is
 * the button on top of the right tower. */
const PRINTER_W = 132, PRINTER_H = 72;
const PAPER_W = 78;                         // 100mm of paper
const PAPER_X = (PRINTER_W - PAPER_W) / 2;
const DOT_UNITS = PAPER_W / PAPER_DOTS;
const SLOT_Y = 38;
const BAR_Y = 33, BAR_H = 14;
const ROLL_BASE_Y = 36, ROLL_FULL_D = 28, ROLL_CORE_D = 7;
const CABLE_W = 26;
const TEAR_ROWS = 4;                        // depth of the serrated edge a tear leaves

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
function linearGradient(id, stops) {
    const g = svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
    for (const [offset, colour] of stops) g.appendChild(svgEl('stop', { offset, 'stop-color': colour }));
    return g;
}

const metres = (rows) => (rows * DOT_MM / 1000).toFixed(1);
const centimetres = (rows) => (rows * DOT_MM / 10).toFixed(1);

/* ==================== the paper ==================== */

/* Aluminium-coated paper: a silver sheen brightest down the middle, a faint
 * brushed streak per row, and dark grey where the stylus burned the coating
 * away. */
const SHEEN = new Float32Array(PAPER_DOTS);
for (let x = 0; x < PAPER_DOTS; x++) {
    const across = (x - (PAPER_DOTS / 2)) / (PAPER_DOTS / 2);
    SHEEN[x] = 188 + (30 * (1 - (across * across)));
}
const streak = (index) => {
    let h = (index * 2654435761) >>> 0;
    h ^= h >>> 15;
    return ((h & 7) - 3.5) * 1.2;
};
const tearDepth = (x) => 1 + Math.round(3 * Math.abs((x % 9) - 4.5) / 4.5);

/* Paints printout row `index` into ImageData `data` at byte `offset`. */
function paintRow(data, offset, row, index) {
    const shade = streak(index);
    for (let x = 0; x < PAPER_DOTS; x++) {
        const o = offset + (x * 4);
        if (index < TEAR_ROWS && index < tearDepth(x)) {
            data[o + 3] = 0;
            continue;
        }
        const d = x - MARGIN_DOTS;
        if (d >= 0 && d < 256 && (row[d >> 3] & (0x80 >> (d & 7)))) {
            data[o] = 46; data[o + 1] = 47; data[o + 2] = 53;
        } else {
            const v = SHEEN[x] + shade;
            data[o] = v - 3; data[o + 1] = v; data[o + 2] = v + 5;
        }
        data[o + 3] = 255;
    }
}

/* The printout as a PNG, at twice its dot size when that stays a sensible
 * size. Longer than a canvas can be, it keeps the most recent part. */
function printoutBlob(rows) {
    const MAX_ROWS = 32000;
    const first = Math.max(0, rows.length - MAX_ROWS);
    const count = rows.length - first;
    const src = el('canvas', {}, { width: PAPER_DOTS, height: count });
    const ctx = src.getContext('2d');
    const img = ctx.createImageData(PAPER_DOTS, count);
    for (let i = 0; i < count; i++) paintRow(img.data, i * PAPER_DOTS * 4, rows[first + i], first + i);
    ctx.putImageData(img, 0, 0);
    const zoom = count <= 8000 ? 2 : 1;
    let out = src;
    if (zoom > 1) {
        out = el('canvas', {}, { width: PAPER_DOTS * zoom, height: count * zoom });
        const octx = out.getContext('2d');
        octx.imageSmoothingEnabled = false;
        octx.drawImage(src, 0, 0, out.width, out.height);
    }
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}

/* ==================== the printer (dock art) ==================== */

let printerArtId = 0;

function buildPrinterArt() {
    const id = 'zxp' + (printerArtId++);
    const box = el('div', { position: 'relative', width: PRINTER_W + 'px', height: PRINTER_H + 'px', cursor: 'pointer' });
    box.title = 'ZX Printer';

    /* ---------- behind the paper: the recess and the roll ---------- */
    const back = svgEl('svg', { width: PRINTER_W, height: PRINTER_H, viewBox: `0 0 ${PRINTER_W} ${PRINTER_H}` });
    Object.assign(back.style, { position: 'absolute', left: '0', top: '0', overflow: 'visible' });
    const backDefs = svgEl('defs');
    backDefs.appendChild(linearGradient(id + 'roll', [[0, '#d4d5d2'], [0.35, '#fbfbf8'], [0.7, '#e6e6e2'], [1, '#a4a5a1']]));
    backDefs.appendChild(linearGradient(id + 'core', [[0, '#c9a06a'], [1, '#86653e']]));
    back.appendChild(backDefs);
    back.appendChild(svgEl('rect', { x: 14, y: 8, width: PRINTER_W - 28, height: 32, fill: '#0e0e10' }));
    back.appendChild(svgEl('rect', {
        x: PAPER_X, y: ROLL_BASE_Y - ROLL_CORE_D, width: PAPER_W, height: ROLL_CORE_D, rx: 2,
        fill: `url(#${id}core)`,
    }));
    const roll = svgEl('rect', { x: PAPER_X, width: PAPER_W, fill: `url(#${id}roll)`, stroke: '#8d8d8a', 'stroke-width': 0.3 });
    back.appendChild(roll);
    box.appendChild(back);

    /* ---------- the paper, rising from the slot ---------- */
    const paperWrap = el('div', {
        position: 'absolute', left: PAPER_X + 'px', width: PAPER_W + 'px',
        bottom: (PRINTER_H - SLOT_Y) + 'px', height: '0px', overflow: 'hidden',
    });
    const paper = el('canvas', { position: 'absolute', left: '0', bottom: '0', width: PAPER_W + 'px', display: 'block' });
    paper.width = PAPER_DOTS;
    paper.height = 1;
    paperWrap.appendChild(paper);
    box.appendChild(paperWrap);

    /* ---------- in front of the paper: body, towers, cutter bar ---------- */
    const front = svgEl('svg', { width: PRINTER_W, height: PRINTER_H, viewBox: `0 0 ${PRINTER_W} ${PRINTER_H}` });
    Object.assign(front.style, { position: 'absolute', left: '0', top: '0', overflow: 'visible' });
    const defs = svgEl('defs');
    defs.appendChild(linearGradient(id + 'body', [[0, '#2e2e31'], [1, '#18181a']]));
    defs.appendChild(linearGradient(id + 'tower', [[0, '#3b3b3f'], [1, '#232326']]));
    defs.appendChild(linearGradient(id + 'bar', [[0, 'rgba(210,214,218,0.55)'], [0.25, 'rgba(160,166,172,0.38)'], [1, 'rgba(120,126,132,0.45)']]));
    front.appendChild(defs);

    front.appendChild(svgEl('rect', { x: 0, y: SLOT_Y, width: PRINTER_W, height: PRINTER_H - SLOT_Y - 1, rx: 3, fill: `url(#${id}body)` }));
    front.appendChild(svgEl('rect', { x: 0.5, y: PRINTER_H - 1.6, width: PRINTER_W - 1, height: 0.8, fill: '#0a0a0b' }));
    for (const x of [1, PRINTER_W - 17]) {
        front.appendChild(svgEl('rect', { x, y: 4, width: 16, height: 40, rx: 2.5, fill: `url(#${id}tower)` }));
        front.appendChild(svgEl('rect', { x: x + 0.6, y: 4.3, width: 14.8, height: 1.4, rx: 0.7, fill: '#4b4b50' }));
    }

    const barX = 17, barW = PRINTER_W - 34;
    front.appendChild(svgEl('rect', { x: barX, y: BAR_Y, width: barW, height: BAR_H, fill: `url(#${id}bar)`, stroke: 'rgba(235,240,245,0.35)', 'stroke-width': 0.4 }));
    let teeth = `M ${barX} ${BAR_Y + 1.6}`;
    for (let x = barX; x < barX + barW; x += 1.6) teeth += ` L ${x + 0.8} ${BAR_Y} L ${Math.min(x + 1.6, barX + barW)} ${BAR_Y + 1.6}`;
    front.appendChild(svgEl('path', { d: teeth + ' Z', fill: '#a9adb2' }));
    const logo = svgEl('text', {
        x: barX + 4, y: BAR_Y + 11, 'font-family': '"Arial Rounded MT Bold", "Helvetica Rounded", Arial, sans-serif',
        'font-weight': 'bold', 'font-size': 7.5, fill: 'rgba(255,255,255,0.16)', stroke: 'rgba(0,0,0,0.3)', 'stroke-width': 0.2,
    });
    logo.textContent = 'sinclair';
    front.appendChild(logo);

    const name = svgEl('text', {
        x: barX, y: 60, 'font-family': 'Arial, Helvetica, sans-serif', 'font-weight': 'bold',
        'font-size': 5.2, 'letter-spacing': 0.3, fill: '#d23a32',
    });
    name.textContent = 'ZX PRINTER';
    front.appendChild(name);

    // Lit while the motor runs, whether the computer or FEED is driving it.
    const light = svgEl('circle', { cx: PRINTER_W - barX - 1.6, cy: 58.2, r: 1.6, fill: '#3a1210', stroke: '#000', 'stroke-width': 0.4 });
    front.appendChild(light);

    const feed = svgEl('g', { cursor: 'pointer' });
    const feedTitle = svgEl('title');
    feedTitle.textContent = 'FEED (hold to feed paper)';
    feed.appendChild(feedTitle);
    const feedCap = svgEl('rect', { x: PRINTER_W - 12.5, y: 9, width: 7, height: 5.5, rx: 1.2, fill: '#2d2d30', stroke: '#0b0b0c', 'stroke-width': 0.5 });
    const feedShine = svgEl('rect', { x: PRINTER_W - 11.8, y: 9.5, width: 5.6, height: 0.7, rx: 0.35, fill: '#48484d' });
    feed.append(feedCap, feedShine);
    front.appendChild(feed);
    box.appendChild(front);

    return {
        element: box,
        paperWrap,
        paper,
        feed,
        setRoll(rows) {
            const d = rows > 0 ? ROLL_CORE_D + ((ROLL_FULL_D - ROLL_CORE_D) * Math.sqrt(Math.min(1, rows / ROLL_ROWS))) : 0;
            roll.setAttribute('y', ROLL_BASE_Y - d);
            roll.setAttribute('height', d);
            roll.setAttribute('rx', Math.min(3, d / 2));
            roll.style.display = d ? '' : 'none';
        },
        setLight(on) {
            light.setAttribute('fill', on ? '#ff3b30' : '#3a1210');
            light.style.filter = on ? 'drop-shadow(0 0 2px #ff3b30)' : 'none';
        },
        setFeedPressed(pressed) {
            feedCap.setAttribute('fill', pressed ? '#1b1b1d' : '#2d2d30');
            feedShine.style.display = pressed ? 'none' : '';
        },
    };
}

/* The printer's cable: a round black lead from the back of the left tower
 * to an edge connector on the side of the Spectrum, its plug level with the
 * Microdrive ribbon's. */
function buildCable() {
    const W = CABLE_W, H = PRINTER_H, y = RIBBON_PLUG_Y, plugW = 5.5;
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    svg.style.display = 'block';
    svg.style.overflow = 'visible';
    const path = `M ${W + 2} 17 C ${W * 0.55} 18 ${W * 0.5} ${y} ${plugW + 1.5} ${y}`;
    svg.appendChild(svgEl('path', { d: path, fill: 'none', stroke: '#111113', 'stroke-width': 3.4, 'stroke-linecap': 'round' }));
    svg.appendChild(svgEl('path', { d: path, fill: 'none', stroke: '#3c3c41', 'stroke-width': 0.7, transform: 'translate(0 -0.8)' }));
    svg.appendChild(svgEl('rect', { x: plugW, y: y - 2.2, width: 2.6, height: 4.4, rx: 0.6, fill: '#222225' }));
    svg.appendChild(svgEl('rect', { x: 0, y: y - 6, width: plugW, height: 12, rx: 0.8, fill: '#151618', stroke: '#000', 'stroke-width': 0.4 }));
    return svg;
}

/* ==================== the printer panel ==================== */

function buildPanel(printer) {
    const panel = el('div', {
        position: 'absolute', width: '270px', background: '#1c1e22', color: '#eee',
        border: '1px solid #444', borderRadius: '8px', boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
        fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px', zIndex: '120', overflow: 'hidden',
    });
    const mkBtn = (label, title) => {
        const b = el('button', {
            border: 'none', background: '#333', color: '#ccc', borderRadius: '4px',
            padding: '4px 8px', cursor: 'pointer', fontSize: '11px',
        }, { textContent: label });
        if (title) b.title = title;
        return b;
    };
    const enable = (b, on) => {
        b.disabled = !on;
        b.style.opacity = on ? '1' : '0.45';
        b.style.cursor = on ? 'pointer' : 'default';
    };

    const header = el('div', {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px',
        background: '#25282e', borderBottom: '1px solid #333',
    });
    const title = el('div', { flex: '1', fontSize: '13px', fontWeight: 'bold' }, { textContent: 'ZX Printer' });
    const status = el('div', { fontSize: '11px', borderRadius: '4px', padding: '2px 6px' });
    const closeBtn = el('button', { border: 'none', background: 'none', cursor: 'pointer', flexShrink: '0' });
    closeBtn.innerHTML = closeIcon;
    closeBtn.style.filter = 'invert(1)';
    closeBtn.firstChild.style.height = '14px';
    closeBtn.title = 'Close';
    header.append(title, status, closeBtn);

    const body = el('div', { padding: '10px', lineHeight: '1.5' });
    const paperLine = el('div');
    const gauge = el('div', { height: '6px', background: '#333', borderRadius: '3px', overflow: 'hidden', margin: '4px 0 8px' });
    const gaugeFill = el('div', { height: '100%', background: '#c8ccd2' });
    gauge.appendChild(gaugeFill);
    const printoutLine = el('div');
    const hint = el('div', { color: '#888', fontSize: '11px', marginTop: '6px' });
    body.append(paperLine, gauge, printoutLine, hint);

    const footer = el('div', {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px',
        borderTop: '1px solid #333', background: '#1a1c20',
    });
    const feedBtn = mkBtn('Feed', 'Feed paper while held down, as the FEED button does');
    const tearBtn = mkBtn('Tear off', 'Tear the printout off at the serrated edge');
    const saveBtn = mkBtn('Save PNG', 'Save the printout to your computer as a picture');
    const rollBtn = mkBtn('New roll', 'Load a new 20m roll of paper');
    footer.append(feedBtn, tearBtn, saveBtn, el('div', { flex: '1' }), rollBtn);
    panel.append(header, body, footer);

    // A button that throws something away asks once more, and forgets
    // after a few seconds.
    const confirmFirst = (b, question, needed, action) => {
        const label = b.textContent;
        let timer = null;
        b.addEventListener('click', () => {
            if (timer || !needed()) {
                clearTimeout(timer);
                timer = null;
                b.textContent = label;
                action();
                return;
            }
            b.textContent = question;
            timer = setTimeout(() => { timer = null; b.textContent = label; }, 3000);
        });
    };

    confirmFirst(tearBtn, 'Tear off unsaved?', () => !printer.printoutSaved, () => printer.tearOff());
    confirmFirst(rollBtn, 'Replace roll?', () => printer.paper > 0, () => printer.newRoll());
    saveBtn.addEventListener('click', () => printer.save());
    printer.holdToFeed(feedBtn, feedBtn);

    const api = {
        element: panel,
        onClose: null,
        refresh() {
            const paper = printer.paper;
            const rows = printer.printoutRows;
            if (paper > 0) {
                paperLine.textContent = `Paper: ${metres(paper)} m of ${metres(ROLL_ROWS)} m left`;
            } else {
                paperLine.textContent = 'Out of paper';
            }
            gaugeFill.style.width = (100 * paper / ROLL_ROWS) + '%';
            printoutLine.textContent = rows ? `Printout: ${centimetres(rows)} cm` : 'No printout: it has been torn off';
            if (paper === 0) {
                status.textContent = 'Out of paper';
                Object.assign(status.style, { background: '#6b1d1d', color: '#fcc' });
                hint.textContent = 'Printing waits for paper. Load a new roll to carry on, or press BREAK to stop.';
            } else {
                status.textContent = printer.motor ? 'Printing' : 'Ready';
                Object.assign(status.style, printer.motor
                    ? { background: '#24452c', color: '#bfb' }
                    : { background: '#333', color: '#aaa' });
                hint.textContent = 'In BASIC: LPRINT, LLIST and COPY. Hold FEED on the printer to feed paper.';
            }
            enable(tearBtn, rows > 0);
            enable(saveBtn, rows > 0);
            enable(feedBtn, paper > 0 || printer.feeding);
        },
    };
    closeBtn.addEventListener('click', () => { if (api.onClose) api.onClose(); });
    return api;
}

/* ==================== the dock ==================== */

/* Whether the printer is connected is kept in localStorage, like the
 * Microdrive dock. The roll - the paper left on it and the printout - stays
 * with the browser session in sessionStorage: it survives a reload, and a new
 * session starts with a fresh roll. The printout is stored deflated, which
 * the browser does asynchronously, so for the last save as the page goes
 * away it is stored as it is instead, in runs. */
function loadConnected() {
    try {
        const saved = JSON.parse(localStorage.getItem(STATE_KEY));
        return !!(saved && saved.connected);
    } catch (e) {
        return false;
    }
}

function saveConnected(connected) {
    try {
        localStorage.setItem(STATE_KEY, JSON.stringify({ connected }));
    } catch (e) { /* private browsing / quota / disabled storage: just don't persist it */ }
}

/* The printout as runs: a number is that many blank rows, a string is base64
 * of consecutive inked rows, ROW_BYTES each. */
function encodePrintout(rows) {
    const runs = [];
    let i = 0;
    while (i < rows.length) {
        let j = i;
        if (rows[i] === BLANK_ROW) {
            while (j < rows.length && rows[j] === BLANK_ROW) j++;
            runs.push(j - i);
        } else {
            while (j < rows.length && rows[j] !== BLANK_ROW) j++;
            let binary = '';
            for (let k = i; k < j; k++) binary += String.fromCharCode.apply(null, rows[k]);
            runs.push(btoa(binary));
        }
        i = j;
    }
    return runs;
}

function decodePrintout(runs) {
    const rows = [];
    for (const run of runs) {
        if (typeof run === 'number') {
            for (let k = 0; k < run; k++) rows.push(BLANK_ROW);
        } else {
            const binary = atob(run);
            for (let k = 0; k + ROW_BYTES <= binary.length; k += ROW_BYTES) {
                const row = new Uint8Array(ROW_BYTES);
                for (let b = 0; b < ROW_BYTES; b++) row[b] = binary.charCodeAt(k + b);
                rows.push(row);
            }
        }
    }
    return rows;
}

/* The printout as its rows end to end, ROW_BYTES each, for deflating. */
function packPrintout(rows) {
    const bytes = new Uint8Array(rows.length * ROW_BYTES);
    for (let i = 0; i < rows.length; i++) {
        if (rows[i] !== BLANK_ROW) bytes.set(rows[i], i * ROW_BYTES);
    }
    return bytes;
}

function unpackPrintout(bytes) {
    const rows = [];
    for (let i = 0; i + ROW_BYTES <= bytes.length; i += ROW_BYTES) {
        const row = bytes.subarray(i, i + ROW_BYTES);
        rows.push(row.some(b => b) ? row.slice() : BLANK_ROW);
    }
    return rows;
}

const canDeflate = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function transform(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function loadRoll() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(ROLL_KEY));
        if (saved && Number.isFinite(saved.paper)) {
            let printout = null;
            if (typeof saved.deflated === 'string' && canDeflate) {
                printout = unpackPrintout(await transform(fromBase64(saved.deflated), new DecompressionStream('deflate-raw')));
            } else if (Array.isArray(saved.printout)) {
                printout = decodePrintout(saved.printout);
            }
            if (printout) {
                return { paper: Math.max(0, Math.min(ROLL_ROWS, saved.paper)), printout, saved: !!saved.saved };
            }
        }
    } catch (e) { /* unreadable: start afresh */ }
    // A fresh roll, with a lead of blank paper pulled through.
    return { paper: ROLL_ROWS - LEAD_ROWS, printout: new Array(LEAD_ROWS).fill(BLANK_ROW), saved: true };
}

/* Stores the roll deflated. `isCurrent` is asked before writing, so a save
 * that a newer one overtook while it was being deflated is dropped. Returns
 * whether it was written. */
async function saveRollDeflated(paper, printout, saved, isCurrent) {
    // Past the storage quota, the oldest part of the printout gives way.
    for (let keep = printout.length; ; keep = Math.floor(keep / 2)) {
        const packed = packPrintout(printout.slice(printout.length - keep));
        const deflated = toBase64(await transform(packed, new CompressionStream('deflate-raw')));
        if (!isCurrent()) return false;
        try {
            sessionStorage.setItem(ROLL_KEY, JSON.stringify({ paper, deflated, saved }));
            return true;
        } catch (e) {
            if (!keep) return false;  // storage unavailable altogether
        }
    }
}

/* Stores the roll straight away, in runs. */
function saveRoll(paper, printout, saved) {
    // Past the storage quota, the oldest part of the printout gives way.
    for (let keep = printout.length; ; keep = Math.floor(keep / 2)) {
        try {
            const rows = printout.slice(printout.length - keep);
            sessionStorage.setItem(ROLL_KEY, JSON.stringify({ paper, printout: encodePrintout(rows), saved }));
            return;
        } catch (e) {
            if (!keep) return;  // storage unavailable altogether
        }
    }
}

export function createPrinter(ui, emu) {
    // The paper count and printout come in once the stored roll is read.
    const state = { connected: loadConnected(), paper: 0 };

    // Sits to the right of the Spectrum, mirroring the Microdrive dock on the
    // left: the same scale, and the cable's plug level with the toolbar strip.
    const element = el('div', { position: 'absolute', zIndex: '90', left: '100%', transformOrigin: '0% 0%', display: 'none' });
    const inner = el('div', { display: 'flex', flexDirection: 'row', alignItems: 'flex-end' });
    element.appendChild(inner);
    const cable = buildCable();
    cable.style.pointerEvents = 'none';
    inner.appendChild(cable);
    const art = buildPrinterArt();
    inner.appendChild(art.element);
    ui.appContainer.appendChild(element);

    /* The printout, oldest row first, and whether it has been saved to the
     * PC since anything was last printed on it. */
    let printout = [];
    let printoutSaved = true;

    /* ---------- drawing the printout ---------- */
    const ctx = art.paper.getContext('2d');
    let visibleRows = 1;

    function redrawPaper() {
        const shown = Math.min(printout.length, visibleRows);
        ctx.clearRect(0, 0, PAPER_DOTS, visibleRows);
        if (!shown) return;
        const img = ctx.createImageData(PAPER_DOTS, shown);
        const first = printout.length - shown;
        for (let i = 0; i < shown; i++) paintRow(img.data, i * PAPER_DOTS * 4, printout[first + i], first + i);
        ctx.putImageData(img, 0, visibleRows - shown);
    }

    // New rows come in at the slot: the paper above moves up by as many.
    function addRows(count) {
        if (count >= visibleRows) { redrawPaper(); return; }
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(art.paper, 0, -count);
        ctx.globalCompositeOperation = 'source-over';
        const img = ctx.createImageData(PAPER_DOTS, count);
        const first = printout.length - count;
        for (let i = 0; i < count; i++) paintRow(img.data, i * PAPER_DOTS * 4, printout[first + i], first + i);
        ctx.putImageData(img, 0, visibleRows - count);
    }

    /* ---------- the panel ---------- */
    let panel = null;
    const panelResize = window.ResizeObserver ? new ResizeObserver(() => positionPanel()) : null;

    function closePanel() {
        if (!panel) return;
        releaseFeed();
        if (panelResize) panelResize.unobserve(panel.element);
        panel.element.remove();
        panel = null;
    }
    function positionPanel() {
        if (!panel) return;
        // Opens just above the printer, right edges aligned.
        const box = art.element.getBoundingClientRect();
        const container = ui.appContainer.getBoundingClientRect();
        const panelHeight = panel.element.offsetHeight || 160;
        panel.element.style.left = (box.right - container.left - panel.element.offsetWidth) + 'px';
        panel.element.style.top = (box.top - container.top - panelHeight - 6) + 'px';
    }
    function openPanel() {
        if (panel) return;
        panel = buildPanel(printer);
        panel.onClose = closePanel;
        ui.appContainer.appendChild(panel.element);
        panel.refresh();
        positionPanel();
        if (panelResize) panelResize.observe(panel.element);
    }
    const refreshPanel = () => { if (panel) panel.refresh(); };

    /* ---------- the feed ---------- */
    // Whichever FEED is held down lets go when its button goes away (the
    // panel closing, the dock hiding) or the pointer comes up anywhere, so
    // the feed can never be left running.
    let releaseHeldFeed = null;
    function releaseFeed() {
        if (releaseHeldFeed) releaseHeldFeed();
    }
    window.addEventListener('pointerup', releaseFeed);
    window.addEventListener('pointercancel', releaseFeed);

    /* ---------- the paper and the roll ---------- */
    // rollVersion counts changes to the roll and writtenVersion is the one
    // last stored; nothing is stored until the stored roll has been read.
    let rollReady = false;
    let rollVersion = 0, writtenVersion = 0;
    let lastSavedPaper = 0;
    let deflating = false, deflateAgain = false;

    async function storeRoll() {
        if (!canDeflate) {
            saveRoll(state.paper, printout, printoutSaved);
            writtenVersion = rollVersion;
            return;
        }
        if (deflating) { deflateAgain = true; return; }
        deflating = true;
        try {
            do {
                deflateAgain = false;
                const version = rollVersion;
                const written = await saveRollDeflated(state.paper, printout.slice(), printoutSaved, () => version > writtenVersion);
                if (written) writtenVersion = version;
            } while (deflateAgain);
        } catch (e) {
            console.warn('Could not store the printer roll:', e);
        } finally {
            deflating = false;
        }
    }

    function persist(force) {
        // The roll changes with every row printed, so it is written back only
        // every so often while printing, and whenever printing stops.
        if (!rollReady) return;
        rollVersion++;
        if (force || Math.abs(lastSavedPaper - state.paper) >= 500) {
            lastSavedPaper = state.paper;
            storeRoll();
        }
    }
    window.addEventListener('pagehide', () => {
        if (rollReady && writtenVersion < rollVersion) {
            saveRoll(state.paper, printout, printoutSaved);
            writtenVersion = rollVersion;
        }
    });

    const printer = {
        get paper() { return state.paper; },
        get motor() { return emu.printerMotor; },
        get printoutRows() { return printout.length; },
        get printoutSaved() { return printoutSaved || !printout.length; },
        get feeding() { return !!releaseHeldFeed; },
        tearOff() {
            printout = [];
            printoutSaved = true;
            redrawPaper();
            persist(true);
            refreshPanel();
        },
        newRoll() {
            state.paper = ROLL_ROWS;
            emu.setPrinterPaper(state.paper);
            art.setRoll(state.paper);
            persist(true);
            refreshPanel();
        },
        async save() {
            if (!printout.length) return;
            const blob = await printoutBlob(printout);
            if (!blob) return;
            const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
            const url = URL.createObjectURL(blob);
            const a = el('a', { display: 'none' }, { href: url, download: `zx-printout-${stamp}.png` });
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            printoutSaved = true;
            persist(true);
            refreshPanel();
        },
        // Makes `target` feed paper while it is held down, showing that on
        // `pressedEl` (the FEED button, or a panel button).
        holdToFeed(target, pressedEl) {
            let held = false;
            const release = () => {
                if (!held) return;
                held = false;
                releaseHeldFeed = null;
                emu.setPrinterFeed(false);
                if (pressedEl === art.feed) art.setFeedPressed(false); else pressedEl.style.background = '#333';
            };
            target.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (state.paper <= 0) return;
                held = true;
                releaseHeldFeed = release;
                if (target.setPointerCapture) target.setPointerCapture(e.pointerId);
                emu.setPrinterFeed(true);
                if (pressedEl === art.feed) art.setFeedPressed(true); else pressedEl.style.background = '#555';
            });
            target.addEventListener('pointerup', release);
            target.addEventListener('pointercancel', release);
            target.addEventListener('lostpointercapture', release);
            target.addEventListener('click', (e) => e.stopPropagation());
        },
    };

    printer.holdToFeed(art.feed, art.feed);
    art.setRoll(state.paper);
    art.element.addEventListener('click', () => {
        if (panel) closePanel(); else openPanel();
    });

    emu.on('printerOutput', (bytes) => {
        const count = bytes.length / ROW_BYTES;
        for (let i = 0; i < count; i++) {
            const row = bytes.subarray(i * ROW_BYTES, (i + 1) * ROW_BYTES);
            if (row.some(b => b)) {
                printout.push(row.slice());
                printoutSaved = false;
            } else {
                printout.push(BLANK_ROW);
            }
        }
        if (count) addRows(count);
        const ranOut = state.paper > 0 && emu.printerPaper === 0;
        state.paper = emu.printerPaper;
        art.setRoll(state.paper);
        art.setLight(emu.printerMotor);
        persist(!emu.printerMotor || ranOut);
        // Running out mid-print leaves the Spectrum waiting: say why.
        if (ranOut && state.connected && element.style.display !== 'none') openPanel();
        refreshPanel();
    });

    /* ---------- showing, hiding, placing ---------- */
    let fullscreen = false;
    function applyVisibility() {
        const show = state.connected && !fullscreen;
        element.style.display = show ? 'block' : 'none';
        if (!show) {
            releaseFeed();
            closePanel();
        }
        if (show) reposition();
    }

    function reposition() {
        if (element.style.display === 'none') return;
        const scale = DOCK_SCALE * (typeof ui.zoom === 'number' ? ui.zoom : 1);
        const bar = ui.toolbar.elem;
        const top = bar.offsetTop + (bar.offsetHeight / 2) - (RIBBON_PLUG_Y * scale);
        element.style.top = top + 'px';
        element.style.transform = `scale(${scale})`;
        // The paper reaches from the slot up to the top of the screen.
        const screenTop = emu.canvas.getBoundingClientRect().top - ui.appContainer.getBoundingClientRect().top;
        const height = Math.max(0, SLOT_Y + ((top - screenTop) / scale));
        art.paperWrap.style.height = height + 'px';
        const rows = Math.max(1, Math.ceil(height / DOT_UNITS));
        if (rows !== visibleRows) {
            visibleRows = rows;
            art.paper.height = rows;
            art.paper.style.height = (rows * DOT_UNITS) + 'px';
            redrawPaper();
        }
        positionPanel();
    }
    if (window.ResizeObserver) new ResizeObserver(reposition).observe(ui.appContainer);
    ui.on('setZoom', reposition);

    function setConnected(connected) {
        state.connected = connected;
        emu.setPrinter(connected);
        saveConnected(connected);
        applyVisibility();
    }

    const rollLoaded = loadRoll().then((roll) => {
        state.paper = roll.paper;
        lastSavedPaper = roll.paper;
        printout = roll.printout;
        printoutSaved = roll.saved;
        rollReady = true;
        art.setRoll(state.paper);
        redrawPaper();
        refreshPanel();
    });

    emu.onReady(() => {
        rollLoaded.then(() => {
            emu.setPrinterPaper(state.paper);
            if (state.connected) emu.setPrinter(true);
            applyVisibility();
        });
    });

    return {
        element,
        toggle() { setConnected(!state.connected); },
        setFullscreen(value) { fullscreen = value; applyVisibility(); },
    };
}

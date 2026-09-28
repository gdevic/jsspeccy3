/*
 * runtime/char-picker.js: recognises the characters on the Spectrum's
 * screen. Over the picture (not the border) the pointer is a pointing hand.
 * A click takes the 8x8 cell under it, on the Spectrum's 32x24 character
 * grid, and looks for its pattern, as drawn or inverted, among the 96
 * characters of the ROM's character set; a bubble beside the cell shows
 * what it found and the keys that type it, and a double-click presses them,
 * as the keyboard would, and closes the bubble soon after. Only a character typed by one key, alone or with
 * Caps Shift or Symbol Shift, is typed; one that needs extended mode is
 * shown but not typed. A space, a blank cell or a solid one, is passed
 * over, as the border is.
 */
import { SPECCY, speccyKeysForChar } from './keyboard.js';

// The picture's place on the 320x240 display, inside the border.
const PICTURE_X = 32;
const PICTURE_Y = 24;

/* How long a double-click holds its keys down: long enough for the ROM,
 * which scans the keyboard once a frame, to see them. */
const HOLD_MS = 80;

// How long the bubble stays open after a double-click has typed its character.
const TYPED_CLOSE_MS = 1000;

/* How long a click on the bubble's cell waits to close it, for a second
 * click that makes it a double-click and leaves it open. */
const CLICK_CLOSE_MS = 250;

// The ROM's characters that are not the ASCII ones at their codes.
const SPECCY_CHARS = { 0x5E: '↑', 0x60: '£', 0x7F: '©' };

// A key's name on the keyboard, where it differs from its name in SPECCY.
const KEY_LABELS = {
    ONE: '1', TWO: '2', THREE: '3', FOUR: '4', FIVE: '5',
    SIX: '6', SEVEN: '7', EIGHT: '8', NINE: '9', ZERO: '0',
    CAPS_SHIFT: 'CAPS SHIFT', SYMBOL_SHIFT: 'SYMBOL SHIFT',
};

// The Spectrum's rainbow, in the bright colours of the display's palette.
const RAINBOW = ['#ff4030', '#ffe850', '#50e010', '#50e0ff'];

const keyLabel = (key) => {
    const name = Object.keys(SPECCY).find(n => (SPECCY[n].row === key.row) && (SPECCY[n].mask === key.mask));
    return KEY_LABELS[name] || name;
};

const el = (tag, style, text) => {
    const e = document.createElement(tag);
    Object.assign(e.style, style);
    if (text !== undefined) e.textContent = text;
    return e;
};

/* The character of the ROM's set, `font` (8 bytes each from code 32), that
 * the 8 bytes `rows` draw, as {code, inverse}; null for none. */
function recognise(font, rows) {
    for (const inverse of [false, true]) {
        for (let code = 32; code < 128; code++) {
            const glyph = (code - 32) * 8;
            let row = 0;
            while ((row < 8) && (font[glyph + row] === (inverse ? ((~rows[row]) & 0xff) : rows[row]))) row++;
            if (row === 8) return { code, inverse };
        }
    }
    return null;
}

export class CharPicker {
    constructor(ui, emulator) {
        this.ui = ui;
        this.emulator = emulator;
        this.canvas = ui.canvas;
        this.shown = null;     // the cell the bubble is open on: {x, y, keys}
        this.parts = null;     // the bubble's elements, while it is open
        this.typing = false;
        this.closeTimer = null;  // closes the bubble in a moment, after a click on its cell or typing

        this.canvas.addEventListener('mousemove', (e) => {
            const pointing = this.isOn() && !this.ui.uiIsHidden && !!this.cellAt(e);
            this.canvas.style.cursor = pointing ? 'pointer' : '';
        });
        // A double-click selects nothing on the page.
        this.canvas.addEventListener('mousedown', (e) => {
            if (e.detail > 1) e.preventDefault();
        });
        this.canvas.addEventListener('click', (e) => {
            const cell = this.isOn() ? this.cellAt(e) : null;
            if (!cell) {
                this.close();
                return;
            }
            /* A click of its own on the bubble's cell closes it; the second
             * click of a double-click leaves it as the first opened it. */
            if (this.isShowing(cell)) {
                clearTimeout(this.closeTimer);
                this.closeTimer = (e.detail <= 1) ? setTimeout(() => this.close(), CLICK_CLOSE_MS) : null;
                return;
            }
            this.open(cell);
        });
        this.canvas.addEventListener('dblclick', (e) => {
            const cell = this.isOn() ? this.cellAt(e) : null;
            if (cell && this.isShowing(cell)) this.type();
        });

        ui.on('setZoom', () => this.close());
        emulator.on('powerOff', () => {
            this.canvas.style.cursor = '';
            this.close();
        });
        emulator.on('start', () => this.showHint());
        emulator.on('pause', () => this.showHint());

        this.onKeyDown = (e) => { if (e.key === 'Escape') this.close(); };
        // Caught on the way down, as some of the page's controls stop their clicks there.
        this.onDocumentClick = (e) => {
            if ((e.target !== this.canvas) && this.parts && !this.parts.bubble.contains(e.target)) this.close();
        };
        this.onResize = () => this.close();
    }

    // Switched off, the machine shows no picture to pick from.
    isOn() {
        return !this.emulator.isInitiallyPaused;
    }

    isShowing(cell) {
        return !!this.shown && (this.shown.x === cell.x) && (this.shown.y === cell.y);
    }

    /* The whole 320x240 display, in client coordinates: the canvas scales it
     * to fit its box and keeps its shape (object-fit: contain), so in
     * fullscreen it is centred with bars beside it. */
    displayRect() {
        const box = this.canvas.getBoundingClientRect();
        const scale = Math.min(box.width / 320, box.height / 240);
        return {
            left: box.left + ((box.width - (320 * scale)) / 2),
            top: box.top + ((box.height - (240 * scale)) / 2),
            scale,
        };
    }

    // The character cell under the mouse event `e`, as {x, y}; null over the border.
    cellAt(e) {
        const display = this.displayRect();
        const x = Math.floor((((e.clientX - display.left) / display.scale) - PICTURE_X) / 8);
        const y = Math.floor((((e.clientY - display.top) / display.scale) - PICTURE_Y) / 8);
        return ((x >= 0) && (x < 32) && (y >= 0) && (y < 24)) ? { x, y } : null;
    }

    open(cell) {
        this.close();
        const bitmap = this.emulator.displayHandler.renderer.screenBitmap;
        const rows = [];
        for (let row = 0; row < 8; row++) rows.push(bitmap[((((cell.y * 8) + row) * 32) + cell.x)]);
        const font = this.emulator.romFont;
        const found = font ? recognise(font, rows) : null;
        if (found && (found.code === 32)) return;
        const ch = found ? (SPECCY_CHARS[found.code] || String.fromCharCode(found.code)) : null;
        const keys = ch ? speccyKeysForChar(ch) : null;
        this.shown = { x: cell.x, y: cell.y, keys };

        const home = this.ui.appContainer;
        const highlight = el('div', {
            position: 'absolute', zIndex: '4', pointerEvents: 'none', boxSizing: 'border-box',
            border: '2px solid #fff', borderRadius: '2px',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.8), 0 0 8px 2px rgba(255,232,80,0.8)',
        });
        home.appendChild(highlight);

        const bubble = el('div', {
            position: 'absolute', zIndex: '5', visibility: 'hidden', userSelect: 'none',
            fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px', color: '#eee', whiteSpace: 'nowrap',
        });
        const panel = el('div', {
            position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', gap: '10px',
            padding: '8px 30px 8px 8px', borderRadius: '6px',
            background: 'linear-gradient(#262626, #111)', border: '1px solid #000',
            boxShadow: '0 4px 14px rgba(0,0,0,0.55)',
        });
        bubble.appendChild(panel);

        // The rainbow across the bubble's corner, as across the Spectrum's.
        const stripes = RAINBOW.map((colour, i) => `${colour} ${56 + (i * 8)}% ${64 + (i * 8)}%`).join(', ');
        panel.appendChild(el('div', {
            position: 'absolute', right: '0', bottom: '0', width: '36px', height: '36px', pointerEvents: 'none',
            background: `linear-gradient(135deg, transparent 56%, ${stripes}, transparent 88%)`,
        }));

        // The cell as it is on the screen, magnified, with its pixel grid.
        const glyph = el('div', { position: 'relative', flex: 'none', width: '64px', height: '64px', border: '1px solid #555' });
        const magnified = document.createElement('canvas');
        magnified.width = 8;
        magnified.height = 8;
        magnified.getContext('2d').drawImage(this.canvas, PICTURE_X + (cell.x * 8), PICTURE_Y + (cell.y * 8), 8, 8, 0, 0, 8, 8);
        Object.assign(magnified.style, { display: 'block', width: '64px', height: '64px', imageRendering: 'pixelated' });
        glyph.appendChild(magnified);
        glyph.appendChild(el('div', {
            position: 'absolute', inset: '0',
            background: [
                'repeating-linear-gradient(90deg, rgba(128,128,128,0.35) 0 1px, transparent 1px 8px)',
                'repeating-linear-gradient(0deg, rgba(128,128,128,0.35) 0 1px, transparent 1px 8px)',
            ].join(', '),
        }));
        panel.appendChild(glyph);

        const text = el('div', { display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' });
        panel.appendChild(text);
        const keycaps = [];
        if (found) {
            const title = el('div', { display: 'flex', alignItems: 'baseline', gap: '8px' });
            title.appendChild(el('span', {
                fontFamily: '"Courier New", monospace', fontWeight: 'bold', lineHeight: '1',
                fontSize: '26px', color: '#fff',
            }, ch));
            title.appendChild(el('span', { fontFamily: 'monospace', fontSize: '11px', color: '#aaa' }, `CHR$ ${found.code}`));
            if (found.inverse) {
                title.appendChild(el('span', {
                    fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.5px',
                    padding: '1px 4px', borderRadius: '3px', background: '#eee', color: '#111',
                }, 'INVERSE'));
            }
            text.appendChild(title);
            if (keys) {
                const row = el('div', { display: 'flex', alignItems: 'center', gap: '3px' });
                keys.forEach((key, i) => {
                    if (i > 0) row.appendChild(el('span', { color: '#888' }, '+'));
                    const cap = el('span', {
                        padding: '2px 5px', borderRadius: '3px', fontSize: '10px', fontWeight: 'bold',
                        background: '#3a3a3a', color: '#fff', border: '1px solid #5a5a5a', borderBottom: '3px solid #1a1a1a',
                        transition: 'background 60ms, color 60ms, transform 60ms',
                    }, keyLabel(key));
                    keycaps.push(cap);
                    row.appendChild(cap);
                });
                text.appendChild(row);
            }
        } else {
            text.appendChild(el('div', { fontSize: '13px', fontWeight: 'bold', color: '#fff' }, 'Not a ROM character'));
            const hex = rows.map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
            text.appendChild(el('div', { fontFamily: 'monospace', fontSize: '11px', color: '#aaa' }, hex));
        }
        const hint = el('div', { fontSize: '10px', color: '#999' });
        text.appendChild(hint);

        const arrow = el('div', {
            position: 'absolute', width: '10px', height: '10px', marginLeft: '-6px', transform: 'rotate(45deg)',
        });
        bubble.appendChild(arrow);
        home.appendChild(bubble);

        this.parts = { highlight, bubble, arrow, panel, keycaps, hint };
        this.showHint();
        bubble.style.visibility = 'visible';

        const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!reduceMotion && bubble.animate) {
            bubble.animate(
                [{ opacity: 0, transform: 'scale(0.85)' }, { opacity: 1, transform: 'scale(1)' }],
                { duration: 120, easing: 'ease-out' }
            );
        }

        document.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('resize', this.onResize);
        // Deferred, so the click opening the bubble does not reach it.
        setTimeout(() => { if (this.parts) document.addEventListener('click', this.onDocumentClick, true); }, 0);
    }

    /* Puts the outline on the bubble's cell, and the bubble above the cell
     * if it fits there in the part of the display in the window, otherwise
     * below it, or wherever there is more room; across, centred on the cell
     * and kept inside that part of the display. */
    place() {
        const { highlight, bubble, arrow } = this.parts;
        const homeBox = this.ui.appContainer.getBoundingClientRect();
        const display = this.displayRect();
        const displayLeft = display.left - homeBox.left;
        const displayTop = display.top - homeBox.top;
        const size = 8 * display.scale;
        const cellLeft = displayLeft + ((PICTURE_X + (this.shown.x * 8)) * display.scale);
        const cellTop = displayTop + ((PICTURE_Y + (this.shown.y * 8)) * display.scale);
        Object.assign(highlight.style, {
            left: (cellLeft - 2) + 'px', top: (cellTop - 2) + 'px',
            width: (size + 4) + 'px', height: (size + 4) + 'px',
        });

        // The page may be scrolled so that only part of the display is in the window.
        const view = document.documentElement;
        const top = Math.max(displayTop, -homeBox.top);
        const bottom = Math.min(displayTop + (240 * display.scale), view.clientHeight - homeBox.top);
        const left = Math.max(displayLeft, -homeBox.left);
        const right = Math.min(displayLeft + (320 * display.scale), view.clientWidth - homeBox.left);

        // Measured at the container's edge, where nothing narrows it.
        Object.assign(bubble.style, { left: '0', top: '0' });
        const GAP = 8;
        const width = bubble.offsetWidth;
        const height = bubble.offsetHeight;
        const roomAbove = cellTop - top;
        const roomBelow = bottom - (cellTop + size);
        const above = ((roomAbove >= (height + GAP)) || (roomAbove > roomBelow));
        const middle = cellLeft + (size / 2);
        const bubbleLeft = Math.max(left + 4, Math.min(middle - (width / 2), right - 4 - width));
        Object.assign(bubble.style, {
            left: bubbleLeft + 'px',
            top: (above ? (cellTop - GAP - height) : (cellTop + size + GAP)) + 'px',
            transformOrigin: `${middle - bubbleLeft}px ${above ? '100%' : '0%'}`,
        });
        // The arrow's colour is the panel's at that edge.
        const edge = '1px solid #000';
        Object.assign(arrow.style, { left: Math.max(10, Math.min(middle - bubbleLeft, width - 10)) + 'px' }, above
            ? { top: '', bottom: '-5px', borderTop: 'none', borderLeft: 'none', borderBottom: edge, borderRight: edge, background: '#111' }
            : { top: '-5px', bottom: '', borderTop: edge, borderLeft: edge, borderBottom: 'none', borderRight: 'none', background: '#262626' });
    }

    close() {
        clearTimeout(this.closeTimer);
        this.closeTimer = null;
        if (!this.parts) return;
        this.parts.highlight.remove();
        this.parts.bubble.remove();
        this.parts = null;
        this.shown = null;
        document.removeEventListener('keydown', this.onKeyDown);
        document.removeEventListener('click', this.onDocumentClick, true);
        window.removeEventListener('resize', this.onResize);
    }

    /* A paused machine's ROM never sees a key, and with the keyboard off
     * the emulator takes none. */
    canType() {
        return this.emulator.keyboardEnabled && this.emulator.isRunning;
    }

    showHint() {
        if (!this.parts) return;
        let hint = '';
        if (this.shown.keys && this.emulator.keyboardEnabled) {
            hint = this.emulator.isRunning ? 'Double-click to type it' : 'Resume the machine to type it';
        }
        this.parts.hint.textContent = hint;
        this.parts.hint.style.display = hint ? '' : 'none';
        // The hint's length changes the bubble's width.
        this.place();
    }

    // Presses the keys that type the bubble's character, and shows them going down.
    type() {
        const keys = this.shown.keys;
        if (!keys || this.typing || !this.canType()) return;
        this.typing = true;
        // The keys are the next typed, which lets a shift latched on the on-screen keyboard go.
        this.ui.emit('typeCharacter');
        const { keycaps, panel } = this.parts;
        const press = (down) => keycaps.forEach(cap => Object.assign(cap.style, down
            ? { background: '#ffe850', color: '#000', transform: 'translateY(2px)' }
            : { background: '#3a3a3a', color: '#fff', transform: '' }));
        keys.forEach(key => this.emulator.keyDown(key.row, key.mask));
        press(true);
        if (panel.animate) {
            panel.animate(
                [{ boxShadow: '0 0 0 2px #ffe850, 0 0 16px 4px rgba(255,232,80,0.7)' }, { boxShadow: '0 4px 14px rgba(0,0,0,0.55)' }],
                { duration: 400, easing: 'ease-out' }
            );
        }
        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => this.close(), TYPED_CLOSE_MS);
        setTimeout(() => {
            keys.slice().reverse().forEach(key => this.emulator.keyUp(key.row, key.mask));
            press(false);
            this.typing = false;
        }, HOLD_MS);
    }
}

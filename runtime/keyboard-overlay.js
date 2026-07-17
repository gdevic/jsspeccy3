/*
 * runtime/keyboard-overlay.js — an on-screen, clickable ZX Spectrum keyboard.
 *
 * Renders the keyboard reference image (scaled to the emulator display width)
 * with a transparent clickable region over every key. Clicking a key sends the
 * matching keyDown/keyUp to the emulator via its keyboard matrix (row/mask).
 *
 * CAPS SHIFT / SYMBOL SHIFT are sticky: a single click latches the shift down
 * (staying down so the user can pick any of a key's legends). A latched shift
 * releases automatically after the next non-shift key is clicked, or when the
 * shift is clicked again. CAPS and SYMBOL latch independently, so both can be
 * held at once. Holding a physical modifier while clicking also works, matching
 * the emulator's native keys: Shift → CAPS SHIFT, Ctrl → SYMBOL SHIFT (read from
 * the click, so it works regardless of focus). A pressed key is slightly dimmed
 * on the image for feedback.
 *
 * Key boxes were measured from the image (percentages of its size, so they
 * scale with it); the row/mask values match runtime/keyboard.js (SPECCY).
 */

const CAPS = { row: 0, mask: 0x01 };
const SYM = { row: 7, mask: 0x02 };

// name, matrix row/mask, and [left%, top%, width%, height%] box on the image.
const KEY_LAYOUT = [
    { name: 'ONE', row: 3, mask: 0x01, box: [3.2, 13.82, 6.33, 11.02] },
    { name: 'TWO', row: 3, mask: 0x02, box: [12.19, 13.65, 6.33, 11.18] },
    { name: 'THREE', row: 3, mask: 0x04, box: [21.17, 13.65, 6.33, 11.18] },
    { name: 'FOUR', row: 3, mask: 0x08, box: [30.16, 13.65, 6.33, 11.18] },
    { name: 'FIVE', row: 3, mask: 0x10, box: [39.14, 13.65, 6.33, 11.18] },
    { name: 'SIX', row: 4, mask: 0x10, box: [48.13, 13.65, 6.33, 11.18] },
    { name: 'SEVEN', row: 4, mask: 0x08, box: [57.11, 13.65, 6.33, 11.18] },
    { name: 'EIGHT', row: 4, mask: 0x04, box: [66.03, 13.82, 6.33, 11.02] },
    { name: 'NINE', row: 4, mask: 0x02, box: [74.88, 13.82, 6.33, 11.02] },
    { name: 'ZERO', row: 4, mask: 0x01, box: [83.59, 13.82, 6.33, 11.02] },
    { name: 'Q', row: 2, mask: 0x01, box: [7.9, 35.86, 6.33, 11.02] },
    { name: 'W', row: 2, mask: 0x02, box: [16.88, 35.86, 6.33, 11.02] },
    { name: 'E', row: 2, mask: 0x04, box: [25.87, 35.86, 6.33, 11.02] },
    { name: 'R', row: 2, mask: 0x08, box: [34.85, 35.86, 6.33, 11.02] },
    { name: 'T', row: 2, mask: 0x10, box: [43.84, 35.86, 6.33, 11.02] },
    { name: 'Y', row: 5, mask: 0x10, box: [52.83, 35.86, 6.33, 11.02] },
    { name: 'U', row: 5, mask: 0x08, box: [61.81, 35.86, 6.33, 11.02] },
    { name: 'I', row: 5, mask: 0x04, box: [70.66, 35.86, 6.33, 11.02] },
    { name: 'O', row: 5, mask: 0x02, box: [79.65, 35.86, 6.33, 11.02] },
    { name: 'P', row: 5, mask: 0x01, box: [88.29, 35.86, 6.33, 11.02] },
    { name: 'A', row: 1, mask: 0x01, box: [10.55, 57.57, 6.33, 11.02] },
    { name: 'S', row: 1, mask: 0x02, box: [19.54, 57.57, 6.33, 11.02] },
    { name: 'D', row: 1, mask: 0x04, box: [28.52, 57.57, 6.33, 11.02] },
    { name: 'F', row: 1, mask: 0x08, box: [37.51, 57.57, 6.33, 11.02] },
    { name: 'G', row: 1, mask: 0x10, box: [46.49, 57.57, 6.33, 11.02] },
    { name: 'H', row: 6, mask: 0x10, box: [55.48, 57.57, 6.33, 11.02] },
    { name: 'J', row: 6, mask: 0x08, box: [64.47, 57.57, 6.33, 11.02] },
    { name: 'K', row: 6, mask: 0x04, box: [73.45, 57.57, 6.33, 11.02] },
    { name: 'L', row: 6, mask: 0x02, box: [82.16, 57.57, 6.33, 11.02] },
    { name: 'ENTER', row: 6, mask: 0x01, box: [90.95, 57.57, 6.33, 11.02] },
    { name: 'CAPS_SHIFT', row: 0, mask: 0x01, box: [4.29, 79.44, 7.83, 11.18] },
    { name: 'Z', row: 0, mask: 0x02, box: [14.91, 79.61, 6.33, 11.02] },
    { name: 'X', row: 0, mask: 0x04, box: [23.89, 79.61, 6.33, 11.02] },
    { name: 'C', row: 0, mask: 0x08, box: [32.88, 79.61, 6.33, 11.02] },
    { name: 'V', row: 0, mask: 0x10, box: [41.87, 79.61, 6.33, 11.02] },
    { name: 'B', row: 7, mask: 0x10, box: [50.85, 79.61, 6.33, 11.02] },
    { name: 'N', row: 7, mask: 0x08, box: [59.84, 79.61, 6.33, 11.02] },
    { name: 'M', row: 7, mask: 0x04, box: [68.82, 79.61, 6.33, 11.02] },
    { name: 'SYMBOL_SHIFT', row: 7, mask: 0x02, box: [77.74, 79.61, 6.33, 11.02] },
    { name: 'BREAK_SPACE', row: 7, mask: 0x01, box: [86.59, 79.61, 10.69, 11.02] },
];

const DIM_PRESSED = 'rgba(0, 0, 0, 0.32)';
const DIM_LOCKED = 'rgba(40, 70, 200, 0.38)';

export function createKeyboardOverlay(emu, imageUrl) {
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.style.width = '100%';       // appContainer is sized to the display width
    container.style.lineHeight = '0';      // no gap under the image
    container.style.display = 'none';      // hidden until toggled on
    container.style.userSelect = 'none';
    container.style.touchAction = 'none';

    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = 'ZX Spectrum keyboard';
    img.draggable = false;
    img.style.width = '100%';
    img.style.display = 'block';
    container.appendChild(img);

    // Sticky one-shot state for the two shift keys. A single click LATCHES the
    // modifier down (so the user can select any of a key's legends); it releases
    // after the next non-modifier key, or when the modifier is clicked again.
    // CAPS and SYMBOL latch independently, so both can be set at once.
    let capsLatched = false;
    let symLatched = false;
    let capsEl = null;
    let symEl = null;

    const dim = (el, mode) => {
        // mode: 'pressed' | 'latched' | null
        el.style.backgroundColor =
            mode === 'latched' ? DIM_LOCKED : (mode === 'pressed' ? DIM_PRESSED : 'transparent');
    };

    const setLatched = (which, on) => {
        if (which === 'caps') {
            if (capsLatched === on) return;
            capsLatched = on;
            if (capsEl) dim(capsEl, on ? 'latched' : null);
            if (on) emu.keyDown(CAPS.row, CAPS.mask); else emu.keyUp(CAPS.row, CAPS.mask);
        } else {
            if (symLatched === on) return;
            symLatched = on;
            if (symEl) dim(symEl, on ? 'latched' : null);
            if (on) emu.keyDown(SYM.row, SYM.mask); else emu.keyUp(SYM.row, SYM.mask);
        }
    };
    const clearLatched = () => {
        setLatched('caps', false);
        setLatched('sym', false);
    };

    for (const key of KEY_LAYOUT) {
        const el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.left = key.box[0] + '%';
        el.style.top = key.box[1] + '%';
        el.style.width = key.box[2] + '%';
        el.style.height = key.box[3] + '%';
        el.style.borderRadius = '6px';
        el.style.cursor = 'pointer';
        el.style.backgroundColor = 'transparent';
        el.title = key.name.replace('_', ' ');
        container.appendChild(el);

        const isCaps = (key.name === 'CAPS_SHIFT');
        const isSym = (key.name === 'SYMBOL_SHIFT');

        if (isCaps || isSym) {
            const which = isCaps ? 'caps' : 'sym';
            if (isCaps) capsEl = el; else symEl = el;
            // Single click toggles this shift's sticky latch.
            el.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                setLatched(which, !(isCaps ? capsLatched : symLatched));
            });
        } else {
            let held = false;
            let tCaps = false;
            let tSym = false;
            el.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                try { el.setPointerCapture(e.pointerId); } catch (_) {}
                held = true;
                emu.keyDown(key.row, key.mask);   // any latched shift is already down -> combo
                dim(el, 'pressed');
                // physical modifiers held during the click, matching the emulator's
                // native keys: Shift -> CAPS SHIFT, Ctrl -> SYMBOL SHIFT.
                tCaps = e.shiftKey && !capsLatched;
                tSym = e.ctrlKey && !symLatched;
                if (tCaps) emu.keyDown(CAPS.row, CAPS.mask);
                if (tSym) emu.keyDown(SYM.row, SYM.mask);
            });
            const release = () => {
                if (!held) return;
                held = false;
                emu.keyUp(key.row, key.mask);
                dim(el, null);
                if (tCaps) { emu.keyUp(CAPS.row, CAPS.mask); tCaps = false; }
                if (tSym) { emu.keyUp(SYM.row, SYM.mask); tSym = false; }
                clearLatched();   // one-shot: latched CAPS/SYMBOL release after this key
            };
            el.addEventListener('pointerup', release);
            el.addEventListener('pointercancel', release);
        }
    }

    return {
        element: container,
        show() { container.style.display = 'block'; },
        hide() { container.style.display = 'none'; },
        isVisible() { return container.style.display !== 'none'; },
    };
}

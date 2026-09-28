/*
 * runtime/keyboard-overlay.js — an on-screen, clickable ZX Spectrum keyboard.
 *
 * Renders the keyboard reference image (scaled to the emulator display width)
 * and sends the emulator the keys clicked on it, through its keyboard matrix
 * (row/mask). Every legend printed on the image can be clicked, not only the
 * caps: hovering one highlights it, and clicking it presses the shifts and
 * modes that enter it and lets them go again. The highlight shows what a
 * click enters in the ROM's editor as it stands (see
 * runtime/keyboard-legends.js): a legend it would not take does not react.
 * Each legend is hit across its key's whole column, not only over its text.
 * A line under the image names what is under the pointer and the keys it
 * presses, and is empty with nothing there.
 *
 * A legend entered by one chord (DELETE, the arrows, a Symbol Shift
 * character) is held for as long as the button is, so the ROM repeats it and
 * a game sees it held; one taking several (anything through extended or
 * graphics mode, or a keyword spelled out) is typed as a sequence, and clicks
 * made meanwhile queue behind it. Holding Shift while clicking a colour gives
 * its INK rather than its PAPER, and a block graphic inverted.
 *
 * CAPS SHIFT / SYMBOL SHIFT are sticky: a single click latches the shift down
 * (staying down so the user can pick any of a key's legends). A latched shift
 * releases automatically after the next non-shift key is clicked, or when the
 * shift is clicked again. CAPS and SYMBOL latch independently, so both can be
 * held at once. Holding a physical modifier while clicking a key also works,
 * matching the emulator's native keys: Shift → CAPS SHIFT, Ctrl → SYMBOL SHIFT
 * (read from the click, so it works regardless of focus). A pressed key is
 * slightly dimmed on the image for feedback.
 */
import { SPECCY, KEY_HOLD_MS, KEY_GAP_MS } from './keyboard.js';
import { KEY_LAYOUT, partAt, partText, partBox, plainPart, planLegend, chordLabel } from './keyboard-legends.js';

const CAPS = SPECCY.CAPS_SHIFT;
const SYM = SPECCY.SYMBOL_SHIFT;

const DIM_PRESSED = 'rgba(0, 0, 0, 0.32)';
const DIM_LOCKED = 'rgba(40, 70, 200, 0.38)';

// The highlight reaches this far past a legend's text, in percent of the image.
const HIGHLIGHT_PAD_X = 0.4;
const HIGHLIGHT_PAD_Y = 0.9;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const el = (tag, style, text) => {
    const e = document.createElement(tag);
    Object.assign(e.style, style);
    if (text !== undefined) e.textContent = text;
    return e;
};

// A key as the char picker's bubble shows one (see char-picker.js).
const keycap = (text) => el('span', {
    padding: '1px 5px', borderRadius: '3px', fontSize: '10px', fontWeight: 'bold', whiteSpace: 'nowrap',
    background: '#3a3a3a', color: '#fff', border: '1px solid #5a5a5a', borderBottom: '3px solid #1a1a1a',
}, text);

export function createKeyboardOverlay(emu, imageUrl) {
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.style.width = '100%';       // appContainer is sized to the display width
    container.style.lineHeight = '0';      // no gap under the image
    container.style.display = 'none';      // hidden until toggled on
    container.style.userSelect = 'none';
    container.style.touchAction = 'none';

    // The image and everything placed on it, in percent of its size.
    const stage = el('div', { position: 'relative' });
    container.appendChild(stage);

    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = 'ZX Spectrum keyboard';
    img.draggable = false;
    img.style.width = '100%';
    img.style.display = 'block';
    stage.appendChild(img);

    const highlight = el('div', {
        position: 'absolute', display: 'none', pointerEvents: 'none', borderRadius: '4px',
        transition: 'left 60ms, top 60ms, width 60ms, height 60ms',
    });
    stage.appendChild(highlight);

    const status = el('div', {
        display: 'flex', alignItems: 'center', gap: '5px', height: '24px', padding: '0 10px', overflow: 'hidden',
        background: '#000', color: '#999', lineHeight: 'normal', whiteSpace: 'nowrap',
        fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px',
    });
    container.appendChild(status);

    // A shade over each cap, for a key pressed or a shift latched; by matrix place, as keys come as copies too.
    const shades = new Map();
    const place = (key) => `${key.row}:${key.mask}`;
    for (const layout of KEY_LAYOUT) {
        const shade = el('div', {
            position: 'absolute', pointerEvents: 'none', borderRadius: '6px', backgroundColor: 'transparent',
            left: layout.box[0] + '%', top: layout.box[1] + '%', width: layout.box[2] + '%', height: layout.box[3] + '%',
        });
        stage.appendChild(shade);
        shades.set(place(SPECCY[layout.name]), shade);
    }

    // Sticky one-shot state for the two shift keys. A single click LATCHES the
    // modifier down (so the user can select any of a key's legends); it releases
    // after the next non-modifier key, or when the modifier is clicked again.
    // CAPS and SYMBOL latch independently, so both can be set at once.
    const latched = { caps: false, sym: false };

    const dim = (key, mode) => {
        // mode: 'pressed' | 'latched' | null
        shades.get(place(key)).style.backgroundColor =
            mode === 'latched' ? DIM_LOCKED : (mode === 'pressed' ? DIM_PRESSED : 'transparent');
    };
    // A key let go shows as latched again if it is a latched shift.
    const undim = (key) => dim(key, ((place(key) === place(CAPS)) && latched.caps) || ((place(key) === place(SYM)) && latched.sym) ? 'latched' : null);

    const setLatched = (which, on) => {
        if (latched[which] === on) return;
        latched[which] = on;
        const key = (which === 'caps') ? CAPS : SYM;
        dim(key, on ? 'latched' : null);
        if (on) emu.keyDown(key.row, key.mask); else emu.keyUp(key.row, key.mask);
        refresh();
    };
    const clearLatched = () => {
        setLatched('caps', false);
        setLatched('sym', false);
    };
    // The emulator let every key go (on pause, or focus leaving): the latches are up already.
    emu.on('keysReleased', () => {
        latched.caps = false;
        latched.sym = false;
        undim(CAPS);
        undim(SYM);
        refresh();
    });
    // With the keyboard turned off (the keyboardEnabled option), the keys do nothing.
    const enabled = () => emu.keyboardEnabled;
    // A paused machine's ROM sees no key, so nothing is typed into it.
    const canType = () => emu.keyboardEnabled && emu.isRunning;

    /* ---- What is under the pointer ---- */

    let pointer = null;  // {x, y} in percent of the image, while over it
    let shiftHeld = false;  // the PC's Shift, at the pointer's last move

    const pointAt = (e) => {
        const rect = stage.getBoundingClientRect();
        return { x: ((e.clientX - rect.left) * 100) / rect.width, y: ((e.clientY - rect.top) * 100) / rect.height };
    };

    /* What a click at `at` does, as {name, entry, part, shown, plan}: a key
     * pressed alone (plan null) or a legend's plan; shown is the part of the
     * entry that shows what it enters, or null for nothing. Null over no key. */
    const targetAt = (at) => {
        const editor = emu.editorState;
        const hit = at && partAt(at.x, at.y, editor);
        if (!hit) return null;
        const plain = (hit.part === 'cap') || (hit.part === 'main') || ((hit.part === 'keyword') && (editor.kind !== 128));
        if (plain) return { ...hit, shown: plainPart(hit.entry, editor, latched), plan: null };
        const plan = planLegend(hit.name, hit.entry, hit.part, editor, shiftHeld);
        return plan ? { ...hit, shown: hit.part, plan } : null;
    };

    const showHighlight = (target) => {
        if (!target || !target.shown) {
            highlight.style.display = 'none';
            return;
        }
        const box = partBox(target.name, target.entry, target.shown);
        const pad = (target.shown === 'cap') ? [0, 0] : [HIGHLIGHT_PAD_X, HIGHLIGHT_PAD_Y];
        Object.assign(highlight.style, {
            display: 'block',
            left: (box[0] - pad[0]) + '%', top: (box[1] - pad[1]) + '%',
            width: (box[2] + (2 * pad[0])) + '%', height: (box[3] + (2 * pad[1])) + '%',
            background: (target.shown === 'cap') ? 'rgba(255, 232, 80, 0.10)' : 'rgba(255, 255, 255, 0.16)',
            boxShadow: '0 0 0 1px rgba(255, 232, 80, 0.75), 0 0 8px 1px rgba(255, 232, 80, 0.45)',
        });
    };

    const showStatus = (target) => {
        status.replaceChildren();
        const editor = emu.editorState;
        if (!target || !target.shown) return;
        let text = partText(target.name, target.entry, target.shown);
        // a letter as the L cursor types it
        if ((target.shown === 'main') && !target.entry.caps && (editor.cursor === 'L') && !latched.caps) text = text.toLowerCase();
        status.appendChild(el('span', { color: '#fff', fontWeight: 'bold', marginRight: '4px' }, text));
        let steps;
        if (target.plan) {
            steps = target.plan.steps;
        } else {
            const key = SPECCY[target.name];
            if ((key === CAPS) || (key === SYM)) {
                steps = [{ keys: [key] }];
            } else {
                steps = [{ keys: [...(latched.caps ? [CAPS] : []), ...(latched.sym ? [SYM] : []), key] }];
            }
        }
        steps.forEach((step, i) => {
            if (i > 0) status.appendChild(el('span', { color: '#666' }, '›'));
            if (step.keys) status.appendChild(keycap(chordLabel(step.keys)));
            else status.appendChild(el('span', { color: '#ccc' }, `types "${step.text}"`));
        });
    };

    const refresh = () => {
        const target = pointer ? targetAt(pointer) : null;
        stage.style.cursor = target ? 'pointer' : '';
        showHighlight(target);
        showStatus(target);
    };
    emu.on('editorState', () => refresh());

    /* ---- Typing ---- */

    const queue = [];  // clicks waiting for a sequence being typed: {target, inverse}
    let typing = false;
    let held = null;  // the keys held down while the pointer is: {keys, since, plain, releasing}

    const down = (keys) => keys.forEach(key => {
        emu.keyDown(key.row, key.mask);
        dim(key, 'pressed');
    });
    const up = (keys) => keys.slice().reverse().forEach(key => {
        emu.keyUp(key.row, key.mask);
        undim(key);
    });

    // Types what was clicked, one after another, each from the editor as it stands by then.
    const typeQueue = async () => {
        if (typing) return;
        typing = true;
        let keys = null;  // down at the moment
        try {
            while (queue.length && canType()) {
                const { target, inverse } = queue.shift();
                let chords;
                if (target.plan) {
                    const plan = planLegend(target.name, target.entry, target.part, emu.editorState, inverse);
                    if (!plan) continue;
                    chords = plan.steps.flatMap(step => (step.keys ? [step.keys] : step.chords));
                } else {
                    chords = [[...(latched.caps ? [CAPS] : []), ...(latched.sym ? [SYM] : []), SPECCY[target.name]]];
                }
                // a legend brings its own shifts, and a latched shift goes with the key after it
                if (latched.caps || latched.sym) {
                    clearLatched();
                    if (target.plan) await sleep(KEY_GAP_MS);
                }
                for (const chord of chords) {
                    if (!canType()) break;
                    keys = chord;
                    down(keys);
                    await sleep(KEY_HOLD_MS);
                    up(keys);
                    keys = null;
                    await sleep(KEY_GAP_MS);
                }
            }
        } finally {
            if (keys) up(keys);
            queue.length = 0;
            typing = false;
            refresh();
        }
    };
    emu.on('pause', () => { queue.length = 0; });
    emu.on('powerOff', () => { queue.length = 0; });

    const press = (target, e) => {
        const key = SPECCY[target.name];
        if ((key === CAPS) || (key === SYM)) {
            // Single click toggles this shift's sticky latch.
            if (!typing) setLatched((key === CAPS) ? 'caps' : 'sym', !((key === CAPS) ? latched.caps : latched.sym));
            return;
        }
        if (typing) {
            queue.push({ target, inverse: e.shiftKey });
            return;
        }
        if (target.plan) {
            if (!canType()) return;
            if (!target.plan.hold) {
                queue.push({ target, inverse: e.shiftKey });
                typeQueue();
                return;
            }
            clearLatched();
            held = { keys: target.plan.steps[0].keys, since: performance.now() };
        } else {
            // any latched shift is already down -> combo; physical modifiers held
            // during the click, matching the emulator's native keys: Shift -> CAPS
            // SHIFT, Ctrl -> SYMBOL SHIFT.
            const keys = [key];
            if (e.shiftKey && !latched.caps) keys.unshift(CAPS);
            if (e.ctrlKey && !latched.sym) keys.unshift(SYM);
            held = { keys, since: performance.now(), plain: true };
        }
        down(held.keys);
        refresh();
    };

    const release = async () => {
        if (!held || held.releasing) return;
        held.releasing = true;
        // a click shorter than a scan of the keyboard would go unseen
        const left = KEY_HOLD_MS - (performance.now() - held.since);
        if (left > 0) await sleep(left);
        up(held.keys);
        if (held.plain) clearLatched();   // one-shot: latched CAPS/SYMBOL release after this key
        held = null;
        refresh();
    };

    stage.addEventListener('pointermove', (e) => {
        pointer = pointAt(e);
        shiftHeld = e.shiftKey;
        refresh();
    });
    stage.addEventListener('pointerleave', () => {
        pointer = null;
        refresh();
    });
    stage.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!enabled() || held) return;
        pointer = pointAt(e);
        shiftHeld = e.shiftKey;
        const target = targetAt(pointer);
        if (!target) return;
        try { stage.setPointerCapture(e.pointerId); } catch (_) {}
        press(target, e);
    });
    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);

    return {
        element: container,
        show() { container.style.display = 'block'; },
        hide() { container.style.display = 'none'; },
        isVisible() { return container.style.display !== 'none'; },
        // Lets a latched CAPS SHIFT or SYMBOL SHIFT go, as the next key clicked would.
        releaseShifts: clearLatched,
    };
}

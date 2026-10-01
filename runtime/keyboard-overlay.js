/*
 * runtime/keyboard-overlay.js — an on-screen, clickable ZX Spectrum keyboard.
 *
 * Renders the keyboard reference image (scaled to the emulator display width)
 * and sends the emulator the keys pressed on it, through its keyboard matrix
 * (row/mask). A press works in one of two ways, chosen for each one:
 *
 * - With a mouse or pen, every legend printed on the image can be clicked,
 *   not only the caps: hovering one highlights it, and clicking it presses
 *   the shifts and modes that enter it and lets them go again. The highlight
 *   shows what a click enters in the ROM's editor as it stands (see
 *   runtime/keyboard-legends.js): a legend it would not take does not react.
 *   Each legend is hit across its key's whole column, not only over its text.
 * - With a finger on a touchscreen, and with a mouse too once the simple
 *   keyboard is chosen (setSimple), only the caps react, each pressing its
 *   own key alone as on the real keyboard; between the caps nothing does.
 *
 * A line under the image names what is under the pointer, or under a finger
 * while it is down, and the keys it presses, and is empty with nothing there.
 *
 * Each finger presses a key of its own, so keys go down together as on the
 * real keyboard: a shift and a key, both shifts for extended mode, or a
 * direction and fire in a game. A key pressed alone, and a legend entered by
 * one chord (DELETE, the arrows, a Symbol Shift character), is held for as
 * long as the finger or button is, so the ROM repeats it and a game sees it
 * held; a legend taking several (anything through extended or graphics mode,
 * or a keyword spelled out) is typed as a sequence, and clicks made
 * meanwhile queue behind it. Holding Shift while clicking a colour gives its
 * INK rather than its PAPER, and a block graphic inverted.
 *
 * CAPS SHIFT and SYMBOL SHIFT are sticky. A tap (a click or a touch let go
 * within TAP_MS, with no other key down with it) latches the shift down for
 * the next key, which lets it go; a second tap straight after locks it down
 * for a run of keys, such as the arrows, DELETE or symbols, until it is
 * tapped again. A later tap on a latched shift lets it go. A shift held down
 * with another key, whichever went down first, or for longer than a tap, is
 * an ordinary shift, let go with the finger, as a game's fire button is. A
 * shift tapped or held while the other is down, latched, locked or held, is
 * extended mode: it does not latch, and takes a latched other shift with it.
 * A legend brings its own shifts, so clicking one lets go of any latched or
 * locked, and so does hiding the keyboard, which would otherwise leave the
 * PC's keys shifted with nothing to show it. Holding a
 * physical modifier while clicking a key also works, matching the emulator's
 * native keys: Shift → CAPS SHIFT, Ctrl → SYMBOL SHIFT (read from the click,
 * so it works regardless of focus). A pressed key is slightly dimmed on the
 * image, a latched shift shaded blue, and a locked one ringed as well.
 */
import { SPECCY, KEY_HOLD_MS, KEY_GAP_MS } from './keyboard.js';
import { KEY_LAYOUT, capAt, partAt, partText, partBox, plainPart, planLegend, chordLabel } from './keyboard-legends.js';

const CAPS = SPECCY.CAPS_SHIFT;
const SYM = SPECCY.SYMBOL_SHIFT;

// How a cap is shaded: pressed, or a shift latched or locked.
const SHADES = {
    none: { backgroundColor: 'transparent', boxShadow: 'none' },
    pressed: { backgroundColor: 'rgba(0, 0, 0, 0.32)', boxShadow: 'none' },
    latched: { backgroundColor: 'rgba(40, 70, 200, 0.38)', boxShadow: 'none' },
    locked: { backgroundColor: 'rgba(40, 70, 200, 0.5)', boxShadow: 'inset 0 0 0 2px rgba(150, 180, 255, 0.95)' },
};

// A tap on a latched shift this soon after it latched locks it.
const DOUBLE_TAP_MS = 400;
// A shift held down longer than this is pressed, not tapped: it goes up with the finger rather than latching.
const TAP_MS = 300;

// Where the CAPS SHIFT cap's left edge is, in percent of the image's width.
const CAPS_SHIFT_LEFT = KEY_LAYOUT.find(layout => layout.name === 'CAPS_SHIFT').box[0];

// How wide each bent side edge is, in percent of the image; the first and last caps stand just inside it.
const FOLD_WIDTH = 2.2;
// What the bend of each side looks like, from the edge inwards. The left rim is brightest at the edge and ends in a
// crease, the right one catches a highlight a little way in.
const FOLDS = {
    left: 'linear-gradient(to right, rgba(255, 255, 255, 0.26), rgba(255, 255, 255, 0.13) 45%, rgba(255, 255, 255, 0.07))',
    right: 'linear-gradient(to left, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.07) 15%, rgba(255, 255, 255, 0.24) 42%, rgba(255, 255, 255, 0.09) 70%, rgba(255, 255, 255, 0))',
};

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

// A key as the char picker's bubble shows one (see char-picker.js), outlined to stand out on the page's grey.
const keycap = (text) => el('span', {
    padding: '1px 5px', borderRadius: '3px', fontSize: '10px', fontWeight: 'bold', whiteSpace: 'nowrap',
    background: '#3a3a3a', color: '#fff', border: '1px solid #8c8c8c', borderBottom: '3px solid #1a1a1a',
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

    // The faceplate's side edges bend back: a bright rim along each, fading into the flat face.
    for (const side of Object.keys(FOLDS)) {
        stage.appendChild(el('div', {
            position: 'absolute', top: '0', bottom: '0', [side]: '0', width: FOLD_WIDTH + '%', pointerEvents: 'none',
            background: FOLDS[side],
        }));
    }

    const highlight = el('div', {
        position: 'absolute', display: 'none', pointerEvents: 'none', borderRadius: '4px',
        transition: 'left 60ms, top 60ms, width 60ms, height 60ms',
    });
    stage.appendChild(highlight);

    // Under the image, on the page, starting beneath the left edge of the CAPS SHIFT cap.
    const status = el('div', {
        display: 'flex', alignItems: 'center', gap: '5px', height: '24px', padding: '0 10px 0 ' + CAPS_SHIFT_LEFT + '%', overflow: 'hidden',
        color: '#ccc', lineHeight: 'normal', whiteSpace: 'nowrap',
        fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px',
    });
    container.appendChild(status);

    // A shade over each cap, for a key pressed or a shift latched; by matrix place, as keys come as copies too.
    const shades = new Map();
    const place = (key) => `${key.row}:${key.mask}`;
    for (const layout of KEY_LAYOUT) {
        const shade = el('div', {
            position: 'absolute', pointerEvents: 'none', borderRadius: '6px', ...SHADES.none,
            left: layout.box[0] + '%', top: layout.box[1] + '%', width: layout.box[2] + '%', height: layout.box[3] + '%',
        });
        stage.appendChild(shade);
        shades.set(place(SPECCY[layout.name]), shade);
    }

    /* ---- Keys down ---- */

    // How many hold each key down, by matrix place: fingers or the mouse on
    // it, a latched or locked shift, or a legend being typed.
    const holds = new Map();
    // Moves on when the emulator lets every key go, so a press from before cannot let go of one made since.
    let generation = 0;

    /* The two shifts' sticky state: off, latched for the next key, or locked
     * until tapped again; with the fingers on each, whether another key was
     * down with them (chorded), whether it went down with the other shift
     * down (extend), and when it was last pressed and latched. */
    const newShift = (key) => ({ key, state: 'off', fingers: 0, chorded: false, extend: false, pressedAt: 0, latchedAt: 0 });
    const shifts = { caps: newShift(CAPS), sym: newShift(SYM) };
    const shiftOf = (key) => ((place(key) === place(CAPS)) ? shifts.caps : ((place(key) === place(SYM)) ? shifts.sym : null));
    const otherShift = (s) => ((s === shifts.caps) ? shifts.sym : shifts.caps);
    const isDown = (s) => (s.state !== 'off') || (s.fingers > 0);
    // The shifts down, as plainPart and the line under the keyboard take them.
    const shiftsDown = () => ({ caps: isDown(shifts.caps), sym: isDown(shifts.sym) });

    const shade = (key) => {
        const s = shiftOf(key);
        let look = 'none';
        if (s && !s.fingers && (s.state !== 'off')) look = s.state;
        else if (holds.get(place(key))) look = 'pressed';
        Object.assign(shades.get(place(key)).style, SHADES[look]);
    };
    const down = (keys) => keys.forEach(key => {
        const count = holds.get(place(key)) || 0;
        holds.set(place(key), count + 1);
        if (!count) emu.keyDown(key.row, key.mask);
        shade(key);
    });
    const up = (keys) => keys.slice().reverse().forEach(key => {
        const count = holds.get(place(key)) || 0;
        if (!count) return;
        holds.set(place(key), count - 1);
        if (count === 1) emu.keyUp(key.row, key.mask);
        shade(key);
    });

    // A shift latched or locked holds its key down.
    const setShift = (s, state) => {
        if (s.state === state) return;
        const was = s.state;
        s.state = state;
        if (state === 'latched') s.latchedAt = performance.now();
        if (was === 'off') down([s.key]);
        else if (state === 'off') up([s.key]);
        else shade(s.key);
        refresh();
    };
    // Lets the latched shifts go, as the key after them does, and with `locked` the locked ones too.
    const releaseShifts = (locked) => {
        for (const s of [shifts.caps, shifts.sym]) {
            if ((s.state === 'latched') || (locked && (s.state === 'locked'))) setShift(s, 'off');
        }
    };

    // The emulator let every key go (on pause, or focus leaving): so are the fingers' and the latches'.
    emu.on('keysReleased', () => {
        generation++;
        holds.clear();
        presses.clear();
        plainHeld = 0;
        for (const s of [shifts.caps, shifts.sym]) Object.assign(s, { state: 'off', fingers: 0, chorded: false, extend: false });
        for (const layout of KEY_LAYOUT) shade(SPECCY[layout.name]);
        refresh();
    });
    // With the keyboard turned off (the keyboardEnabled option), the keys do nothing.
    const enabled = () => emu.keyboardEnabled;
    // A paused machine's ROM sees no key, so nothing is typed into it.
    const canType = () => emu.keyboardEnabled && emu.isRunning;

    /* ---- What is under the pointer ---- */

    // The pointer shown, as {x, y} in percent of the image, its pointerId and
    // whether it is a finger: a mouse or pen while over the image, a finger
    // while it is down. Null with none.
    let pointer = null;
    let shiftHeld = false;  // the PC's Shift, at the pointer's last move
    let simple = false;     // a mouse presses whole keys, as a finger does

    const pointAt = (e) => {
        const rect = stage.getBoundingClientRect();
        return {
            x: ((e.clientX - rect.left) * 100) / rect.width, y: ((e.clientY - rect.top) * 100) / rect.height,
            id: e.pointerId, touch: e.pointerType === 'touch',
        };
    };

    /* What a press at `at` does, as {name, entry, part, shown, plan}: a key
     * pressed alone (plan null) or a legend's plan; shown is the part of the
     * entry that shows what it enters, or null for nothing. Null over no key,
     * and for a finger or the simple keyboard anywhere off the caps. */
    const targetAt = (at) => {
        const editor = emu.editorState;
        if (simple || at.touch) {
            const cap = capAt(at.x, at.y);
            return cap && { name: cap.name, entry: cap.entry, part: 'cap', shown: plainPart(cap.entry, editor, shiftsDown()), plan: null };
        }
        const hit = partAt(at.x, at.y, editor);
        if (!hit) return null;
        const plain = (hit.part === 'cap') || (hit.part === 'main') || ((hit.part === 'keyword') && (editor.kind !== 128));
        if (plain) return { ...hit, shown: plainPart(hit.entry, editor, shiftsDown()), plan: null };
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

    // What a shift does next, in the words for the pointer over it.
    const shiftHint = (s, verb) => ({
        off: `${verb}: latch, double-${verb}: lock`,
        latched: 'latched for the next key',
        locked: `locked, ${verb} to let go`,
    })[s.state];

    const showStatus = (target) => {
        status.replaceChildren();
        const editor = emu.editorState;
        if (!target || !target.shown) return;
        const held = shiftsDown();
        let text = partText(target.name, target.entry, target.shown);
        // a letter as the L cursor types it
        if ((target.shown === 'main') && !target.entry.caps && (editor.cursor === 'L') && !held.caps) text = text.toLowerCase();
        status.appendChild(el('span', { color: '#fff', fontWeight: 'bold', marginRight: '4px' }, text));
        let steps;
        const key = SPECCY[target.name];
        const shift = !target.plan && shiftOf(key);
        if (target.plan) {
            steps = target.plan.steps;
        } else if (shift) {
            steps = [{ keys: [key] }];
        } else {
            steps = [{ keys: [...(held.caps ? [CAPS] : []), ...(held.sym ? [SYM] : []), key] }];
        }
        steps.forEach((step, i) => {
            if (i > 0) status.appendChild(el('span', { color: '#bbb' }, '›'));
            if (step.keys) status.appendChild(keycap(chordLabel(step.keys)));
            else status.appendChild(el('span', { color: '#e4e4e4' }, `types "${step.text}"`));
        });
        if (shift) status.appendChild(el('span', { color: '#c8c8c8', marginLeft: '4px' }, shiftHint(shift, pointer.touch ? 'tap' : 'click')));
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
    // What each pointer down on the keyboard holds down, by pointerId: {keys, since, gen, shift, plain}.
    const presses = new Map();
    // How many keys pressed alone are down, the pointer on them or let go and still to go up.
    let plainHeld = 0;

    // Types what was clicked, one after another, each from the editor as it stands by then.
    const typeQueue = async () => {
        if (typing) return;
        typing = true;
        let keys = null;  // down at the moment
        let gen = generation;
        try {
            while (queue.length && canType()) {
                const { target, inverse } = queue.shift();
                let chords;
                if (target.plan) {
                    const plan = planLegend(target.name, target.entry, target.part, emu.editorState, inverse);
                    if (!plan) continue;
                    chords = plan.steps.flatMap(step => (step.keys ? [step.keys] : step.chords));
                    // a legend brings its own shifts
                    if ((shifts.caps.state !== 'off') || (shifts.sym.state !== 'off')) {
                        releaseShifts(true);
                        await sleep(KEY_GAP_MS);
                    }
                } else {
                    chords = [[SPECCY[target.name]]];
                }
                for (const chord of chords) {
                    if (!canType()) break;
                    keys = chord;
                    gen = generation;
                    down(keys);
                    await sleep(KEY_HOLD_MS);
                    if (gen === generation) up(keys);
                    keys = null;
                    await sleep(KEY_GAP_MS);
                }
                // a latched shift goes with the key after it
                if (!target.plan) releaseShifts(false);
            }
        } finally {
            if (keys && (gen === generation)) up(keys);
            queue.length = 0;
            typing = false;
            refresh();
        }
    };
    emu.on('pause', () => { queue.length = 0; });
    emu.on('powerOff', () => { queue.length = 0; });

    const startPress = (e, pressed) => {
        presses.set(e.pointerId, { ...pressed, since: performance.now(), gen: generation });
        if (pressed.plain) plainHeld++;
        down(pressed.keys);
        refresh();
    };

    const press = (target, e) => {
        const key = SPECCY[target.name];
        const shift = shiftOf(key);
        if (shift) {
            // while a legend is typed, the shifts are its own
            if (typing) return;
            const other = otherShift(shift);
            if (!shift.fingers) {
                // with a key already held, it is an ordinary shift, as with one pressed while it is held
                shift.chorded = [...presses.values()].some(pressed => !pressed.shift);
                shift.extend = isDown(other);
                shift.pressedAt = performance.now();
            }
            if (other.fingers) other.chorded = true;
            shift.fingers++;
            startPress(e, { keys: [key], shift });
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
            releaseShifts(true);
            startPress(e, { keys: target.plan.steps[0].keys });
        } else {
            // a shift already down makes a combination; physical modifiers
            // held during the click, matching the emulator's native keys:
            // Shift -> CAPS SHIFT, Ctrl -> SYMBOL SHIFT.
            const held = shiftsDown();
            const keys = [key];
            if (e.shiftKey && !held.caps) keys.unshift(CAPS);
            if (e.ctrlKey && !held.sym) keys.unshift(SYM);
            // a shift held by a finger goes with this key, and is let go with the finger
            for (const s of [shifts.caps, shifts.sym]) {
                if (s.fingers) s.chorded = true;
            }
            startPress(e, { keys, plain: true });
        }
    };

    // The last finger (or the mouse) on shift `s` let go of it: what that leaves it as.
    const liftShift = (s) => {
        s.fingers--;
        if (s.fingers > 0) return;
        const other = otherShift(s);
        if (s.extend) {
            // with the other shift down: extended mode, which takes a latched other shift with it
            setShift(s, 'off');
            if (other.state === 'latched') setShift(other, 'off');
        } else if (s.chorded || ((performance.now() - s.pressedAt) >= TAP_MS)) {
            // down with another key, or held longer than a tap: an ordinary shift, unless it was locked
            if (s.state === 'latched') setShift(s, 'off');
        } else if (s.state === 'off') {
            setShift(s, 'latched');
        } else if ((s.state === 'latched') && ((s.pressedAt - s.latchedAt) < DOUBLE_TAP_MS)) {
            setShift(s, 'locked');
        } else {
            setShift(s, 'off');
        }
    };

    /* A pointer let go: a shift is settled at once, so the next press finds
     * it as it is left, and the keys go up once they have been down long
     * enough for the ROM to see them. */
    const release = async (e) => {
        const pressed = presses.get(e.pointerId);
        if (!pressed) return;
        presses.delete(e.pointerId);
        // the shift's own state first, so a shift that latches stays down
        if (pressed.shift) liftShift(pressed.shift);
        // a press shorter than a scan of the keyboard would go unseen
        const left = KEY_HOLD_MS - (performance.now() - pressed.since);
        if (left > 0) await sleep(left);
        if (pressed.gen !== generation) return;
        up(pressed.keys);
        if (pressed.plain) {
            plainHeld--;
            // one-shot: a latched shift is let go after the key it went with, once no other key holds it
            if (!plainHeld) releaseShifts(false);
        }
        refresh();
    };

    stage.addEventListener('pointermove', (e) => {
        // a finger shows only while it is down
        if ((e.pointerType === 'touch') && !presses.has(e.pointerId)) return;
        pointer = pointAt(e);
        shiftHeld = e.shiftKey;
        refresh();
    });
    stage.addEventListener('pointerleave', (e) => {
        if (pointer && (pointer.id !== e.pointerId)) return;
        pointer = null;
        refresh();
    });
    stage.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!enabled() || presses.has(e.pointerId)) return;
        pointer = pointAt(e);
        shiftHeld = e.shiftKey;
        const target = targetAt(pointer);
        if (!target) {
            refresh();
            return;
        }
        try { stage.setPointerCapture(e.pointerId); } catch (_) {}
        press(target, e);
    });
    const lift = (e) => {
        // a finger lifted shows nothing
        if (pointer && pointer.touch && (pointer.id === e.pointerId)) {
            pointer = null;
            refresh();
        }
        release(e);
    };
    stage.addEventListener('pointerup', lift);
    stage.addEventListener('pointercancel', lift);
    // a pointer whose pointerup goes elsewhere is let go all the same (after a pointerup this finds nothing left)
    stage.addEventListener('lostpointercapture', lift);

    return {
        element: container,
        show() { container.style.display = 'block'; },
        hide() {
            container.style.display = 'none';
            releaseShifts(true);
        },
        isVisible() { return container.style.display !== 'none'; },
        // Lets a latched or locked CAPS SHIFT or SYMBOL SHIFT go, before keys typed from elsewhere.
        releaseShifts: () => releaseShifts(true),
        // The simple keyboard: a mouse presses whole keys, only on their caps, as a finger does.
        setSimple(on) {
            simple = !!on;
            refresh();
        },
    };
}

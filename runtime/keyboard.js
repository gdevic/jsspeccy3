// Mapping from Spectrum key identifiers to keyboard matrix info
export const SPECCY = {
    ONE: {row: 3, mask: 0x01},
    TWO: {row: 3, mask: 0x02},
    THREE: {row: 3, mask: 0x04},
    FOUR: {row: 3, mask: 0x08},
    FIVE: {row: 3, mask: 0x10},
    SIX: {row: 4, mask: 0x10},
    SEVEN: {row: 4, mask: 0x08},
    EIGHT: {row: 4, mask: 0x04},
    NINE: {row: 4, mask: 0x02},
    ZERO: {row: 4, mask: 0x01},

    Q: {row: 2, mask: 0x01},
    W: {row: 2, mask: 0x02},
    E: {row: 2, mask: 0x04},
    R: {row: 2, mask: 0x08},
    T: {row: 2, mask: 0x10},
    Y: {row: 5, mask: 0x10},
    U: {row: 5, mask: 0x08},
    I: {row: 5, mask: 0x04},
    O: {row: 5, mask: 0x02},
    P: {row: 5, mask: 0x01},

    A: {row: 1, mask: 0x01},
    S: {row: 1, mask: 0x02},
    D: {row: 1, mask: 0x04},
    F: {row: 1, mask: 0x08},
    G: {row: 1, mask: 0x10},
    H: {row: 6, mask: 0x10},
    J: {row: 6, mask: 0x08},
    K: {row: 6, mask: 0x04},
    L: {row: 6, mask: 0x02},
    ENTER: {row: 6, mask: 0x01},

    CAPS_SHIFT: {row: 0, mask: 0x01, isCaps: true},
    Z: {row: 0, mask: 0x02},
    X: {row: 0, mask: 0x04},
    C: {row: 0, mask: 0x08},
    V: {row: 0, mask: 0x10},
    B: {row: 7, mask: 0x10},
    N: {row: 7, mask: 0x08},
    M: {row: 7, mask: 0x04},
    SYMBOL_SHIFT: {row: 7, mask: 0x02, isSymbol: true},
    BREAK_SPACE: {row: 7, mask: 0x01},
};

function sym(speccyKey) {
    // patch key definition to indicate that symbol shift should be activated
    return {...speccyKey, sym: true}
}

function caps(speccyKey) {
    // patch key definition to indicate that caps shift should be activated
    return {...speccyKey, caps: true}
}

// Mapping from JS key codes to Spectrum key definitions
const KEY_CODES = {
    49: SPECCY.ONE,
    50: SPECCY.TWO,
    51: SPECCY.THREE,
    52: SPECCY.FOUR,
    53: SPECCY.FIVE,
    54: SPECCY.SIX,
    55: SPECCY.SEVEN,
    56: SPECCY.EIGHT,
    57: SPECCY.NINE,
    48: SPECCY.ZERO,

    81: SPECCY.Q,
    87: SPECCY.W,
    69: SPECCY.E,
    82: SPECCY.R,
    84: SPECCY.T,
    89: SPECCY.Y,
    85: SPECCY.U,
    73: SPECCY.I,
    79: SPECCY.O,
    80: SPECCY.P,

    65: SPECCY.A,
    83: SPECCY.S,
    68: SPECCY.D,
    70: SPECCY.F,
    71: SPECCY.G,
    72: SPECCY.H,
    74: SPECCY.J,
    75: SPECCY.K,
    76: SPECCY.L,
    13: SPECCY.ENTER,

    16: SPECCY.CAPS_SHIFT, /* caps */
    90: SPECCY.Z,
    88: SPECCY.X,
    67: SPECCY.C,
    86: SPECCY.V,
    66: SPECCY.B,
    78: SPECCY.N,
    77: SPECCY.M,
    17: SPECCY.SYMBOL_SHIFT, /* sym - gah, firefox screws up ctrl+key too */
    32: SPECCY.BREAK_SPACE, /* space */

    /* shifted combinations */
    8: caps(SPECCY.ZERO), /* backspace */
    37: caps(SPECCY.FIVE), /* left arrow */
    38: caps(SPECCY.SEVEN), /* up arrow */
    39: caps(SPECCY.EIGHT), /* right arrow */
    40: caps(SPECCY.SIX), /* down arrow */

    /* the numeric keypad's digits */
    96: SPECCY.ZERO,
    97: SPECCY.ONE,
    98: SPECCY.TWO,
    99: SPECCY.THREE,
    100: SPECCY.FOUR,
    101: SPECCY.FIVE,
    102: SPECCY.SIX,
    103: SPECCY.SEVEN,
    104: SPECCY.EIGHT,
    105: SPECCY.NINE,
};

/* The key typing a character, for a key whose code isn't in KEY_CODES.
 * Kept apart from KEY_CODES, where "8" would find key code 8, Backspace. */
const KEY_CHARS = {
    /* symbol keys */
    '-': sym(SPECCY.J),
    '_': sym(SPECCY.ZERO),
    '=': sym(SPECCY.L),
    '+': sym(SPECCY.K),
    ';': sym(SPECCY.O),
    ':': sym(SPECCY.Z),
    '\'': sym(SPECCY.SEVEN),
    '"': sym(SPECCY.P),
    ',': sym(SPECCY.N),
    '<': sym(SPECCY.R),
    '.': sym(SPECCY.M),
    '>': sym(SPECCY.T),
    '/': sym(SPECCY.V),
    '?': sym(SPECCY.C),
    '*': sym(SPECCY.B),
    '@': sym(SPECCY.TWO),
    '#': sym(SPECCY.THREE),
    /* Typed on the PC with Shift and a digit, which KEY_CODES finds by its
     * key code first; here for speccyKeysForChar. */
    '!': sym(SPECCY.ONE),
    '$': sym(SPECCY.FOUR),
    '%': sym(SPECCY.FIVE),
    '&': sym(SPECCY.SIX),
    '(': sym(SPECCY.EIGHT),
    ')': sym(SPECCY.NINE),
    '£': sym(SPECCY.X),
    '↑': sym(SPECCY.H),
    '^': sym(SPECCY.H),  // character 94, which the Spectrum shows as ↑
};
KEY_CHARS[String.fromCharCode(0x2264)] = sym(SPECCY.Q); // LESS_THAN_EQUAL symbol (≤)
KEY_CHARS[String.fromCharCode(0x2265)] = sym(SPECCY.E); // GREATER_THAN_EQUAL symbol (≥)
KEY_CHARS[String.fromCharCode(0x2260)] = sym(SPECCY.W); // NOT_EQUAL symbol (≠)

/* The key left of 1 (backtick on a US layout, ` ¬ on a UK one) is a second
 * Caps Shift. It is found by its place on the keyboard, not its key code,
 * which on a UK layout belongs to the ' @ key. */
const CAPS_SHIFT_CODE = 'Backquote';

const CTRL_KEY_CODE = 17;  // Symbol Shift (see BaseKeyboardHandler.guardClose)
const preventClose = (evt) => {
    evt.preventDefault();
    evt.returnValue = '';
};

/* How long a key typed for the user is held, and then let go before the
 * next. The ROM scans the keyboard once a frame and takes a key as let go
 * only after five scans without it, so these see every key in, the same
 * key twice running included. */
export const KEY_HOLD_MS = 80;
export const KEY_GAP_MS = 120;

const DIGIT_NAMES = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];

/* The Spectrum key called `name`, in any case: a name from SPECCY ('A',
 * 'ENTER', 'CAPS_SHIFT', 'SYMBOL_SHIFT', 'BREAK_SPACE'), a digit ('0' to
 * '9'), or 'SPACE'. Null for no such key. */
export function speccyKeyByName(name) {
    const upper = String(name).toUpperCase();
    if (/^[0-9]$/.test(upper)) return SPECCY[DIGIT_NAMES[Number(upper)]];
    if (upper === 'SPACE') return SPECCY.BREAK_SPACE;
    return Object.prototype.hasOwnProperty.call(SPECCY, upper) ? SPECCY[upper] : null;
}

/* The keys pressed together to type `ch`: a letter (a capital with Caps
 * Shift), a digit, a space, a newline for Enter, or a symbol typed with
 * Symbol Shift as on the PC keyboard (see KEY_CHARS). Null for a character
 * no key types. */
export function speccyKeysForChar(ch) {
    if ((ch === '\n') || (ch === '\r')) return [SPECCY.ENTER];
    if (/^[a-z0-9 ]$/.test(ch)) return [speccyKeyByName((ch === ' ') ? 'SPACE' : ch)];
    if (/^[A-Z]$/.test(ch)) return [SPECCY.CAPS_SHIFT, SPECCY[ch]];
    const key = Object.prototype.hasOwnProperty.call(KEY_CHARS, ch) ? KEY_CHARS[ch] : null;
    return (key && key.sym) ? [SPECCY.SYMBOL_SHIFT, key] : null;
}


export class BaseKeyboardHandler {
    constructor(worker, rootElement) {
        this.worker = worker;
        this.rootElement = rootElement;  // where we attach keyboard event listeners
        this.eventsAreBound = false;
        this.closeGuarded = false;  // see guardClose
        /* Keys that act on the emulator instead of reaching the Spectrum,
         * by KeyboardEvent.code: a function acts as the key goes down ({F3:
         * () => ...}), and {down, up} acts for as long as the key is held,
         * up() coming as it is let go or as every key is released. Like
         * every other key they work only while the machine runs, as the
         * handler is stopped when it is paused. */
        this.hotkeys = {};
        this.heldHotkeys = new Set();  // codes of the {down, up} hotkeys held down

        this.keypressHandler = (evt) => {
            if (!evt.metaKey) evt.preventDefault();
        };

        // A key let go while the page is out of focus (switched to another tab
        // or application) sends its keyup elsewhere, so every key is released
        // as focus leaves rather than staying held on the Spectrum.
        this.blurHandler = () => this.releaseAllKeys();
        // The same goes for focus moving elsewhere on the page, out of the root element.
        this.focusoutHandler = (evt) => {
            if (!evt.relatedTarget || !this.rootElement.contains(evt.relatedTarget)) this.releaseAllKeys();
        };
    }

    start() {
        this.rootElement.addEventListener('keydown', this.keydownHandler);
        this.rootElement.addEventListener('keyup', this.keyupHandler);
        this.rootElement.addEventListener('keypress', this.keypressHandler);
        this.rootElement.addEventListener('focusout', this.focusoutHandler);
        window.addEventListener('blur', this.blurHandler);
        this.eventsAreBound = true;
    }

    stop() {
        this.rootElement.removeEventListener('keydown', this.keydownHandler);
        this.rootElement.removeEventListener('keyup', this.keyupHandler);
        this.rootElement.removeEventListener('keypress', this.keypressHandler);
        this.rootElement.removeEventListener('focusout', this.focusoutHandler);
        window.removeEventListener('blur', this.blurHandler);
        // With the listeners gone no keyup arrives, so nothing may stay held
        if (this.eventsAreBound) this.releaseAllKeys();
        this.eventsAreBound = false;
    }

    /* Runs the hotkey `evt` is, if any, and returns whether it was one; an
     * auto-repeat is taken but does not run it again. A held hotkey takes
     * an auto-repeat as its key going down when it isn't held: the key
     * kept down while focus was away, and released then, comes back
     * through its repeats. A key held with Ctrl, Alt or Meta is the
     * browser's or the Spectrum's, not a hotkey. */
    handleHotkey(evt) {
        const action = Object.prototype.hasOwnProperty.call(this.hotkeys, evt.code) ? this.hotkeys[evt.code] : null;
        if (!action || evt.ctrlKey || evt.altKey || evt.metaKey) return false;
        if (typeof action === 'function') {
            if (!evt.repeat) action();
        } else if (!this.heldHotkeys.has(evt.code)) {
            this.heldHotkeys.add(evt.code);
            action.down();
        }
        evt.preventDefault();
        return true;
    }

    /* Lets go of the held hotkey `evt` is, if it is held, and returns
     * whether it was. Whatever modifiers are down by now, it is the key
     * that went down as the hotkey. */
    handleHotkeyUp(evt) {
        if (!this.heldHotkeys.has(evt.code)) return false;
        this.heldHotkeys.delete(evt.code);
        this.hotkeys[evt.code].up();
        evt.preventDefault();
        return true;
    }

    releaseAllKeys() {
        for (let row = 0; row < 8; row++) {
            this.worker.postMessage({ message: 'keyUp', row, mask: 0x1f });
        }
        this.guardClose(false);
        const held = [...this.heldHotkeys];
        this.heldHotkeys.clear();
        for (const code of held) this.hotkeys[code].up();
        if (this.onReleaseAll) this.onReleaseAll();
    }

    /* Ctrl is Symbol Shift, and the browser keeps Ctrl+W (close the tab)
     * for itself, beyond preventDefault. While Ctrl is held the page asks
     * before it is closed, so Symbol Shift + W can't lose the machine, or
     * a recording or cartridge not yet kept, by accident. */
    guardClose(held) {
        if (held === this.closeGuarded) return;
        this.closeGuarded = held;
        if (held) window.addEventListener('beforeunload', preventClose);
        else window.removeEventListener('beforeunload', preventClose);
    }

    setRootElement(newRootElement) {
        if (this.eventsAreBound) {
            this.stop();
            this.rootElement = newRootElement;
            this.start();
        } else {
            this.rootElement = newRootElement;
        }
    }
}

export class StandardKeyboardHandler extends BaseKeyboardHandler {
    constructor(worker, rootElement) {
        super(worker, rootElement);

        // if true, the real symbol shift key is being held (as opposed to being active through a
        // virtual key combination)
        this.symbolIsShifted = false;

        // if true, the real caps shift key is being held (as opposed to being active through a
        // virtual key combination)
        this.capsIsShifted = false;

        // When a keypress is recognised by its character rather than its numeric key code, store
        // the resolved key info struct here, indexed by key code. If the state of shift keys
        // changes while that key is held down, we will see subsequent keydown events with a
        // different character but the same key code. For example, if the user holds the semicolon
        // key and then presses shift, we will see a keydown event with {keyCode: 186, key: ';'},
        // and then another keydown event with {keyCode: 186, key=':'}. In this case, we would need
        // to simulate a keyup event for the semicolon before registering the colon as a new
        // keypress. This table allows us to recognise when changes like this happen.
        this.seenKeyCodes = {};

        this.keydownHandler = (evt) => {
            if (this.handleHotkey(evt)) return;
            if (evt.keyCode === CTRL_KEY_CODE) this.guardClose(true);
            let keyInfo = (evt.code === CAPS_SHIFT_CODE) ? SPECCY.CAPS_SHIFT : KEY_CODES[evt.keyCode];
            if (keyInfo) {
                this.keyDown(keyInfo);
            } else {
                keyInfo = Object.prototype.hasOwnProperty.call(KEY_CHARS, evt.key) ? KEY_CHARS[evt.key] : null;
                if (keyInfo) {
                    const lastKeyInfo = this.seenKeyCodes[evt.keyCode];
                    if (lastKeyInfo && lastKeyInfo !== keyInfo) {
                        this.keyUp(lastKeyInfo);
                    }
                    this.seenKeyCodes[evt.keyCode] = keyInfo;
                    this.keyDown(keyInfo);
                }
            }
            if (!evt.metaKey) evt.preventDefault();
        };

        this.keyupHandler = (evt) => {
            if (this.handleHotkeyUp(evt)) return;
            if (evt.keyCode === CTRL_KEY_CODE) this.guardClose(false);
            const keyInfo = (evt.code === CAPS_SHIFT_CODE) ? SPECCY.CAPS_SHIFT : KEY_CODES[evt.keyCode];
            if (keyInfo) {
                this.keyUp(keyInfo);
            } else {
                const lastKeyInfo = this.seenKeyCodes[evt.keyCode];
                if (lastKeyInfo) {
                    this.seenKeyCodes[evt.keyCode] = null;
                    this.keyUp(lastKeyInfo);
                }
            }
            if (!evt.metaKey) evt.preventDefault();
        };
    }

    sendKeyMessage(speccyKey, downNotUp) {
        this.worker.postMessage({
            message: downNotUp ? 'keyDown' : 'keyUp', row: speccyKey.row, mask: speccyKey.mask,
        });
    }

    keyDown(speccyKey) {
        this.sendKeyMessage(speccyKey, true);
        if ('caps' in speccyKey || 'sym' in speccyKey) {
            this.sendKeyMessage(SPECCY.CAPS_SHIFT, 'caps' in speccyKey);
            this.sendKeyMessage(SPECCY.SYMBOL_SHIFT, 'sym' in speccyKey);
        } else if (speccyKey.isCaps) {
            this.capsIsShifted = true;
        } else if (speccyKey.isSymbol) {
            this.symbolIsShifted = true;
        }
    }

    keyUp(speccyKey) {
        this.sendKeyMessage(speccyKey, false);
        if ('caps' in speccyKey || 'sym' in speccyKey) {
            this.sendKeyMessage(SPECCY.CAPS_SHIFT, this.capsIsShifted);
            this.sendKeyMessage(SPECCY.SYMBOL_SHIFT, this.symbolIsShifted);
        } else if (speccyKey.isCaps) {
            this.capsIsShifted = false;
        } else if (speccyKey.isSymbol) {
            this.symbolIsShifted = false;
        }
    }

    releaseAllKeys() {
        super.releaseAllKeys();
        this.symbolIsShifted = false;
        this.capsIsShifted = false;
        this.seenKeyCodes = {};
    }
}

const RECREATED_SPECTRUM_GAME_LAYER = {
    "ab": SPECCY.ONE,
    "cd": SPECCY.TWO,
    "ef": SPECCY.THREE,
    "gh": SPECCY.FOUR,
    "ij": SPECCY.FIVE,
    "kl": SPECCY.SIX,
    "mn": SPECCY.SEVEN,
    "op": SPECCY.EIGHT,
    "qr": SPECCY.NINE,
    "st": SPECCY.ZERO,

    "uv": SPECCY.Q,
    "wx": SPECCY.W,
    "yz": SPECCY.E,
    "AB": SPECCY.R,
    "CD": SPECCY.T,
    "EF": SPECCY.Y,
    "GH": SPECCY.U,
    "IJ": SPECCY.I,
    "KL": SPECCY.O,
    "MN": SPECCY.P,

    "OP": SPECCY.A,
    "QR": SPECCY.S,
    "ST": SPECCY.D,
    "UV": SPECCY.F,
    "WX": SPECCY.G,
    "YZ": SPECCY.H,
    "01": SPECCY.J,
    "23": SPECCY.K,
    "45": SPECCY.L,
    "67": SPECCY.ENTER,

    "89": SPECCY.CAPS_SHIFT,
    "<>": SPECCY.Z,
    "-=": SPECCY.X,
    "[]": SPECCY.C,
    ";:": SPECCY.V,
    ",.": SPECCY.B,
    "/?": SPECCY.N,
    "{}": SPECCY.M,
    "!$": SPECCY.SYMBOL_SHIFT,
    "%^": SPECCY.BREAK_SPACE,
};
let recreatedUpDown = {};

for (const [pair, key] of Object.entries(RECREATED_SPECTRUM_GAME_LAYER)) {
    recreatedUpDown[pair.charAt(0)] = { ...key, message: "keyDown" };
    recreatedUpDown[pair.charAt(1)] = { ...key, message: "keyUp" };
}

export class RecreatedZXSpectrumHandler extends BaseKeyboardHandler {
    constructor(worker, rootElement) {
        super(worker, rootElement);

        this.keydownHandler = (evt) => {
            if (this.handleHotkey(evt)) return;
            const specialCode = recreatedUpDown[evt.key];
            if (specialCode) {
                this.worker.postMessage({
                    message: specialCode.message, row: specialCode.row, mask: specialCode.mask,
                });
            }
            if (!evt.metaKey) evt.preventDefault();
        };

        this.keyupHandler = (evt) => {
            if (this.handleHotkeyUp(evt)) return;
            if (!evt.metaKey) evt.preventDefault();
        };
    }
}

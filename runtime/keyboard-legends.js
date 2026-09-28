/*
 * runtime/keyboard-legends.js: the legends printed on the on-screen
 * keyboard's image (static/zx_keyboard.png), where each one is, and the keys
 * that enter it.
 *
 * What a legend takes depends on the ROM's line editor waiting for a key,
 * as the worker reports it (editorState in runtime/worker.js), {kind,
 * cursor}, or null while a program runs:
 *
 * - The 48K editor (48 BASIC, INPUT in either BASIC, TR-DOS) takes a
 *   keyword in K mode from the key alone, a green legend above a key in
 *   extended mode (E), a red one below it in E with Symbol Shift, and a block
 *   graphic in graphics mode (G). The keys leave E or G first when the legend
 *   is not theirs, and G is taken up again after.
 * - The 128 BASIC editor has no keyword mode and takes no keyword from a
 *   key: it tokenises what is typed on ENTER, so keywords are spelled out. E
 *   still gives the characters below the keys ([ ] ~ | \ { } ©), and G the
 *   block graphics; the colour codes are not taken.
 * - While a program runs, a legend off the caps presses the keys the
 *   keyboard gives it, and a cap is its key alone.
 *
 * Boxes are [left, top, width, height] in percent of the image, so they
 * scale with it; they were measured from the image's pixels.
 */
import { SPECCY, speccyKeysForChar } from './keyboard.js';

// Every key's cap: its name in SPECCY and its box, by rows as on the keyboard.
export const KEY_LAYOUT = [
    { name: 'ONE', box: [3.2, 13.82, 6.33, 11.02] },
    { name: 'TWO', box: [12.19, 13.65, 6.33, 11.18] },
    { name: 'THREE', box: [21.17, 13.65, 6.33, 11.18] },
    { name: 'FOUR', box: [30.16, 13.65, 6.33, 11.18] },
    { name: 'FIVE', box: [39.14, 13.65, 6.33, 11.18] },
    { name: 'SIX', box: [48.13, 13.65, 6.33, 11.18] },
    { name: 'SEVEN', box: [57.11, 13.65, 6.33, 11.18] },
    { name: 'EIGHT', box: [66.03, 13.82, 6.33, 11.02] },
    { name: 'NINE', box: [74.88, 13.82, 6.33, 11.02] },
    { name: 'ZERO', box: [83.59, 13.82, 6.33, 11.02] },
    { name: 'Q', box: [7.9, 35.86, 6.33, 11.02] },
    { name: 'W', box: [16.88, 35.86, 6.33, 11.02] },
    { name: 'E', box: [25.87, 35.86, 6.33, 11.02] },
    { name: 'R', box: [34.85, 35.86, 6.33, 11.02] },
    { name: 'T', box: [43.84, 35.86, 6.33, 11.02] },
    { name: 'Y', box: [52.83, 35.86, 6.33, 11.02] },
    { name: 'U', box: [61.81, 35.86, 6.33, 11.02] },
    { name: 'I', box: [70.66, 35.86, 6.33, 11.02] },
    { name: 'O', box: [79.65, 35.86, 6.33, 11.02] },
    { name: 'P', box: [88.29, 35.86, 6.33, 11.02] },
    { name: 'A', box: [10.55, 57.57, 6.33, 11.02] },
    { name: 'S', box: [19.54, 57.57, 6.33, 11.02] },
    { name: 'D', box: [28.52, 57.57, 6.33, 11.02] },
    { name: 'F', box: [37.51, 57.57, 6.33, 11.02] },
    { name: 'G', box: [46.49, 57.57, 6.33, 11.02] },
    { name: 'H', box: [55.48, 57.57, 6.33, 11.02] },
    { name: 'J', box: [64.47, 57.57, 6.33, 11.02] },
    { name: 'K', box: [73.45, 57.57, 6.33, 11.02] },
    { name: 'L', box: [82.16, 57.57, 6.33, 11.02] },
    { name: 'ENTER', box: [90.95, 57.57, 6.33, 11.02] },
    { name: 'CAPS_SHIFT', box: [4.29, 79.44, 7.83, 11.18] },
    { name: 'Z', box: [14.91, 79.61, 6.33, 11.02] },
    { name: 'X', box: [23.89, 79.61, 6.33, 11.02] },
    { name: 'C', box: [32.88, 79.61, 6.33, 11.02] },
    { name: 'V', box: [41.87, 79.61, 6.33, 11.02] },
    { name: 'B', box: [50.85, 79.61, 6.33, 11.02] },
    { name: 'N', box: [59.84, 79.61, 6.33, 11.02] },
    { name: 'M', box: [68.82, 79.61, 6.33, 11.02] },
    { name: 'SYMBOL_SHIFT', box: [77.74, 79.61, 6.33, 11.02] },
    { name: 'BREAK_SPACE', box: [86.59, 79.61, 10.69, 11.02] },
];
const ROWS = [KEY_LAYOUT.slice(0, 10), KEY_LAYOUT.slice(10, 20), KEY_LAYOUT.slice(20, 30), KEY_LAYOUT.slice(30, 40)];

/* A key's legends, each [text, box]: main is the digit or letter itself (a
 * box only); on the top row, colour (E, and INK with Caps Shift) and caps
 * (Caps Shift) above the key, and the block graphic on it (G, a box only);
 * ext above the letters (E); sym on the cap (Symbol Shift); keyword on the
 * letters (K); extSym below every key (E with Symbol Shift). */
const LEGENDS = [
    { key: 'ONE', main: [4.02, 17.27, 0.82, 4.77], colour: ['BLUE', [3.34, 6.25, 3.40, 2.47]], caps: ['EDIT', [3.34, 9.54, 3.00, 2.47]], sym: ['!', [7.15, 20.39, 0.20, 2.63]], graphic: [6.81, 15.30, 1.50, 3.29], extSym: ['DEF FN', [3.34, 26.32, 4.77, 2.47]] },
    { key: 'TWO', main: [12.93, 17.60, 1.16, 4.28], colour: ['RED', [12.32, 6.25, 2.72, 2.47]], caps: ['CAPS LOCK', [12.25, 9.54, 7.76, 2.47]], sym: ['@', [16.00, 20.39, 1.36, 3.45]], graphic: [15.79, 15.30, 1.50, 3.29], extSym: ['FN', [12.32, 26.32, 1.63, 2.47]] },
    { key: 'THREE', main: [21.85, 17.27, 1.29, 4.77], colour: ['MAGENTA', [21.38, 6.25, 6.67, 2.47]], caps: ['TRUE VIDEO', [21.31, 9.54, 8.30, 2.47]], sym: ['#', [24.91, 20.39, 0.82, 2.63]], graphic: [24.78, 15.30, 1.50, 3.29], extSym: ['LINE', [21.38, 26.32, 2.86, 2.47]] },
    { key: 'FOUR', main: [30.77, 17.27, 1.43, 4.77], colour: ['GREEN', [30.29, 6.25, 4.70, 2.47]], caps: ['INV. VIDEO', [30.36, 9.54, 7.08, 2.47]], sym: ['$', [33.97, 20.23, 0.68, 3.12]], graphic: [33.76, 15.30, 1.50, 3.29], extSym: ['OPEN #', [30.29, 26.32, 3.68, 2.47]] },
    { key: 'FIVE', main: [39.82, 17.27, 1.29, 4.77], colour: ['CYAN', [39.28, 6.25, 3.68, 2.47]], caps: ['⇦', [39.62, 9.38, 2.04, 3.45]], sym: ['%', [42.95, 20.39, 1.16, 2.80]], graphic: [42.75, 15.30, 1.50, 3.29], extSym: ['CLOSE #', [39.28, 26.32, 4.49, 2.47]] },
    { key: 'SIX', main: [48.81, 17.27, 1.29, 4.77], colour: ['YELLOW', [48.33, 6.25, 5.65, 2.47]], caps: ['⇩', [48.06, 9.70, 1.97, 3.12]], sym: ['&', [51.94, 20.39, 0.95, 2.63]], graphic: [51.74, 15.30, 1.50, 3.29], extSym: ['MOVE', [48.40, 26.32, 3.88, 2.47]] },
    { key: 'SEVEN', main: [57.79, 17.27, 1.29, 4.77], colour: ['WHITE', [57.39, 6.25, 4.36, 2.47]], caps: ['⇧', [56.98, 9.54, 1.97, 3.12]], sym: ['\'', [60.93, 20.39, 0.27, 1.15]], graphic: [60.72, 15.30, 1.50, 3.29], extSym: ['ERASE', [57.45, 26.32, 4.42, 2.47]] },
    { key: 'EIGHT', main: [66.78, 17.27, 1.23, 4.77], caps: ['⇨', [66.10, 9.21, 2.04, 3.45]], sym: ['(', [69.84, 19.90, 0.41, 3.29]], graphic: [69.71, 15.30, 1.50, 3.29], extSym: ['POINT', [66.37, 26.32, 4.02, 2.47]] },
    { key: 'NINE', main: [75.56, 17.27, 1.29, 4.77], caps: ['GRAPHICS', [75.02, 9.54, 7.01, 2.47]], sym: [')', [78.69, 19.90, 0.41, 3.29]], extSym: ['CAT', [75.09, 26.32, 2.59, 2.47]] },
    { key: 'ZERO', main: [84.28, 17.27, 1.29, 4.77], colour: ['BLACK', [83.87, 5.92, 4.63, 3.12]], caps: ['DELETE', [83.80, 9.38, 5.17, 2.47]], sym: ['_', [87.07, 23.19, 1.84, 0.49]], extSym: ['FORMAT', [83.93, 26.32, 5.65, 2.47]] },
    { key: 'Q', main: [8.37, 37.34, 1.91, 5.10], ext: ['SIN', [8.24, 31.91, 2.04, 2.47]], sym: ['<=', [11.30, 37.99, 2.38, 3.29]], keyword: ['PLOT', [10.48, 43.09, 3.54, 2.47]], extSym: ['ASN', [8.10, 48.36, 2.65, 2.47]] },
    { key: 'W', main: [17.22, 37.34, 2.59, 4.77], ext: ['COS', [17.15, 31.91, 2.79, 2.47]], sym: ['<>', [20.29, 37.99, 2.38, 3.29]], keyword: ['DRAW', [18.86, 43.09, 4.15, 2.47]], extSym: ['ACS', [17.02, 48.36, 2.72, 2.47]] },
    { key: 'E', main: [26.41, 37.34, 1.50, 4.77], ext: ['TAN', [26.21, 31.91, 2.59, 2.47]], sym: ['>=', [29.41, 37.99, 2.25, 3.29]], keyword: ['REM', [29.07, 43.09, 2.86, 2.47]], extSym: ['ATN', [26.14, 48.36, 2.59, 2.47]] },
    { key: 'R', main: [35.40, 37.34, 1.70, 4.77], ext: ['INT', [35.19, 31.91, 2.11, 2.47]], sym: ['<', [38.46, 37.99, 0.95, 3.29]], keyword: ['RUN', [38.12, 43.09, 2.72, 2.47]], extSym: ['VERIFY', [35.06, 48.36, 4.90, 2.47]] },
    { key: 'T', main: [44.32, 37.34, 1.50, 4.77], ext: ['RND', [44.11, 31.91, 2.79, 2.47]], sym: ['>', [48.13, 37.99, 0.88, 3.29]], keyword: ['RANDOMIZE', [46.15, 43.09, 3.74, 2.47]], extSym: ['MERGE', [44.18, 48.36, 4.83, 2.47]] },
    { key: 'Y', main: [53.23, 37.34, 1.70, 4.77], ext: ['STR$', [53.17, 31.74, 3.34, 2.96]], sym: ['AND', [56.09, 37.66, 2.59, 2.14]], keyword: ['RETURN', [53.37, 43.09, 5.45, 2.47]], extSym: ['[', [53.37, 48.52, 0.34, 2.96]] },
    { key: 'U', main: [62.36, 37.34, 1.57, 4.77], ext: ['CHR$', [62.15, 31.74, 3.61, 2.96]], sym: ['OR', [65.96, 37.66, 1.77, 2.14]], keyword: ['IF', [66.78, 43.09, 1.02, 2.47]], extSym: [']', [62.36, 48.52, 0.34, 2.96]] },
    { key: 'I', main: [71.34, 37.34, 0.34, 4.77], ext: ['CODE', [71.07, 31.91, 3.81, 2.47]], sym: ['AT', [74.95, 37.66, 1.70, 2.14]], keyword: ['INPUT', [72.91, 43.09, 4.02, 2.47]], extSym: ['IN', [71.20, 48.36, 1.09, 2.47]] },
    { key: 'O', main: [80.12, 37.34, 1.84, 4.77], ext: ['PEEK', [79.71, 31.91, 3.54, 2.47]], sym: [';', [84.21, 37.83, 0.27, 3.62]], keyword: ['POKE', [81.96, 43.09, 3.74, 2.47]], extSym: ['OUT', [79.92, 48.36, 2.79, 2.47]] },
    { key: 'P', main: [88.84, 37.34, 1.50, 4.77], ext: ['TAB', [88.63, 31.91, 2.52, 2.47]], sym: ['"', [93.06, 37.99, 0.82, 1.48]], keyword: ['PRINT', [90.54, 43.09, 4.02, 2.47]], extSym: ['©', [88.63, 48.36, 1.02, 2.47]] },
    { key: 'A', main: [10.89, 59.21, 1.97, 4.77], ext: ['READ', [10.89, 53.62, 3.61, 2.47]], sym: ['STOP', [13.41, 59.38, 3.20, 2.14]], keyword: ['NEW', [13.55, 64.97, 3.06, 2.47]], extSym: ['~', [10.82, 71.05, 0.68, 0.49]] },
    { key: 'S', main: [20.01, 59.21, 1.57, 4.77], ext: ['RESTORE', [19.81, 53.62, 6.47, 2.47]], sym: ['NOT', [23.01, 59.38, 2.52, 2.14]], keyword: ['SAVE', [22.06, 64.97, 3.54, 2.47]], extSym: ['|', [20.01, 70.07, 0.14, 3.12]] },
    { key: 'D', main: [29.07, 59.21, 1.63, 4.77], ext: ['DATA', [28.93, 53.62, 3.54, 2.47]], sym: ['STEP', [31.38, 59.38, 3.06, 2.14]], keyword: ['DIM', [32.27, 64.97, 2.31, 2.47]], extSym: ['\\', [28.86, 70.23, 0.61, 2.63]] },
    { key: 'F', main: [38.05, 59.21, 1.36, 4.77], ext: ['SGN', [37.85, 53.62, 2.72, 2.47]], sym: ['TO', [41.66, 59.38, 1.63, 2.14]], keyword: ['FOR', [40.84, 64.97, 2.72, 2.47]], extSym: ['{', [37.85, 70.23, 0.48, 2.96]] },
    { key: 'G', main: [46.97, 59.21, 1.84, 4.77], ext: ['ABS', [46.63, 53.62, 2.65, 2.47]], sym: ['THEN', [49.29, 59.38, 3.20, 2.14]], keyword: ['GO TO', [48.74, 64.97, 3.88, 2.47]], extSym: ['}', [46.83, 70.23, 0.54, 2.96]] },
    { key: 'H', main: [56.02, 59.21, 1.57, 4.77], ext: ['SQR', [55.82, 53.62, 2.79, 2.63]], sym: ['↑', [59.50, 59.54, 1.16, 3.95]], keyword: ['GO SUB', [56.71, 64.97, 4.83, 2.47]], extSym: ['CIRCLE', [55.89, 70.07, 4.83, 2.47]] },
    { key: 'J', main: [64.87, 59.21, 1.23, 4.77], ext: ['VAL', [64.81, 53.62, 2.52, 2.47]], sym: ['-', [68.62, 61.68, 0.75, 0.49]], keyword: ['LOAD', [66.78, 64.97, 3.68, 2.47]], extSym: ['VAL$', [64.87, 70.07, 3.20, 2.80]] },
    { key: 'K', main: [74.00, 59.21, 1.70, 4.77], ext: ['LEN', [73.79, 53.62, 2.38, 2.47]], sym: ['+', [77.54, 60.53, 1.16, 2.80]], keyword: ['LIST', [76.72, 64.97, 2.86, 2.47]], extSym: ['SCREEN$', [73.79, 70.07, 6.33, 2.80]] },
    { key: 'L', main: [82.71, 59.21, 1.36, 4.77], ext: ['USR', [82.30, 53.62, 2.72, 2.47]], sym: ['=', [86.52, 61.18, 1.09, 1.64]], keyword: ['LET', [85.84, 64.97, 2.45, 2.47]], extSym: ['ATTR', [82.37, 70.07, 3.54, 2.47]] },
    { key: 'Z', main: [15.32, 81.09, 1.57, 4.77], ext: ['LN', [15.25, 75.66, 1.50, 2.47]], sym: [':', [19.40, 81.91, 0.34, 3.29]], keyword: ['COPY', [17.22, 87.01, 3.74, 2.47]], extSym: ['BEEP', [15.18, 92.27, 3.47, 2.47]] },
    { key: 'X', main: [24.23, 81.09, 1.77, 4.77], ext: ['EXP', [24.17, 75.66, 2.59, 2.47]], sym: ['£', [27.84, 81.74, 1.02, 3.29]], keyword: ['CLEAR', [25.39, 87.01, 4.56, 2.47]], extSym: ['INK', [24.17, 92.27, 2.11, 2.47]] },
    { key: 'C', main: [33.36, 81.09, 1.70, 4.77], ext: ['LPRINT', [33.22, 75.66, 4.77, 2.47]], sym: ['?', [37.24, 81.91, 0.95, 3.29]], keyword: ['CONT', [35.19, 87.01, 3.81, 2.47]], extSym: ['PAPER', [33.22, 92.27, 4.49, 2.47]] },
    { key: 'V', main: [42.27, 81.09, 1.77, 4.77], ext: ['LLIST', [42.21, 75.66, 3.47, 2.47]], sym: ['/', [45.81, 81.58, 0.88, 3.78]], keyword: ['CLS', [45.34, 87.01, 2.59, 2.47]], extSym: ['FLASH', [42.14, 92.27, 4.15, 2.47]] },
    { key: 'B', main: [51.40, 81.09, 1.63, 4.77], ext: ['BIN', [51.06, 75.66, 2.11, 2.47]], sym: ['*', [55.00, 83.06, 0.95, 2.47]], keyword: ['BORDER', [51.19, 87.01, 5.79, 2.47]], extSym: ['BRIGHT', [51.12, 92.27, 5.04, 2.47]] },
    { key: 'N', main: [60.38, 81.09, 1.57, 4.77], ext: ['INKEY$', [60.18, 75.49, 4.70, 2.96]], sym: [',', [64.40, 83.55, 0.34, 1.48]], keyword: ['NEXT', [62.42, 87.01, 3.54, 2.47]], extSym: ['OVER', [60.18, 92.27, 3.81, 2.47]] },
    { key: 'M', main: [69.37, 81.09, 1.91, 4.77], ext: ['PI', [69.23, 75.66, 1.02, 2.47]], sym: ['.', [73.38, 83.88, 0.27, 0.66]], keyword: ['PAUSE', [70.32, 87.01, 4.49, 2.47]], extSym: ['INVERSE', [69.30, 92.27, 5.79, 2.47]] },
];
const LEGENDS_BY_KEY = new Map(LEGENDS.map(entry => [entry.key, entry]));

/* Where the bands of legends above and below the rows of caps meet, in
 * percent of the image's height; the top row's band above holds the colour
 * line over the Caps Shift line. */
const ROW_SPLITS = [30.26, 52.30, 74.34];
const COLOUR_LINE_END = 9.05;

/* A column of legends starts this far left of its cap, as they are drawn
 * from the cap's left edge, and runs on to the next cap's column. */
const COLUMN_LEAD = 0.5;

const CAPS = SPECCY.CAPS_SHIFT;
const SYMBOL = SPECCY.SYMBOL_SHIFT;
const EXTEND = [CAPS, SYMBOL];  // extended mode, EXTEND MODE on the later keyboards
const GRAPHICS = [CAPS, SPECCY.NINE];

// Symbol Shift legends that are keywords, which the 128 BASIC editor takes only spelled out.
const TOKEN_SYMBOLS = new Set(['<=', '<>', '>=', 'AND', 'OR', 'AT', 'STOP', 'NOT', 'STEP', 'TO', 'THEN']);

// Caps Shift legends the 128 BASIC editor ignores: TRUE VIDEO and INV. VIDEO.
const IGNORED_BY_128 = new Set(['THREE', 'FOUR']);

const KEY_LABELS = {
    ONE: '1', TWO: '2', THREE: '3', FOUR: '4', FIVE: '5', SIX: '6', SEVEN: '7', EIGHT: '8', NINE: '9', ZERO: '0',
    CAPS_SHIFT: 'CAPS SHIFT', SYMBOL_SHIFT: 'SYMBOL SHIFT', BREAK_SPACE: 'SPACE',
};
export const keyLabel = (name) => KEY_LABELS[name] || name;
const nameOfKey = (key) => Object.keys(SPECCY).find(n => (SPECCY[n].row === key.row) && (SPECCY[n].mask === key.mask));

// A chord's name for the user: the two shift chords by the modes they give.
export function chordLabel(keys) {
    if ((keys.length === 2) && (keys[0] === CAPS) && (keys[1] === SYMBOL)) return 'EXTEND MODE';
    if ((keys.length === 2) && (keys[0] === CAPS) && (keys[1] === SPECCY.NINE)) return 'GRAPHICS';
    return keys.map(key => keyLabel(nameOfKey(key))).join(' + ');
}

const inBox = (x, y, box) => (x >= box[0]) && (x < (box[0] + box[2])) && (y >= box[1]) && (y < (box[1] + box[3]));

/* The key whose cap is at (x, y), in percent of the image, as {name, entry,
 * box}: name the key's in SPECCY, entry its legends (undefined for the keys
 * with none) and box its cap's. Null off the caps. */
export function capAt(x, y) {
    const layout = KEY_LAYOUT.find(layout => inBox(x, y, layout.box));
    return layout ? { name: layout.name, entry: LEGENDS_BY_KEY.get(layout.name), box: layout.box } : null;
}

/* The part of the keyboard at (x, y), in percent of the image, as {name,
 * entry, part}: name the key's in SPECCY, entry its legends (undefined for
 * the keys with none), and part the legend's field in the entry. A cap is
 * 'cap' while no editor waits, as all of it is the key; in an editor its
 * digit or letter is 'main' and its legends their own parts. Null where
 * nothing is. */
export function partAt(x, y, editor) {
    const cap = capAt(x, y);
    if (cap) {
        const { name, entry, box } = cap;
        if (!editor || !entry) return { name, entry, part: 'cap' };
        const rx = (x - box[0]) / box[2];
        const ry = (y - box[1]) / box[3];
        let part;
        if (entry.caps) part = (rx < 0.45) ? 'main' : ((entry.graphic && (ry < 0.5)) ? 'graphic' : 'sym');
        else part = (ry >= 0.62) ? 'keyword' : ((rx < 0.4) ? 'main' : 'sym');
        return { name, entry, part };
    }
    for (let r = 0; r < ROWS.length; r++) {
        const row = ROWS[r];
        const capTop = row[0].box[1];
        const capBottom = row[0].box[1] + row[0].box[3];
        let parts;
        if ((y < capTop) && (y >= ((r === 0) ? 0 : ROW_SPLITS[r - 1]))) {
            parts = (r > 0) ? ['ext'] : ((y < COLOUR_LINE_END) ? ['colour'] : ['caps']);
        } else if ((y >= capBottom) && (y < ((r < ROW_SPLITS.length) ? ROW_SPLITS[r] : 100))) {
            parts = ['extSym'];
        } else {
            continue;
        }
        for (let k = 0; k < row.length; k++) {
            const left = (k === 0) ? 0 : (row[k].box[0] - COLUMN_LEAD);
            const right = (k === (row.length - 1)) ? 100 : (row[k + 1].box[0] - COLUMN_LEAD);
            if ((x < left) || (x >= right)) continue;
            const entry = LEGENDS_BY_KEY.get(row[k].name);
            const part = parts.find(p => entry && entry[p]);
            return part ? { name: row[k].name, entry, part } : null;
        }
        return null;
    }
    return null;
}

// The text of an entry's part, as printed on the keyboard; a key's own name for 'main' and 'cap'.
export function partText(name, entry, part) {
    if ((part === 'main') || (part === 'cap')) return keyLabel(name);
    if (part === 'graphic') return 'block graphic ' + keyLabel(name);
    return entry[part][0];
}

// The box to highlight for an entry's part: the cap itself for 'cap'.
export function partBox(name, entry, part) {
    if (part === 'cap') return KEY_LAYOUT.find(layout => layout.name === name).box;
    if ((part === 'main') || (part === 'graphic')) return entry[part];
    return entry[part][1];
}

/* What a key alone gives, as the part of its entry that shows it, in the
 * editor `editor` with the on-screen keyboard's shifts `latched` ({caps,
 * sym}) down, whether latched, locked or held by a finger: 'cap' while no
 * editor waits, null for nothing the keyboard shows. */
export function plainPart(entry, editor, latched) {
    if (!editor || !entry) return 'cap';
    const cursor = editor.cursor;
    const is48 = (editor.kind === 48);
    if (latched.caps && latched.sym) return null;
    if (latched.sym) {
        if (cursor === 'E') return (is48 || !isKeyword('extSym', entry.extSym[0])) ? 'extSym' : null;
        return (is48 || !TOKEN_SYMBOLS.has(entry.sym[0])) ? 'sym' : null;
    }
    if (entry.caps) {
        // a digit: colours in E, block graphics in G (Caps Shift inverts them), else what Caps Shift gives
        if (cursor === 'E') return (is48 && entry.colour) ? 'colour' : null;
        if (cursor === 'G') return entry.graphic ? 'graphic' : (latched.caps ? 'caps' : null);
        if (!latched.caps) return 'main';
        return (is48 || !IGNORED_BY_128.has(entry.key)) ? 'caps' : null;
    }
    if (cursor === 'E') return is48 ? 'ext' : null;
    return (cursor === 'K') ? 'keyword' : 'main';
}

// Whether a legend is a keyword the 128 BASIC editor takes spelled out, rather than a character.
function isKeyword(part, text) {
    if ((part === 'ext') || (part === 'keyword')) return true;
    if (part === 'extSym') return /^[A-Z]/.test(text);
    if (part === 'sym') return TOKEN_SYMBOLS.has(text);
    return false;
}

/* A keyword as typed into the 128 BASIC editor: in small letters, which it
 * takes as well and which type the same with caps lock on, then a space
 * after a word, which it needs between keywords. */
function spelling(text) {
    return /[A-Z$]$/.test(text) ? (text.toLowerCase() + ' ') : text.toLowerCase();
}

/* The steps entering an entry's legend `part` in the editor `editor`, as
 * {steps, hold}: a step is a chord {keys}, or {text, chords} for spelled
 * text; hold is true for a single chord, which may be held down for as long
 * as the user holds the legend. Null for a legend not taken there. `inverse`
 * asks for a colour's INK rather than its PAPER, and for an inverted block
 * graphic. */
export function planLegend(name, entry, part, editor, inverse) {
    const key = SPECCY[name];
    const text = entry[part] && entry[part][0];
    const plan = (steps) => ({ steps, hold: (steps.length === 1) && !!steps[0].keys });
    const chords = (list) => list.map(keys => ({ keys }));
    if (!editor) {
        // No editor waits: the keys the keyboard gives the legend.
        if (part === 'colour') return plan(chords([EXTEND, inverse ? [CAPS, key] : [key]]));
        if (part === 'caps') return plan(chords([[CAPS, key]]));
        if (part === 'ext') return plan(chords([EXTEND, [key]]));
        if (part === 'extSym') return plan(chords([EXTEND, [SYMBOL, key]]));
        return null;
    }
    const inExtend = (editor.cursor === 'E');
    const inGraphics = (editor.cursor === 'G');
    // Out of E and G for keys of neither, and back to G after.
    const outside = (steps) => [
        ...(inExtend ? chords([EXTEND]) : []),
        ...(inGraphics ? chords([GRAPHICS]) : []),
        ...steps,
        ...(inGraphics ? chords([GRAPHICS]) : []),
    ];
    // Into E for a key of E, out of G first and back to it after.
    const extended = (keys) => chords([
        ...(inGraphics ? [GRAPHICS] : []),
        ...(inExtend ? [] : [EXTEND]),
        keys,
        ...(inGraphics ? [GRAPHICS] : []),
    ]);
    if ((editor.kind === 128) && isKeyword(part, text)) {
        const spelled = spelling(text);
        return plan(outside([{ text: spelled, chords: Array.from(spelled, ch => speccyKeysForChar(ch)) }]));
    }
    switch (part) {
        case 'colour':
            return (editor.kind === 48) ? plan(extended(inverse ? [CAPS, key] : [key])) : null;
        case 'ext':
            return plan(extended([key]));
        case 'extSym':
            return plan(extended([SYMBOL, key]));
        case 'sym':
            return plan(outside(chords([[SYMBOL, key]])));
        case 'caps':
            if ((editor.kind === 128) && IGNORED_BY_128.has(name)) return null;
            // GRAPHICS itself is the way out of G
            if (key === SPECCY.NINE) return plan(chords([...(inExtend ? [EXTEND] : []), [CAPS, key]]));
            return plan(outside(chords([[CAPS, key]])));
        case 'graphic':
            return plan(chords([
                ...(inExtend ? [EXTEND] : []),
                ...(inGraphics ? [] : [GRAPHICS]),
                inverse ? [CAPS, key] : [key],
                ...(inGraphics ? [] : [GRAPHICS]),
            ]));
        default:
            return null;
    }
}

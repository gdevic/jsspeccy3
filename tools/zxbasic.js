/*
 * tools/zxbasic.js: a BASIC listing, written as text, turned into the lines
 * the 48K ROM's editor holds once they are typed, for tools/zxheadless.js to
 * enter one by one. The ROM then checks each line and adds the hidden 5-byte
 * form after every number, as it does for a line typed at the keyboard, so
 * nothing here works out a number's value.
 *
 * A listing is one BASIC line per text line: its number, then its statements.
 * A text line that is empty, or starts with #, is left out, and a line ending
 * in a backslash goes on onto the next text line. Keywords are written in
 * capitals, as a listing shows them, as whole words (GOTO and GOSUB also do,
 * and OPEN# and CLOSE# for OPEN # and CLOSE #), and <=, >= and <> are their
 * tokens. Variable names are written in small letters, so that a keyword
 * mistyped is refused rather than taken for a variable. Spaces are left out
 * of a line except inside quotes and in a REM, since the ROM's listing puts
 * in its own.
 *
 * Inside quotes and in a REM these stand for characters no PC key gives:
 *   \a to \u   the user-defined graphics A to U (0x90 to 0xA4)
 *   \xNN       the character with that code, such as 0x80 to 0x8F for the
 *              block graphics or 0x10 to 0x17 for INK, PAPER, AT and the rest
 *   \\         a backslash
 *   £ and ©    themselves (0x60 and 0x7F)
 */

// The 48K ROM's keywords, from token 0xA5 up.
export const KEYWORDS = [
    'RND', 'INKEY$', 'PI', 'FN', 'POINT', 'SCREEN$', 'ATTR', 'AT', 'TAB', 'VAL$', 'CODE',
    'VAL', 'LEN', 'SIN', 'COS', 'TAN', 'ASN', 'ACS', 'ATN', 'LN', 'EXP', 'INT', 'SQR', 'SGN',
    'ABS', 'PEEK', 'IN', 'USR', 'STR$', 'CHR$', 'NOT', 'BIN', 'OR', 'AND', '<=', '>=', '<>',
    'LINE', 'THEN', 'TO', 'STEP', 'DEF FN', 'CAT', 'FORMAT', 'MOVE', 'ERASE', 'OPEN #',
    'CLOSE #', 'MERGE', 'VERIFY', 'BEEP', 'CIRCLE', 'INK', 'PAPER', 'FLASH', 'BRIGHT',
    'INVERSE', 'OVER', 'OUT', 'LPRINT', 'LLIST', 'STOP', 'READ', 'DATA', 'RESTORE', 'NEW',
    'BORDER', 'CONTINUE', 'DIM', 'REM', 'FOR', 'GO TO', 'GO SUB', 'INPUT', 'LOAD', 'LIST',
    'LET', 'PAUSE', 'NEXT', 'POKE', 'PRINT', 'PLOT', 'RUN', 'SAVE', 'RANDOMIZE', 'IF', 'CLS',
    'DRAW', 'CLEAR', 'RETURN', 'COPY',
];
export const FIRST_TOKEN = 0xa5;

const ALIASES = { GOTO: 'GO TO', GOSUB: 'GO SUB', 'OPEN#': 'OPEN #', 'CLOSE#': 'CLOSE #', CONT: 'CONTINUE' };

// Every way of writing a keyword, longest first, so that INPUT is found before IN.
const SPELLINGS = [
    ...KEYWORDS.map((text, i) => ({ text, token: FIRST_TOKEN + i })),
    ...Object.entries(ALIASES).map(([text, keyword]) => ({ text, token: FIRST_TOKEN + KEYWORDS.indexOf(keyword) })),
].sort((a, b) => b.text.length - a.text.length);

const isWordChar = (ch) => !!ch && /[A-Za-z0-9$]/.test(ch);

// The keyword written as a whole word at `at` in `text`, or null.
function keywordAt(text, at) {
    return SPELLINGS.find(k => text.startsWith(k.text, at)
        && !(/^[A-Z]/.test(k.text) && isWordChar(text[at - 1]) && (text[at - 1] !== '$'))
        && !(/[A-Z]$/.test(k.text) && /[A-Za-z0-9]/.test(text[at + k.text.length] || ''))) || null;
}

function lineError(where, message) {
    return new Error(`${where}: ${message}`);
}

/* One character of a string or REM, with the escapes above, at `at`:
 * {code, length}. */
function literalAt(text, at, where) {
    const ch = text[at];
    if (ch === '\\') {
        const next = text[at + 1];
        if (next === '\\') return { code: 0x5c, length: 2 };
        if (next === 'x') {
            const hex = text.slice(at + 2, at + 4);
            if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw lineError(where, `bad escape \\x${hex}`);
            return { code: parseInt(hex, 16), length: 4 };
        }
        if (next && (next >= 'a') && (next <= 'u')) return { code: 0x90 + (next.charCodeAt(0) - 0x61), length: 2 };
        throw lineError(where, `bad escape \\${next}`);
    }
    if (ch === '£') return { code: 0x60, length: 1 };
    if (ch === '©') return { code: 0x7f, length: 1 };
    const code = ch.charCodeAt(0);
    if ((code < 0x20) || (code > 0x7e) || (code === 0x60)) throw lineError(where, `no Spectrum character for ${JSON.stringify(ch)}`);
    return { code, length: 1 };
}

/* One BASIC line's text (its number and statements) as the editor holds it
 * once typed: the number's digits, then tokens and characters. */
export function editLine(text, where) {
    const bytes = [];
    let at = 0;
    let quoted = false;
    let rem = false;
    let remStart = false;
    while (at < text.length) {
        const ch = text[at];
        if (quoted || rem) {
            if (quoted && (ch === '"')) {
                quoted = false;
                bytes.push(0x22);
                at++;
                continue;
            }
            if (remStart && (ch === ' ')) {
                at++;
                continue;
            }
            remStart = false;
            const lit = literalAt(text, at, where);
            bytes.push(lit.code);
            at += lit.length;
            continue;
        }
        if (ch === ' ') {
            at++;
            continue;
        }
        if (ch === '"') {
            quoted = true;
            bytes.push(0x22);
            at++;
            continue;
        }
        const keyword = keywordAt(text, at);
        if (keyword) {
            bytes.push(keyword.token);
            at += keyword.text.length;
            if (keyword.token === FIRST_TOKEN + KEYWORDS.indexOf('REM')) rem = remStart = true;
            continue;
        }
        if (/[A-Z]/.test(ch)) {
            const word = text.slice(at).match(/^[A-Za-z0-9$]+/)[0];
            throw lineError(where, `"${word}" is no keyword, and variables are written in small letters`);
        }
        const lit = literalAt(text, at, where);
        if (lit.length !== 1) throw lineError(where, 'escapes go only inside quotes or a REM');
        bytes.push(lit.code);
        at++;
    }
    if (quoted) throw lineError(where, 'a string is not closed');
    return Uint8Array.from(bytes);
}

/* A listing as its BASIC lines, [{number, bytes, where}], in order, `name`
 * naming the listing in errors. */
export function parseListing(source, name) {
    const lines = [];
    const textLines = String(source).replace(/\r\n?/g, '\n').split('\n');
    for (let n = 0; n < textLines.length; n++) {
        let text = textLines[n];
        const first = n + 1;
        while (text.endsWith('\\') && !text.endsWith('\\\\') && (n + 1 < textLines.length)) {
            text = text.slice(0, -1) + textLines[++n].trimStart();
        }
        const trimmed = text.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const where = `${name}:${first}`;
        const match = trimmed.match(/^(\d+)\s*(.*)$/);
        if (!match) throw lineError(where, 'a line starts with its number');
        const number = Number(match[1]);
        if ((number < 1) || (number > 9999)) throw lineError(where, `line number ${number} is out of range`);
        if (lines.length && (number <= lines[lines.length - 1].number)) throw lineError(where, `line ${number} is out of order`);
        const body = editLine(match[2], where);
        const digits = Array.from(String(number), c => c.charCodeAt(0));
        lines.push({ number, bytes: Uint8Array.from([...digits, ...body]), where });
    }
    return lines;
}

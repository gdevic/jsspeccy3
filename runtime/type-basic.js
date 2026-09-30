/*
 * runtime/type-basic.js: typing BASIC into the Spectrum as someone at its
 * keyboard would, for whatever puts text into the machine for the user or
 * a script: the Type in buttons (runtime/type-in.js) and
 * emu.keyboard.typeBasic (runtime/script-api.js).
 *
 * The text goes into the ROM's line editor waiting for it (editorState in
 * runtime/worker.js), each key chosen from the editor as it stands by then:
 *
 * - The standard 48K editor (48 BASIC on any machine, a program's INPUT,
 *   TR-DOS) takes a keyword only from its key: in K mode where a statement
 *   begins, in extended mode, or with Symbol Shift (the legends in
 *   runtime/keyboard-legends.js). Keywords are typed that way, and the
 *   spaces beside them are left out, as the editor puts in its own. A
 *   statement's keyword anywhere else is refused, since no key gives it
 *   there, and so is a letter where a statement begins.
 * - The 128 BASIC editor and the gw03 ROM's 48K editor take keywords
 *   spelled out and have no K mode, so the text goes in letter by letter,
 *   spaces and all.
 *
 * A keyword is recognised written in capitals, as a listing shows it, as a
 * whole word, and outside quotes and REM; GOTO, GOSUB, OPEN# and CLOSE# are
 * taken for GO TO, GO SUB, OPEN # and CLOSE #. A capital is typed with Caps
 * Shift, or alone with caps lock on, and a small letter with caps lock
 * off: it is turned off for one, and back on before the line is entered. A
 * line's indent is left out. A newline is Enter, and the editor must take
 * the line before typing goes on: the 48K editor shows it has by waiting
 * on an empty line again, or at the next INPUT, and one that keeps the line,
 * with its mistake marked, stops the typing.
 */
import { SPECCY, speccyKeysForChar, KEY_HOLD_MS, KEY_GAP_MS } from './keyboard.js';
import { TEXT_LEGENDS } from './keyboard-legends.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CAPS = SPECCY.CAPS_SHIFT;
const SYMBOL = SPECCY.SYMBOL_SHIFT;
const EXTEND = [CAPS, SYMBOL];  // extended mode, EXTEND MODE on the later keyboards
const GRAPHICS = [CAPS, SPECCY.NINE];
const CAPS_LOCK = [CAPS, SPECCY.TWO];

// How long typing waits for the editor, unless told otherwise: at the start, and for a line to go in.
const WAIT_MS = 10000;
// How long the 48K editor may keep a line after its Enter before the line counts as refused.
const REFUSED_MS = 1000;
// How often the editor is looked at while typing waits for it.
const POLL_MS = 20;

// Other ways of writing a keyword, and the keyword each stands for.
const ALIASES = { GOTO: 'GO TO', GOSUB: 'GO SUB', 'OPEN#': 'OPEN #', 'CLOSE#': 'CLOSE #' };

/* The keywords, as {text, spelled, name, part}: text as written, spelled
 * the keyword itself, and name and part its legend's (see TEXT_LEGENDS).
 * Longest first, so that INPUT is found before IN. */
const KEYWORDS = (() => {
    const legends = TEXT_LEGENDS.filter(legend => legend.keyword);
    const byText = new Map(legends.map(legend => [legend.text, legend]));
    return [
        ...legends.map(legend => ({ ...legend, spelled: legend.text })),
        ...Object.entries(ALIASES).map(([text, spelled]) => ({ ...byText.get(spelled), text, spelled })),
    ].sort((a, b) => b.text.length - a.text.length);
})();

// The characters only a legend in extended mode with Symbol Shift gives: [ ] ~ | \ { } ©.
const LEGEND_CHARS = new Map(TEXT_LEGENDS
    .filter(legend => !legend.keyword && (legend.text.length === 1) && !speccyKeysForChar(legend.text))
    .map(legend => [legend.text, legend]));

const isWordChar = (ch) => !!ch && /[A-Za-z0-9]/.test(ch);

// An Error saying what stopped the typing, with `where` ({line, column}) on it where it is known.
function typingError(message, where) {
    const err = new Error(message);
    if (where && where.line) err.line = where.line;
    if (where && where.column) err.column = where.column;
    return err;
}

// The keyword written as a whole word at `at` in `text`, or null.
function keywordAt(text, at) {
    return KEYWORDS.find(keyword => text.startsWith(keyword.text, at)
        && !(/^[A-Z]/.test(keyword.text) && isWordChar(text[at - 1]))
        && !(/[A-Z]$/.test(keyword.text) && isWordChar(text[at + keyword.text.length]))) || null;
}

/* The text as the steps that type it, each with its line and column: a
 * {keyword}, a {char} (literal inside quotes and after REM, and a space
 * besideKeyword next to a keyword but for other spaces), or an {enter} for
 * a newline, with the text of the line it ends. Keywords are recognised
 * unless `keywords` is false. Throws for a character no key types. */
function parse(text, keywords) {
    const source = String(text).replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
    const steps = [];
    let line = 1;
    let lineStart = 0;
    let quoted = false;
    let rem = false;
    let remStart = false;  // the spaces straight after REM are its own, not the remark's
    let indent = true;
    for (let at = 0; at < source.length;) {
        const ch = source[at];
        const where = { line, column: (at - lineStart) + 1 };
        if (ch === '\n') {
            steps.push({ enter: true, text: source.slice(lineStart, at).trim(), ...where });
            line++;
            lineStart = at + 1;
            quoted = rem = false;
            indent = true;
            at++;
            continue;
        }
        if (indent && (ch === ' ')) {
            at++;
            continue;
        }
        indent = false;
        const keyword = (keywords && !quoted && !rem) ? keywordAt(source, at) : null;
        if (keyword) {
            steps.push({ keyword, ...where });
            rem = remStart = (keyword.spelled === 'REM');
            at += keyword.text.length;
            continue;
        }
        if (!speccyKeysForChar(ch) && !LEGEND_CHARS.has(ch)) throw typingError(`No key types ${JSON.stringify(ch)}`, where);
        if ((ch === '"') && !rem) quoted = !quoted;
        if (ch !== ' ') remStart = false;
        steps.push({ char: ch, literal: quoted || (rem && !remStart), ...where });
        at++;
    }
    // The steps either side of a space, over any other spaces.
    const loose = (step) => step && (step.char === ' ') && !step.literal;
    const past = (n, by) => {
        let k = n + by;
        while (loose(steps[k])) k += by;
        return steps[k];
    };
    steps.forEach((step, n) => {
        if (loose(step)) step.besideKeyword = !!(((past(n, -1) || {}).keyword) || ((past(n, 1) || {}).keyword));
    });
    return steps;
}

/* Where `text` has a character no key types, as {line, column, char}, or
 * null when every one can be typed. */
export function findUntypeable(text) {
    try {
        parse(text, false);
        return null;
    } catch (err) {
        const ch = String(text).replace(/\r\n?/g, '\n').split('\n')[err.line - 1][err.column - 1];
        return { line: err.line, column: err.column, char: ch };
    }
}

/* Whether the Spectrum waits for a command on an empty line, so that typed
 * text can neither go into a running program nor onto the end of a line:
 * {ok, why}, why saying what to do first when it doesn't. */
export function readyForCommand(emu) {
    if (emu.isInitiallyPaused) return { ok: false, why: 'Switch the Spectrum on first' };
    const editor = emu.editorState;
    if (!editor || !editor.command) return { ok: false, why: 'The Spectrum isn’t waiting for a command on an empty line' };
    return { ok: true, why: '' };
}

// Whether the editor `editor` takes keywords spelled out rather than from their keys.
const spellsKeywords = (emu, editor) => (editor.kind === 128) || ((emu.machineType === 48) && (emu.rom48Variant === 'gw03'));

// What each machine is typing, so that a second call waits for the first.
const queues = new WeakMap();

/* Types `text` into the editor waiting for it (see the top of this file),
 * switching on a paused Spectrum. opts: holdMs and gapMs, how long each key
 * is held down and let go (80ms and 120ms unless given); waitMs, how long
 * to wait for the editor, at the start and for each line to go in (10
 * seconds unless given); keywords false to type every word letter by
 * letter, as for an answer to INPUT; signal, an AbortSignal that stops the
 * typing between two keys. Typing for the same machine goes one call after
 * another. Resolves once the last key is up; otherwise fails, every key let
 * go, with an Error saying why, and the line and column it stopped at where
 * there is one: a character no key types (before any key goes down), the
 * Spectrum switched off, paused or not waiting for keys, a keyword where
 * the editor can't take it, or a line refused. */
export function typeBasic(emu, text, opts = {}) {
    let steps;
    try {
        steps = parse(text, opts.keywords !== false);
    } catch (err) {
        return Promise.reject(err);
    }
    const run = () => typeSteps(emu, steps, opts);
    const typed = (queues.get(emu) || Promise.resolve()).then(run, run);
    queues.set(emu, typed.catch(() => {}));
    return typed;
}

async function typeSteps(emu, steps, opts) {
    const holdMs = opts.holdMs ?? KEY_HOLD_MS;
    const gapMs = opts.gapMs ?? KEY_GAP_MS;
    const waitMs = opts.waitMs ?? WAIT_MS;
    const signal = opts.signal || null;

    const stopIfAsked = () => {
        if (signal && signal.aborted) throw signal.reason || new DOMException('The typing was stopped', 'AbortError');
    };
    const press = async (keys) => {
        stopIfAsked();
        if (!emu.isRunning) throw typingError('The Spectrum was paused or switched off');
        keys.forEach(key => emu.keyDown(key.row, key.mask));
        try {
            await sleep(holdMs);
        } finally {
            keys.slice().reverse().forEach(key => emu.keyUp(key.row, key.mask));
        }
        await sleep(gapMs);
    };
    /* The editor once `ready(editor)` holds; fails with timedOut() after
     * waitMs, or earlier with what refused(editor, ms) gives, if anything. */
    const waitFor = async (ready, timedOut, refused) => {
        const start = performance.now();
        for (;;) {
            stopIfAsked();
            const editor = emu.editorState;
            if (ready(editor)) return editor;
            const ms = performance.now() - start;
            const refusal = refused && refused(editor, ms);
            if (refusal) throw refusal;
            if (ms >= waitMs) throw timedOut();
            await sleep(POLL_MS);
        }
    };
    const editorNow = () => waitFor(editor => !!editor, () => typingError('The Spectrum stopped waiting for keys'));

    /* Leaves graphics mode, and goes into extended mode or out of it as
     * `extend` asks; resolves to the editor then. */
    const setMode = async (extend) => {
        for (let tries = 0; tries < 3; tries++) {
            const editor = await editorNow();
            if (editor.cursor === 'G') await press(GRAPHICS);
            else if ((editor.cursor === 'E') !== extend) await press(EXTEND);
            else return editor;
        }
        throw typingError('The Spectrum’s editor didn’t change mode');
    };

    let capsLockOff = false;  // caps lock turned off here, to go back on before Enter
    const restoreCapsLock = async () => {
        if (!capsLockOff) return;
        // Caps Shift and 2 give a colour in extended mode
        const editor = await setMode(false);
        capsLockOff = false;
        if (editor.cursor !== 'C') await press(CAPS_LOCK);
    };

    const typeChar = async (ch, spelled, where) => {
        const legend = LEGEND_CHARS.get(ch);
        if (legend) {
            await setMode(true);
            await press([SYMBOL, SPECCY[legend.name]]);
            return;
        }
        let editor = await setMode(false);
        if (!/^[A-Za-z]$/.test(ch)) {
            await press(speccyKeysForChar(ch));
            return;
        }
        if (!spelled && (editor.cursor === 'K')) {
            throw typingError(`"${ch}" can't go where a statement begins, as the Spectrum takes a keyword there`, where);
        }
        const capital = (ch >= 'A') && (ch <= 'Z');
        if (!capital && (editor.cursor === 'C')) {
            await press(CAPS_LOCK);
            capsLockOff = true;
            editor = await editorNow();
            if (editor.cursor === 'C') throw typingError('The Spectrum’s caps lock didn’t go off', where);
        }
        const key = SPECCY[ch.toUpperCase()];
        await press((capital && (editor.cursor !== 'C')) ? [CAPS, key] : [key]);
    };

    const typeKeyword = async (keyword, where) => {
        const key = SPECCY[keyword.name];
        if ((keyword.part === 'ext') || (keyword.part === 'extSym')) {
            await setMode(true);
            await press((keyword.part === 'ext') ? [key] : [SYMBOL, key]);
            return;
        }
        const editor = await setMode(false);
        if (keyword.part === 'sym') {
            await press([SYMBOL, key]);
            return;
        }
        if (editor.cursor !== 'K') throw typingError(`${keyword.spelled} can go only where a statement begins`, where);
        await press([key]);
    };

    // After Enter: the editor waits again on an empty line or at an INPUT; the 48K editor keeping the line refused it.
    const lineGoesIn = (enter) => waitFor(
        editor => !!editor && (editor.command || editor.input),
        () => typingError(`The Spectrum didn’t come back to its editor after "${enter.text}"`, enter),
        (editor, ms) => (editor && (editor.kind === 48) && !editor.command && !editor.input && (ms >= REFUSED_MS))
            ? typingError(`The Spectrum refused "${enter.text}", marking a mistake in it`, enter) : null,
    );

    if (emu.isInitiallyPaused) throw typingError('The Spectrum is switched off');
    if (!emu.isRunning) emu.start();
    await waitFor(editor => !!editor, () => typingError('The Spectrum isn’t waiting for keys in its editor'));
    for (let n = 0; n < steps.length; n++) {
        const step = steps[n];
        if (step.enter) {
            await restoreCapsLock();
            await press([SPECCY.ENTER]);
            if (n < (steps.length - 1)) await lineGoesIn(step);
            continue;
        }
        const spelled = spellsKeywords(emu, await editorNow());
        if (step.keyword && spelled) {
            for (const ch of step.keyword.spelled) await typeChar(ch, true, step);
        } else if (step.keyword) {
            await typeKeyword(step.keyword, step);
        } else if (spelled || !step.besideKeyword) {
            await typeChar(step.char, spelled, step);
        }
    }
    if (emu.editorState) await restoreCapsLock();
}

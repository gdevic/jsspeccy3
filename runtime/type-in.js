/*
 * runtime/type-in.js: the row under a file picked in the recorder's or a
 * Microdrive's window, with the command that loads it. Clicking the
 * command copies it; Type in types it into the Spectrum for the user (see
 * runtime/type-basic.js), who then presses Enter to run it. Type in is
 * offered only while the Spectrum waits for a command on an empty line, so
 * the keys can't go into a running program or onto the end of a line.
 */
import { typeBasic, readyForCommand, findUntypeable } from './type-basic.js';

/* Whether `command` can be typed in now: {ok, why}, why being the button's
 * tooltip, which says what to do first when it can't. */
function typeInState(emu, command) {
    const ready = readyForCommand(emu);
    if (!ready.ok) return ready;
    if (findUntypeable(command)) return { ok: false, why: 'The command has a character no key types' };
    return { ok: true, why: 'Types this command on the Spectrum; press Enter to run it' };
}

/* The command row: {element, setCommand(text), dispose()}. The element is
 * hidden until a command is set, and again when it is set to null; dispose
 * stops it following the machine, for when its window closes. */
export function makeCommandRow(emu) {
    const element = document.createElement('div');
    Object.assign(element.style, {
        display: 'none', padding: '8px 10px', background: '#111', borderTop: '1px solid #333',
        fontFamily: 'Consolas, Monaco, monospace', fontSize: '12px', alignItems: 'center', gap: '8px',
    });
    const text = document.createElement('span');
    Object.assign(text.style, {
        flex: '1', color: '#8f8', overflowWrap: 'anywhere', userSelect: 'none', cursor: 'pointer', borderRadius: '3px',
    });
    text.title = 'Click to copy';
    // "Copied", or why typing stopped, for a moment
    const note = document.createElement('span');
    Object.assign(note.style, { display: 'none', fontFamily: 'sans-serif', fontSize: '11px' });
    const button = document.createElement('button');
    Object.assign(button.style, {
        border: 'none', background: '#333', color: '#ccc', borderRadius: '4px', padding: '3px 8px', whiteSpace: 'nowrap',
    });
    button.textContent = 'Type in';
    element.append(text, note, button);

    let command = null;
    let typing = false;
    let noteTimer = null;

    function showNote(message, colour, ms) {
        note.textContent = message;
        note.style.color = colour;
        note.style.display = 'inline';
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => {
            text.style.background = '';
            note.style.display = 'none';
        }, ms);
    }

    function refresh() {
        const state = typing ? { ok: false, why: 'Typing…' } : typeInState(emu, command || '');
        button.title = state.why;
        button.setAttribute('aria-disabled', String(!state.ok));
        button.style.opacity = state.ok ? '1' : '0.45';
        button.style.cursor = state.ok ? 'pointer' : 'default';
    }

    button.addEventListener('click', async () => {
        if (!command || typing || !typeInState(emu, command).ok) return;
        typing = true;
        button.textContent = 'Typing…';
        refresh();
        try {
            await typeBasic(emu, command);
            emu.focus();
        } catch (err) {
            showNote((err && err.message) || String(err), '#e88', 4000);
        } finally {
            typing = false;
            button.textContent = 'Type in';
            refresh();
        }
    });

    /* A click copies the whole command. Nothing is selected, since a browser
     * puts its own menu over a selection made with the mouse: the command
     * is lit up as if selected instead, while "Copied" shows. */
    text.addEventListener('click', () => {
        if (!command || !navigator.clipboard || !navigator.clipboard.writeText) return;
        navigator.clipboard.writeText(command).then(() => {
            text.style.background = '#2d4a2d';
            showNote('Copied', '#999', 1200);
        }, () => {});
    });

    const events = ['editorState', 'start', 'pause', 'powerOff', 'powerOnPaused'];
    events.forEach(name => emu.on(name, refresh));

    return {
        element,
        setCommand(value) {
            command = value || null;
            element.style.display = command ? 'flex' : 'none';
            if (command) text.textContent = command;
            refresh();
        },
        dispose() {
            events.forEach(name => emu.removeListener(name, refresh));
            clearTimeout(noteTimer);
        },
    };
}

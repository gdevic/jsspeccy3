/*
 * runtime/script-api.js: the machine's power, the Spectrum's keyboard and
 * the tape recorder, worked from a page's script (emu.machine, emu.keyboard
 * and emu.tape, see the README), so that what a user does with them can be
 * done, and waited for, from code: to drive tests, or a demo.
 */
import { speccyKeyByName, speccyKeysForChar, KEY_HOLD_MS, KEY_GAP_MS } from './keyboard.js';
import { typeBasic } from './type-basic.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// How often, and by default for how long, tape.until looks at the recorder.
const UNTIL_POLL_MS = 20;
const UNTIL_TIMEOUT_MS = 10000;

/* The machine's power and pause: off, as the page starts it and as a
 * session saved switched off restores it; running; or paused. */
export function createMachineApi(emu) {
    const state = () => (emu.isInitiallyPaused ? 'off' : (emu.isRunning ? 'running' : 'paused'));
    return {
        state,
        // Switches the machine on and runs it, as the play button over the screen does.
        powerOn() {
            if (state() === 'off') emu.start();
            return state();
        },
        powerOff() {
            if (state() !== 'off') emu.powerOff();
            return state();
        },
        pause() {
            if (state() === 'running') emu.pause();
            return state();
        },
        resume() {
            if (state() === 'off') throw new Error('The machine is switched off: powerOn() starts it');
            emu.start();
            return state();
        },
    };
}

/* The keyboard: keys are named as speccyKeyByName takes them ('A', '1',
 * 'ENTER', 'SPACE', 'CAPS_SHIFT', 'SYMBOL_SHIFT'), one or an array of them
 * held together. */
export function createKeyboardApi(emu) {
    const keysNamed = (names) => (Array.isArray(names) ? names : [names]).map((name) => {
        const key = speccyKeyByName(name);
        if (!key) throw new Error(`No Spectrum key is called ${JSON.stringify(name)}`);
        return key;
    });
    const down = (keys) => keys.forEach(key => emu.keyDown(key.row, key.mask));
    const up = (keys) => keys.slice().reverse().forEach(key => emu.keyUp(key.row, key.mask));
    const tap = async (keys, opts) => {
        down(keys);
        await sleep(opts.holdMs ?? KEY_HOLD_MS);
        up(keys);
        await sleep(opts.gapMs ?? KEY_GAP_MS);
    };
    return {
        keyDown(names) { down(keysNamed(names)); },
        keyUp(names) { up(keysNamed(names)); },
        // Holds the keys down together, then lets them go.
        press(names, opts) { return tap(keysNamed(names), opts || {}); },
        /* Types `text` a character at a time, as speccyKeysForChar types
         * each; the whole of it is checked before the first key goes down. */
        async type(text, opts) {
            // a line ending, CR LF as on Windows included, is one Enter
            const chords = Array.from(String(text).replace(/\r\n?/g, '\n'), (ch) => {
                const keys = speccyKeysForChar(ch);
                if (!keys) throw new Error(`No Spectrum key types ${JSON.stringify(ch)}`);
                return keys;
            });
            for (const keys of chords) await tap(keys, opts || {});
        },
        /* Types BASIC as someone at the keyboard would, keywords and all,
         * into whichever editor waits for it (see runtime/type-basic.js). */
        typeBasic(text, opts) { return typeBasic(emu, text, opts || {}); },
        // The ROM's line editor waiting for a key, {kind, cursor, command, input}, or null.
        editor() { return emu.editorState ? { ...emu.editorState } : null; },
        releaseAll() {
            for (let row = 0; row < 8; row++) emu.keyUp(row, 0x1f);
        },
    };
}

/* The tape recorder and the cassette box. `deck` is the recorder's UI
 * (runtime/tape-deck-ui.js), or null where the page doesn't offer it. What
 * changes the recorder resolves once the worker has done it, so status()
 * and parts() then tell how things are. */
export function createTapeApi(emu, deck) {
    const needDeck = () => {
        if (!deck) throw new Error('This page has no tape recorder');
        return deck;
    };
    const settled = () => emu.barrier();
    const status = () => {
        const s = emu.deckStatus || {};
        return {
            connected: !!emu.tapeDeckConnected,
            kind: emu.tapeKind || null,
            cassette: deck ? deck.cassetteInRecorder() : null,
            mode: (emu.tapeDeckConnected && s.mode) || 'stop',
            auto: !!s.auto,
            saving: !!s.saving,
            loading: !!s.loading,
            positionMs: emu.tapePositionMs || 0,
            lengthMs: emu.tapeLengthMs || 0,
            blankFromMs: emu.tapeBlankFromMs || 0,
            writeProtect: !!emu.tapeWriteProtect,
            instantLoading: !!emu.tapeTrapsEnabled,
        };
    };
    /* Resolves with the status once `condition(status)` holds, or fails
     * after `timeoutMs`, 10 seconds unless given. */
    const until = async (condition, timeoutMs) => {
        const deadline = performance.now() + (timeoutMs ?? UNTIL_TIMEOUT_MS);
        for (;;) {
            const s = status();
            if (condition(s)) return s;
            if (performance.now() > deadline) throw new Error('The tape recorder did not get there in time');
            await sleep(UNTIL_POLL_MS);
        }
    };
    return {
        status,
        /* The parts on the tape, as the recorder's panel lists them. A
         * pre-recorded tape's parts are named as the panel names them, and
         * have no type, length or load command. */
        parts() {
            const game = emu.tapeKind === 'game';
            return (emu.tapeSegments || []).map(({ startMs, endMs, durationMs, name, label, typeName, length, loadCommand, damaged, sound }) => (game
                ? { startMs, endMs: startMs + durationMs, durationMs, name: name || (label || '').split('  @')[0], typeName: null, length: null, loadCommand: null, damaged: false, sound: false }
                : { startMs, endMs, durationMs, name, typeName, length, loadCommand, damaged: !!damaged, sound: !!sound }
            ));
        },
        async connect() { await needDeck().setConnected(true); await settled(); },
        async disconnect() { await needDeck().setConnected(false); await settled(); },
        async newCassette(label) { const id = await needDeck().newCassette(label); await settled(); return id; },
        // `data` is a .tap or .tzx file's bytes, `fileName` its name, for the label.
        async importCassette(data, fileName) { const id = await needDeck().importCassette(data, fileName); await settled(); return id; },
        async insert(id) { await needDeck().insertFromBox(id); await settled(); },
        cassettes() { return needDeck().cassettes(); },
        /* Presses one of the recorder's keys: 'play', 'record', 'rewind',
         * 'ffwd', 'stop' or 'eject'. */
        async press(key) {
            needDeck();
            if (key === 'eject') {
                needDeck().eject();
            } else if (['play', 'record', 'rewind', 'ffwd', 'stop'].includes(key)) {
                emu.deckKey(key);
            } else {
                throw new Error(`The tape recorder has no ${JSON.stringify(key)} key`);
            }
            await settled();
        },
        /* Winds the tape to `positionMs`, as picking a part in the panel
         * does, or at once with opts.quiet. Resolves once the tape is there,
         * or fails after opts.timeoutMs as until does. */
        async windTo(positionMs, opts) {
            needDeck();
            opts = opts || {};
            emu.windTape(positionMs, !!opts.quiet);
            await settled();
            await until(s => s.mode === 'stop', opts.timeoutMs);
        },
        /* Takes back the last recording that recorded over something, once
         * the Record a SAVE pressed has come up again, as the UI offers it;
         * fails, as until does, if it hasn't by opts.timeoutMs. */
        async undo(opts) {
            needDeck();
            await until(s => !((s.mode === 'record') && s.auto), (opts || {}).timeoutMs);
            emu.undoCassetteRecording();
            await settled();
        },
        async setWriteProtect(value) { await needDeck().setWriteProtect(value); await settled(); },
        // the page's choice for now, which the visitor's own setting doesn't take on
        async setInstantLoading(value) { needDeck(); emu.setTapeTraps(!!value, true); await settled(); },
        // The cassette in the recorder as a TZX file, recordings so far included; null if none is in.
        data() { return needDeck().currentData(); },
        until,
    };
}

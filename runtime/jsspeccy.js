import EventEmitter from 'events';
import fileDialog from 'file-dialog';
import JSZip from 'jszip';

import { DisplayHandler } from './render.js';
import { UIController } from './ui.js';
import { parseSNAFile, parseZ80File, parseSZXFile } from './snapshot.js';
import { TAPFile, TZXFile } from './tape.js';
import { StandardKeyboardHandler, RecreatedZXSpectrumHandler } from './keyboard.js';
import { JoystickHandler } from './joystick.js';
import { AudioHandler } from './audio.js';
import { openPokesDialog } from './pokes.js';
import { openPlayZXDialog } from './playzx.js';
import { openDialog, h, button } from './dialog.js';
import { isPlayZXAvailable } from './playzx-session.js';
import { validateMDRFile } from './mdr.js';
import { createMicrodriveDock } from './microdrive-ui.js';
import { createPrinter } from './printer-ui.js';
import { createTapeDeck } from './tape-deck-ui.js';
import { createMachineApi, createKeyboardApi, createTapeApi } from './script-api.js';
import { isSessionFile, buildSessionFile, readSessionFile, confirmRestore, chooseSaveTarget, writeSaveTarget } from './session.js';

import sessionSaveIcon from './icons/session-save.svg';
import sessionRestoreIcon from './icons/session-restore.svg';
import resetIcon from './icons/reset.svg';
import playIcon from './icons/play.svg';
import pauseIcon from './icons/pause.svg';
import fullscreenIcon from './icons/fullscreen.svg';
import exitFullscreenIcon from './icons/exitfullscreen.svg';
import tapePlayIcon from './icons/tape_play.svg';
import tapePauseIcon from './icons/tape_pause.svg';
import ejectIcon from './icons/eject.svg';
import tapeRecorderIcon from './icons/tape-recorder.svg';
import keyboardIcon from './icons/keyboard.svg';
import microdriveIcon from './icons/microdrive.svg';
import printerIcon from './icons/printer.svg';

import { createKeyboardOverlay } from './keyboard-overlay.js';

const scriptUrl = document.currentScript.src;

// How far behind time the frame loop catches up (see advanceFrameTime).
const MAX_FRAME_LAG_MS = 100;

// How long exit() waits for the worker to send back what it holds.
const EXIT_FLUSH_TIMEOUT_MS = 2000;

// How long a display change asked for through the API takes to arrive at most.
const API_DISPLAY_MS = 1000;

// The file name at the end of a path.
const baseName = (path) => String(path).split('/').pop();

// A URL without its query string or fragment, which don't name the file.
const urlPath = (url) => String(url).split(/[?#]/)[0];

// The file name at the end of a URL, decoded.
const urlFileName = (url) => {
    const name = baseName(urlPath(url));
    try {
        return decodeURIComponent(name);
    } catch (e) {
        return name;
    }
};

// A file's bytes fetched from `url`; an error page from the server is not taken for the file.
const fetchBytes = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw 'Could not load ' + urlFileName(url) + ': the server answered ' + response.status + ' ' + response.statusText;
    return response.arrayBuffer();
};

// Calls each of `handlers`; one that throws doesn't keep the rest from being called.
const callEach = (handlers) => {
    for (const handler of handlers) {
        try {
            handler();
        } catch (err) {
            console.error(err);
        }
    }
};

// A copy of a file's bytes as an ArrayBuffer of its own.
const copyBytes = (data) => (data instanceof ArrayBuffer) ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

class Emulator extends EventEmitter {
    constructor(canvas, opts) {
        super();
        this.canvas = canvas;
        this.worker = new Worker(new URL('jsspeccy-worker.js', scriptUrl));
        this.keyboardEnabled = ('keyboardEnabled' in opts) ? opts.keyboardEnabled : true;
        if (this.keyboardEnabled) {
            this.keyboardHandler = (opts.keyboardMap == 'recreated')
                ? new RecreatedZXSpectrumHandler(this.worker, opts.keyboardEventRoot || document)
                : new StandardKeyboardHandler(this.worker, opts.keyboardEventRoot || document);
            // every key let go at once (pause, focus leaving), which the on-screen keyboard's latches follow
            this.keyboardHandler.onReleaseAll = () => this.emit('keysReleased');
        }
        this.joystickEnabled = ('joystickEnabled' in opts) ? opts.joystickEnabled : true;
        this.joystickType = opts.joystickType || 'kempston';
        this.joystickDevice = opts.joystickDevice || null;
        if (this.joystickEnabled) {
            this.joystickHandler = new JoystickHandler(this.worker, this.joystickType, this.joystickDevice);
        }
        this.displayHandler = new DisplayHandler(this.canvas);
        this.audioHandler = new AudioHandler();
        this.isRunning = false;
        this.animationFrameRequested = false;  // see requestAnimationFrame
        this.isReady = false;
        this.isInitiallyPaused = (!opts.autoStart);
        this.autoLoadTapes = ('autoLoadTapes' in opts) ? opts.autoLoadTapes : true;
        this.tapeAutoLoadMode = opts.tapeAutoLoadMode || 'default';  // or usr0
        this.tapeIsPlaying = false;
        this.tapeTrapsEnabled = ('tapeTrapsEnabled' in opts) ? opts.tapeTrapsEnabled : true;
        this.tapeSegments = []; // segments of the loaded tape (cassette counter)
        this.tapeTotalMs = 0;
        this.tapeTotalBytes = 0;
        this.tapePositionMs = 0;
        this.tapeBlockIndex = 0; // block the tape is parked on: what the next load reads
        this.tapeNextBlockMs = null;  // where on the timeline that block starts, where the tape can say
        this.tapeFile = null;    // {name, data} of the loaded tape, for saving a session
        /* The tape recorder (see runtime/tape-deck-ui.js). While it is
         * connected, the tape slot is the recorder: tapeKind says what is in
         * it, 'game' (an opened tape) or 'cassette' (one SAVE records onto),
         * or null. deckStatus is the recorder's last report: its keys, the
         * tape's position and speed (deckStatusTime is when it came). */
        this.tapeDeckConnected = false;
        this.tapeKind = null;
        this.tapeLengthMs = 0;
        this.tapeBlankFromMs = 0;
        this.tapeWriteProtect = false;
        this.deckStatus = null;
        this.deckStatusTime = 0;
        /* Tapes and cassettes sent to the worker whose fileOpened hasn't come
         * back yet (by file-open id), and the latest of them; and what the
         * files given in opts.openUrl are opened by (a promise), if any. */
        this.tapeOpenIDs = new Set();
        this.lastTapeOpenID = null;
        this.startupOpened = Promise.resolve();
        this.rom48Variant = 'standard';  // which 48K ROM is in page 10: 'standard' or 'gw03'
        this.romFont = null;  // the 48K ROM's character set, codes 32 to 127 (see char-picker.js)
        this.nextSnapshotID = 0;
        this.snapshotResolutions = {};

        this.msPerFrame = 20;

        this.isExecutingFrame = false;
        this.nextFrameTime = null;
        this.machineType = null;

        this.nextFileOpenID = 0;
        this.fileOpenPromiseResolutions = {};

        /* Pokes (cheats) support: name of the most recently loaded game (used
         * to look up its pokes), and the currently applied trainers, keyed by
         * trainer id -> {pokes, originals, locations} so they can be undone. */
        this.loadedGameName = null;
        this.activePokes = new Map();
        this.nextPokesID = 0;
        this.pokesPromiseResolutions = {};

        /* Interface 1 / Microdrive support. interface1Enabled mirrors whether
         * the shadow ROM is plugged in (independent of what's inserted -
         * disconnecting never ejects a cartridge). microdriveMotors is a
         * bitmask (bit N = drive N's LED); microdriveHeads is a head-position
         * byte offset per drive, for the tape-loop animation. microdriveTokens
         * tracks which cartridge (an opaque id from whatever's storing them)
         * is in each of the 8 drives, so a 'microdriveData' flush can be
         * matched back to the right one. */
        this.interface1Enabled = false;
        this.microdriveMotors = 0;
        this.microdriveHeads = [0, 0, 0, 0, 0, 0, 0, 0];
        this.microdriveTokens = [null, null, null, null, null, null, null, null];
        this.microdriveInsertSeq = 0;

        /* ZX Printer support. printerPaper is the paper left on the roll, in
         * pixel rows, as last reported by the worker; printerMotor is whether
         * the printer's motor is running. */
        this.printerEnabled = false;
        this.printerPaper = 0;
        this.printerMotor = false;

        this.onReadyHandlers = [];
        this.onStartedHandlers = [];
        this.isStarted = false;
        /* Resolves once the worker has the core and the ROMs and the machine is
         * set up; files opened before then wait for it, rather than be wiped by
         * that set-up or reach a worker with no core. */
        this.coreReady = new Promise(resolve => { this.resolveCoreReady = resolve; });

        this.worker.onmessage = (e) => {
            switch(e.data.message) {
                case 'ready':
                    this.loadRoms().then(() => {
                        this.isReady = true;
                        // a machine chosen while the core was loading is kept
                        this.setMachine(this.machineType || opts.machine || 48);
                        this.setTapeTraps(this.tapeTrapsEnabled);
                        this.resolveCoreReady();

                        const opened = opts.openUrl ? this.openUrlList(opts.openUrl).catch(err => { alert(err); }) : Promise.resolve();
                        this.startupOpened = opened.then(() => {
                            if (opts.autoStart) this.start();
                        });
                        // after startupOpened is set, which the recorder and the Microdrives wait for
                        callEach(this.onReadyHandlers);
                        this.startupOpened.then(() => {
                            this.isStarted = true;
                            callEach(this.onStartedHandlers);
                        });
                    }).catch(err => { alert(err); });
                    break;
                case 'coreFailed':
                    alert('The emulator could not load its core: ' + e.data.error);
                    break;
                case 'frameCompleted':
                    // benchmarkRunCount++;
                    if ('audioBufferLeft' in e.data) {
                        this.audioHandler.frameCompleted(e.data.audioBufferLeft, e.data.audioBufferRight);
                    }

                    this.displayHandler.frameCompleted(e.data.frameBuffer);
                    if (this.isRunning) {
                        const time = performance.now();
                        if (time > this.nextFrameTime) {
                            // behind time: run the next frame straight away, to catch up
                            this.runFrame();
                            this.advanceFrameTime(time);
                        } else {
                            this.isExecutingFrame = false;
                        }
                    } else {
                        this.isExecutingFrame = false;
                    }
                    break;
                case 'frameFailed':
                    // The machine stops where it failed; starting it again retries the frame.
                    if ('audioBufferLeft' in e.data) {
                        this.audioHandler.frameFailed(e.data.audioBufferLeft, e.data.audioBufferRight);
                    }
                    this.displayHandler.frameFailed(e.data.frameBuffer);
                    this.isExecutingFrame = false;
                    this.pause();
                    alert('The emulator stopped because of an error: ' + e.data.error);
                    break;
                case 'fileOpened':
                    if (this.tapeOpenIDs.delete(e.data.id) && !e.data.error) {
                        // what the tape slot holds now, ahead of the tapeInfo that follows
                        this.tapeKind = (e.data.mediaType == 'cassette') ? 'cassette' : 'game';
                    }
                    if (e.data.error) {
                        this.settleFileOpen(e.data.id, { mediaType: e.data.mediaType, error: e.data.error });
                        break;
                    }
                    if (e.data.mediaType == 'tape' && this.autoLoadTapes && !e.data.quiet) {
                        this.bootTapeLoader();
                        if (!this.tapeTrapsEnabled) {
                            this.playTape();
                        }
                    }
                    // A cassette takes the place of an opened tape, unless another was opened since.
                    if ((e.data.mediaType == 'cassette') && (e.data.id === this.lastTapeOpenID)) this.tapeFile = null;
                    this.settleFileOpen(e.data.id, {
                        mediaType: e.data.mediaType,
                    });
                    if (e.data.mediaType == 'tape') {
                        this.emit('openedTapeFile');
                    }
                    break;
                case 'screenRendered':
                    this.displayHandler.frameCompleted(e.data.frameBuffer);
                    this.displayHandler.show();
                    if (this.screenRenderedResolution) this.screenRenderedResolution();
                    this.screenRenderedResolution = null;
                    break;
                case 'snapshot':
                case 'barrier':
                    this.snapshotResolutions[e.data.id](e.data.snapshot);
                    delete this.snapshotResolutions[e.data.id];
                    break;
                case 'pokesApplied':
                    this.pokesPromiseResolutions[e.data.id]({ originals: e.data.originals, locations: e.data.locations });
                    delete this.pokesPromiseResolutions[e.data.id];
                    break;
                case 'playingTape':
                    this.tapeIsPlaying = true;
                    this.emit('playingTape');
                    break;
                case 'stoppedTape':
                    this.tapeIsPlaying = false;
                    this.emit('stoppedTape');
                    break;
                case 'tapeInfo':
                    this.tapeSegments = e.data.segments || [];
                    this.tapeTotalMs = e.data.totalMs || 0;
                    this.tapeTotalBytes = e.data.totalBytes || 0;
                    this.tapePositionMs = e.data.positionMs || 0;
                    this.tapeBlockIndex = e.data.blockIndex || 0;
                    this.tapeNextBlockMs = e.data.nextBlockMs ?? null;
                    this.tapeKind = e.data.kind || null;
                    this.tapeLengthMs = e.data.lengthMs || 0;
                    this.tapeBlankFromMs = e.data.blankFromMs || 0;
                    this.tapeWriteProtect = !!e.data.writeProtect;
                    this.emit('tapeInfo');
                    break;
                case 'tapePosition':
                    this.tapePositionMs = e.data.positionMs || 0;
                    this.tapeBlockIndex = e.data.blockIndex || 0;
                    this.tapeNextBlockMs = e.data.nextBlockMs ?? null;
                    this.emit('tapePosition');
                    break;
                case 'tapeSeeked':
                    if (e.data.quiet) {
                        // restoring a session: the tape just moves
                    } else if (e.data.kind == 'cassette') {
                        // a cassette is loaded from by the user's own LOAD: booting the
                        // tape loader would replace the program they are working on
                    } else if (!this.tapeTrapsEnabled) {
                        this.playTape();
                    } else if (!e.data.loadInFlight && this.autoLoadTapes) {
                        this.bootTapeLoader();
                    }
                    this.emit('tapeSeeked');
                    break;
                case 'tapeEjected':
                    this.tapeFile = null;
                    this.tapeSegments = [];
                    this.tapeTotalMs = 0;
                    this.tapeTotalBytes = 0;
                    this.tapePositionMs = 0;
                    this.tapeBlockIndex = 0;
                    this.tapeNextBlockMs = null;
                    this.tapeIsPlaying = false;
                    this.tapeKind = null;
                    this.tapeLengthMs = 0;
                    this.tapeBlankFromMs = 0;
                    this.tapeWriteProtect = false;
                    this.emit('tapeEjected');
                    break;
                case 'tapeDeckStatus':
                    this.deckStatus = e.data;
                    this.deckStatusTime = performance.now();
                    this.tapePositionMs = e.data.positionMs || 0;
                    this.emit('tapeDeckStatus', e.data);
                    break;
                case 'cassetteData':
                    // A cassette's bytes after recording on it (a TZX file, as an
                    // ArrayBuffer), for whoever keeps cassettes to store against the token.
                    this.emit('cassetteData', e.data);
                    break;
                case 'cassetteEjected':
                    // A cassette left the recorder: e.data {token, positionMs, reason}.
                    this.emit('cassetteEjected', e.data);
                    break;
                case 'deckHint':
                    this.emit('deckHint', e.data);
                    break;
                case 'microdriveStatus':
                    this.microdriveMotors = e.data.motors;
                    this.microdriveHeads = e.data.heads;
                    this.emit('microdriveStatus');
                    break;
                case 'printerOutput':
                    // e.data.rows holds the pixel rows printed since the last
                    // message, 32 bytes each, oldest first.
                    this.printerPaper = e.data.paper;
                    this.printerMotor = e.data.motor;
                    this.emit('printerOutput', e.data.rows);
                    break;
                case 'microdriveData':
                    // A drive went idle (or hit the periodic force-flush) with
                    // unsaved changes; e.data.data is a full .mdr image
                    // (ArrayBuffer). Whoever's tracking cartridges listens for
                    // this to persist it against e.data.token; e.data.seq is
                    // the insert it came from (see insertMicrodrive).
                    this.emit('microdriveData', e.data.drive, e.data.token, e.data.data, e.data.seq);
                    break;
                default:
                    console.log('message received by host:', e.data);
            }
        }
        this.worker.postMessage({
            message: 'loadCore',
            baseUrl: scriptUrl,
        })
    }

    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.isInitiallyPaused = false;
            this.nextFrameTime = performance.now();
            if (this.keyboardEnabled) {
                this.keyboardHandler.start();
            }
            if (this.joystickEnabled) {
                this.joystickHandler.start();
            }
            this.audioHandler.start();
            this.focus();
            this.emit('start');
            this.requestAnimationFrame();
        }
    }

    /* Asks for the next animation frame, unless one is asked for already: a
     * pause and start within one frame leave the frame asked for before the
     * pause to carry on the loop, rather than starting a second loop. */
    requestAnimationFrame() {
        if (this.animationFrameRequested) return;
        this.animationFrameRequested = true;
        window.requestAnimationFrame((t) => {
            this.animationFrameRequested = false;
            this.runAnimationFrame(t);
        });
    }

    focus() {
        if (this.keyboardEnabled && this.keyboardHandler.rootElement.focus) {
            this.keyboardHandler.rootElement.focus();
        }
    }

    setKeyboardEventRoot(newRootElement) {
        if (this.keyboardEnabled) {
            this.keyboardHandler.setRootElement(newRootElement);
        }
    }

    setJoystickType(type) {
        this.joystickType = type;
        if (this.joystickEnabled) {
            this.joystickHandler.setType(type);
        }
        this.emit('setJoystickType', type);
    }

    setJoystickDevice(deviceSelector) {
        this.joystickDevice = deviceSelector || null;
        if (this.joystickEnabled) {
            this.joystickHandler.setDevice(this.joystickDevice);
        }
        this.emit('setJoystickDevice', this.joystickDevice);
    }

    getJoystickDevices() {
        return this.joystickEnabled ? this.joystickHandler.getDevices() : [];
    }

    pause() {
        if (this.isRunning) {
            this.isRunning = false;
            if (this.keyboardEnabled) {
                this.keyboardHandler.stop();
            }
            if (this.joystickEnabled) {
                this.joystickHandler.stop();
            }
            this.audioHandler.stop();
            this.emit('pause');
        }
    }

    async loadRom(url, page) {
        const data = new Uint8Array(await fetchBytes(new URL(url, scriptUrl)));
        if (page === 10) this.romFont = data.slice(0x3D00, 0x4000);
        this.worker.postMessage({
            message: 'loadMemory',
            data,
            page: page,
        });
    }

    async loadRoms() {
        await this.loadRom('roms/128-0.rom', 8);
        await this.loadRom('roms/128-1.rom', 9);
        await this.loadRom('roms/48.rom', 10);
        await this.loadRom('roms/pentagon-0.rom', 12);
        await this.loadRom('roms/trdos.rom', 13);
        await this.loadInterface1Rom();
    }

    /* The Interface 1 ROM is 8K, but every page in the core's memory is a
     * full 16K /ROMCS window, mirrored across both halves (as the real
     * hardware maps it) - so it's loaded as one 16K buffer with the same 8K
     * copied to both 0x0000 and 0x2000, rather than through loadRom(). */
    async loadInterface1Rom() {
        const rom = new Uint8Array(await fetchBytes(new URL('roms/if1-2.rom', scriptUrl)));
        const mirrored = new Uint8Array(0x4000);
        mirrored.set(rom, 0);
        mirrored.set(rom, 0x2000);
        this.worker.postMessage({
            message: 'loadMemory',
            data: mirrored,
            page: 14,
        });
    }


    runFrame() {
        this.isExecutingFrame = true;
        const frameBuffer = this.displayHandler.getNextFrameBuffer();

        if (this.audioHandler.isActive) {
            const [audioBufferLeft, audioBufferRight] = this.audioHandler.frameBuffers;

            this.worker.postMessage({
                message: 'runFrame',
                frameBuffer,
                audioBufferLeft,
                audioBufferRight,
            }, [frameBuffer, audioBufferLeft, audioBufferRight]);
        } else {
            this.worker.postMessage({
                message: 'runFrame',
                frameBuffer,
            }, [frameBuffer]);
        }
    }

    /* A frame is due every msPerFrame, however late the last one ran, so a
     * display refreshing slower than 50 Hz, or a slow round trip to the
     * worker, is made up by running frames back to back. Once more than
     * MAX_FRAME_LAG_MS behind (a stalled tab, or a machine too slow to keep
     * up) the lost time is let go. */
    advanceFrameTime(time) {
        this.nextFrameTime += this.msPerFrame;
        if ((time - this.nextFrameTime) > MAX_FRAME_LAG_MS) this.nextFrameTime = time;
    }

    runAnimationFrame(time) {
        if (this.displayHandler.readyToShow()) {
            this.displayHandler.show();
            // benchmarkRenderCount++;
        }
        if (this.isRunning) {
            // A machine started before the worker has its core and ROMs waits for them.
            if (time > this.nextFrameTime && !this.isExecutingFrame && this.isReady) {
                this.runFrame();
                this.advanceFrameTime(time);
            }
            this.requestAnimationFrame();
        }
    };

    setMachine(type) {
        if (type != 128 && type != 5) type = 48;
        // Before the core is in, the machine is set up with this once it is.
        if (this.isReady) {
            this.worker.postMessage({
                message: 'setMachineType',
                type,
            });
        }
        this.machineType = type;
        this.activePokes.clear();  // the new machine starts with its memory cleared
        this.emit('setMachine', type);
    }

    reset() {
        this.worker.postMessage({message: 'reset'});
        this.activePokes.clear();  // the ROM clears memory on reset
    }

    /* Puts the standard ('standard') or the alternate ('gw03') ROM in as the
     * 48K ROM; the machine keeps running whatever is in memory. */
    async setRom48Variant(variant) {
        this.rom48Variant = (variant === 'gw03') ? 'gw03' : 'standard';
        await this.loadRom(this.rom48Variant === 'gw03' ? 'roms/gw03.rom' : 'roms/48.rom', 10);
    }

    /* The machine as it stands between two frames: a snapshot in the
     * structure the snapshot parsers produce, with the extras a saved
     * session keeps (see takeSnapshot in the worker). */
    getSnapshot() {
        const id = this.nextSnapshotID++;
        this.worker.postMessage({ message: 'getSnapshot', id });
        return new Promise((resolve) => {
            this.snapshotResolutions[id] = resolve;
        });
    }

    /* Switches the machine off: it stops, and shows the switched-off
     * screen until it is started again. */
    powerOff() {
        this.pause();
        this.isInitiallyPaused = true;
        this.emit('powerOff');
    }

    /* Switches the machine on without starting it: it stays paused, showing
     * its screen (see showScreen). */
    powerOnPaused() {
        this.isInitiallyPaused = false;
        this.emit('powerOnPaused');
    }

    /* Draws the machine's screen from its memory without running it, for a
     * paused machine that has just been given a new state. */
    showScreen() {
        const frameBuffer = this.displayHandler.getNextFrameBuffer();
        this.worker.postMessage({ message: 'renderScreen', frameBuffer }, [frameBuffer]);
        return new Promise((resolve) => {
            this.screenRenderedResolution = resolve;
        });
    }

    /* Resolves once every message the worker sent before this call has
     * been handled here. */
    barrier() {
        const id = this.nextSnapshotID++;
        this.worker.postMessage({ message: 'barrier', id });
        return new Promise((resolve) => {
            this.snapshotResolutions[id] = resolve;
        });
    }

    loadSnapshot(snapshot) {
        if (!this.isReady) return this.coreReady.then(() => this.loadSnapshot(snapshot));
        // A snapshot taken inside the Interface 1's ROM needs it connected to carry on.
        if (snapshot.interface1Paged && !this.interface1Enabled) this.setInterface1(true);
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'loadSnapshot',
            id: fileID,
            snapshot,
        })
        // The machine changes only if the worker takes the snapshot.
        return new Promise((resolve) => {
            this.fileOpenPromiseResolutions[fileID] = (result) => {
                if (!result.error) {
                    this.machineType = snapshot.model;
                    this.activePokes.clear();  // memory holds the snapshot's now
                    this.emit('setMachine', snapshot.model);
                }
                resolve(result);
            };
        });
    }

    // A file-open id for a tape or cassette, noted until its fileOpened comes back.
    nextTapeOpenID() {
        const fileID = this.nextFileOpenID++;
        this.tapeOpenIDs.add(fileID);
        this.lastTapeOpenID = fileID;
        return fileID;
    }
    // Whether a tape or cassette is on its way into the tape slot.
    get tapeOpening() {
        return this.tapeOpenIDs.size > 0;
    }

    /* Inserts a tape. opts.name is its file name, kept with a copy of the
     * bytes for saving a session (a tape opened without a name isn't
     * saved); opts.quiet (restoring a session) inserts it without
     * auto-loading it. */
    openTAPFile(data, opts) {
        return this.openTapeFile('openTAPFile', data, opts);
    }

    openTZXFile(data, opts) {
        return this.openTapeFile('openTZXFile', data, opts);
    }

    /* The tape becomes emu.tapeFile only once the worker has taken it: one it
     * turns away leaves the tape that was in the slot where it was. */
    openTapeFile(message, data, opts) {
        opts = opts || {};
        const tapeFile = opts.name ? { name: opts.name, data: copyBytes(data) } : null;
        const fileID = this.nextTapeOpenID();
        this.worker.postMessage({
            message,
            id: fileID,
            data,
            quiet: !!opts.quiet,
        })
        return new Promise((resolve) => {
            this.fileOpenPromiseResolutions[fileID] = (result) => {
                if (!result.error) this.tapeFile = tapeFile;
                resolve(result);
            };
        });
    }

    /* How to open a file, going by its name; `displayName` is the name to
     * show and keep for it, the last part of `filename` if not given. */
    getFileOpener(filename, displayName) {
        const cleanName = filename.toLowerCase();
        const name = displayName || baseName(filename);
        if (cleanName.endsWith('.z80')) {
            return async arrayBuffer => {
                const z80file = parseZ80File(arrayBuffer);
                return this.loadSnapshot(z80file);
            };
        } else if (cleanName.endsWith('.szx')) {
            return async arrayBuffer => {
                const szxfile = parseSZXFile(arrayBuffer);
                return this.loadSnapshot(szxfile);
            };
        } else if (cleanName.endsWith('.sna')) {
            return async arrayBuffer => {
                const snafile = parseSNAFile(arrayBuffer);
                return this.loadSnapshot(snafile);
            };
        } else if (cleanName.endsWith('.tap')) {
            return async arrayBuffer => {
                if (!TAPFile.isValid(arrayBuffer)) throw 'Invalid TAP file';
                return this.openTAPFile(arrayBuffer, { name });
            };
        } else if (cleanName.endsWith('.tzx')) {
            return async arrayBuffer => {
                if (!TZXFile.isValid(arrayBuffer)) throw 'Invalid TZX file';
                return this.openTZXFile(arrayBuffer, { name });
            };
        } else if (cleanName.endsWith('.mdr')) {
            return async arrayBuffer => {
                if (!validateMDRFile(arrayBuffer)) throw 'Invalid Microdrive cartridge (.mdr) file';
                if (this.listenerCount('microdriveImageOpened') > 0) {
                    // Something's tracking cartridges (the cartridge box UI) -
                    // hand it off rather than guessing where it should go.
                    this.emit('microdriveImageOpened', { name: filename, data: arrayBuffer });
                } else {
                    // No UI listening: just connect and insert it into drive 1.
                    this.setInterface1(true);
                    this.insertMicrodrive(0, arrayBuffer, null);
                }
                return { mediaType: 'microdrive' };
            };
        } else if (cleanName.endsWith('.zip')) {
            return async arrayBuffer => {
                const zip = await JSZip.loadAsync(arrayBuffer);
                // A saved session is restored as a whole by whoever handles
                // sessions, not opened as a game.
                if (await isSessionFile(zip)) {
                    if (this.listenerCount('sessionFileOpened') === 0) {
                        throw name + ' is a saved session, which can only be restored where the emulator has its toolbar.';
                    }
                    this.emit('sessionFileOpened', { name, zip });
                    return { mediaType: 'session' };
                }
                const openers = [];
                zip.forEach((path, file) => {
                    if (path.startsWith('__MACOSX/')) return;
                    const opener = this.getFileOpener(path);
                    if (opener) {
                        const boundOpener = async () => {
                            const buf = await file.async('arraybuffer');
                            return opener(buf);
                        };
                        openers.push(boundOpener);
                    }
                });
                if (openers.length == 1) {
                    return openers[0]();
                } else if (openers.length == 0) {
                    throw 'No loadable files found inside ZIP file: ' + filename;
                } else {
                    // TODO: prompt to choose a file
                    throw 'Multiple loadable files found inside ZIP file: ' + filename;
                }
            }
        }
    }

    /* Remember which game is loaded (for the Pokes dialog); a new game
     * invalidates any pokes applied to the previous one. */
    setLoadedGame(name) {
        this.loadedGameName = name || null;
        this.activePokes.clear();
        this.emit('setLoadedGame', this.loadedGameName);
    }

    /* Apply an array of {bank, address, value} pokes in the worker, or of
     * {location, value} to put bytes back; resolves with {originals,
     * locations}: the overwritten byte values and where in memory each was
     * (for undo). */
    applyPokes(pokes) {
        const id = this.nextPokesID++;
        this.worker.postMessage({
            message: 'applyPokes',
            id,
            pokes,
        });
        return new Promise((resolve) => {
            this.pokesPromiseResolutions[id] = resolve;
        });
    }

    /* Answers the file open `id`, once. Its answer holds on to what was
     * opened (a whole snapshot or tape), so it is let go of with it. */
    settleFileOpen(id, result) {
        const resolve = this.fileOpenPromiseResolutions[id];
        delete this.fileOpenPromiseResolutions[id];
        if (resolve) resolve(result);
    }

    async openFile(file) {
        const opener = this.getFileOpener(file.name);
        if (opener) {
            const buf = await file.arrayBuffer();
            await this.coreReady;
            return opener(buf).then((res) => {
                if (res && res.error) throw res.error;
                // A microdrive cartridge tracks its own label, not the
                // loaded-game name (it's not "the game", and inserting one
                // shouldn't invalidate pokes applied to what's running).
                if (res.mediaType !== 'microdrive' && res.mediaType !== 'session') this.setLoadedGame(file.name);
                return res;
            }).catch(err => {alert(err);});
        } else {
            throw 'Unrecognised file type: ' + file.name;
        }
    }

    async openUrl(url, opts) {
        opts = opts || {};
        const name = urlFileName(url);
        const opener = this.getFileOpener(urlPath(url), name);
        if (opener) {
            const buf = await fetchBytes(url);
            // a load whose caller has given up by the time the file arrives is dropped
            if (opts.stillWanted && !opts.stillWanted()) return null;
            await this.coreReady;
            return opener(buf).then((res) => {
                if (res && res.error) throw res.error;
                // Internal loads (e.g. tape-loader snapshots) must not
                // masquerade as the loaded game.
                if (opts.trackName !== false && res.mediaType !== 'microdrive' && res.mediaType !== 'session') {
                    this.setLoadedGame(name);
                }
                return res;
            });
        } else {
            throw 'Unrecognised file type: ' + name;
        }
    }
    async openUrlList(urls) {
        if (typeof(urls) === 'string') {
            return await this.openUrl(urls);
        } else {
            for (const url of urls) {
                await this.openUrl(url);
            }
        }
    }

    setAutoLoadTapes(val) {
        this.autoLoadTapes = val;
        this.emit('setAutoLoadTapes', val);
    }
    // `byScript` marks the page's own choice, which the visitor's settings don't keep.
    setTapeTraps(val, byScript) {
        this.tapeTrapsEnabled = val;
        this.worker.postMessage({
            message: 'setTapeTraps',
            value: val,
        })
        this.emit('setTapeTraps', val, !!byScript);
    }

    playTape() {
        this.worker.postMessage({
            message: 'playTape',
        });
    }
    stopTape() {
        this.worker.postMessage({
            message: 'stopTape',
        });
    }
    /* Boot the ROM tape loader for the current machine: a snapshot parked at a
     * LOAD "" prompt, which is how a tape starts loading without the user typing
     * it. Does nothing for a machine with no loader snapshot. */
    bootTapeLoader() {
        const TAPE_LOADERS_BY_MACHINE = {
            '48': {'default': 'tapeloaders/tape_48.szx', 'usr0': 'tapeloaders/tape_48.szx'},
            '128': {'default': 'tapeloaders/tape_128.szx', 'usr0': 'tapeloaders/tape_128_usr0.szx'},
            '5': {'default': 'tapeloaders/tape_pentagon.szx', 'usr0': 'tapeloaders/tape_pentagon_usr0.szx'},
        };
        const loaders = TAPE_LOADERS_BY_MACHINE[this.machineType];
        if (!loaders) return;
        return this.openUrl(new URL(loaders[this.tapeAutoLoadMode], scriptUrl), {trackName: false});
    }
    /* `quiet` (restoring a session) moves the tape without starting a load.
     * `positionMs`, a part's start, picks which time round a block the tape
     * plays more than once is sought; otherwise it is the first. */
    seekTape(blockIndex, quiet, positionMs) {
        this.worker.postMessage({
            message: 'seekTape',
            index: blockIndex,
            quiet: !!quiet,
            positionMs,
        });
    }
    /* `reason` is passed back with a cassette that leaves the recorder:
     * 'eject' unless given, or 'parked' when the recorder is switched off. */
    ejectTape(reason) {
        this.worker.postMessage({
            message: 'ejectTape',
            reason: reason || 'eject',
        });
        this.tapeKind = null;  // as it will be, ahead of the tapeEjected that follows
    }

    /* Connects or disconnects the tape recorder. While it is connected,
     * SAVE records onto a cassette in it. */
    setTapeDeck(connected) {
        this.tapeDeckConnected = connected;
        this.worker.postMessage({ message: 'setTapeDeck', connected });
        this.emit('setTapeDeck', connected);
    }
    /* Puts a cassette (a TZX file, as runtime/cassette.js writes it) into the
     * tape recorder, in place of whatever tape is in. opts.token is the
     * caller's id for it, handed back with its bytes after recording, and
     * opts.seq a number telling this insert from any other of the same
     * cassette; opts.positionMs is where the tape was left. Resolves like
     * openTAPFile. */
    insertCassette(data, opts) {
        opts = opts || {};
        const bytes = (data instanceof ArrayBuffer) ? new Uint8Array(data) : data;
        const buf = bytes.slice(0).buffer;
        const fileID = this.nextTapeOpenID();
        this.worker.postMessage({
            message: 'insertCassette',
            id: fileID,
            data: buf,
            token: opts.token ?? null,
            seq: opts.seq ?? null,
            positionMs: opts.positionMs || 0,
            writeProtect: !!opts.writeProtect,
        }, [buf]);
        return new Promise((resolve) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }
    /* Presses one of the recorder's keys: 'play', 'record', 'rewind', 'ffwd'
     * or 'stop'. */
    deckKey(key) {
        this.worker.postMessage({ message: 'deckKey', key });
    }
    /* Winds the tape to `positionMs`, visibly unless `quiet`. */
    windTape(positionMs, quiet) {
        this.worker.postMessage({ message: 'windTape', positionMs, quiet: !!quiet });
    }
    setCassetteWriteProtect(value) {
        this.worker.postMessage({ message: 'setCassetteWriteProtect', value: !!value });
    }
    // Takes back the last recording that erased something, restoring what it erased.
    undoCassetteRecording() {
        this.worker.postMessage({ message: 'undoCassetteRecording' });
    }
    /* Has the worker post the cassette's bytes back if it has been recorded
     * on since they were last posted; a barrier() after it waits for them. */
    flushCassette() {
        this.worker.postMessage({ message: 'flushCassette' });
    }
    keyDown(row, mask) {
        this.worker.postMessage({ message: 'keyDown', row, mask });
    }
    keyUp(row, mask) {
        this.worker.postMessage({ message: 'keyUp', row, mask });
    }

    /* Plugs in (or unplugs) the Interface 1. This is purely the "is it
     * connected" switch - it never ejects a cartridge, so reconnecting finds
     * every drive exactly as it was left. */
    setInterface1(enabled) {
        this.interface1Enabled = enabled;
        this.worker.postMessage({ message: 'setInterface1', enabled });
        if (!enabled) {
            this.microdriveMotors = 0;
            this.emit('microdriveStatus');
        }
        this.emit('setInterface1', enabled);
    }
    /* Inserts a cartridge (a full .mdr image, as an ArrayBuffer) into drive
     * 0-7. `token` is an opaque id the caller can use to recognise this
     * cartridge again in a later 'microdriveData' event (e.g. a storage
     * record id) - pass null if that doesn't matter. Whatever was already in
     * the drive is flushed (if it had unsaved changes) before being replaced.
     * Returns this insert's number, which its 'microdriveData' events carry,
     * so they are told apart from those of an earlier insert even of the
     * same cartridge, and matched when `token` is null. */
    insertMicrodrive(drive, data, token) {
        this.microdriveTokens[drive] = token ?? null;
        const seq = ++this.microdriveInsertSeq;
        // Accept an ArrayBuffer or a typed array; either way, transfer a
        // fresh standalone copy so the caller keeps whatever it passed in.
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const buf = bytes.slice(0).buffer;
        this.worker.postMessage({ message: 'insertMicrodrive', drive, data: buf, token, seq }, [buf]);
        this.emit('insertMicrodrive', drive, token);
        return seq;
    }
    ejectMicrodrive(drive) {
        this.microdriveTokens[drive] = null;
        this.worker.postMessage({ message: 'ejectMicrodrive', drive });
        this.emit('ejectMicrodrive', drive);
    }
    /* Sets the drives' motors, heads and sync state as a session saved them,
     * so a Microdrive command caught in the middle carries on; for after the
     * session's cartridges are back in their drives. */
    setMicrodriveMechanism(mechanism) {
        this.worker.postMessage({ message: 'setMicrodriveMechanism', mechanism });
    }
    setMicrodriveWriteProtect(drive, value) {
        this.worker.postMessage({ message: 'setMicrodriveWriteProtect', drive, value });
    }
    /* The cartridge in drive 0-7 is kept under `token` from now on, where it
     * was kept under `from`: its later flushes carry the new token. */
    setMicrodriveToken(drive, from, token) {
        if (this.microdriveTokens[drive] === from) this.microdriveTokens[drive] = token;
        this.worker.postMessage({ message: 'setMicrodriveToken', drive, from, token });
    }
    /* The same for the cassette put in the recorder by insert `seq`. */
    setCassetteToken(seq, token) {
        this.worker.postMessage({ message: 'setCassetteToken', seq, token });
    }
    /* Renames the cartridge in drive 0-7 in place, files untouched; the
     * renamed image comes back in a 'microdriveData' event. */
    renameMicrodrive(drive, name) {
        this.worker.postMessage({ message: 'renameMicrodrive', drive, name });
    }

    /* Connects (or disconnects) the ZX Printer. Nothing is reset: the paper
     * and what is printed on it stay as they are. */
    setPrinter(enabled) {
        this.printerEnabled = enabled;
        this.worker.postMessage({ message: 'setPrinter', enabled });
        if (!enabled) this.printerMotor = false;
        this.emit('setPrinter', enabled);
    }
    /* Loads the printer with `rows` pixel rows of paper (0 = no paper). */
    setPrinterPaper(rows) {
        this.printerPaper = rows;
        this.worker.postMessage({ message: 'setPrinterPaper', rows });
    }
    /* Presses (true) or releases (false) the printer's feed button. */
    setPrinterFeed(on) {
        this.worker.postMessage({ message: 'setPrinterFeed', on });
    }

    /* Calls back once the core and the ROMs are in and the machine is set
     * up, immediately if that has already happened. */
    onReady(callback) {
        if (this.isReady) {
            callback();
        } else {
            this.onReadyHandlers.push(callback);
        }
    }

    /* Calls back once, beyond that, the files in the constructor's
     * opts.openUrl are open and opts.autoStart has started the machine,
     * immediately if that has already happened. The public JSSpeccy(...)
     * return value's onReady delegates to this. */
    onStarted(callback) {
        if (this.isStarted) {
            callback();
        } else {
            this.onStartedHandlers.push(callback);
        }
    }

    /* Stops the emulator for good. What the tape recorder and the drives
     * hold that isn't kept yet is sent back first, so a recording or save
     * still in the worker isn't lost; resolves once the worker is gone. */
    async exit() {
        this.pause();
        if (this.isReady) {
            this.flushCassette();
            this.worker.postMessage({ message: 'flushMicrodrives' });
            // a worker that doesn't answer is stopped anyway
            await Promise.race([this.barrier(), new Promise(resolve => setTimeout(resolve, EXIT_FLUSH_TIMEOUT_MS))]);
        }
        this.worker.terminate();
    }
}

/* The display size - any windowed size, or fullscreen - is remembered in
 * localStorage and restored on the next visit. A browser lets a page go
 * fullscreen only in response to the user, so a remembered fullscreen comes
 * back on the first press of the start button; until then the display has
 * the size it had under fullscreen. */
const DISPLAY_KEY = 'jsspeccy-display';

/* The Display menu's slider sets the windowed size from ZOOM_MIN to
 * ZOOM_MAX in ZOOM_STEP steps, its thumb catching on ZOOM_MARKS within
 * ZOOM_SNAP. */
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.1;
const ZOOM_MARKS = [1, 1.5, 2, 2.5, 3, 3.5, 4];
const ZOOM_SNAP = 0.06;

function loadDisplay() {
    try {
        const saved = JSON.parse(localStorage.getItem(DISPLAY_KEY));
        if (saved && Number.isFinite(saved.zoom) && saved.zoom > 0) {
            return { zoom: saved.zoom, fullscreen: !!saved.fullscreen };
        }
    } catch (e) { /* unreadable: use the page's own setting */ }
    return null;
}

function saveDisplay(display) {
    try {
        localStorage.setItem(DISPLAY_KEY, JSON.stringify(display));
    } catch (e) { /* private browsing / quota / disabled storage: just don't persist it */ }
}

/* The File menu's Auto-load tapes and Instant tape loading, once changed,
 * are remembered in localStorage and restored on the next visit, as
 * {autoLoadTapes, tapeTraps}. */
const TAPE_SETTINGS_KEY = 'jsspeccy-tape-settings';

function loadTapeSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(TAPE_SETTINGS_KEY));
        if (saved && typeof saved === 'object') return saved;
    } catch (e) { /* unreadable: use the page's own settings */ }
    return {};
}

function saveTapeSetting(name, value) {
    try {
        localStorage.setItem(TAPE_SETTINGS_KEY, JSON.stringify({ ...loadTapeSettings(), [name]: value }));
    } catch (e) { /* private browsing / quota / disabled storage: just don't persist it */ }
}

/* A listener that remembers the setting `name` whenever it changes from
 * `initial`, unless a script changed it. */
function rememberTapeSetting(name, initial) {
    let last = initial;
    return (value, byScript) => {
        if (value === last) return;
        last = value;
        if (!byScript) saveTapeSetting(name, value);
    };
}

window.JSSpeccy = (container, opts) => {
    // let benchmarkRunCount = 0;
    // let benchmarkRenderCount = 0;
    opts = opts || {};

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;

    const keyboardEnabled = ('keyboardEnabled' in opts) ? opts.keyboardEnabled : true;
    const uiEnabled = ('uiEnabled' in opts) ? opts.uiEnabled : true;

    // Only a setting the File menu shows can have been changed, so only that
    // one takes the place of the page's own.
    const savedTape = uiEnabled ? loadTapeSettings() : {};
    const savedAutoLoad = (!opts.sandbox && (typeof savedTape.autoLoadTapes === 'boolean')) ? savedTape.autoLoadTapes : null;
    const savedTraps = (typeof savedTape.tapeTraps === 'boolean') ? savedTape.tapeTraps : null;

    const emu = new Emulator(canvas, {
        machine: opts.machine || 48,
        autoStart: opts.autoStart || false,
        autoLoadTapes: savedAutoLoad ?? (('autoLoadTapes' in opts) ? opts.autoLoadTapes : true),
        tapeAutoLoadMode: opts.tapeAutoLoadMode || 'default',
        openUrl: opts.openUrl,
        tapeTrapsEnabled: savedTraps ?? (('tapeTrapsEnabled' in opts) ? opts.tapeTrapsEnabled : true),
        keyboardEnabled: keyboardEnabled,
        keyboardMap: opts.keyboardMap || 'standard',
        joystickEnabled: ('joystickEnabled' in opts) ? opts.joystickEnabled : true,
        joystickType: opts.joystickType || 'kempston',
        joystickDevice: opts.joystickDevice || null,
    });
    // Without the menu bar there is no way to change the size, so the page's
    // own setting always holds.
    const savedDisplay = uiEnabled ? loadDisplay() : null;
    const ui = new UIController(container, emu, {
        zoom: (savedDisplay && savedDisplay.zoom) || opts.zoom || 1,
        sandbox: opts.sandbox,
        uiEnabled: uiEnabled,
    });
    let tapeDeck = null;  // the tape recorder, where the UI offers one
    /* A display size set through the embedding API is the page's choice,
     * not the visitor's, so it isn't remembered. The change it asks for is
     * noted here and passed over when it arrives: at once, or in or out of
     * fullscreen once the browser has made the change. */
    let apiDisplay = null;
    const displayByApi = (value) => { apiDisplay = { value, at: performance.now() }; };
    if (uiEnabled) {
        ui.on('setZoom', (factor) => {
            if (apiDisplay && (apiDisplay.value === factor) && ((performance.now() - apiDisplay.at) < API_DISPLAY_MS)) {
                apiDisplay = null;
                return;
            }
            saveDisplay(factor === 'fullscreen' ? { zoom: ui.zoom, fullscreen: true } : { zoom: factor, fullscreen: false });
        });
        if (savedDisplay && savedDisplay.fullscreen) {
            ui.startButton.addEventListener('click', () => ui.enterFullscreen(), { once: true });
        }
    }

    if (keyboardEnabled) {
        if (ui.appContainer.tabIndex == -1) {
            ui.appContainer.tabIndex = 0;  // allow receiving focus for keyboard events
        }
        emu.setKeyboardEventRoot(ui.appContainer);
    }

    if (uiEnabled) {
        const fileMenu = ui.menuBar.addMenu('File');
        if (!opts.sandbox) {
            fileMenu.addItem('Open...', () => {
                openFileDialog();
            });
            fileMenu.addItem('Find games...', () => {
                openGameBrowser();
            });
            // Only where a download can actually succeed; see isPlayZXAvailable()
            if (isPlayZXAvailable()) {
                fileMenu.addItem('PlayZX open…', () => openPlayZXDialog(ui, emu));
            }
            fileMenu.addItem('Pokes…', () => openPokesDialog(ui, emu));
            const autoLoadTapesMenuItem = fileMenu.addItem('Auto-load tapes', () => {
                emu.setAutoLoadTapes(!emu.autoLoadTapes);
                emu.focus();
            });
            const updateAutoLoadTapesCheckbox = () => {
                if (emu.autoLoadTapes) {
                    autoLoadTapesMenuItem.setCheckbox();
                } else {
                    autoLoadTapesMenuItem.unsetCheckbox();
                }
            }
            emu.on('setAutoLoadTapes', updateAutoLoadTapesCheckbox);
            emu.on('setAutoLoadTapes', rememberTapeSetting('autoLoadTapes', emu.autoLoadTapes));
            updateAutoLoadTapesCheckbox();
        }

        const tapeTrapsMenuItem = fileMenu.addItem('Instant tape loading', () => {
            emu.setTapeTraps(!emu.tapeTrapsEnabled);
            emu.focus();
        });

        const updateTapeTrapsCheckbox = () => {
            if (emu.tapeTrapsEnabled) {
                tapeTrapsMenuItem.setCheckbox();
            } else {
                tapeTrapsMenuItem.unsetCheckbox();
            }
        }
        emu.on('setTapeTraps', updateTapeTrapsCheckbox);
        emu.on('setTapeTraps', rememberTapeSetting('tapeTraps', emu.tapeTrapsEnabled));
        updateTapeTrapsCheckbox();

        const machineMenu = ui.menuBar.addMenu('Machine');
        // The 48K machine runs the standard ROM or the "Gosh Wonderful" gw03
        // alternate (Emulator.rom48Variant); they differ only in the ROM in
        // page 10, so choosing one swaps that page and reboots.
        const boot48 = (variant) => {
            emu.setRom48Variant(variant).then(() => {
                emu.setMachine(48);
                emu.reset();
                emu.focus();
            });
        };
        const machine48Item = machineMenu.addItem('Spectrum 48K', () => {
            boot48('standard');
        });
        const machine48gwItem = machineMenu.addItem('Spectrum 48K gw03', () => {
            boot48('gw03');
        });
        const machine128Item = machineMenu.addItem('Spectrum 128K', () => {
            emu.setMachine(128);
            emu.reset();
            emu.focus();
        });
        const machinePentagonItem = machineMenu.addItem('Pentagon 128', () => {
            emu.setMachine(5);
            emu.reset();
            emu.focus();
        });
        const joystickMenu = ui.menuBar.addMenu('Joystick');
        const joystickItemsByType = {
            'none': joystickMenu.addItem('None', () => {
                emu.setJoystickType('none');
                emu.focus();
            }),
            'kempston': joystickMenu.addItem('Kempston', () => {
                emu.setJoystickType('kempston');
                emu.focus();
            }),
            'cursor': joystickMenu.addItem('Cursor', () => {
                emu.setJoystickType('cursor');
                emu.focus();
            }),
            'sinclair1': joystickMenu.addItem('Sinclair 1', () => {
                emu.setJoystickType('sinclair1');
                emu.focus();
            }),
            'sinclair2': joystickMenu.addItem('Sinclair 2', () => {
                emu.setJoystickType('sinclair2');
                emu.focus();
            }),
        };
        emu.on('setJoystickType', (type) => {
            for (const t in joystickItemsByType) {
                if (t == type) {
                    joystickItemsByType[t].setBullet();
                } else {
                    joystickItemsByType[t].unsetBullet();
                }
            }
        });
        // reflect the initial joystick type in the menu
        if (joystickItemsByType[emu.joystickType]) {
            joystickItemsByType[emu.joystickType].setBullet();
        }

        // Controller menu: choose which physical gamepad drives the emulator when
        // more than one is connected. The list is rebuilt as controllers connect /
        // disconnect - note a controller only shows up once a button is pressed on
        // it (a browser Gamepad API requirement).
        if (emu.joystickEnabled) {
            const controllerMenu = ui.menuBar.addMenu('Controller');
            const rebuildControllerMenu = () => {
                controllerMenu.list.innerHTML = '';
                const autoItem = controllerMenu.addItem('Automatic', () => {
                    emu.setJoystickDevice(null);
                    emu.focus();
                });
                if (!emu.joystickDevice) autoItem.setBullet();

                const devices = emu.getJoystickDevices();
                if (devices.length == 0) {
                    controllerMenu.addItem('(press a button on a pad)', null);
                } else {
                    devices.forEach((dev) => {
                        const item = controllerMenu.addItem(dev.label, () => {
                            emu.setJoystickDevice(dev.id);
                            emu.focus();
                        });
                        if (emu.joystickDevice
                            && dev.id.toLowerCase().includes(emu.joystickDevice.toLowerCase())) {
                            item.setBullet();
                        }
                    });
                }
            };
            rebuildControllerMenu();
            window.addEventListener('gamepadconnected', rebuildControllerMenu, { signal: ui.teardown });
            window.addEventListener('gamepaddisconnected', rebuildControllerMenu, { signal: ui.teardown });
            emu.on('setJoystickDevice', rebuildControllerMenu);
        }

        const displayMenu = ui.menuBar.addMenu('Display');

        /* The windowed size follows the slider as it is dragged. In
         * fullscreen the slider shows the size underneath, and is disabled
         * rather than leave fullscreen part way through a drag. */
        displayMenu.list.style.width = '190px';
        const zoomSlider = displayMenu.addSlider({
            min: ZOOM_MIN, max: ZOOM_MAX, step: ZOOM_STEP, marks: ZOOM_MARKS, snap: ZOOM_SNAP,
            format: (z) => Math.round(z * 100) + '%',
            onInput: (z) => ui.setZoom(z),
            onChange: () => emu.focus(),
        });
        const fullscreenItem = displayMenu.addItem('Fullscreen', () => {
            ui.enterFullscreen();
        })
        const setZoomCheckbox = (factor) => {
            zoomSlider.setValue(ui.zoom);
            zoomSlider.setEnabled(factor != 'fullscreen');
            if (factor == 'fullscreen') {
                fullscreenItem.setBullet();
            } else {
                fullscreenItem.unsetBullet();
            }
        }

        ui.on('setZoom', setZoomCheckbox);
        setZoomCheckbox(ui.zoom);

        emu.on('setMachine', (type) => {
            machine48Item.unsetBullet();
            machine48gwItem.unsetBullet();
            machine128Item.unsetBullet();
            machinePentagonItem.unsetBullet();
            if (type == 48) {
                if (emu.rom48Variant === 'gw03') machine48gwItem.setBullet();
                else machine48Item.setBullet();
            } else if (type == 128) {
                machine128Item.setBullet();
            } else { // pentagon
                machinePentagonItem.setBullet();
            }
        });

        // Saving and restoring the whole session; defined further down, once
        // the docks and the keyboard exist.
        const sessions = {};
        if (!opts.sandbox) {
            ui.toolbar.addButton(sessionSaveIcon, {label: 'Save session to PC'}, () => {
                sessions.save();
            });
            ui.toolbar.addButton(sessionRestoreIcon, {label: 'Restore a saved session'}, () => {
                sessions.chooseAndRestore();
            });
        }
        ui.toolbar.addButton(resetIcon, {label: 'Reset'}, () => {
            emu.reset();
        });
        const pauseButton = ui.toolbar.addButton(playIcon, {label: 'Unpause'}, () => {
            if (emu.isRunning) {
                emu.pause();
            } else {
                emu.start();
            }
        });
        emu.on('pause', () => {
            pauseButton.setIcon(playIcon);
            pauseButton.setLabel('Unpause');
        });
        emu.on('start', () => {
            pauseButton.setIcon(pauseIcon);
            pauseButton.setLabel('Pause');
        });
        const tapeButton = ui.toolbar.addButton(tapePlayIcon, {label: 'Start tape'}, () => {
            if (emu.tapeIsPlaying) {
                emu.stopTape();
            } else {
                emu.playTape();
            }
        });
        tapeButton.disable();
        emu.on('openedTapeFile', () => {
            tapeButton.enable();
        });
        emu.on('tapeInfo', () => {
            tapeButton.enable();
        });
        emu.on('playingTape', () => {
            tapeButton.setIcon(tapePauseIcon);
            tapeButton.setLabel('Stop tape');
        });
        emu.on('stoppedTape', () => {
            tapeButton.setIcon(tapePlayIcon);
            tapeButton.setLabel('Start tape');
        });

        /* Cassette counter: shows tape position / total (advancing as the tape
         * loads, instantly under tape-traps or gradually in real time), and the
         * loaded game's size. On the compact toolbar it shows the position
         * alone, so the toolbar stays on one row. Click it to jump to any
         * segment (a portion of the game split at the silences between
         * blocks), which also supports the multi-load games whose parts load
         * one at a time. */
        const fmtMs = (ms) => {
            const s = Math.round(ms / 1000);
            return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
        };
        const counterButton = ui.toolbar.addTextButton('--:--', {label: 'Cassette counter'}, () => {
            if (ui.isTapePopupOpen()) { ui.hideTapePopup(); return; }
            const segs = emu.tapeSegments || [];
            if (segs.length === 0) return;
            /* Mark the part the next load will read, which is the block the
             * tape is parked on, not where the counter sits: once a whole tape
             * has loaded the counter stays at the end while the tape itself has
             * wrapped back round to the first block. Where the tape says where
             * on its timeline that block starts, the part is found by that,
             * which tells apart the times round a loop; otherwise by the
             * block. */
            const nextMs = emu.tapeNextBlockMs;
            const block = emu.tapeBlockIndex;
            let currentSeg = 0;
            for (let i = 0; i < segs.length; i++) {
                const reached = (nextMs !== null) ? (segs[i].startMs <= nextMs + 0.5) : (segs[i].index <= block);
                if (reached) currentSeg = i;
            }
            const items = segs.map((seg, i) => ({ label: seg.label, current: i === currentSeg }));
            ui.showTapePopup('Jump to tape segment', items, (index) => {
                // The worker's reply starts whatever needs to read the tape.
                emu.seekTape(segs[index].index, false, segs[index].startMs);
                emu.focus();
            });
        });
        counterButton.disable();
        let tapeIn = false;
        const updateCounter = () => {
            if (!tapeIn) return;
            counterButton.setText(fmtMs(emu.tapePositionMs) + (ui.toolbar.compact ? '' : '/' + fmtMs(emu.tapeTotalMs)));
        };
        ui.on('setZoom', updateCounter);
        emu.on('tapeInfo', () => {
            tapeIn = true;
            counterButton.enable();
            updateCounter();
            counterButton.setLabel(
                'Tape: ' + Math.round(emu.tapeTotalBytes / 1024) + 'K, '
                + emu.tapeSegments.length + ' segment(s), click to jump to a part');
        });
        emu.on('tapePosition', updateCounter);

        /* Eject: remove the loaded tape and reset the counter. */
        const ejectButton = ui.toolbar.addButton(ejectIcon, {label: 'Eject tape'}, () => {
            emu.ejectTape();
            emu.focus();
        });
        ejectButton.disable();
        emu.on('tapeInfo', () => {
            ejectButton.enable();
        });
        emu.on('tapeEjected', () => {
            tapeIn = false;
            ui.hideTapePopup();
            counterButton.setText('--:--');
            counterButton.setLabel('Cassette counter');
            counterButton.disable();
            ejectButton.disable();
            tapeButton.disable();
        });

        /* Tape recorder: stands to the left of the Spectrum above the
         * Microdrives, joined to it by its EAR and MIC leads. The button beside
         * the eject button connects it or disconnects it. While connected, the
         * tape buttons above work its keys, whatever tape is in goes into it,
         * and SAVE records onto a cassette of your own (see
         * runtime/tape-deck-ui.js). Hidden in fullscreen, like the docks. */
        if (!opts.sandbox) {
            tapeDeck = createTapeDeck(ui, emu);
            const tapeDeckButton = ui.toolbar.addButton(tapeRecorderIcon, {label: 'Connect tape recorder'}, () => {
                tapeDeck.toggle();
                emu.focus();
            });
            emu.on('setTapeDeck', (connected) => {
                tapeDeckButton.setLabel(connected ? 'Disconnect tape recorder' : 'Connect tape recorder');
            });
            ui.on('setZoom', (factor) => {
                tapeDeck.setFullscreen(factor === 'fullscreen');
            });
            fileMenu.addItem('Tape cassettes…', () => tapeDeck.openBox());
        }

        const fullscreenButton = ui.toolbar.addButton(
            fullscreenIcon,
            {label: 'Enter full screen mode', align: 'right'},
            () => {
                ui.toggleFullscreen();
            }
        )

        /* ZX Printer: stands to the right of the Spectrum, joined to it by
         * its cable, with the printout rising to the top of the screen. The
         * toolbar button between the fullscreen and Microdrive buttons
         * connects or disconnects it without resetting the machine (see
         * runtime/printer-ui.js). Hidden in fullscreen, like the dock. */
        let printer = null;
        if (!opts.sandbox) {
            printer = createPrinter(ui, emu);
            const printerButton = ui.toolbar.addButton(
                printerIcon,
                {label: 'Connect Printer', align: 'right'},
                () => {
                    printer.toggle();
                    emu.focus();
                }
            );
            emu.on('setPrinter', (enabled) => {
                printerButton.setLabel(enabled ? 'Disconnect Printer' : 'Connect Printer');
            });
            ui.on('setZoom', (factor) => {
                printer.setFullscreen(factor === 'fullscreen');
            });
        }

        /* Microdrive dock: two drives standing to the left of the Spectrum,
         * joined to it by a ribbon. The toolbar button between the keyboard
         * and printer buttons connects the Interface 1 with its drives, or
         * disconnects it, without resetting the machine (a cartridge stays in
         * its drive either way - see runtime/microdrive-ui.js). The dock is
         * shown while connected; in fullscreen it is hidden but stays
         * connected, same as the keyboard. */
        let microdriveDock = null;
        if (!opts.sandbox) {
            microdriveDock = createMicrodriveDock(ui, emu);
            const microdriveButton = ui.toolbar.addButton(
                microdriveIcon,
                {label: 'Connect Microdrives', align: 'right'},
                () => {
                    microdriveDock.toggle();
                    emu.focus();
                }
            );
            emu.on('setInterface1', (enabled) => {
                microdriveButton.setLabel(enabled ? 'Disconnect Microdrives' : 'Connect Microdrives');
            });
            ui.on('setZoom', (factor) => {
                microdriveDock.setFullscreen(factor === 'fullscreen');
            });
            fileMenu.addItem('Microdrive cartridges…', () => microdriveDock.openBox());
        }

        /* On-screen clickable ZX Spectrum keyboard, shown under the emulation
         * area (as wide as the display, scaling with it). Toggled from the
         * toolbar next to the fullscreen button; hidden in fullscreen. */
        const keyboard = createKeyboardOverlay(emu, new URL('zx_keyboard.png', scriptUrl).href);
        ui.appContainer.appendChild(keyboard.element);
        // A character typed from the screen (see char-picker.js) is a key typed after a latched shift.
        ui.on('typeCharacter', () => keyboard.releaseShifts());
        let keyboardWanted = true;   // shown by default
        const keyboardButton = ui.toolbar.addButton(
            keyboardIcon,
            {label: 'Hide keyboard', align: 'right'},
            () => {
                keyboardWanted = !keyboardWanted;
                if (keyboardWanted && !ui.isFullscreen) { keyboard.show(); } else { keyboard.hide(); }
                keyboardButton.setLabel(keyboardWanted ? 'Hide keyboard' : 'Show keyboard');
                emu.focus();
            }
        );
        keyboard.show();

        ui.on('setZoom', (factor) => {
            if (factor == 'fullscreen') {
                fullscreenButton.setIcon(exitFullscreenIcon);
                fullscreenButton.setLabel('Exit full screen mode');
                keyboard.hide();                       // ignored in fullscreen
            } else {
                fullscreenButton.setIcon(fullscreenIcon);
                fullscreenButton.setLabel('Enter full screen mode');
                if (keyboardWanted) keyboard.show();   // restore on leaving fullscreen
            }
        });

        /* Saving and restoring the whole session as one file (see
         * runtime/session.js). Saving captures everything at the moment of
         * the click, then asks where to put the file. Restoring - from the
         * toolbar, File -> Open, or a session file dropped on the Spectrum -
         * asks first, then replaces the machine, tape, printout and
         * settings, and adds the session's cartridges and cassettes to their
         * boxes. */
        if (!opts.sandbox) {
            let sessionBusy = false;
            const showKeyboard = (shown) => {
                keyboardWanted = shown;
                if (keyboardWanted && !ui.isFullscreen) { keyboard.show(); } else { keyboard.hide(); }
                keyboardButton.setLabel(keyboardWanted ? 'Hide keyboard' : 'Show keyboard');
            };

            // Save and restore take turns; a second one while one is under
            // way is turned away, saying so.
            const beginSession = () => {
                if (!emu.isReady) return false;
                if (sessionBusy) {
                    alert('A session is already being saved or restored.');
                    return false;
                }
                sessionBusy = true;
                return true;
            };
            const localStamp = () => {
                const d = new Date();
                const two = (n) => String(n).padStart(2, '0');
                return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
            };

            sessions.save = async () => {
                if (!beginSession()) return;
                try {
                    const fileName = `spectrum-session-${localStamp()}.zip`;
                    // The snapshot is asked for at the click; everything else
                    // is read the moment it arrives, before anything else can
                    // happen, so it all matches. Meanwhile the Save As
                    // dialog opens, straight from the click as it must.
                    const captured = emu.getSnapshot().then((snapshot) => {
                        if (!snapshot) throw new Error('the emulator could not take a snapshot');
                        return {
                            snapshot,
                            settings: {
                                machine: emu.machineType,
                                rom48: emu.rom48Variant,
                                joystickType: emu.joystickType,
                                joystickDevice: emu.joystickDevice,
                                tapeTraps: emu.tapeTrapsEnabled,
                                autoLoadTapes: emu.autoLoadTapes,
                                tapeAutoLoadMode: emu.tapeAutoLoadMode,
                                keyboardShown: keyboardWanted,
                                zoom: ui.zoom,
                            },
                            tape: emu.tapeFile ? { name: emu.tapeFile.name, data: emu.tapeFile.data, block: emu.tapeBlockIndex, positionMs: snapshot.tapePositionMs } : null,
                            printer: printer.sessionSave(),
                            microdrives: microdriveDock.sessionSave(snapshot.drives),
                            tapeRecorder: tapeDeck.sessionSave(snapshot.cassette),
                            gameName: emu.loadedGameName,
                            power: emu.isInitiallyPaused ? 'off' : (emu.isRunning ? 'running' : 'paused'),
                        };
                    });
                    captured.catch(() => {});  // reported below, unless the user cancelled
                    const target = await chooseSaveTarget(fileName);
                    if (target === false) return;
                    const parts = await captured;
                    parts.microdrives = await parts.microdrives;
                    parts.tapeRecorder = await parts.tapeRecorder;
                    parts.printer.picture = await printer.sessionPicture(parts.printer.rows);
                    const blob = await buildSessionFile(parts);
                    await writeSaveTarget(target, blob, fileName);
                } catch (e) {
                    alert('Could not save the session: ' + ((e && e.message) || e));
                } finally {
                    sessionBusy = false;
                    emu.focus();
                }
            };

            /* The machine is paused for the whole restore, so the old program
             * can't act on the new tape, printout or cartridges. The snapshot
             * goes in first, with the Interface 1 connected or not as saved
             * so that its paging applies; the peripherals follow, the tape
             * recorder after the tape, since it may hold the tape. The machine
             * is then left as it was when the session was saved: switched
             * off, paused showing its screen, or running. */
            sessions.restore = async (zip) => {
                if (!beginSession()) return;
                let pausedHere = false;
                let restored = false;
                let power = 'running';
                try {
                    const session = await readSessionFile(zip);
                    if (!(await confirmRestore(ui, session))) return;
                    pausedHere = emu.isRunning;
                    emu.pause();

                    const settings = session.settings;
                    if (settings.joystickType) emu.setJoystickType(settings.joystickType);
                    if ('joystickDevice' in settings) emu.setJoystickDevice(settings.joystickDevice);
                    if ('tapeTraps' in settings) emu.setTapeTraps(settings.tapeTraps);
                    if ('autoLoadTapes' in settings) emu.setAutoLoadTapes(settings.autoLoadTapes);
                    if (settings.tapeAutoLoadMode) emu.tapeAutoLoadMode = settings.tapeAutoLoadMode;
                    if ('keyboardShown' in settings) showKeyboard(settings.keyboardShown);
                    await emu.setRom48Variant(settings.rom48);

                    emu.setInterface1(session.microdrives.connected);
                    const loaded = await emu.loadSnapshot(session.snapshot);
                    if (loaded && loaded.error) throw new Error(loaded.error);

                    await microdriveDock.sessionRestore(session.microdrives);
                    if (session.snapshot.microdriveMechanism) emu.setMicrodriveMechanism(session.snapshot.microdriveMechanism);
                    printer.sessionRestore(session.printer);
                    if (session.tape) {
                        const tapeOpts = { name: session.tape.name, quiet: true };
                        const opened = await (session.tape.isTZX
                            ? emu.openTZXFile(session.tape.data, tapeOpts)
                            : emu.openTAPFile(session.tape.data, tapeOpts));
                        if (opened && opened.error) throw new Error(opened.error);
                        emu.seekTape(session.tape.block, true);
                    } else if ((emu.tapeFile || emu.tapeTotalMs) && (session.tapeRecorder || (emu.tapeKind !== 'cassette'))) {
                        // A session from before the tape recorder leaves a cassette of yours in it.
                        emu.ejectTape();
                    }
                    // A session from before the tape recorder leaves it as it is.
                    if (session.tapeRecorder) await tapeDeck.sessionRestore(session.tapeRecorder);
                    if (session.tape && emu.tapeDeckConnected && (session.tape.positionMs !== null)) {
                        emu.windTape(session.tape.positionMs, true);
                    }
                    emu.setLoadedGame(session.gameName);
                    restored = true;
                    power = session.power;
                    if (power === 'off') {
                        emu.powerOff();
                    } else if (power === 'paused') {
                        emu.powerOnPaused();
                        await emu.showScreen();
                    }
                } catch (e) {
                    alert('Could not restore the session: ' + ((e && e.message) || e));
                } finally {
                    // Restored, it runs if it was saved running; otherwise it
                    // carries on as it was before the restore.
                    const run = restored ? (power === 'running') : pausedHere;
                    if (run && !emu.isRunning) emu.start();
                    sessionBusy = false;
                    emu.focus();
                }
            };

            sessions.chooseAndRestore = () => {
                fileDialog({ accept: '.zip' }).then(async (files) => {
                    const file = files && files[0];
                    if (!file) return;
                    let zip = null;
                    try {
                        zip = await JSZip.loadAsync(await file.arrayBuffer());
                    } catch (e) { /* not a ZIP */ }
                    if (!zip || !(await isSessionFile(zip))) {
                        alert(file.name + ' is not a saved session.');
                        return;
                    }
                    await sessions.restore(zip);
                });
            };

            emu.on('sessionFileOpened', ({ zip }) => sessions.restore(zip));
        }
    }

    const openFileDialog = () => {
        fileDialog().then(files => {
            const file = files[0];
            emu.openFile(file).then((res) => {
                // a session starts the machine itself, once restored
                if (emu.isInitiallyPaused && !(res && res.mediaType === 'session')) emu.start();
                emu.focus();
            }).catch((err) => {alert(err);});
        });
    }

    const openGameBrowser = () => {
        // Closing the dialog, by its X, Escape or after opening a game, sets the machine going as it was.
        const dialog = openDialog(ui, emu, {
            id: 'findGames', title: 'Find games', subtitle: 'Search the Internet Archive’s ZX Spectrum software library',
            width: 600, height: 600,
        });
        const searchForm = h('form', 'jsd-bar');
        const input = h('input', 'jsd-input jsd-search jsd-grow', {
            type: 'search', placeholder: 'Type a game name…', autocomplete: 'off', spellcheck: false,
        });
        const searchButton = button('Search', { variant: 'primary' });
        searchButton.type = 'submit';
        searchForm.append(input, searchButton);
        const resultsContainer = h('div', 'jsd-scroll');
        dialog.body.append(searchForm, resultsContainer);
        const archive = h('a', '', { href: 'https://archive.org/', target: '_blank', rel: 'noopener', textContent: 'Internet Archive' });
        dialog.aside.append('Powered by the ', archive);

        const showEmpty = (title, text) => {
            const box = h('div', 'jsd-empty');
            box.appendChild(h('b', '', { textContent: title }));
            box.appendChild(document.createTextNode(text));
            resultsContainer.replaceChildren(box);
        };
        showEmpty('Find a game', 'Type a title and press Enter. Double-click a result, or click its Open button, to play it.');

        const failed = (what) => (err) => {
            searchButton.disabled = false;
            dialog.setStatus(what + ': ' + ((err && err.message) || err), 'error');
        };

        // Opens the game's first snapshot or tape file.
        let opening = false;
        const openResult = (result) => {
            if (opening) return;
            opening = true;
            dialog.setStatus('Opening ' + result.title + '…', 'busy');
            const done = (err) => {
                opening = false;
                failed('Could not open ' + result.title)(err);
            };
            fetch(
                'https://archive.org/metadata/' + encodeURIComponent(result.identifier)
            ).then(response => {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            }).then(data => {
                if (dialog.closed) return;
                const chosen = (data.files || []).find(file => {
                    const ext = String(file.name).split('.').pop().toLowerCase();
                    return ext == 'z80' || ext == 'sna' || ext == 'tap' || ext == 'tzx' || ext == 'szx';
                });
                const chosenFilename = chosen ? chosen.name : null;
                if (!chosenFilename) {
                    done(new Error('it has no file the emulator can load'));
                    return;
                }
                // the file's path within the item, a segment at a time, keeping its slashes
                const finalUrl = 'https://cors.archive.org/cors/' + encodeURIComponent(result.identifier)
                    + '/' + chosenFilename.split('/').map(encodeURIComponent).join('/');
                // a dialog closed while the game downloads leaves the machine as it is
                return emu.openUrl(finalUrl, {stillWanted: () => !dialog.closed}).then((res) => {
                    opening = false;
                    if (!res || dialog.closed) return;
                    dialog.close();
                    emu.focus();
                    emu.start();
                });
            }).catch(done);
        };

        searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            // anything that could end the quoted title in the query goes
            const searchTerm = input.value.replace(/[^\w\s\-\']/g, '');
            if (!searchTerm.trim()) {
                input.focus();
                return;
            }
            searchButton.disabled = true;
            dialog.setStatus('Searching…', 'busy');

            const encodeParam = (key, val) => {
                return encodeURIComponent(key) + '=' + encodeURIComponent(val);
            }

            const searchUrl = (
                'https://archive.org/advancedsearch.php?'
                + encodeParam('q', 'collection:softwarelibrary_zx_spectrum title:"' + searchTerm + '"')
                + '&' + encodeParam('fl[]', 'creator')
                + '&' + encodeParam('fl[]', 'identifier')
                + '&' + encodeParam('fl[]', 'title')
                + '&' + encodeParam('rows', '50')
                + '&' + encodeParam('page', '1')
                + '&' + encodeParam('output', 'json')
            )
            fetch(searchUrl).then(response => {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            }).then(data => {
                searchButton.disabled = false;
                const results = data.response.docs;
                dialog.setStatus(results.length
                    ? results.length + (results.length === 1 ? ' game found' : ' games found') + (results.length >= 50 ? ' (the first 50)' : '')
                    : '');
                if (!results.length) {
                    showEmpty('No games found', 'Nothing in the library matches "' + searchTerm + '". Try fewer or different words.');
                    return;
                }
                const list = h('div');
                results.forEach(result => {
                    const row = h('div', 'jsd-row');
                    const main = h('div', 'jsd-row-main');
                    main.appendChild(h('div', 'jsd-row-title', { textContent: result.title }));
                    const creator = [].concat(result.creator || []).join(', ');
                    if (creator) main.appendChild(h('div', 'jsd-row-meta', { textContent: creator }));
                    const openButton = button('Open', { small: true, title: 'Load this game into the emulator' });
                    openButton.addEventListener('click', (e) => {
                        e.stopPropagation();
                        openResult(result);
                    });
                    row.append(main, openButton);
                    row.addEventListener('click', () => {
                        for (const other of list.children) {
                            other.classList.toggle('selected', other === row);
                            other.querySelector('.jsd-btn').classList.toggle('primary', other === row);
                        }
                    });
                    row.addEventListener('dblclick', () => openResult(result));
                    list.appendChild(row);
                });
                resultsContainer.replaceChildren(list);
                resultsContainer.scrollTop = 0;
            }).catch(failed('The search failed'));
        })
        input.focus();
    }

    // The page is left at once; the promise settles once what the worker held is sent back.
    const exit = () => {
        const done = emu.exit();
        ui.unload();
        return done;
    }

    /*
        const benchmarkElement = document.getElementById('benchmark');
        setInterval(() => {
            benchmarkElement.innerText = (
                "Running at " + benchmarkRunCount + "fps, rendering at "
                + benchmarkRenderCount + "fps"
            );
            benchmarkRunCount = 0;
            benchmarkRenderCount = 0;
        }, 1000)
    */

    return {
        setZoom: (zoom) => {displayByApi(zoom); ui.setZoom(zoom);},
        toggleFullscreen: () => {ui.toggleFullscreen();},
        enterFullscreen: () => {
            displayByApi('fullscreen');
            // refused, it makes no change for the note to pass over
            Promise.resolve(ui.enterFullscreen()).catch(() => { apiDisplay = null; });
        },
        exitFullscreen: () => {ui.exitFullscreen();},
        setMachine: (model) => {emu.setMachine(model);},
        setJoystickType: (type) => {emu.setJoystickType(type);},
        setJoystickDevice: (device) => {emu.setJoystickDevice(device);},
        getJoystickDevices: () => emu.getJoystickDevices(),
        openFileDialog: () => {openFileDialog();},
        openUrl: (url) => {
            emu.openUrl(url).catch((err) => {alert(err);});
        },
        loadSnapshotFromStruct: (snapshot) => {
            emu.loadSnapshot(snapshot);
        },
        onReady: (callback) => { emu.onStarted(callback); },
        exit: () => exit(),
        machine: createMachineApi(emu),
        keyboard: createKeyboardApi(emu),
        tape: createTapeApi(emu, tapeDeck),
    };
};

// Injected by webpack from package.json
window.JSSpeccy.version = __JSSPECCY_VERSION__;

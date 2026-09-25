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
import { isPlayZXAvailable } from './playzx-session.js';
import { validateMDRFile } from './mdr.js';
import { createMicrodriveDock } from './microdrive-ui.js';
import { createPrinter } from './printer-ui.js';
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
import keyboardIcon from './icons/keyboard.svg';
import microdriveIcon from './icons/microdrive.svg';
import printerIcon from './icons/printer.svg';

import { createKeyboardOverlay } from './keyboard-overlay.js';

const scriptUrl = document.currentScript.src;

// The file name at the end of a path.
const baseName = (path) => String(path).split('/').pop();

// The file name at the end of a URL, decoded.
const urlFileName = (url) => {
    const name = baseName(url).split('?')[0];
    try {
        return decodeURIComponent(name);
    } catch (e) {
        return name;
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
        this.tapeFile = null;    // {name, data} of the loaded tape, for saving a session
        this.rom48Variant = 'standard';  // which 48K ROM is in page 10: 'standard' or 'gw03'
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
         * trainer id -> {pokes, originals} so they can be undone. */
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

        /* ZX Printer support. printerPaper is the paper left on the roll, in
         * pixel rows, as last reported by the worker; printerMotor is whether
         * the printer's motor is running. */
        this.printerEnabled = false;
        this.printerPaper = 0;
        this.printerMotor = false;

        this.onReadyHandlers = [];

        this.worker.onmessage = (e) => {
            switch(e.data.message) {
                case 'ready':
                    this.loadRoms().then(() => {
                        this.setMachine(opts.machine || 48);
                        this.setTapeTraps(this.tapeTrapsEnabled);
                        if (opts.openUrl) {
                            this.openUrlList(opts.openUrl).catch(err => {
                                alert(err);
                            }).then(() => {
                                if (opts.autoStart) this.start();
                            });
                        } else if (opts.autoStart) {
                            this.start();
                        }

                        this.isReady = true;
                        for (let i=0; i < this.onReadyHandlers.length; i++) {
                            this.onReadyHandlers[i]();
                        }
                    });
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
                            /* running at full blast - start next frame but adjust time base
                            to give it the full time allocation */
                            this.runFrame();
                            this.nextFrameTime = time + this.msPerFrame;
                        } else {
                            this.isExecutingFrame = false;
                        }
                    } else {
                        this.isExecutingFrame = false;
                    }
                    break;
                case 'fileOpened':
                    if (e.data.error) {
                        this.fileOpenPromiseResolutions[e.data.id]({ mediaType: e.data.mediaType, error: e.data.error });
                        break;
                    }
                    if (e.data.mediaType == 'tape' && this.autoLoadTapes && !e.data.quiet) {
                        this.bootTapeLoader();
                        if (!this.tapeTrapsEnabled) {
                            this.playTape();
                        }
                    }
                    this.fileOpenPromiseResolutions[e.data.id]({
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
                    this.pokesPromiseResolutions[e.data.id](e.data.originals);
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
                    this.emit('tapeInfo');
                    break;
                case 'tapePosition':
                    this.tapePositionMs = e.data.positionMs || 0;
                    this.tapeBlockIndex = e.data.blockIndex || 0;
                    this.emit('tapePosition');
                    break;
                case 'tapeSeeked':
                    if (e.data.quiet) {
                        // restoring a session: the tape just moves
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
                    this.tapeIsPlaying = false;
                    this.emit('tapeEjected');
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
                    // this to persist it against e.data.token.
                    this.emit('microdriveData', e.data.drive, e.data.token, e.data.data);
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
            window.requestAnimationFrame((t) => {
                this.runAnimationFrame(t);
            });
        }
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
        const response = await fetch(new URL(url, scriptUrl));
        const data = new Uint8Array(await response.arrayBuffer());
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
        const response = await fetch(new URL('roms/if1-2.rom', scriptUrl));
        const rom = new Uint8Array(await response.arrayBuffer());
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

    runAnimationFrame(time) {
        if (this.displayHandler.readyToShow()) {
            this.displayHandler.show();
            // benchmarkRenderCount++;
        }
        if (this.isRunning) {
            if (time > this.nextFrameTime && !this.isExecutingFrame) {
                this.runFrame();
                this.nextFrameTime += this.msPerFrame;
            }
            window.requestAnimationFrame((t) => {
                this.runAnimationFrame(t);
            });
        }
    };

    setMachine(type) {
        if (type != 128 && type != 5) type = 48;
        this.worker.postMessage({
            message: 'setMachineType',
            type,
        });
        this.machineType = type;
        this.emit('setMachine', type);
    }

    reset() {
        this.worker.postMessage({message: 'reset'});
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
        this.machineType = snapshot.model;
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'loadSnapshot',
            id: fileID,
            snapshot,
        })
        this.emit('setMachine', snapshot.model);
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    /* Inserts a tape. opts.name is its file name, kept with a copy of the
     * bytes for saving a session (a tape opened without a name isn't
     * saved); opts.quiet (restoring a session) inserts it without
     * auto-loading it. */
    openTAPFile(data, opts) {
        opts = opts || {};
        this.tapeFile = opts.name ? { name: opts.name, data: copyBytes(data) } : null;
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTAPFile',
            id: fileID,
            data,
            quiet: !!opts.quiet,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    openTZXFile(data, opts) {
        opts = opts || {};
        this.tapeFile = opts.name ? { name: opts.name, data: copyBytes(data) } : null;
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTZXFile',
            id: fileID,
            data,
            quiet: !!opts.quiet,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    /* How to open a file, going by its name; `displayName` is the name to
     * show and keep for it, the last part of `filename` if not given. */
    getFileOpener(filename, displayName) {
        const cleanName = filename.toLowerCase();
        const name = displayName || baseName(filename);
        if (cleanName.endsWith('.z80')) {
            return arrayBuffer => {
                const z80file = parseZ80File(arrayBuffer);
                return this.loadSnapshot(z80file);
            };
        } else if (cleanName.endsWith('.szx')) {
            return arrayBuffer => {
                const szxfile = parseSZXFile(arrayBuffer);
                return this.loadSnapshot(szxfile);
            };
        } else if (cleanName.endsWith('.sna')) {
            return arrayBuffer => {
                const snafile = parseSNAFile(arrayBuffer);
                return this.loadSnapshot(snafile);
            };
        } else if (cleanName.endsWith('.tap')) {
            return arrayBuffer => {
                if (!TAPFile.isValid(arrayBuffer)) {
                    alert('Invalid TAP file');
                } else {
                    return this.openTAPFile(arrayBuffer, { name });
                }
            };
        } else if (cleanName.endsWith('.tzx')) {
            return arrayBuffer => {
                if (!TZXFile.isValid(arrayBuffer)) {
                    alert('Invalid TZX file');
                } else {
                    return this.openTZXFile(arrayBuffer, { name });
                }
            };
        } else if (cleanName.endsWith('.mdr')) {
            return async arrayBuffer => {
                if (!validateMDRFile(arrayBuffer)) {
                    alert('Invalid Microdrive cartridge (.mdr) file');
                    return { mediaType: 'microdrive' };
                }
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

    /* Apply an array of {bank, address, value} pokes in the worker; resolves
     * with the array of overwritten byte values (for undo). */
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

    async openFile(file) {
        const opener = this.getFileOpener(file.name);
        if (opener) {
            const buf = await file.arrayBuffer();
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
        const opener = this.getFileOpener(url.toString(), urlFileName(url.toString()));
        if (opener) {
            const response = await fetch(url);
            const buf = await response.arrayBuffer();
            return opener(buf).then((res) => {
                if (res && res.error) throw res.error;
                // Internal loads (e.g. tape-loader snapshots) must not
                // masquerade as the loaded game.
                if (opts.trackName !== false && res.mediaType !== 'microdrive' && res.mediaType !== 'session') {
                    this.setLoadedGame(urlFileName(url.toString()));
                }
                return res;
            });
        } else {
            throw 'Unrecognised file type: ' + url.split('/').pop();
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
    setTapeTraps(val) {
        this.tapeTrapsEnabled = val;
        this.worker.postMessage({
            message: 'setTapeTraps',
            value: val,
        })
        this.emit('setTapeTraps', val);
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
    /* `quiet` (restoring a session) moves the tape without starting a load. */
    seekTape(blockIndex, quiet) {
        this.worker.postMessage({
            message: 'seekTape',
            index: blockIndex,
            quiet: !!quiet,
        });
    }
    ejectTape() {
        this.worker.postMessage({
            message: 'ejectTape',
        });
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
     * the drive is flushed (if it had unsaved changes) before being replaced. */
    insertMicrodrive(drive, data, token) {
        this.microdriveTokens[drive] = token ?? null;
        // Accept an ArrayBuffer or a typed array; either way, transfer a
        // fresh standalone copy so the caller keeps whatever it passed in.
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const buf = bytes.slice(0).buffer;
        this.worker.postMessage({ message: 'insertMicrodrive', drive, data: buf, token }, [buf]);
        this.emit('insertMicrodrive', drive, token);
    }
    ejectMicrodrive(drive) {
        this.microdriveTokens[drive] = null;
        this.worker.postMessage({ message: 'ejectMicrodrive', drive });
        this.emit('ejectMicrodrive', drive);
    }
    setMicrodriveWriteProtect(drive, value) {
        this.worker.postMessage({ message: 'setMicrodriveWriteProtect', drive, value });
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

    /* Calls back once loadRoms() has resolved and any openUrl/autoStart from
     * the constructor's opts has run - immediately if that's already
     * happened. The public JSSpeccy(...) return value's onReady delegates
     * to this. */
    onReady(callback) {
        if (this.isReady) {
            callback();
        } else {
            this.onReadyHandlers.push(callback);
        }
    }

    exit() {
        this.pause();
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

window.JSSpeccy = (container, opts) => {
    // let benchmarkRunCount = 0;
    // let benchmarkRenderCount = 0;
    opts = opts || {};

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;

    const keyboardEnabled = ('keyboardEnabled' in opts) ? opts.keyboardEnabled : true;
    const uiEnabled = ('uiEnabled' in opts) ? opts.uiEnabled : true;

    const emu = new Emulator(canvas, {
        machine: opts.machine || 48,
        autoStart: opts.autoStart || false,
        autoLoadTapes: ('autoLoadTapes' in opts) ? opts.autoLoadTapes : true,
        tapeAutoLoadMode: opts.tapeAutoLoadMode || 'default',
        openUrl: opts.openUrl,
        tapeTrapsEnabled: ('tapeTrapsEnabled' in opts) ? opts.tapeTrapsEnabled : true,
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
    if (uiEnabled) {
        ui.on('setZoom', (factor) => {
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
            window.addEventListener('gamepadconnected', rebuildControllerMenu);
            window.addEventListener('gamepaddisconnected', rebuildControllerMenu);
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
         * loaded game's size. Click it to jump to any segment (a portion of the
         * game split at the silences between blocks), which also supports the
         * multi-load games whose parts load one at a time. */
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
             * wrapped back round to the first block. */
            const block = emu.tapeBlockIndex;
            let currentSeg = 0;
            for (let i = 0; i < segs.length; i++) {
                if (segs[i].index <= block) currentSeg = i;
            }
            const items = segs.map((seg, i) => ({ label: seg.label, current: i === currentSeg }));
            ui.showTapePopup('Jump to tape segment', items, (index) => {
                // The worker's reply starts whatever needs to read the tape.
                emu.seekTape(segs[index].index);
                emu.focus();
            });
        });
        counterButton.disable();
        const updateCounter = () => {
            counterButton.setText(fmtMs(emu.tapePositionMs) + '/' + fmtMs(emu.tapeTotalMs));
        };
        emu.on('tapeInfo', () => {
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
            ui.hideTapePopup();
            counterButton.setText('--:--');
            counterButton.setLabel('Cassette counter');
            counterButton.disable();
            ejectButton.disable();
            tapeButton.disable();
        });

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
         * settings, and adds the session's cartridges to the box. */
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
                            tape: emu.tapeFile ? { name: emu.tapeFile.name, data: emu.tapeFile.data, block: emu.tapeBlockIndex } : null,
                            printer: printer.sessionSave(),
                            microdrives: microdriveDock.sessionSave(snapshot.drives),
                            gameName: emu.loadedGameName,
                            power: emu.isInitiallyPaused ? 'off' : (emu.isRunning ? 'running' : 'paused'),
                        };
                    });
                    captured.catch(() => {});  // reported below, unless the user cancelled
                    const target = await chooseSaveTarget(fileName);
                    if (target === false) return;
                    const parts = await captured;
                    parts.microdrives = await parts.microdrives;
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
             * so that its paging applies; the peripherals follow. The machine
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
                    if (settings.zoom && !ui.isFullscreen) ui.setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, settings.zoom)));
                    await emu.setRom48Variant(settings.rom48);

                    emu.setInterface1(session.microdrives.connected);
                    const loaded = await emu.loadSnapshot(session.snapshot);
                    if (loaded && loaded.error) throw new Error(loaded.error);

                    await microdriveDock.sessionRestore(session.microdrives);
                    printer.sessionRestore(session.printer);
                    if (session.tape) {
                        const tapeOpts = { name: session.tape.name, quiet: true };
                        const opened = await (session.tape.isTZX
                            ? emu.openTZXFile(session.tape.data, tapeOpts)
                            : emu.openTAPFile(session.tape.data, tapeOpts));
                        if (opened && opened.error) throw new Error(opened.error);
                        emu.seekTape(session.tape.block, true);
                    } else if (emu.tapeFile || emu.tapeTotalMs) {
                        emu.ejectTape();
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
        emu.pause();
        const body = ui.showDialog();
        body.innerHTML = `
            <label>Find games</label>
            <form>
                <input type="search">
                <button type="submit">Search</button>
            </form>
            <div class="results">
            </div>
        `;
        const input = body.querySelector('input');
        const searchButton = body.querySelector('button');
        const searchForm = body.querySelector('form');
        const resultsContainer = body.querySelector('.results');

        searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            searchButton.innerText = 'Searching...';
            const searchTerm = input.value.replace(/[^\w\s\-\']/, '');

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
                searchButton.innerText = 'Search';
                return response.json();
            }).then(data => {
                resultsContainer.innerHTML = '<ul></ul><p>- powered by <a href="https://archive.org/">Internet Archive</a></p>';
                const ul = resultsContainer.querySelector('ul');
                const results = data.response.docs;
                results.forEach(result => {
                    const li = document.createElement('li');
                    ul.appendChild(li);
                    const resultLink = document.createElement('a');
                    resultLink.href = '#';
                    resultLink.innerText = result.title;
                    const creator = document.createTextNode(' - ' + result.creator)
                    li.appendChild(resultLink);
                    li.appendChild(creator);
                    resultLink.addEventListener('click', (e) => {
                        e.preventDefault();
                        fetch(
                            'https://archive.org/metadata/' + result.identifier
                        ).then(response => response.json()).then(data => {
                            let chosenFilename = null;
                            data.files.forEach(file => {
                                const ext = file.name.split('.').pop().toLowerCase();
                                if (ext == 'z80' || ext == 'sna' || ext == 'tap' || ext == 'tzx' || ext == 'szx') {
                                    chosenFilename = file.name;
                                }
                            });
                            if (!chosenFilename) {
                                alert('No loadable file found');
                            } else {
                                const finalUrl = 'https://cors.archive.org/cors/' + result.identifier + '/' + chosenFilename;
                                emu.openUrl(finalUrl).catch((err) => {
                                    alert(err);
                                }).then(() => {
                                    ui.hideDialog();
                                    emu.focus();
                                    emu.start();
                                });
                            }
                        })
                    })
                })
            })
        })
        input.focus();
    }

    const exit = () => {
        emu.exit();
        ui.unload();
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
        setZoom: (zoom) => {ui.setZoom(zoom);},
        toggleFullscreen: () => {ui.toggleFullscreen();},
        enterFullscreen: () => {ui.enterFullscreen();},
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
        onReady: (callback) => { emu.onReady(callback); },
        exit: () => {exit();},
    };
};

// Injected by webpack from package.json
window.JSSpeccy.version = __JSSPECCY_VERSION__;

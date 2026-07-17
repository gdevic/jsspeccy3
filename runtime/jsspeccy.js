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

import openIcon from './icons/open.svg';
import resetIcon from './icons/reset.svg';
import playIcon from './icons/play.svg';
import pauseIcon from './icons/pause.svg';
import fullscreenIcon from './icons/fullscreen.svg';
import exitFullscreenIcon from './icons/exitfullscreen.svg';
import tapePlayIcon from './icons/tape_play.svg';
import tapePauseIcon from './icons/tape_pause.svg';
import ejectIcon from './icons/eject.svg';
import keyboardIcon from './icons/keyboard.svg';

import { createKeyboardOverlay } from './keyboard-overlay.js';

const scriptUrl = document.currentScript.src;

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
        this.tapeSegments = [];       // segments of the loaded tape (cassette counter)
        this.tapeTotalMs = 0;
        this.tapeTotalBytes = 0;
        this.tapePositionMs = 0;

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
                    if (e.data.mediaType == 'tape' && this.autoLoadTapes) {
                        const TAPE_LOADERS_BY_MACHINE = {
                            '48': {'default': 'tapeloaders/tape_48.szx', 'usr0': 'tapeloaders/tape_48.szx'},
                            '128': {'default': 'tapeloaders/tape_128.szx', 'usr0': 'tapeloaders/tape_128_usr0.szx'},
                            '5': {'default': 'tapeloaders/tape_pentagon.szx', 'usr0': 'tapeloaders/tape_pentagon_usr0.szx'},
                        };
                        this.openUrl(new URL(TAPE_LOADERS_BY_MACHINE[this.machineType][this.tapeAutoLoadMode], scriptUrl), {trackName: false});
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
                    this.emit('tapeInfo');
                    break;
                case 'tapePosition':
                    this.tapePositionMs = e.data.positionMs || 0;
                    this.emit('tapePosition');
                    break;
                case 'tapeEjected':
                    this.tapeSegments = [];
                    this.tapeTotalMs = 0;
                    this.tapeTotalBytes = 0;
                    this.tapePositionMs = 0;
                    this.tapeIsPlaying = false;
                    this.emit('tapeEjected');
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

    loadSnapshot(snapshot) {
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

    openTAPFile(data) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTAPFile',
            id: fileID,
            data,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    openTZXFile(data) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTZXFile',
            id: fileID,
            data,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    getFileOpener(filename) {
        const cleanName = filename.toLowerCase();
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
                    return this.openTAPFile(arrayBuffer);
                }
            };
        } else if (cleanName.endsWith('.tzx')) {
            return arrayBuffer => {
                if (!TZXFile.isValid(arrayBuffer)) {
                    alert('Invalid TZX file');
                } else {
                    return this.openTZXFile(arrayBuffer);
                }
            };
        } else if (cleanName.endsWith('.zip')) {
            return async arrayBuffer => {
                const zip = await JSZip.loadAsync(arrayBuffer);
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
                this.setLoadedGame(file.name);
                return res;
            }).catch(err => {alert(err);});
        } else {
            throw 'Unrecognised file type: ' + file.name;
        }
    }

    async openUrl(url, opts) {
        opts = opts || {};
        const opener = this.getFileOpener(url.toString());
        if (opener) {
            const response = await fetch(url);
            const buf = await response.arrayBuffer();
            return opener(buf).then((res) => {
                // Internal loads (e.g. tape-loader snapshots) must not
                // masquerade as the loaded game.
                if (opts.trackName !== false) {
                    const basename = decodeURIComponent(
                        url.toString().split('/').pop().split('?')[0]);
                    this.setLoadedGame(basename);
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
    seekTape(blockIndex) {
        this.worker.postMessage({
            message: 'seekTape',
            index: blockIndex,
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

    exit() {
        this.pause();
        this.worker.terminate();
    }
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
    const ui = new UIController(container, emu, {
        zoom: opts.zoom || 1,
        sandbox: opts.sandbox,
        uiEnabled: uiEnabled,
    });

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
        // Which 48K ROM is active: 'standard' (roms/48.rom) or 'gw03' (the
        // "Gosh Wonderful" alternate 48K ROM). Both run as a 48K machine; they
        // differ only in the ROM loaded into page 10, so switching swaps that
        // page and reboots.
        let rom48Variant = 'standard';
        const boot48 = (variant, romFile) => {
            rom48Variant = variant;
            emu.loadRom(romFile, 10).then(() => {
                emu.setMachine(48);
                emu.reset();
                emu.focus();
            });
        };
        const machine48Item = machineMenu.addItem('Spectrum 48K', () => {
            boot48('standard', 'roms/48.rom');
        });
        const machine48gwItem = machineMenu.addItem('Spectrum 48K gw03', () => {
            boot48('gw03', 'roms/gw03.rom');
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

        const zoomItemsBySize = {
            1: displayMenu.addItem('100%', () => {ui.setZoom(1); emu.focus();}),
            2: displayMenu.addItem('200%', () => {ui.setZoom(2); emu.focus();}),
            3: displayMenu.addItem('300%', () => {ui.setZoom(3); emu.focus();}),
        }
        const fullscreenItem = displayMenu.addItem('Fullscreen', () => {
            ui.enterFullscreen();
        })
        const setZoomCheckbox = (factor) => {
            if (factor == 'fullscreen') {
                fullscreenItem.setBullet();
                for (let i in zoomItemsBySize) {
                    zoomItemsBySize[i].unsetBullet();
                }
            } else {
                fullscreenItem.unsetBullet();
                for (let i in zoomItemsBySize) {
                    if (parseInt(i) == factor) {
                        zoomItemsBySize[i].setBullet();
                    } else {
                        zoomItemsBySize[i].unsetBullet();
                    }
                }
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
                if (rom48Variant === 'gw03') machine48gwItem.setBullet();
                else machine48Item.setBullet();
            } else if (type == 128) {
                machine128Item.setBullet();
            } else { // pentagon
                machinePentagonItem.setBullet();
            }
        });

        if (!opts.sandbox) {
            ui.toolbar.addButton(openIcon, {label: 'Open file'}, () => {
                openFileDialog();
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
            const pos = emu.tapePositionMs;
            let currentSeg = 0;
            for (let i = 0; i < segs.length; i++) {
                if (segs[i].startMs <= pos + 1) currentSeg = i;
            }
            const items = segs.map((seg, i) => ({ label: seg.label, current: i === currentSeg }));
            ui.showTapePopup('Jump to tape segment', items, (index) => {
                emu.seekTape(segs[index].index);
                if (!emu.tapeTrapsEnabled) emu.playTape();  // real-time loaders need pulses flowing
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
                + emu.tapeSegments.length + ' segment(s) — click to jump to a part');
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
    }

    const openFileDialog = () => {
        fileDialog().then(files => {
            const file = files[0];
            emu.openFile(file).then(() => {
                if (emu.isInitiallyPaused) emu.start();
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
        onReady: (callback) => {
            if (emu.isReady) {
                callback();
            } else {
                emu.onReadyHandlers.push(callback);
            }
        },
        exit: () => {exit();},
    };
};

import { FRAME_BUFFER_SIZE } from './constants.js';
import { TAPFile, TZXFile } from './tape.js';
import { setCartridgeName } from './mdr.js';

let core = null;
let memory = null;
let memoryData = null;
let workerFrameData = null;
let registerPairs = null;
let tapePulses = null;

let stopped = false;
let tape = null;
let tapeIsPlaying = false;
let tapePositionTstates = 0;      // tape consumed since load/seek, drives the cassette counter
let framesSincePositionPost = 0;  // throttle position updates to the UI
let framesSinceTapeTrap = 0;      // frames since the machine last pulled a block through the trap
let tapeAutoPlayed = false;       // the tape was started by loader detection, not by the user
let autoPlaySuppressed = false;   // the user stopped the tape, so detection must not restart it
let loaderIdleFrames = 0;         // frames in which the machine read the port but no loader sampled it
let tapeTrapsEnabled = true;

/* Interface 1 / Microdrive: per-drive bookkeeping the core doesn't expose
 * directly. mdrTokens identifies which cartridge (an opaque id from the UI's
 * storage layer) is in each drive, so a flush can be posted back with an id
 * that still points at the right record even if the drive's been swapped by
 * the time the message arrives; mdrBlocks is the sector count last passed to
 * insertMicrodrive, needed to know how many bytes of the drive's (always
 * full-size) slot in MICRODRIVE_DATA are actually its cartridge. */
let mdrTokens = [null, null, null, null, null, null, null, null];
let mdrBlocks = [0, 0, 0, 0, 0, 0, 0, 0];
let mdrFramesSinceFlush = [0, 0, 0, 0, 0, 0, 0, 0];
let mdrLastMotors = 0;
let mdrFramesSinceStatus = 0;

/* How often a still-spinning, still-dirty drive gets force-flushed anyway
 * (long multi-block SAVEs shouldn't sit unflushed for their whole duration),
 * and how often the LED/head status gets posted regardless of whether it
 * changed (so the UI's head-position animation stays smooth). */
const MDR_FORCE_FLUSH_FRAMES = 250;
const MDR_STATUS_INTERVAL_FRAMES = 4;

const TSTATES_PER_MS = 3500;

/* A load counts as "in flight" while the machine has pulled a block through the
 * tape trap within this many frames (~1s at 50fps). Seeking during one lets the
 * running loader pick up the new position by itself; seeking outside one leaves
 * nothing to read the tape, so the UI boots the tape loader to start a fresh
 * LOAD from where the user jumped to. */
const TRAP_IDLE_FRAMES = 50;

/* With instant loading on, a custom loader that the trap cannot catch is run faster
 * than real time instead: each frame request runs extra frames for up to this many
 * milliseconds while the detected loader has the tape playing. */
const FAST_LOAD_MS = 12;

/* An auto-started tape is stopped once this many frames (~0.5s) have read the
 * port without a loader sampling it in an edge-timing loop, so a multi-load game
 * waiting between levels finds the tape where the last load left it. A frame is
 * active if it saw at least LOADER_ACTIVE_READS loader-like reads, which a game
 * polling the keyboard does not reach. A frame with no reads at all counts
 * neither way: loaders sit in long delays without touching the port (the ROM
 * and Speedlock both wait about a second into the pilot tone), and a stop only
 * takes effect at a frame boundary, so stopping there would cut the tone short
 * or corrupt a block. */
const LOADER_IDLE_FRAMES = 25;
const LOADER_ACTIVE_READS = 10;

const setTapePlaying = (playing, auto) => {
    if (playing == tapeIsPlaying) return;
    tapeIsPlaying = playing;
    tapeAutoPlayed = playing && !!auto;
    loaderIdleFrames = 0;
    if (core) core.setTapeState(!!tape, playing);
    postMessage({
        message: playing ? 'playingTape' : 'stoppedTape',
    });
};

/* A tape freshly inserted or ejected starts out stopped. */
const resetTapeState = () => {
    if (tapeIsPlaying) postMessage({ message: 'stoppedTape' });
    tapeIsPlaying = false;
    tapeAutoPlayed = false;
    autoPlaySuppressed = false;
    if (core) core.setTapeState(!!tape, false);
};

/* Start the tape when the core has seen a loader start sampling EAR, and stop it
 * once the loader has gone idle. Only a tape that detection started is stopped
 * by it, so a tape the user set playing keeps running. */
const serviceLoaderDetection = () => {
    const startRequested = core.takeLoaderStartRequest();
    const active = core.takeLoaderActivity() >= LOADER_ACTIVE_READS;
    const portRead = core.takeEarReads() > 0;
    if (startRequested && tape && !tapeIsPlaying && !autoPlaySuppressed && !tape.pulseGenerator.isAtEnd()) {
        setTapePlaying(true, true);
    } else if (tapeIsPlaying && tapeAutoPlayed) {
        if (active) loaderIdleFrames = 0;
        else if (portRead) loaderIdleFrames++;
        if (loaderIdleFrames >= LOADER_IDLE_FRAMES) setTapePlaying(false);
    }
};

const postTapeInfo = () => {
    if (!tape) return;
    postMessage({
        message: 'tapeInfo',
        segments: tape.segments,
        totalMs: tape.totalMs,
        totalBytes: tape.totalBytes,
        positionMs: tapePositionTstates / TSTATES_PER_MS,
        blockIndex: tape.nextBlockIndex,
    });
};

const postTapePosition = () => {
    postMessage({
        message: 'tapePosition',
        positionMs: tapePositionTstates / TSTATES_PER_MS,
        blockIndex: tape ? tape.nextBlockIndex : 0,
    });
    framesSincePositionPost = 0;
};

const loadCore = (baseUrl) => {
    WebAssembly.instantiateStreaming(
        fetch(new URL('jsspeccy-core.wasm', baseUrl), {})
    ).then(results => {
        core = results.instance.exports;
        memory = core.memory;
        memoryData = new Uint8Array(memory.buffer);
        workerFrameData = memoryData.subarray(core.FRAME_BUFFER, FRAME_BUFFER_SIZE);
        registerPairs = new Uint16Array(core.memory.buffer, core.REGISTERS, 12);
        tapePulses = new Uint16Array(core.memory.buffer, core.TAPE_PULSES, core.TAPE_PULSES_LENGTH);

        postMessage({
            'message': 'ready',
        });
    });
}

const loadMemoryPage = (page, data) => {
    memoryData.set(data, core.MACHINE_MEMORY + page * 0x4000);
};

/* Writes a cartridge's bytes into drive `drive`'s slice of MICRODRIVE_DATA
 * and tells the core about it. `data` is a full .mdr image (blocks*543
 * bytes, optionally with one trailing write-protect byte); a shorter
 * cartridge than the slot last held is fine, the slot is blanked first.
 * Flushes whatever cartridge was already in the drive first, so swapping
 * doesn't silently drop an unsaved change. */
const insertMicrodrive = (drive, data, token) => {
    flushMicrodrive(drive);
    const bytes = new Uint8Array(data);
    const blockLen = core.MICRODRIVE_BLOCK_LEN;
    let dataLen = bytes.length;
    let writeProtect = false;
    if (dataLen % blockLen === 1) {
        writeProtect = !!bytes[dataLen - 1];
        dataLen -= 1;
    }
    const blocks = Math.floor(dataLen / blockLen);
    const offset = core.MICRODRIVE_DATA + drive * core.MICRODRIVE_DRIVE_BYTES;
    memoryData.fill(0xff, offset, offset + core.MICRODRIVE_DRIVE_BYTES);
    memoryData.set(bytes.subarray(0, blocks * blockLen), offset);
    core.insertMicrodrive(drive, blocks, writeProtect);
    mdrTokens[drive] = token;
    mdrBlocks[drive] = blocks;
    mdrFramesSinceFlush[drive] = 0;
};

const ejectMicrodrive = (drive) => {
    flushMicrodrive(drive);
    core.ejectMicrodrive(drive);
    mdrTokens[drive] = null;
    mdrBlocks[drive] = 0;
};

/* Reads drive `drive`'s current bytes out of MICRODRIVE_DATA (if it's
 * inserted, dirty and has somewhere to go, or unconditionally for any
 * inserted cartridge when `force` is set) and posts them back as a .mdr
 * image. Returns whether anything was sent. */
const flushMicrodrive = (drive, force) => {
    if (!mdrBlocks[drive]) return false;
    if (!force && mdrTokens[drive] == null) return false;
    if (!force && !(core.getMicrodriveModified() & (1 << drive))) return false;
    const blockLen = core.MICRODRIVE_BLOCK_LEN;
    const dataLen = mdrBlocks[drive] * blockLen;
    const offset = core.MICRODRIVE_DATA + drive * core.MICRODRIVE_DRIVE_BYTES;
    const image = new Uint8Array(dataLen + 1);
    image.set(memoryData.subarray(offset, offset + dataLen));
    image[dataLen] = core.getMicrodriveWriteProtect(drive) ? 1 : 0;
    core.clearMicrodriveModified(drive);
    mdrFramesSinceFlush[drive] = 0;
    postMessage({
        message: 'microdriveData',
        drive,
        token: mdrTokens[drive],
        data: image.buffer,
    }, [image.buffer]);
    return true;
};

/* Called once per frame: posts LED/head-position status on change (or at
 * least every MDR_STATUS_INTERVAL_FRAMES, so the UI's head animation stays
 * smooth), and flushes a dirty drive once its motor stops, or periodically
 * anyway if it's been spinning and dirty for a long single save. */
const serviceMicrodrives = () => {
    if (!core.getMicrodriveMotors) return; // core predates this feature (shouldn't happen, but be defensive)
    const motors = core.getMicrodriveMotors();
    mdrFramesSinceStatus++;
    if (motors !== mdrLastMotors || mdrFramesSinceStatus >= MDR_STATUS_INTERVAL_FRAMES) {
        mdrLastMotors = motors;
        mdrFramesSinceStatus = 0;
        const heads = [];
        for (let d = 0; d < 8; d++) heads.push(core.getMicrodriveHeadPos(d));
        postMessage({ message: 'microdriveStatus', motors, heads });
    }
    const modifiedMask = core.getMicrodriveModified();
    for (let d = 0; d < 8; d++) {
        if (!(modifiedMask & (1 << d))) continue;
        mdrFramesSinceFlush[d]++;
        const motorOn = (motors & (1 << d)) !== 0;
        if (!motorOn || mdrFramesSinceFlush[d] >= MDR_FORCE_FLUSH_FRAMES) {
            flushMicrodrive(d);
        }
    }
};

/* Called once per emulated frame while the ZX Printer is connected: passes
 * on any rows printed since the last call, with the paper left and whether
 * the motor is running, and posts again whenever the motor starts or stops. */
let printerEnabled = false;
let printerLastMotor = false;
const servicePrinter = () => {
    if (!printerEnabled) return;
    const count = core.getPrinterRowCount();
    const motor = !!core.getPrinterMotor();
    if (!count && motor === printerLastMotor) return;
    printerLastMotor = motor;
    const rows = memoryData.slice(core.PRINTER_ROWS, core.PRINTER_ROWS + count * core.PRINTER_ROW_BYTES);
    core.clearPrinterRows();
    postMessage({ message: 'printerOutput', rows, paper: core.getPrinterPaper(), motor }, [rows.buffer]);
};

const loadSnapshot = (snapshot) => {
    core.setMachineType(snapshot.model);
    for (let page in snapshot.memoryPages) {
        loadMemoryPage(page, snapshot.memoryPages[page]);
    }
    ['AF', 'BC', 'DE', 'HL', 'AF_', 'BC_', 'DE_', 'HL_', 'IX', 'IY', 'SP', 'IR'].forEach(
        (r, i) => {
            registerPairs[i] = snapshot.registers[r];
        }
    )
    core.setPC(snapshot.registers.PC);
    core.setIFF1(snapshot.registers.iff1);
    core.setIFF2(snapshot.registers.iff2);
    core.setIM(snapshot.registers.im);
    core.setHalted(!!snapshot.halted);

    core.writePort(0x00fe, snapshot.ulaState.borderColour);
    if (snapshot.model != 48) {
        core.writePort(0x7ffd, snapshot.ulaState.pagingFlags);
    }

    core.setTStates(snapshot.tstates);
};

const trapTapeLoad = () => {
    if (!tape) return;
    framesSinceTapeTrap = 0;
    const beforeIndex = tape.nextBlockIndex;
    const block = tape.getNextLoadableBlock();
    if (!block) return;

    // Advance the cassette counter: an instant (trapped) load jumps straight to
    // the next block's start, or to the end once we wrap past the last block.
    if (tape.blockStartMs) {
        const afterIndex = tape.nextBlockIndex;
        tapePositionTstates = (afterIndex > beforeIndex && afterIndex < tape.blockStartMs.length)
            ? tape.blockStartMs[afterIndex] * TSTATES_PER_MS
            : tape.totalMs * TSTATES_PER_MS;
        postTapePosition();
    }

    /* get expected block type and load vs verify flag from AF' */
    const af_ = registerPairs[4];
    const expectedBlockType = af_ >> 8;
    const shouldLoad = af_ & 0x0001;  // LOAD rather than VERIFY
    let addr = registerPairs[8];  /* IX */
    const requestedLength = registerPairs[2];  /* DE */
    const actualBlockType = block[0];

    let success = true;
    if (expectedBlockType != actualBlockType) {
        success = false;
    } else {
        if (shouldLoad) {
            let offset = 1;
            let loadedBytes = 0;
            let checksum = actualBlockType;
            while (loadedBytes < requestedLength) {
                if (offset >= block.length) {
                    /* have run out of bytes to load */
                    success = false;
                    break;
                }
                const byte = block[offset++];
                loadedBytes++;
                core.poke(addr, byte);
                addr = (addr + 1) & 0xffff;
                checksum ^= byte;
            }

            // if loading is going right, we should still have a checksum byte left to read
            success &= (offset < block.length);
            let lastByte = loadedBytes ? block[offset - 1] : 0;
            if (success) {
                const expectedChecksum = block[offset];
                lastByte = expectedChecksum;
                checksum ^= expectedChecksum;
                success = (checksum === 0);
            }

            /* Leave the registers as LD-BYTES itself does on return: IX past the
             * last byte stored, DE counting the bytes still wanted, H holding the
             * running parity (0 on success) and L the last byte read. Loaders run
             * code from the block they just loaded that picks up from IX, e.g.
             * Tomahawk's BASIC decrypts itself relative to it. */
            registerPairs[8] = addr;  /* IX */
            registerPairs[2] = (requestedLength - loadedBytes) & 0xffff;  /* DE */
            registerPairs[3] = ((checksum & 0xff) << 8) | lastByte;  /* HL */
        } else {
            // VERIFY. TODO: actually verify.
            success = true;
        }
    }

    if (success) {
        /* set carry to indicate success */
        registerPairs[0] |= 0x0001;
    } else {
        /* reset carry to indicate failure */
        registerPairs[0] &= 0xfffe;
    }
    core.setPC(0x05e2);  /* address at which to exit the tape trap */
}

const runEmulatedFrame = () => {
    if (framesSinceTapeTrap < TRAP_IDLE_FRAMES) framesSinceTapeTrap++;

    if (tape && tapeIsPlaying) {
        const tapePulseBufferTstateCount = core.getTapePulseBufferTstateCount();
        const tapePulseWriteIndex = core.getTapePulseWriteIndex();
        const [newTapePulseWriteIndex, tstatesGenerated, tapeFinished] = tape.pulseGenerator.emitPulses(
            tapePulses, tapePulseWriteIndex, 80000 - tapePulseBufferTstateCount
        );
        core.setTapePulseBufferState(newTapePulseWriteIndex, tapePulseBufferTstateCount + tstatesGenerated);
        // Advance the cassette counter by the tape actually played this frame.
        tapePositionTstates += tstatesGenerated;
        framesSincePositionPost++;
        if (tapeFinished || framesSincePositionPost >= 5) postTapePosition();
        if (tapeFinished) setTapePlaying(false);
    }

    let status = core.runFrame();
    while (status) {
        switch (status) {
            case 1:
                stopped = true;
                throw("Unrecognised opcode!");
            case 2:
                trapTapeLoad();
                break;
            default:
                stopped = true;
                throw("runFrame returned unexpected result: " + status);
        }

        status = core.resumeFrame();
    }
    serviceLoaderDetection();
    serviceMicrodrives();
    servicePrinter();
};

onmessage = (e) => {
    switch (e.data.message) {
        case 'loadCore':
            loadCore(e.data.baseUrl);
            break;
        case 'runFrame':
            if (stopped) return;
            const frameBuffer = e.data.frameBuffer;
            const frameData = new Uint8Array(frameBuffer);

            let audioBufferLeft = null;
            let audioBufferRight = null;
            let audioLength = 0;
            if ('audioBufferLeft' in e.data) {
                audioBufferLeft = e.data.audioBufferLeft;
                audioBufferRight = e.data.audioBufferRight;
                audioLength = audioBufferLeft.byteLength / 4;
                core.setAudioSamplesPerFrame(audioLength);
            } else {
                core.setAudioSamplesPerFrame(0);
            }

            runEmulatedFrame();
            if (tapeTrapsEnabled) {
                const fastLoadStart = performance.now();
                while (tapeIsPlaying && tapeAutoPlayed && (performance.now() - fastLoadStart) < FAST_LOAD_MS)
                    runEmulatedFrame();
            }

            frameData.set(workerFrameData);
            if (audioLength) {
                const leftSource = new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_LEFT, audioLength);
                const rightSource = new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_RIGHT, audioLength);
                const leftData = new Float32Array(audioBufferLeft);
                const rightData = new Float32Array(audioBufferRight);
                leftData.set(leftSource);
                rightData.set(rightSource);
                postMessage({
                    message: 'frameCompleted',
                    frameBuffer,
                    audioBufferLeft,
                    audioBufferRight,
                }, [frameBuffer, audioBufferLeft, audioBufferRight]);
            } else {
                postMessage({
                    message: 'frameCompleted',
                    frameBuffer,
                }, [frameBuffer]);
            }

            break;
        case 'keyDown':
            core.keyDown(e.data.row, e.data.mask);
            break;
        case 'keyUp':
            core.keyUp(e.data.row, e.data.mask);
            break;
        case 'setKempstonState':
            core.setKempstonState(e.data.state);
            break;
        case 'setMachineType':
            core.setMachineType(e.data.type);
            break;
        case 'reset':
            core.reset();
            break;
        case 'loadMemory':
            loadMemoryPage(e.data.page, e.data.data);
            break;
        case 'applyPokes': {
            /* Apply a list of {bank, address, value} pokes (.POK semantics:
             * bank bit 3 set = poke through the current paging, like a
             * Multiface would; bank 0-7 = that 128K RAM page directly).
             * Replies with the bytes that were overwritten so the UI can
             * undo the pokes later. */
            const originals = [];
            for (const p of e.data.pokes) {
                if (p.bank & 0x08) {
                    originals.push(core.peek(p.address));
                    core.poke(p.address, p.value);
                } else {
                    const offset = core.MACHINE_MEMORY
                        + ((p.bank & 0x07) * 0x4000) + (p.address & 0x3fff);
                    originals.push(memoryData[offset]);
                    memoryData[offset] = p.value;
                }
            }
            postMessage({
                message: 'pokesApplied',
                id: e.data.id,
                originals,
            });
            break;
        }
        case 'loadSnapshot':
            loadSnapshot(e.data.snapshot);
            postMessage({
                message: 'fileOpened',
                id: e.data.id,
                mediaType: 'snapshot',
            });
            break;
        case 'openTAPFile':
            tape = new TAPFile(e.data.data);
            resetTapeState();
            tapePositionTstates = 0;
            framesSinceTapeTrap = TRAP_IDLE_FRAMES;
            postMessage({
                message: 'fileOpened',
                id: e.data.id,
                mediaType: 'tape',
            });
            postTapeInfo();
            break;
        case 'openTZXFile':
            tape = new TZXFile(e.data.data);
            resetTapeState();
            tapePositionTstates = 0;
            framesSinceTapeTrap = TRAP_IDLE_FRAMES;
            postMessage({
                message: 'fileOpened',
                id: e.data.id,
                mediaType: 'tape',
            });
            postTapeInfo();
            break;
        case 'seekTape':
            if (tape) {
                tape.seekToBlock(e.data.index);
                autoPlaySuppressed = false;
                tapePositionTstates = (tape.blockStartMs[e.data.index] || 0) * TSTATES_PER_MS;
                if (core) core.resetTapePulseBuffer();
                postTapePosition();
                /* Moving the tape is all we can do here: something still has to
                 * read it. Tell the UI whether a load is already in flight, so
                 * it knows whether one needs starting. */
                postMessage({
                    message: 'tapeSeeked',
                    loadInFlight: framesSinceTapeTrap < TRAP_IDLE_FRAMES || tapeIsPlaying,
                });
            }
            break;
        case 'ejectTape':
            tape = null;
            resetTapeState();
            tapePositionTstates = 0;
            framesSinceTapeTrap = TRAP_IDLE_FRAMES;
            if (core) core.resetTapePulseBuffer();
            postMessage({ message: 'tapeEjected' });
            break;

        case 'playTape':
            if (tape) {
                autoPlaySuppressed = false;
                setTapePlaying(true);
            }
            break;
        case 'stopTape':
            if (tape) {
                autoPlaySuppressed = true;
                setTapePlaying(false);
            }
            break;
        case 'setTapeTraps':
            tapeTrapsEnabled = e.data.value;
            core.setTapeTraps(e.data.value);
            break;
        case 'setInterface1':
            // Flush every dirty drive before unpaging - disconnecting never
            // ejects a cartridge, but it's the natural moment to save it.
            if (!e.data.enabled) {
                for (let d = 0; d < 8; d++) flushMicrodrive(d);
            }
            core.setInterface1Enabled(!!e.data.enabled);
            break;
        case 'setPrinter':
            printerEnabled = !!e.data.enabled;
            core.setPrinterEnabled(printerEnabled);
            if (!printerEnabled && printerLastMotor) {
                printerLastMotor = false;
                postMessage({ message: 'printerOutput', rows: new Uint8Array(0), paper: core.getPrinterPaper(), motor: false });
            }
            break;
        case 'setPrinterPaper':
            // Confirmed straight back, so the page's paper count ends on
            // this value even if a report of the old roll was already on
            // its way.
            core.setPrinterPaper(e.data.rows);
            postMessage({ message: 'printerOutput', rows: new Uint8Array(0), paper: core.getPrinterPaper(), motor: printerLastMotor });
            break;
        case 'setPrinterFeed':
            core.setPrinterFeed(!!e.data.on);
            break;
        case 'insertMicrodrive':
            insertMicrodrive(e.data.drive, e.data.data, e.data.token);
            break;
        case 'ejectMicrodrive':
            ejectMicrodrive(e.data.drive);
            break;
        case 'setMicrodriveWriteProtect':
            core.setMicrodriveWriteProtect(e.data.drive, !!e.data.value);
            break;
        case 'renameMicrodrive':
            // Renames the live copy, so nothing written since the last flush
            // is lost, then posts the whole image back straight away.
            if (mdrBlocks[e.data.drive]) {
                const offset = core.MICRODRIVE_DATA + e.data.drive * core.MICRODRIVE_DRIVE_BYTES;
                setCartridgeName(memoryData.subarray(offset, offset + mdrBlocks[e.data.drive] * core.MICRODRIVE_BLOCK_LEN), e.data.name);
                flushMicrodrive(e.data.drive, true);
            }
            break;
        default:
            console.log('message received by worker:', e.data);
    }
};

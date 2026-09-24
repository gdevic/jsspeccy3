import { FRAME_BUFFER_SIZE } from './constants.js';
import { TAPFile, TZXFile } from './tape.js';

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
        default:
            console.log('message received by worker:', e.data);
    }
};

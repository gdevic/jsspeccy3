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

const TSTATES_PER_MS = 3500;

const postTapeInfo = () => {
    if (!tape) return;
    postMessage({
        message: 'tapeInfo',
        segments: tape.segments,
        totalMs: tape.totalMs,
        totalBytes: tape.totalBytes,
        positionMs: tapePositionTstates / TSTATES_PER_MS,
    });
};

const postTapePosition = () => {
    postMessage({ message: 'tapePosition', positionMs: tapePositionTstates / TSTATES_PER_MS });
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
            if (success) {
                const expectedChecksum = block[offset];
                success = (checksum === expectedChecksum);
            }
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
                if (tapeFinished) {
                    tapeIsPlaying = false;
                    postMessage({
                        message: 'stoppedTape',
                    });
                }
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
            tapeIsPlaying = false;
            tapePositionTstates = 0;
            postMessage({
                message: 'fileOpened',
                id: e.data.id,
                mediaType: 'tape',
            });
            postTapeInfo();
            break;
        case 'openTZXFile':
            tape = new TZXFile(e.data.data);
            tapeIsPlaying = false;
            tapePositionTstates = 0;
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
                tapePositionTstates = (tape.blockStartMs[e.data.index] || 0) * TSTATES_PER_MS;
                if (core) core.resetTapePulseBuffer();
                postTapePosition();
            }
            break;
        case 'ejectTape':
            tape = null;
            tapeIsPlaying = false;
            tapePositionTstates = 0;
            if (core) core.resetTapePulseBuffer();
            postMessage({ message: 'tapeEjected' });
            break;

        case 'playTape':
            if (tape && !tapeIsPlaying) {
                tapeIsPlaying = true;
                postMessage({
                    message: 'playingTape',
                });
            }
            break;
        case 'stopTape':
            if (tape && tapeIsPlaying) {
                tapeIsPlaying = false;
                postMessage({
                    message: 'stoppedTape',
                });
            }
            break;
        case 'setTapeTraps':
            core.setTapeTraps(e.data.value);
            break;
        default:
            console.log('message received by worker:', e.data);
    }
};

import {
    TSTATES_PER_MS, CASSETTE_MS, dataBlockTstates, headerName, pilotMs, blockMs, catchUntilMs,
    counterText, describeParts, blankFromMs, parseCassetteFile, writeCassetteTZX, pilotPulses, bytesThatFit,
    TAPE_TOLERANCE_MS, blockEndMs, soundLevel, soundSlice, soundChanges,
} from './cassette.js';

/* A pause at least this long (ms) after a block ends the current tape "segment"
 * (a loadable portion of the game): segments are split at the silences between
 * blocks. Tunable. */
const SEGMENT_PAUSE_MS = 500;

/* A loader started this close to the end of a block's pilot tone still
 * catches the block (see seekToMs). */
const CATCH_MARGIN_MS = 100;

function msToString(ms) {
    const secs = Math.round(ms / 1000);
    return Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2);
}

/* Group a flat list of {index, tstates, bytes, name, pauseAfterMs, loadable}
 * timed blocks into segments, breaking after any block whose trailing pause is
 * at least SEGMENT_PAUSE_MS. Returns {segments, totalMs, totalBytes}. */
function groupSegments(timed) {
    const segments = [];
    const blockStartMs = [];      // ms at which each block starts (indexed by block index)
    let totalTstates = 0;
    let totalBytes = 0;
    let cur = null;
    const closeSegment = () => {
        if (cur) { segments.push(cur); cur = null; }
    };
    for (const b of timed) {
        blockStartMs[b.index] = totalTstates / TSTATES_PER_MS;
        totalTstates += b.tstates;
        totalBytes += b.bytes;
        if (!cur) {
            cur = {
                index: b.index,           // block to seek to when this segment is chosen
                startMs: blockStartMs[b.index],
                tstates: 0, bytes: 0, name: '',
            };
        }
        if (!cur.name && b.name) cur.name = b.name;
        cur.tstates += b.tstates;
        cur.bytes += b.bytes;
        if (b.pauseAfterMs >= SEGMENT_PAUSE_MS) closeSegment();
    }
    closeSegment();
    let n = 0;
    for (const s of segments) {
        s.durationMs = s.tstates / TSTATES_PER_MS;
        // Show sub-kilobyte segments (headers, tiny blocks) in exact bytes rather
        // than a useless "0K".
        const kb = Math.round(s.bytes / 1024);
        const sizeStr = (kb === 0) ? (s.bytes + 'B') : (kb + 'K');
        s.label = (s.name || ('Part ' + (n + 1)))
            + '  @' + msToString(s.startMs) + '  (' + msToString(s.durationMs)
            + ', ' + sizeStr + ')';
        n++;
    }
    return {
        segments,
        totalMs: totalTstates / TSTATES_PER_MS,
        totalBytes,
        blockStartMs,
    };
}

class ToneSegment {
    constructor(pulseLength, pulseCount) {
        this.pulseLength = pulseLength;
        this.pulseCount = pulseCount;
        this.pulsesGenerated = 0;
    }
    isFinished() {
        return this.pulsesGenerated == this.pulseCount;
    }
    getNextPulseLength() {
        this.pulsesGenerated++;
        return this.pulseLength;
    }
}

class PulseSequenceSegment {
    constructor(pulses) {
        this.pulses = pulses;
        this.index = 0;
    }
    isFinished() {
        return this.index == this.pulses.length;
    }
    getNextPulseLength() {
        return this.pulses[this.index++];
    }
}

class DataSegment {
    constructor(data, zeroPulseLength, onePulseLength, lastByteBits) {
        this.data = data;
        this.zeroPulseLength = zeroPulseLength;
        this.onePulseLength = onePulseLength;
        this.bitCount = (this.data.length - 1) * 8 + lastByteBits;
        this.pulsesOutput = 0;
        this.lastPulseLength = null;
    }
    isFinished() {
        return this.pulsesOutput == this.bitCount * 2;
    }
    getNextPulseLength() {
        if (this.pulsesOutput & 0x01) {
            this.pulsesOutput++;
            return this.lastPulseLength;
        } else {
            const bitIndex = this.pulsesOutput >> 1;
            const byteIndex = bitIndex >> 3;
            const bitMask = 1 << (7 - (bitIndex & 0x07));
            this.lastPulseLength = (this.data[byteIndex] & bitMask) ? this.onePulseLength : this.zeroPulseLength;
            this.pulsesOutput++;
            return this.lastPulseLength;
        }
    }
}

class PauseSegment {
    constructor(duration) {
        this.duration = duration;
        this.emitted = false;
    }
    isFinished() {
        return this.emitted;
    }
    getNextPulseLength() {
        // TODO: take level back down to 0 after 1ms if it's currently high
        this.emitted = true;
        return this.duration * 3500;
    }
}

/* Blank tape lasting `tstates`, which need not be a whole number of
 * milliseconds. */
class SilenceSegment {
    constructor(tstates) {
        this.tstates = Math.max(1, Math.round(tstates));
        this.emitted = false;
    }
    isFinished() {
        return this.emitted;
    }
    getNextPulseLength() {
        this.emitted = true;
        return this.tstates;
    }
}

/* A sound recording (see runtime/cassette.js) from sample `fromSample` on:
 * each run of samples at one level is a pulse. */
class SoundSegment {
    constructor(sound, fromSample) {
        this.sound = sound;
        this.index = fromSample;
    }
    isFinished() {
        return this.index >= this.sound.count;
    }
    getNextPulseLength() {
        const level = soundLevel(this.sound, this.index);
        let end = this.index + 1;
        while ((end < this.sound.count) && (soundLevel(this.sound, end) === level)) end++;
        const samples = end - this.index;
        this.index = end;
        return samples * this.sound.tstatesPerSample;
    }
}

class PulseGenerator {
    constructor(getSegments) {
        this.segments = [];
        this.getSegments = getSegments;
        this.level = 0x0000;
        this.tapeIsFinished = false;  // if true, don't call getSegments again
        this.pendingCycles = 0;
    }
    addSegment(segment) {
        this.segments.push(segment);
    }
    reset() {
        /* Drop any queued/partly-emitted pulses so playback can restart cleanly
         * from a newly-sought tape position. */
        this.segments = [];
        this.pendingCycles = 0;
        this.level = 0x0000;
        this.tapeIsFinished = false;
    }
    /* True once every pulse up to the end of the tape has been emitted. */
    isAtEnd() {
        return this.tapeIsFinished && this.segments.length === 0 && this.pendingCycles === 0;
    }
    emitPulses(buffer, startIndex, cycleCount) {
        let cyclesEmitted = 0;
        let index = startIndex;
        let isFinished = false;
        while (cyclesEmitted < cycleCount) {
            if (this.pendingCycles > 0) {
                if (this.pendingCycles >= 0x8000) {
                    // emit a pulse of length 0x7fff
                    buffer[index++] = this.level | 0x7fff;
                    cyclesEmitted += 0x7fff;
                    this.pendingCycles -= 0x7fff;
                } else {
                    // emit a the remainder of this pulse in full
                    buffer[index++] = this.level | this.pendingCycles;
                    cyclesEmitted += this.pendingCycles;
                    this.pendingCycles = 0;
                }
            } else if (this.segments.length === 0) {
                if (this.tapeIsFinished) {
                    // mark end of tape
                    isFinished = true;
                    break;
                } else {
                    // get more segments
                    this.tapeIsFinished = !this.getSegments(this);
                }
            } else if (this.segments[0].isFinished()) {
                // discard finished segment
                this.segments.shift();
            } else {
                // new pulse
                this.pendingCycles = this.segments[0].getNextPulseLength();
                this.level ^= 0x8000;
            }
        }
        return [index, cyclesEmitted, isFinished];
    }
}

export class TAPFile {
    constructor(data) {
        let i = 0;
        this.blocks = [];
        var tap = new DataView(data);

        while ((i+1) < data.byteLength) {
            const blockLength = tap.getUint16(i, true);
            i += 2;
            this.blocks.push(new Uint8Array(data, i, blockLength));
            i += blockLength;
        }

        this.nextBlockIndex = 0;
        /* Whether the tape goes round again after its last block, as it
         * does for the toolbar's player; in the tape recorder it stops at
         * the end, like a real one. */
        this.wrap = true;
        /* T-states of the next block's pilot tone already past the head,
         * after a seek into the middle of it. */
        this.pilotSkipTstates = 0;

        this.pulseGenerator = new PulseGenerator((generator) => {
            if (this.blocks.length === 0) return false;
            if (this.nextBlockIndex >= this.blocks.length) {
                // parked at the end by seekToMs
                if (!this.wrap) return false;
                this.nextBlockIndex = 0;
            }
            const index = this.nextBlockIndex;
            const block = this.blocks[index];
            this.nextBlockIndex = this.wrap ? ((index + 1) % this.blocks.length) : (index + 1);

            // a short leader tone for a data block, a long one for a header
            this.queuePilot(generator, index, 2168, pilotPulses(block));
            generator.addSegment(new PulseSequenceSegment([667, 735]));
            generator.addSegment(new DataSegment(block, 855, 1710, 8));
            generator.addSegment(new PauseSegment(1000));

            // return false if tape has ended
            return this.wrap ? (this.nextBlockIndex != 0) : (this.nextBlockIndex < this.blocks.length);
        });

        this.buildTimeline();
    }

    /* Per-block timing/size for the cassette-counter UI; a standard TAP block is
     * leader + sync + data + a 1000 ms pause, so every block ends a segment. */
    buildTimeline() {
        const timed = this.blocks.map((block, index) => {
            const isHeader = !(block[0] & 0x80);
            const leader = 2168 * (isHeader ? 8063 : 3223);
            const sync = 667 + 735;
            const data = dataBlockTstates(block, 8, 855, 1710);
            const pauseMs = 1000;
            return {
                index,
                tstates: leader + sync + data + pauseMs * TSTATES_PER_MS,
                bytes: block.length,
                name: headerName(block),
                pauseAfterMs: pauseMs,
                loadable: true,
            };
        });
        const t = groupSegments(timed);
        this.segments = t.segments;
        this.totalMs = t.totalMs;
        this.totalBytes = t.totalBytes;
        this.blockStartMs = t.blockStartMs;
    }

    /* Rewind/fast-forward so the next block loaded is `index`. */
    seekToBlock(index) {
        if (index < 0 || index >= this.blocks.length) return;
        this.nextBlockIndex = index;
        this.pilotSkipTstates = 0;
        this.pulseGenerator.reset();
    }

    /* How many of a pilot tone's `count` pulses of `length` are left to play,
     * after a seek into the middle of it; the skip applies to that one tone. */
    takePilotPulses(length, count) {
        const skipped = length ? Math.floor(this.pilotSkipTstates / length) : 0;
        this.pilotSkipTstates = 0;
        return skipped ? Math.max(1, count - skipped) : count;
    }

    /* Queues the pilot tone of block `index`, remembered for catchPlayingBlock. */
    queuePilot(generator, index, length, count) {
        this.pilot = new ToneSegment(length, this.takePilotPulses(length, count));
        this.pilotBlockIndex = index;
        generator.addSegment(this.pilot);
    }

    /* The pulse generator takes a block off the tape as it starts playing it,
     * but a loader started during the block's pilot tone still catches that
     * block: this winds back to it, so getNextLoadableBlock returns it. */
    catchPlayingBlock() {
        if (this.pilot && !this.pilot.isFinished() && this.pulseGenerator.segments.includes(this.pilot)) {
            this.nextBlockIndex = this.pilotBlockIndex;
        }
    }

    /* Winds the tape to `ms` from its start. The next block is the first
     * whose pilot tone hasn't yet gone past, played from wherever the tape
     * now is: after blank tape up to it, or part way through its tone. Past
     * the last one, the tape is parked at its end. */
    seekToMs(ms) {
        const index = this.blocks.findIndex((block, i) => ms < (this.blockStartMs[i] + pilotMs(block) - CATCH_MARGIN_MS));
        if (index < 0) {
            this.nextBlockIndex = this.blocks.length;
            this.pilotSkipTstates = 0;
            this.pulseGenerator.reset();
            return;
        }
        this.seekToBlock(index);
        const startMs = this.blockStartMs[index];
        if (ms < startMs) {
            this.pulseGenerator.addSegment(new SilenceSegment((startMs - ms) * TSTATES_PER_MS));
        } else {
            this.pilotSkipTstates = (ms - startMs) * TSTATES_PER_MS;
        }
    }

    getNextLoadableBlock() {
        if (this.blocks.length === 0) return null;
        // a block loaded in one go takes any pilot skip from a seek with it
        this.pilotSkipTstates = 0;
        if (this.nextBlockIndex >= this.blocks.length) {
            if (!this.wrap) return null;
            this.nextBlockIndex = 0;
        }
        const block = this.blocks[this.nextBlockIndex];
        this.nextBlockIndex = this.wrap ? ((this.nextBlockIndex + 1) % this.blocks.length) : (this.nextBlockIndex + 1);
        return block;
    }

    static isValid(data) {
        /* test whether the given ArrayBuffer is a valid TAP file, i.e. EOF is consistent with the
        block lengths we read from the file */
        let pos = 0;
        const tap = new DataView(data);

        while (pos < data.byteLength) {
            if (pos + 1 >= data.byteLength) return false; /* EOF in the middle of a length word */
            const blockLength = tap.getUint16(pos, true);
            pos += blockLength + 2;
        }

        return (pos == data.byteLength); /* file is a valid TAP if pos is exactly at EOF and no further */
    }
};


export class TZXFile {
    static isValid(data) {
        const tzx = new DataView(data);

        const signature = "ZXTape!\x1A";
        for (let i = 0; i < signature.length; i++) {
            if (signature.charCodeAt(i) != tzx.getUint8(i)) {
                return false;
            }
        }
        return true;
    }

    constructor(data) {
        this.blocks = [];
        const tzx = new DataView(data);

        let offset = 0x0a;

        while (offset < data.byteLength) {
            const blockType = tzx.getUint8(offset);
            offset++;
            switch (blockType) {
                case 0x10:
                    (() => {
                        const pause = tzx.getUint16(offset, true);
                        offset += 2;
                        const dataLength = tzx.getUint16(offset, true);
                        offset += 2;
                        const blockData = new Uint8Array(data, offset, dataLength);
                        this.blocks.push({
                            'type': 'StandardSpeedData',
                            'pause': pause,
                            'data': blockData,
                            'generatePulses': (generator, index) => {
                                // a short leader tone for a data block, a long one for a header
                                this.queuePilot(generator, index, 2168, pilotPulses(blockData));
                                generator.addSegment(new PulseSequenceSegment([667, 735]));
                                generator.addSegment(new DataSegment(blockData, 855, 1710, 8));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x11:
                    (() => {
                        const pilotPulseLength = tzx.getUint16(offset, true); offset += 2;
                        const syncPulse1Length = tzx.getUint16(offset, true); offset += 2;
                        const syncPulse2Length = tzx.getUint16(offset, true); offset += 2;
                        const zeroBitLength = tzx.getUint16(offset, true); offset += 2;
                        const oneBitLength = tzx.getUint16(offset, true); offset += 2;
                        const pilotPulseCount = tzx.getUint16(offset, true); offset += 2;
                        const lastByteMask = tzx.getUint8(offset); offset += 1;
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        const dataLength = tzx.getUint16(offset, true) | (tzx.getUint8(offset+2) << 16); offset += 3;
                        const blockData = new Uint8Array(data, offset, dataLength);
                        this.blocks.push({
                            'type': 'TurboSpeedData',
                            'pilotPulseLength': pilotPulseLength,
                            'syncPulse1Length': syncPulse1Length,
                            'syncPulse2Length': syncPulse2Length,
                            'zeroBitLength': zeroBitLength,
                            'oneBitLength': oneBitLength,
                            'pilotPulseCount': pilotPulseCount,
                            'lastByteMask': lastByteMask,
                            'pause': pause,
                            'data': blockData,
                            'generatePulses': (generator, index) => {
                                this.queuePilot(generator, index, pilotPulseLength, pilotPulseCount);
                                generator.addSegment(new PulseSequenceSegment([syncPulse1Length, syncPulse2Length]));
                                generator.addSegment(new DataSegment(blockData, zeroBitLength, oneBitLength, lastByteMask));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x12:
                    (() => {
                        const pulseLength = tzx.getUint16(offset, true); offset += 2;
                        const pulseCount = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'PureTone',
                            'pulseLength': pulseLength,
                            'pulseCount': pulseCount,
                            'generatePulses': (generator) => {
                                generator.addSegment(new ToneSegment(pulseLength, pulseCount));
                            }
                        });
                    })();
                    break;
                case 0x13:
                    (() => {
                        const pulseCount = tzx.getUint8(offset); offset += 1;
                        const pulseLengths = [];
                        for (let i = 0; i < pulseCount; i++) {
                            pulseLengths[i] = tzx.getUint16(offset + i*2, true);
                        }
                        this.blocks.push({
                            'type': 'PulseSequence',
                            'pulseLengths': pulseLengths,
                            'generatePulses': (generator) => {
                                generator.addSegment(new PulseSequenceSegment(pulseLengths));
                            }
                        });
                        offset += (pulseCount * 2);
                    })();
                    break;
                case 0x14:
                    (() => {
                        const zeroBitLength = tzx.getUint16(offset, true); offset += 2;
                        const oneBitLength = tzx.getUint16(offset, true); offset += 2;
                        const lastByteMask = tzx.getUint8(offset); offset += 1;
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        const dataLength = tzx.getUint16(offset, true) | (tzx.getUint8(offset+2) << 16); offset += 3;
                        const blockData = new Uint8Array(data, offset, dataLength);
                        this.blocks.push({
                            'type': 'PureData',
                            'zeroBitLength': zeroBitLength,
                            'oneBitLength': oneBitLength,
                            'lastByteMask': lastByteMask,
                            'pause': pause,
                            'data': blockData,
                            'generatePulses': (generator) => {
                                generator.addSegment(new DataSegment(blockData, zeroBitLength, oneBitLength, lastByteMask));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x15:
                    (() => {
                        const tstatesPerSample = tzx.getUint16(offset, true); offset += 2;
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        const lastByteMask = tzx.getUint8(offset); offset += 1;
                        const dataLength = tzx.getUint16(offset, true) | (tzx.getUint8(offset+2) << 16); offset += 3;
                        const blockData = new Uint8Array(data, offset, dataLength);
                        // one bit per sample; lastByteMask is how many of the last byte's bits are used
                        const count = dataLength ? (((dataLength - 1) * 8) + (((lastByteMask >= 1) && (lastByteMask <= 8)) ? lastByteMask : 8)) : 0;
                        this.blocks.push({
                            'type': 'DirectRecording',
                            'tstatesPerSample': tstatesPerSample,
                            'lastByteMask': lastByteMask,
                            'pause': pause,
                            'data': blockData,
                            'generatePulses': (generator) => {
                                if (count && tstatesPerSample) {
                                    generator.addSegment(new SoundSegment({ bits: blockData, from: 0, count, tstatesPerSample }, 0));
                                }
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x20:
                    (() => {
                        // TODO: handle pause length of 0 (= stop tape)
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'Pause',
                            'pause': pause,
                            'generatePulses': (generator) => {
                                generator.addSegment(new PauseSegment(pause));
                            }
                        });
                    })();
                    break;
                case 0x21:
                    (() => {
                        const nameLength = tzx.getUint8(offset); offset += 1;
                        const nameBytes = new Uint8Array(data, offset, nameLength);
                        offset += nameLength;
                        const name = String.fromCharCode.apply(null, nameBytes);
                        this.blocks.push({
                            'type': 'GroupStart',
                            'name': name
                        });
                    })();
                    break;
                case 0x22:
                    (() => {
                        this.blocks.push({
                            'type': 'GroupEnd'
                        });
                    })();
                    break;
                case 0x23:
                    (() => {
                        const jumpOffset = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'JumpToBlock',
                            'offset': jumpOffset
                        });
                    })();
                    break;
                case 0x24:
                    (() => {
                        const repeatCount = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'LoopStart',
                            'repeatCount': repeatCount
                        });
                    })();
                    break;
                case 0x25:
                    (() => {
                        this.blocks.push({
                            'type': 'LoopEnd'
                        });
                    })();
                    break;
                case 0x26:
                    (() => {
                        const callCount = tzx.getUint16(offset, true); offset += 2;
                        const offsets = [];
                        for (let i = 0; i < callCount; i++) {
                            offsets[i] = tzx.getUint16(offset + i*2, true);
                        }
                        this.blocks.push({
                            'type': 'CallSequence',
                            'offsets': offsets
                        });
                        offset += (callCount * 2);
                    })();
                    break;
                case 0x27:
                    (() => {
                        this.blocks.push({
                            'type': 'ReturnFromSequence'
                        });
                    })();
                    break;
                case 0x28:
                    (() => {
                        const blockLength = tzx.getUint16(offset, true); offset += 2;
                        /* This is a silly block. Don't bother parsing it further. */
                        this.blocks.push({
                            'type': 'Select',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
                    break;
                case 0x30:
                    (() => {
                        const textLength = tzx.getUint8(offset); offset += 1;
                        const textBytes = new Uint8Array(data, offset, textLength);
                        offset += textLength;
                        const text = String.fromCharCode.apply(null, textBytes);
                        this.blocks.push({
                            'type': 'TextDescription',
                            'text': text
                        });
                    })();
                    break;
                case 0x31:
                    (() => {
                        const displayTime = tzx.getUint8(offset); offset += 1;
                        const textLength = tzx.getUint8(offset); offset += 1;
                        const textBytes = new Uint8Array(data, offset, textLength);
                        offset += textLength;
                        const text = String.fromCharCode.apply(null, textBytes);
                        this.blocks.push({
                            'type': 'MessageBlock',
                            'displayTime': displayTime,
                            'text': text
                        });
                    })();
                    break;
                case 0x32:
                    (() => {
                        const blockLength = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'ArchiveInfo',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
                    break;
                case 0x33:
                    (() => {
                        const blockLength = tzx.getUint8(offset) * 3; offset += 1;
                        this.blocks.push({
                            'type': 'HardwareType',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
                    break;
                case 0x35:
                    (() => {
                        const identifierBytes = new Uint8Array(data, offset, 10);
                        offset += 10;
                        const identifier = String.fromCharCode.apply(null, identifierBytes);
                        const dataLength = tzx.getUint32(offset, true);
                        offset += 4;
                        this.blocks.push({
                            'type': 'CustomInfo',
                            'identifier': identifier,
                            'data': new Uint8Array(data, offset, dataLength)
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x5A:
                    (() => {
                        offset += 9;
                        this.blocks.push({
                            'type': 'Glue'
                        });
                    })();
                    break;
                default:
                    (() => {
                        /* follow extension rule: next 4 bytes = length of block */
                        const blockLength = tzx.getUint32(offset, true);
                        offset += 4;
                        this.blocks.push({
                            'type': 'unknown',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
                }
        }

        this.nextBlockIndex = 0;
        this.loopToBlockIndex;
        this.repeatCount;
        this.callStack = [];
        this.wrap = true;          // see TAPFile
        this.pilotSkipTstates = 0;

        this.pulseGenerator = new PulseGenerator((generator) => {
            const block = this.getNextMeaningfulBlock(false);
            if (!block) return false;
            block.generatePulses(generator, this.nextBlockIndex - 1);
            return true;
        });

        this.buildTimeline();
    }

    /* Per-block timing/size for the cassette-counter UI. Uses linear block order
     * (loops/jumps are rare and only wrap pilot tones), which is accurate enough
     * for the segment list. */
    blockTiming(block) {
        switch (block.type) {
            case 'StandardSpeedData': {
                const isHeader = !(block.data[0] & 0x80);
                const t = 2168 * (isHeader ? 8063 : 3223) + (667 + 735)
                    + dataBlockTstates(block.data, 8, 855, 1710)
                    + block.pause * TSTATES_PER_MS;
                return { tstates: t, bytes: block.data.length, name: headerName(block.data),
                    pauseAfterMs: block.pause, loadable: true };
            }
            case 'TurboSpeedData': {
                const t = block.pilotPulseLength * block.pilotPulseCount
                    + (block.syncPulse1Length + block.syncPulse2Length)
                    + dataBlockTstates(block.data, block.lastByteMask, block.zeroBitLength, block.oneBitLength)
                    + block.pause * TSTATES_PER_MS;
                return { tstates: t, bytes: block.data.length, name: headerName(block.data),
                    pauseAfterMs: block.pause, loadable: true };
            }
            case 'PureData': {
                const t = dataBlockTstates(block.data, block.lastByteMask, block.zeroBitLength, block.oneBitLength)
                    + block.pause * TSTATES_PER_MS;
                return { tstates: t, bytes: block.data.length, name: '', pauseAfterMs: block.pause, loadable: true };
            }
            case 'DirectRecording': {
                const samples = (block.data.length - 1) * 8 + block.lastByteMask;
                const t = samples * block.tstatesPerSample + block.pause * TSTATES_PER_MS;
                return { tstates: t, bytes: block.data.length, name: '', pauseAfterMs: block.pause, loadable: true };
            }
            case 'PureTone':
                return { tstates: block.pulseLength * block.pulseCount, bytes: 0, name: '', pauseAfterMs: 0, loadable: false };
            case 'PulseSequence':
                return { tstates: block.pulseLengths.reduce((a, b) => a + b, 0), bytes: 0, name: '', pauseAfterMs: 0, loadable: false };
            case 'Pause':
                return { tstates: block.pause * TSTATES_PER_MS, bytes: 0, name: '', pauseAfterMs: block.pause, loadable: false };
            case 'GroupStart':
                return { tstates: 0, bytes: 0, name: block.name, pauseAfterMs: 0, loadable: false };
            default:
                return { tstates: 0, bytes: 0, name: '', pauseAfterMs: 0, loadable: false };
        }
    }

    buildTimeline() {
        const timed = this.blocks.map((block, index) => {
            const info = this.blockTiming(block);
            return { index, ...info };
        });
        const t = groupSegments(timed);
        this.segments = t.segments;
        this.totalMs = t.totalMs;
        this.totalBytes = t.totalBytes;
        this.blockStartMs = t.blockStartMs;
    }

    /* Rewind/fast-forward so the next meaningful block played/loaded is `index`. */
    seekToBlock(index) {
        if (index < 0 || index >= this.blocks.length) return;
        this.nextBlockIndex = index;
        this.loopToBlockIndex = undefined;
        this.repeatCount = undefined;
        this.callStack = [];
        this.pilotSkipTstates = 0;
        this.pulseGenerator.reset();
    }

    takePilotPulses(length, count) {
        return TAPFile.prototype.takePilotPulses.call(this, length, count);
    }

    queuePilot(generator, index, length, count) {
        TAPFile.prototype.queuePilot.call(this, generator, index, length, count);
    }

    catchPlayingBlock() {
        TAPFile.prototype.catchPlayingBlock.call(this);
    }

    /* Where a loader starting at the tape's current position can still
     * catch `block`: before its pilot tone ends for a block that has one,
     * otherwise only before it starts. */
    catchUntilMs(block, index) {
        const startMs = this.blockStartMs[index];
        let toneMs = 0;
        if (block.type === 'StandardSpeedData') toneMs = pilotMs(block.data);
        else if (block.type === 'TurboSpeedData') toneMs = (block.pilotPulseLength * block.pilotPulseCount) / TSTATES_PER_MS;
        return (toneMs > CATCH_MARGIN_MS) ? (startMs + toneMs - CATCH_MARGIN_MS) : startMs;
    }

    /* Winds the tape to `ms` from its start, as TAPFile.seekToMs does. */
    seekToMs(ms) {
        const index = this.blocks.findIndex((block, i) => ms <= this.catchUntilMs(block, i));
        if (index < 0) {
            this.nextBlockIndex = this.blocks.length;
            this.loopToBlockIndex = undefined;
            this.repeatCount = undefined;
            this.callStack = [];
            this.pilotSkipTstates = 0;
            this.pulseGenerator.reset();
            return;
        }
        this.seekToBlock(index);
        const startMs = this.blockStartMs[index];
        if (ms < startMs) {
            this.pulseGenerator.addSegment(new SilenceSegment((startMs - ms) * TSTATES_PER_MS));
        } else {
            this.pilotSkipTstates = (ms - startMs) * TSTATES_PER_MS;
        }
    }

    getNextMeaningfulBlock(wrapAtEnd) {
        let startedAtZero = (this.nextBlockIndex === 0);
        while (true) {
            if (this.nextBlockIndex >= this.blocks.length) {
                if (startedAtZero || !wrapAtEnd) return null; /* have looped around; quit now */
                this.nextBlockIndex = 0;
                startedAtZero = true;
            }
            var block = this.blocks[this.nextBlockIndex];
            switch (block.type) {
                case 'StandardSpeedData':
                case 'TurboSpeedData':
                case 'PureTone':
                case 'PulseSequence':
                case 'PureData':
                case 'DirectRecording':
                case 'Pause':
                    /* found a meaningful block */
                    this.nextBlockIndex++;
                    return block;
                case 'JumpToBlock':
                    this.nextBlockIndex += block.offset;
                    break;
                case 'LoopStart':
                    this.loopToBlockIndex = this.nextBlockIndex + 1;
                    this.repeatCount = block.repeatCount;
                    this.nextBlockIndex++;
                    break;
                case 'LoopEnd':
                    this.repeatCount--;
                    if (this.repeatCount > 0) {
                        this.nextBlockIndex = this.loopToBlockIndex;
                    } else {
                        this.nextBlockIndex++;
                    }
                    break;
                case 'CallSequence':
                    /* push the future destinations (where to go on reaching a ReturnFromSequence block)
                        onto the call stack in reverse order, starting with the block immediately
                        after the CallSequence (which we go to when leaving the sequence) */
                    this.callStack.unshift(this.nextBlockIndex+1);
                    for (var i = block.offsets.length - 1; i >= 0; i--) {
                        this.callStack.unshift(this.nextBlockIndex + block.offsets[i]);
                    }
                    /* now visit the first destination on the list */
                    this.nextBlockIndex = this.callStack.shift();
                    break;
                case 'ReturnFromSequence':
                    this.nextBlockIndex = this.callStack.shift();
                    break;
                default:
                    /* not one of the types we care about; skip past it */
                    this.nextBlockIndex++;
            }
        }
    }

    /* Reads on to the end of the tape and, where the tape goes round, once
     * more from its start, so a tape with nothing loadable on it gives null. */
    getNextLoadableBlock() {
        this.pilotSkipTstates = 0;  // see TAPFile
        let mayWrap = this.wrap && (this.nextBlockIndex > 0);
        while (true) {
            const block = this.getNextMeaningfulBlock(false);
            if (block) {
                if (block.type == 'StandardSpeedData' || block.type == 'TurboSpeedData') return block.data;
            } else {
                if (!mayWrap) return null;
                this.nextBlockIndex = 0;
                mayWrap = false;
            }
        }
    }
};


/* A cassette in the tape recorder (see runtime/cassette.js): standard-speed
 * blocks and sound recordings at their places along the tape, with blank
 * tape between them, that SAVE and the machine's sound record onto. It fills
 * the worker's tape slot as TAPFile and TZXFile do, but never goes round
 * again: a loader reads onwards from wherever the tape is, and finds nothing
 * past the last block. A sound recording plays but is never loaded. */
// A block at its place on a cassette, with where it ends worked out once.
const placed = (block) => ({ ...block, endMs: blockEndMs(block) });

/* What is left of the sound recording `block` once fromMs to toMs is
 * wiped: the pieces either side, each kept only if it still has sound in
 * it, since one without is as good as blank tape. */
function soundLeft(block, fromMs, toMs) {
    const sound = block.sound;
    const sampleMs = sound.tstatesPerSample / TSTATES_PER_MS;
    const pieces = [];
    const beforeEnd = Math.min(sound.count, Math.floor((fromMs - block.startMs) / sampleMs));
    if (beforeEnd > 0) pieces.push({ startMs: block.startMs, sound: soundSlice(sound, 0, beforeEnd) });
    const afterStart = Math.max(0, Math.ceil((toMs - block.startMs) / sampleMs));
    if (afterStart < sound.count) {
        pieces.push({ startMs: block.startMs + (afterStart * sampleMs), sound: soundSlice(sound, afterStart, sound.count) });
    }
    return pieces.filter(piece => soundChanges(piece.sound)).map(placed);
}

export class CassetteTape {
    constructor(data, opts) {
        opts = opts || {};
        this.isCassette = true;
        this.blocks = parseCassetteFile(data).blocks.map(placed);  // [{startMs, data or sound, endMs}]
        this.lengthMs = CASSETTE_MS;
        this.writeProtect = !!opts.writeProtect;
        this.wrap = false;
        this.nextBlockIndex = 0;
        this.cursorMs = 0;         // how far along the tape the pulse generator has got
        this.lastLoadedEndMs = 0;  // where the block getNextLoadableBlock last returned ends
        this.pulseGenerator = new PulseGenerator((generator) => this.generatePulses(generator));
        this.buildTimeline();
    }

    /* The parts on the tape (see describeParts) as the counter's segments,
     * and the timings the worker reads, rebuilt whenever the tape changes. */
    buildTimeline() {
        this.blocks.sort((a, b) => a.startMs - b.startMs);
        this.segments = describeParts(this.blocks).map((part) => {
            const durationMs = part.endMs - part.startMs;
            const size = part.sound ? (Math.max(1, Math.round(durationMs / 1000)) + ' s')
                : ((part.length < 1024) ? (part.length + 'B') : (Math.round(part.length / 1024) + 'K'));
            return {
                ...part,
                durationMs,
                label: (part.name || part.typeName) + '  @' + counterText(part.startMs)
                    + '  (' + (part.sound ? '' : (part.typeName + ', ')) + size + (part.damaged ? ', damaged' : '') + ')',
            };
        });
        this.blockStartMs = this.blocks.map(block => block.startMs);
        this.totalMs = this.lengthMs;
        this.totalBytes = this.blocks.reduce((total, block) => total + (block.data ? block.data.length : 0), 0);
        this.blankFromMs = blankFromMs(this.blocks);
    }

    // The first block a loader starting at `ms` can still catch, or -1: a sound recording is never one.
    blockAheadIndex(ms) {
        return this.blocks.findIndex(block => !block.sound && (ms <= catchUntilMs(block)));
    }

    seekToMs(ms) {
        this.cursorMs = Math.max(0, Math.min(ms, this.lengthMs));
        const index = this.blockAheadIndex(this.cursorMs);
        this.nextBlockIndex = (index < 0) ? this.blocks.length : index;
        this.pulseGenerator.reset();
    }

    seekToBlock(index) {
        if (index >= 0 && index < this.blocks.length) this.seekToMs(this.blocks[index].startMs);
    }

    /* Queues the tape from cursorMs on, a stretch at a time: blank tape up to
     * the next block, then the block, from part way through its pilot tone
     * if the tape starts there. A block whose tone has gone by can no longer
     * be read, so the rest of it plays as blank tape. A sound recording plays
     * from wherever the tape is in it. */
    generatePulses(generator) {
        if (this.cursorMs >= this.lengthMs) return false;
        const index = this.blocks.findIndex(block => this.cursorMs < block.endMs);
        if (index < 0) {
            generator.addSegment(new SilenceSegment((this.lengthMs - this.cursorMs) * TSTATES_PER_MS));
            this.cursorMs = this.lengthMs;
            this.nextBlockIndex = this.blocks.length;
            return false;
        }
        const block = this.blocks[index];
        const endMs = block.endMs;
        if (this.cursorMs < block.startMs) {
            generator.addSegment(new SilenceSegment((block.startMs - this.cursorMs) * TSTATES_PER_MS));
            this.cursorMs = block.startMs;
            return true;
        }
        if (block.sound) {
            const sampleMs = block.sound.tstatesPerSample / TSTATES_PER_MS;
            generator.addSegment(new SoundSegment(block.sound, Math.floor((this.cursorMs - block.startMs) / sampleMs)));
        } else if (this.cursorMs <= catchUntilMs(block)) {
            const intoTstates = (this.cursorMs - block.startMs) * TSTATES_PER_MS;
            generator.addSegment(new ToneSegment(2168, Math.max(1, pilotPulses(block.data) - Math.floor(intoTstates / 2168))));
            generator.addSegment(new PulseSequenceSegment([667, 735]));
            generator.addSegment(new DataSegment(block.data, 855, 1710, 8));
            this.nextBlockIndex = index + 1;
        } else {
            generator.addSegment(new SilenceSegment((endMs - this.cursorMs) * TSTATES_PER_MS));
        }
        this.cursorMs = endMs;
        return true;
    }

    /* The block a loader starting at `positionMs` reads next, or null when
     * there is nothing more on the tape; lastLoadedEndMs is then where the
     * block ends. */
    getNextLoadableBlock(positionMs) {
        const index = this.blockAheadIndex(positionMs);
        if (index < 0) return null;
        const block = this.blocks[index];
        this.nextBlockIndex = index + 1;
        this.lastLoadedEndMs = block.endMs;
        return block.data;
    }

    /* Wipes the tape from fromMs to toMs: every block with any of its length
     * there goes, since what is left of it can't be read, but a sound
     * recording only loses that stretch (see soundLeft). A block only
     * touching the range, to within TAPE_TOLERANCE_MS, stays. Returns the
     * blocks wiped or cut. */
    erase(fromMs, toMs) {
        if (toMs <= fromMs) return [];
        const erased = [];
        const kept = [];
        for (const block of this.blocks) {
            const overlaps = (block.startMs < (toMs - TAPE_TOLERANCE_MS)) && (block.endMs > (fromMs + TAPE_TOLERANCE_MS));
            if (!overlaps) {
                kept.push(block);
                continue;
            }
            erased.push(block);
            if (block.sound) kept.push(...soundLeft(block, fromMs, toMs));
        }
        if (erased.length) {
            this.blocks = kept;
            this.buildTimeline();
        }
        return erased;
    }

    // Puts a block recorded at startMs onto (already blank) tape.
    insertRecorded(startMs, data) {
        this.blocks.push(placed({ startMs, data }));
        this.buildTimeline();
    }

    /* Puts the sound recording `sound` at startMs onto (already blank) tape,
     * in place of `replacing`, if given: a shorter take of the same recording,
     * put there while it was still going. Returns the block. */
    putSound(startMs, sound, replacing) {
        if (replacing) this.blocks = this.blocks.filter(block => block !== replacing);
        const block = placed({ startMs, sound });
        this.blocks.push(block);
        this.buildTimeline();
        return block;
    }

    /* Records `data` at startMs in one go, over whatever was there, cut
     * short where the tape runs out. Returns {endMs, erased, written}, where
     * `written` is whether all of it fitted. */
    record(startMs, data) {
        const fits = (startMs + blockMs(data)) <= this.lengthMs;
        const keep = fits ? data.length : bytesThatFit(data, this.lengthMs - startMs);
        const endMs = fits ? (startMs + blockMs(data)) : this.lengthMs;
        const erased = this.erase(startMs, endMs);
        if (keep) this.insertRecorded(startMs, data.subarray(0, keep));
        return { endMs, erased, written: fits };
    }

    snapshotBlocks() {
        return this.blocks.slice();
    }

    restoreBlocks(blocks) {
        this.blocks = blocks.slice();
        this.buildTimeline();
    }

    toTZX() {
        return writeCassetteTZX({ blocks: this.blocks });
    }
}

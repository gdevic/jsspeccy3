/* T-states per millisecond at the 3.5 MHz Spectrum clock (a PauseSegment of N ms
 * emits N*3500 t-states — see PauseSegment.getNextPulseLength below). */
const TSTATES_PER_MS = 3500;

/* A pause at least this long (ms) after a block ends the current tape "segment"
 * (a loadable portion of the game): segments are split at the silences between
 * blocks. Tunable. */
const SEGMENT_PAUSE_MS = 500;

/* Popcount lookup, used to total the 1-bits of a data block so we can compute a
 * block's exact play duration without walking every bit individually. */
const BIT_COUNTS = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    BIT_COUNTS[i] = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1)
        + ((i >> 4) & 1) + ((i >> 5) & 1) + ((i >> 6) & 1) + ((i >> 7) & 1);
}

/* Exact t-states to play a data block: each bit is two pulses of its (zero/one)
 * length, and only the top `lastByteBits` bits of the final byte are emitted. */
function dataBlockTstates(data, lastByteBits, zeroLen, oneLen) {
    if (data.length === 0) return 0;
    let ones = 0;
    for (let i = 0; i < data.length - 1; i++) ones += BIT_COUNTS[data[i]];
    const last = data[data.length - 1];
    for (let b = 0; b < lastByteBits; b++) {
        if (last & (0x80 >> b)) ones++;
    }
    const totalBits = (data.length - 1) * 8 + lastByteBits;
    const zeros = totalBits - ones;
    return 2 * (ones * oneLen + zeros * zeroLen);
}

/* Read the 10-character program name out of a standard-speed header block
 * (flag byte 0x00, 19 bytes: flag, type, 10-char name, ...). Returns '' if the
 * block is not a header. Gives segments human labels like "ELITE" / "ManicMine". */
function headerName(data) {
    if (!data || data.length < 12 || (data[0] & 0x80)) return '';
    let name = '';
    for (let i = 2; i < 12; i++) name += String.fromCharCode(data[i]);
    return name.replace(/[^\x20-\x7e]/g, ' ').trim();
}

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

        this.pulseGenerator = new PulseGenerator((generator) => {
            if (this.blocks.length === 0) return false;
            const block = this.blocks[this.nextBlockIndex];
            this.nextBlockIndex = (this.nextBlockIndex + 1) % this.blocks.length;

            if (block[0] & 0x80) {
                // add short leader tone for data block
                generator.addSegment(new ToneSegment(2168, 3223));
            } else {
                // add long leader tone for header block
                generator.addSegment(new ToneSegment(2168, 8063));
            }
            generator.addSegment(new PulseSequenceSegment([667, 735]));
            generator.addSegment(new DataSegment(block, 855, 1710, 8));
            generator.addSegment(new PauseSegment(1000));

            // return false if tape has ended
            return this.nextBlockIndex != 0;
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
        this.pulseGenerator.reset();
    }

    getNextLoadableBlock() {
        if (this.blocks.length === 0) return null;
        const block = this.blocks[this.nextBlockIndex];
        this.nextBlockIndex = (this.nextBlockIndex + 1) % this.blocks.length;
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
                            'generatePulses': (generator) => {
                                if (blockData[0] & 0x80) {
                                    // add short leader tone for data block
                                    generator.addSegment(new ToneSegment(2168, 3223));
                                } else {
                                    // add long leader tone for header block
                                    generator.addSegment(new ToneSegment(2168, 8063));
                                }
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
                            'generatePulses': (generator) => {
                                generator.addSegment(new ToneSegment(pilotPulseLength, pilotPulseCount));
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
                        this.blocks.push({
                            'type': 'DirectRecording',
                            'tstatesPerSample': tstatesPerSample,
                            'lastByteMask': lastByteMask,
                            'pause': pause,
                            'data': new Uint8Array(data, offset, dataLength)
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

        this.pulseGenerator = new PulseGenerator((generator) => {
            const block = this.getNextMeaningfulBlock(false);
            if (!block) return false;
            block.generatePulses(generator);
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
        this.pulseGenerator.reset();
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

    getNextLoadableBlock() {
        while (true) {
            var block = this.getNextMeaningfulBlock(true);
            if (!block) return null;
            if (block.type == 'StandardSpeedData' || block.type == 'TurboSpeedData') {
                return block.data;
            }
            /* FIXME: avoid infinite loop if the TZX file consists only of meaningful but non-loadable blocks */
        }
    }
};

import pako from 'pako';

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
 * catches the block (see getNextLoadableBlock). */
const CATCH_MARGIN_MS = 100;

/* A position this close (ms) before a block's start counts as at it. A
 * block starts at a whole number of T-states, but a position comes back
 * from the counter through a multiplication and a division and can land a
 * hair before the start it was wound to; without this it would fall in the
 * block before, at its very end. 35 T-states, far below anything audible. */
const SEEK_EPSILON_MS = 0.01;

/* How many TZX control blocks (jumps, loops, calls, and blocks that do not
 * play) are followed in a row before the tape is taken to go round them for
 * ever; a loop of 65535 repeats over a few such blocks stays well within it. */
const MAX_CONTROL_STEPS = 1 << 20;

/* How many blocks a TZX timeline lays out at most, a loop's repeats
 * included. */
const MAX_TIMELINE_ENTRIES = 1 << 20;

/* How many places a TZX call stack holds at most. Calls that never return
 * would pile up without end, and each place in the timeline keeps a copy of
 * the stack, so a call that would take it past this ends the tape; a real
 * tape calls a handful of sequences, one call at a time. */
const MAX_CALL_STACK = 1024;

// Where the walk through a TZX file's blocks starts (see TZXFile.controlState).
const START_STATE = Object.freeze({ index: 0, loopTo: undefined, repeats: undefined, calls: [] });

/* TZX blocks carrying a signal the tape trap can't read but a loader may: a
 * block the ROM loads can be kept as pure data after a tone and pulses, and
 * perhaps a signal level (LEAD_IN_BLOCK_TYPES), or as a recording of its
 * sound. */
const REAL_TIME_BLOCK_TYPES = new Set(['PureData', 'DirectRecording', 'CSWRecording', 'GeneralizedData']);
const LEAD_IN_BLOCK_TYPES = new Set(['PureTone', 'PulseSequence', 'SetSignalLevel']);

function msToString(ms) {
    const secs = Math.round(ms / 1000);
    return Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2);
}

/* Group a flat list of {index, tstates, bytes, name, pauseAfterMs, loadable,
 * endsPart} timed blocks into segments, breaking after any block whose
 * trailing pause is at least SEGMENT_PAUSE_MS, and at a block with endsPart,
 * which joins no segment. Returns {segments, totalMs, totalBytes}. */
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
        const startMs = totalTstates / TSTATES_PER_MS;
        // a block the tape plays more than once starts where it is first played
        if (blockStartMs[b.index] === undefined) blockStartMs[b.index] = startMs;
        if (b.endsPart) {
            closeSegment();
            continue;
        }
        totalTstates += b.tstates;
        totalBytes += b.bytes;
        if (!cur) {
            cur = {
                index: b.index,           // block to seek to when this segment is chosen
                startMs,
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

/* How many bits of a TZX data block's last byte are used: the TZX spec allows
 * 1 to 8, and 8 stands in for anything else. */
const lastBits = (lastByteBits) => (((lastByteBits >= 1) && (lastByteBits <= 8)) ? lastByteBits : 8);

// How many bits a TZX data block of `length` bytes holds.
const dataBitCount = (length, lastByteBits) => (length ? (((length - 1) * 8) + lastBits(lastByteBits)) : 0);

class DataSegment {
    constructor(data, zeroPulseLength, onePulseLength, lastByteBits) {
        this.data = data;
        this.zeroPulseLength = zeroPulseLength;
        this.onePulseLength = onePulseLength;
        this.bitCount = dataBitCount(data.length, lastByteBits);
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

/* The level a pulse starts at, for a segment that says (TZX 0x19 symbol
 * flags): an edge, no edge, or a forced level. */
const EDGE = 0;
const SAME_LEVEL = 1;
const LOW = 2;
const HIGH = 3;

/* Pulses from `pulses`, an iterator of {length, polarity}; a pulse of length
 * 0 only sets the level, as TZX block 0x2B does. */
class LevelledPulseSegment {
    constructor(pulses) {
        this.pulses = pulses;
        this.next = pulses.next();
    }
    isFinished() {
        return this.next.done;
    }
    nextPulseLevel(level) {
        switch (this.next.value.polarity) {
            case SAME_LEVEL: return level;
            case LOW: return 0x0000;
            case HIGH: return 0x8000;
            default: return level ^ 0x8000;
        }
    }
    getNextPulseLength() {
        const length = this.next.value.length;
        this.next = this.pulses.next();
        return length;
    }
}

/* Stops the tape when it reaches the head: always, or with `onlyIn48KMode`
 * only on a 48K machine or a 128K locked into 48K mode (TZX 0x20 of 0 and
 * 0x2A). */
class StopSegment {
    constructor(onlyIn48KMode) {
        this.onlyIn48KMode = onlyIn48KMode;
    }
    isFinished() {
        return false;
    }
    stopsTape(in48KMode) {
        return !this.onlyIn48KMode || in48KMode;
    }
}

/* The pulse lengths in T-states of a TZX 0x18 block's CSW data at `rate`
 * samples a second: RLE, or with `compression` 2 zlib-packed RLE, where a
 * byte of 1-255 is a pulse that many samples long and a 0 byte is followed by
 * a 4-byte length. */
function decodeCSW(bytes, rate, compression) {
    if (!rate) throw new RangeError('CSW block with a sample rate of 0');
    if ((compression !== 1) && (compression !== 2)) throw new RangeError('CSW block with unknown compression ' + compression);
    const rle = (compression === 2) ? pako.inflate(bytes) : bytes;
    const view = new DataView(rle.buffer, rle.byteOffset, rle.byteLength);
    const lengths = [];
    let samples = 0;
    let tstates = 0;
    for (let i = 0; i < rle.length;) {
        const run = rle[i++];
        if (run) {
            samples += run;
        } else {
            samples += view.getUint32(i, true);
            i += 4;
        }
        // timed from the start of the block, so rounding never adds up
        const end = Math.round((samples * TSTATES_PER_MS * 1000) / rate);
        lengths.push(end - tstates);
        tstates = end;
    }
    return { lengths, tstates };
}

/* A TZX 0x19 block's body: a pilot and sync stream of symbols, each with a
 * repeat count, then a data stream of symbols packed into as few bits as its
 * alphabet needs. A symbol is up to a set number of pulses, cut short by one
 * of length 0, and its flags say how its first pulse starts. Returns the
 * pause after it, the bytes of its data stream, its length in T-states and
 * a function giving its pulses afresh. */
function parseGeneralizedData(body) {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let p = 0;
    const pause = view.getUint16(p, true); p += 2;
    const pilotCount = view.getUint32(p, true); p += 4;
    const pilotMaxPulses = view.getUint8(p++);
    const pilotAlphabet = view.getUint8(p++) || 256;
    const dataCount = view.getUint32(p, true); p += 4;
    const dataMaxPulses = view.getUint8(p++);
    const dataAlphabet = view.getUint8(p++) || 256;

    const readSymbols = (count, maxPulses) => {
        const symbols = [];
        for (let i = 0; i < count; i++) {
            const polarity = view.getUint8(p++) & 0x03;
            const lengths = [];
            let cut = false;
            for (let j = 0; j < maxPulses; j++) {
                const length = view.getUint16(p, true); p += 2;
                if (!length) cut = true;
                if (!cut) lengths.push(length);
            }
            symbols.push({ polarity, lengths });
        }
        return symbols;
    };

    let pilotSymbols = [];
    const pilotStream = [];
    if (pilotCount) {
        pilotSymbols = readSymbols(pilotAlphabet, pilotMaxPulses);
        for (let i = 0; i < pilotCount; i++) {
            pilotStream.push({ symbol: view.getUint8(p), repeats: view.getUint16(p + 1, true) });
            p += 3;
        }
    }
    let dataSymbols = [];
    let bitsPerSymbol = 0;
    let dataStream = new Uint8Array(0);
    if (dataCount) {
        dataSymbols = readSymbols(dataAlphabet, dataMaxPulses);
        bitsPerSymbol = Math.ceil(Math.log2(dataAlphabet));
        const length = Math.ceil((bitsPerSymbol * dataCount) / 8);
        if ((p + length) > body.length) throw new RangeError('Generalized data block is cut short');
        dataStream = body.subarray(p, p + length);
    }

    const symbolAt = (symbols, index) => {
        if (index >= symbols.length) throw new RangeError('Generalized data block uses an undefined symbol');
        return symbols[index];
    };
    // a symbol with no pulses can still force the level
    function* symbolPulses(symbol) {
        if (!symbol.lengths.length && (symbol.polarity >= LOW)) yield { length: 0, polarity: symbol.polarity };
        for (let i = 0; i < symbol.lengths.length; i++) {
            yield { length: symbol.lengths[i], polarity: i ? EDGE : symbol.polarity };
        }
    }
    function* pulses() {
        for (const { symbol, repeats } of pilotStream) {
            const s = symbolAt(pilotSymbols, symbol);
            for (let r = 0; r < repeats; r++) yield* symbolPulses(s);
        }
        for (let i = 0; i < dataCount; i++) {
            let index = 0;
            for (let b = 0; b < bitsPerSymbol; b++) {
                const bit = (i * bitsPerSymbol) + b;
                index = (index << 1) | ((dataStream[bit >> 3] >> (7 - (bit & 7))) & 1);
            }
            yield* symbolPulses(symbolAt(dataSymbols, index));
        }
    }

    // played through once here, which also turns away a block with undefined symbols
    let tstates = 0;
    for (const pulse of pulses()) tstates += pulse.length;
    return { pause, bytes: dataStream.length, tstates, pulses };
}

/* A sound recording (see runtime/cassette.js) from sample `fromSample` on:
 * each run of samples at one level is a pulse, at that level, since a sample
 * is the level itself rather than a change of it. */
class SoundSegment {
    constructor(sound, fromSample) {
        this.sound = sound;
        this.index = fromSample;
    }
    isFinished() {
        return this.index >= this.sound.count;
    }
    nextPulseLevel() {
        return soundLevel(this.sound, this.index) ? 0x8000 : 0x0000;
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
        /* T-states of the queued signal already past the head, after a seek
         * into the middle of it: eaten from the front of the pulses as they
         * come, so playing starts with what is under the head, the level as
         * it would be there. */
        this.skipTstates = 0;
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
        this.skipTstates = 0;
    }
    /* True once every pulse up to the end of the tape has been emitted. */
    isAtEnd() {
        return this.tapeIsFinished && this.segments.length === 0 && this.pendingCycles === 0;
    }
    /* Fills `buffer` from `startIndex` with up to `cycleCount` T-states of
     * pulses. Returns the next free index, the T-states emitted, and whether
     * the tape stopped: at its end, or at a block that stops it, where
     * `in48KMode` says whether one that stops only in 48K mode does. */
    emitPulses(buffer, startIndex, cycleCount, in48KMode) {
        let cyclesEmitted = 0;
        let index = startIndex;
        let stopped = false;
        // whether nothing has played since getSegments was last called, which getSegments is told
        let idle = false;
        // Stops short of the time asked for once the buffer is full; the rest waits for the next call.
        while ((cyclesEmitted < cycleCount) && (index < buffer.length)) {
            if (this.pendingCycles > 0) {
                idle = false;
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
                    stopped = true;
                    break;
                } else {
                    // get more segments
                    this.tapeIsFinished = !this.getSegments(this, idle);
                    idle = true;
                }
            } else if (this.segments[0].isFinished()) {
                // discard finished segment
                this.segments.shift();
            } else if (this.segments[0].stopsTape) {
                if (this.segments.shift().stopsTape(in48KMode)) {
                    stopped = true;
                    break;
                }
            } else {
                // new pulse
                const segment = this.segments[0];
                const level = segment.nextPulseLevel ? segment.nextPulseLevel(this.level) : (this.level ^ 0x8000);
                this.pendingCycles = segment.getNextPulseLength();
                this.level = level;
                if (this.skipTstates > 0) {
                    /* Part of the signal already past the head goes unheard: a
                     * whole pulse, or the start of the one the head is in. The
                     * tape has moved, so getSegments is not told nothing played. */
                    const cut = Math.min(this.pendingCycles, this.skipTstates);
                    this.pendingCycles -= cut;
                    this.skipTstates -= cut;
                    idle = false;
                }
            }
        }
        return [index, cyclesEmitted, stopped];
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
         * does for the toolbar's player, where it stops at the end and Play
         * or a loader starts it again from the beginning; in the tape
         * recorder it stops at the end, like a real one. */
        this.wrap = true;
        this.lastLoadedEndMs = 0;  // see getNextLoadableBlock

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

    /* Rewind/fast-forward so the next block played or loaded is `index`,
     * from its start. */
    seekToBlock(index) {
        if (index < 0 || index >= this.blocks.length) return;
        this.nextBlockIndex = index;
        this.pulseGenerator.reset();
    }

    /* Queues the pilot tone of block `index`, remembered for catchPlayingBlock. */
    queuePilot(generator, index, length, count) {
        this.pilot = new ToneSegment(length, count);
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

    /* Winds the tape to `ms` from its start: the block under the head plays
     * from that very point, whatever of it has gone past, as a real tape
     * does. Past the last block, the tape is parked at its end. */
    seekToMs(ms) {
        if ((this.blocks.length === 0) || (ms >= this.totalMs)) {
            this.nextBlockIndex = this.blocks.length;
            this.pulseGenerator.reset();
            return;
        }
        let index = 0;
        while (((index + 1) < this.blocks.length) && (this.blockStartMs[index + 1] <= (ms + SEEK_EPSILON_MS))) index++;
        this.seekToBlock(index);
        this.pulseGenerator.skipTstates = Math.max(0, Math.round((ms - this.blockStartMs[index]) * TSTATES_PER_MS));
    }

    // Where on the timeline the next block to play starts; null past the last one.
    nextBlockStartMs() {
        return (this.nextBlockIndex < this.blocks.length) ? this.blockStartMs[this.nextBlockIndex] : null;
    }

    /* The block a loader reads next, going round to the first where the tape
     * does; lastLoadedEndMs is then where on the timeline it ends. With the
     * tape standing still at `fromMs`, that is the first block from the head
     * on whose pilot tone a loader can still catch: one the head is past the
     * tone of would only be heard as noise, and is left behind. Playing, the
     * head is where the pulses queued so far have got to (see
     * catchPlayingBlock), and `fromMs` is null. */
    getNextLoadableBlock(fromMs) {
        if (this.blocks.length === 0) return null;
        if (this.nextBlockIndex >= this.blocks.length) {
            if (!this.wrap) return null;
            this.nextBlockIndex = 0;
        } else if (fromMs !== null) {
            while ((this.nextBlockIndex < this.blocks.length) && (fromMs > this.catchUntilMs(this.nextBlockIndex))) this.nextBlockIndex++;
            if (this.nextBlockIndex >= this.blocks.length) return null;
        }
        const index = this.nextBlockIndex;
        this.lastLoadedEndMs = ((index + 1) < this.blocks.length) ? this.blockStartMs[index + 1] : this.totalMs;
        this.nextBlockIndex = this.wrap ? ((index + 1) % this.blocks.length) : (index + 1);
        return this.blocks[index];
    }

    // The last position from which a loader still catches block `index`: a moment before its pilot tone ends.
    catchUntilMs(index) {
        return this.blockStartMs[index] + pilotMs(this.blocks[index]) - CATCH_MARGIN_MS;
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
        // the signature and the version, 10 bytes, come before any block
        if (data.byteLength < 10) return false;
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
                        const count = dataBitCount(dataLength, lastByteMask);
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
                case 0x18:
                    (() => {
                        const blockLength = tzx.getUint32(offset, true);
                        const body = new DataView(data, offset + 4, blockLength);
                        offset += 4 + blockLength;
                        const pause = body.getUint16(0, true);
                        const rate = body.getUint16(2, true) | (body.getUint8(4) << 16);
                        const csw = new Uint8Array(data, body.byteOffset + 10, blockLength - 10);
                        const { lengths, tstates } = decodeCSW(csw, rate, body.getUint8(5));
                        this.blocks.push({
                            'type': 'CSWRecording',
                            'pause': pause,
                            'tstates': tstates,
                            'bytes': csw.length,
                            'generatePulses': (generator) => {
                                generator.addSegment(new PulseSequenceSegment(lengths));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                    })();
                    break;
                case 0x19:
                    (() => {
                        const blockLength = tzx.getUint32(offset, true);
                        const { pause, bytes, tstates, pulses } = parseGeneralizedData(new Uint8Array(data, offset + 4, blockLength));
                        offset += 4 + blockLength;
                        this.blocks.push({
                            'type': 'GeneralizedData',
                            'pause': pause,
                            'tstates': tstates,
                            'bytes': bytes,
                            'generatePulses': (generator) => {
                                generator.addSegment(new LevelledPulseSegment(pulses()));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                    })();
                    break;
                case 0x20:
                    (() => {
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        if (pause) {
                            this.blocks.push({
                                'type': 'Pause',
                                'pause': pause,
                                'generatePulses': (generator) => {
                                    generator.addSegment(new PauseSegment(pause));
                                }
                            });
                        } else {
                            // a pause of 0 stops the tape
                            this.blocks.push({
                                'type': 'Stop',
                                'generatePulses': (generator) => {
                                    generator.addSegment(new StopSegment(false));
                                }
                            });
                        }
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
                        const jumpOffset = tzx.getInt16(offset, true); offset += 2;
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
                            offsets[i] = tzx.getInt16(offset + i*2, true);
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
                case 0x2A:
                    (() => {
                        offset += 4 + tzx.getUint32(offset, true);
                        this.blocks.push({
                            'type': 'StopIf48K',
                            'generatePulses': (generator) => {
                                generator.addSegment(new StopSegment(true));
                            }
                        });
                    })();
                    break;
                case 0x2B:
                    (() => {
                        const level = tzx.getUint8(offset + 4);
                        offset += 4 + tzx.getUint32(offset, true);
                        this.blocks.push({
                            'type': 'SetSignalLevel',
                            'level': level,
                            'generatePulses': (generator) => {
                                generator.addSegment(new LevelledPulseSegment([{ length: 0, polarity: level ? HIGH : LOW }].values()));
                            }
                        });
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
                case 0x34:
                    // emulation info, 8 bytes, not used
                    offset += 8;
                    this.blocks.push({ 'type': 'EmulationInfo' });
                    break;
                case 0x40:
                    // a snapshot: its type, then a 3-byte length; not used
                    offset += 4 + (tzx.getUint16(offset + 1, true) | (tzx.getUint8(offset + 3) << 16));
                    this.blocks.push({ 'type': 'Snapshot' });
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
        this.lastLoadedEndMs = 0;  // see getNextLoadableBlock

        /* Where the walk has stood since the tape last played for any time. A
         * walk that comes back to one of them goes round blocks that take no
         * time for ever, so the tape ends there. */
        const idleStates = new Set();
        this.pulseGenerator = new PulseGenerator((generator, idle) => {
            if (!idle) idleStates.clear();
            const block = this.getNextMeaningfulBlock();
            if (!block) return false;
            const key = TZXFile.stateKey(this.controlState());
            if (idleStates.has(key)) return false;
            idleStates.add(key);
            block.generatePulses(generator, this.nextBlockIndex - 1);
            return true;
        });

        this.buildTimeline();
    }

    // Per-block timing/size for the cassette-counter UI.
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
                    + dataBlockTstates(block.data, lastBits(block.lastByteMask), block.zeroBitLength, block.oneBitLength)
                    + block.pause * TSTATES_PER_MS;
                return { tstates: t, bytes: block.data.length, name: headerName(block.data),
                    pauseAfterMs: block.pause, loadable: true };
            }
            case 'PureData': {
                const t = dataBlockTstates(block.data, lastBits(block.lastByteMask), block.zeroBitLength, block.oneBitLength)
                    + block.pause * TSTATES_PER_MS;
                return { tstates: t, bytes: block.data.length, name: '', pauseAfterMs: block.pause, loadable: true };
            }
            case 'DirectRecording': {
                const samples = dataBitCount(block.data.length, block.lastByteMask);
                const t = samples * block.tstatesPerSample + block.pause * TSTATES_PER_MS;
                return { tstates: t, bytes: block.data.length, name: '', pauseAfterMs: block.pause, loadable: true };
            }
            case 'CSWRecording':
            case 'GeneralizedData':
                return { tstates: block.tstates + block.pause * TSTATES_PER_MS, bytes: block.bytes, name: '', pauseAfterMs: block.pause, loadable: true };
            case 'Stop':
            case 'StopIf48K':
                // where the tape stops, one part of it ends
                return { tstates: 0, bytes: 0, name: '', pauseAfterMs: 0, loadable: false, endsPart: true };
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

    /* Lays the blocks out in the order the tape plays them, following its
     * jumps, loops and calls, so a block in a loop is there once for each
     * time round. Each entry of `timeline` holds where the walk stands just
     * before it, for seeking there; `endMsAfter` maps where the walk stands
     * just after a block that plays to where that block ends. A tape that
     * goes round for ever is laid out up to where it starts repeating. */
    buildTimeline() {
        const saved = this.controlState();
        this.setControlState(START_STATE);
        const timed = [];
        this.timeline = [];
        this.endMsAfter = new Map();
        this.startMsAt = new Map();  // where the walk stands just before a block that plays -> where it starts
        const seen = new Set();
        let tstates = 0;
        const add = (index, state) => {
            const info = this.blockTiming(this.blocks[index]);
            timed.push({ index, ...info });
            this.timeline.push({ index, startMs: tstates / TSTATES_PER_MS, state });
            tstates += info.tstates;
        };
        while (this.timeline.length < MAX_TIMELINE_ENTRIES) {
            const block = this.getNextMeaningfulBlock((index) => add(index, this.controlState()));
            if (!block) break;
            const after = this.controlState();
            const before = { ...after, index: after.index - 1 };
            const key = TZXFile.stateKey(before);
            // the tape plays on from here as it already has
            if (seen.has(key)) break;
            seen.add(key);
            this.startMsAt.set(key, tstates / TSTATES_PER_MS);
            add(before.index, before);
            this.endMsAfter.set(TZXFile.stateKey(after), tstates / TSTATES_PER_MS);
        }
        this.setControlState(saved);

        const t = groupSegments(timed);
        this.segments = t.segments;
        this.totalMs = t.totalMs;
        this.totalBytes = t.totalBytes;
        this.blockStartMs = t.blockStartMs;
    }

    /* Rewind/fast-forward so the next meaningful block played/loaded is
     * `index`, the first time the tape reaches it. */
    seekToBlock(index) {
        if (index < 0 || index >= this.blocks.length) return;
        const entry = this.timeline.find(e => e.index === index);
        this.setControlState(entry ? entry.state : { ...START_STATE, index });
        this.pulseGenerator.reset();
    }

    queuePilot(generator, index, length, count) {
        TAPFile.prototype.queuePilot.call(this, generator, index, length, count);
    }

    catchPlayingBlock() {
        TAPFile.prototype.catchPlayingBlock.call(this);
    }

    /* Where a loader starting at the tape's current position can still
     * catch `block`, starting at `startMs`: before its pilot tone ends for a
     * block that has one, otherwise only before it starts. */
    catchUntilMs(block, startMs) {
        let toneMs = 0;
        if (block.type === 'StandardSpeedData') toneMs = pilotMs(block.data);
        else if (block.type === 'TurboSpeedData') toneMs = (block.pilotPulseLength * block.pilotPulseCount) / TSTATES_PER_MS;
        return (toneMs > CATCH_MARGIN_MS) ? (startMs + toneMs - CATCH_MARGIN_MS) : startMs;
    }

    /* Winds the tape to `ms` from its start, as TAPFile.seekToMs does: the
     * walk stands before the block under the head, which plays from that
     * very point. A stop takes no time, so what follows it starts where it
     * does; winding to that point leaves the stop behind, or Play would stop
     * again at once. A block that plays but takes no time (a signal level)
     * standing where the block under the head starts is kept before it. */
    seekToMs(ms) {
        this.pulseGenerator.reset();
        const plays = (e) => !!this.blocks[e.index].generatePulses;
        const takesTime = (e) => this.blockTiming(this.blocks[e.index]).tstates > 0;
        const isStop = (e) => (this.blocks[e.index].type === 'Stop') || (this.blocks[e.index].type === 'StopIf48K');
        let at = -1;
        for (let i = 0; i < this.timeline.length; i++) {
            const e = this.timeline[i];
            if (e.startMs > (ms + SEEK_EPSILON_MS)) break;
            if (plays(e) && takesTime(e)) at = i;
        }
        if ((at < 0) || (ms >= this.totalMs)) {
            this.setControlState({ ...START_STATE, index: this.blocks.length });
            return;
        }
        const startMs = this.timeline[at].startMs;
        while ((at > 0) && (this.timeline[at - 1].startMs === startMs) && plays(this.timeline[at - 1])
            && !takesTime(this.timeline[at - 1]) && !isStop(this.timeline[at - 1])) at--;
        this.setControlState(this.timeline[at].state);
        this.pulseGenerator.skipTstates = Math.max(0, Math.round((ms - startMs) * TSTATES_PER_MS));
    }

    /* The next block that plays, following jumps, loops and calls on the way;
     * null at the end of the tape. A jump or call outside the tape ends it,
     * and so do control blocks that go round without ever reaching a block
     * that plays. */
    getNextMeaningfulBlock(onSkip) {
        for (let steps = 0; steps < MAX_CONTROL_STEPS; steps++) {
            if (this.nextBlockIndex < 0) break;
            if (this.nextBlockIndex >= this.blocks.length) return null;
            var block = this.blocks[this.nextBlockIndex];
            switch (block.type) {
                case 'JumpToBlock':
                    // a jump of 0 would stay put for ever, so it moves on
                    this.nextBlockIndex += (block.offset || 1);
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
                    if (this.callStack.length + block.offsets.length + 1 > MAX_CALL_STACK) {
                        // too deep: ends the tape, as a call outside it does
                        this.nextBlockIndex = -1;
                        break;
                    }
                    /* push the future destinations (where to go on reaching a ReturnFromSequence block)
                        onto the call stack in reverse order, starting with the block immediately
                        after the CallSequence (which we go to when leaving the sequence) */
                    this.callStack.push(this.nextBlockIndex+1);
                    for (var i = block.offsets.length - 1; i >= 0; i--) {
                        this.callStack.push(this.nextBlockIndex + block.offsets[i]);
                    }
                    /* now visit the first destination on the list */
                    this.nextBlockIndex = this.callStack.pop();
                    break;
                case 'ReturnFromSequence':
                    // outside a call it does nothing
                    this.nextBlockIndex = this.callStack.length ? this.callStack.pop() : (this.nextBlockIndex + 1);
                    break;
                default:
                    /* a block that plays; any other is skipped, and passed to onSkip */
                    if (block.generatePulses) {
                        this.nextBlockIndex++;
                        return block;
                    }
                    if (onSkip) onSkip(this.nextBlockIndex);
                    this.nextBlockIndex++;
            }
        }
        this.nextBlockIndex = this.blocks.length;
        this.callStack = [];
        return null;
    }

    /* Where the walk through the blocks stands: the next block to look at,
     * the loop it is in and the calls it will return from. */
    controlState() {
        return { index: this.nextBlockIndex, loopTo: this.loopToBlockIndex, repeats: this.repeatCount, calls: this.callStack.slice() };
    }

    setControlState(state) {
        this.nextBlockIndex = state.index;
        this.loopToBlockIndex = state.loopTo;
        this.repeatCount = state.repeats;
        this.callStack = state.calls.slice();
    }

    static stateKey(state) {
        return state.index + '/' + state.loopTo + '/' + state.repeats + '/' + state.calls.join(',');
    }

    /* Where on the timeline the next block to play starts, the time round
     * the tape has got to; null past the last one. */
    nextBlockStartMs() {
        const saved = this.controlState();
        let ms = null;
        if (this.getNextMeaningfulBlock()) {
            const after = this.controlState();
            ms = this.startMsAt.get(TZXFile.stateKey({ ...after, index: after.index - 1 })) ?? null;
        }
        this.setControlState(saved);
        return ms;
    }

    /* Reads on to the end of the tape and, where the tape goes round, once
     * more from its start, so a tape with nothing loadable on it gives null.
     * lastLoadedEndMs is then where on the timeline the block it returns
     * ends. A tape whose jumps go round blocks that play but never load also
     * gives null, once the walk comes back to where it has already been.
     * Pauses and stops are passed over, and so is a tone, pulses or a signal
     * level leading in to a data block. With the tape standing still at
     * `fromMs` (null while it plays, see TAPFile), a data block whose pilot
     * tone the head is past is passed over too. A block carrying a signal
     * other than a data block's (see REAL_TIME_BLOCK_TYPES) ends the walk
     * before it, or before what led in to it: the tape stays there, for the
     * loader to read in real time, and playsInRealTime is set; with the head
     * part way into a block, the walk stays where it stood, since the pulses
     * still to be skipped belong to that block. */
    getNextLoadableBlock(fromMs) {
        this.playsInRealTime = false;
        const entryState = this.controlState();
        let mayWrap = this.wrap && (this.nextBlockIndex > 0);
        let wrapped = false;
        const seen = new Set();
        let leadInFrom = null;  // where the tone and pulses just walked past began
        while (true) {
            const before = this.controlState();
            const block = this.getNextMeaningfulBlock();
            if (block) {
                const after = this.controlState();
                const key = TZXFile.stateKey(after);
                if (block.type == 'StandardSpeedData' || block.type == 'TurboSpeedData') {
                    const startMs = this.startMsAt.get(TZXFile.stateKey({ ...after, index: after.index - 1 }));
                    const passed = (fromMs !== null) && !wrapped && (startMs !== undefined) && (fromMs > this.catchUntilMs(block, startMs));
                    if (!passed) {
                        const endMs = this.endMsAfter.get(key);
                        this.lastLoadedEndMs = (endMs !== undefined) ? endMs : (this.blockStartMs[this.nextBlockIndex] ?? this.totalMs);
                        return block.data;
                    }
                    leadInFrom = null;
                } else if (REAL_TIME_BLOCK_TYPES.has(block.type)) {
                    this.setControlState((this.pulseGenerator.skipTstates > 0) ? entryState : (leadInFrom || before));
                    this.playsInRealTime = true;
                    return null;
                } else if (LEAD_IN_BLOCK_TYPES.has(block.type)) {
                    if (!leadInFrom) leadInFrom = before;
                } else {
                    leadInFrom = null;
                }
                if (seen.has(key)) return null;
                seen.add(key);
            } else {
                if (!mayWrap) return null;
                this.setControlState(START_STATE);
                mayWrap = false;
                wrapped = true;
                leadInFrom = null;
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
     * the next block, then the block, from wherever the tape is in it, tone,
     * sync or data, as a real tape plays. A sound recording likewise plays
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
        } else {
            generator.addSegment(new ToneSegment(2168, pilotPulses(block.data)));
            generator.addSegment(new PulseSequenceSegment([667, 735]));
            generator.addSegment(new DataSegment(block.data, 855, 1710, 8));
            generator.skipTstates = Math.max(0, Math.round((this.cursorMs - block.startMs) * TSTATES_PER_MS));
            this.nextBlockIndex = index + 1;
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

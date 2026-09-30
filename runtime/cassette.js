/*
 * runtime/cassette.js: cassettes for the tape recorder: timing, files and parts.
 *
 * A cassette is a length of tape, CASSETTE_MS long, holding blocks, each at
 * the place on the tape where it was recorded, with blank tape between them.
 * Most are standard-speed blocks, kept as TAP-style bytes: the flag byte, the
 * data and the parity byte ({startMs, data}). The rest are sound recordings
 * ({startMs, sound}, see below). On disk and in storage a cassette is a TZX
 * file of standard-speed and direct recording blocks whose pauses are the
 * blank tape between them, so it loads in any emulator and reads back with
 * every block where it was. There is no DOM here: the worker, the recorder
 * and saved sessions all use it.
 */

export const TSTATES_PER_MS = 3500;
export const CASSETTE_MS = 60 * 60 * 1000;  // a C60

// The ROM's tape timings, in T-states
const PILOT_PULSE = 2168;
const PILOT_HEADER = 8063;
const PILOT_DATA = 3223;
const SYNC_TSTATES = 667 + 735;
const ZERO_PULSE = 855;
const ONE_PULSE = 1710;

/* A TAP file has no gaps of its own: its blocks go onto a cassette this far
 * apart, the pause a TAP block is played with. */
const TAP_GAP_MS = 1000;

/* A loader started this close to the end of a block's pilot tone still
 * catches the block. */
const CATCH_MARGIN_MS = 100;

/* A header followed by a data block within this much blank tape is one
 * part: a SAVE writes the header, waits a second, then writes the data. */
const PART_GAP_MS = 5000;

const TZX_SIGNATURE = 'ZXTape!\x1A';
const MAX_PAUSE_MS = 65535;
const MAX_BLOCK_BYTES = 65535;
const MAX_SOUND_BYTES = 0xffffff;  // a direct recording block's length field is 24 bits

/* Popcount lookup, used to total the 1-bits of a data block so we can compute a
 * block's exact play duration without walking every bit individually. */
export const BIT_COUNTS = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    BIT_COUNTS[i] = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1)
        + ((i >> 4) & 1) + ((i >> 5) & 1) + ((i >> 6) & 1) + ((i >> 7) & 1);
}

/* Exact t-states to play a data block: each bit is two pulses of its (zero/one)
 * length, and only the top `lastByteBits` bits of the final byte are emitted. */
export function dataBlockTstates(data, lastByteBits, zeroLen, oneLen) {
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
export function headerName(data) {
    if (!data || data.length < 12 || (data[0] & 0x80)) return '';
    let name = '';
    for (let i = 2; i < 12; i++) name += String.fromCharCode(data[i]);
    return name.replace(/[^\x20-\x7e]/g, ' ').trim();
}

// The pilot tone's length in pulses: a header's is long, a data block's short.
export const pilotPulses = (data) => (data.length && (data[0] & 0x80)) ? PILOT_DATA : PILOT_HEADER;

// How long a standard-speed block takes to play, pilot tone to last bit.
export const blockTstates = (data) => (PILOT_PULSE * pilotPulses(data)) + SYNC_TSTATES + dataBlockTstates(data, 8, ZERO_PULSE, ONE_PULSE);
export const blockMs = (data) => blockTstates(data) / TSTATES_PER_MS;
export const pilotMs = (data) => (PILOT_PULSE * pilotPulses(data)) / TSTATES_PER_MS;

/* The last position on the tape from which a loader still catches `block`
 * ({startMs, data}): a moment before its pilot tone ends. */
export const catchUntilMs = (block) => block.startMs + pilotMs(block.data) - CATCH_MARGIN_MS;

/* A sound recording is what the machine played while the user held Record:
 * the MIC socket carries the speaker's signal as well as SAVE's, so a real
 * recorder puts both on the tape. It is kept as a TZX direct recording block
 * keeps it, the level at the MIC socket one bit a sample, the first in bit 7:
 * {bits, from, count, tstatesPerSample}, the `count` samples from sample
 * `from` of `bits`. Pieces of a recording cut up share its `bits`, which
 * never change under them. */
export const SOUND_TSTATES_PER_SAMPLE = 79;  // 44.3 kHz, the rate the TZX format gives for 44.1 kHz

export const soundMs = (sound) => (sound.count * sound.tstatesPerSample) / TSTATES_PER_MS;

// The level of sample `i` of `sound`.
export const soundLevel = (sound, i) => (sound.bits[(sound.from + i) >> 3] >> (7 - ((sound.from + i) & 7))) & 1;

// Samples `start` up to `end` of `sound`.
export const soundSlice = (sound, start, end) => ({ ...sound, from: sound.from + start, count: end - start });

// Whether the level changes anywhere in `sound`: a stretch where it doesn't is as good as blank tape.
export function soundChanges(sound) {
    const first = soundLevel(sound, 0);
    for (let i = 1; i < sound.count; i++) {
        if (soundLevel(sound, i) !== first) return true;
    }
    return false;
}

// The samples of `sound` packed from bit 7 of the first byte, as a direct recording block holds them.
function packSound(sound) {
    const out = new Uint8Array((sound.count + 7) >> 3);
    const first = sound.from >> 3;
    const shift = sound.from & 7;
    if (shift === 0) {
        out.set(sound.bits.subarray(first, first + out.length));
    } else {
        for (let i = 0; i < out.length; i++) {
            out[i] = (sound.bits[first + i] << shift) | ((sound.bits[first + i + 1] || 0) >> (8 - shift));
        }
    }
    const spare = (out.length * 8) - sound.count;
    if (out.length) out[out.length - 1] &= 0xff << spare;
    return out;
}

// Where a block, standard-speed or sound, ends on the tape.
export const blockEndMs = (block) => block.startMs + (block.sound ? soundMs(block.sound) : blockMs(block.data));

/* Positions on the tape are fractions of a millisecond that pass through
 * T-state counts and TZX pauses in whole milliseconds, so two that should be
 * the same can differ by a little. Within this much, blocks count as only
 * touching, and a recording counts as fitting on the tape. */
export const TAPE_TOLERANCE_MS = 1;

/* How many whole bytes of `data` made it onto the tape when recording
 * stopped `ms` after its pilot tone began. */
export function bytesThatFit(data, ms) {
    let tstates = ((ms + (TAPE_TOLERANCE_MS / 1000)) * TSTATES_PER_MS) - ((PILOT_PULSE * pilotPulses(data)) + SYNC_TSTATES);
    let count = 0;
    while (count < data.length) {
        const ones = BIT_COUNTS[data[count]];
        const byteTstates = 2 * ((ONE_PULSE * ones) + (ZERO_PULSE * (8 - ones)));
        if (tstates < byteTstates) break;
        tstates -= byteTstates;
        count++;
    }
    return count;
}

// Whether a block's parity byte matches its contents.
export function blockIsIntact(data) {
    if (data.length < 2) return false;
    let parity = 0;
    for (let i = 0; i < data.length; i++) parity ^= data[i];
    return parity === 0;
}

// The tape counter's reading at `ms`: whole seconds, four digits.
export const counterText = (ms) => String(Math.max(0, Math.floor(ms / 1000))).padStart(4, '0');

const HEADER_TYPES = ['Program', 'Number array', 'Character array', 'Bytes'];

/* The contents of a standard header block (flag 0x00, 19 bytes), or null
 * for any other block. `name` keeps any leading spaces, since LOAD matches
 * them, and drops the padding after it. */
export function parseHeader(data) {
    if (!data || data.length !== 19 || data[0] !== 0x00 || data[1] > 3) return null;
    let name = '';
    for (let i = 2; i < 12; i++) name += String.fromCharCode(data[i]);
    const header = {
        type: data[1],
        name: name.replace(/[^\x20-\x7e]/g, '?').replace(/ +$/, ''),
        length: data[12] | (data[13] << 8),
        param1: data[14] | (data[15] << 8),
        param2: data[16] | (data[17] << 8),
        arrayName: data[15],
    };
    const screen = (header.type === 3) && (header.param1 === 16384) && (header.length === 6912);
    header.typeName = screen ? 'SCREEN$' : HEADER_TYPES[header.type];
    return header;
}

/* The BASIC command that loads what `header` describes, e.g. LOAD "name" CODE.
 * A quote in the name is doubled, as BASIC needs it. */
export function loadCommand(header) {
    const name = '"' + header.name.replace(/"/g, '""') + '"';
    const letter = String.fromCharCode((header.arrayName & 0x1f) | 0x60);
    switch (header.type) {
        case 0: return 'LOAD ' + name;
        case 1: return 'LOAD ' + name + ' DATA ' + letter + '()';
        case 2: return 'LOAD ' + name + ' DATA ' + letter + '$()';
        default: return 'LOAD ' + name + ((header.typeName === 'SCREEN$') ? ' SCREEN$' : ' CODE');
    }
}

/* What is on a cassette, as parts: a header with the data block it
 * introduces, or a block standing alone. Each part is {index (its first
 * block), blockIndices, startMs, endMs, name, typeName, length (data bytes),
 * loadCommand (or null), damaged, sound}. A part is damaged when a block
 * fails its parity check, the data doesn't match its header's length, or the
 * header's data block is missing. A sound recording is a part of its own,
 * with no name and no data bytes. */
export function describeParts(blocks) {
    const parts = [];
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (block.sound) {
            parts.push({
                index: i,
                blockIndices: [i],
                startMs: block.startMs,
                endMs: blockEndMs(block),
                name: '',
                typeName: 'Sound',
                length: 0,
                loadCommand: null,
                damaged: false,
                sound: true,
            });
            continue;
        }
        const header = parseHeader(block.data);
        if (header) {
            const next = blocks[i + 1];
            const hasData = next && next.data && next.data.length && (next.data[0] !== 0x00)
                && ((next.startMs - blockEndMs(block)) <= PART_GAP_MS);
            parts.push({
                index: i,
                blockIndices: hasData ? [i, i + 1] : [i],
                startMs: block.startMs,
                endMs: hasData ? blockEndMs(next) : blockEndMs(block),
                name: header.name,
                typeName: header.typeName,
                length: header.length,
                loadCommand: loadCommand(header),
                damaged: !blockIsIntact(block.data) || !hasData
                    || !blockIsIntact(next.data) || (next.data.length !== (header.length + 2)),
            });
            if (hasData) i++;
        } else {
            parts.push({
                index: i,
                blockIndices: [i],
                startMs: block.startMs,
                endMs: blockEndMs(block),
                name: '',
                typeName: (block.data.length && (block.data[0] === 0x00)) ? 'Header' : 'Headerless',
                length: Math.max(0, block.data.length - 2),
                loadCommand: null,
                damaged: !blockIsIntact(block.data),
            });
        }
    }
    return parts;
}

// Where the blank tape after the last recording begins.
export function blankFromMs(blocks) {
    let endMs = 0;
    for (const block of blocks) endMs = Math.max(endMs, blockEndMs(block));
    return endMs;
}

/* A game tape shows in the recorder on the shortest cassette of a size once
 * sold that holds it, with some leader to spare. */
const CASSETTE_SIZES_MIN = [10, 15, 20, 30, 45, 60, 90, 120];
export function gameTapeLengthMs(totalMs) {
    const needed = totalMs + 10000;
    for (const minutes of CASSETTE_SIZES_MIN) {
        if ((minutes * 60000) >= needed) return minutes * 60000;
    }
    return needed;
}

/* ---------- reading and writing files ---------- */

function isTAP(bytes) {
    let pos = 0;
    while (pos < bytes.length) {
        if ((pos + 1) >= bytes.length) return false;
        pos += 2 + (bytes[pos] | (bytes[pos + 1] << 8));
    }
    return pos === bytes.length;
}

function isTZX(bytes) {
    if (bytes.length < 10) return false;
    for (let i = 0; i < TZX_SIGNATURE.length; i++) {
        if (bytes[i] !== TZX_SIGNATURE.charCodeAt(i)) return false;
    }
    return true;
}

const tooLong = () => new Error('This tape is longer than a cassette holds (60 minutes).');

function parseTAP(bytes) {
    const blocks = [];
    let pos = 0;
    let startMs = 0;
    while (pos < bytes.length) {
        const length = bytes[pos] | (bytes[pos + 1] << 8);
        const data = bytes.slice(pos + 2, pos + 2 + length);
        pos += 2 + length;
        if (!data.length) continue;
        blocks.push({ startMs, data });
        startMs += blockMs(data) + TAP_GAP_MS;
    }
    return { blocks, label: '' };
}

function parseTZX(bytes) {
    const damaged = () => new Error('This tape file is damaged.');
    const blocks = [];
    // What names the tape: the title in its archive info, or else its first text description.
    let title = null;
    let label = null;
    const printable = (from, to) => String.fromCharCode(...bytes.subarray(from, to)).replace(/[^\x20-\x7e]/g, ' ').trim();
    let pos = 10;
    let startMs = 0;
    const need = (count) => { if ((pos + count) > bytes.length) throw damaged(); };
    const u8 = () => { need(1); return bytes[pos++]; };
    const u16 = () => { need(2); const v = bytes[pos] | (bytes[pos + 1] << 8); pos += 2; return v; };
    const u24 = () => { need(3); const v = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16); pos += 3; return v; };
    const u32 = () => { need(4); const v = (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16)) + (bytes[pos + 3] * 0x1000000); pos += 4; return v; };
    const skip = (count) => { need(count); pos += count; };
    while (pos < bytes.length) {
        const id = u8();
        switch (id) {
            case 0x10: {
                const pause = u16();
                const length = u16();
                need(length);
                const data = bytes.slice(pos, pos + length);
                pos += length;
                if (data.length) {
                    blocks.push({ startMs, data });
                    startMs += blockMs(data);
                }
                startMs += pause;
                break;
            }
            case 0x15: {
                const tstatesPerSample = u16();
                const pause = u16();
                const lastBits = u8();
                const length = u24();
                need(length);
                const count = length ? (((length - 1) * 8) + (((lastBits >= 1) && (lastBits <= 8)) ? lastBits : 8)) : 0;
                if (count && tstatesPerSample) {
                    const sound = { bits: bytes.slice(pos, pos + length), from: 0, count, tstatesPerSample };
                    blocks.push({ startMs, sound });
                    startMs += soundMs(sound);
                }
                pos += length;
                startMs += pause;
                break;
            }
            case 0x20:
                startMs += u16();
                break;
            case 0x30: {
                const length = u8();
                need(length);
                if (label === null) label = printable(pos, pos + length);
                pos += length;
                break;
            }
            case 0x32: {                        // archive info: entries of {type, length, text}, type 0 the title
                const length = u16();
                need(length);
                const end = pos + length;
                let at = pos + 1;
                for (let i = 0; (length > 0) && (i < bytes[pos]) && ((at + 2) <= end); i++) {
                    const next = at + 2 + bytes[at + 1];
                    if ((bytes[at] === 0x00) && (title === null) && (next <= end)) title = printable(at + 2, next);
                    at = next;
                }
                pos = end;
                break;
            }
            case 0x21: skip(u8()); break;       // group start
            case 0x22: break;                   // group end
            case 0x31: skip(1); skip(u8()); break;  // message
            case 0x33: skip(u8() * 3); break;   // hardware type
            case 0x34: skip(8); break;          // emulation info
            case 0x35: skip(16); skip(u32()); break;  // custom info: a 16-character identifier, then its length
            case 0x40: skip(1); skip(u24()); break;  // snapshot: its type, then its length
            case 0x5a: skip(9); break;          // glue
            case 0x2a:                          // stop the tape if in 48K mode
            case 0x2b: skip(u32()); break;      // signal level
            default:
                throw new Error('This tape uses blocks a cassette cannot hold, such as a turbo or custom loader. Open it with File > Open instead.');
        }
    }
    return { blocks, label: title || label || '' };
}

/* Reads a .tap or .tzx file as a cassette: {blocks: [{startMs, data} or
 * {startMs, sound}], label}. Throws with a message for the user when it
 * cannot be one. */
export function parseCassetteFile(buffer) {
    const bytes = new Uint8Array(buffer);
    let cassette;
    if (isTZX(bytes)) {
        cassette = parseTZX(bytes);
    } else if (isTAP(bytes)) {
        cassette = parseTAP(bytes);
    } else {
        throw new Error('This is not a tape file (.tap or .tzx).');
    }
    if (blankFromMs(cassette.blocks) > (CASSETTE_MS + TAPE_TOLERANCE_MS)) throw tooLong();
    return cassette;
}

function textBlock(text) {
    const chars = Array.from(String(text).slice(0, 255), (c) => {
        const code = c.charCodeAt(0);
        return (code >= 0x20 && code < 0x7f) ? code : 0x3f;
    });
    return [0x30, chars.length, ...chars];
}

/* Writes a cassette as a TZX file. A standard-speed block is a standard
 * speed data block and a sound recording a direct recording block, split
 * over more than one when it is too long for a block to hold. The last block
 * of each has for its pause the blank tape up to the next one, and blank
 * tape longer than a pause can hold, or before the first block, is written as
 * pause blocks. Each gap is rounded against the position a reader will work
 * out for the block, so rounding never adds up over a long tape. `label`, if
 * given, goes in as a text description, first. */
export function writeCassetteTZX({ blocks, label }) {
    const chunks = [];
    const put = (...bytes) => chunks.push(Uint8Array.from(bytes));
    put(...Array.from(TZX_SIGNATURE, c => c.charCodeAt(0)), 1, 20);
    if (label) put(...textBlock(label));
    const pauses = (ms) => {
        while (ms > 0) {
            const pause = Math.min(ms, MAX_PAUSE_MS);
            put(0x20, pause & 0xff, pause >> 8);
            ms -= pause;
        }
    };
    const putSound = (sound, pause) => {
        const bits = packSound(sound);
        const rate = sound.tstatesPerSample;
        for (let pos = 0; pos < bits.length; pos += MAX_SOUND_BYTES) {
            const part = bits.subarray(pos, pos + MAX_SOUND_BYTES);
            const last = (pos + part.length) === bits.length;
            const used = last ? (sound.count - ((pos + part.length - 1) * 8)) : 8;
            const partPause = last ? pause : 0;
            put(0x15, rate & 0xff, rate >> 8, partPause & 0xff, partPause >> 8, used,
                part.length & 0xff, (part.length >> 8) & 0xff, part.length >> 16);
            chunks.push(part);
        }
    };
    blocks = blocks.filter(block => !block.sound || block.sound.count);
    let readerMs = blocks.length ? Math.max(0, Math.round(blocks[0].startMs)) : 0;
    pauses(readerMs);
    blocks.forEach((block, i) => {
        const data = block.sound ? null
            : ((block.data.length > MAX_BLOCK_BYTES) ? block.data.subarray(0, MAX_BLOCK_BYTES) : block.data);
        const duration = block.sound ? soundMs(block.sound) : blockMs(data);
        const next = blocks[i + 1];
        const gap = next ? Math.max(0, Math.round(next.startMs - (readerMs + duration))) : TAP_GAP_MS;
        const pause = Math.min(gap, MAX_PAUSE_MS);
        if (block.sound) {
            putSound(block.sound, pause);
        } else {
            put(0x10, pause & 0xff, pause >> 8, data.length & 0xff, data.length >> 8);
            chunks.push(data);
        }
        if (next) pauses(gap - pause);
        readerMs += duration + gap;
    });
    const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let pos = 0;
    for (const chunk of chunks) {
        out.set(chunk, pos);
        pos += chunk.length;
    }
    return out;
}

/* Writes a cassette's blocks as a TAP file, one after another. A TAP file
 * holds only data, so sound recordings are left out. */
export function writeCassetteTAP(blocks) {
    blocks = blocks.filter(block => !block.sound);
    const size = blocks.reduce((total, block) => total + 2 + Math.min(block.data.length, MAX_BLOCK_BYTES), 0);
    const out = new Uint8Array(size);
    let pos = 0;
    for (const block of blocks) {
        const data = (block.data.length > MAX_BLOCK_BYTES) ? block.data.subarray(0, MAX_BLOCK_BYTES) : block.data;
        out[pos] = data.length & 0xff;
        out[pos + 1] = data.length >> 8;
        out.set(data, pos + 2);
        pos += 2 + data.length;
    }
    return out;
}

/* The TZX file `tzx` with `label` as its text description, or with none
 * when `label` is empty. Only a description straight after the TZX header,
 * where writeCassetteTZX puts it, is replaced; the rest is kept byte for
 * byte. Anything but a TZX file comes back as it is. */
export function relabel(tzx, label) {
    const bytes = new Uint8Array(tzx);
    if (!isTZX(bytes)) return bytes.slice();
    let rest = 10;
    if ((bytes.length > 11) && (bytes[10] === 0x30) && ((12 + bytes[11]) <= bytes.length)) rest = 12 + bytes[11];
    const head = Array.from(bytes.subarray(0, 10));
    const text = label ? textBlock(label) : [];
    const out = new Uint8Array(head.length + text.length + (bytes.length - rest));
    out.set(head, 0);
    out.set(text, head.length);
    out.set(bytes.subarray(rest), head.length + text.length);
    return out;
}

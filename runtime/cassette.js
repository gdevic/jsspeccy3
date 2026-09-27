/*
 * runtime/cassette.js: cassettes for the tape recorder: timing, files and parts.
 *
 * A cassette is a length of tape, CASSETTE_MS long, holding standard-speed
 * blocks, each at the place on the tape where it was recorded, with blank
 * tape between them. A block is kept as TAP-style bytes: the flag byte, the
 * data and the parity byte. On disk and in storage a cassette is a TZX file
 * of standard-speed blocks whose pauses are the blank tape between them, so
 * it loads in any emulator and reads back with every block where it was.
 * There is no DOM here: the worker, the recorder and saved sessions all use
 * it.
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
 * loadCommand (or null), damaged}. A part is damaged when a block fails its
 * parity check, the data doesn't match its header's length, or the header's
 * data block is missing. */
export function describeParts(blocks) {
    const parts = [];
    const endOf = (block) => block.startMs + blockMs(block.data);
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const header = parseHeader(block.data);
        if (header) {
            const next = blocks[i + 1];
            const hasData = next && next.data.length && (next.data[0] !== 0x00)
                && ((next.startMs - endOf(block)) <= PART_GAP_MS);
            parts.push({
                index: i,
                blockIndices: hasData ? [i, i + 1] : [i],
                startMs: block.startMs,
                endMs: hasData ? endOf(next) : endOf(block),
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
                endMs: endOf(block),
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
    for (const block of blocks) endMs = Math.max(endMs, block.startMs + blockMs(block.data));
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
    let label = null;
    let pos = 10;
    let startMs = 0;
    const need = (count) => { if ((pos + count) > bytes.length) throw damaged(); };
    const u8 = () => { need(1); return bytes[pos++]; };
    const u16 = () => { need(2); const v = bytes[pos] | (bytes[pos + 1] << 8); pos += 2; return v; };
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
            case 0x20:
                startMs += u16();
                break;
            case 0x30: {
                const length = u8();
                need(length);
                const text = String.fromCharCode(...bytes.subarray(pos, pos + length));
                pos += length;
                if (label === null) label = text.replace(/[^\x20-\x7e]/g, ' ').trim();
                break;
            }
            case 0x21: skip(u8()); break;       // group start
            case 0x22: break;                   // group end
            case 0x31: skip(1); skip(u8()); break;  // message
            case 0x32: skip(u16()); break;      // archive info
            case 0x33: skip(u8() * 3); break;   // hardware type
            case 0x35: skip(10); skip(u32()); break;  // custom info
            case 0x5a: skip(9); break;          // glue
            case 0x2a:                          // stop the tape if in 48K mode
            case 0x2b: skip(u32()); break;      // signal level
            default:
                throw new Error('This tape uses blocks a cassette cannot hold, such as a turbo or custom loader. Open it with File > Open instead.');
        }
    }
    return { blocks, label: label || '' };
}

/* Reads a .tap or .tzx file as a cassette: {blocks: [{startMs, data}],
 * label}. Throws with a message for the user when it cannot be one. */
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

/* Writes a cassette as a TZX file. Every block is a standard-speed block
 * whose pause is the blank tape up to the next one, and blank tape longer
 * than a pause can hold, or before the first block, is written as pause
 * blocks. Each gap is rounded against the position a reader will work out
 * for the block, so rounding never adds up over a long tape. `label`, if
 * given, goes in as a text description, first. */
export function writeCassetteTZX({ blocks, label }) {
    const out = [];
    for (let i = 0; i < TZX_SIGNATURE.length; i++) out.push(TZX_SIGNATURE.charCodeAt(i));
    out.push(1, 20);
    if (label) out.push(...textBlock(label));
    const pauses = (ms) => {
        while (ms > 0) {
            const pause = Math.min(ms, MAX_PAUSE_MS);
            out.push(0x20, pause & 0xff, pause >> 8);
            ms -= pause;
        }
    };
    let readerMs = blocks.length ? Math.max(0, Math.round(blocks[0].startMs)) : 0;
    pauses(readerMs);
    blocks.forEach((block, i) => {
        const data = (block.data.length > MAX_BLOCK_BYTES) ? block.data.subarray(0, MAX_BLOCK_BYTES) : block.data;
        const duration = blockMs(data);
        const next = blocks[i + 1];
        const gap = next ? Math.max(0, Math.round(next.startMs - (readerMs + duration))) : TAP_GAP_MS;
        const pause = Math.min(gap, MAX_PAUSE_MS);
        out.push(0x10, pause & 0xff, pause >> 8, data.length & 0xff, data.length >> 8);
        for (let j = 0; j < data.length; j++) out.push(data[j]);
        if (next) pauses(gap - pause);
        readerMs += duration + gap;
    });
    return new Uint8Array(out);
}

// Writes a cassette's blocks as a TAP file, one after another.
export function writeCassetteTAP(blocks) {
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

/*
 * runtime/mdr.js — ZX Microdrive cartridge (.MDR) format helpers.
 *
 * A cartridge is a sequence of 10-254 blocks (libspectrum's
 * LIBSPECTRUM_MICRODRIVE_BLOCK_LEN/BLOCK_MAX), one per physical sector, each
 * 543 bytes: a 15-byte header, a 15-byte record descriptor, 512 data bytes
 * and a checksum. A .mdr file is that many blocks back to back, optionally
 * followed by one trailing write-protect byte. The hardware preamble/sync
 * pattern that precedes each half on the tape is not persisted - see
 * generator/core.ts.in and tech_notes.md for how the emulator core
 * synthesises it.
 *
 * Byte layout of a 543-byte block (offsets from the block's start):
 *   0      HDFLAG   bit 0 set = valid header
 *   1      HDNUMB   sector number, 1-254
 *   2-3    (unused)
 *   4-13   HDNAME   cartridge name, space-padded
 *   14     HDCHK    checksum of bytes 0-13
 *   15     RECFLG   bit 1 = EOF, bit 2 clear = a print (OPEN#) file
 *   16     RECNUM   record number within its file, 0-255
 *   17-18  RECLEN   data bytes used in this record, 0-512 (little-endian)
 *   19-28  RECNAM   filename, space-padded
 *   29     DESCHK   checksum of bytes 15-28
 *   30-541 data     512 bytes
 *   542    DCHK     checksum of bytes 30-541
 *
 * Record 0 of a SAVEd file additionally starts its 512 data bytes with a
 * 9-byte header (type, length, start, program-length/array-name, autorun
 * line), mirroring a tape header - see the Sinclair Wiki's Interface 1 page.
 */

export const HEAD_LEN = 15;
export const DATA_LEN = 512;
export const BLOCK_LEN = HEAD_LEN + HEAD_LEN + DATA_LEN + 1; // 543
export const MIN_BLOCKS = 10;
export const MAX_BLOCKS = 254;

const HDFLAG = 0, HDNUMB = 1, HDNAME = 4, HDCHK = 14;
const RECFLG = 15, RECNUM = 16, RECLEN = 17, RECNAM = 19, DESCHK = 29, RECDATA = 30, DCHK = 542;

/* The ROM's running checksum: an 8-bit sum with end-around carry, forced
 * never to land on 0xff (LD A,E / ADD A,(HL) / INC HL / ADC A,1 / JR Z,skip /
 * DEC A / skip: LD E,A), applied over 14 bytes (header/descriptor) or 512
 * (data). */
export function checksum(bytes, start, length) {
    start = start || 0;
    length = (length === undefined) ? bytes.length - start : length;
    let sum = 0;
    for (let i = 0; i < length; i++) {
        sum += bytes[start + i];
        const carry = (sum > 255) ? 1 : 0;
        if (carry) sum -= 256;
        sum += carry + 1;
        if (sum === 256) sum = 0; else sum -= 1;
    }
    return sum;
}

const padName = (name, len) => {
    const bytes = new Uint8Array(len);
    bytes.fill(0x20);
    for (let i = 0; i < Math.min(len, name.length); i++) bytes[i] = name.charCodeAt(i) & 0xff;
    return bytes;
};
const readName = (bytes, offset, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]);
    return s.replace(/ +$/, '');
};

/* Accepts a .mdr file's raw bytes per libspectrum's rule: 10-254 whole
 * blocks, with an optional single trailing write-protect byte. */
export function validateMDRFile(data) {
    const bytes = new Uint8Array(data);
    const length = bytes.length;
    if (length < BLOCK_LEN * MIN_BLOCKS) return false;
    if (length > BLOCK_LEN * MAX_BLOCKS + 1) return false;
    return (length % BLOCK_LEN) === 0 || (length % BLOCK_LEN) === 1;
}

/* Splits a .mdr buffer into its whole-block byte count and write-protect
 * flag (the optional trailing byte); assumes validateMDRFile() already
 * passed. */
export function splitMDRFile(data) {
    const bytes = new Uint8Array(data);
    const remainder = bytes.length % BLOCK_LEN;
    const writeProtect = remainder === 1 ? !!bytes[bytes.length - 1] : false;
    const blocks = Math.floor(bytes.length / BLOCK_LEN);
    return { blocks, writeProtect, data: bytes.subarray(0, blocks * BLOCK_LEN) };
}

/* A brand new, unformatted cartridge: every byte 0xff (as a real blank
 * cartridge is), plus a trailing write-protect byte (off). Matches how the
 * core's insertMicrodrive() recognises "nothing written here yet". */
export function createBlank(blocks) {
    blocks = Math.max(MIN_BLOCKS, Math.min(MAX_BLOCKS, blocks | 0));
    const bytes = new Uint8Array(blocks * BLOCK_LEN + 1);
    bytes.fill(0xff, 0, blocks * BLOCK_LEN);
    bytes[blocks * BLOCK_LEN] = 0; // not write-protected
    return bytes;
}

/* A convenience "quick format": every sector gets a valid header (numbered
 * blocks..1, adapted to the cartridge's own length - the real ROM always
 * counts from 254 and, on a cartridge shorter than that, ends up
 * re-numbering sectors as it wraps round more than once; typing FORMAT in
 * BASIC reproduces that exactly, since it's the real ROM. This is a
 * simplification for a one-click "make it usable" button) and an empty,
 * free record, so CAT reports it as formatted with all sectors free. */
export function quickFormat(blocks, name) {
    const bytes = createBlank(blocks);
    const nameBytes = padName((name || '').slice(0, 10), 10);
    for (let b = 0; b < blocks; b++) {
        const base = b * BLOCK_LEN;
        bytes[base + HDFLAG] = 0x01;
        bytes[base + HDNUMB] = blocks - b;
        bytes[base + 2] = 0;
        bytes[base + 3] = 0;
        bytes.set(nameBytes, base + HDNAME);
        bytes[base + HDCHK] = checksum(bytes, base, 14);

        bytes[base + RECFLG] = 0x04; // bit1 clear (not EOF) + bit2 set (not a print file) = a free record
        bytes[base + RECNUM] = 0;
        bytes[base + RECLEN] = 0;
        bytes[base + RECLEN + 1] = 0;
        bytes.set(padName('', 10), base + RECNAM);
        bytes[base + DESCHK] = checksum(bytes, base + RECFLG, 14);
        bytes.fill(0, base + RECDATA, base + RECDATA + DATA_LEN);
        bytes[base + DCHK] = checksum(bytes, base + RECDATA, DATA_LEN);
    }
    return bytes;
}

/* File-header prefix that record 0 of a SAVEd file carries in its first 9
 * data bytes (mirrors a tape header): type, length, start address,
 * program-length-or-array-name, autorun line. */
const FILE_TYPES = ['Program', 'Number array', 'Character array', 'Bytes'];
function parseFileHeader(recordData) {
    if (recordData.length < 9) return null;
    const type = recordData[0];
    if (type > 3) return null;
    const length = recordData[1] | (recordData[2] << 8);
    const start = recordData[3] | (recordData[4] << 8);
    const param1 = recordData[5] | (recordData[6] << 8);
    const param2 = recordData[7] | (recordData[8] << 8);
    const info = { typeName: FILE_TYPES[type], length, start };
    if (type === 0) { // Program
        info.line = param2; // autorun line, 0x8000+ = none
        info.varsOffset = param1;
    } else if (type === 3) { // Bytes (CODE)
        info.codeStart = param1;
    }
    return info;
}

/* Parses a cartridge (whole-block bytes, as from splitMDRFile) the way CAT
 * would: walks every block, groups records into files by name, and reports
 * free space. A cartridge with no valid header anywhere is unformatted. */
export function parse(blockBytes, writeProtect) {
    const blocks = Math.floor(blockBytes.length / BLOCK_LEN);
    let cartridgeName = null;
    let formatted = false;
    const sectors = [];
    const filesByName = new Map();
    let freeSectors = 0;
    let badSectors = 0;

    for (let b = 0; b < blocks; b++) {
        const base = b * BLOCK_LEN;
        const hdflag = blockBytes[base + HDFLAG];
        const hdValid = (hdflag & 0x01) !== 0
            && checksum(blockBytes, base, 14) === blockBytes[base + HDCHK];
        if (hdValid) {
            formatted = true;
            if (cartridgeName === null) cartridgeName = readName(blockBytes, base + HDNAME, 10);
        }

        const recflg = blockBytes[base + RECFLG];
        const reclen = blockBytes[base + RECLEN] | (blockBytes[base + RECLEN + 1] << 8);
        const descOk = checksum(blockBytes, base + RECFLG, 14) === blockBytes[base + DESCHK];
        const isEOF = (recflg & 0x02) !== 0;
        const isFree = !isEOF && reclen === 0 && descOk;
        const isBad = isEOF && reclen === 0 && descOk;
        const isUsed = descOk && !isFree && !isBad;

        let sector = { index: b, hdNumb: blockBytes[base + HDNUMB], formatted: hdValid, state: 'free', fileName: null };
        if (!hdValid) {
            sector.state = 'unformatted';
        } else if (isFree) {
            freeSectors++;
            sector.state = 'free';
        } else if (isBad) {
            badSectors++;
            sector.state = 'bad';
        } else if (isUsed) {
            const recnam = readName(blockBytes, base + RECNAM, 10);
            sector.state = 'used';
            sector.fileName = recnam;
            const recnum = blockBytes[base + RECNUM];
            const isPrintFile = (recflg & 0x04) === 0;
            let file = filesByName.get(recnam);
            if (!file) {
                file = { name: recnam, records: [], isPrintFile, complete: false, length: 0 };
                filesByName.set(recnam, file);
            }
            file.records.push({ recnum, isEOF, length: reclen, dataOffset: base + RECDATA });
            if (isEOF) file.complete = true;
            file.length += reclen;
        } else {
            // descriptor checksum failed: treat the sector as unreadable/bad
            // rather than guessing at its content.
            badSectors++;
            sector.state = 'bad';
        }
        sectors.push(sector);
    }

    const files = Array.from(filesByName.values()).map(file => {
        file.records.sort((a, b) => a.recnum - b.recnum);
        const first = file.records.find(r => r.recnum === 0);
        file.header = first ? parseFileHeader(blockBytes.subarray(first.dataOffset, first.dataOffset + 9)) : null;
        delete file.records; // offsets only meaningful within this parse; not exposed
        return file;
    }).sort((a, b) => a.name.localeCompare(b.name));

    return {
        blocks,
        writeProtect: !!writeProtect,
        formatted,
        cartridgeName,
        files,
        sectors,
        freeSectors,
        badSectors,
        freeK: freeSectors / 2,
        totalK: blocks / 2,
    };
}

/* The BASIC command that loads this file back, in whatever form its type
 * needs (CODE files need the keyword; array files load into a placeholder
 * array since the actual variable name isn't recoverable from the header). */
export function loadCommand(file, drive) {
    const base = `LOAD *"m";${drive + 1};"${file.name}"`;
    const type = file.header && file.header.typeName;
    if (type === 'Bytes') return `${base} CODE`;
    if (type === 'Number array') return `${base} DATA a()`;
    if (type === 'Character array') return `${base} DATA a$()`;
    return base;
}

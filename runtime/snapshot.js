import pako from 'pako';

function extractMemoryBlock(data, fileOffset, isCompressed, unpackedLength) {
    if (!isCompressed) {
        /* uncompressed; extract a byte array directly from data */
        return new Uint8Array(data, fileOffset, unpackedLength);
    } else {
        /* compressed */
        const fileBytes = new Uint8Array(data, fileOffset);
        const memoryBytes = new Uint8Array(unpackedLength);
        let filePtr = 0;
        let memoryPtr = 0;
        while (memoryPtr < unpackedLength) {
            /* check for coded ED ED nn bb sequence */
            if (
                unpackedLength - memoryPtr >= 2 && /* at least two bytes left to unpack */
                fileBytes[filePtr] == 0xed &&
                fileBytes[filePtr + 1] == 0xed
            ) {
                /* coded sequence */
                const count = fileBytes[filePtr + 2];
                const value = fileBytes[filePtr + 3];
                for (let i = 0; i < count; i++) {
                    memoryBytes[memoryPtr++] = value;
                }
                filePtr += 4;
            } else {
                /* plain byte */
                memoryBytes[memoryPtr++] = fileBytes[filePtr++];
            }
        }
        return memoryBytes;
    }
}

export function parseZ80File(data) {
    const file = new DataView(data);

    const iReg = file.getUint8(10);
    const byte12 = file.getUint8(12);
    const rReg = (file.getUint8(11) & 0x7f) | ((byte12 & 0x01) << 7);
    const byte29 = file.getUint8(29);

    const snapshot = {
        registers: {
            'AF': file.getUint16(0, false), /* NB Big-endian */
            'BC': file.getUint16(2, true),
            'HL': file.getUint16(4, true),
            'PC': file.getUint16(6, true),
            'SP': file.getUint16(8, true),
            'IR': (iReg << 8) | rReg,
            'DE': file.getUint16(13, true),
            'BC_': file.getUint16(15, true),
            'DE_': file.getUint16(17, true),
            'HL_': file.getUint16(19, true),
            'AF_': file.getUint16(21, false), /* Big-endian */
            'IY': file.getUint16(23, true),
            'IX': file.getUint16(25, true),
            'iff1': !!file.getUint8(27),
            'iff2': !!file.getUint8(28),
            'im': byte29 & 0x03
        },
        ulaState: {
            borderColour: (byte12 & 0x0e) >> 1
        },
        memoryPages: {},
    };

    if (snapshot.registers.PC !== 0) {
        /* a non-zero value for PC at offset 6 indicates a version 1 file */
        snapshot.model = 48;
        const memory = extractMemoryBlock(data, 30, byte12 & 0x20, 0xc000);

        /* construct byte arrays of length 0x4000 at the appropriate offsets into the data stream */
        snapshot.memoryPages[5] = new Uint8Array(memory.buffer, 0, 0x4000);
        snapshot.memoryPages[2] = new Uint8Array(memory.buffer, 0x4000, 0x4000);
        snapshot.memoryPages[0] = new Uint8Array(memory.buffer, 0x8000, 0x4000);

        snapshot.tstates = 0;
    } else {
        /* version 2-3 snapshot */
        const additionalHeaderLength = file.getUint16(30, true);
        const isVersion2 = (additionalHeaderLength == 23);
        snapshot.registers.PC = file.getUint16(32, true);
        const machineId = file.getUint8(34);
        const is48K = (isVersion2 ? machineId < 3 : machineId < 4);
        snapshot.model = (is48K ? 48 : 128);
        if (!is48K) {
            snapshot.ulaState.pagingFlags = file.getUint8(35);
        }
        const tstateChunkSize = (is48K ? 69888 : 70908) / 4;
        snapshot.tstates = (
            (((file.getUint8(57) + 1) % 4) + 1) * tstateChunkSize
            - (file.getUint16(55, true) + 1)
        );
        if (snapshot.tstates >= tstateChunkSize * 4) snapshot.tstates = 0;

        let offset = 32 + additionalHeaderLength;

        /* translation table from the IDs Z80 assigns to pages, to the page numbers they
        actually get loaded into */
        let pageIdToNumber;
        if (is48K) {
            pageIdToNumber = {
                4: 2,
                5: 0,
                8: 5
            };
        } else {
            pageIdToNumber = {
                3: 0,
                4: 1,
                5: 2,
                6: 3,
                7: 4,
                8: 5,
                9: 6,
                10: 7
            };
        }
        while (offset < data.byteLength) {
            let compressedLength = file.getUint16(offset, true);
            let isCompressed = true;
            if (compressedLength == 0xffff) {
                compressedLength = 0x4000;
                isCompressed = false;
            }
            const pageId = file.getUint8(offset + 2);
            if (pageId in pageIdToNumber) {
                const pageNumber = pageIdToNumber[pageId];
                const pageData = extractMemoryBlock(data, offset + 3, isCompressed, 0x4000);
                snapshot.memoryPages[pageNumber] = pageData;
            }
            offset += compressedLength + 3;
        }
    }

    return snapshot;
}


export function parseSNAFile(data) {
    let mode128 = false;
    let snapshot = null;
    const len = data.byteLength;
    let sna;

    switch (len) {
        case 131103:
        case 147487:
            mode128 = true;
        case 49179:
            sna = new DataView(data, 0, mode128 ? 49182 : len);
            snapshot = {
                model: (mode128 ? 128 : 48),
                registers: {},
                ulaState: {},
            /* construct byte arrays of length 0x4000 at the appropriate offsets into the data stream */
                memoryPages: {
                    5: new Uint8Array(data, 0x0000 + 27, 0x4000),
                    2: new Uint8Array(data, 0x4000 + 27, 0x4000)
                },
                tstates: 0,
            };

            if (mode128) {
                const page = (sna.getUint8(49181) & 7);
                snapshot.memoryPages[page] = new Uint8Array(data, 0x8000 + 27, 0x4000);

                for (let i = 0, ptr = 49183; i < 8; i++) {
                    if (typeof snapshot.memoryPages[i] === 'undefined') {
                        snapshot.memoryPages[i] = new Uint8Array(data, ptr, 0x4000);
                        ptr += 0x4000;
                    }
                }
            }
            else
                snapshot.memoryPages[0] = new Uint8Array(data, 0x8000 + 27, 0x4000);

            snapshot.registers['IR'] = (sna.getUint8(0) << 8) | sna.getUint8(20);
            snapshot.registers['HL_'] = sna.getUint16(1, true);
            snapshot.registers['DE_'] = sna.getUint16(3, true);
            snapshot.registers['BC_'] = sna.getUint16(5, true);
            snapshot.registers['AF_'] = sna.getUint16(7, true);
            snapshot.registers['HL'] = sna.getUint16(9, true);
            snapshot.registers['DE'] = sna.getUint16(11, true);
            snapshot.registers['BC'] = sna.getUint16(13, true);
            snapshot.registers['IY'] = sna.getUint16(15, true);
            snapshot.registers['IX'] = sna.getUint16(17, true);
            snapshot.registers['iff1'] = snapshot.registers['iff2'] = (sna.getUint8(19) & 0x04) >> 2;
            snapshot.registers['AF'] = sna.getUint16(21, true);

            if (mode128) {
                snapshot.registers['SP'] = sna.getUint16(23, true);
                snapshot.registers['PC'] = sna.getUint16(49179, true);
                snapshot.ulaState.pagingFlags = sna.getUint8(49181);
            }
            else {
                /* peek memory at SP to get proper value of PC */
                let sp = sna.getUint16(23, true);
                const l = sna.getUint8(sp - 16384 + 27);
                sp = (sp + 1) & 0xffff;
                const h = sna.getUint8(sp - 16384 + 27);
                sp = (sp + 1) & 0xffff;
                snapshot.registers['PC'] = (h << 8) | l;
                snapshot.registers['SP'] = sp;
            }

            snapshot.registers['im'] = sna.getUint8(25);
            snapshot.ulaState.borderColour = sna.getUint8(26);
            break;

        default:
            throw "Cannot handle SNA snapshots of length " + len;
    }

    return snapshot;
}


function getSZXIDString(file, offset) {
    const dword = file.getUint32(offset, true);
    return (
        String.fromCharCode(dword & 0xff)
        + String.fromCharCode((dword & 0xff00) >> 8)
        + String.fromCharCode((dword & 0xff0000) >> 16)
        + String.fromCharCode(dword >> 24)
    )
}

export function parseSZXFile(data) {
    const file = new DataView(data);
    const fileLen = data.byteLength;
    const snapshot = {
        memoryPages: {},
    };

    if (getSZXIDString(file, 0) != 'ZXST') {
        throw "Not a valid SZX file";
    }

    const machineId = file.getUint8(6);
    switch (machineId) {
        case 1:
            snapshot.model = 48;
            break;
        case 2:
        case 3:
            snapshot.model = 128;
            break;
        case 7:
            snapshot.model = 5;
            break;
        default:
            throw "Unsupported machine type: " + machineId;
    }

    let offset = 8;
    while (offset < fileLen) {
        const blockId = getSZXIDString(file, offset);
        const blockLen = file.getUint32(offset + 4, true);
        offset += 8;

        switch (blockId) {
            case 'Z80R':
                snapshot.registers = {
                    'AF': file.getUint16(offset + 0, true),
                    'BC': file.getUint16(offset + 2, true),
                    'DE': file.getUint16(offset + 4, true),
                    'HL': file.getUint16(offset + 6, true),
                    'AF_': file.getUint16(offset + 8, true),
                    'BC_': file.getUint16(offset + 10, true),
                    'DE_': file.getUint16(offset + 12, true),
                    'HL_': file.getUint16(offset + 14, true),
                    'IX': file.getUint16(offset + 16, true),
                    'IY': file.getUint16(offset + 18, true),
                    'SP': file.getUint16(offset + 20, true),
                    'PC': file.getUint16(offset + 22, true),
                    'IR': file.getUint16(offset + 24, false),
                    'iff1': !!file.getUint8(offset + 26),
                    'iff2': !!file.getUint8(offset + 27),
                    'im': file.getUint8(offset + 28),
                };
                snapshot.tstates = file.getUint32(offset + 29, true);
                snapshot.halted = !!(file.getUint8(offset + 34) & 0x02);
                snapshot.eilast = !!(file.getUint8(offset + 34) & 0x01);
                // currently ignored:
                // chHoldIntReqCycles, memptr

                break;
            case 'SPCR':
                snapshot.ulaState = {
                    borderColour: file.getUint8(offset + 0),
                    pagingFlags: file.getUint8(offset + 1),
                };
                // currently ignored:
                // ch1ffd, chEff7, chFe
                break;
            case 'AY\0\0':
                snapshot.ay = {
                    selected: file.getUint8(offset + 1),
                    registers: Array.from(new Uint8Array(data, offset + 2, 16)),
                };
                break;
            case 'IF1\0':
                snapshot.interface1Paged = !!(file.getUint16(offset, true) & 0x0004);
                break;
            case 'B128':
                snapshot.betadiskPaged = !!(file.getUint32(offset, true) & 0x0004);
                break;
            case 'RAMP':
                const isCompressed = file.getUint16(offset + 0, true) & 0x0001;
                const pageNumber = file.getUint8(offset + 2);
                if (isCompressed) {
                    const compressedLength = blockLen - 3;
                    const compressed = new Uint8Array(data, offset + 3, compressedLength);
                    const pageData = pako.inflate(compressed);
                    snapshot.memoryPages[pageNumber] = pageData;
                } else {
                    const pageData = new Uint8Array(data, offset + 3, 0x4000);
                    snapshot.memoryPages[pageNumber] = pageData;
                }
                break;
            // default:
            //     console.log('skipping block', blockId);
        }

        offset += blockLen;
    }

    return snapshot;


}

/* Writes a snapshot, in the structure the parsers above produce, as an SZX
 * file (the zx-state format, version 1.4): the Z80 registers, the ULA and
 * paging state, the AY chip on a 128K or Pentagon, the Interface 1 and
 * whether its ROM is paged in, the Pentagon's Beta 128 disk interface and
 * whether TR-DOS is paged in, a connected ZX Printer, and every RAM page the
 * machine has, deflated. Returns an ArrayBuffer. */
export function writeSZXFile(snapshot) {
    const MACHINE_IDS = { 48: 1, 128: 2, 5: 7 };
    if (!MACHINE_IDS[snapshot.model]) throw new Error('This machine can not be saved as a snapshot.');
    const chunks = [];
    const block = (id, length, fill) => {
        const bytes = new Uint8Array(8 + length);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < 4; i++) bytes[i] = id.charCodeAt(i);
        view.setUint32(4, length, true);
        fill(view, bytes, 8);
        chunks.push(bytes);
    };

    const header = new Uint8Array([0x5a, 0x58, 0x53, 0x54, 1, 4, MACHINE_IDS[snapshot.model], 0]);
    chunks.push(header);

    block('CRTR', 36, (view, bytes, o) => {
        const creator = 'JSSpeccy';
        for (let i = 0; i < creator.length; i++) bytes[o + i] = creator.charCodeAt(i);
        view.setUint16(o + 32, 3, true);
        view.setUint16(o + 34, 0, true);
    });

    const r = snapshot.registers;
    block('Z80R', 37, (view, bytes, o) => {
        ['AF', 'BC', 'DE', 'HL', 'AF_', 'BC_', 'DE_', 'HL_', 'IX', 'IY', 'SP', 'PC'].forEach((name, i) => {
            view.setUint16(o + (i * 2), r[name], true);
        });
        view.setUint16(o + 24, r.IR, false);  // I then R
        bytes[o + 26] = r.iff1 ? 1 : 0;
        bytes[o + 27] = r.iff2 ? 1 : 0;
        bytes[o + 28] = r.im;
        view.setUint32(o + 29, snapshot.tstates, true);
        bytes[o + 33] = 0;  // chHoldIntReqCycles
        bytes[o + 34] = (snapshot.halted ? 0x02 : 0x00) | (snapshot.eilast ? 0x01 : 0x00);
        view.setUint16(o + 35, 0, true);  // MEMPTR
    });

    block('SPCR', 8, (view, bytes, o) => {
        bytes[o + 0] = snapshot.ulaState.borderColour;
        bytes[o + 1] = snapshot.ulaState.pagingFlags;
        bytes[o + 3] = snapshot.ulaState.borderColour;  // last write to port 0xfe
    });

    if (snapshot.ay && snapshot.model !== 48) {
        block('AY\0\0', 18, (view, bytes, o) => {
            bytes[o + 0] = 0;
            bytes[o + 1] = snapshot.ay.selected;
            for (let i = 0; i < 16; i++) bytes[o + 2 + i] = snapshot.ay.registers[i] || 0;
        });
    }

    if (snapshot.interface1Connected) {
        // enabled, and paged in; two Microdrives; the standard ROM (no ROM data)
        block('IF1\0', 40, (view, bytes, o) => {
            view.setUint16(o, 0x0001 | (snapshot.interface1Paged ? 0x0004 : 0), true);
            bytes[o + 2] = 2;
        });
    }
    if (snapshot.model === 5) {
        // connected, and paged in; no disk drives
        block('B128', 10, (view, bytes, o) => {
            view.setUint32(o, 0x0001 | (snapshot.betadiskPaged ? 0x0004 : 0), true);
        });
    }
    if (snapshot.zxPrinter) {
        block('ZXPR', 2, (view, bytes, o) => view.setUint16(o, 0x0001, true));
    }

    for (const page of Object.keys(snapshot.memoryPages).map(Number).sort((a, b) => a - b)) {
        const packed = pako.deflate(snapshot.memoryPages[page]);
        block('RAMP', 3 + packed.length, (view, bytes, o) => {
            view.setUint16(o, 1, true);  // compressed
            bytes[o + 2] = page;
            bytes.set(packed, o + 3);
        });
    }

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out.buffer;
}

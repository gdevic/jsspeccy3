const subtle = crypto.subtle;

export function b64urlDecode(text) {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

export function hexEncode(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
}

async function hmacSha256(keyBytes, message) {
    const key = await subtle.importKey('raw', keyBytes, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', key, message));
}

async function hkdfSha256(ikm, salt, infoStr, length) {
    const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const info = new TextEncoder().encode(infoStr);
    const bits = await subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt, info}, key, length * 8);
    return new Uint8Array(bits);
}

async function keystream(msgKey, length) {
    const blockCount = Math.ceil(length / 32);
    const counters = [];
    for (let i = 0; i < blockCount; i++) {
        const buf = new Uint8Array(4);
        new DataView(buf.buffer).setUint32(0, i, true); // LE32
        counters.push(buf);
    }
    const blocks = await Promise.all(counters.map((c) => hmacSha256(msgKey, c)));
    return concatBytes(...blocks).slice(0, length);
}

function xorBytes(a, b) {
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
    return out;
}

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

export async function playzxDecrypt(sessionKeyBytes, nonceBytes, gid, response) {
    const isPzx2 = response.length >= 24
        && response[0] === 0x50 && response[1] === 0x5a && response[2] === 0x58 && response[3] === 0x32
        && response[4] === 0x01;
    if (!isPzx2) throw new Error('Unrecognized response format.');

    const header = response.subarray(0, 8);
    const ciphertext = response.subarray(8, response.length - 16);
    const tag = response.subarray(response.length - 16);

    const msgKey = await hkdfSha256(sessionKeyBytes, nonceBytes, 'PZX2|enc|' + gid, 32);
    const macKey = await hkdfSha256(sessionKeyBytes, nonceBytes, 'PZX2|mac|' + gid, 32);

    const expectedTag = (await hmacSha256(macKey, concatBytes(header, ciphertext))).slice(0, 16);
    if (!bytesEqual(expectedTag, tag)) throw new Error('Response authentication failed.');

    return xorBytes(ciphertext, await keystream(msgKey, ciphertext.length));
}

export async function playzxSignRequest(sessionKeyBytes, gid, nonceHex) {
    const message = new TextEncoder().encode(`D|${gid}|${nonceHex}`);
    return hexEncode(await hmacSha256(sessionKeyBytes, message)).slice(0, 16);
}

export function makeNonce() {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setUint32(0, Math.floor(Date.now() / 1000), false); // BE32
    crypto.getRandomValues(bytes.subarray(4));
    return {hex: hexEncode(bytes), bytes};
}

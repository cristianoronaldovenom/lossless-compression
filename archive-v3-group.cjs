"use strict";

const zlib = require("node:zlib");
const { digest } = require("./archive-format.cjs");

const { parityPair, recoverPair } = require("./archive-parity.cjs");

const MAGIC = Buffer.from("S10ARC03"), MAGIC_RESILIENT = Buffer.from("S10ARC04");
const CHUNK = 256 * 1024;
const SLOTS = 8;
const MAX = 1024 ** 4;
const PREFIX = 64;
const ENTRY = 76;
const BODY = PREFIX + SLOTS * ENTRY;
const MANIFEST = BODY + 32;
const RAW = 0, DEFLATE = 1, ZSTD = 2;
const hasZstd = typeof zlib.zstdCompressSync === "function" && typeof zlib.zstdDecompressSync === "function";

function xorInto(target, source) {
    const count = source.length >>> 2;
    if (!(target.byteOffset & 3) && !(source.byteOffset & 3)) {
        const dst = new Uint32Array(target.buffer, target.byteOffset, count);
        const src = new Uint32Array(source.buffer, source.byteOffset, count);
        for (let i = 0; i < count; i++) dst[i] ^= src[i];
    } else {
        for (let i = 0; i < count * 4; i++) target[i] ^= source[i];
    }
    for (let i = count * 4; i < source.length; i++) target[i] ^= source[i];
}

function parityFor(payloads) {
    const result = Buffer.alloc(Math.max(...payloads.map(payload => payload.length)));
    for (const payload of payloads) xorInto(result, payload);
    return result;
}

function manifest(group, priorBytes, count, resilient = false) {
    const info = Buffer.alloc(MANIFEST);
    (resilient ? MAGIC_RESILIENT : MAGIC).copy(info);
    info.writeBigUInt64LE(BigInt(group), 8);
    info.writeBigUInt64LE(BigInt(priorBytes), 16);
    info.writeUInt32LE(count, 24);
    return info;
}

function seal(info) {
    digest(info.subarray(0, BODY)).copy(info, BODY);
    return info;
}

function encode(raw, portable) {
    const mode = hasZstd && !portable ? ZSTD : DEFLATE;
    const payload = mode === ZSTD ? zlib.zstdCompressSync(raw, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 }
    }) : zlib.deflateRawSync(raw, { level: 1 });
    return payload.length < raw.length ? { mode, payload } : { mode: RAW, payload: raw };
}

function decode(mode, payload, length) {
    if (mode === RAW) return payload;
    if (mode === ZSTD && !hasZstd) throw Error("This archive uses Zstandard. Open it with Node.js 24 or a runtime with built-in Zstandard support.");
    const options = { maxOutputLength: length };
    if (mode === ZSTD) options.params = { [zlib.constants.ZSTD_d_windowLogMax]: 18 };
    return mode === ZSTD ? zlib.zstdDecompressSync(payload, options) : zlib.inflateRawSync(payload, options);
}

// Buffer views survive structured cloning as Uint8Arrays; wrap without copying.
function asBuffer(view) {
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function encodeGroup({ input, group, priorBytes, portable, resilient, vectored, workspace }) {
    const rawGroup = asBuffer(input);
    const info = manifest(group, priorBytes, Math.ceil(rawGroup.length / CHUNK), resilient);
    const payloads = [];
    const modes = [0, 0, 0];
    let storedBytes = 0;
    for (let start = 0; start < rawGroup.length; start += CHUNK) {
        const raw = rawGroup.subarray(start, start + CHUNK);
        const { mode, payload } = encode(raw, portable);
        const at = PREFIX + payloads.length * ENTRY;
        info.writeUInt32LE(mode, at);
        info.writeUInt32LE(payload.length, at + 4);
        info.writeUInt32LE(raw.length, at + 8);
        const checksum = digest(payload);
        checksum.copy(info, at + 12);
        (mode === RAW ? checksum : digest(raw)).copy(info, at + 44);
        payloads.push(payload);
        modes[mode]++;
        storedBytes += payload.length;
    }
    const length = Math.max(...payloads.map(payload => payload.length));
    const parity = resilient ? parityPair(payloads, length, workspace) : [parityFor(payloads)];
    info.writeUInt32LE(length, 28);
    digest(...parity).copy(info, 32);
    seal(info);
    const parts = [info, info, ...payloads, ...parity];
    if (vectored) return { parts, modes };
    const output = Buffer.allocUnsafeSlow(2 * MANIFEST + storedBytes + parity.length * length);
    let at = 0;
    for (const part of parts) at += part.copy(output, at);
    return { output, modes };
}

function recoverSingle(payloads, entries, bad, parity, check, group, force) {
    const goodParity = digest(parity).equals(check);
    if (bad.length > 1 || (bad.length && !goodParity)) {
        throw Error("Cannot recover group " + (group + 1) + ": more than one data/parity shard is damaged");
    }
    if (bad.length) {
        const [badSlot] = bad;
        const rebuilt = Buffer.from(parity);
        for (let i = 0; i < entries.length; i++) if (i !== badSlot) xorInto(rebuilt, payloads[i]);
        const entry = entries[badSlot];
        const payload = rebuilt.subarray(0, entry.stored);
        if (rebuilt.subarray(entry.stored).some(Boolean) || !digest(payload).equals(entry.encodedHash)) {
            throw Error("Recovered bytes did not match their checksum at group " + (group + 1));
        }
        payload.copy(payloads[badSlot]);
        return 1;
    } else if (!goodParity || force) {
        const rebuilt = parityFor(payloads);
        if (!digest(rebuilt).equals(check)) throw Error("Cannot verify parity at group " + (group + 1));
        if (!goodParity) {
            rebuilt.copy(parity);
            return 1;
        }
    }
    return 0;
}

function prepareDecodeGroup({ input, entries, group, parityHash, parityLength, command, resilient, firstSlot }) {
    const frame = asBuffer(input);
    const check = asBuffer(parityHash);
    const selectedOnly = firstSlot !== undefined;
    let pos = 0;
    const bad = [];
    const payloads = entries.map((entry, slot) => {
        const payload = frame.subarray(pos, pos + entry.stored);
        pos += entry.stored;
        if (!selectedOnly && !digest(payload).equals(entry.encodedHash)) bad.push(slot);
        return payload;
    });
    const parity = frame.subarray(pos, pos + parityLength);
    const repairs = selectedOnly ? 0 : resilient
        ? recoverPair(payloads, entries, bad, parity, frame.subarray(pos + parityLength), check, group, command === "repair")
        : recoverSingle(payloads, entries, bad, parity, check, group, command === "repair");
    return { frame, payloads, repairs };
}

function decodeGroup(job, prepared = prepareDecodeGroup(job), decoded) {
    const { entries, group, groupBytes, command, range, firstSlot, vectored } = job;
    const { frame, payloads, repairs } = prepared;
    const outputLength = range ? range.to - range.from : groupBytes;
    const extracts = command === "unpack" || Boolean(range);
    // Serial extraction writes verified chunk views directly. Workers return
    // a compact transferable buffer.
    const rawView = extracts && vectored && entries.every(entry => entry.mode === RAW)
        ? frame.subarray(range ? range.from - (firstSlot ?? 0) * CHUNK : 0,
            range ? range.to - (firstSlot ?? 0) * CHUNK : groupBytes)
        : undefined;
    const parts = extracts && vectored && !rawView ? [] : undefined;
    const output = command === "repair" ? frame : rawView ?? (extracts && !parts ? Buffer.allocUnsafeSlow(outputLength) : undefined);
    let written = 0;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const offset = ((firstSlot ?? 0) + i) * CHUNK;
        if (range && (offset >= range.to || offset + entry.raw <= range.from)) continue;
        const raw = decoded?.[i] ?? decode(entry.mode, payloads[i], entry.raw);
        if (raw.length !== entry.raw || !(entry.mode === RAW ? asBuffer(entry.encodedHash) : digest(raw)).equals(entry.plainHash)) {
            throw Error("Decoded bytes did not match their checksum at group " + (group + 1));
        }
        if (extracts) {
            const from = range ? Math.max(range.from - offset, 0) : 0;
            const to = range ? Math.min(range.to - offset, raw.length) : raw.length;
            if (parts) parts.push(raw.subarray(from, to));
            else if (!rawView) raw.copy(output, written, from, to);
            written += to - from;
        }
    }
    if (extracts && (written !== outputLength || (rawView && rawView.length !== outputLength))) {
        throw Error("Incomplete v3 worker output");
    }
    return parts ? { parts, repairs } : { output, repairs };
}

module.exports = { MAGIC, MAGIC_RESILIENT, CHUNK, SLOTS, MAX, PREFIX, ENTRY, BODY, MANIFEST, RAW, DEFLATE, ZSTD,
    manifest, seal, encodeGroup, prepareDecodeGroup, decodeGroup };

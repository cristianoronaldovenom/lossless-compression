"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { CHUNK_BYTES, RAW, PALETTE, DEFLATE } = require("./block-codec.cjs");

const HEADER_BYTES = 16;
const ENTRY_BYTES = 32;
const FOOTER_BYTES = 56;
const MAX_BYTES = 64 * 1024 ** 3;
const MAGIC = Buffer.from("S10ARC01");
const END_MAGIC = Buffer.from("S10END01");

function digest(...buffers) {
    if (buffers.length === 1 && typeof crypto.hash === "function") return crypto.hash("sha256", buffers[0], "buffer");
    const hash = crypto.createHash("sha256");
    for (const buffer of buffers) hash.update(buffer);
    return hash.digest();
}

function readInto(fd, target, position) {
    let received = 0;
    while (received < target.length) {
        const count = fs.readSync(fd, target, received, target.length - received,
            position === null ? null : position + received);
        if (count === 0) break;
        received += count;
    }
    return target.subarray(0, received);
}

function readExactly(fd, length, position) {
    const result = readInto(fd, Buffer.allocUnsafe(length), position);
    if (result.length !== length) throw new Error("Truncated archive");
    return result;
}

function inspectArchive(fd, { embedded = false } = {}) {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Error("Expected a regular archive file");
    const fileSize = stat.size;
    if (fileSize < HEADER_BYTES + FOOTER_BYTES || fileSize >
        MAX_BYTES + MAX_BYTES / CHUNK_BYTES * ENTRY_BYTES + HEADER_BYTES + FOOTER_BYTES) {
        throw new Error("Invalid archive size");
    }
    const header = readExactly(fd, HEADER_BYTES, 0);
    const footer = readExactly(fd, FOOTER_BYTES, fileSize - FOOTER_BYTES);
    if (!header.subarray(0, 8).equals(MAGIC) || header.readUInt32LE(12) ||
        !footer.subarray(48).equals(END_MAGIC)) throw new Error("Invalid archive format");
    const rawSize = Number(footer.readBigUInt64LE());
    const indexOffset = Number(footer.readBigUInt64LE(8));
    if (rawSize > MAX_BYTES || indexOffset < HEADER_BYTES ||
        indexOffset + Math.ceil(rawSize / CHUNK_BYTES) * ENTRY_BYTES + FOOTER_BYTES !== fileSize) {
        throw new Error("Invalid archive index location");
    }
    const index = readExactly(fd, fileSize - indexOffset - FOOTER_BYTES, indexOffset);
    if (!digest(header, index, footer.subarray(0, 16)).equals(footer.subarray(16, 48))) {
        throw new Error("Archive index checksum mismatch");
    }
    let expectedOffset = HEADER_BYTES;
    let containsDeflate = false;
    for (let entry = 0; entry < index.length; entry += ENTRY_BYTES) {
        const offset = Number(index.readBigUInt64LE(entry));
        const stored = index.readUInt32LE(entry + 8);
        const mode = index[entry + 12];
        const rawLength = Math.min(CHUNK_BYTES, rawSize - entry / ENTRY_BYTES * CHUNK_BYTES);
        if (offset !== expectedOffset || !stored || mode > DEFLATE ||
            index.readUIntLE(entry + 13, 3) ||
            (mode === RAW ? stored !== rawLength : stored >= rawLength)) {
            throw new Error("Invalid chunk entry");
        }
        if (embedded && mode === PALETTE && stored < 4) throw Error("Invalid firmware palette size");
        if (mode === DEFLATE) containsDeflate = true;
        expectedOffset += stored;
    }
    if (expectedOffset !== indexOffset) throw new Error("Invalid payload length");
    if (embedded && containsDeflate) throw Error("Firmware does not support DEFLATE. Pack with --fast-decode.");
    const seed = header.readUInt32LE(8);
    return { rawSize, fileSize, index, seed, blocks: index.length / ENTRY_BYTES };
}

module.exports = { HEADER_BYTES, ENTRY_BYTES, FOOTER_BYTES, MAX_BYTES, MAGIC, END_MAGIC, digest, readInto, readExactly, inspectArchive };

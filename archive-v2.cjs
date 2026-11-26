"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { CHUNK_BYTES, RAW, PALETTE, DEFLATE, makeDictionary, encodeBlock, decodeBlock } = require("./block-codec.cjs");
const { readInto, readExactly, digest } = require("./archive-format.cjs");
const { runOrdered } = require("./codec-worker.cjs");
const { publishFile } = require("./publish-file.cjs");

const MAGIC = Buffer.from("S10ARC02");
const END_MAGIC = Buffer.from("S10END02");
const HEADER = 16;
const FOOTER = 56;
const GROUP_CHUNKS = 16;
const GROUP_BYTES = GROUP_CHUNKS * CHUNK_BYTES;
const CHUNK_ENTRY = 24;
const GROUP_HEADER = GROUP_CHUNKS * CHUNK_ENTRY;
const DIRECTORY_ENTRY = 32;
const MAX_BYTES = 1024 ** 4;

function write(fd, buffers) {
    let at = 0;
    while (at < buffers.length) {
        let written = fs.writevSync(fd, buffers.slice(at));
        if (!written) throw Error("Short archive write");
        while (at < buffers.length && written >= buffers[at].length) written -= buffers[at++].length;
        if (written) buffers[at] = buffers[at].subarray(written);
    }
}

function groupDigest(header, index, location, metadata) {
    const ordinal = Buffer.alloc(8);
    ordinal.writeBigUInt64LE(BigInt(index));
    return digest(header, ordinal, location, metadata).subarray(0, 16);
}

async function pack(source, destination, fastDecode) {
    const stdin = source === "-";
    const input = stdin ? 0 : fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const initial = stdin ? undefined : fs.fstatSync(input, { bigint: true });
        if (initial && !initial.isFile()) throw Error("Expected a regular input file or binary stdin");
        if (initial?.size > BigInt(MAX_BYTES)) throw Error("v2 archive limit is 1 TiB");
        await publishFile(destination, output => {
            const temp = fs.mkdtempSync(path.join(path.dirname(path.resolve(destination)), ".s10-index-"));
            const file = path.join(temp, "directory");
            let spool;
            try {
                spool = fs.openSync(file, "wx+", 0o600);
                const header = Buffer.alloc(HEADER);
                MAGIC.copy(header);
                const seed = crypto.randomBytes(4).readUInt32LE();
                header.writeUInt32LE(seed, 8);
                const dictionary = makeDictionary(seed);
                const scratch = Buffer.allocUnsafe(GROUP_BYTES);
                const entries = Buffer.allocUnsafe(64 * 1024);
                let pending = 0, rawSize = 0, position = HEADER, groups = 0;
                write(output, [header]);
                for (;;) {
                    const bytes = readInto(input, scratch, null);
                    if (!bytes.length) break;
                    rawSize += bytes.length;
                    if (rawSize > MAX_BYTES) throw Error("v2 archive limit is 1 TiB");
                    const metadata = Buffer.alloc(GROUP_HEADER);
                    const payloads = [];
                    let groupLength = GROUP_HEADER;
                    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
                        const raw = bytes.subarray(offset, offset + CHUNK_BYTES);
                        const { mode, bytes: payload } = encodeBlock(raw, dictionary, fastDecode);
                        const entry = offset / CHUNK_BYTES * CHUNK_ENTRY;
                        metadata.writeUInt32LE(payload.length, entry);
                        metadata[entry + 4] = mode;
                        digest(raw).copy(metadata, entry + 8, 0, 16);
                        groupLength += payload.length;
                        payloads.push(payload);
                    }
                    const row = entries.subarray(pending, pending + DIRECTORY_ENTRY);
                    row.fill(0);
                    row.writeBigUInt64LE(BigInt(position));
                    row.writeUInt32LE(groupLength, 8);
                    groupDigest(header, groups++, row.subarray(0, 16), metadata).copy(row, 16);
                    pending += DIRECTORY_ENTRY;
                    if (pending === entries.length) {
                        write(spool, [entries]);
                        pending = 0;
                    }
                    write(output, [metadata, ...payloads]);
                    position += groupLength;
                    if (bytes.length < GROUP_BYTES) break;
                }
                if (initial) {
                    const final = fs.fstatSync(input, { bigint: true });
                    if (initial.size !== BigInt(rawSize) || initial.size !== final.size ||
                        initial.mtimeNs !== final.mtimeNs || initial.ctimeNs !== final.ctimeNs) {
                        throw Error("Input file changed while packing");
                    }
                }
                for (let at = 0, end = groups * DIRECTORY_ENTRY - pending; at < end; at += entries.length) {
                    const bytes = Buffer.allocUnsafe(Math.min(entries.length, end - at));
                    if (readInto(spool, bytes, at).length !== bytes.length) throw Error("Truncated index spool");
                    write(output, [bytes]);
                }
                if (pending) write(output, [entries.subarray(0, pending)]);
                const footer = Buffer.alloc(FOOTER);
                footer.writeBigUInt64LE(BigInt(rawSize));
                footer.writeBigUInt64LE(BigInt(position), 8);
                digest(header, footer.subarray(0, 16)).copy(footer, 16);
                END_MAGIC.copy(footer, 48);
                write(output, [footer]);
            } finally {
                if (spool !== undefined) fs.closeSync(spool);
                try {
                    fs.rmSync(file, { force: true });
                    fs.rmdirSync(temp);
                } catch (error) { process.emitWarning("Could not clean up v2 spool: " + error.message); }
            }
        });
    } finally {
        if (!stdin) fs.closeSync(input);
    }
}

function openArchive(filename) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < HEADER + FOOTER) {
            throw Error("Invalid v2 archive size");
        }
        const header = readExactly(fd, HEADER, 0);
        const footer = readExactly(fd, FOOTER, stat.size - FOOTER);
        if (!MAGIC.equals(header.subarray(0, 8)) || header.readUInt32LE(12) || !END_MAGIC.equals(footer.subarray(48))) {
            throw Error("Invalid v2 archive format");
        }
        if (!digest(header, footer.subarray(0, 16)).equals(footer.subarray(16, 48))) throw Error("Invalid v2 footer checksum");
        const size = Number(footer.readBigUInt64LE());
        const directory = Number(footer.readBigUInt64LE(8));
        const groups = Math.ceil(size / GROUP_BYTES);
        if (size > MAX_BYTES || directory < HEADER || directory > HEADER + size + groups * GROUP_HEADER ||
            directory + groups * DIRECTORY_ENTRY + FOOTER !== stat.size || (!groups && directory !== HEADER)) {
            throw Error("Invalid v2 directory bounds");
        }
        const seed = header.readUInt32LE(8);
        const dictionary = makeDictionary(seed);
        let closed = false;
        function* groupJobs(start, length, restore, transferable = false) {
            if (closed) throw Error("Archive is closed");
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start > size - length) {
                throw Error("Byte range exceeds archive");
            }
            if (!length) return;
            const end = start + length;
            const first = Math.floor(start / GROUP_BYTES);
            const last = Math.ceil(end / GROUP_BYTES);
            let expected = first === 0 ? HEADER : undefined;
            for (let group = first; group < last; group++) {
                if (closed) throw Error("Archive closed during traversal");
                const row = readExactly(fd, DIRECTORY_ENTRY, directory + group * DIRECTORY_ENTRY);
                const offset = Number(row.readBigUInt64LE());
                const stored = row.readUInt32LE(8);
                if (offset < HEADER || row.readUInt32LE(12) || (expected !== undefined && offset !== expected) ||
                    stored <= GROUP_HEADER || stored > GROUP_HEADER + GROUP_BYTES || offset > directory - stored ||
                    (group === groups - 1 && offset + stored !== directory)) throw Error("Invalid v2 group bounds");
                expected = offset + stored;
                const meta = readExactly(fd, GROUP_HEADER, offset);
                if (!groupDigest(header, group, row.subarray(0, 16), meta).equals(row.subarray(16))) {
                    throw Error("Invalid v2 group checksum at group " + group);
                }
                const base = group * GROUP_BYTES;
                let position = offset + GROUP_HEADER;
                const jobs = [];
                for (let slot = 0; slot < GROUP_CHUNKS; slot++) {
                    const entry = slot * CHUNK_ENTRY;
                    const startByte = base + slot * CHUNK_BYTES;
                    if (startByte >= size) {
                        if (meta.subarray(entry).some(Boolean)) throw Error("Nonzero unused v2 entry");
                        break;
                    }
                    const raw = Math.min(CHUNK_BYTES, size - startByte);
                    const storedBytes = meta.readUInt32LE(entry);
                    const mode = meta[entry + 4];
                    if (!storedBytes || mode > DEFLATE || meta.readUIntLE(entry + 5, 3) ||
                        (mode === RAW ? storedBytes !== raw : storedBytes >= raw) ||
                        (mode === PALETTE && storedBytes < 4) || position + storedBytes > expected) {
                        throw Error("Invalid v2 chunk entry");
                    }
                    if (startByte < end && startByte + raw > start) jobs.push({ position, storedBytes, mode, raw, startByte, entry });
                    position += storedBytes;
                }
                if (position !== expected) throw Error("Invalid v2 group length");
                const firstJob = jobs[0].position;
                const finalJob = jobs.at(-1);
                const storedLength = finalJob.position + finalJob.storedBytes - firstJob;
                const payload = transferable ? Buffer.allocUnsafeSlow(storedLength) : Buffer.allocUnsafe(storedLength);
                if (readInto(fd, payload, firstJob).length !== storedLength) throw Error("Truncated archive");
                const blocks = jobs.map(job => ({
                    offset: job.position - firstJob, stored: job.storedBytes, mode: job.mode,
                    rawLength: job.raw, base: job.startByte,
                    checksum: transferable ? Uint8Array.from(meta.subarray(job.entry + 8, job.entry + 24)) :
                        meta.subarray(job.entry + 8, job.entry + 24)
                }));
                yield { job: { payload, blocks, start: Math.max(start, base), end: Math.min(end, base + GROUP_BYTES),
                    restore, version: 2 }, transfer: transferable ? [payload.buffer] : [] };
            }
        }
        function visit(start, length, consume) {
            for (const { job: { payload, blocks, start: from, end: to } } of groupJobs(start, length, Boolean(consume))) {
                const decoded = [];
                for (const { mode, offset, stored, rawLength, base, checksum } of blocks) {
                    const raw = decodeBlock(mode, payload.subarray(offset, offset + stored), rawLength, dictionary);
                    if (!digest(raw).subarray(0, 16).equals(checksum)) throw Error("v2 chunk checksum mismatch at byte " + base);
                    if (consume) decoded.push(raw.subarray(Math.max(0, from - base), to - base));
                }
                if (consume) consume(decoded);
            }
        }
        async function transfer(start, length, output, workers = 1) {
            if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
                throw Error("Worker count must be between 1 and 16");
            }
            const consume = output === null ? undefined : blocks => write(output, blocks);
            if (workers === 1 || !length || Math.floor(start / GROUP_BYTES) === Math.floor((start + length - 1) / GROUP_BYTES)) {
                visit(start, length, consume);
                return;
            }
            const jobs = groupJobs(start, length, Boolean(consume), true);
            for await (const { output: decoded } of runOrdered(jobs, { seed, decode: true }, workers)) {
                if (consume) consume([decoded]);
            }
        }
        return {
            size, groups, fileSize: stat.size, visit, transfer,
            close() {
                if (!closed) {
                    closed = true;
                    fs.closeSync(fd);
                }
            }
        };
    } catch (error) {
        fs.closeSync(fd);
        throw error;
    }
}

function byteCount(text) {
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw Error("Expected a nonnegative byte count");
    return Number(text);
}

const commands = new Map([
    ["pack", "<input|-> <archive> [--fast-decode]"],
    ["verify", "<archive> [--workers=N]"],
    ["unpack", "<archive> <file> [--workers=N]"],
    ["read", "<archive> <offset> <length> <file> [--workers=N]"],
    ["info", "<archive>"]
]);
const syntax = command => "node symbol10.cjs v2 " + command + " " + commands.get(command);
const usage = [...commands.keys()].map(syntax).join("\n");

async function main([command, ...args]) {
    if (!command || command === "--help") return console.log(usage);
    if (!commands.has(command)) throw Error("Unknown v2 command: " + command + ". Run node symbol10.cjs v2 --help.");
    if (args.length === 1 && args[0] === "--help") return console.log(syntax(command));
    if (command === "pack" && (args.length === 2 || (args.length === 3 && args[2] === "--fast-decode"))) {
        await pack(args[0], args[1], args.length === 3);
        return;
    }
    const count = ({ verify: 1, unpack: 2, read: 4, info: 1 })[command];
    let workers = 1;
    if (command !== "info" && count !== undefined && args.length === count + 1 && args.at(-1).startsWith("--workers=")) {
        const value = args.pop().slice(10);
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 16) throw Error("Worker count must be between 1 and 16");
        workers = Number(value);
    }
    if (args.length !== count) {
        throw Error("Invalid arguments. Usage: " + syntax(command));
    }
    const archive = openArchive(args[0]);
    try {
        if (command === "info") console.log(JSON.stringify({ format: "S10ARC02", originalBytes: archive.size,
            archiveBytes: archive.fileSize, groups: archive.groups }));
        else if (command === "verify") {
            await archive.transfer(0, archive.size, null, workers);
            console.log("v2 archive verified");
        } else {
            const range = command === "read";
            const start = range ? byteCount(args[1]) : 0;
            const length = range ? byteCount(args[2]) : archive.size;
            await publishFile(args[range ? 3 : 1], output => archive.transfer(start, length, output, workers));
        }
    } finally { archive.close(); }
}

module.exports = { main, openArchive };

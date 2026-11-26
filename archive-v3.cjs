"use strict";

const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { digest, readInto } = require("./archive-format.cjs");
const { publishFile } = require("./publish-file.cjs");
const { runOrdered } = require("./codec-worker.cjs");
const { MAGIC, MAGIC_RESILIENT, CHUNK, SLOTS, MAX, PREFIX, ENTRY, BODY, MANIFEST, RAW, DEFLATE, ZSTD,
    manifest, seal, encodeGroup, prepareDecodeGroup, decodeGroup } = require("./archive-v3-group.cjs");

function writeAll(fd, parts) {
    let at = 0;
    while (at < parts.length) {
        let n = fs.writevSync(fd, parts.slice(at));
        if (n <= 0) throw Error("Could not finish writing the output file");
        while (at < parts.length && n >= parts[at].length) n -= parts[at++].length;
        if (n) parts[at] = parts[at].subarray(n);
    }
}

function openInput(filename) {
    return fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
}

async function* processGroups(jobs, kind, workers) {
    if (workers === 1) {
        const handle = kind === "pack" ? encodeGroup : decodeGroup;
        for (const { job } of jobs) yield { ...handle({ ...job, vectored: true }), sequence: job.group };
        return;
    }
    yield* runOrdered(jobs, { v3: kind }, workers);
}

function* decodeBatch(batch, decoder) {
    const prepared = batch.map(prepareDecodeGroup);
    const blocks = [];
    const results = batch.map(({ entries, range, firstSlot }, group) => {
        const decoded = [];
        for (const [slot, entry] of entries.entries()) {
            const offset = ((firstSlot ?? 0) + slot) * CHUNK;
            if (entry.mode === RAW || (range && (offset >= range.to || offset + entry.raw <= range.from))) continue;
            blocks.push({ mode: entry.mode, length: entry.raw, payload: prepared[group].payloads[slot], decoded, slot });
        }
        return decoded;
    });
    if (blocks.length) {
        const output = decoder.decode(blocks);
        if (!Array.isArray(output) || output.length !== blocks.length) throw Error("Incomplete GPU decode");
        for (const [i, { decoded, slot, length }] of blocks.entries()) {
            const bytes = output[i];
            if (!Buffer.isBuffer(bytes) || bytes.length !== length) throw Error("Incomplete GPU decode");
            decoded[slot] = bytes;
        }
    }
    const extracts = batch[0].command === "unpack" || batch[0].command === "read";
    const parts = [];
    let repairs = 0;
    for (const [i, job] of batch.entries()) {
        const result = decodeGroup(job, prepared[i], results[i]);
        if (!extracts) {
            yield { ...result, sequence: job.group };
            continue;
        }
        repairs += result.repairs;
        for (const part of result.parts ?? [result.output]) {
            const previous = parts.at(-1);
            if (previous?.buffer === part.buffer && previous.byteOffset + previous.length === part.byteOffset) {
                parts[parts.length - 1] = Buffer.from(part.buffer, previous.byteOffset, previous.length + part.length);
            } else {
                parts.push(part);
            }
        }
    }
    if (extracts) yield { parts, repairs };
}

function* decodeBatches(jobs, decoder) {
    let batch = [];
    for (const { job } of jobs) {
        batch.push({ ...job, vectored: true });
        if (batch.length === decoder.groupsPerBatch) {
            yield* decodeBatch(batch, decoder);
            batch = [];
        }
    }
    if (batch.length) yield* decodeBatch(batch, decoder);
}

async function pack(source, destination, portable, workers, resilient) {
    const stdin = source === "-";
    const fd = stdin ? 0 : openInput(source);
    try {
        const original = stdin ? undefined : fs.fstatSync(fd, { bigint: true });
        if (original && (!original.isFile() || original.size > BigInt(MAX))) {
            throw Error("Expected a regular input file of at most 1 TiB (or - for binary stdin)");
        }
        if (original?.size <= BigInt(CHUNK * SLOTS)) workers = 1;
        let result;
        await publishFile(destination, async out => {
            result = await writeArchive(out, target => readInto(fd, target, null), {
                portable, workers, resilient,
                finish(bytes) {
                    if (original && (original.size !== BigInt(bytes) || !unchanged(fd, original))) {
                        throw Error("Input file changed while packing; no archive was saved");
                    }
                }
            });
        });
        return result;
    } finally {
        if (!stdin) fs.closeSync(fd);
    }
}

function unchanged(fd, original) {
    const final = fs.fstatSync(fd, { bigint: true });
    return final.size === original.size && final.mtimeNs === original.mtimeNs && final.ctimeNs === original.ctimeNs;
}

function pooledBuffer(workspace, length) {
    if (!workspace.buffer || workspace.buffer.length < length) workspace.buffer = Buffer.allocUnsafeSlow(length);
    return workspace.buffer.subarray(0, length);
}

async function writeArchive(out, readGroup, { portable, workers = 1, resilient, workspace = {}, finish }) {
    const shared = workers === 1 ? workspace : undefined;
    const summary = createHash("sha256");
    const modes = [0, 0, 0];
    let bytes = 0, groups = 0, archiveBytes = 0;
    function* jobs() {
        for (;;) {
            const target = shared ? pooledBuffer(shared, CHUNK * SLOTS) : Buffer.allocUnsafeSlow(CHUNK * SLOTS);
            const rawGroup = readGroup(target);
            if (!rawGroup.length) break;
            if (rawGroup.length > MAX - bytes) throw Error("v3 archive limit is 1 TiB");
            const job = { input: rawGroup, group: groups++, priorBytes: bytes, portable, resilient, workspace: shared };
            bytes += rawGroup.length;
            const final = rawGroup.length < CHUNK * SLOTS;
            yield { job, transfer: shared ? [] : [rawGroup.buffer] };
            if (final) break;
        }
    }
    for await (const { output, parts = [output], modes: selected } of processGroups(jobs(), "pack", workers)) {
        summary.update(parts[0].subarray(0, MANIFEST));
        archiveBytes += parts.reduce((n, part) => n + part.length, 0);
        writeAll(out, parts);
        for (let i = 0; i < modes.length; i++) modes[i] += selected[i];
    }
    finish?.(bytes);
    const end = manifest(groups, bytes, 0, resilient);
    summary.digest().copy(end, 32);
    seal(end);
    writeAll(out, [end, end]);
    return { bytes, archiveBytes: archiveBytes + 2 * MANIFEST, groups, raw: modes[RAW], deflate: modes[DEFLATE], zstd: modes[ZSTD] };
}

async function scan(fd, out, command, workers, range, {
    start = 0, length, workspace = {}, consume, expectedBytes, requireResilient = false
} = {}) {
    const stat = fs.fstatSync(fd, { bigint: true });
    const size = length ?? Number(stat.size);
    if (!stat.isFile() || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) ||
        size < 2 * MANIFEST || size > 2 * MAX || BigInt(start) + BigInt(size) > stat.size) {
        throw Error("Not a supported Symbol10 archive, or the archive is truncated");
    }
    let at = 0, groups = 0, bytes = 0, repairs = 0, finalGroup = false;
    const summary = createHash("sha256");
    let terminator, resilient;
    const pendingManifests = new Map();
    const decoder = workers === 1 ? workspace.decoder : undefined;
    const frames = decoder ? (workspace.frames ??= []) : undefined;
    let frameSlot = 0;
    function readAt(position, length, payload = false) {
        if (length > size - position) throw Error("Archive is truncated at group " + (groups + 1));
        let target;
        if (!payload) target = Buffer.allocUnsafe(length);
        else if (workers !== 1) target = Buffer.allocUnsafeSlow(length);
        else {
            // The serial consumer writes or verifies the frame before the next read.
            target = pooledBuffer(frames ? (frames[frameSlot] ??= {}) : workspace, length);
        }
        const result = readInto(fd, target, start + position);
        if (result.length !== length) throw Error("Archive changed or was truncated while reading");
        return result;
    }
    function advance(length) {
        if (length > size - at) throw Error("Archive is truncated at group " + (groups + 1));
        const start = at;
        at += length;
        return start;
    }
    function valid(info) {
        const magic = info.subarray(0, 8);
        return (magic.equals(MAGIC) || magic.equals(MAGIC_RESILIENT)) && info.readBigUInt64LE(8) === BigInt(groups) &&
            info.readBigUInt64LE(16) === BigInt(bytes) && digest(info.subarray(0, BODY)).equals(info.subarray(BODY));
    }
    function* jobs() {
        for (;;) {
            const copies = readAt(advance(2 * MANIFEST), 2 * MANIFEST);
            const first = copies.subarray(0, MANIFEST), second = copies.subarray(MANIFEST);
            const a = valid(first), b = first.equals(second) ? a : valid(second);
            if ((!a && !b) || (a && b && !first.equals(second))) {
                throw Error("Cannot recover archive metadata at group " + (groups + 1));
            }
            if (!a || !b) repairs++;
            const info = a ? first : second;
            const version = info.subarray(0, 8).equals(MAGIC_RESILIENT);
            if (requireResilient && !version) throw Error("Expected a two-shard archive");
            if (resilient !== undefined && version !== resilient) throw Error("Mixed archive formats at group " + (groups + 1));
            resilient = version;
            const count = info.readUInt32LE(24);
            const parityLength = info.readUInt32LE(28);
            const check = info.subarray(32, 64);
            if (!count) {
                if (parityLength || at !== size || info.subarray(PREFIX, BODY).some(Boolean) || !summary.digest().equals(check)) {
                    throw Error("Invalid archive terminator or unexpected trailing data");
                }
                if (range && range.end > bytes) throw Error("Byte range exceeds archive");
                if (expectedBytes !== undefined && bytes !== expectedBytes) throw Error("Decoded size disagrees with the catalog");
                terminator = info;
                return;
            }
            if (finalGroup || count > SLOTS || !parityLength || parityLength > CHUNK ||
                info.subarray(PREFIX + count * ENTRY, BODY).some(Boolean)) throw Error("Invalid v3 group layout");
            const entries = [];
            let largest = 0;
            let storedBytes = 0;
            let groupBytes = 0;
            for (let slot = 0; slot < count; slot++) {
                const pos = PREFIX + slot * ENTRY;
                const mode = info.readUInt32LE(pos);
                const stored = info.readUInt32LE(pos + 4);
                const raw = info.readUInt32LE(pos + 8);
                if (mode > ZSTD || !raw || raw > CHUNK || (slot < count - 1 && raw !== CHUNK) || !stored ||
                    (mode === RAW ? stored !== raw : stored >= raw)) throw Error("Invalid v3 chunk bounds at group " + (groups + 1));
                entries.push({ mode, stored, raw, encodedHash: info.subarray(pos + 12, pos + 44), plainHash: info.subarray(pos + 44, pos + 76) });
                largest = Math.max(largest, stored);
                groupBytes += raw;
                storedBytes += stored;
            }
            if (largest !== parityLength || groupBytes > (expectedBytes ?? MAX) - bytes) throw Error("Invalid v3 parity or output size");
            summary.update(info);
            finalGroup = groupBytes < SLOTS * CHUNK;
            const frameLength = storedBytes + (resilient ? 2 : 1) * parityLength;
            const frameStart = advance(frameLength);
            const group = groups++;
            const base = bytes;
            bytes += groupBytes;
            const job = { entries, group, groupBytes, parityHash: check, parityLength, command, resilient };
            if (range) {
                const from = Math.max(range.start, base) - base;
                const to = Math.min(range.end, bytes) - base;
                if (from >= to) continue;
                const firstSlot = Math.floor(from / CHUNK);
                const endSlot = Math.ceil(to / CHUNK);
                const offset = entries.slice(0, firstSlot).reduce((n, entry) => n + entry.stored, 0);
                const selected = entries.slice(firstSlot, endSlot);
                const length = selected.reduce((n, entry) => n + entry.stored, 0);
                const candidate = readAt(frameStart + offset, length, true);
                let cursor = 0;
                const intact = selected.every(entry => {
                    const start = cursor;
                    cursor += entry.stored;
                    return digest(candidate.subarray(start, cursor)).equals(entry.encodedHash);
                });
                job.range = { from, to };
                if (intact) {
                    job.input = candidate;
                    job.entries = selected;
                    job.firstSlot = firstSlot;
                }
            }
            job.input ??= readAt(frameStart, frameLength, true);
            if (command === "repair") pendingManifests.set(group, info);
            if (decoder) frameSlot = (frameSlot + 1) % decoder.groupsPerBatch;
            yield { job, transfer: workers === 1 ? [] : [job.input.buffer] };
        }
    }
    const decoded = decoder ? decodeBatches(jobs(), decoder) : processGroups(jobs(), "restore", workers);
    for await (const { output, parts, repairs: recovered, sequence } of decoded) {
        repairs += recovered;
        if (command === "repair") {
            const info = pendingManifests.get(sequence);
            writeAll(out, [info, info, output]);
            pendingManifests.delete(sequence);
        } else if (command === "unpack" || command === "read") {
            if (consume) for (const part of parts ?? [output]) consume(part);
            else writeAll(out, parts ?? [output]);
        }
    }
    if (!unchanged(fd, stat)) throw Error("Archive changed while reading");
    if (command === "repair") writeAll(out, [terminator, terminator]);
    return { groups, bytes: range ? range.end - range.start : bytes, repairs };
}

async function restore(command, source, destination, workers, range) {
    const fd = openInput(source);
    try {
        if (command === "verify") return await scan(fd, undefined, command, workers);
        let report;
        await publishFile(destination, async out => { report = await scan(fd, out, command, workers, range); });
        return report;
    } finally { fs.closeSync(fd); }
}

const commands = {
    pack: "<file|-> <archive> [--portable] [--resilient]",
    unpack: "<archive> <new-file>",
    read: "<archive> <offset> <length> <new-file>",
    verify: "<archive>",
    repair: "<archive> <new-archive>"
};
const syntax = (command, prefix) => prefix + " " + command + " " + commands[command] + " [--workers=N]";

async function main([command, ...args], prefix = "node symbol10.cjs v3") {
    if (!command || command === "--help") return console.log(Object.keys(commands).map(key => syntax(key, prefix)).join("\n"));
    if (!Object.hasOwn(commands, command)) throw Error("Unknown v3 command: " + command + ". Run " + prefix + " --help.");
    if (args.length === 1 && args[0] === "--help") return console.log(syntax(command, prefix));
    const positional = command === "verify" ? 1 : command === "read" ? 4 : 2;
    let portable = false, resilient = false, workers = 1;
    const flags = args.splice(positional);
    const seen = new Set();
    for (const flag of flags) {
        const key = flag.split("=", 1)[0];
        if (seen.has(key)) throw Error("Repeated option: " + key);
        seen.add(key);
        if (command === "pack" && flag === "--portable") portable = true;
        else if (command === "pack" && flag === "--resilient") resilient = true;
        else if (key === "--workers") {
            const value = flag.slice(10);
            if (!/^\d+$/.test(value) || +value < 1 || +value > 8) throw Error("Worker count must be between 1 and 8");
            workers = +value;
        } else throw Error("Unknown v3 option: " + flag);
    }
    if (args.length !== positional) throw Error("Usage: " + syntax(command, prefix));
    if (command === "pack") {
        const result = await pack(args[0], args[1], portable, workers, resilient);
        const ratio = result.bytes ? " (" + (100 * result.archiveBytes / result.bytes).toFixed(2) + "% of original)" : "";
        console.log((resilient ? "Packed with two recovery shards per group: " : "Packed ") + result.bytes + " bytes into " + result.archiveBytes + " bytes" + ratio +
            "; chunks: " + result.zstd + " Zstandard, " + result.deflate + " DEFLATE, " + result.raw + " raw.");
    } else {
        let range;
        if (command === "read") {
            const [start, length] = args.slice(1, 3).map(text => /^\d+$/.test(text) ? Number(text) : NaN);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start > MAX || length > MAX - start) {
                throw Error("Expected a nonnegative byte offset and length within the 1 TiB limit");
            }
            range = { start, end: start + length };
        }
        const result = await restore(command, args[0], range ? args[3] : args[1], workers, range);
        if (range) {
            console.log("Read " + result.bytes + " verified bytes. Recovered " + result.repairs +
                " damaged archive part(s) encountered; unrelated payloads were not verified.");
            return;
        }
        const action = { unpack: "Restored", verify: "Verified", repair: "Wrote verified archive for" }[command];
        console.log(action + " " + result.bytes + " bytes. " + (result.repairs ?
            "Recovered " + result.repairs + " damaged archive part(s). " + (command === "repair" ? "Original left unchanged." : "Original unchanged; use repair to save a clean copy.") : "No damage found."));
    }
}

module.exports = { main, scan, writeArchive, writeAll, openInput, unchanged };

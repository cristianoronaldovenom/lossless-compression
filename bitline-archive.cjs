"use strict";

const fs = require("node:fs");
const { isUtf8 } = require("node:buffer");
const { digest, readInto } = require("./archive-format.cjs");
const { MANIFEST, MAX } = require("./archive-v3-group.cjs");
const { openInput, scan, unchanged, writeAll, writeArchive } = require("./archive-v3.cjs");
const { publishFile } = require("./publish-file.cjs");
const { FILTER_BYTES, MAX_QUERY_BYTES, addGrams, queryFilter, matcher } = require("./bitline-search.cjs");

const MAGIC = Buffer.from("BITLINE1");
const FOOTER = 88;
const MAX_CATALOG = 8 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_BITS = 1024 * 1024;
const MAX_HITS = 10000;
const MIN_ENTRY = 2 * MANIFEST;
const BIT_TEXT = Buffer.from(Array.from({ length: 256 }, (_, n) => n.toString(2).padStart(8, "0")).join(""));

function integer(value, min, max) {
    return Number.isSafeInteger(value) && value >= min && value <= max;
}

function validName(name) {
    return typeof name === "string" && name.length > 0 && Buffer.byteLength(name) <= 512 &&
        !/[\u0000-\u001f]/.test(name) && Buffer.from(name).toString() === name;
}

function packBits(text, target) {
    const result = target.subarray(0, Math.ceil(text.length / 8)).fill(0);
    for (let bit = 0; bit < text.length; bit++) result[bit >>> 3] |= (text.charCodeAt(bit) & 1) << (7 - (bit & 7));
    return result;
}

function writeCatalog(out, end, encoded) {
    if (encoded.length > MAX_CATALOG) throw Error("Bitline catalog exceeds 8 MiB");
    const footer = Buffer.alloc(FOOTER);
    MAGIC.copy(footer);
    footer.writeBigUInt64LE(BigInt(end), 8);
    footer.writeUInt32LE(encoded.length, 16);
    digest(encoded).copy(footer, 24);
    digest(footer.subarray(0, 56)).copy(footer, 56);
    writeAll(out, [encoded, encoded, footer, footer]);
}

function readAt(fd, start, length) {
    const bytes = readInto(fd, Buffer.allocUnsafe(length), start);
    if (bytes.length !== length) throw Error("Truncated Bitline catalog");
    return bytes;
}

function loadCatalog(fd, stat) {
    if (!stat.isFile() || stat.size < BigInt(2 * FOOTER + MIN_ENTRY) ||
        stat.size > BigInt(2 * MAX + 2 * MAX_CATALOG + 2 * FOOTER)) throw Error("Invalid Bitline bundle size");
    const size = Number(stat.size);
    const copies = readAt(fd, size - 2 * FOOTER, 2 * FOOTER);
    const first = copies.subarray(0, FOOTER), second = copies.subarray(FOOTER);
    const valid = footer => footer.subarray(0, 8).equals(MAGIC) && !footer.readUInt32LE(20) &&
        digest(footer.subarray(0, 56)).equals(footer.subarray(56));
    const a = valid(first), b = first.equals(second) ? a : valid(second);
    if ((!a && !b) || (a && b && !first.equals(second))) throw Error("Cannot recover Bitline catalog footer");
    const footer = a ? first : second;
    const end = Number(footer.readBigUInt64LE(8)), length = footer.readUInt32LE(16);
    if (!integer(end, MIN_ENTRY, 2 * MAX) || !integer(length, 2, MAX_CATALOG) ||
        end + 2 * length + 2 * FOOTER !== size) throw Error("Invalid Bitline catalog bounds");
    const check = footer.subarray(24, 56);
    const primary = readAt(fd, end, length);
    const backup = readAt(fd, end + length, length);
    const good = digest(primary).equals(check);
    const goodBackup = primary.equals(backup) ? good : digest(backup).equals(check);
    if (!good && !goodBackup) throw Error("Cannot recover Bitline catalog");
    const encoded = good ? primary : backup;
    if (!isUtf8(encoded)) throw Error("Invalid Bitline catalog encoding");
    const entries = JSON.parse(encoded.toString());
    if (!Array.isArray(entries) || !integer(entries.length, 1, MAX_ENTRIES)) throw Error("Invalid Bitline catalog entry count");
    const dictionary = new Map();
    let position = 0;
    for (const entry of entries) {
        if (!entry || !validName(entry.name) || dictionary.has(entry.name) || entry.position !== position ||
            !integer(entry.size, MIN_ENTRY, end - position) || !integer(entry.bytes, 0, MAX) ||
            !integer(entry.executable, 0, 0o111) || (entry.executable & ~0o111)) throw Error("Invalid Bitline catalog entry");
        if (entry.kind === "bits") {
            if (!integer(entry.bits, 0, MAX_BITS) || entry.bytes !== Math.ceil(entry.bits / 8) ||
                entry.filter !== null || entry.executable) throw Error("Invalid Bitline bit entry");
        } else if (entry.kind !== "file" || entry.bits !== null ||
            (entry.filter !== null && (typeof entry.filter !== "string" ||
            entry.filter.length !== Math.ceil(FILTER_BYTES / 3) * 4 ||
            Buffer.from(entry.filter, "base64").length !== FILTER_BYTES))) throw Error("Invalid Bitline file entry");
        dictionary.set(entry.name, entry);
        position += entry.size;
    }
    if (position !== end) throw Error("Bitline catalog does not cover its payload");
    return { dictionary, end, encoded, repairs: Number(!a || !b) + Number(!good || !goodBackup) };
}

async function encode(destination, sources, portable, workspace = {}) {
    await publishFile(destination, async out => {
        const entries = [];
        let position = 0;
        for (const source of sources) {
            let result, filter = null, executable = 0;
            if (source.kind === "bits") {
                // The maximum packed bit literal fits in one archive group.
                result = await writeArchive(out, target => packBits(source.value, target), { workspace, portable, resilient: true });
            } else {
                const fd = openInput(source.value);
                try {
                    const stat = fs.fstatSync(fd, { bigint: true });
                    if (!stat.isFile() || stat.size > BigInt(MAX)) throw Error("Expected a regular file of at most 1 TiB: " + source.value);
                    executable = process.platform === "win32" ? 0 : Number(stat.mode & 0o111n);
                    const grams = addGrams();
                    result = await writeArchive(out, target => {
                        const raw = readInto(fd, target, null);
                        grams.add(raw);
                        return raw;
                    }, {
                        workspace, portable, resilient: true,
                        finish(bytes) {
                            if (BigInt(bytes) !== stat.size || !unchanged(fd, stat)) {
                                throw Error("Input changed while encoding: " + source.value);
                            }
                        }
                    });
                    filter = grams.finish();
                } finally { fs.closeSync(fd); }
            }
            entries.push({ name: source.name, kind: source.kind, position, size: result.archiveBytes, bytes: result.bytes,
                bits: source.kind === "bits" ? source.value.length : null, executable, filter });
            position += result.archiveBytes;
            if (position > 2 * MAX) throw Error("Bitline bundle exceeds 2 TiB");
        }
        writeCatalog(out, position, Buffer.from(JSON.stringify(entries)));
    });
}

async function withBundle(filename, operation, cache) {
    const fd = openInput(filename);
    try {
        const stat = fs.fstatSync(fd, { bigint: true });
        const previous = cache?.snapshot;
        const old = previous?.stat;
        const catalog = old && previous.filename === filename && old.dev === stat.dev && old.ino === stat.ino &&
            old.size === stat.size && old.mtimeNs === stat.mtimeNs && old.ctimeNs === stat.ctimeNs
            ? previous.catalog : loadCatalog(fd, stat);
        let checked = false;
        const check = () => {
            if (!unchanged(fd, stat)) throw Error("Bitline bundle changed while reading");
            checked = true;
        };
        const result = await operation(fd, catalog, check);
        if (!checked) check();
        if (cache) cache.snapshot = { filename, stat, catalog };
        return result;
    } finally { fs.closeSync(fd); }
}

function describe(entry) {
    return entry ? { name: entry.name, kind: entry.kind, bytes: entry.bytes, bits: entry.bits ?? entry.bytes * 8 } : null;
}

function list(filename, name, cache) {
    return withBundle(filename, (_fd, { dictionary }) => (
        name === undefined ? Array.from(dictionary.values(), describe) : describe(dictionary.get(name))
    ), cache);
}

function readEntry(fd, out, command, entry, workspace, consume) {
    return scan(fd, out, command, 1, undefined, {
        start: entry.position, length: entry.size, expectedBytes: entry.bytes, workspace, consume, requireResilient: true
    });
}

function visitBits(fd, entry, workspace, out) {
    const buffer = out === undefined ? undefined : (workspace.bitText ??= Buffer.allocUnsafe(65536));
    let remaining = entry.bits;
    return readEntry(fd, undefined, "unpack", entry, workspace, bytes => {
        let used = 0;
        for (const byte of bytes) {
            const live = Math.min(8, remaining);
            if (live < 1 || (live < 8 && (byte & ((1 << (8 - live)) - 1)))) throw Error("Invalid Bitline symbol padding");
            remaining -= live;
            if (!buffer) continue;
            BIT_TEXT.copy(buffer, used, byte * 8, byte * 8 + live);
            used += live;
            if (used === buffer.length) {
                writeAll(out, [buffer]);
                used = 0;
            }
        }
        if (used) writeAll(out, [buffer.subarray(0, used)]);
    });
}

function restore(filename, name, destination, cache) {
    return withBundle(filename, async (fd, { dictionary }, check) => {
        const entry = dictionary.get(name);
        if (!entry) throw Error("Unknown Bitline name: " + name);
        const workspace = cache?.workspace ?? {};
        await publishFile(destination, async out => {
            if (entry.kind === "bits") await visitBits(fd, entry, workspace, out);
            else await readEntry(fd, out, "unpack", entry, workspace);
            if (process.platform !== "win32" && entry.executable) fs.fchmodSync(out, 0o600 | entry.executable);
            check();
        });
    }, cache);
}

function verify(filename, destination, cache) {
    return withBundle(filename, async (fd, catalog, check) => {
        const workspace = cache?.workspace ?? {};
        let repairs = catalog.repairs;
        if (destination === undefined) {
            for (const entry of catalog.dictionary.values()) {
                const result = entry.kind === "bits" ? await visitBits(fd, entry, workspace) :
                    await readEntry(fd, undefined, "verify", entry, workspace);
                repairs += result.repairs;
            }
        } else {
            await publishFile(destination, async out => {
                for (const entry of catalog.dictionary.values()) {
                    if (entry.kind === "bits") await visitBits(fd, entry, workspace);
                    const result = await readEntry(fd, out, "repair", entry, workspace);
                    repairs += result.repairs;
                }
                check();
                writeCatalog(out, catalog.end, catalog.encoded);
            });
        }
        return { entries: catalog.dictionary.size, repairs };
    }, cache);
}

function find(filename, text, limit, cache) {
    const query = Buffer.from(text);
    const accepts = queryFilter(query), match = matcher(query);
    return withBundle(filename, async (fd, { dictionary }) => {
        const workspace = cache?.workspace ?? {};
        const hits = [];
        for (const entry of dictionary.values()) {
            if (entry.kind !== "file" || query.length > entry.bytes || !accepts(entry.filter)) continue;
            await readEntry(fd, undefined, "unpack", entry, workspace,
                match(limit - hits.length, offset => hits.push({ name: entry.name, offset })));
            if (hits.length === limit) break;
        }
        return hits;
    }, cache);
}

module.exports = { MAX_ENTRIES, MAX_BITS, MAX_QUERY_BYTES, MAX_HITS, validName, encode, list, restore, verify, find };

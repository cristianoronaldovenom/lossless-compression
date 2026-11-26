"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { publishFile } = require("./publish-file.cjs");
const os = require("node:os");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const assert = require("node:assert/strict");
const { SYMBOL_COUNT, CHUNK_BYTES, RAW, PALETTE, DEFLATE,
    makeDictionary, encodeBlock, decodeBlock, paletteLayout, encodePalette, decodePalette } = require("./block-codec.cjs");

const { HEADER_BYTES, ENTRY_BYTES, FOOTER_BYTES, MAX_BYTES, MAGIC, END_MAGIC, digest, readInto, inspectArchive } = require("./archive-format.cjs");
const INDEX_PAGE_BYTES = 64 * 1024;

function writeAll(fd, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (!written) throw new Error("Could not complete write");
        offset += written;
    }
}

function writeBatch(fd, buffers) {
    while (buffers.length) {
        let written = fs.writevSync(fd, buffers);
        if (written <= 0) throw Error("Could not complete batch write");
        let index = 0;
        while (index < buffers.length && written >= buffers[index].byteLength) {
            written -= buffers[index++].byteLength;
        }
        buffers = buffers.slice(index);
        if (written) buffers[0] = buffers[0].subarray(written);
    }
}

function archiveWriter(output) {
    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.copy(header);
    const seed = crypto.randomBytes(4).readUInt32LE();
    header.writeUInt32LE(seed, 8);
    const pages = [];
    let indexLength = 0;
    let originalSize = 0;
    let position = HEADER_BYTES;
    writeAll(output, header);

    return {
        seed,
        append({ rawLength, mode, bytes, checksum }) {
            originalSize += rawLength;
            if (originalSize > MAX_BYTES) throw new Error("Archive limit is 64 GiB");
            const offset = indexLength % INDEX_PAGE_BYTES;
            if (offset === 0) pages.push(Buffer.alloc(INDEX_PAGE_BYTES));
            const page = pages[pages.length - 1];
            page.writeBigUInt64LE(BigInt(position), offset);
            page.writeUInt32LE(bytes.length, offset + 8);
            page[offset + 12] = mode;
            page.set(checksum, offset + 16);
            indexLength += ENTRY_BYTES;
            writeAll(output, bytes);
            position += bytes.length;
        },
        finish() {
            const footer = Buffer.alloc(FOOTER_BYTES);
            footer.writeBigUInt64LE(BigInt(originalSize));
            footer.writeBigUInt64LE(BigInt(position), 8);
            END_MAGIC.copy(footer, 48);
            const hash = crypto.createHash("sha256").update(header);
            let remaining = indexLength;
            for (const page of pages) {
                const part = page.subarray(0, remaining);
                hash.update(part);
                writeAll(output, part);
                remaining -= part.length;
            }
            hash.update(footer.subarray(0, 16)).digest().copy(footer, 16);
            writeAll(output, footer);
            return { originalSize, archiveSize: position + indexLength + FOOTER_BYTES };
        }
    };
}

async function encodeArchive(output, chunks, fastDecode, workers) {
    const writer = archiveWriter(output);
    if (workers === 1) {
        const dictionary = makeDictionary(writer.seed);
        for await (const raw of chunks) {
            writer.append({ rawLength: raw.length, ...encodeBlock(raw, dictionary, fastDecode),
                checksum: digest(raw).subarray(0, 16) });
        }
        return writer.finish();
    }

    const { runOrdered } = require("./codec-worker.cjs");
    async function* jobs() {
        let originalSize = 0;
        for await (const raw of chunks) {
            originalSize += raw.length;
            if (originalSize > MAX_BYTES) throw Error("Archive limit is 64 GiB");
            // The producer reuses its read buffer. Transfer an owned snapshot.
            const copy = Uint8Array.from(raw);
            yield { job: copy, transfer: [copy.buffer] };
        }
    }
    for await (const encoded of runOrdered(jobs(), { seed: writer.seed, fastDecode }, workers)) {
        writer.append(encoded);
    }
    return writer.finish();
}

function* fileChunks(input) {
    const scratch = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
        const raw = readInto(input, scratch, null);
        if (!raw.length) return;
        yield raw;
    }
}

async function pack(source, destination, fastDecode = false, workers = 1) {
    const stdin = source === "-";
    const input = stdin ? 0 : fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    let sizes;
    try {
        const before = stdin ? undefined : fs.fstatSync(input, { bigint: true });
        if (before && !before.isFile()) throw Error("Expected a regular input file or binary stdin");
        if (before && before.size > BigInt(MAX_BYTES)) throw Error("Archive limit is 64 GiB");
        await publishFile(destination, async output => {
            sizes = await encodeArchive(output, fileChunks(input), fastDecode, workers);
            if (before) {
                const after = fs.fstatSync(input, { bigint: true });
                if (before.size !== BigInt(sizes.originalSize) || before.size !== after.size ||
                    before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
                    throw Error("Input file changed while packing");
                }
            }
        });
    } finally {
        if (!stdin) fs.closeSync(input);
    }
    return sizes;
}

async function* downloadChunks(body, awaitNetwork, maxBytes, hash) {
    if (!body) return;
    const scratch = Buffer.allocUnsafe(CHUNK_BYTES);
    let used = 0, received = 0;
    const reader = body.getReader();
    try {
        for (;;) {
            const { done, value: incoming } = await awaitNetwork("reading the response body", () => reader.read());
            if (done) break;
            received += incoming.byteLength;
            if (received > maxBytes) throw Error("Download exceeds " + maxBytes + " bytes");
            hash?.update(incoming);
            const bytes = Buffer.from(incoming.buffer, incoming.byteOffset, incoming.byteLength);
            let position = 0;
            while (position < bytes.length) {
                const copied = bytes.copy(scratch, used, position, position + scratch.length - used);
                position += copied;
                used += copied;
                if (used === scratch.length) {
                    yield scratch;
                    used = 0;
                }
            }
        }
        if (used) yield scratch.subarray(0, used);
    } finally {
        reader.releaseLock();
    }
}

async function download(url, destination, { fastDecode = false, workers = 1, timeoutMs = 30_000,
    maxBytes = MAX_BYTES, expectedDigest } = {}) {
    const address = new URL(url);
    if (address.protocol !== "https:" && address.protocol !== "http:") throw new Error("Expected an HTTP or HTTPS URL");
    const abort = new AbortController();
    const timeout = Error("Download timed out after " + timeoutMs + " ms without network progress");
    async function awaitNetwork(stage, operation) {
        const timer = setTimeout(() => abort.abort(timeout), timeoutMs);
        timer.unref();
        try { return await operation(); }
        catch (error) {
            if (abort.signal.reason === timeout) throw timeout;
            throw Error("Download failed while " + stage + " from " + address.origin + ": " +
                (error.cause?.code ?? error.message), { cause: error });
        } finally { clearTimeout(timer); }
    }
    let sizes;
    try {
        await publishFile(destination, async output => {
            const response = await awaitNetwork("waiting for headers", () => fetch(address, {
                signal: abort.signal,
                headers: { "Accept-Encoding": "identity" }
            }));
            if (!response.ok || response.status === 206) {
                throw new Error("Download failed with HTTP status " + response.status);
            }
            const length = response.headers.get("content-length");
            const unencoded = !response.headers.get("content-encoding") ||
                response.headers.get("content-encoding") === "identity";
            if (unencoded && length !== null && Number(length) > maxBytes) {
                throw Error("Download exceeds " + maxBytes + " bytes");
            }
            const hash = expectedDigest ? crypto.createHash("sha256") : undefined;
            sizes = await encodeArchive(output, downloadChunks(response.body, awaitNetwork, maxBytes, hash), fastDecode, workers);
            if (unencoded && length !== null && sizes.originalSize !== Number(length)) {
                throw new Error("Download length mismatch");
            }
            if (hash && hash.digest("hex") !== expectedDigest) throw Error("Download SHA-256 mismatch");
        });
    } finally {
        abort.abort();
    }
    return sizes;
}

function archiveInfo(source) {
    const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const archive = inspectArchive(fd);
        const counts = [0, 0, 0];
        for (let entry = 0; entry < archive.index.length; entry += ENTRY_BYTES) {
            counts[archive.index[entry + 12]]++;
        }
        return {
            format: "S10ARC01",
            originalBytes: archive.rawSize,
            archiveBytes: archive.fileSize,
            blocks: { raw: counts[RAW], palette: counts[PALETTE], deflate: counts[DEFLATE] },
            firmwareCompatibleModes: counts[DEFLATE] === 0
        };
    } finally { fs.closeSync(fd); }
}

const BATCH_BLOCKS = 128;

function prepareBatch(fd, archive, first, last, gpu, scratch, flush = false) {
    const entryOffset = block => Number(archive.index.readBigUInt64LE(block * ENTRY_BYTES));
    const base = entryOffset(first);
    const byteLength = entryOffset(last - 1) + archive.index.readUInt32LE((last - 1) * ENTRY_BYTES + 8) - base;
    // Eight guard bytes support unaligned index reads at the end of a device batch.
    if (scratch && scratch.bytes.length < byteLength + 8) {
        scratch.bytes = Buffer.allocUnsafe(Math.min(BATCH_BLOCKS * CHUNK_BYTES + 8,
            Math.max(byteLength + 8, scratch.bytes.length * 2)));
    }
    const bytes = scratch?.bytes.subarray(0, byteLength + 8) ?? Buffer.allocUnsafe(byteLength + 8);
    if (readInto(fd, bytes.subarray(0, byteLength), base).length !== byteLength) throw Error("Truncated archive");
    bytes.fill(0, byteLength);
    const descriptors = gpu ? new Uint32Array((last - first) * 5) : undefined;
    const blocks = [];
    const deviceBlocks = [];
    let paletteBytes = 0;
    for (let block = first; block < last; block++) {
        const entry = block * ENTRY_BYTES;
        const offset = entryOffset(block) - base;
        const payload = bytes.subarray(offset, offset + archive.index.readUInt32LE(entry + 8));
        const rawLength = Math.min(CHUNK_BYTES, archive.rawSize - block * CHUNK_BYTES);
        const mode = archive.index[entry + 12];
        if (gpu && mode === PALETTE) {
            const layout = paletteLayout(payload, rawLength);
            descriptors.set([offset + 2, offset + layout.paletteEnd, layout.paletteLength, layout.width, rawLength], deviceBlocks.length * 5);
            deviceBlocks.push({ block, rawLength, payload });
            paletteBytes += payload.length;
        } else {
            blocks[block - first] = decodeBlock(mode, payload, rawLength, archive.dictionary);
        }
    }
    let ready;
    if (deviceBlocks.length) {
        let input = bytes;
        const bypassBytes = byteLength - paletteBytes;
        if (bypassBytes >= CHUNK_BYTES && bypassBytes > paletteBytes / 2) {
            input = Buffer.allocUnsafe(paletteBytes + 8);
            let offset = 0;
            for (const [row, { payload }] of deviceBlocks.entries()) {
                const job = row * 5;
                const indexStart = descriptors[job + 1] - descriptors[job];
                descriptors[job] = offset + 2;
                descriptors[job + 1] = offset + 2 + indexStart;
                input.set(payload, offset);
                offset += payload.length;
            }
            input.fill(0, offset);
        }
        const jobs = descriptors.subarray(0, deviceBlocks.length * 5);
        if (flush) {
            gpu.submit(input, jobs, deviceBlocks.length);
            gpu.flush();
        } else ready = gpu.decode(input, jobs, deviceBlocks.length);
    }
    return () => {
        if (deviceBlocks.length) {
            const decoded = ready ?? gpu.finish();
            deviceBlocks.forEach(({ block, rawLength }, row) => {
                blocks[block - first] = decoded.subarray(row * CHUNK_BYTES, row * CHUNK_BYTES + rawLength);
            });
        }
        return blocks;
    };
}

function verifyBatch(archive, first, blocks) {
    blocks.forEach((raw, index) => {
        const entry = (first + index) * ENTRY_BYTES;
        if (!digest(raw).subarray(0, 16).equals(archive.index.subarray(entry + 16, entry + ENTRY_BYTES))) {
            throw Error("Chunk checksum mismatch at block " + (first + index));
        }
    });
    return blocks;
}

function decodeBatch(fd, archive, first, last, gpu, scratch) {
    return verifyBatch(archive, first, prepareBatch(fd, archive, first, last, gpu, scratch)());
}

function openArchive(source, { gpu: useGpu = false, gpuPipeline = false } = {}) {
    if (![false, true, "auto"].includes(useGpu) && (!Number.isSafeInteger(useGpu) || useGpu < 0)) {
        throw TypeError("GPU selection must be false, true, auto, or an adapter index");
    }
    const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    let archive, gpu;
    try {
        archive = inspectArchive(fd);
        archive.dictionary = makeDictionary(archive.seed);
        if (useGpu !== false && useGpu !== "auto") {
            gpu = require("./opencl.cjs").createGpu(archive.dictionary.inverse, useGpu === true ? undefined : useGpu);
        }
    } catch (error) {
        fs.closeSync(fd);
        throw error;
    }
    let closed = false;
    let triedGpu = false;
    let fallback;
    let failedGpu;
    const scratch = { bytes: Buffer.alloc(0) };
    const pipelineScratch = [{ bytes: Buffer.alloc(0) }, { bytes: Buffer.alloc(0) }];
    function disableGpu(error) {
        fallback = error.message;
        failedGpu = { gpuBytes: gpu.decodedBytes || 0, profiledBytes: gpu.profiledBytes || 0,
            kernelNs: gpu.kernelNs || 0, device: gpu.name, groupSize: gpu.groupSize, batchBlocks: gpu.batchBlocks };
        gpu.close();
        gpu = undefined;
    }
    function transfer(start, length, consumeBatch, reuse) {
        if (closed) throw Error("Archive is closed");
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) ||
            start < 0 || length < 0 || start > archive.rawSize - length) throw Error("Byte range exceeds archive");
        if (!length) return;
        const end = start + length;
        const limit = Math.ceil(end / CHUNK_BYTES);
        const startBlock = Math.floor(start / CHUNK_BYTES);
        const automatic = useGpu === "auto";
        const useAccelerator = !automatic || length >= 8 * CHUNK_BYTES;
        if (automatic && useAccelerator && !triedGpu) {
            // Avoid opening the driver for ranges dominated by CPU-only blocks.
            let palettes = 0;
            for (let block = startBlock; block < limit && palettes < 8; block++) {
                if (archive.index[block * ENTRY_BYTES + 12] === PALETTE) palettes++;
            }
            if (palettes >= 8) {
                triedGpu = true;
                try { gpu = require("./opencl.cjs").createGpu(archive.dictionary.inverse); }
                catch (error) { fallback = error.message; }
            }
        }
        function deliver(first, blocks) {
            if (consumeBatch) consumeBatch(blocks.map((raw, index) => {
                const base = (first + index) * CHUNK_BYTES;
                return raw.subarray(Math.max(0, start - base), end - base);
            }));
        }
        // Only internal consumers that finish with each batch before returning may
        // use the two reusable input buffers. Public visitors can retain references.
        if (gpuPipeline && reuse && gpu && useAccelerator) {
            // Reuse the device buffers only after readback. While the next kernel
            // runs, the CPU verifies the previous batch's independent host buffers.
            function submit(first, slot) {
                const activeGpu = gpu;
                const last = Math.min(first + (activeGpu?.batchBlocks ?? BATCH_BLOCKS), limit);
                const retry = error => {
                    if (!automatic || !activeGpu || !(error instanceof require("./opencl.cjs").OpenClError)) throw error;
                    disableGpu(error);
                    return prepareBatch(fd, archive, first, last)();
                };
                let finish;
                try { finish = prepareBatch(fd, archive, first, last, activeGpu, pipelineScratch[slot], true); }
                catch (error) {
                    const blocks = retry(error);
                    return { first, last, collect: () => blocks };
                }
                return { first, last, collect() {
                    try { return finish(); }
                    catch (error) { return retry(error); }
                } };
            }
            try {
                let slot = 0, batch = submit(startBlock, slot);
                while (batch) {
                    const blocks = batch.collect();
                    if (!gpu) {
                        deliver(batch.first, verifyBatch(archive, batch.first, blocks));
                        // Let the normal CPU loop finish with its reusable scratch.
                        for (let first = batch.last; first < limit; first += BATCH_BLOCKS) {
                            deliver(first, decodeBatch(fd, archive, first, Math.min(first + BATCH_BLOCKS, limit), undefined, scratch));
                        }
                        break;
                    }
                    let next, nextError;
                    try { if (batch.last < limit) next = submit(batch.last, slot ^= 1); }
                    catch (error) { nextError = error; }
                    deliver(batch.first, verifyBatch(archive, batch.first, blocks));
                    if (nextError) throw nextError;
                    batch = next;
                }
            } finally { gpu?.discard(); }
            return;
        }
        for (let first = startBlock; first < limit;) {
            if (closed) throw Error("Archive was closed during traversal");
            const activeGpu = useAccelerator ? gpu : undefined;
            const last = Math.min(first + (activeGpu?.batchBlocks ?? BATCH_BLOCKS), limit);
            let blocks;
            try { blocks = decodeBatch(fd, archive, first, last, activeGpu, reuse ? scratch : undefined); }
            catch (error) {
                if (!automatic || !activeGpu || !(error instanceof require("./opencl.cjs").OpenClError)) throw error;
                disableGpu(error);
                blocks = decodeBatch(fd, archive, first, last, undefined, reuse ? scratch : undefined);
            }
            deliver(first, blocks);
            first = last;
        }
    }
    function visit(start, length, consume) {
        if (consume !== undefined && typeof consume !== "function") throw TypeError("Expected a chunk visitor");
        transfer(start, length, consume && (blocks => {
            for (const block of blocks) {
                if (closed) throw Error("Archive was closed during traversal");
                consume(block);
            }
        }), consume === undefined);
    }
    return {
        size: archive.rawSize,
        visit,
        writeTo(fd, start = 0, length = archive.rawSize - start) {
            transfer(start, length, blocks => writeBatch(fd, blocks), true);
        },
        readInto(target, start = 0) {
            if (!(target instanceof Uint8Array)) throw Error("Expected a byte buffer");
            let written = 0;
            visit(start, target.length, bytes => {
                target.set(bytes, written);
                written += bytes.length;
            });
            return written;
        },
        counters() {
                return { gpuBytes: gpu?.decodedBytes || 0, profiledBytes: gpu?.profiledBytes || 0,
                kernelNs: gpu?.kernelNs || 0, device: gpu?.name,
                groupSize: gpu?.groupSize, batchBlocks: gpu?.batchBlocks, ...failedGpu, fallback };
        },
        close() {
            if (!closed) {
                closed = true;
                scratch.bytes = Buffer.alloc(0);
                for (const slot of pipelineScratch) slot.bytes = scratch.bytes;
                try { gpu?.close(); } finally { fs.closeSync(fd); }
            }
        }
    };
}

async function extractParallel(source, destination, start, length, workers) {
    const { runOrdered } = require("./codec-worker.cjs");
    const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const archive = inspectArchive(fd);
        const size = length ?? archive.rawSize - start;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) ||
            start < 0 || size < 0 || start > archive.rawSize - size) throw Error("Byte range exceeds archive");
        const end = start + size;
        const restore = destination !== null;
        const firstBlock = Math.floor(start / CHUNK_BYTES);
        const last = Math.ceil(end / CHUNK_BYTES);
        const blocksPerJob = 16;
        function* jobs() {
            for (let first = firstBlock; first < last; first += blocksPerJob) {
                const limit = Math.min(last, first + blocksPerJob);
                const offset = Number(archive.index.readBigUInt64LE(first * ENTRY_BYTES));
                const batch = [];
                let storedLength = 0;
                for (let block = first; block < limit; block++) {
                    const entry = block * ENTRY_BYTES;
                    const stored = archive.index.readUInt32LE(entry + 8);
                    const base = block * CHUNK_BYTES;
                    batch.push({ stored, offset: storedLength, block, base, mode: archive.index[entry + 12],
                        rawLength: Math.min(CHUNK_BYTES, archive.rawSize - base),
                        checksum: Uint8Array.from(archive.index.subarray(entry + 16, entry + ENTRY_BYTES)) });
                    storedLength += stored;
                }
                const payload = Buffer.allocUnsafeSlow(storedLength);
                if (readInto(fd, payload, offset).length !== storedLength) throw Error("Truncated archive");
                yield { job: { payload, blocks: batch, start: Math.max(start, first * CHUNK_BYTES),
                    end: Math.min(end, limit * CHUNK_BYTES), restore }, transfer: [payload.buffer] };
            }
        }
        const transfer = async output => {
            if (!size) return;
            if (last - firstBlock <= blocksPerJob) {
                archive.dictionary = makeDictionary(archive.seed);
                const decoded = decodeBatch(fd, archive, firstBlock, last);
                if (restore) writeBatch(output, decoded.map((bytes, index) => {
                    const base = (firstBlock + index) * CHUNK_BYTES;
                    return bytes.subarray(Math.max(0, start - base), end - base);
                }));
                return;
            }
            for await (const { output: decoded } of runOrdered(jobs(), { seed: archive.seed, decode: true }, workers)) {
                if (restore) writeAll(output, decoded);
            }
        };
        if (restore) await publishFile(destination, transfer);
        else await transfer(null);
    } finally {
        fs.closeSync(fd);
    }
}

async function extract(source, destination, start = 0, length = undefined, useGpu = false, workers = 1, gpuPipeline = false) {
    if (workers > 1) return extractParallel(source, destination, start, length, workers);
    const reader = openArchive(source, { gpu: useGpu, gpuPipeline });
    try {
        const size = length ?? reader.size - start;
        if (destination === null) reader.visit(start, size);
        else await publishFile(destination, output => reader.writeTo(output, start, size));
    } finally {
        reader.close();
    }
}

function benchmarkDecode(source, useGpu, minimumSeconds = 0, gpuPipeline = false) {
    const init = performance.now();
    const reader = openArchive(source, { gpu: useGpu, gpuPipeline });
    try {
        reader.visit(0, reader.size);
        const ready = performance.now();
        console.log("Open and first verified read: " + (ready - init).toFixed(1) + " ms");
        const before = reader.counters();
        const start = performance.now();
        const cpuStart = process.cpuUsage();
        let passes = 0;
        let seconds;
        do {
            reader.visit(0, reader.size);
            passes++;
            seconds = (performance.now() - start) / 1000;
        } while (passes < 5 || seconds < minimumSeconds);
        const stats = reader.counters();
        console.log("Warm verified decode: " + (passes * reader.size / seconds / 1e9).toFixed(3) +
            " GB/s (" + passes + " passes, " + reader.size + " bytes each)");
        const cpu = process.cpuUsage(cpuStart);
        const logical = require("node:os").availableParallelism?.() ?? require("node:os").cpus().length;
        const cores = (cpu.user + cpu.system) / 1e6 / seconds;
        console.log("Process CPU: " + cores.toFixed(2) + " logical cores, " + (100 * cores / logical).toFixed(1) + "% of " + logical + " available logical CPUs");
        if (stats.fallback) console.log("CPU fallback: " + stats.fallback);
        if (stats.device) {
            const gpuBytes = stats.gpuBytes - before.gpuBytes;
            console.log("GPU: " + stats.device + ", work-group: " + stats.groupSize +
                ", batch blocks: " + stats.batchBlocks + ", palette bytes per pass: " + gpuBytes / passes);
            const ns = stats.kernelNs - before.kernelNs;
            const profiled = stats.profiledBytes - before.profiledBytes;
            if (ns > 0 && profiled > 0) {
                console.log("Palette kernel only: " + (profiled / ns).toFixed(3) + " GB/s");
                if (profiled === gpuBytes) console.log("Profiled kernel time / verified wall time: " +
                    (ns / (seconds * 1e7)).toFixed(2) + "% (not GPU utilization)");
            }
        }
    } finally {
        reader.close();
    }
}

async function testDownload(original, filename) {
    const server = http.createServer((request, response) => {
        response.setHeader("Connection", "close");
        if (request.url === "/missing") {
            response.writeHead(404).end();
        } else if (request.url === "/truncated") {
            response.writeHead(200, { "Content-Length": original.length });
            response.end(original.subarray(0, CHUNK_BYTES + 1));
        } else {
            response.writeHead(200, { "Content-Length": original.length });
            response.write(original.subarray(0, CHUNK_BYTES + 2));
            setImmediate(() => response.end(original.subarray(CHUNK_BYTES + 2)));
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    try {
        const address = "http://127.0.0.1:" + server.address().port;
        await download(address + "/full", filename("download"));
        await extract(filename("download"), filename("download-output"));
        assert.deepEqual(fs.readFileSync(filename("download-output")), original);
        await assert.rejects(() => download(address + "/missing", filename("missing")), /404/);
        await assert.rejects(() => download(address + "/truncated", filename("partial")));
        assert.equal(fs.existsSync(filename("missing")), false);
        assert.equal(fs.existsSync(filename("partial")), false);
    } finally {
        await new Promise(resolve => {
            server.close(resolve);
            server.closeAllConnections();
        });
    }
}

function testGpu(dictionary, selection) {
    const gpu = require("./opencl.cjs").createGpu(dictionary.inverse, selection === true ? undefined : selection);
    const batch = [];
    let random = 0x75ca3f;
    function run(items) {
        const jobs = new Uint32Array(items.length * 5);
        let offset = 0;
        const parts = items.map(({ raw, bytes }, row) => {
            const layout = paletteLayout(bytes, raw.length);
            jobs.set([offset + 2, offset + layout.paletteEnd, layout.paletteLength, layout.width, raw.length], row * 5);
            offset += bytes.length;
            return bytes;
        });
        const output = gpu.decode(Buffer.concat([...parts, Buffer.alloc(8)]), jobs, items.length);
        items.forEach(({ raw }, row) => {
            assert.deepEqual(output.subarray(row * CHUNK_BYTES, row * CHUNK_BYTES + raw.length), raw);
        });
    }
    try {
        for (const levels of [1, 2, 3, 7, 15, 31, 63, 127, 255, 511]) {
            for (let tail = 0; tail < (levels === 15 ? 20 : 10); tail++) {
                const raw = Buffer.alloc(CHUNK_BYTES - tail);
                let pos = 0, bits = 0, available = 0;
                while (pos < raw.length) {
                    random ^= random << 13;
                    random ^= random >>> 17;
                    random ^= random << 5;
                    bits |= ((random >>> 0) % levels) << available;
                    available += 10;
                    while (available >= 8 && pos < raw.length) {
                        raw[pos++] = bits & 255;
                        bits >>>= 8;
                        available -= 8;
                    }
                }
                batch.push({ raw, bytes: encodePalette(raw, dictionary) });
            }
        }
        // A nonzero one-entry palette exercises the repeating five-byte pattern.
        const repeated = Buffer.alloc(64000, 255);
        batch.push({ raw: repeated, bytes: encodePalette(repeated, dictionary) });
        for (let first = 0; first < batch.length; first += gpu.batchBlocks) {
            run(batch.slice(first, first + gpu.batchBlocks));
        }
        const invalid = batch[20];
        const layout = paletteLayout(invalid.bytes, invalid.raw.length);
        assert.equal(layout.paletteLength, 3);
        invalid.bytes[layout.paletteEnd] |= 3;
        assert.throws(() => run([invalid]), /Invalid GPU palette/);
        const malformedFour = batch.find(({raw, bytes}) => {
            const layout = paletteLayout(bytes, raw.length);
            return layout.width === 4 && layout.paletteLength === 15;
        });
        assert.ok(malformedFour);
        const fourLayout = paletteLayout(malformedFour.bytes, malformedFour.raw.length);
        malformedFour.bytes[fourLayout.paletteEnd] |= 15;
        assert.throws(() => run([malformedFour]), /Invalid GPU palette/);
        const badTail = batch[0];
        new DataView(badTail.bytes.buffer, badTail.bytes.byteOffset).setUint16(2, dictionary.forward[1023], true);
        assert.throws(() => run([badTail]), /Invalid GPU palette/);
        console.log("GPU verified on " + gpu.name + " across every palette width, byte tails and malformed inputs");
    } finally {
        gpu.close();
    }
}

async function selfTest(useGpu = false) {
    const dictionary = makeDictionary(403817);
    const distinctSymbols = new Set(dictionary.forward);
    assert.equal(distinctSymbols.size, SYMBOL_COUNT);
    assert.ok(dictionary.forward.every((symbol, value) => dictionary.inverse[symbol] === value));

    for (const count of [1, 2, 3, 5, 17, 33, 65, 129, 257, 512, 1024]) {
        const raw = Buffer.alloc(CHUNK_BYTES - 1);
        let bits = 0;
        let available = 0;
        let offset = 0;
        for (let index = 0; offset < raw.length; index++) {
            bits |= (index % count) << available;
            available += 10;
            while (available >= 8 && offset < raw.length) {
                raw[offset++] = bits & 255;
                bits >>>= 8;
                available -= 8;
            }
        }
        const payload = encodePalette(raw, dictionary);
        if (count === 1024) assert.equal(payload, null);
        else assert.deepEqual(Buffer.from(decodePalette(payload, raw.length, dictionary)), raw);
    }

    if (useGpu !== false && useGpu !== "auto") testGpu(dictionary, useGpu);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symbol10-test-"));
    const filename = name => path.join(root, name);
    try {
        const zeros = Buffer.alloc(CHUNK_BYTES);
        const random = crypto.randomBytes(CHUNK_BYTES);
        const repeated = Buffer.concat(Array.from({length: 8}, () => random.subarray(0, CHUNK_BYTES / 8)));
        const original = Buffer.concat([zeros, random, repeated, Buffer.from([1, 24, 255])]);
        fs.writeFileSync(filename("source"), original);
        await pack(filename("source"), filename("archive"));
        const fd = fs.openSync(filename("archive"), "r");
        try {
            const archive = inspectArchive(fd);
            assert.equal(archive.index[12], PALETTE);
            assert.equal(archive.index[ENTRY_BYTES + 12], RAW);
            assert.equal(archive.index[ENTRY_BYTES * 2 + 12], DEFLATE);
        } finally {
            fs.closeSync(fd);
        }
        await extract(filename("archive"), null);
        await extract(filename("archive"), filename("full"));
        assert.deepEqual(fs.readFileSync(filename("full")), original);
        await extract(filename("archive"), filename("range"), CHUNK_BYTES - 3, CHUNK_BYTES + 11);
        assert.deepEqual(fs.readFileSync(filename("range")), original.subarray(CHUNK_BYTES - 3, CHUNK_BYTES * 2 + 8));
        await assert.rejects(() => extract(filename("archive"), filename("full")), { code: "EEXIST" });
        assert.deepEqual(fs.readFileSync(filename("full")), original);
        await assert.rejects(() => extract(filename("archive"), filename("bad-range"), original.length, 1), /range/);
        const corrupted = fs.readFileSync(filename("archive"));
        corrupted[HEADER_BYTES + 4] ^= 1;
        fs.writeFileSync(filename("corrupted"), corrupted);
        await assert.rejects(() => extract(filename("corrupted"), filename("bad-output")), /checksum/);
        assert.equal(fs.existsSync(filename("bad-output")), false);
        corrupted[8] ^= 1;
        fs.writeFileSync(filename("bad-index"), corrupted);
        await assert.rejects(() => extract(filename("bad-index"), null), /index checksum/);
        fs.writeFileSync(filename("truncated"), corrupted.subarray(0, -1));
        await assert.rejects(() => extract(filename("truncated"), null), /archive/);
        fs.writeFileSync(filename("empty"), Buffer.alloc(0));
        await pack(filename("empty"), filename("empty-archive"));
        await extract(filename("empty-archive"), filename("empty-output"));
        assert.equal(fs.statSync(filename("empty-output")).size, 0);
        const reader = openArchive(filename("archive"), { gpu: useGpu });
        try {
            const portion = Buffer.alloc(CHUNK_BYTES + 7);
            assert.equal(reader.readInto(portion, CHUNK_BYTES - 2), portion.length);
            assert.deepEqual(portion, original.subarray(CHUNK_BYTES - 2, 2 * CHUNK_BYTES + 5));
            assert.throws(() => reader.readInto(portion, original.length), /range/);
        } finally { reader.close(); }
        assert.throws(() => reader.readInto(Buffer.alloc(0)), /closed/);
        await pack(filename("source"), filename("fast-archive"), true);
        const fastFd = fs.openSync(filename("fast-archive"), "r");
        try {
            const { index } = inspectArchive(fastFd);
            for (let entry = 0; entry < index.length; entry += ENTRY_BYTES) assert.ok(index[entry + 12] <= PALETTE);
        } finally { fs.closeSync(fastFd); }
        await extract(filename("fast-archive"), filename("fast-output"), 0, undefined, useGpu);
        assert.deepEqual(fs.readFileSync(filename("fast-output")), original);
        await testDownload(original, filename);
    } finally {
        for (const entry of fs.readdirSync(root)) fs.unlinkSync(filename(entry));
        fs.rmdirSync(root);
    }
    console.log("Passed: all three modes, full and range reads, empty file, corruption, truncation, overwrite protection, and streamed downloads");
}

async function bench(source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symbol10-bench-"));
    const archive = path.join(root, "archive.s10");
    try {
        const start = performance.now();
        const sizes = await pack(source, archive);
        const packed = performance.now();
        await extract(archive, null);
        const verified = performance.now();
        const rate = millis => ((sizes.originalSize / 1e6) / (millis / 1000)).toFixed(1);
        console.log("Archive: " + sizes.archiveSize + " bytes from " + sizes.originalSize);
        console.log("File to archive: " + rate(packed - start) + " MB/s");
        console.log("Archive decode and verify: " + rate(verified - packed) + " MB/s");
    } finally {
        if (fs.existsSync(archive)) fs.unlinkSync(archive);
        fs.rmdirSync(root);
    }
}

function nonnegative(value) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Expected a nonnegative byte count");
    return Number(value);
}

function workerCount(value) {
    const workers = value === "eco" ? Math.max(1, Math.min(16, Math.floor((require("node:os").availableParallelism?.() ?? require("node:os").cpus().length) / 4))) : nonnegative(value);
    if (workers < 1 || workers > 16) throw Error("Worker count must be between 1 and 16");
    return workers;
}

const usage = "node symbol10.cjs pack <file|-> <archive> [--fast-decode] [--workers=N]\n" +
    "node symbol10.cjs download <url> <archive> [--fast-decode] [--workers=N] [--timeout-ms=N] [--max-bytes=N] [--sha256=HEX]\n" +
    "node symbol10.cjs unpack <archive> <file> [--gpu|--gpu=auto|--gpu=INDEX|--workers=N] [--gpu-pipeline]\n" +
    "node symbol10.cjs read <archive> <offset> <length> <file> [--gpu|--gpu=auto|--gpu=INDEX|--workers=N] [--gpu-pipeline]\n" +
    "node symbol10.cjs verify <archive> [--gpu|--gpu=auto|--gpu=INDEX|--workers=N] [--gpu-pipeline]\n" +
    "node symbol10.cjs info <archive> [--json]\n" +
    "node symbol10.cjs bench-decode <archive> [--gpu|--gpu=auto|--gpu=INDEX] [--gpu-pipeline] [--seconds=N]\n" +
    "node symbol10.cjs bench <file>\n" +
    "node symbol10.cjs devices\n" +
    "node symbol10.cjs firmware <emulator|serial> <archive> <file|-> <executable|port>\n" +
    "node symbol10.cjs v2 <pack|verify|unpack|read|info> ...\n" +
    "node symbol10.cjs v3 <pack|unpack|read|verify|repair> ...\n" +
    "node symbol10.cjs bitline <check|compile|run> ...\n" +
    "node symbol10.cjs lang <check|compile|run> ...\n" +
    "node symbol10.cjs self-test [--gpu|--gpu=auto|--gpu=INDEX]";

const commandUsage = new Map(usage.split("\n").map(line => [line.split(" ")[2], line]));

async function main(args) {
    const [command, ...values] = args;
    if (!command || command === "--help") return console.log(usage);
    if (command === "v2") return require("./archive-v2.cjs").main(values);
    if (command === "v3") return require("./archive-v3.cjs").main(values);
    if (command === "bitline") return require("./language/bitline.cjs").main(values);
    const syntax = commandUsage.get(command);
    if (!syntax) throw Error("Unknown command: " + command + ". Run node symbol10.cjs --help.");
    if (command !== "lang" && values.length === 1 && values[0] === "--help") return console.log(syntax);
    let minimumSeconds = 0;
    if (command === "bench-decode" && values.length >= 2 && values.at(-1).startsWith("--seconds=")) {
        minimumSeconds = nonnegative(values.pop().slice(10));
        if (minimumSeconds < 1 || minimumSeconds > 300) throw Error("Benchmark duration must be between 1 and 300 seconds");
    }
    const gpuPipeline = ["verify", "bench-decode", "unpack", "read"].includes(command) && values.at(-1) === "--gpu-pipeline";
    if (gpuPipeline) values.pop();
    const decodeArguments = { unpack: 2, read: 4, verify: 1, "bench-decode": 1, "self-test": 0 };
    let useGpu = false;
    let decodeWorkers = 1;
    if (values.length === decodeArguments[command] + 1) {
        const flag = values.at(-1);
        if (flag === "--gpu") useGpu = true;
        else if (flag === "--gpu=auto") useGpu = "auto";
        else if (flag.startsWith("--gpu=")) useGpu = nonnegative(flag.slice(6));
        else if (["unpack", "read", "verify"].includes(command) && flag.startsWith("--workers=")) {
            decodeWorkers = workerCount(flag.slice(10));
            values.pop();
        } else if (flag.startsWith("--")) throw Error("Unknown option for " + command + ": " + flag);
        if (useGpu !== false) values.pop();
    }
    if (gpuPipeline && useGpu === false) throw Error("--gpu-pipeline requires a GPU selection");
    if ((command === "pack" || command === "download") && values.length >= 2) {
        const [source, destination, ...flags] = values;
        let fastDecode = false, workers = 1, timeoutMs = 30_000, maxBytes = MAX_BYTES, expectedDigest;
        const seen = new Set();
        for (const flag of flags) {
            const option = flag.split("=", 1)[0];
            if (seen.has(option)) throw Error("Repeated option: " + option);
            seen.add(option);
            if (flag === "--fast-decode") fastDecode = true;
            else if (flag.startsWith("--workers=")) {
                workers = workerCount(flag.slice(10));
            } else if (command === "download" && flag.startsWith("--timeout-ms=")) {
                timeoutMs = nonnegative(flag.slice(13));
                if (timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) throw Error("Invalid download timeout");
            } else if (command === "download" && flag.startsWith("--max-bytes=")) {
                maxBytes = nonnegative(flag.slice(12));
                if (maxBytes > MAX_BYTES) throw Error("Download byte limit cannot exceed 64 GiB");
            } else if (command === "download" && flag.startsWith("--sha256=")) {
                expectedDigest = flag.slice(9).toLowerCase();
                if (!/^[0-9a-f]{64}$/.test(expectedDigest)) throw Error("Expected a 64-digit SHA-256 value");
            } else throw Error("Unknown option: " + flag);
        }
        const { originalSize, archiveSize } = command === "pack"
            ? await pack(source, destination, fastDecode, workers)
            : await download(source, destination, { fastDecode, workers, timeoutMs, maxBytes, expectedDigest });
        console.log("Wrote " + archiveSize + " bytes from " + originalSize + " bytes");
    } else if (command === "info" && (values.length === 1 || (values.length === 2 && values[1] === "--json"))) {
        const info = archiveInfo(values[0]);
        if (values[1] === "--json") console.log(JSON.stringify(info));
        else {
            console.log(info.format + " · " + info.originalBytes + " original bytes · " + info.archiveBytes + " archive bytes");
            console.log(info.blocks.raw + " raw, " + info.blocks.palette + " palette, " + info.blocks.deflate + " DEFLATE blocks");
            console.log("Raw/palette firmware mode check: " + (info.firmwareCompatibleModes ? "passed" : "contains DEFLATE"));
        }
    } else if (command === "lang") {
        await require("./language/s10lang.cjs").main(values, main);
    } else if (command === "firmware" && values.length === 4 && ["emulator", "serial"].includes(values[0])) {
        await require("./firmware/bridge.cjs").restore(...values);
    } else if (command === "devices" && values.length === 0) {
        let devices;
        try { devices = require("./opencl.cjs").listGpus(); }
        catch (error) { console.log("CPU available. OpenCL probe failed: " + error.message); return; }
        if (!devices.length) console.log("CPU available. No OpenCL GPUs detected.");
        for (const device of devices) {
            const memory = device.unified ? "shared memory" : "dedicated memory";
            console.log("[" + device.index + "] " + device.name + " (" + device.vendor +
                ", " + memory + ", " + device.version + ")" + (device.supported ? "" : " ? unsupported"));
        }
    } else if (command === "unpack" && values.length === 2) {
        await extract(values[0], values[1], 0, undefined, useGpu, decodeWorkers, gpuPipeline);
    } else if (command === "read" && values.length === 4) {
        const [archive, offset, length, output] = values;
        await extract(archive, output, nonnegative(offset), nonnegative(length), useGpu, decodeWorkers, gpuPipeline);
    } else if (command === "verify" && values.length === 1) {
        await extract(values[0], null, 0, undefined, useGpu, decodeWorkers, gpuPipeline);
        console.log("Archive verified");
    } else if (command === "bench-decode" && values.length === 1) {
        benchmarkDecode(values[0], useGpu, minimumSeconds, gpuPipeline);
    } else if (command === "bench" && values.length === 1) {
        await bench(values[0]);
    } else if (command === "self-test" && values.length === 0) {
        await selfTest(useGpu);
    } else {
        throw Error("Invalid arguments. Usage: " + syntax);
    }
}

module.exports = { CHUNK_BYTES, makeDictionary, encodeBlock, decodeBlock, openArchive, archiveInfo, main };

if (require.main === module) {
    main(process.argv.slice(2)).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

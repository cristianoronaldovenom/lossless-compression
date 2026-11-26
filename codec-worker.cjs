"use strict";

const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { digest } = require("./archive-format.cjs");

function createCodecWorker(options) {
    const worker = new Worker(__filename, { workerData: options });
    let pending, failure;
    function fail(error) {
        failure ??= error;
        const task = pending;
        pending = undefined;
        task?.reject(failure);
    }
    worker.on("error", fail);
    worker.on("exit", code => fail(Error("Codec worker exited with code " + code)));
    worker.on("message", result => {
        const task = pending;
        pending = undefined;
        if (result.error) task?.reject(Error(result.error));
        else task?.resolve(result);
    });
    return {
        run(job, transfer) {
            if (failure) return Promise.reject(failure);
            return new Promise((resolve, reject) => {
                if (pending) throw Error("Codec worker is already busy");
                pending = { resolve, reject };
                try { worker.postMessage(job, transfer); } catch (error) { fail(error); }
            });
        },
        close() { return worker.terminate(); }
    };
}

async function* runOrdered(jobs, options, concurrency, createWorker = createCodecWorker) {
    const pool = [];
    const pending = [];
    let rejectFailure;
    const failure = new Promise((_, reject) => { rejectFailure = reject; });
    failure.catch(() => {});
    function watch(result) {
        result.then(undefined, rejectFailure);
        return result;
    }
    function nextResult() {
        return Promise.race([pending.shift(), failure]);
    }
    let slot = 0;
    try {
        for await (const { job, transfer } of jobs) {
            pool[slot] ??= createWorker(options);
            pending.push(watch(pool[slot].run(job, transfer)));
            slot = (slot + 1) % concurrency;
            if (pending.length === concurrency) yield await nextResult();
        }
        while (pending.length) yield await nextResult();
    } finally {
        await Promise.allSettled(pool.map(worker => worker.close()));
    }
}

if (!isMainThread && require.main === module && workerData.v3) {
    const { encodeGroup, decodeGroup } = require("./archive-v3-group.cjs");
    const handle = workerData.v3 === "pack" ? encodeGroup : decodeGroup;
    parentPort.on("message", job => {
        try {
            const result = handle(job);
            parentPort.postMessage({ ...result, sequence: job.group }, result.output ? [result.output.buffer] : []);
        } catch (error) {
            parentPort.postMessage({ error: error.message });
        }
    });
} else if (!isMainThread && require.main === module) {
    const { makeDictionary, encodeBlock, decodeBlock } = require("./block-codec.cjs");
    const dictionary = makeDictionary(workerData.seed);
    function encode(raw) {
        const { mode, bytes } = encodeBlock(raw, dictionary, workerData.fastDecode);
        const checksum = digest(raw).subarray(0, 16);
        // A zlib result may share an allocation. Transfer only the selected payload.
        const payload = bytes.buffer === raw.buffer ? raw :
            (!Buffer.isBuffer(bytes) && bytes.byteOffset===0 && bytes.byteLength===bytes.buffer.byteLength ? bytes : Uint8Array.from(bytes));
        parentPort.postMessage({ rawLength: raw.length, mode, bytes: payload, checksum }, [payload.buffer]);
    }
    function decode({ payload, blocks, start, end, restore, version }) {
        const output = restore ? new Uint8Array(end - start) : undefined;
        let written = 0;
        for (const { mode, offset, stored, rawLength, block, checksum, base } of blocks) {
            const raw = decodeBlock(mode, payload.subarray(offset, offset + stored), rawLength, dictionary);
            const actual = digest(raw).subarray(0, 16);
            if (!actual.equals(checksum)) {
                throw Error(version === 2 ? "v2 chunk checksum mismatch at byte " + base :
                    "Chunk checksum mismatch at block " + block);
            }
            if (output) {
                const part = raw.subarray(Math.max(0, start - base), end - base);
                output.set(part, written);
                written += part.length;
            }
        }
        if (output && written !== output.length) throw Error("Incomplete worker output");
        parentPort.postMessage({ output }, output ? [output.buffer] : []);
    }
    parentPort.on("message", job => {
        try {
            if (workerData.decode) decode(job);
            else encode(job);
        } catch (error) {
            parentPort.postMessage({ error: error.message });
        }
    });
}

module.exports = { runOrdered };

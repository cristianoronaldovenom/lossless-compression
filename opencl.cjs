"use strict";

const fs = require("node:fs");
const path = require("node:path");
const CHUNK = 65536;
const SYMBOLS = 1024;
const DESCRIPTOR_WORDS = 5;
const INPUT_GUARD_BYTES = 8;
const OUTPUT_HEADER_BYTES = 64;
// Tile boundaries align to the five-word (16-symbol) expansion unit.
const WORDS_PER_GROUP = 1020;
const MAX_BATCH_BLOCKS = 128;
const SHARED_MEMORY_BATCH_BLOCKS = 32;
const ZERO = Buffer.alloc(4);
let kernelSource;

class OpenClError extends Error {}

function checked(code, operation) {
    if (code !== 0) throw new OpenClError(operation + " failed with OpenCL status " + code);
}

function sizeArray(...values) {
    const result = Buffer.alloc(values.length * 8);
    values.forEach((value, index) => result.writeBigUInt64LE(BigInt(value), index * 8));
    return result;
}

function loadApi() {
    if (!["x64", "arm64"].includes(process.arch) || require("node:os").endianness() !== "LE") {
        throw Error("GPU decoding requires a little-endian 64-bit host");
    }
    let ffi;
    try { ffi = require("koffi"); } catch (cause) {
        throw Error("GPU decoding needs the optional Koffi package. Run npm install.", { cause });
    }
    const loaders = {
        win32: () => path.join(process.env.SystemRoot, "System32", "OpenCL.dll"),
        linux: () => "libOpenCL.so.1",
        darwin: () => "/System/Library/Frameworks/OpenCL.framework/OpenCL"
    };
    const locate = loaders[process.platform];
    if (!locate) throw Error("OpenCL is unavailable on " + process.platform);
    const loader = locate();
    const lib = ffi.load(loader);
    const bind = signature => lib.func(signature);
    return {
        platforms: bind("int clGetPlatformIDs(uint32_t, void *, void *)"),
        devices: bind("int clGetDeviceIDs(uintptr_t, uint64_t, uint32_t, void *, void *)"),
        deviceInfo: bind("int clGetDeviceInfo(uintptr_t, uint32_t, size_t, void *, void *)"),
        context: bind("uintptr_t clCreateContext(void *, uint32_t, void *, void *, void *, void *)"),
        queue: bind("uintptr_t clCreateCommandQueue(uintptr_t, uintptr_t, uint64_t, void *)"),
        program: bind("uintptr_t clCreateProgramWithSource(uintptr_t, uint32_t, const char **, void *, void *)"),
        build: bind("int clBuildProgram(uintptr_t, uint32_t, void *, const char *, void *, void *)"),
        buildInfo: bind("int clGetProgramBuildInfo(uintptr_t, uintptr_t, uint32_t, size_t, void *, void *)"),
        kernel: bind("uintptr_t clCreateKernel(uintptr_t, const char *, void *)"),
        kernelInfo: bind("int clGetKernelWorkGroupInfo(uintptr_t, uintptr_t, uint32_t, size_t, void *, void *)"),
        buffer: bind("uintptr_t clCreateBuffer(uintptr_t, uint64_t, size_t, void *, void *)"),
        arg: bind("int clSetKernelArg(uintptr_t, uint32_t, size_t, void *)"),
        write: bind("int clEnqueueWriteBuffer(uintptr_t, uintptr_t, uint32_t, size_t, size_t, const void *, uint32_t, void *, void *)"),
        read: bind("int clEnqueueReadBuffer(uintptr_t, uintptr_t, uint32_t, size_t, size_t, void *, uint32_t, void *, void *)"),
        fill: bind("int clEnqueueFillBuffer(uintptr_t, uintptr_t, const void *, size_t, size_t, size_t, uint32_t, void *, void *)"),
        run: bind("int clEnqueueNDRangeKernel(uintptr_t, uintptr_t, uint32_t, void *, void *, void *, uint32_t, void *, void *)"),
        flush: bind("int clFlush(uintptr_t)"),
        profile: bind("int clGetEventProfilingInfo(uintptr_t, uint32_t, size_t, void *, void *)"),
        releaseEvent: bind("int clReleaseEvent(uintptr_t)"),
        release: name => bind("int clRelease" + name + "(uintptr_t)")
    };
}

function deviceInfo(api, device, key, size) {
    const result = Buffer.alloc(size);
    checked(api.deviceInfo(device, key, size, result, null), "Read GPU capabilities");
    return result;
}

function deviceString(api, device, key) {
    const length = Buffer.alloc(8);
    checked(api.deviceInfo(device, key, 0, null, length), "Size GPU name or version");
    return deviceInfo(api, device, key, Number(length.readBigUInt64LE())).toString("utf8").split("\0", 1)[0].trim();
}

function enumerate(api) {
    const count = new Uint32Array(1);
    const status = api.platforms(0, null, count);
    if (status === -1001) return { devices: [], failures: [] };
    checked(status, "Enumerate OpenCL platforms");
    if (!count[0]) return { devices: [], failures: [] };
    const platforms = Buffer.alloc(count[0] * 8);
    checked(api.platforms(count[0], platforms, null), "Read OpenCL platforms");
    const devices = [];
    const failures = [];
    for (let offset = 0; offset < platforms.length; offset += 8) {
        const platform = platforms.readBigUInt64LE(offset);
        let ids;
        try {
            const status = api.devices(platform, 4, 0, null, count);
            if (status === -1) continue;
            checked(status, "Enumerate OpenCL GPUs");
            if (!count[0]) continue;
            ids = Buffer.alloc(count[0] * 8);
            checked(api.devices(platform, 4, count[0], ids, null), "Read OpenCL GPUs");
        } catch (error) {
            failures.push("Platform " + (offset / 8) + ": " + error.message);
            continue;
        }
        for (let index = 0; index < ids.length; index += 8) {
            const id = ids.readBigUInt64LE(index);
            const adapter = { index: devices.length, platform, id };
            try {
                const uint = key => deviceInfo(api, id, key, 4).readUInt32LE();
                const text = key => deviceString(api, id, key);
                adapter.name = text(0x102b);
                adapter.vendor = text(0x102c);
                const runtime = text(0x102f);
                const canQueryCompiler = !/^OpenCL 1\.0\b/.test(runtime);
                adapter.version = canQueryCompiler ? text(0x103d) : runtime;
                adapter.unified = canQueryCompiler && Boolean(uint(0x1035));
                adapter.computeUnits = uint(0x1002);
                const [, major, minor] = /^OpenCL C (\d+)\.(\d+)/.exec(adapter.version) ?? [];
                const compiler = Number(major) >= 2 || (Number(major) === 1 && Number(minor) >= 2);
                adapter.dimensions = uint(0x1003);
                const localMemory = deviceInfo(api, id, 0x1023, 8).readBigUInt64LE();
                adapter.supported = compiler && adapter.dimensions >= 2 && localMemory >= BigInt(SYMBOLS * 2) &&
                    Boolean(uint(0x1026) && uint(0x1027) && uint(0x1028));
            } catch (error) {
                adapter.name ??= "OpenCL adapter " + adapter.index;
                adapter.vendor ??= "unknown vendor";
                adapter.version ??= "unknown OpenCL version";
                adapter.error = error.message;
                adapter.supported = false;
            }
            devices.push(adapter);
        }
    }
    return { devices, failures };
}

function listGpus() {
    const { devices, failures } = enumerate(loadApi());
    if (!devices.length && failures.length) throw Error(failures.join("\n"));
    return devices.map(({ id, platform, dimensions, ...details }) => details);
}

function createGpu(inverse, index) {
    if (!(inverse instanceof Uint16Array) || inverse.length !== SYMBOLS ||
        inverse.some(value => value >= SYMBOLS) || new Set(inverse).size !== SYMBOLS) {
        throw Error("Invalid GPU inverse dictionary");
    }
    const api = loadApi();
    const { devices, failures } = enumerate(api);
    const candidates = devices.filter(device => device.supported && (index === undefined || device.index === index));
    candidates.sort((a, b) => Number(a.unified) - Number(b.unified) || b.computeUnits - a.computeUnits);
    if (!candidates.length) {
        const unavailable = index === undefined ? "No compatible OpenCL GPU found" :
            "No compatible OpenCL GPU at index " + index + ". Run devices to list adapters.";
        throw Error([unavailable, ...failures].join("\n"));
    }
    for (const device of candidates) {
        try { return new GpuDecoder(inverse, api, device); }
        catch (error) { failures.push(device.name + ": " + error.message); }
    }
    throw Error(failures.join("\n"));
}

class GpuDecoder {
    constructor(inverse, api, adapter) {
        this.api = api;
        this.resources = [];
        this.kernelNs = 0;
        this.profiledBytes = 0;
        this.decodedBytes = 0;
        const status = new Int32Array(1);
        const own = (name, fn, ...args) => {
            const release = api.release(name);
            const handle = fn(...args, status);
            checked(status[0], "Create " + name);
            this.resources.push(() => release(handle));
            return handle;
        };
        try {
            const device = adapter.id;
            const deviceId = sizeArray(device);
            this.name = adapter.name;
            const context = own("Context", api.context, sizeArray(0x1084, adapter.platform, 0), 1, deviceId, null, null);
            this.queue = own("CommandQueue", api.queue, context, device, 2);
            kernelSource ??= fs.readFileSync(path.join(__dirname, "palette.cl"), "utf8");
            const program = own("Program", api.program, context, 1, [kernelSource], null);
            const options = [
                "-cl-std=CL1.2",
                "-DCHUNK_WORDS=" + CHUNK / 4,
                "-DDESCRIPTOR_WORDS=" + DESCRIPTOR_WORDS,
                "-DHEADER_WORDS=" + OUTPUT_HEADER_BYTES / 4,
                "-DSYMBOL_COUNT=" + SYMBOLS,
                "-DWORDS_PER_GROUP=" + WORDS_PER_GROUP
            ].join(" ");
            const built = api.build(program, 1, deviceId, options, null, null);
            if (built !== 0) {
                const length = Buffer.alloc(8);
                checked(api.buildInfo(program, device, 0x1183, 0, null, length), "Size build log");
                const log = Buffer.alloc(Number(length.readBigUInt64LE()));
                checked(api.buildInfo(program, device, 0x1183, log.length, log, null), "Read build log");
                throw Error("OpenCL program build failed: " + log.toString());
            }
            this.kernel = own("Kernel", api.kernel, program, "expand");
            const kernelSize = key => {
                const value = Buffer.alloc(8);
                checked(api.kernelInfo(this.kernel, device, key, 8, value, null), "Read kernel work-group limits");
                return Number(value.readBigUInt64LE());
            };
            const firstDimension = Number(deviceInfo(api, device, 0x1005, adapter.dimensions * 8).readBigUInt64LE());
            const cap = Math.min(kernelSize(0x11b0), firstDimension, adapter.unified ? 64 : 128);
            const preferred = kernelSize(0x11b3);
            if (cap < 1) throw Error("GPU cannot dispatch this kernel");
            this.groupSize = preferred > 0 && preferred <= cap ? Math.floor(cap / preferred) * preferred : cap;
            this.localSize = sizeArray(this.groupSize, 1);
            const allocation = Number(deviceInfo(api, device, 0x1010, 8).readBigUInt64LE());
            this.batchBlocks = Math.min(adapter.unified ? SHARED_MEMORY_BATCH_BLOCKS : MAX_BATCH_BLOCKS,
                Math.floor((allocation - OUTPUT_HEADER_BYTES) / CHUNK));
            if (this.batchBlocks < 1) throw Error("GPU allocation limit is too small");
            const allocate = (flags, bytes) => own("MemObject", api.buffer, context, flags, bytes, null);
            this.input = allocate(4, CHUNK * this.batchBlocks + INPUT_GUARD_BYTES);
            this.jobs = allocate(4, DESCRIPTOR_WORDS * 4 * this.batchBlocks);
            const dictionary = allocate(4, inverse.byteLength);
            this.output = allocate(1, OUTPUT_HEADER_BYTES + CHUNK * this.batchBlocks);
            [this.input, this.jobs, dictionary, this.output].forEach((buffer, index) => {
                checked(api.arg(this.kernel, index, 8, sizeArray(buffer)), "Bind kernel argument");
            });
            this.write(dictionary, inverse);
        } catch (error) {
            this.close();
            throw error;
        }
    }

    write(handle, bytes) {
        checked(this.api.write(this.queue, handle, 1, 0, bytes.byteLength, bytes, 0, null, null), "Upload");
    }

    read(handle, bytes) {
        checked(this.api.read(this.queue, handle, 1, 0, bytes.byteLength, bytes, 0, null, null), "Download");
    }

    submit(payload, descriptors, count) {
        if (this.pending) throw Error("GPU decoder already has a pending batch");
        if (!this.resources.length) throw Error("GPU decoder is closed");
        if (!(payload instanceof Uint8Array) || !(descriptors instanceof Uint32Array) ||
            !Number.isInteger(count) || count < 1 || count > this.batchBlocks ||
            descriptors.length !== count * DESCRIPTOR_WORDS ||
            payload.length > CHUNK * this.batchBlocks + INPUT_GUARD_BYTES) {
            throw Error("Invalid GPU batch");
        }
        let decodedBytes = 0;
        let longestBlock = 0;
        for (let row = 0; row < count; row++) {
            const descriptor = row * DESCRIPTOR_WORDS;
            const paletteOffset = descriptors[descriptor];
            const indexOffset = descriptors[descriptor + 1];
            const paletteLength = descriptors[descriptor + 2];
            const width = descriptors[descriptor + 3];
            const length = descriptors[descriptor + 4];
            const symbols = Math.ceil(length * 8 / 10);
            const indexBytes = Math.ceil(symbols * width / 8);
            if (length < 1 || length > CHUNK || paletteLength < 1 ||
                paletteLength > Math.min(SYMBOLS, symbols) || width !== 32 - Math.clz32(paletteLength - 1) ||
                indexOffset !== paletteOffset + paletteLength * 2 ||
                indexOffset + indexBytes + INPUT_GUARD_BYTES > payload.length) {
                throw Error("Invalid GPU block descriptor");
            }
            decodedBytes += length;
            longestBlock = Math.max(longestBlock, length);
        }
        this.write(this.input, payload);
        this.write(this.jobs, descriptors);
        checked(this.api.fill(this.queue, this.output, ZERO, ZERO.length, 0, OUTPUT_HEADER_BYTES, 0, null, null),
            "Clear decode status");
        const event = Buffer.alloc(8);
        const groups = Math.ceil(longestBlock / (WORDS_PER_GROUP * 4));
        const globalSize = sizeArray(groups * this.groupSize, count);
        checked(this.api.run(this.queue, this.kernel, 2, null, globalSize, this.localSize,
            0, null, event), "Dispatch decode");
        this.pending = { handle: event.readBigUInt64LE(), descriptors, count, decodedBytes };
    }

    flush() {
        checked(this.api.flush(this.queue), "Flush decode queue");
    }

    finish() {
        if (!this.pending) throw Error("GPU decoder has no pending batch");
        const { handle, descriptors, count, decodedBytes } = this.pending;
        this.pending = undefined;
        try {
            const lastLength = descriptors[descriptors.length - 1];
            const resultLength = (count - 1) * CHUNK + lastLength;
            const result = Buffer.allocUnsafe(OUTPUT_HEADER_BYTES + Math.ceil(resultLength / 4) * 4);
            this.read(this.output, result);
            if (result.readUInt32LE()) throw Error("Invalid GPU palette index, symbol, or symbol padding");
            const stamp = key => {
                const value = Buffer.alloc(8);
                const status = this.api.profile(handle, key, 8, value, null);
                return status === 0 ? value.readBigUInt64LE() : undefined;
            };
            const start = stamp(0x1282);
            const end = stamp(0x1283);
            if (start !== undefined && end !== undefined && end > start) {
                this.kernelNs += Number(end - start);
                this.profiledBytes += decodedBytes;
            }
            this.decodedBytes += decodedBytes;
            for (let row = 0; row < count - 1; row++) {
                const padding = CHUNK - descriptors[row * DESCRIPTOR_WORDS + 4];
                const rowEnd = OUTPUT_HEADER_BYTES + (row + 1) * CHUNK;
                if (padding) result.fill(0, rowEnd - padding, rowEnd);
            }
            return result.subarray(OUTPUT_HEADER_BYTES, OUTPUT_HEADER_BYTES + resultLength);
        } finally {
            this.api.releaseEvent(handle);
        }
    }

    decode(payload, descriptors, count) {
        this.submit(payload, descriptors, count);
        return this.finish();
    }

    discard() {
        if (!this.pending) return;
        this.api.releaseEvent(this.pending.handle);
        this.pending = undefined;
    }

    close() {
        this.discard();
        while (this.resources.length) this.resources.pop()();
    }
}

module.exports = { createGpu, listGpus, OpenClError };

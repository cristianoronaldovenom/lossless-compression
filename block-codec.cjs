"use strict";

const zlib = require("node:zlib");
const { expandBinary, expandBinaryInto, expandWideNative } = require("./binary-palette.cjs");
const { encodeBinary } = require("./binary-encode.cjs");

const SYMBOL_COUNT = 1024;
const CHUNK_BYTES = 65536;
const ZERO_CHUNK = Buffer.alloc(CHUNK_BYTES);
const workspaces = new WeakMap();
function makeDictionary(seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
        throw RangeError("Dictionary seed must be an unsigned 32-bit integer");
    }
    const forward = Uint16Array.from({length: SYMBOL_COUNT}, (_, value) => value);
    let state = seed >>> 0;
    for (let last = SYMBOL_COUNT - 1; last > 0; last--) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const swap = Math.floor(state * (last + 1) / 4294967296);
        const previous = forward[last];
        forward[last] = forward[swap];
        forward[swap] = previous;
    }
    const inverse = new Uint16Array(SYMBOL_COUNT);
    forward.forEach((symbol, value) => { inverse[symbol] = value; });
    return {forward, inverse};
}
function encodePalette(raw, dictionary) {
    if (raw.length > CHUNK_BYTES || raw.length < 3) return null;
    if (raw.length > 4 && Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
        .equals(ZERO_CHUNK.subarray(0, raw.length))) {
        const symbol = dictionary.forward[0];
        return Uint8Array.of(1, 0, symbol & 255, symbol >>> 8);
    }
    if (process.env.S10_DISABLE_BINARY_ENCODE !== "1") {
        const binary = encodeBinary(raw, dictionary.forward);
        if (binary) return binary;
    }
    const count = Math.ceil(raw.length * 8 / 10);
    let workspace = workspaces.get(dictionary);
    if (!workspace) {
        workspace = { indices: new Uint16Array(Math.ceil(CHUNK_BYTES * 8 / 10)),
            lookup: new Uint16Array(SYMBOL_COUNT) };
        workspaces.set(dictionary, workspace);
    }
    const { indices, lookup } = workspace;
    lookup.fill(0);
    const palette = [];
    let bits = 0;
    let available = 0;
    let cursor = 0;
    for (let index = 0; index < count; index++) {
        while (available < 10 && cursor < raw.length) {
            bits |= raw[cursor++] << available;
            available += 8;
        }
        const value = bits & 1023;
        bits >>>= 10;
        available -= 10;
        if (lookup[value] === 0) {
            lookup[value] = palette.push(dictionary.forward[value]);
            const width = 32 - Math.clz32(palette.length - 1);
            if (2 + palette.length * 2 + Math.ceil(count * width / 8) >= raw.length) return null;
        }
        indices[index] = lookup[value] - 1;
    }
    const width = 32 - Math.clz32(palette.length - 1);
    const payload = new Uint8Array(2 + palette.length * 2 + Math.ceil(count * width / 8));
    const view = new DataView(payload.buffer);
    view.setUint16(0, palette.length, true);
    palette.forEach((symbol, index) => view.setUint16(2 + index * 2, symbol, true));
    cursor = 2 + palette.length * 2;
    available = 0;
    bits = 0;
    if (width === 0) return payload;
    for (let index = 0; index < count; index++) {
        bits |= indices[index] << available;
        available += width;
        while (available >= 8) {
            payload[cursor++] = bits & 255;
            bits >>>= 8;
            available -= 8;
        }
    }
    if (available) payload[cursor] = bits;
    return payload;
}
function paletteLayout(payload, rawLength) {
    if (!Number.isInteger(rawLength) || rawLength < 1 || rawLength > CHUNK_BYTES ||
        payload.length < 4 || payload.length >= rawLength) throw new Error("Invalid palette block size");
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const paletteLength = view.getUint16(0, true);
    const count = Math.ceil(rawLength * 8 / 10);
    const width = 32 - Math.clz32(paletteLength - 1);
    const paletteEnd = 2 + 2 * paletteLength;
    const indexBits = count * width;
    if (paletteLength < 1 || paletteLength > SYMBOL_COUNT || paletteLength > count ||
        payload.length !== paletteEnd + Math.ceil(indexBits / 8)) throw new Error("Invalid palette layout");
    if ((indexBits & 7) && (payload[payload.length - 1] >>> (indexBits & 7))) throw new Error("Invalid index padding");
    if (paletteLength <= 2) {
        const a = view.getUint16(2, true);
        const b = paletteLength === 2 ? view.getUint16(4, true) : -1;
        if (a >= SYMBOL_COUNT || b >= SYMBOL_COUNT || a === b) throw Error("Invalid palette symbol");
    } else {
        const seen = new Uint8Array(SYMBOL_COUNT);
        for (let index = 0; index < paletteLength; index++) {
            const symbol = view.getUint16(2 + 2 * index, true);
            if (symbol >= SYMBOL_COUNT || seen[symbol]) throw new Error("Invalid palette symbol");
            seen[symbol] = 1;
        }
    }
    return { view, count, width, paletteLength, paletteEnd };
}

function decodePalette(payload, rawLength, dictionary) {
    const { view, count, width, paletteLength, paletteEnd } = paletteLayout(payload, rawLength);
    if (width === 1 && process.env.S10_DISABLE_BINARY_FAST !== "1") {
        return expandBinary(payload.subarray(paletteEnd), rawLength,
            dictionary.inverse[view.getUint16(2, true)], dictionary.inverse[view.getUint16(4, true)]);
    }
    const invalid = 0x8000;
    const values = new Uint16Array(1 << width);
    values.fill(invalid, paletteLength);
    for (let index = 0; index < paletteLength; index++) {
        values[index] = dictionary.inverse[view.getUint16(2 + 2 * index, true)];
    }
    if (width === 0) {
        const value = values[0];
        if (value >>> (rawLength * 8 - 10 * (count - 1))) throw Error("Invalid symbol padding");
        if (value === 0) return Buffer.alloc(rawLength);
        return Buffer.allocUnsafe(rawLength).fill(Buffer.from([
            value, (value >>> 8) | (value << 2), (value >>> 6) | (value << 4),
            (value >>> 4) | (value << 6), value >>> 2
        ]));
    }
    if(width>=2){
        const fast=expandWideNative(payload.subarray(paletteEnd),rawLength,width,values.subarray(0,paletteLength));
        if(fast)return fast;
    }
    const output = new Uint8Array(rawLength);
    const target = new DataView(output.buffer);
    let inputBits = 0;
    let inputAvailable = 0;
    let outputBits = 0;
    let outputAvailable = 0;
    let cursor = paletteEnd;
    let written = 0;
    const mask = (1 << width) - 1;
    // Eight indices occupy exactly width input bytes. The four-byte loads
    // can overlap, so leave any group without four readable bytes to the tail.
    const groups = Math.floor(rawLength / 10);
    const twice = 2 * width, third = 3 * width;
    const readableEnd = payload.length - Math.max(4, width);
    let group = 0;
    for (; group < groups && cursor <= readableEnd; group++) {
        const first = view.getUint32(cursor, true);
        let second, firstHigh = 0, secondHigh = 0;
        if (width <= 4) {
            second = first >>> (4 * width);
        } else if (width <= 8) {
            second = view.getUint32(cursor + width - 4, true) >>> (32 - 4 * width);
        } else {
            // A compressed palette uses at most nine bits per index.
            // Each set of four nine-bit indices needs four extra bits.
            const middle = payload[cursor + 4];
            const last = view.getUint32(cursor + 5, true);
            firstHigh = middle & 15;
            second = (middle >>> 4) | (last << 4);
            secondHigh = last >>> 28;
        }
        const a = values[first & mask], b = values[(first >>> width) & mask];
        const c = values[(first >>> twice) & mask], d = values[((first >>> third) | (firstHigh << (32 - third))) & mask];
        const e = values[second & mask], f = values[(second >>> width) & mask];
        const g = values[(second >>> twice) & mask], h = values[((second >>> third) | (secondHigh << (32 - third))) & mask];
        if ((a | b | c | d | e | f | g | h) & invalid) throw Error("Invalid palette index");
        target.setUint32(written, a | (b << 10) | (c << 20) | (d << 30), true);
        output[written + 4] = d >>> 2;
        target.setUint32(written + 5, e | (f << 10) | (g << 20) | (h << 30), true);
        output[written + 9] = h >>> 2;
        written += 10;
        cursor += width;
    }
    // Restore only the original bytes and require the unused final bits to
    // be zero. Seven bytes, for example, need six symbols with four pad bits.
    for (let index = group * 8; index < count; index++) {
        while (inputAvailable < width) {
            inputBits |= payload[cursor++] << inputAvailable;
            inputAvailable += 8;
        }
        const entry = inputBits & mask;
        if (entry >= paletteLength) throw new Error("Invalid palette index");
        inputBits >>>= width;
        inputAvailable -= width;
        outputBits |= values[entry] << outputAvailable;
        outputAvailable += 10;
        while (outputAvailable >= 8 && written < rawLength) {
            output[written++] = outputBits & 255;
            outputBits >>>= 8;
            outputAvailable -= 8;
        }
    }
    if (outputBits !== 0) throw new Error("Invalid symbol padding");
    return output;
}

const RAW = 0;
const PALETTE = 1;
const DEFLATE = 2;

function encodeBlock(raw, dictionary, fastDecode = false) {
    if (!(raw instanceof Uint8Array)) throw TypeError("Expected a byte buffer");
    if (raw.length < 1 || raw.length > CHUNK_BYTES) throw new Error("Invalid input block size");
    if (!(dictionary?.forward instanceof Uint16Array) || dictionary.forward.length !== SYMBOL_COUNT) {
        throw TypeError("Expected a Symbol10 forward dictionary");
    }
    const palette = encodePalette(raw, dictionary);
    if (fastDecode) return palette ? { mode: PALETTE, bytes: palette } : { mode: RAW, bytes: raw };
    if (palette?.length === 4) return { mode: PALETTE, bytes: palette };
    const deflate = zlib.deflateRawSync(raw, { level: 1 });
    if (palette && palette.length <= deflate.length) return { mode: PALETTE, bytes: palette };
    if (deflate.length < raw.length) return { mode: DEFLATE, bytes: deflate };
    return { mode: RAW, bytes: raw };
}

function decodeBlock(mode, payload, rawLength, dictionary) {
    if (!(payload instanceof Uint8Array)) throw TypeError("Expected a byte buffer");
    if (!Number.isInteger(rawLength) || rawLength < 1 || rawLength > CHUNK_BYTES ||
        payload.length < 1 || payload.length > rawLength ||
        (mode !== RAW && mode !== PALETTE && mode !== DEFLATE)) throw new Error("Invalid block");
    let raw = payload;
    if (mode === PALETTE) {
        if (!(dictionary?.inverse instanceof Uint16Array) || dictionary.inverse.length !== SYMBOL_COUNT) {
            throw TypeError("Expected a Symbol10 inverse dictionary");
        }
        raw = decodePalette(payload, rawLength, dictionary);
    }
    if (mode === DEFLATE) {
        const result = zlib.inflateRawSync(payload, { maxOutputLength: rawLength, info: true });
        if (result.engine.bytesWritten !== payload.length) throw new Error("Invalid compressed block length");
        raw = result.buffer;
    }
    if (raw.length !== rawLength) throw new Error("Invalid decoded block length");
    return raw;
}

// Direct destination decode for complete blocks. Caller-owned memory must
// not alias compressed input; partial ranges retain the original path.
function decodeBlockInto(mode,payload,destination,dictionary){
    if(!(destination instanceof Uint8Array)||!(payload instanceof Uint8Array)||
       destination.length<1||destination.length>CHUNK_BYTES)
        throw Error("Invalid decode destination");
    if(destination.buffer===payload.buffer&&destination.byteOffset<payload.byteOffset+payload.byteLength&&
       payload.byteOffset<destination.byteOffset+destination.byteLength)
        throw Error("Overlapping decode destination");
    if(mode===PALETTE && process.env.S10_DISABLE_BINARY_FAST!=="1"){
        const layout=paletteLayout(payload,destination.length);
        if(layout.width===1){
            if(!(dictionary?.inverse instanceof Uint16Array)||dictionary.inverse.length!==SYMBOL_COUNT)
                throw TypeError("Expected a Symbol10 inverse dictionary");
            return expandBinaryInto(payload.subarray(layout.paletteEnd),destination,
                dictionary.inverse[layout.view.getUint16(2,true)],dictionary.inverse[layout.view.getUint16(4,true)]);
        }
    }
    destination.set(decodeBlock(mode,payload,destination.length,dictionary));
    return destination;
}
module.exports = { SYMBOL_COUNT, CHUNK_BYTES, RAW, PALETTE, DEFLATE, decodeBlockInto,
    makeDictionary, encodeBlock, decodeBlock, paletteLayout, encodePalette, decodePalette };

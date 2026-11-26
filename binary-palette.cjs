"use strict";
// One input byte contains eight 1-bit indices, expanding to ten original bytes.
// Only the two original 10-bit values are needed. The archive format is unchanged.
let native;
if (process.env.S10_DISABLE_NATIVE !== "1") {
    try { native = require("./native/build/Release/s10binary.node"); }
    catch (error) {
        if (error.code !== "MODULE_NOT_FOUND" && error.code !== "ERR_DLOPEN_FAILED") throw error;
    }
}
let cachedKey = -1;
const table = new Uint32Array(256 * 3);
function prepare(a, b) {
    const key = (a << 10) | b;
    if (key === cachedKey) return;
    for (let i = 0; i < 256; i++) {
        const x = i & 1 ? b : a, y = i & 2 ? b : a;
        const z = i & 4 ? b : a, w = i & 8 ? b : a;
        const p = i & 16 ? b : a, q = i & 32 ? b : a;
        const r = i & 64 ? b : a, s = i & 128 ? b : a;
        table[i * 3] = x | (y << 10) | (z << 20) | (w << 30);
        table[i * 3 + 1] = (w >>> 2) | (p << 8) | (q << 18) | (r << 28);
        table[i * 3 + 2] = (r >>> 4) | (s << 6);
    }
    cachedKey = key;
}
function expandBinary(indices, length, a, b, destination) {
    if (!(indices instanceof Uint8Array) || !Number.isInteger(length) || length < 1 || length > 65536 ||
        !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 1023 || b < 0 || b > 1023 || a === b)
        throw Error("Invalid binary palette");
    const count = Math.ceil(length * 8 / 10);
    if (indices.length !== Math.ceil(count / 8)) throw Error("Invalid binary index length");
    if ((count & 7) && indices[indices.length - 1] >>> (count & 7)) throw Error("Invalid index padding");
    const last = (indices[(count - 1) >>> 3] >>> ((count - 1) & 7)) & 1 ? b : a;
    if (last >>> (length * 8 - 10 * (count - 1))) throw Error("Invalid symbol padding");
    if(destination!==undefined && (!(destination instanceof Uint8Array)||destination.length!==length ||
        (destination.buffer===indices.buffer && destination.byteOffset<indices.byteOffset+indices.byteLength &&
         indices.byteOffset<destination.byteOffset+destination.byteLength)))throw Error("Invalid or overlapping output");
    if (native && destination===undefined) return native.expand(indices, length, a, b);
    if (native && typeof native.expandInto==="function") return native.expandInto(indices,length,a,b,destination);
    prepare(a, b);
    const output = destination ?? new Uint8Array(length);
    const view = new DataView(output.buffer,output.byteOffset,output.byteLength);
    const full = Math.floor(length / 10);
    for (let i = 0, out = 0; i < full; i++, out += 10) {
        const t = indices[i] * 3;
        view.setUint32(out, table[t], true);
        view.setUint32(out + 4, table[t + 1], true);
        view.setUint16(out + 8, table[t + 2], true);
    }
    if (length % 10) {
        const t = indices[full] * 3;
        for (let j = 0; j < length % 10; j++)
            output[full * 10 + j] = table[t + (j >>> 2)] >>> ((j & 3) * 8);
    }
    return output;
}
function expandBinaryInto(indices,destination,a,b){
    if(!(destination instanceof Uint8Array))throw TypeError("Expected destination Uint8Array");
    return expandBinary(indices,destination.length,a,b,destination);
}
function expandWideNative(indices,length,width,values){
    if(typeof native?.expandPalette!=="function" || process.env.S10_DISABLE_WIDE_NATIVE==="1")return null;
    return native.expandPalette(indices,length,width,values);
}
module.exports = { expandBinary, expandBinaryInto, expandWideNative, nativeEnabled: Boolean(native) };

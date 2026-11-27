"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { expandBinary } = require("../binary-palette.cjs");
const { makeDictionary, encodePalette, decodePalette } = require("../block-codec.cjs");
function fixture(length, a, b, seed) {
    const count = Math.ceil(length * 8 / 10);
    const indices = new Uint8Array(Math.ceil(count / 8)), raw = new Uint8Array(length);
    let state = seed >>> 0, bits = 0, available = 0, cursor = 0;
    for (let j = 0; j < count; j++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const bit = j === count-1 ? 0 : state >>> 31;
        indices[j >>> 3] |= bit << (j & 7);
        bits |= (bit ? b : a) << available; available += 10;
        while (available >= 8 && cursor < length) {
            raw[cursor++] = bits; bits >>>= 8; available -= 8;
        }
    }
    return { raw, indices };
}
test("binary expansion, exact tails and dictionary changes", () => {
    for (const length of [...Array.from({length: 100}, (_, i) => i + 1), 65531, 65535, 65536]) {
        for (const [a,b] of [[0,1023],[1,731],[0,1]]) {
            const {raw,indices} = fixture(length,a,b,123);
            assert.deepEqual(Buffer.from(expandBinary(indices,length,a,b)),Buffer.from(raw));
            const dict = makeDictionary(123);
            const encoded = encodePalette(raw,dict);
            if (encoded) assert.deepEqual(Buffer.from(decodePalette(encoded,length,dict)),Buffer.from(raw));
        }
    }
});
test("all 256 index bytes and alternating cache keys", () => {
    for(let x=0;x<256;x++) for(const [a,b] of [[0,1023],[511,123]]) {
        const expected = new Uint8Array(10);
        for(let i=0;i<8;i++) for(let bit=0;bit<10;bit++)
            if(((x>>i&1?b:a)>>bit)&1) expected[(i*10+bit)>>3] |= 1<<((i*10+bit)&7);
        assert.deepEqual(Buffer.from(expandBinary(Uint8Array.of(x),10,a,b)),Buffer.from(expected));
    }
});
test("reject invalid binary padding, lengths and palettes", () => {
    assert.throws(()=>expandBinary(Uint8Array.of(128),1,0,1));
    assert.throws(()=>expandBinary(Uint8Array.of(1),1,0,1023));
    assert.throws(()=>expandBinary(new Uint8Array(0),10,0,1));
    assert.throws(()=>expandBinary(Uint8Array.of(0),10,1,1));
});
module.exports = {fixture};

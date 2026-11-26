"use strict";

const FILTER_BYTES = 512;
const MASK = FILTER_BYTES * 8 - 1;
const MAX_QUERY_BYTES = 4096;

function firstPosition(gram) {
    return Math.imul(gram ^ (gram >>> 7), 0x9e3779b1) >>> 20;
}

function secondPosition(gram, first) {
    return (first + ((Math.imul(gram, 0x85ebca77) >>> 20) | 1)) & MASK;
}

function setBit(filter, bit) {
    const cell = bit >>> 3, flag = 1 << (bit & 7);
    const previous = filter[cell];
    filter[cell] = previous | flag;
    return (previous & flag) === 0;
}

function addGrams() {
    let filter = Buffer.alloc(FILTER_BYTES);
    let rolling = 0, count = 0, used = 0, previous = -1;
    return {
        add(bytes) {
            if (!filter) return;
            for (const byte of bytes) {
                rolling = ((rolling << 8) | byte) & 0xffffff;
                if (count < 2) {
                    count++;
                    continue;
                }
                if (rolling === previous) continue;
                previous = rolling;
                const first = firstPosition(rolling);
                used += Number(setBit(filter, first)) + Number(setBit(filter, secondPosition(rolling, first)));
                if (used >= FILTER_BYTES * 7) {
                    filter = null; // A saturated filter is treated as a search candidate.
                    return;
                }
            }
        },
        finish() { return filter?.toString("base64") ?? null; }
    };
}

function queryFilter(query) {
    const probes = new Set();
    for (let i = 0, step = Math.max(1, Math.floor((query.length - 2) / 64)); i + 2 < query.length; i += step) {
        const gram = (query[i] << 16) | (query[i + 1] << 8) | query[i + 2];
        const first = firstPosition(gram);
        probes.add(first);
        probes.add(secondPosition(gram, first));
    }
    return encoded => {
        if (encoded === null || !probes.size) return true;
        const filter = Buffer.from(encoded, "base64");
        for (const bit of probes) if (!(filter[bit >>> 3] & (1 << (bit & 7)))) return false;
        return true;
    };
}

function matcher(query) {
    const overlap = query.length - 1;
    const bridge = Buffer.allocUnsafe(2 * overlap);
    return (limit, match) => {
        let offset = 0, previous = 0, hits = 0;
        return bytes => {
            if (hits >= limit) return;
            if (previous) {
                const copied = bytes.copy(bridge, previous, 0, overlap);
                const window = bridge.subarray(0, previous + copied);
                for (let i = window.indexOf(query); i >= 0 && i < previous && hits < limit; i = window.indexOf(query, i + 1)) {
                    match(offset - previous + i);
                    hits++;
                }
            }
            for (let i = bytes.indexOf(query); i >= 0 && hits < limit; i = bytes.indexOf(query, i + 1)) {
                match(offset + i);
                hits++;
            }
            if (bytes.length >= overlap) {
                bytes.copy(bridge, 0, bytes.length - overlap);
                previous = overlap;
            } else {
                const retained = Math.min(previous, overlap - bytes.length);
                bridge.copy(bridge, 0, previous - retained, previous);
                bytes.copy(bridge, retained);
                previous = retained + bytes.length;
            }
            offset += bytes.length;
        };
    };
}

module.exports = { FILTER_BYTES, MAX_QUERY_BYTES, addGrams, queryFilter, matcher };

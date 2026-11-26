"use strict";

const { digest } = require("./archive-format.cjs");

// GF(256), x^8 + x^4 + x^3 + x^2 + 1. Slot i has coefficient 2^i.
let tables;
function multiplication() {
    if (tables) return tables;
    tables = Array.from({ length: 256 }, (_, a) => {
        const row = new Uint8Array(256);
        for (let b = 1; b < 256; b++) {
            const half = row[b >>> 1];
            row[b] = ((half << 1) ^ ((half & 128) ? 0x11d : 0)) ^ ((b & 1) ? a : 0);
        }
        return row;
    });
    return tables;
}

function parityPair(payloads, length, workspace) {
    if (workspace && (!workspace.parity || workspace.parity[0].length < length)) {
        workspace.parity = [Buffer.allocUnsafe(length), Buffer.allocUnsafe(length)];
    }
    const [p, q] = workspace
        ? workspace.parity.map(buffer => buffer.subarray(0, length).fill(0))
        : [Buffer.alloc(length), Buffer.alloc(length)];
    if (payloads[0]) {
        p.set(payloads[0]);
        q.set(payloads[0]); // Slot zero has coefficient one.
    }
    if (payloads.length < 2) return [p, q];
    const mul = multiplication();
    for (let slot = 1; slot < payloads.length; slot++) {
        const data = payloads[slot];
        if (!data) continue;
        const row = mul[1 << slot];
        for (let i = 0; i < data.length; i++) {
            const value = data[i];
            p[i] ^= value;
            q[i] ^= row[value];
        }
    }
    return [p, q];
}

function recoverPair(payloads, entries, bad, p, q, check, group, force) {
    const fail = () => Error("Cannot recover group " + (group + 1) + ": two-shard recovery checks failed");
    if (bad.length > 2) throw fail();
    const intact = digest(p, q).equals(check);
    if (!bad.length && intact && !force) return 0;
    if (bad.length === 2 && !intact) throw fail();
    if (bad.length) {
        const good = payloads.slice();
        for (const slot of bad) good[slot] = undefined;
        const [knownP, knownQ] = parityPair(good, p.length);
        const mul = multiplication();
        const [a, b] = bad;
        const matches = (candidate, slot) => !candidate.subarray(entries[slot].stored).some(Boolean) &&
            digest(candidate.subarray(0, entries[slot].stored)).equals(entries[slot].encodedHash);
        const insert = (candidate, slot) => candidate.copy(payloads[slot], 0, 0, entries[slot].stored);
        const first = Buffer.allocUnsafe(p.length);
        if (bad.length === 1) {
            for (let i = 0; i < p.length; i++) first[i] = p[i] ^ knownP[i];
            if (!matches(first, a)) {
                const divide = mul[mul[1 << a].indexOf(1)];
                for (let i = 0; i < p.length; i++) first[i] = divide[q[i] ^ knownQ[i]];
                if (!matches(first, a)) throw fail();
            }
            insert(first, a);
        } else {
            // residual P = A xor B; residual Q = ca*A xor cb*B.
            const weightB = mul[1 << b];
            const divide = mul[mul[(1 << a) ^ (1 << b)].indexOf(1)];
            const second = Buffer.allocUnsafe(p.length);
            for (let i = 0; i < p.length; i++) {
                const dp = p[i] ^ knownP[i];
                const dq = q[i] ^ knownQ[i];
                first[i] = divide[dq ^ weightB[dp]];
                second[i] = dp ^ first[i];
            }
            if (!matches(first, a) || !matches(second, b)) throw fail();
            insert(first, a);
            insert(second, b);
        }
    }
    const [expectedP, expectedQ] = parityPair(payloads, p.length);
    if (!digest(expectedP, expectedQ).equals(check)) throw fail();
    const repairP = !p.equals(expectedP), repairQ = !q.equals(expectedQ);
    const repairs = bad.length + Number(repairP) + Number(repairQ);
    if (repairs > 2) throw fail();
    if (repairP) expectedP.copy(p);
    if (repairQ) expectedQ.copy(q);
    return repairs;
}

module.exports = { parityPair, recoverPair };

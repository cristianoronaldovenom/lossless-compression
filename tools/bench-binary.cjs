"use strict";
// Reproducible one-bit workload. Reports decode-only and decode+SHA-256;
// neither is a disk throughput result. CPU use includes all process threads.
const { performance } = require("node:perf_hooks");
const os = require("node:os"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { makeDictionary, encodePalette, decodePalette } = require("../block-codec.cjs");
const { nativeEnabled } = require("../binary-palette.cjs");
const dictionary = makeDictionary(123);
const raw = Buffer.alloc(65536);
let seed = 42, acc = 0, available = 0, cursor = 0;
for (let j=0;j<Math.ceil(raw.length*8/10);j++) {
    seed = (Math.imul(seed,1664525)+1013904223)>>>0;
    const value = j===Math.ceil(raw.length*8/10)-1 ? 0 : (seed>>>31)*1023;
    acc |= value<<available; available+=10;
    while(available>=8 && cursor<raw.length){raw[cursor++]=acc;acc>>>=8;available-=8;}
}
const encodeStart=performance.now();
const encodeCPU=process.cpuUsage();
let encodedBlocks=0, payload;
do { payload=encodePalette(raw,dictionary); encodedBlocks++; } while(performance.now()-encodeStart<500);
const encodeElapsed=(performance.now()-encodeStart)/1000;
const encodeUsed=process.cpuUsage(encodeCPU);
console.log(JSON.stringify({encodingGBps:encodedBlocks*raw.length/encodeElapsed/1e9,encodingAverageLogicalCores:(encodeUsed.user+encodeUsed.system)/1e6/encodeElapsed}));
assert(payload && payload[0]===2 && payload[1]===0);
const expected = crypto.createHash("sha256").update(raw).digest("hex");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
assert.equal(hash(decodePalette(payload,raw.length,dictionary)),expected);
const seconds = Number(process.argv[2] ?? 3);
if(!Number.isFinite(seconds)||seconds<0.25||seconds>60) throw Error("Seconds must be between 0.25 and 60");
const logical = os.availableParallelism?.() ?? os.cpus().length;
console.log(JSON.stringify({nativeEnabled,logicalCPUs:logical,rawBytes:raw.length,payloadBytes:payload.length,ratio:raw.length/payload.length}));
for (const verified of [false,true]) {
    for(let i=0;i<100;i++)decodePalette(payload,raw.length,dictionary);
    const start=performance.now(), cpu=process.cpuUsage();let blocks=0, guard=0;
    do {
        const out=decodePalette(payload,raw.length,dictionary);
        if(verified)assert.equal(hash(out),expected);
        guard^=out[0];blocks++;
    }while(performance.now()-start<seconds*1000);
    const elapsed=(performance.now()-start)/1000, usage=process.cpuUsage(cpu);
    const cores=(usage.user+usage.system)/1e6/elapsed;
    const throughput=blocks*raw.length/elapsed/1e9;
    console.log(JSON.stringify({verified,GBps:throughput,averageLogicalCores:cores,processCPUPercent:100*cores/logical,
        speedTargetMet:throughput>=5,cpuBudgetMet:cores/logical<=0.25,guard}));
}

"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {encodeBinary}=require("../binary-encode.cjs");
const {makeDictionary,encodePalette,decodePalette}=require("../block-codec.cjs");
const {blockCost,archiveCost,throughputBound}=require("../tools/symbol-math.cjs");
function rawSymbols(n,a,b,seed){
    const raw=new Uint8Array(n);
    for(let i=0;i<Math.ceil(n*8/10);i++){
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        const v=i===Math.ceil(n*8/10)-1?0:(seed>>>31?b:a);
        for(let k=0;k<10&&i*10+k<n*8;k++)if((v>>k)&1)raw[(i*10+k)>>>3]|=1<<((i*10+k)&7);
    }
    return raw;
}
test("binary encoder agrees with generic reference and restores exact bytes",()=>{
    for(const n of [...Array.from({length:150},(_,i)=>i+16),65531,65535,65536]){
        for(const [a,b] of [[0,1023],[0,731],[0,1],[0,0]]){
            const raw=rawSymbols(n,a,b,123),dict=makeDictionary(n);
            const fast=encodeBinary(raw,dict.forward);
            const before=process.env.S10_DISABLE_BINARY_ENCODE;
            let generic;
            try{process.env.S10_DISABLE_BINARY_ENCODE="1";generic=encodePalette(raw,dict);}
            finally{if(before===undefined)delete process.env.S10_DISABLE_BINARY_ENCODE;else process.env.S10_DISABLE_BINARY_ENCODE=before;}
            assert.deepEqual(fast,generic);
            assert.deepEqual(Buffer.from(decodePalette(fast,n,dict)),Buffer.from(raw));
        }
    }
});
test("third distinct value causes binary fallback",()=>{
    const raw=Uint8Array.from({length:100},(_,i)=>i);
    assert.equal(encodeBinary(raw,makeDictionary(1).forward),null);
});
test("integer sizes and throughput model",()=>{
    assert.equal(blockCost(65536,2).stored,6560n);
    assert.equal(archiveCost([{length:65536,unique:2}]).stored,6664n);
    assert.equal(blockCost(65536,1024).mode,"raw");
    assert.equal(throughputBound({ratio:10,cpuRate:20,gpuShare:0}).upperGBps,5);
    assert.equal(throughputBound({ratio:10,cpuRate:20,gpuShare:0,output:1}).upperGBps,1);
});

"use strict";
const assert=require("node:assert/strict"),crypto=require("node:crypto");
const {performance}=require("node:perf_hooks");
const {createGpu,listGpus}=require("../opencl.cjs");
const {expandBinaryInto}=require("../binary-palette.cjs");
const L=65536,I=Math.ceil(Math.ceil(L*8/10)/8),STRIDE=4+I+8;
function fixture(count){
    const payload=Buffer.alloc(count*STRIDE),jobs=new Uint32Array(count*5);
    const inverse=Uint16Array.from({length:1024},(_,i)=>i);
    const expected=Buffer.allocUnsafe(count*L);
    let seed=0x7384b9;
    function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
    for(let row=0;row<count;row++){
        const pos=row*STRIDE, a=rand()&1023;let b=rand()&1023;
        if(a===b)b^=1;
        // A full 65536 byte block has a partially used final 10-bit symbol.
        // Pick a value fitting its six available bits, then force its index.
        const aa=a&63,bb=b===aa?(b^64):b;
        payload.writeUInt16LE(aa,pos);payload.writeUInt16LE(bb,pos+2);
        const idx=payload.subarray(pos+4,pos+4+I);
        for(let j=0;j<I;j++)idx[j]=rand()&255;
        const symbols=Math.ceil(L*8/10);
        idx[I-1]&=(1<<((symbols-1)&7))-1; // final index is 0, unused bits zero
        jobs.set([pos,pos+4,2,1,L],row*5);
        expandBinaryInto(idx,expected.subarray(row*L,(row+1)*L),aa,bb);
    }
    return {payload,jobs,inverse,expected};
}
function main(){
    const index=process.argv[2]===undefined?undefined:Number(process.argv[2]);
    const blocks=Number(process.argv[3]??1024),iterations=Number(process.argv[4]??15);
    if((index!==undefined&&(!Number.isInteger(index)||index<0))||!Number.isInteger(blocks)||blocks<128||blocks>2048||
        !Number.isInteger(iterations)||iterations<3||iterations>100)throw Error("Usage: bench-gpu-resident.cjs [device] [128..2048 blocks] [3..100 iterations]");
    const devices=listGpus();console.log(JSON.stringify({type:"devices",devices}));
    let best;
    for(const binaryKernel of ["legacy","coalesced"]){
        const gpu=createGpu(Uint16Array.from({length:1024},(_,i)=>i),index,{binaryKernel,residentBlocks:blocks});
        try{
            const count=gpu.batchBlocks,{payload,jobs,expected}=fixture(count);
            const result=gpu.benchmarkResident(payload,jobs,count,iterations);
            assert.ok(result.output.equals(expected),"GPU differs from CPU reference");
            const t=performance.now(),out=gpu.decode(payload,jobs,count),elapsed=(performance.now()-t)/1000;
            assert.ok(out.equals(expected),"Transfer path differs from CPU reference");
            const h=performance.now();crypto.createHash("sha256").update(out).digest();const hashSeconds=(performance.now()-h)/1000;
            const {output,...rates}=result;
            const report={type:"result",device:gpu.name,binaryKernel,blocks:count,workingSetBytes:count*L,
                ...rates,transferIncludedGBps:count*L/elapsed/1e9,hostHashOnlyGBps:count*L/hashSeconds/1e9,
                correctness:"byte-for-byte CPU reference",target80GBps:rates.deviceSpanGBps>=80};
            console.log(JSON.stringify(report));
            if(!best||report.deviceSpanGBps>best.deviceSpanGBps)best=report;
        }finally{gpu.close();}
    }
    console.log(JSON.stringify({type:"recommendation",binaryKernel:best.binaryKernel,deviceSpanGBps:best.deviceSpanGBps,
        env:"S10_GPU_BINARY_KERNEL="+best.binaryKernel,note:"Choose only after correctness passes; no claim about verified archive throughput."}));
}
if(require.main===module)main();
module.exports={fixture};

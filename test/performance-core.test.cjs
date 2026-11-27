"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {runPipeline}=require("../ordered-pipeline.cjs");
const {encodeBinary}=require("../binary-encode.cjs");
const {encodeBinary:reference}=require("../binary-encode-reference.cjs");
const {expandBinaryInto}=require("../binary-palette.cjs");
const forward=Uint16Array.from({length:1024},(_,i)=>(i*613+41)&1023);
test("ordered pipeline scratch lifetime and failure cursor",()=>{
 for(const slots of [1,2])for(const fail of [-1,0,5,10,15]){
    const buffers=Array.from({length:slots+1},()=>new Uint8Array(1)),active=new Set(),delivered=[];
    let cursor=0,gpu=0;
    function run(){runPipeline({start:0,end:17,batchSize:5,slots,
      submit:(first,last,s)=>{assert(!active.has(s));active.add(s);buffers[s][0]=first;assert(++gpu<=slots);return {s,first};},
      collect:h=>{gpu--;return h;},
      deliver:(first,h)=>{assert.equal(buffers[h.s][0],first);if(first===fail)throw Error("injected");active.delete(h.s);delivered.push(first);},
      onProgress:last=>cursor=last});}
    if(fail<0){run();assert.equal(cursor,17);}else{assert.throws(run,/injected/);assert.equal(cursor,fail);}
    assert.deepEqual(delivered,Array.from({length:Math.ceil(cursor/5)},(_,i)=>i*5));
 }
});
test("packed encoder and reusable output",()=>{
 let seed=42;const rand=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 for(const n of [...Array.from({length:250},(_,i)=>i+16),65531,65535,65536]){
  for(const [a,b] of [[0,1023],[511,513],[0,1],[0,0],[rand()&1023,rand()&1023]]){
   const raw=new Uint8Array(n);
   for(let j=0;j<Math.ceil(n*8/10);j++){
    const v=rand()>>>31?b:a;
    for(let k=0;k<10&&j*10+k<n*8;k++)if(v>>k&1)raw[(j*10+k)>>>3]|=1<<((j*10+k)&7);
   }
   const out=encodeBinary(raw,forward),old=reference(raw,forward);assert.deepEqual(out,old);
   if(out&&out[0]===2){
    const v0=forward.indexOf(out[2]|out[3]<<8),v1=forward.indexOf(out[4]|out[5]<<8);
    const storage=new Uint8Array(n+8).fill(0xaa),dest=storage.subarray(4,n+4);
    assert.strictEqual(expandBinaryInto(out.subarray(6),dest,v0,v1),dest);
    assert.deepEqual(dest,raw);
    assert.deepEqual([...storage.subarray(0,4),...storage.subarray(n+4)],[170,170,170,170,170,170,170,170]);
   }
  }
 }
 const shared=new Uint8Array(10);
 assert.throws(()=>expandBinaryInto(shared.subarray(0,1),shared,0,1),/overlap/i);
});

"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {makeVerifyJob,verifyDecoded}=require("../verify-decoded.cjs");
const {makeDictionary,encodePalette,decodePalette}=require("../block-codec.cjs");
const digest=x=>crypto.createHash("sha256").update(x).digest();
test("GPU backing transferred once, CPU rows copied and corruption rejected",()=>{
 const backing=new Uint8Array(20),cpu=new Uint8Array([1,2,3]);
 for(let i=0;i<20;i++)backing[i]=i;
 const blocks=[backing.subarray(0,10),cpu,backing.subarray(10)];blocks.deviceBuffer=backing;
 const index=Buffer.alloc(96);
 blocks.forEach((b,i)=>digest(b).copy(index,i*32+16,0,16));
 const {job,transfer}=makeVerifyJob(blocks,index,0,32,true);
 assert.equal(transfer.length,3);assert.equal(job.rows[0].buffer,backing.buffer);
 assert.notEqual(job.rows[1].buffer,cpu.buffer);
 assert.equal(verifyDecoded(job,digest).rows.length,3);
 job.rows[1][0]^=1;assert.throws(()=>verifyDecoded(job,digest),/checksum mismatch at block 1/);
});
test("wide palettes match reference across widths and tails",()=>{
 const dict=makeDictionary(42);
 for(const levels of [3,7,15,31,63,127,255,511])for(let tail=0;tail<20;tail++){
  const raw=new Uint8Array(65536-tail);let seed=42,acc=0,bits=0,pos=0;
  while(pos<raw.length){
   seed=(Math.imul(seed,1664525)+1013904223)>>>0;
   acc|=(seed%levels)<<bits;bits+=10;
   while(bits>=8&&pos<raw.length){raw[pos++]=acc;acc>>>=8;bits-=8;}
  }
  const packed=encodePalette(raw,dict);
  if(!packed)continue;
  const fast=decodePalette(packed,raw.length,dict);
  const before=process.env.S10_DISABLE_WIDE_NATIVE;
  try{process.env.S10_DISABLE_WIDE_NATIVE="1";assert.deepEqual(Buffer.from(fast),Buffer.from(decodePalette(packed,raw.length,dict)));}
  finally{if(before===undefined)delete process.env.S10_DISABLE_WIDE_NATIVE;else process.env.S10_DISABLE_WIDE_NATIVE=before;}
  assert.deepEqual(Buffer.from(fast),Buffer.from(raw));
 }
});

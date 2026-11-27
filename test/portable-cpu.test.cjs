"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {clockModel,estimate}=require("../clock-model.cjs");
const {encodeBinaryNative,nativeEncoderAvailable}=require("../binary-palette.cjs");
const {encodeBinary:reference}=require("../binary-encode-reference.cjs");
test("frequency fit and memory cap",()=>{
 const m=clockModel(4e9,1,2400,4);
 assert.equal(m.divisorMHzPerGBps,2400);
 assert.equal(estimate({mhz:2400,workers:4,divisor:2400}),4);
 assert.equal(estimate({mhz:2400,workers:4,divisor:2400,memoryGBps:3,trafficPerByte:1.5}),2);
});
test("native encoder exact agreement",{skip:!nativeEncoderAvailable},()=>{
 const forward=Uint16Array.from({length:1024},(_,i)=>(i*613+41)&1023);
 let seed=42;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 for(const n of [...Array.from({length:300},(_,i)=>i+16),65531,65535,65536]){
  for(const [a,b] of [[0,1],[0,1023],[511,513],[7,7],[next()&1023,next()&1023]]){
   const raw=new Uint8Array(n);
   for(let j=0;j<Math.ceil(n*8/10);j++){const v=next()>>>31?a:b;for(let k=0;k<10&&j*10+k<n*8;k++)if(v>>k&1)raw[(j*10+k)>>>3]|=1<<((j*10+k)&7);}
   assert.deepEqual(encodeBinaryNative(raw,forward),reference(raw,forward));
  }
 }
 for(let n=16;n<300;n++){const raw=Uint8Array.from({length:n},()=>next()>>>24);assert.deepEqual(encodeBinaryNative(raw,forward),reference(raw,forward));}
});

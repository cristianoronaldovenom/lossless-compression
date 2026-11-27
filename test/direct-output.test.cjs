"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {makeDictionary,encodeBlock,decodeBlockInto}=require("../block-codec.cjs");
test("direct worker destination, all modes and bounds",()=>{
 const dict=makeDictionary(42);
 for(const n of [16,17,79,80,81,65535,65536]){
  for(const kind of [0,1,2,3]){
   const raw=new Uint8Array(n);
   if(kind===1)for(let j=0;j<Math.ceil(n*8/10)-1;j++)if(j&1)raw[(j*10)>>>3]|=1<<((j*10)&7);
   if(kind===2)for(let j=0;j<n;j++)raw[j]=j%7;
   if(kind===3){let x=42;for(let j=0;j<n;j++){x^=x<<13;x^=x>>>17;x^=x<<5;raw[j]=x;}}
   const packed=encodeBlock(raw,dict,kind<2),backing=new Uint8Array(n+8).fill(170),dest=backing.subarray(4,n+4);
   assert.equal(decodeBlockInto(packed.mode,packed.bytes,dest,dict),dest);
   assert.deepEqual(dest,raw);
   assert.deepEqual([...backing.subarray(0,4),...backing.subarray(n+4)],Array(8).fill(170));
  }
 }
 const bytes=new Uint8Array(20);
 assert.throws(()=>decodeBlockInto(0,bytes.subarray(0,10),bytes.subarray(5,15),dict),/Overlapping/);
});

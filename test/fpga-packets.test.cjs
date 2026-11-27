"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {packJob}=require("../fpga-packets.cjs");
test("DMA packet layout and all final sizes",()=>{
 for(let n=1;n<=65536;n+=n<160?1:257){
  const count=Math.ceil(n*8/10),indices=new Uint8Array(Math.ceil(count/8));
  for(let i=0;i<count-1;i++)if(i&1)indices[i>>>3]|=1<<(i&7);
  const records=packJob({indices,length:n,a:0,b:1023});
  assert.equal(records.length,16*Math.ceil(n/80));
  const view=new DataView(records.buffer,records.byteOffset,records.byteLength);
  for(let i=0;i<records.length/16;i++){
   const p=i*16,c=view.getUint32(p+8,true);
   assert.equal(c&1023,0);assert.equal(c>>>10&1023,1023);
   assert.equal(c>>>20&127,Math.min(80,n-i*80));
   assert.equal(c>>>27&1,Number(i===records.length/16-1));
   assert.equal(c>>>28,0);assert.equal(view.getUint32(p+12,true),0);
   for(let j=0;j<8;j++)assert.equal(records[p+j],indices[i*8+j]??0);
  }
 }
 assert.throws(()=>packJob({indices:Uint8Array.of(255),length:1,a:0,b:1}),/padding/);
});

"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createFpga}=require("../fpga-backend.cjs");
const {ranges,autotune}=require("../platform.cjs");
test("FPGA simulator: exact padding, descriptor bounds and result",()=>{
 const inverse=Uint16Array.from({length:1024},(_,i)=>i);
 const f=createFpga(inverse,"simulator");
 try{
  const p=Uint8Array.of(0,0,255,3,0x55);
  const jobs=Uint32Array.of(0,4,2,1,10);
  const out=f.decode(p,jobs,1);
  let expected=0n;for(let i=0;i<8;i++)if(0x55>>i&1)expected|=1023n<<BigInt(10*i);
  assert.deepEqual([...out],Array.from({length:10},(_,i)=>Number(expected>>BigInt(i*8)&255n)));
  assert.throws(()=>f.decode(p,Uint32Array.of(0,4,2,2,10),1),/descriptor/);
  assert.throws(()=>f.decode(p,Uint32Array.of(0,4,2,1,1),1),/padding/);
 }finally{f.close();}
});
test("autotune uses verified sample times and closes each reader",()=>{
 let clock=0,closed=0;
 const result=autotune("test",(_,opts)=>({
  size:20*1024*1024,visit(){clock+=opts.gpu===false?4:1;},
  close(){closed++;}
 }),{discover:()=>({opencl:[{supported:true,index:0}]}),now:()=>clock,report:()=>{}});
 assert.equal(result.selected,0);assert.equal(closed,2);
 assert.equal(ranges(0).length,0);assert.equal(ranges(20e6).length,3);
});
test("FPGA simulator archive round-trip with CPU fallback",async()=>{
 const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
 const {main}=require("../symbol10.cjs");
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"s10-fpga-"));
 try{
  const raw=Buffer.alloc(65536*3+7);
  for(let i=65536;i<131072;i++)raw[i]=i&255;
  for(let j=0;j<Math.floor(65536*8/10)-1;j++)if(j&1)
   for(let k=0;k<10;k++)raw[131072+((j*10+k)>>>3)]|=1<<((j*10+k)&7);
  const input=path.join(dir,"in"),archive=path.join(dir,"archive"),output=path.join(dir,"out");
  fs.writeFileSync(input,raw);
  await main(["pack",input,archive,"--fast-decode"]);
  await main(["fpga-unpack",archive,output,"simulator"]);
  assert.deepEqual(fs.readFileSync(output),raw);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

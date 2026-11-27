"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {bitWindow,extractBits}=require("../bit-access.cjs");
const {VerifiedReader}=require("../verified-reader.cjs");
const {makeDictionary,encodeBlock,decodeBlock,CHUNK_BYTES:L,PALETTE}=require("../block-codec.cjs");
const {digest,MAGIC,END_MAGIC}=require("../archive-format.cjs");
function fixture(){
 const seed=17,dict=makeDictionary(seed),raw=Buffer.alloc(L*10+17),blocks=[];
 for(let i=0;i<9;i++)for(let j=0;j<Math.ceil(L*8/10)-1;j++)if((j*13+i)%7<3)raw[i*L+((j*10)>>>3)]|=1<<((j*10)&7);
 // Non-palette row to exercise the CPU side of mixed decoding.
 for(let j=9*L;j<raw.length;j++)raw[j]=(j*73+(j>>>9))&255;
 const header=Buffer.alloc(16);MAGIC.copy(header);header.writeUInt32LE(seed,8);
 const index=Buffer.alloc(Math.ceil(raw.length/L)*32);let at=16;
 for(let i=0;i<index.length/32;i++){
  const row=raw.subarray(i*L,(i+1)*L),p=encodeBlock(row,dict,true),e=i*32;
  index.writeBigUInt64LE(BigInt(at),e);index.writeUInt32LE(p.bytes.length,e+8);index[e+12]=p.mode;digest(row).copy(index,e+16,0,16);
  blocks.push(Buffer.from(p.bytes));at+=p.bytes.length;
 }
 const footer=Buffer.alloc(56);footer.writeBigUInt64LE(BigInt(raw.length));footer.writeBigUInt64LE(BigInt(at),8);
 digest(header,index,footer.subarray(0,16)).copy(footer,16);END_MAGIC.copy(footer,48);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"s10-reader-")),file=path.join(dir,"test.s10");
 fs.writeFileSync(file,Buffer.concat([header,...blocks,index,footer]));
 return {raw,file,dir,dict,index,blocks};
}
function reference(raw,offset,width){let result=0;for(let i=0;i<width;i++){const pos=offset+i;result+=((raw[Math.floor(pos/8)]>>>(pos%8))&1)*2**i;}return result;}
test("all bit phases and widths, including 16-bit reads over three symbols",()=>{
 const data=Uint8Array.from({length:64},(_,i)=>(i*73+91)&255);
 for(let off=0;off<400;off++)for(let width=1;width<=32;width++){
  const w=bitWindow(off,width,data.length);assert.equal(extractBits(data.subarray(w.firstByte,w.firstByte+w.bytes),w.shift,width),reference(data,off,width));
 }
 assert.equal(bitWindow(0,16,64).symbols,2);assert.equal(bitWindow(9,16,64).symbols,3);
});
test("verified byte ranges, boundaries, cache ownership and mutation detection",()=>{
 const f=fixture();let r;
 try{
  r=new VerifiedReader(f.file,{cacheBytes:L*2});
  for(const [offset,length] of [[0,1],[L-3,19],[L*2-1,2],[0,L*3+7],[f.raw.length-17,17],[f.raw.length,0]])assert.deepEqual(r.read(offset,length),f.raw.subarray(offset,offset+length));
  for(let i=L*8-19;i<L*8+19;i++)for(const w of [8,16,32])assert.equal(r.readBits(i,w),reference(f.raw,i,w));
  const copy=r.read(0,32);copy.fill(255);assert.deepEqual(r.read(0,32),f.raw.subarray(0,32));assert.ok(r.stats.hits>0);assert.ok(r.stats.cacheBytes<=L*2);
  assert.throws(()=>r.read(-1,1));assert.throws(()=>r.read(f.raw.length,1));
  fs.appendFileSync(f.file,Buffer.from([1]));assert.throws(()=>r.read(0,1),/changed/);
 }finally{r?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
function fakeGpu(dict,corrupt){
 let pending;
 return {batchBlocks:16,supportsWidth:()=>true,submit(input,desc,count){pending={input,desc,count};},flush(){},
 finish(){const {input,desc,count}=pending,out=Buffer.alloc(count*L);
  for(let j=0;j<count;j++){const [p,i,k,w,len]=desc.subarray(j*5,j*5+5),end=i+Math.ceil(Math.ceil(len*8/10)*w/8);
   const decoded=decodeBlock(PALETTE,input.subarray(p-2,end),len,dict);out.set(decoded,j*L);}
  if(corrupt)out[0]^=1;return out;},discard(){},close(){}};
}
test("GPU verified results and corrupt device fallback",()=>{
 const f=fixture();try{
  for(const corrupt of [false,true]){
   const r=new VerifiedReader(f.file,{cacheBytes:0,gpuMinBlocks:2,gpuFactory:()=>fakeGpu(f.dict,corrupt)});
   try{assert.deepEqual(r.read(0,f.raw.length),f.raw);
    if(corrupt){assert.equal(r.stats.gpuFailures,1);assert.equal(r.stats.gpuActive,false);assert.ok(r.stats.cpuBlocks>=9);}
    else{assert.ok(r.stats.gpuBlocks>=9);assert.ok(r.stats.cpuBlocks>=1);}
   }finally{r.close();}
  }
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test("corrupted stored payload never updates destination",()=>{
 const f=fixture();let r;try{
  const fd=fs.openSync(f.file,"r+");try{const b=Buffer.from([f.blocks[0][6]^1]);fs.writeSync(fd,b,0,1,22);}finally{fs.closeSync(fd);}
  r=new VerifiedReader(f.file);const target=Buffer.alloc(32,0x5a);
  assert.throws(()=>r.readInto(0,target));assert.ok(target.every(x=>x===0x5a));
 }finally{r?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test("verified snapshots support fast typed reads, independent ownership and stable old contents",()=>{
 const f=fixture();let r;try{
  r=new VerifiedReader(f.file);const offset=L-11,length=128,s=r.snapshot(offset,length),original=f.raw.subarray(offset,offset+length);
  for(let i=0;i<length-4;i++){
   assert.equal(s.readU16LE(i),original.readUInt16LE(i));assert.equal(s.readU32LE(i),original.readUInt32LE(i));
   for(const w of [1,10,16,32])assert.equal(s.readBits(i*8+3,w),reference(original,i*8+3,w));
  }
  const c=s.read(0,20);c.fill(0xff);assert.deepEqual(s.read(0,20),original.subarray(0,20));
  const d=Buffer.alloc(20);s.readInto(4,d);assert.deepEqual(d,original.subarray(4,24));
  r.close();assert.equal(s.readU32LE(0),original.readUInt32LE(0));assert.throws(()=>s.readU32LE(length-3));
 }finally{r?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

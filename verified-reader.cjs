"use strict";
const fs=require("node:fs");
const {CHUNK_BYTES:L,RAW,PALETTE,makeDictionary,paletteLayout,decodeBlockInto}=require("./block-codec.cjs");
const {ENTRY_BYTES:E,inspectArchive,readExactly,digest}=require("./archive-format.cjs");
const {bitWindow,extractBits}=require("./bit-access.cjs");
const MAX_READ=16*1024*1024;
const sig=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(":");

// A verified, private, immutable-in-API snapshot for asset hot paths.
// No filesystem calls on each lookup; it represents the bytes at creation,
// not a live view of the archive. No public backing-buffer access.
class VerifiedSnapshot {
 #bytes;
 constructor(bytes){this.#bytes=bytes;}
 get size(){return this.#bytes.length;}
 #check(offset,length){
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||offset>this.size-length)throw RangeError("Invalid snapshot range");
 }
 read(offset,length){this.#check(offset,length);return Buffer.from(this.#bytes.subarray(offset,offset+length));}
 readInto(offset,dest){
  if(!(dest instanceof Uint8Array))throw TypeError("Expected Uint8Array");
  this.#check(offset,dest.length);dest.set(this.#bytes.subarray(offset,offset+dest.length));return dest;
 }
 readU16LE(offset){this.#check(offset,2);return this.#bytes.readUInt16LE(offset);}
 readU32LE(offset){this.#check(offset,4);return this.#bytes.readUInt32LE(offset);}
 readBits(offset,width){
  const w=bitWindow(offset,width,this.size);
  let word=0;for(let i=0;i<w.bytes;i++)word+=this.#bytes[w.firstByte+i]*2**(8*i);
  return Math.floor(word/2**w.shift)%2**width;
 }
}

class VerifiedReader{
 #fd;#archive;#dict;#stamp;#cache=new Map();#used=0;#limit;#gpu;#gpuMin;#gpuDisabled=false;#ownsGpu=false;
 #stats={hits:0,misses:0,cpuBlocks:0,gpuBlocks:0,gpuFailures:0,verifiedBytes:0};
 constructor(path,{cacheBytes=16*1024*1024,gpuIndex=null,gpuMinBlocks=8,gpuFactory}={}){
  if(!Number.isSafeInteger(cacheBytes)||cacheBytes<0||cacheBytes>256*1024*1024||
     !Number.isInteger(gpuMinBlocks)||gpuMinBlocks<1||gpuMinBlocks>256)throw RangeError("Invalid reader options");
  this.#limit=cacheBytes;this.#gpuMin=gpuMinBlocks;
  this.#fd=fs.openSync(path,"r");
  try{
   this.#stamp=sig(fs.fstatSync(this.#fd,{bigint:true}));
   this.#archive=inspectArchive(this.#fd);this.#dict=makeDictionary(this.#archive.seed);
   this.#check();
   if(gpuIndex!==null||gpuFactory){
    try{this.#gpu=(gpuFactory??((inverse,index)=>require("./opencl.cjs").createGpu(inverse,index)))(this.#dict.inverse.slice(),gpuIndex===true?undefined:gpuIndex);
     this.#ownsGpu=true;
    }catch{this.#gpuDisabled=true;this.#stats.gpuFailures++;}
   }
  }catch(e){this.close();throw e;}
 }
 get size(){return this.#archive.rawSize;}
 get stats(){return {...this.#stats,cacheBytes:this.#used,gpuActive:!!this.#gpu&&!this.#gpuDisabled};}
 #check(){
  if(this.#fd===undefined)throw Error("Reader closed");
  if(sig(fs.fstatSync(this.#fd,{bigint:true}))!==this.#stamp){this.#cache.clear();this.#used=0;throw Error("Archive changed while open");}
 }
 #load(id){
  const index=this.#archive.index,at=id*E;
  const length=Math.min(L,this.size-id*L),stored=index.readUInt32LE(at+8),mode=index[at+12];
  const packed=readExactly(this.#fd,stored,Number(index.readBigUInt64LE(at)));
  return {id,length,mode,packed,hash:index.subarray(at+16,at+32)};
 }
 #verify(row,raw){
  if(!(raw instanceof Uint8Array)||raw.length!==row.length||
     !digest(raw).subarray(0,16).equals(row.hash))throw Error("Chunk checksum mismatch at block "+row.id);
  this.#stats.verifiedBytes+=raw.length;
 }
 #cpu(row){
  const raw=Buffer.allocUnsafe(row.length);
  decodeBlockInto(row.mode,row.packed,raw,this.#dict);this.#verify(row,raw);this.#stats.cpuBlocks++;
  return raw;
 }
 #remember(id,raw){
  if(raw.length>this.#limit)return;
  while(this.#used+raw.length>this.#limit&&this.#cache.size){
   const [key,old]=this.#cache.entries().next().value;this.#cache.delete(key);this.#used-=old.length;
  }
  this.#cache.set(id,raw);this.#used+=raw.length;
 }
 #decode(rows){
  const ready=new Map(),eligible=[],cpu=[];
  for(const row of rows){
   if(this.#gpu&&!this.#gpuDisabled&&row.mode===PALETTE){
    const layout=paletteLayout(row.packed,row.length);
    // Zero/repeated blocks are cheap CPU fills; GPU only for larger batches.
    if(layout.width>0&&(!this.#gpu.supportsWidth||this.#gpu.supportsWidth(layout.width))){
     eligible.push({...row,layout});continue;
    }
   }
   cpu.push(row);
  }
  if(eligible.length<this.#gpuMin){cpu.push(...eligible);eligible.length=0;}
  const max=Math.max(1,Math.min(256,this.#gpu?.batchBlocks??1));
  // Submit one GPU batch, then use CPU while the device is running.
  for(let i=0;i<eligible.length;i+=max){
   const group=eligible.slice(i,i+max);
   if(this.#gpuDisabled){cpu.push(...group);continue;}
   const desc=new Uint32Array(group.length*5);let offset=0;
   for(let j=0;j<group.length;j++){
    const r=group[j],p=r.layout;
    desc.set([offset+2,offset+p.paletteEnd,p.paletteLength,p.width,r.length],j*5);offset+=r.packed.length;
   }
   try{
    this.#gpu.submit(Buffer.concat([...group.map(r=>r.packed),Buffer.alloc(8)]),desc,group.length);
    this.#gpu.flush();
   }catch{
    this.#disableGpu();cpu.push(...group);continue;
   }
   // CPU errors are archive errors, not GPU failures.
   try{while(cpu.length){const r=cpu.pop();ready.set(r.id,this.#cpu(r));}}
   catch(e){this.#disableGpu();throw e;}
   try{
    const output=this.#gpu.finish(),verified=[];
    for(let j=0;j<group.length;j++){
     const row=group[j],raw=Buffer.from(output.subarray(j*L,j*L+row.length));
     this.#verify(row,raw);verified.push([row.id,raw]);
    }
    for(const [id,raw] of verified)ready.set(id,raw);
    this.#stats.gpuBlocks+=group.length;
   }catch{
    // Reject the whole device batch, independently decode and verify on CPU.
    this.#disableGpu();cpu.push(...group);
   }
  }
  for(const r of cpu)ready.set(r.id,this.#cpu(r));
  return ready;
 }
 #disableGpu(){this.#gpuDisabled=true;this.#stats.gpuFailures++;try{this.#gpu.discard?.();}catch{}}
 read(offset,length){
  this.#check();
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||length>MAX_READ||offset>this.size-length)throw RangeError("Invalid byte range");
  const result=Buffer.allocUnsafe(length);
  if(!length)return result;
  const first=Math.floor(offset/L),last=Math.floor((offset+length-1)/L);
  const ready=new Map(),missing=[];
  for(let id=first;id<=last;id++){
   const cached=this.#cache.get(id);
   if(cached){this.#cache.delete(id);this.#cache.set(id,cached);ready.set(id,cached);this.#stats.hits++;}
   else{missing.push(this.#load(id));this.#stats.misses++;}
  }
  for(const [id,raw] of this.#decode(missing)){ready.set(id,raw);}
  // Never publish unverified bytes or cache a partially failed batch.
  this.#check();
  let written=0;
  for(let id=first;id<=last;id++){
   const raw=ready.get(id),start=Math.max(0,offset-id*L),end=Math.min(raw.length,offset+length-id*L);
   result.set(raw.subarray(start,end),written);written+=end-start;
   if(!this.#cache.has(id))this.#remember(id,raw);
  }
  if(written!==length)throw Error("Incomplete range");
  return result;
 }
 readInto(offset,dest){
  if(!(dest instanceof Uint8Array))throw TypeError("Expected Uint8Array");
  // Caller buffer remains unchanged if verification fails.
  dest.set(this.read(offset,dest.length));return dest;
 }
 readBits(offset,width){
  const w=bitWindow(offset,width,this.size);return extractBits(this.read(w.firstByte,w.bytes),w.shift,width);
 }
 prefetch(offset,length){this.read(offset,length);return this.stats;}
 snapshot(offset,length){return new VerifiedSnapshot(this.read(offset,length));}
 close(){
  if(this.#ownsGpu){try{this.#gpu?.close();}finally{this.#ownsGpu=false;if(this.#fd!==undefined){fs.closeSync(this.#fd);this.#fd=undefined;}this.#cache.clear();this.#used=0;}}
  else{if(this.#fd!==undefined){fs.closeSync(this.#fd);this.#fd=undefined;}this.#cache.clear();this.#used=0;}
 }
}
module.exports={VerifiedReader,MAX_READ};

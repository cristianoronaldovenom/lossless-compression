"use strict";
const os=require("node:os"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const {performance}=require("node:perf_hooks");
const {Worker,isMainThread,parentPort,workerData}=require("node:worker_threads");
const {clockModel}=require("../clock-model.cjs");
const {encodeBinary}=require("../binary-encode.cjs");
const {expandBinaryInto,nativeEnabled,nativeEncoderAvailable}=require("../binary-palette.cjs");
const {makeDictionary,encodeBlock,decodeBlock,RAW,PALETTE,DEFLATE}=require("../block-codec.cjs");
const sha=x=>crypto.createHash("sha256").update(x).digest();
const dict=makeDictionary(42),L=65536;
function fixture(profile,count,id){
 const rows=[];let s=(42+id*113)>>>0;
 const next=()=>s=(Math.imul(s,1664525)+1013904223)>>>0;
 for(let i=0;i<count;i++){
  const raw=Buffer.alloc(L);
  if(profile==="binary"){
   for(let j=0;j<Math.ceil(L*8/10)-1;j++)if(next()>>>31)raw[(j*10)>>>3]|=1<<((j*10)&7);
  }else if(profile==="text"){
   const line=Buffer.from("Symbol10 portable test record "+i+" with repeated text and numbers "+next()+"\n");
   for(let j=0;j<L;j+=line.length)line.copy(raw,j,0,Math.min(line.length,L-j));
  }else for(let j=0;j<L;j+=4)raw.writeUInt32LE(next(),j);
  const packed=encodeBlock(raw,dict,profile==="binary"),hash=sha(raw);
  assert.deepEqual(Buffer.from(decodeBlock(packed.mode,packed.bytes,L,dict)),raw);
  const dest=new Uint8Array(L);
  if(profile==="binary"){
   assert.equal(packed.mode,PALETTE);assert.equal(packed.bytes[0],2);
   const p=packed.bytes,a=dict.inverse[p[2]|p[3]<<8],b=dict.inverse[p[4]|p[5]<<8];
   rows.push({raw,packed,hash,dest,a,b,indices:p.subarray(6)});
  }else rows.push({raw,packed,hash,dest});
 }
 return rows;
}
function work({profile,mode,count,id,seconds,gate}){
 const rows=fixture(profile,count,id);
 const modes={raw:0,palette:0,deflate:0};let stored=0;
 for(const r of rows){stored+=r.packed.bytes.length;modes[r.packed.mode===RAW?"raw":r.packed.mode===PALETTE?"palette":"deflate"]++;}
 const operation=r=>{
  if(mode==="encode"||mode==="encodeVerified"){
   const p=encodeBlock(r.raw,dict,profile==="binary");
   if(mode==="encodeVerified")sha(r.raw);
   return p.bytes[0];
  }
  if(mode==="hash")return sha(r.raw)[0];
  const out=profile==="binary"&&mode!=="decodeAlloc"?
    expandBinaryInto(r.indices,r.dest,r.a,r.b):decodeBlock(r.packed.mode,r.packed.bytes,L,dict);
  if(mode==="verified"&&!sha(out).equals(r.hash))throw Error("Checksum mismatch");
  return out[0];
 };
 for(const r of rows)operation(r);
 parentPort.postMessage({ready:true});
 Atomics.wait(gate,0,0);
 const t=performance.now();let n=0,guard=0;
 do{for(let i=0;i<Math.min(count,16);i++){guard^=operation(rows[n%count]);n++;}}
 while(performance.now()-t<seconds*1000);
 const elapsed=(performance.now()-t)/1000;
 parentPort.postMessage({bytes:n*L,seconds:elapsed,stored,original:count*L,modes,guard});
}
async function trial(options,workers){
 const gate=new Int32Array(new SharedArrayBuffer(4)),pool=[];
 const startCpu=process.cpuUsage();let ready=0,begin;
 try{
  const jobs=Array.from({length:workers},(_,id)=>new Promise((resolve,reject)=>{
   const w=new Worker(__filename,{workerData:{...options,id,gate}});pool.push(w);
   w.on("error",reject);w.on("exit",code=>{if(code!==0)reject(Error("Worker exited "+code));});
   w.on("message",r=>{
    if(r.ready){if(++ready===workers){begin=performance.now();Atomics.store(gate,0,1);Atomics.notify(gate,0,workers);}}
    else resolve(r);
   });
  }));
  const rows=await Promise.all(jobs),wall=(performance.now()-begin)/1000;
  const usage=process.cpuUsage(startCpu);
  return {bytes:rows.reduce((a,b)=>a+b.bytes,0),seconds:wall,
   stored:rows.reduce((a,b)=>a+b.stored,0),original:rows.reduce((a,b)=>a+b.original,0),
   modes:rows.reduce((a,b)=>{for(const k of Object.keys(a))a[k]+=b.modes[k];return a;},{raw:0,palette:0,deflate:0}),
   processCPUSeconds:(usage.user+usage.system)/1e6};
 }finally{Atomics.store(gate,0,1);Atomics.notify(gate,0);await Promise.allSettled(pool.map(w=>w.terminate()));}
}
async function main(){
 const cpus=os.availableParallelism?.()??os.cpus().length;
 const workers=Number(process.argv[2]??Math.max(1,Math.floor(cpus/4)));
 const seconds=Number(process.argv[3]??.5),rounds=Number(process.argv[4]??3),count=Number(process.argv[5]??32);
 if(!Number.isInteger(workers)||workers<1||workers>Math.min(16,cpus)||!Number.isFinite(seconds)||seconds<.1||seconds>30||
 !Number.isInteger(rounds)||rounds<1||rounds>9||!Number.isInteger(count)||count<1||count>128)throw Error("Usage: bench-portable.cjs workers seconds rounds blocksPerWorker");
 const info=require("../platform.cjs").hardwareInfo();
 console.log(JSON.stringify({type:"hardware",...info,nativeEnabled,nativeEncoderAvailable,workers,seconds,rounds,blocksPerWorker:count,
 rawWorkingSetBytes:workers*count*L,clockWarning:"OS-reported MHz, not sampled hardware cycles; no physical I/O"}));
 for(const profile of ["binary","text","random"])for(const mode of ["encode","encodeVerified","decodeAlloc","decode","verified","hash"]){
  if(profile!=="binary"&&mode==="decodeAlloc")continue;
  const samples=[];
  for(let i=0;i<rounds;i++){
   const r=await trial({profile,mode,count,seconds},workers);
   const mhz=os.cpus().map(c=>c.speed).filter(x=>x>0);
   const f=mhz.length?mhz.reduce((a,b)=>a+b,0)/mhz.length:0;
   samples.push({...r,gbps:r.bytes/r.seconds/1e9,reportedMeanMHz:f,
    model:f?clockModel(r.bytes,r.seconds,f,workers):null});
  }
  samples.sort((a,b)=>a.gbps-b.gbps);const median=samples[Math.floor(samples.length/2)];
  console.log(JSON.stringify({type:"result",profile,mode,workers,medianGBps:median.gbps,
    minGBps:samples[0].gbps,maxGBps:samples.at(-1).gbps,ratio:median.original/median.stored,
    modes:median.modes,clockModel:median.model,samples}));
 }
}
if(isMainThread)main().catch(e=>{console.error(e);process.exitCode=1;});else work(workerData);

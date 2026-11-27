"use strict";
const os=require("node:os"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const {Worker,isMainThread,parentPort,workerData}=require("node:worker_threads");
const {performance}=require("node:perf_hooks");
const {expandBinaryInto,cpuCapabilities,nativeEnabled}=require("../binary-palette.cjs");
const L=65536,I=6554;
function work(o){
 const n=o.blocks,output=Buffer.alloc(n*L),indices=Buffer.alloc(n*I),pal=[];
 let seed=12345+o.id;const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
 for(let i=0;i<n;i++){
  const a=rand()&255;let b=rand()&1023;if(a===b)b^=512;
  const input=indices.subarray(i*I,(i+1)*I);for(let j=0;j<I;j++)input[j]=rand()&255;input[I-1]&=7;
  const dest=output.subarray(i*L,(i+1)*L);
  // Independent scalar bitstream reference, not the chosen kernel.
  const expected=Buffer.alloc(L);let acc=0,bits=0,at=0;
  for(let k=0;k<Math.ceil(L*8/10);k++){acc|=(input[k>>>3]>>(k&7)&1?b:a)<<bits;bits+=10;
   while(bits>=8&&at<L){expected[at++]=acc&255;acc>>>=8;bits-=8;}}
  assert.equal(acc,0);
  expandBinaryInto(input,dest,a,b);assert.ok(dest.equals(expected));
  pal.push({input,dest,a,b,hash:crypto.createHash("sha256").update(expected).digest()});
 }
 const run=()=>{for(const p of pal){expandBinaryInto(p.input,p.dest,p.a,p.b);
   if(o.verified&&!crypto.createHash("sha256").update(p.dest).digest().equals(p.hash))throw Error("Hash mismatch");}};
 run();parentPort.postMessage({ready:true});Atomics.wait(o.gate,0,0);
 const t=performance.now();let passes=0;do{run();passes++;}while(performance.now()-t<o.seconds*1000);
 const finished=performance.now();
 for(const p of pal)assert.ok(crypto.createHash("sha256").update(p.dest).digest().equals(p.hash));
 parentPort.postMessage({bytes:passes*n*L,finished});
}
async function trial(options,workers){
 const gate=new Int32Array(new SharedArrayBuffer(4)),pool=[];let ready=0,start;
 const previous=process.env.S10_CPU_KERNEL;process.env.S10_CPU_KERNEL=options.kernel;
 try{
  const r=await Promise.all(Array.from({length:workers},(_,id)=>new Promise((resolve,reject)=>{
   const w=new Worker(__filename,{workerData:{...options,id,gate}});pool.push(w);
   w.on("error",reject);w.on("exit",code=>{if(code!==0)reject(Error("Worker exit "+code));});
   w.on("message",m=>{if(m.ready){if(++ready===workers){start=performance.now();Atomics.store(gate,0,1);Atomics.notify(gate,0);}}else resolve(m);});
  })));
  return r.reduce((s,x)=>s+x.bytes,0)/((Math.max(...r.map(x=>x.finished))-start)/1000)/1e9;
 }finally{Atomics.store(gate,0,1);Atomics.notify(gate,0);await Promise.allSettled(pool.map(w=>w.terminate()));if(previous===undefined)delete process.env.S10_CPU_KERNEL;else process.env.S10_CPU_KERNEL=previous;}
}
async function main(){
 const cpus=os.availableParallelism?.()??os.cpus().length,workers=Number(process.argv[2]??Math.min(4,cpus)),mib=Number(process.argv[3]??256),seconds=Number(process.argv[4]??1);
 if(!Number.isInteger(workers)||workers<1||workers>Math.min(64,cpus)||!Number.isFinite(mib)||mib<1||mib>1024||!Number.isFinite(seconds)||seconds<.2||seconds>20)throw Error("Usage: bench-cpu.cjs [workers] [total output MiB:1..1024] [seconds]");
 if(!nativeEnabled)throw Error("Build native addon first: npm run build:native");
 const caps=cpuCapabilities(),blocks=Math.max(1,Math.floor(mib*16/workers));
 console.log(JSON.stringify({type:"setup",cpu:os.cpus()[0]?.model,workers,outputWorkingSetMiB:blocks*workers/16,caps,warning:"Synthetic binary data; no file I/O. Working set may fit in CPU cache."}));
 const kernels=["scalar",...(caps.avx2?["avx2"]:[]),...(caps.bmi2?["bmi2"]:[])];
 for(const verified of [false,true])for(const kernel of kernels){
  const samples=[];for(let i=0;i<3;i++)samples.push(await trial({kernel,verified,blocks,seconds},workers));
  samples.sort((a,b)=>a-b);console.log(JSON.stringify({kernel,verified,medianGBps:samples[1],samples,meets80:samples[1]>=80}));
 }
}
if(isMainThread)main().catch(e=>{console.error(e);process.exitCode=1;});else work(workerData);

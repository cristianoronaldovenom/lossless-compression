"use strict";
const {performance}=require("node:perf_hooks"),os=require("node:os"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const {encodeBinary}=require("../binary-encode.cjs"),{encodeBinary:reference}=require("../binary-encode-reference.cjs");
const {expandBinary,expandBinaryInto,nativeEnabled}=require("../binary-palette.cjs");
const {makeDictionary}=require("../block-codec.cjs");
const dict=makeDictionary(42), raw=new Uint8Array(65536);
let seed=42;
for(let j=0;j<Math.ceil(raw.length*8/10)-1;j++){
 seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 if(seed>>>31)for(let k=0;k<10;k++)raw[(j*10+k)>>>3]|=1<<((j*10+k)&7);
}
const payload=encodeBinary(raw,dict.forward),a=dict.inverse[payload[2]|payload[3]<<8],b=dict.inverse[payload[4]|payload[5]<<8],idx=payload.subarray(6);
const dest=new Uint8Array(raw.length),expected=crypto.createHash("sha256").update(raw).digest("hex");
const hash=x=>crypto.createHash("sha256").update(x).digest("hex");
assert.deepEqual(payload,reference(raw,dict.forward));assert.equal(hash(expandBinaryInto(idx,dest,a,b)),expected);
const seconds=Number(process.argv[2]??1), rounds=Number(process.argv[3]??5);
if(!Number.isFinite(seconds)||seconds<.1||seconds>30||!Number.isInteger(rounds)||rounds<3||rounds>15)throw Error("Invalid benchmark options");
const cpus=os.availableParallelism?.()??os.cpus().length;
const tasks={
 "reference encode":()=>reference(raw,dict.forward),
 "packed encode":()=>encodeBinary(raw,dict.forward),
 "allocating decode":()=>expandBinary(idx,raw.length,a,b),
 "reused output decode":()=>expandBinaryInto(idx,dest,a,b),
 "verified reused decode":()=>{const r=expandBinaryInto(idx,dest,a,b);assert.equal(hash(r),expected);return r;}
};
console.log(JSON.stringify({nativeEnabled,cpus,platform:process.platform,arch:process.arch,node:process.version,ratio:raw.length/payload.length}));
for(const [name,fn] of Object.entries(tasks)){
 const samples=[];let guard=0;
 for(let r=0;r<rounds;r++){
  for(let i=0;i<100;i++)fn();
  let n=0;const t=performance.now(),c=process.cpuUsage();
  do{guard^=fn()[0];n++;}while(performance.now()-t<seconds*1000);
  const elapsed=(performance.now()-t)/1000,usage=process.cpuUsage(c);
  samples.push({GBps:n*raw.length/elapsed/1e9,cpuPercent:100*(usage.user+usage.system)/1e6/elapsed/cpus});
 }
 const sorted=samples.map(s=>s.GBps).sort((a,b)=>a-b);
 console.log(JSON.stringify({name,medianGBps:sorted[Math.floor(rounds/2)],minGBps:sorted[0],maxGBps:sorted.at(-1),samples,guard}));
}

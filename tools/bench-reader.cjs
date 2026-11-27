"use strict";
const {VerifiedReader}=require("../verified-reader.cjs"),{performance}=require("node:perf_hooks");
const path=process.argv[2],gpu=process.argv.includes("--gpu"),iterations=Number(process.argv[3]??20000);
if(!path||!Number.isSafeInteger(iterations)||iterations<100||iterations>1000000)throw Error("Usage: node tools/bench-reader.cjs archive.s10 [iterations] [--gpu]");
const r=new VerifiedReader(path,{gpuIndex:gpu?true:null});
try{
 if(r.size<4)throw Error("Archive must contain at least four bytes");
 let seed=42,guard=0;const samples=[],hot=Math.min(r.size,8*1024*1024);
 r.prefetch(0,hot);
 for(let i=0;i<iterations;i++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  const offset=seed%(hot*8-31),t=performance.now();guard^=r.readBits(offset,32);samples.push((performance.now()-t)*1e3);
 }
 samples.sort((a,b)=>a-b);
 console.log(JSON.stringify({phase:"hot random 32-bit reads",unit:"microseconds",p50:samples[Math.floor(samples.length*.5)],p95:samples[Math.floor(samples.length*.95)],p99:samples[Math.floor(samples.length*.99)],guard,stats:r.stats}));
 const snapshot=r.snapshot(0,hot),lat=[];seed=42;
 for(let i=0;i<iterations;i++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  const offset=seed%(hot*8-31),t=performance.now();guard^=snapshot.readBits(offset,32);lat.push((performance.now()-t)*1e3);
 }
 lat.sort((a,b)=>a-b);
 console.log(JSON.stringify({phase:"private verified snapshot random 32-bit reads",unit:"microseconds",p50:lat[Math.floor(lat.length*.5)],p95:lat[Math.floor(lat.length*.95)],p99:lat[Math.floor(lat.length*.99)],guard}));
 const t=performance.now();for(let off=0;off<r.size;off+=16*1024*1024)r.read(off,Math.min(16*1024*1024,r.size-off));
 console.log(JSON.stringify({phase:"verified sequential read including storage and copies",GBps:r.size/((performance.now()-t)*1e6),stats:r.stats}));
}finally{r.close();}

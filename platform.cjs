"use strict";
const os=require("node:os");
const {performance}=require("node:perf_hooks");
function hardwareInfo(){
    const info={platform:process.platform,arch:process.arch,node:process.version,
        logicalCPUs:os.availableParallelism?.()??os.cpus().length,memoryBytes:os.totalmem(),
        cpuModel:os.cpus()[0]?.model??"unknown",reportedMHz:os.cpus().map(c=>c.speed).filter(x=>x>0),
        native:require("./binary-palette.cjs").nativeEnabled,opencl:[]};
    try{info.opencl=require("./opencl.cjs").listGpus();}catch(error){info.openclError=error.message;}
    if(process.platform==="linux"){
        try{info.board=require("node:fs").readFileSync("/proc/device-tree/model","utf8").replace(/\0/g,"").trim();}catch{}
    }
    info.ecoWorkers=Math.max(1,Math.min(16,Math.floor(info.logicalCPUs/4)));
    return info;
}
function doctor(){const result=hardwareInfo();console.log(JSON.stringify(result,null,2));return result;}
function ranges(size,maxBytes=12*65536*3){
    if(!Number.isSafeInteger(size)||size<0||!Number.isSafeInteger(maxBytes)||maxBytes<3)throw Error("Invalid sample bounds");
    if(size<=maxBytes)return size?[{start:0,length:size}]:[];
    const length=Math.floor(maxBytes/3);
    return [{start:0,length},{start:Math.floor((size-length)/2),length},{start:size-length,length}];
}
function median(a){return [...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];}
function autotune(source,openArchive,{discover=hardwareInfo,now=()=>performance.now(),report=console.log}={}){
    const hardware=discover();
    const candidates=[false,...hardware.opencl.filter(x=>x.supported).map(x=>x.index)];
    const results=[];let size;
    for(const candidate of candidates){
        let reader;
        try{
            const init=now();
            reader=openArchive(source,{gpu:candidate,gpuPipeline:candidate!==false});
            size=reader.size;
            const samples=ranges(size);
            const visit=()=>{for(const r of samples)reader.visit(r.start,r.length);};
            visit();
            const startupMs=now()-init, times=[];
            for(let pass=0;pass<3;pass++){
                const t=now();visit();times.push(Math.max(.001,now()-t));
            }
            const bytes=samples.reduce((s,r)=>s+r.length,0);
            const rate=bytes/median(times)/1e6;
            // Project cold full-archive time conservatively. Sample speed is
            // verified decode (not file output); small files favor CPU.
            const estimateMs=startupMs+(rate>0?size/(rate*1e6):0);
            results.push({backend:candidate===false?"cpu":"opencl",selection:candidate,
                sampledBytes:bytes,medianGBps:rate,startupMs,estimateMs,device:reader.counters?.().device});
        }catch(error){
            if(candidate===false)throw error; // Never hide damaged archives.
            results.push({backend:"opencl",selection:candidate,error:error.message});
        }finally{reader?.close();}
    }
    const valid=results.filter(x=>!x.error).sort((a,b)=>a.estimateMs-b.estimateMs);
    const selected=valid[0]?.selection??false;
    const result={selected,results,note:"Sampled verified decode; not guaranteed full-file speed or utilization"};
    report(JSON.stringify(result,null,2));return result;
}
module.exports={hardwareInfo,doctor,ranges,autotune};

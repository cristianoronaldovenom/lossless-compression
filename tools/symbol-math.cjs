"use strict";
// Integer-exact size model. GB/s rates are decimal. BigInt avoids rounding
// file size and overhead when predicting large archives.
function ceilDiv(a,b){return (a+b-1n)/b;}
function blockCost(length, unique) {
    const n=BigInt(length), k=BigInt(unique);
    if(n<1n||n>65536n||k<1n||k>1024n) throw RangeError("Invalid block dimensions");
    const symbols=ceilDiv(8n*n,10n);
    if(k>symbols) throw RangeError("More distinct values than symbols");
    let width=0n; for(let x=k-1n;x;x>>=1n)width++;
    const palette=2n+2n*k+ceilDiv(symbols*width,8n);
    const stored=palette<n?palette:n;
    return {symbols,width,palette,stored,mode:palette<n?"palette":"raw"};
}
function archiveCost(blocks) {
    let raw=0n,stored=72n, count=0n;
    for(const {length,unique} of blocks){raw+=BigInt(length);stored+=32n+blockCost(length,unique).stored;count++;}
    return {raw,stored,blocks:count};
}
// Necessary, not sufficient: all component capacities are effective sustained
// decimal GB/s; CPU/GPU duty factors use the same resource definition as
// the measured full-load throughput. Infinity means the stage is absent.
function throughputBound({ratio,cpuRate=0,gpuRate=0,cpuDuty=.25,gpuDuty=.25,ram=Infinity,ramBytesPerOutput=2,
    input=Infinity,output=Infinity,upload=Infinity,download=Infinity,gpuShare=0,verify=Infinity}) {
    if(!(ratio>0)||![cpuDuty,gpuDuty,gpuShare].every(x=>Number.isFinite(x)&&x>=0&&x<=1)||
       !(ramBytesPerOutput>0)||![cpuRate,gpuRate,ram,input,output,upload,download,verify].every(x=>typeof x==="number"&&x>=0))
        throw RangeError("Invalid capacity model");
    const cpu=cpuDuty*cpuRate,gpu=gpuDuty*gpuRate;
    const terms={compute:cpu+gpu,ram:ram/ramBytesPerOutput,input:input*ratio,output,verify};
    if(gpuShare>0){terms.gpu=gpu/gpuShare;terms.upload=upload*ratio/gpuShare;terms.download=download/gpuShare;}
    if(gpuShare<1)terms.cpu=cpu/(1-gpuShare);
    return {upperGBps:Math.min(...Object.values(terms)),terms};
}
module.exports={ceilDiv,blockCost,archiveCost,throughputBound};
if(require.main===module){
    const c=blockCost(Number(process.argv[2]??65536),Number(process.argv[3]??2));
    console.log(JSON.stringify(c,(_,v)=>typeof v==="bigint"?v.toString():v,2));
}

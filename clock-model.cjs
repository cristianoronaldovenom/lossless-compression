"use strict";
// Decimal GB/s. f is reported MHz, not a hardware cycle counter.
function clockModel(bytes,seconds,mhz,workers=1){
    if(![bytes,seconds,mhz,workers].every(Number.isFinite)||bytes<=0||seconds<=0||mhz<=0||workers<=0)throw Error("Invalid clock model inputs");
    const gbps=bytes/seconds/1e9;
    return {gbps,bytesPerReportedCycle:1000*gbps/(mhz*workers),
        divisorMHzPerGBps:mhz*workers/gbps,
        note:"Effective frequency-normalized fit, not actual cycles or cross-CPU guarantee"};
}
function estimate({mhz,workers,divisor,memoryGBps=Infinity,trafficPerByte=1}){
    if(![mhz,workers,divisor,trafficPerByte].every(x=>Number.isFinite(x)&&x>0)||!(memoryGBps>0))throw Error("Invalid model inputs");
    return Math.min(mhz*workers/divisor,memoryGBps/trafficPerByte);
}
module.exports={clockModel,estimate};

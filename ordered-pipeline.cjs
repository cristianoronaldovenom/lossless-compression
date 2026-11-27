"use strict";
// Retain completed scratch until its verified output is delivered.
function runPipeline({start,end,batchSize,slots,submit,collect,deliver,onProgress}) {
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||
       !Number.isSafeInteger(batchSize)||batchSize<1||![1,2].includes(slots))
        throw Error("Invalid pipeline bounds");
    const pending=[], free=Array.from({length:slots+1},(_,i)=>i);
    let next=start;
    function refill(){
        while(pending.length<slots&&next<end){
            const scratch=free.shift(), first=next,last=Math.min(end,first+batchSize);
            if(scratch===undefined)throw Error("Scratch ownership violation");
            const handle=submit(first,last,scratch);
            pending.push({first,last,scratch,handle});next=last;
        }
    }
    refill();
    while(pending.length){
        const job=pending.shift(), result=collect(job.handle);
        refill();
        deliver(job.first,result);
        onProgress(job.last);
        free.push(job.scratch);
    }
}
module.exports={runPipeline};

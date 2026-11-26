"use strict";
const path=require("node:path");
const {expandBinary}=require("./binary-palette.cjs");
const CHUNK=65536;
// Trusted driver module, explicitly selected by the operator. A board vendor
// can implement this synchronous interface over a native DMA addon.
function createFpga(inverse,driverPath) {
    if(!(inverse instanceof Uint16Array)||inverse.length!==1024||
        inverse.some(v=>v>=1024)||new Set(inverse).size!==1024)
        throw Error("Invalid inverse dictionary");
    if(typeof driverPath!=="string"||!driverPath.length)throw Error("FPGA driver required");
    const driver=driverPath==="simulator"?{
        name:"FPGA protocol simulator (CPU, not hardware)",batchBlocks:32,
        decodeBatch(jobs,out){for(const j of jobs)expandBinary(j.indices,j.length,j.a,j.b,out.subarray(j.row*CHUNK,j.row*CHUNK+j.length));}
    }:require(path.resolve(driverPath)).open();
    if(!driver||typeof driver.decodeBatch!=="function"||
        !Number.isInteger(driver.batchBlocks)||driver.batchBlocks<1||driver.batchBlocks>128){
        driver?.close?.();throw Error("Invalid FPGA driver ABI");
    }
    let pending=null,closed=false;
    return {
        name:String(driver.name??"FPGA adapter"),simulated:driverPath==="simulator",
        batchBlocks:driver.batchBlocks,pipelineSlots:1,decodedBytes:0,profiledBytes:0,kernelNs:0,
        supportsWidth:w=>w===1,
        submit(payload,descriptors,count){
            if(closed||pending)throw Error("FPGA backend unavailable or busy");
            if(!(payload instanceof Uint8Array)||!(descriptors instanceof Uint32Array)||
                !Number.isInteger(count)||count<1||count>driver.batchBlocks||descriptors.length!==count*5)
                throw Error("Invalid FPGA batch");
            const jobs=[];
            let decodedBytes=0;
            for(let row=0;row<count;row++){
                const at=row*5,p=descriptors[at],offset=descriptors[at+1],k=descriptors[at+2],w=descriptors[at+3],length=descriptors[at+4];
                if(w!==1||k!==2||length<1||length>CHUNK||offset!==p+4)throw Error("Invalid FPGA descriptor");
                const symbols=Math.ceil(length*8/10),n=Math.ceil(symbols/8);
                if(offset+n>payload.length)throw Error("Truncated FPGA input");
                const id0=payload[p]|payload[p+1]<<8,id1=payload[p+2]|payload[p+3]<<8;
                if(id0>=1024||id1>=1024||id0===id1)throw Error("Invalid FPGA palette");
                const a=inverse[id0],b=inverse[id1],indices=payload.subarray(offset,offset+n);
                if((symbols&7)&&(indices[n-1]>>>(symbols&7)))throw Error("Invalid FPGA index padding");
                const last=(indices[(symbols-1)>>>3]>>>((symbols-1)&7))&1?b:a;
                if(last>>>(length*8-10*(symbols-1)))throw Error("Invalid FPGA symbol padding");
                jobs.push({row,a,b,length,indices});decodedBytes+=length;
            }
            const output=Buffer.allocUnsafeSlow((count-1)*CHUNK+jobs[count-1].length);
            // The driver must complete all DMA before returning; never retain
            // the borrowed inputs or output pointer after the call.
            const status=driver.decodeBatch(jobs,output);
            if(status!==undefined&&status!==0)throw Error("FPGA driver returned an error");
            pending={output,decodedBytes};
        },
        flush(){},
        finish(){
            if(!pending)throw Error("No FPGA batch pending");
            const result=pending;pending=null;this.decodedBytes+=result.decodedBytes;return result.output;
        },
        decode(payload,descriptors,count){this.submit(payload,descriptors,count);return this.finish();},
        discard(){pending=null;},
        close(){if(!closed){closed=true;pending=null;driver.close?.();}}
    };
}
module.exports={createFpga};

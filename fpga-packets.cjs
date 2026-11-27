"use strict";
// Wire ABI: 16 bytes, little endian; indices [0..7], control u32 [8..11],
// reserved [12..15]. Control: A[9:0], B[19:10], length[26:20], last[27].
// Each packet is a block; records are its successive beats.
function packJob(job,destination,offset=0){
    const {indices,length,a,b}=job;
    if(!(indices instanceof Uint8Array)||!Number.isInteger(length)||length<1||length>65536||
       !Number.isInteger(a)||!Number.isInteger(b)||a<0||a>1023||b<0||b>1023||a===b)
        throw Error("Invalid FPGA job");
    const symbols=Math.ceil(length*8/10),indexBytes=Math.ceil(symbols/8),records=Math.ceil(length/80),bytes=records*16;
    if(indices.length!==indexBytes||((symbols&7)&&(indices[indexBytes-1]>>>(symbols&7))))
        throw Error("Invalid FPGA indices");
    const last=(indices[(symbols-1)>>>3]>>>((symbols-1)&7))&1?b:a;
    if(last>>>(length*8-10*(symbols-1)))throw Error("Invalid FPGA symbol padding");
    if(destination===undefined){destination=new Uint8Array(bytes);offset=0;}
    if(!(destination instanceof Uint8Array)||!Number.isSafeInteger(offset)||offset<0||offset>destination.length-bytes)
        throw Error("FPGA packet destination too small");
    if(destination.buffer===indices.buffer&&destination.byteOffset+offset<indices.byteOffset+indices.length&&
       indices.byteOffset<destination.byteOffset+offset+bytes)throw Error("Overlapping FPGA packet buffers");
    const view=new DataView(destination.buffer,destination.byteOffset,destination.byteLength);
    for(let i=0;i<records;i++){
        const p=offset+i*16, n=Math.min(80,length-i*80);
        destination.fill(0,p,p+16);
        destination.set(indices.subarray(i*8,Math.min(i*8+8,indexBytes)),p);
        view.setUint32(p+8,a|(b<<10)|(n<<20)|((i===records-1?1:0)<<27),true);
    }
    return destination.subarray(offset,offset+bytes);
}
module.exports={packJob};

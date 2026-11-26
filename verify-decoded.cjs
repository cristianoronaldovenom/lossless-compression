"use strict";
// Prepare exclusively owned arrays for transfer. GPU readback has a single
// dedicated backing buffer shared by all device row views. CPU-only output
// may borrow scratch or pooled memory, so copy only those rows.
function makeVerifyJob(blocks, index, first, entryBytes, restore) {
    const device=blocks.deviceBuffer?.buffer;
    const transfer=new Set();
    const rows=blocks.map(raw=>{
        const row=device && raw.buffer===device ? raw : Uint8Array.from(raw);
        transfer.add(row.buffer); return row;
    });
    const hashes=new Uint8Array(rows.length*16);
    for(let i=0;i<rows.length;i++){
        const at=(first+i)*entryBytes+16;
        if(at+16>index.length)throw Error("Missing checksum");
        hashes.set(index.subarray(at,at+16),i*16);
    }
    transfer.add(hashes.buffer);
    return {job:{rows,hashes,first,restore},transfer:[...transfer]};
}
function verifyDecoded(job,digest){
    const {rows,hashes,first,restore}=job;
    if(!Array.isArray(rows)||!(hashes instanceof Uint8Array)||hashes.length!==rows.length*16)
        throw Error("Invalid verification job");
    for(let i=0;i<rows.length;i++){
        const raw=rows[i];
        if(!(raw instanceof Uint8Array)||raw.length<1||raw.length>65536)
            throw Error("Invalid verified row");
        const actual=digest(raw);
        for(let j=0;j<16;j++)if(actual[j]!==hashes[i*16+j])
            throw Error("Chunk checksum mismatch at block "+(first+i));
    }
    return {first,rows:restore?rows:undefined};
}
module.exports={makeVerifyJob,verifyDecoded};

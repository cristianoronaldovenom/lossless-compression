"use strict";
const oldEncode = require("./binary-encode-reference.cjs").encodeBinary;
const {encodeBinaryNative}=require("./binary-palette.cjs");
// A distinguishing bit selects the candidate index. Compare all 40 bits
// to a precomputed exact pattern to reject any third value.
function encodeBinary(raw, forward) {
    if (process.env.S10_BINARY_REFERENCE === "1" || raw.length < 16 || raw.length > 65536)
        return oldEncode(raw,forward);
    if(process.env.S10_ENABLE_NATIVE_ENCODE!=="0"){
        const native=encodeBinaryNative(raw,forward);
        if(native!==undefined)return native;
    }
    const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    const full=Math.floor(raw.length/5), count=Math.ceil(raw.length*8/10);
    const a=view.getUint16(0,true)&1023;
    const aLo=(a|a<<10|a<<20|a<<30)>>>0, aHi=a>>>2;
    let group=0,b=-1,firstMask=0;
    while(group<full) {
        const low=view.getUint32(group*5,true), high=raw[group*5+4];
        if(low===aLo&&high===aHi){group++;continue;}
        const values=[low&1023,low>>>10&1023,low>>>20&1023,(low>>>30)|(high<<2)];
        for(let j=0;j<4;j++){
            const v=values[j];
            if(v===a)continue;
            if(b===-1)b=v;
            if(v!==b)return null;
            firstMask|=1<<j;
        }
        break;
    }
    if(b===-1)return oldEncode(raw,forward);
    const delta=a^b, pick=31-Math.clz32(delta&-delta);
    const lo=new Uint32Array(16),hi=new Uint8Array(16);
    for(let m=0;m<16;m++){
        const x=m&1?delta:0,y=m&2?delta:0,z=m&4?delta:0,w=m&8?delta:0;
        lo[m]=(x|y<<10|z<<20|w<<30)>>>0;hi[m]=w>>>2;
    }
    const payload=new Uint8Array(6+Math.ceil(count/8));
    payload[6+(group>>>1)]=firstMask<<((group&1)*4);
    const shift=30+pick, s1=10+pick,s2=20+pick;
    for(let i=group+1;i<full;i++){
        const x=(view.getUint32(i*5,true)^aLo)>>>0,y=raw[i*5+4]^aHi;
        const m=((x>>>pick)&1)|(((x>>>s1)&1)<<1)|(((x>>>s2)&1)<<2)|
            (((shift<32?x>>>shift:y>>>(shift-32))&1)<<3);
        if(x!==lo[m]||y!==hi[m])return null;
        payload[6+(i>>>1)]|=m<<((i&1)*4);
    }
    const tail=raw.length-full*5;
    if(tail){
        let x=0;for(let j=0;j<tail;j++)x|=raw[full*5+j]<<(j*8);
        const n=Math.ceil(tail*8/10);
        let m=0;for(let j=0;j<n;j++){
            const v=(x>>>(j*10))&1023;
            if(v===b)m|=1<<j;else if(v!==a)return null;
        }
        payload[6+(full>>>1)]|=m<<((full&1)*4);
    }
    const sa=forward[a],sb=forward[b];
    payload.set([2,0,sa&255,sa>>>8,sb&255,sb>>>8]);
    return payload.length<raw.length?payload:null;
}
module.exports={encodeBinary};

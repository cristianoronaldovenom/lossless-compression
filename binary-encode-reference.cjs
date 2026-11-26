"use strict";
// Direct 10-bit value classification. Four symbols occupy exactly five bytes.
// Only the two discovered values need a dictionary lookup when sealing.
function encodeBinary(raw, forward) {
    if (raw.length < 16 || raw.length > 65536) return null;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const count = Math.ceil(raw.length * 8 / 10);
    let a = view.getUint16(0,true) & 1023, b = -1;
    function classify(x,y,z,w,n=4) {
        if (b >= 0 && n === 4) {
            if ((x!==a && x!==b)||(y!==a && y!==b)||(z!==a && z!==b)||(w!==a && w!==b)) return -1;
            return (x===b)|((y===b)<<1)|((z===b)<<2)|((w===b)<<3);
        }
        let mask=0;
        for(let j=0;j<n;j++) {
            const v=j===0?x:j===1?y:j===2?z:w;
            if(v===a) continue;
            if(b===-1) b=v;
            if(v!==b) return -1;
            mask|=1<<j;
        }
        return mask;
    }
    function group(at) {
        const x=view.getUint32(at,true), y=raw[at+4];
        return classify(x&1023,(x>>>10)&1023,(x>>>20)&1023,(x>>>30)|(y<<2));
    }
    // Most incompressible data fails before allocating the output.
    const first=group(0); if(first<0) return null;
    const second=group(5); if(second<0) return null;
    const payload=new Uint8Array(6+Math.ceil(count/8));
    payload[6]=first|(second<<4);
    const full=Math.floor(raw.length/5);
    for(let i=2;i<full;i++) {
        const mask=group(i*5);
        if(mask<0) return null;
        payload[6+(i>>>1)]|=mask<<((i&1)*4);
    }
    const tail=raw.length-full*5;
    if(tail) {
        let x=0;
        for(let i=0;i<tail;i++) x|=raw[full*5+i]<<(i*8);
        const mask=classify(x&1023,(x>>>10)&1023,(x>>>20)&1023,x>>>30,Math.ceil(tail*8/10));
        if(mask<0) return null;
        payload[6+(full>>>1)]|=mask<<((full&1)*4);
    }
    const sa=forward[a];
    if(b===-1) return Uint8Array.of(1,0,sa&255,sa>>>8);
    const sb=forward[b];
    payload.set([2,0,sa&255,sa>>>8,sb&255,sb>>>8]);
    return payload.length<raw.length ? payload : null;
}
module.exports={encodeBinary};

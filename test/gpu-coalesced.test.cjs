"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {expandBinaryInto}=require("../binary-palette.cjs");
const {fixture}=require("../tools/bench-gpu-resident.cjs");
// Mirrors OpenCL's phase table and contiguous-word addressing, independently
// compared with the actual CPU expansion function.
function word(a,b,k,phase){
    const skip=phase*2,v=[0,1,2,3].map(j=>k>>j&1?b:a);
    return ((v[0]>>>skip)|(v[1]<<(10-skip))|(v[2]<<(20-skip))|(v[3]<<(30-skip)))>>>0;
}
test("phase table and partial output agree with CPU expansion",()=>{
    let seed=7;const next=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
    for(const length of [...Array.from({length:257},(_,i)=>i+1),4079,4080,4081,65535,65536]){
        for(let run=0;run<4;run++){
            const count=Math.ceil(length*8/10),valid=length*8-10*(count-1);
            const a=next()&((1<<valid)-1);let b=next()&1023;if(a===b)b^=1;
            const idx=new Uint8Array(Math.ceil(count/8));for(let i=0;i<idx.length;i++)idx[i]=next()&255;
            idx[idx.length-1]&=(1<<((count-1)&7))-1;
            const expected=expandBinaryInto(idx,new Uint8Array(length),a,b);
            const table=Uint32Array.from({length:80},(_,i)=>word(a,b,i&15,i>>>4));
            const output=new Uint8Array(Math.ceil(length/4)*4),view=new DataView(output.buffer);
            for(let w=0;w<Math.ceil(length/4);w++){
                const s=Math.floor(w*32/10),q=s>>>3,key=((idx[q]|((idx[q+1]??0)<<8))>>>(s&7))&15;
                if(w<Math.ceil(length/4)-1)view.setUint32(w*4,table[(w%5)*16+key],true);
                else {
                    // Final word clears symbols outside logical output.
                    const vals=Array.from({length:4},(_,i)=>s+i<count?(key>>i&1?b:a):0),skip=w%5*2;
                    view.setUint32(w*4,(vals[0]>>>skip)|(vals[1]<<(10-skip))|(vals[2]<<(20-skip))|(vals[3]<<(30-skip)),true);
                }
            }
            assert.deepEqual(output.subarray(0,length),expected);
        }
    }
});
test("resident fixture descriptors and output",()=>{
    const {payload,jobs,expected}=fixture(8);
    assert.equal(expected.length,8*65536);
    for(let i=0;i<8;i++){
        const [p,q,k,w,n]=jobs.subarray(i*5,i*5+5);
        assert.equal(k,2);assert.equal(w,1);assert.equal(n,65536);
        assert.deepEqual(Buffer.from(expandBinaryInto(payload.subarray(q,q+6554),new Uint8Array(n),payload.readUInt16LE(p),payload.readUInt16LE(p+2))),expected.subarray(i*n,(i+1)*n));
    }
});

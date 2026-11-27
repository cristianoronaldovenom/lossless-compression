"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {expandBinaryInto,cpuCapabilities,nativeEnabled}=require("../binary-palette.cjs");
test("native CPU strategies match independent bitstream and preserve guards",{skip:!nativeEnabled},()=>{
 const prev=process.env.S10_CPU_KERNEL,cap=cpuCapabilities();let seed=71;const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
 try{
  for(const length of [...Array.from({length:161},(_,i)=>i+1),4095,4096,65535,65536]){
   const n=Math.ceil(length*8/10),valid=length*8-10*(n-1),a=rnd()&((1<<valid)-1);let b=rnd()&1023;if(a===b)b^=512;
   const input=Uint8Array.from({length:Math.ceil(n/8)},()=>rnd()&255);input[input.length-1]&=(1<<((n-1)&7))-1;
   const expected=new Uint8Array(length);let acc=0,bits=0,at=0;
   for(let i=0;i<n;i++){acc|=(input[i>>>3]>>(i&7)&1?b:a)<<bits;bits+=10;while(bits>=8&&at<length){expected[at++]=acc&255;acc>>>=8;bits-=8;}}
   assert.equal(acc,0);
   for(const kernel of ["scalar","auto",...(cap.avx2?["avx2"]:[]),...(cap.bmi2?["bmi2"]:[])]){
    process.env.S10_CPU_KERNEL=kernel;
    const guarded=new Uint8Array(length+34).fill(173),dest=guarded.subarray(17,17+length);
    assert.deepEqual(expandBinaryInto(input,dest,a,b),expected);
    assert.ok(guarded.subarray(0,17).every(x=>x===173)&&guarded.subarray(17+length).every(x=>x===173));
   }
  }
 }finally{if(prev===undefined)delete process.env.S10_CPU_KERNEL;else process.env.S10_CPU_KERNEL=prev;}
});

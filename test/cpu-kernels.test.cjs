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

test("native encoding exactness and third-symbol rejection",{skip:!nativeEnabled},()=>{
 const {encodeBinaryNative}=require("../binary-palette.cjs"),forward=Uint16Array.from({length:1024},(_,i)=>i);
 const prev=process.env.S10_CPU_KERNEL;let seed=93;const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
 try{
  for(const kernel of ["scalar","auto"]){
   process.env.S10_CPU_KERNEL=kernel;
   for(let i=0;i<200;i++){
    const length=20+5*(rnd()%500),count=length*8/10,a=rnd()&1023;let b=rnd()&1023;if(a===b)b^=1;
    const bits=Uint8Array.from({length:Math.ceil(count/8)},()=>rnd()&255);
    if(count&7)bits[bits.length-1]&=(1<<(count&7))-1;
    bits[0]&=254;bits[0]|=2;
    const raw=expandBinaryInto(bits,new Uint8Array(length),a,b);
    const encoded=encodeBinaryNative(raw,forward);
    assert.equal(encoded[0],2);assert.equal(encoded[2]|encoded[3]<<8,a);assert.equal(encoded[4]|encoded[5]<<8,b);
    assert.deepEqual(encoded.subarray(6),bits);
    const bad=raw.slice();let third=(a+1)&1023;while(third===a||third===b)third=(third+1)&1023;
    bad[0]=third&255;bad[1]=(bad[1]&252)|(third>>8);
    // Preserve both original values after changing first symbol.
    bad[2]=(bad[2]&15)|((a&15)<<4); // replace a full symbol at bit 20 instead
    bad[3]=(bad[3]&192)|(a>>4);
    // bit 10 is b (forced above), bit 20 is a, bit 0 is third.
    assert.equal(encodeBinaryNative(bad,forward),null);
   }
  }
 }finally{if(prev===undefined)delete process.env.S10_CPU_KERNEL;else process.env.S10_CPU_KERNEL=prev;}
});

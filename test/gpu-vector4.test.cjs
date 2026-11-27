"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {expandBinaryInto}=require("../binary-palette.cjs");
test("vector4 exact expansion across phases, group boundaries and tails",()=>{
 let seed=145;const next=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
 for(let p=0;p<5;p++)for(let j=0;j<4;j++)assert.equal(Math.floor((p*2+j*32)/10),Math.floor((p+j)*32/10)-Math.floor(p*32/10));
 for(const length of [...Array.from({length:260},(_,i)=>i+1),4079,4080,4081,65535,65536]){
  const count=Math.ceil(length*8/10),valid=length*8-10*(count-1),a=next()&((1<<valid)-1);
  let b=next()&1023;if(a===b)b^=1;
  const idx=new Uint8Array(Math.ceil(count/8));for(let i=0;i<idx.length;i++)idx[i]=next()&255;
  idx[idx.length-1]&=(1<<((count-1)&7))-1;
  const expected=expandBinaryInto(idx,new Uint8Array(length),a,b);
  const word=(k,p)=>{const v=Array.from({length:4},(_,j)=>k>>j&1?b:a),s=p*2;return ((v[0]>>>s)|(v[1]<<(10-s))|(v[2]<<(20-s))|(v[3]<<(30-s)))>>>0;};
  const table=Uint32Array.from({length:80},(_,i)=>word(i&15,i>>>4));
  const words=Math.ceil(length/4),output=new Uint8Array(words*4),view=new DataView(output.buffer);
  for(let first=0;first<words;first+=1020){
   const limit=Math.min(first+1020,words),fullLimit=Math.floor(Math.min(limit,words-1)/4)*4;
   for(let w=first;w<fullLimit;w+=4){
    const s=Math.floor(w*32/10),p=w%5,q=s>>>3;
    const packed=((idx[q]??0)|((idx[q+1]??0)<<8)|((idx[q+2]??0)<<16)|((idx[q+3]??0)<<24))>>>(s&7);
    for(let j=0;j<4;j++)view.setUint32((w+j)*4,table[((p+j)%5)*16+((packed>>>Math.floor((p*2+j*32)/10))&15)],true);
   }
   for(let w=Math.max(first,fullLimit);w<limit;w++){
    const s=Math.floor(w*32/10),q=s>>>3,key=((idx[q]|((idx[q+1]??0)<<8))>>>(s&7))&15;
    const v=Array.from({length:4},(_,i)=>s+i<count?(key>>i&1?b:a):0),skip=w%5*2;
    view.setUint32(w*4,(v[0]>>>skip)|(v[1]<<(10-skip))|(v[2]<<(20-skip))|(v[3]<<(30-skip)),true);
   }
  }
  assert.deepEqual(output.subarray(0,length),expected);
 }
});
"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),c=require("../memory-page.cjs");
function suite(){
 let seed=0x4829;const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
 function fixture(mode){
  const a=new Uint8Array(64),v=new DataView(a.buffer);
  if(mode===1){const x=rand()||1;for(let i=0;i<16;i++)v.setUint32(i*4,x,true);}
  if(mode===2){const b=rand();v.setUint32(0,b,true);for(let i=1;i<16;i++)v.setUint32(i*4,(b+(rand()%256)-128)>>>0,true);}
  if(mode===3){let b=rand()&1023;const x=rand()&3;if(b===x)b^=16;let bits=0,n=0,at=0;for(let i=0;i<52;i++){bits|=(i===51||rand()&1?x:b)<<n;n+=10;while(n>=8){a[at++]=bits&255;bits>>>=8;n-=8;}}}
  if(mode===4){for(let i=0;i<3;i++)v.setUint32((rand()%16)*4,rand()||1,true);}
  if(mode===5)for(let i=0;i<64;i++)a[i]=rand()&255;
  return a;
 }
 const modes=new Set();let lines=0,pages=0;
 for(let i=0;i<1200;i++){const a=fixture(i%6),e=c.lineEncode(a);modes.add(e.mode);assert.deepEqual(c.lineDecode(e.mode,e.bytes),a);lines++;}
 assert.equal(modes.size,6);
 const ratios={};
 for(let i=0;i<150;i++){
  const a=new Uint8Array(4096);for(let j=0;j<64;j++)a.set(fixture(i<6?i:rand()%6),j*64);
  const e=c.encodePage(a);assert.ok(e.bytes.length<=4096);assert.deepEqual(c.decodePage(e),a);pages++;
  for(let j=0;j<64;j++){assert.deepEqual(c.decodeLine(e,j),a.subarray(j*64,(j+1)*64));lines++;}
  if(i<6)ratios[i]={kind:e.kind,payload:e.bytes.length};
 }
 const a=new Uint8Array(4096);a.set(fixture(1));const e=c.encodePage(a);
 const bad={kind:e.kind,bytes:e.bytes.slice()};bad.bytes[0]=0;assert.throws(()=>c.decodePage(bad));
 assert.throws(()=>c.decodeLine(e,64));assert.throws(()=>c.lineDecode(c.BINARY10,new Uint8Array(10)));
 return {lines,pages,modes:[...modes],ratios};
}
test("all six modes, page round trips and random line access",suite);
module.exports={suite};

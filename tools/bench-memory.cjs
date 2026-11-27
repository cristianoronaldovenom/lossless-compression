"use strict";
const c=require("../memory-page.cjs"),{performance}=require("node:perf_hooks"),assert=require("node:assert/strict");
const count=Number(process.argv[2]??4096);if(!Number.isInteger(count)||count<1||count>65536)throw Error("Page count must be 1..65536");
let seed=73;function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
for(const name of ["zero","delta32","sparse","random","mixed"]){
 const pages=Array.from({length:count},(_,i)=>{const a=new Uint8Array(4096),v=new DataView(a.buffer),kind=name==="mixed"?["zero","delta32","sparse","random"][i%4]:name;
 if(kind==="delta32")for(let j=0;j<64;j++){const b=rand();for(let k=0;k<16;k++)v.setUint32(j*64+k*4,(b+k)>>>0,true);}
 if(kind==="sparse")for(let j=0;j<64;j++)v.setUint32(j*64,rand(),true);
 if(kind==="random")for(let j=0;j<4096;j++)a[j]=rand()&255;return a;});
 const t=performance.now(),encoded=pages.map(c.encodePage),enc=performance.now()-t;
 const dst=new Uint8Array(4096);const d=performance.now();for(const e of encoded)c.decodePage(e,dst);const dec=performance.now()-d;
 for(let i=0;i<count;i++)assert.deepEqual(c.decodePage(encoded[i]),pages[i]);
 const line=new Uint8Array(64);let guard=0;const n=count*64,l=performance.now();
 for(let i=0;i<n;i++){c.decodeLine(encoded[i%count],rand()&63,line);guard^=line[0];}const lineMs=performance.now()-l;
 const payload=encoded.reduce((s,e)=>s+e.bytes.length,0),metadataAllowance=8*count;
 console.log(JSON.stringify({fixture:name,pages:count,encodeGBps:count*4096/enc/1e6,decodeGBps:count*4096/dec/1e6,averageSoftwareLineNs:lineMs*1e6/n,ratioIncluding8ByteMetadata:count*4096/(payload+metadataAllowance),guard,note:"Synthetic JS benchmark; no hardware, checksum, allocator or OS overhead"}));
}

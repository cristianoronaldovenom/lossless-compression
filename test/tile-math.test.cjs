"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
function tile(a,b,q){
    const lo=[],hi=[];
    for(let k=0;k<16;k++){
        const v=Array.from({length:4},(_,j)=>k>>j&1?b:a);
        lo[k]=(v[0]|v[1]<<10|v[2]<<20|v[3]<<30)>>>0;hi[k]=v[3]>>>2;
    }
    const [k0,k1,k2,k3]=[q&15,q>>>4&15,q>>>8&15,q>>>12];
    const [l0,l1,l2,l3]=[lo[k0],lo[k1],lo[k2],lo[k3]], [h0,h1,h2,h3]=[hi[k0],hi[k1],hi[k2],hi[k3]];
    const words=[l0,h0|l1<<8,l1>>>24|h1<<8|l2<<16,l2>>>16|h2<<16|l3<<24,l3>>>8|h3<<24];
    const out=Buffer.alloc(20);words.forEach((v,i)=>out.writeUInt32LE(v>>>0,4*i));return out;
}
function reference(a,b,q){
    let x=0n;for(let i=0;i<16;i++)x|=BigInt(q>>i&1?b:a)<<BigInt(i*10);
    return Buffer.from(Array.from({length:20},(_,i)=>Number(x>>BigInt(i*8)&255n)));
}
test("all 16-bit index patterns for three palettes",()=>{
    for(const [a,b] of [[0,1023],[123,711],[1023,0]])
        for(let q=0;q<65536;q++)assert.deepEqual(tile(a,b,q),reference(a,b,q));
});

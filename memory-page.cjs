"use strict";
// Experimental 4 KiB page format. Not the archive format and not a RAM driver.
// Incompressible pages are stored verbatim. Page kind and integrity metadata
// are external; all byte counts must include them when sizing a memory pool.
const PAGE=4096,LINE=64,DIR=128;
const RAW=0,ZERO=1,REPEAT32=2,DELTA32=3,BINARY10=4,SPARSE32=5;
const PAGE_RAW=0,PAGE_ZERO=1,PAGE_PACKED=2;
function check(a,n){if(!(a instanceof Uint8Array)||a.length!==n)throw Error("Invalid buffer length");}
function view(a){return new DataView(a.buffer,a.byteOffset,a.byteLength);}
function lineEncode(raw){
 check(raw,LINE);const v=view(raw),base=v.getUint32(0,true);
 let zero=true,repeat=true,delta=true,mask=0,nonzero=0;
 for(let i=0;i<16;i++){
  const x=v.getUint32(i*4,true),d=(x-base)|0;
  if(x){zero=false;mask|=1<<i;nonzero++;}
  if(x!==base)repeat=false;
  if(d< -128||d>127)delta=false;
 }
 if(zero)return {mode:ZERO,bytes:new Uint8Array(0)};
 if(repeat)return {mode:REPEAT32,bytes:raw.slice(0,4)};
 let mode=RAW,bytes=raw;
 // Each mode competes on exact encoded size; no dictionary scan.
 if(delta){bytes=new Uint8Array(20);bytes.set(raw.subarray(0,4));for(let i=0;i<16;i++)bytes[4+i]=(v.getUint32(i*4,true)-base)&255;mode=DELTA32;}
 if(2+4*nonzero<bytes.length){
  const s=new Uint8Array(2+4*nonzero),sv=view(s);sv.setUint16(0,mask,true);
  let at=2;for(let i=0;i<16;i++)if(mask&(1<<i)){sv.setUint32(at,v.getUint32(i*4,true),true);at+=4;}
  mode=SPARSE32;bytes=s;
 }
 // 52 ten-bit symbols (last has only 2 significant bits). Store the two
 // actual values, not permuted IDs: the RAM path needs no global dictionary.
 if(bytes.length>11){
  const idx=new Uint8Array(11),iv=view(idx);let bits=0,avail=0,cursor=0,a=-1,b=-1,ok=true;
  for(let i=0;i<52;i++){
   while(avail<10&&cursor<64){bits|=raw[cursor++]<<avail;avail+=8;}
   const x=bits&1023;bits>>>=10;avail-=10;
   if(a<0)a=x;
   if(x!==a){if(b<0)b=x;if(x!==b){ok=false;break;}idx[4+(i>>>3)]|=1<<(i&7);}
  }
  if(ok){iv.setUint16(0,a,true);iv.setUint16(2,b<0?a:b,true);mode=BINARY10;bytes=idx;}
 }
 return {mode,bytes};
}
function lineDecode(mode,bytes,dst=new Uint8Array(LINE)){
 check(dst,LINE);if(!(bytes instanceof Uint8Array))throw Error("Invalid payload");
 const d=view(dst),v=view(bytes);
 switch(mode){
 case RAW:check(bytes,64);dst.set(bytes);break;
 case ZERO:check(bytes,0);dst.fill(0);break;
 case REPEAT32:check(bytes,4);for(let i=0;i<16;i++)d.setUint32(i*4,v.getUint32(0,true),true);break;
 case DELTA32:
  check(bytes,20);if(bytes[4]!==0)throw Error("Noncanonical base delta");
  for(let i=0;i<16;i++)d.setUint32(i*4,(v.getUint32(0,true)+(bytes[4+i]<<24>>24))>>>0,true);break;
 case SPARSE32:{
  if(bytes.length<2)throw Error("Truncated sparse line");const mask=v.getUint16(0,true);let at=2;
  for(let i=0;i<16;i++){let x=0;if(mask&(1<<i)){if(at+4>bytes.length)throw Error("Truncated sparse word");x=v.getUint32(at,true);if(!x)throw Error("Noncanonical sparse word");at+=4;}d.setUint32(i*4,x,true);}
  if(at!==bytes.length)throw Error("Extra sparse bytes");break;}
 case BINARY10:{
  check(bytes,11);const a=v.getUint16(0,true),b=v.getUint16(2,true);
  if(a>1023||b>1023||(bytes[10]&240))throw Error("Invalid binary palette");
  let bits=0,avail=0,at=0;
  for(let i=0;i<52;i++){
   const x=bytes[4+(i>>>3)]&(1<<(i&7))?b:a;
   if(i===51&&x>3)throw Error("Invalid final symbol");
   bits|=x<<avail;avail+=10;while(avail>=8&&at<64){dst[at++]=bits&255;bits>>>=8;avail-=8;}
  }
  if(at!==64||bits)throw Error("Invalid binary tail");break;}
 default:throw Error("Unknown line mode");
 }
 return dst;
}
function encodePage(raw){
 check(raw,PAGE);const parts=[];let total=DIR,allZero=true;
 for(let i=0;i<64;i++){const x=lineEncode(raw.subarray(i*64,(i+1)*64));parts.push(x);total+=x.bytes.length;if(x.mode!==ZERO)allZero=false;}
 if(allZero)return {kind:PAGE_ZERO,bytes:new Uint8Array(0)};
 if(total>=PAGE)return {kind:PAGE_RAW,bytes:Uint8Array.from(raw)};
 const bytes=new Uint8Array(total),v=view(bytes);let at=DIR;
 for(let i=0;i<64;i++){const p=parts[i];v.setUint16(i*2,(p.mode<<13)|at,true);bytes.set(p.bytes,at);at+=p.bytes.length;}
 return {kind:PAGE_PACKED,bytes};
}
function pageCheck(page){
 if(!(page?.bytes instanceof Uint8Array))throw Error("Invalid page");
 if(page.kind===PAGE_RAW){check(page.bytes,PAGE);return;}
 if(page.kind===PAGE_ZERO){check(page.bytes,0);return;}
 if(page.kind!==PAGE_PACKED||page.bytes.length<DIR||page.bytes.length>=PAGE)throw Error("Invalid packed page");
 if((view(page.bytes).getUint16(0,true)&8191)!==DIR)throw Error("Invalid initial offset");
}
function decodeLine(page,index,dst=new Uint8Array(LINE)){
 pageCheck(page);check(dst,LINE);if(!Number.isInteger(index)||index<0||index>=64)throw Error("Invalid line number");
 if(page.kind===PAGE_RAW){dst.set(page.bytes.subarray(index*64,(index+1)*64));return dst;}
 if(page.kind===PAGE_ZERO){dst.fill(0);return dst;}
 const v=view(page.bytes),entry=v.getUint16(index*2,true),start=entry&8191;
 const end=index===63?page.bytes.length:v.getUint16((index+1)*2,true)&8191;
 if(start<DIR||end<start||end>page.bytes.length||end-start>LINE)throw Error("Invalid directory range");
 return lineDecode(entry>>>13,page.bytes.subarray(start,end),dst);
}
function decodePage(page,dst=new Uint8Array(PAGE)){
 pageCheck(page);check(dst,PAGE);
 if(dst.buffer===page.bytes.buffer&&dst.byteOffset<page.bytes.byteOffset+page.bytes.byteLength&&page.bytes.byteOffset<dst.byteOffset+PAGE)throw Error("Overlapping page buffer");
 if(page.kind===PAGE_RAW){dst.set(page.bytes);return dst;}
 if(page.kind===PAGE_ZERO){dst.fill(0);return dst;}
 for(let i=0;i<64;i++)decodeLine(page,i,dst.subarray(i*64,(i+1)*64));
 return dst;
}
module.exports={PAGE,LINE,DIR,RAW,ZERO,REPEAT32,DELTA32,BINARY10,SPARSE32,PAGE_RAW,PAGE_ZERO,PAGE_PACKED,lineEncode,lineDecode,encodePage,decodePage,decodeLine};

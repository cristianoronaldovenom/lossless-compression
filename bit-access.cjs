"use strict";
// All bit offsets are LSB-first, exactly as in the archive. Never round a
// request to a symbol boundary or return padded bits to an application.
function bitWindow(offset,width,totalBytes){
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(width)||width<1||width>32||
    !Number.isSafeInteger(totalBytes)||totalBytes<0||totalBytes>Math.floor(Number.MAX_SAFE_INTEGER/8)||
    offset>totalBytes*8-width)throw RangeError("Invalid bit range");
 const firstByte=Math.floor(offset/8),shift=offset%8;
 return {firstByte,shift,bytes:Math.ceil((shift+width)/8),firstSymbol:Math.floor(offset/10),
  symbols:Math.ceil((offset%10+width)/10)};
}
function extractBits(bytes,shift,width){
 if(!(bytes instanceof Uint8Array)||!Number.isInteger(shift)||shift<0||shift>7||
    !Number.isInteger(width)||width<1||width>32||bytes.length<Math.ceil((shift+width)/8))throw RangeError("Invalid bit window");
 // A 32-bit value starting at bit 7 needs 39 bits; Number is exact here.
 let word=0;for(let i=0;i<Math.ceil((shift+width)/8);i++)word+=bytes[i]*2**(8*i);
 return Math.floor(word/2**shift)%2**width;
}
module.exports={bitWindow,extractBits};

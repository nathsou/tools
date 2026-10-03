/** Fixture generator only: RFC 5297, using Node/OpenSSL AES primitives independently of the app's AES-SIV library. */
import { createCipheriv } from 'node:crypto';
const xor=(a:Buffer,b:Buffer)=>Buffer.from(a.map((v,i)=>v^b[i]));
function dbl(block:Buffer):Buffer {
  const out=Buffer.alloc(16);let carry=0;
  for(let i=15;i>=0;i--){out[i]=((block[i]<<1)|carry)&255;carry=block[i]>>>7;}
  if(carry)out[15]^=0x87;return out;
}
function aes(key:Buffer,block:Buffer):Buffer {
  const c=createCipheriv(`aes-${key.length*8}-ecb`,key,null);c.setAutoPadding(false);return Buffer.concat([c.update(block),c.final()]);
}
function cmac(key:Buffer,data:Buffer):Buffer {
  const k1=dbl(aes(key,Buffer.alloc(16))),k2=dbl(k1);
  const count=Math.max(1,Math.ceil(data.length/16));let previous=Buffer.alloc(16);
  for(let i=0;i<count-1;i++)previous=aes(key,xor(previous,data.subarray(i*16,i*16+16)));
  const last=Buffer.alloc(16),remaining=data.subarray((count-1)*16);remaining.copy(last);
  if(data.length && data.length%16===0) return aes(key,xor(previous,xor(last,k1)));
  last[remaining.length]=0x80;return aes(key,xor(previous,xor(last,k2)));
}
export function referenceSiv(key:Buffer,plain:Buffer,...associated:Buffer[]):Buffer {
  const k1=key.subarray(0,key.length/2),k2=key.subarray(key.length/2);
  let d=cmac(k1,Buffer.alloc(16));
  for(const ad of associated)d=xor(dbl(d),cmac(k1,ad));
  let t:Buffer;
  if(plain.length>=16){t=Buffer.from(plain);const tail=xor(t.subarray(-16),d);tail.copy(t,t.length-16);}
  else{const padded=Buffer.alloc(16);plain.copy(padded);padded[plain.length]=0x80;t=xor(dbl(d),padded);}
  const v=cmac(k1,t),q=Buffer.from(v);q[8]&=127;q[12]&=127;
  const c=createCipheriv(`aes-${k2.length*8}-ctr`,k2,q);return Buffer.concat([v,c.update(plain),c.final()]);
}

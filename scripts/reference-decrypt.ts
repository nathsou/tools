/** Test oracle: decrypt the writer's output with independent Node/OpenSSL primitives. */
import { createDecipheriv,createHmac,timingSafeEqual } from 'node:crypto';
import type { Scheme } from './generate-fixtures.ts';
function decrypt(bytes:Buffer,key:Buffer,nonce:Buffer,scheme:Scheme,aad?:Buffer):Buffer {
  const cipher=createDecipheriv(scheme==='SIV_GCM'?'aes-256-gcm':'aes-256-ctr',key,nonce);
  if(scheme==='SIV_GCM') {
    if(aad)(cipher as any).setAAD(aad);
    (cipher as any).setAuthTag(bytes.subarray(-16));bytes=bytes.subarray(0,-16);
  }
  return Buffer.concat([cipher.update(bytes),cipher.final()]);
}
function verify(data:Buffer,tag:Buffer,key:Buffer) {
  if(!timingSafeEqual(createHmac('sha256',key).update(data).digest(),tag))throw new Error('Reference MAC mismatch');
}
export function decryptReference(bytes:Buffer,raw:Buffer,scheme:Scheme):Buffer {
  const enc=raw.subarray(0,32),mac=raw.subarray(32),nonceSize=scheme==='SIV_GCM'?12:16,headerSize=scheme==='SIV_GCM'?68:88;
  const header=bytes.subarray(0,headerSize),nonce=header.subarray(0,nonceSize);
  if(scheme==='SIV_CTRMAC')verify(header.subarray(0,56),header.subarray(56),mac);
  const payload=decrypt(header.subarray(nonceSize,scheme==='SIV_GCM'?68:56),enc,nonce,scheme);
  if(!payload.subarray(0,8).equals(Buffer.alloc(8,255)))throw new Error('Invalid reserved header bytes');
  const fileKey=payload.subarray(8),chunks:Buffer[]=[];let index=0;
  const stride=32768+(scheme==='SIV_GCM'?28:48);
  for(let offset=headerSize;offset<bytes.length;offset+=stride,index++) {
    const chunk=bytes.subarray(offset,offset+stride),number=Buffer.alloc(8);number.writeBigUInt64BE(BigInt(index));
    if(scheme==='SIV_CTRMAC')verify(Buffer.concat([nonce,number,chunk.subarray(0,-32)]),chunk.subarray(-32),mac);
    chunks.push(decrypt(chunk.subarray(nonceSize,scheme==='SIV_GCM'?chunk.length:chunk.length-32),fileKey,chunk.subarray(0,nonceSize),scheme,Buffer.concat([number,nonce])));
  }
  return Buffer.concat(chunks);
}

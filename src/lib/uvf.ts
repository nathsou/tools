import {aessiv} from '@noble/ciphers/aes.js';
import {base32,concat,fromBase64,random,text,toBase64Url,utf8,type Bytes} from './bytes';
import {validateName,type FileHeader,type VaultBootstrap} from './crypto';

// UVF v1, encryption-alliance/unified-vault-format @ ed54be8.
export const UVF_CHUNK=32740;
const PASSWORD_ALG='PBES2-HS512+A256KW';
const PASSWORD_ITERATIONS=600000;
interface Recipient {header:Record<string,unknown>;encrypted_key:string;}
export interface UvfMetadata {protected:string;iv:string;ciphertext:string;tag:string;recipients:Recipient[];aad?:string;}
interface Payload {fileFormat:string;nameFormat:string;kdf:string;kdfSalt:string;seeds:Record<string,string>;initialSeed:string;latestSeed:string;[key:string]:unknown;}
interface SeedKeys {siv:Bytes;hmac:CryptoKey;header:CryptoKey;}
export interface UvfDirectory {id:Bytes;seedId:string;}
export interface UvfMaterial {combo:'UVF';raw:Bytes;payload:Payload;keys:Map<string,SeedKeys>;directories:Map<string,UvfDirectory>;cacheSecret:Bytes;}
export interface UvfHeader extends FileHeader {seedId:string;}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
export function uvfBase64(value:unknown,length?:number):Bytes {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]*$/.test(value))throw new Error('Invalid UVF base64url field.');
  const bytes=fromBase64(value);
  if(toBase64Url(bytes)!==value||(length!==undefined&&bytes.length!==length))throw new Error('Invalid UVF field length or encoding.');
  return bytes;
}
function json(bytes:Bytes):Record<string,unknown>{const value:unknown=JSON.parse(text(bytes));if(!object(value))throw new Error('Invalid UVF JSON object.');return value;}
export function parseUvf(input:string):UvfMetadata {
  if(input.length>1024*1024)throw new Error('UVF metadata is too large.');
  let value:Record<string,unknown>;
  try{value=json(utf8(input));}catch{throw new Error('Invalid vault.uvf metadata.');}
  const header=json(uvfBase64(value.protected));
  if(header.enc!=='A256GCM'||!['json','application/json'].includes(String(header.cty))||header['uvf.spec.version']!==1)throw new Error('Unsupported UVF version or metadata encryption.');
  if(!Array.isArray(header.crit)||header.crit.length!==1||header.crit[0]!=='uvf.spec.version')throw new Error('Unsupported UVF critical header.');
  const shared=value.unprotected;
  if(shared!==undefined&&!object(shared))throw new Error('Invalid UVF unprotected header.');
  if('zip' in header||'alg' in header||'kid' in header)throw new Error('Invalid UVF protected header.');
  if(object(shared)&&Object.keys(shared).some(k=>k in header||['zip','alg','kid','crit','enc','uvf.spec.version'].includes(k)))throw new Error('Invalid UVF shared header.');
  if(!Array.isArray(value.recipients)||!value.recipients.length||value.recipients.length>64||'encrypted_key' in value||'header' in value)throw new Error('UVF requires a bounded recipients array.');
  for(const recipient of value.recipients){
    if(!object(recipient)||!object(recipient.header)||typeof recipient.header.alg!=='string'||typeof recipient.header.kid!=='string'||!/^\w+[.][\w.-]+/.test(recipient.header.kid))throw new Error('Invalid UVF recipient.');
    if(Object.keys(recipient.header).some(k=>k in header||(object(shared)&&k in shared)||['zip','crit','enc','uvf.spec.version'].includes(k)))throw new Error('Conflicting UVF recipient headers.');
    uvfBase64(recipient.encrypted_key);
    if(recipient.header.alg===PASSWORD_ALG){
      uvfBase64(recipient.encrypted_key,40);
      const salt=uvfBase64(recipient.header.p2s),count=recipient.header.p2c;
      if(salt.length<8||salt.length>64||!Number.isSafeInteger(count)||(count as number)<1||(count as number)>2000000)throw new Error('Unsupported UVF password derivation parameters.');
    }
  }
  // Bound total work when several password recipients are tried.
  const cost=value.recipients.reduce((sum:number,r:any)=>sum+(r.header.alg===PASSWORD_ALG?r.header.p2c:0),0);
  if(cost>4000000)throw new Error('UVF password derivation requires too much work.');
  uvfBase64(value.iv,12);uvfBase64(value.tag,16);uvfBase64(value.ciphertext);
  if(value.aad!==undefined)uvfBase64(value.aad);
  return value as unknown as UvfMetadata;
}
async function passwordKey(password:string,header:Record<string,unknown>,usage:KeyUsage):Promise<CryptoKey>{
  // PBES2 uses the UTF-8 password verbatim; Cryptomator's NFC rule is separate.
  const bytes=utf8(password);
  try{const key=await crypto.subtle.importKey('raw',bytes,'PBKDF2',false,['deriveKey']);
    return await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-512',salt:concat(utf8(PASSWORD_ALG),new Uint8Array(1),uvfBase64(header.p2s)),iterations:header.p2c as number},key,{name:'AES-KW',length:256},false,[usage]);
  }finally{bytes.fill(0);}
}
export async function unlockUvf(meta:UvfMetadata,password:string,progress?:(p:number)=>void):Promise<UvfMaterial>{
  const recipients=meta.recipients.filter(r=>r.header.alg===PASSWORD_ALG);
  if(!recipients.length)throw new Error('This UVF vault has no supported password recipient. Hub and externally supplied keys are not supported.');
  progress?.(0);
  for(let index=0;index<recipients.length;index++){
    const r=recipients[index];let raw:Bytes|undefined;
    try{
      const kek=await passwordKey(password,r.header,'unwrapKey');
      const cek=await crypto.subtle.unwrapKey('raw',uvfBase64(r.encrypted_key),kek,'AES-KW','AES-GCM',true,['decrypt']);
      raw=new Uint8Array(await crypto.subtle.exportKey('raw',cek));
    }catch(e){if(!(e instanceof DOMException&&['OperationError','DataError'].includes(e.name)))throw e;}
    if(raw){try{const material=await openUvf(meta,raw);progress?.(1);return material;}finally{raw.fill(0);}}
    progress?.((index+1)/recipients.length);
  }
  throw new Error('Incorrect password, or the UVF recipient is damaged.');
}
export async function uvfKdf(seed:Bytes,salt:Bytes,context:string,length:number):Promise<Bytes>{
  const key=await crypto.subtle.importKey('raw',seed,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-512',salt,info:utf8(context)},key,length*8));
}
export async function openUvf(meta:UvfMetadata,raw:Bytes):Promise<UvfMaterial>{
  if(raw.length!==32)throw new Error('Invalid UVF metadata key.');
  const cek=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
  let clear:Bytes;
  try{clear=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:uvfBase64(meta.iv),additionalData:utf8(meta.protected+(meta.aad===undefined?'':'.'+meta.aad))},cek,concat(uvfBase64(meta.ciphertext),uvfBase64(meta.tag))));}
  catch{throw new Error('UVF metadata authentication failed.');}
  let payload:Payload;
  try{payload=json(clear) as unknown as Payload;}finally{clear.fill(0);}
  if(payload.fileFormat!=='AES-256-GCM-32k'||payload.nameFormat!=='AES-SIV-512-B64URL'||payload.kdf!=='HKDF-SHA512')throw new Error('Unsupported UVF file, name or key derivation format.');
  const salt=uvfBase64(payload.kdfSalt,32);
  if(!object(payload.seeds)||Object.keys(payload.seeds).length<1||Object.keys(payload.seeds).length>1024)throw new Error('Invalid UVF seed map.');
  uvfBase64(payload.initialSeed,4);uvfBase64(payload.latestSeed,4);
  if(!Object.hasOwn(payload.seeds,payload.initialSeed)||!Object.hasOwn(payload.seeds,payload.latestSeed))throw new Error('Missing UVF initial or latest seed.');
  const material:UvfMaterial={combo:'UVF',raw:raw.slice(),payload,keys:new Map(),directories:new Map(),cacheSecret:new Uint8Array()};
  try{
    for(const [id,value] of Object.entries(payload.seeds)){
      uvfBase64(id,4);const seed=uvfBase64(value,32);
      let siv:Bytes|undefined,hmac:Bytes|undefined,header:Bytes|undefined;
      try{
        siv=await uvfKdf(seed,salt,'siv',64);hmac=await uvfKdf(seed,salt,'hmac',64);header=await uvfKdf(seed,salt,'fileHeader',32);
        material.keys.set(id,{siv,hmac:await crypto.subtle.importKey('raw',hmac,{name:'HMAC',hash:'SHA-256'},false,['sign']),header:await crypto.subtle.importKey('raw',header,'AES-GCM',false,['encrypt','decrypt'])});siv=undefined;
        if(id===payload.initialSeed)material.directories.set('',{id:await uvfKdf(seed,salt,'rootDirId',32),seedId:id});
        if(id===payload.latestSeed)material.cacheSecret=await uvfKdf(seed,salt,'app.crypte.private-cache.v1',32);
      }finally{seed.fill(0);hmac?.fill(0);header?.fill(0);siv?.fill(0);}
    }
    return material;
  }catch(e){destroyUvf(material);throw e;}
}
export function destroyUvf(m:UvfMaterial){m.raw.fill(0);m.cacheSecret.fill(0);for(const key of m.keys.values())key.siv.fill(0);for(const dir of m.directories.values())dir.id.fill(0);m.keys.clear();m.directories.clear();m.payload.seeds={};}
export function uvfDirectory(m:UvfMaterial,id:string):UvfDirectory {const dir=m.directories.get(id);if(!dir)throw new Error('Unknown vault folder.');return dir;}
export async function uvfDirectoryPath(dir:UvfDirectory,m:UvfMaterial):Promise<string>{
  const keys=m.keys.get(dir.seedId);if(!keys)throw new Error('Unknown UVF directory seed.');
  const hash=base32(new Uint8Array(await crypto.subtle.sign('HMAC',keys.hmac,dir.id)).subarray(0,20));return `d/${hash.slice(0,2)}/${hash.slice(2)}`;
}
export function uvfName(name:string,parent:string,m:UvfMaterial,open=false):string{
  const dir=uvfDirectory(m,parent),key=m.keys.get(dir.seedId)!.siv;
  if(open){const clear=text(aessiv(key,dir.id).decrypt(uvfBase64(name)));if(validateName(clear)!==clear)throw new Error('Invalid UVF filename normalization.');return clear;}
  const encrypted=toBase64Url(aessiv(key,dir.id).encrypt(utf8(validateName(name))))+'.uvf';
  if(encrypted.length>255)throw new Error('UVF filenames must fit within 172 UTF-8 bytes. Shorten this name before copying.');
  return encrypted;
}
function indexBytes(index:number):Bytes {if(!Number.isSafeInteger(index)||index<0||index>=2**32)throw new Error('UVF chunk index exceeds its nonce budget.');const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,index);return b;}
export async function uvfEncryptHeader(m:UvfMaterial,seedId=m.payload.latestSeed):Promise<{bytes:Bytes;header:UvfHeader}>{
  const general=concat(utf8('uvf'),new Uint8Array([1]),uvfBase64(seedId,4)),nonce=random(12),raw=random(32);
  try{const bytes=concat(general,nonce,new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:general},m.keys.get(seedId)!.header,raw)));
    return {bytes,header:{nonce,seedId,key:await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt'])}};
  }finally{raw.fill(0);}
}
export async function uvfDecryptHeader(bytes:Bytes,m:UvfMaterial):Promise<UvfHeader>{
  if(bytes.length!==68||text(bytes.subarray(0,3))!=='uvf'||bytes[3]!==1)throw new Error('Invalid UVF file header.');
  const seedId=toBase64Url(bytes.subarray(4,8)),keys=m.keys.get(seedId);if(!keys)throw new Error('Unknown UVF file seed.');
  const nonce=bytes.slice(8,20);let raw:Bytes;
  try{raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:bytes.subarray(0,8)},keys.header,bytes.subarray(20)));}
  catch{throw new Error('UVF file header authentication failed.');}
  try{return {nonce,seedId,key:await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt'])};}finally{raw.fill(0);}
}
export async function uvfEncryptChunk(bytes:Bytes,index:number,h:FileHeader):Promise<Bytes>{
  if(bytes.length>UVF_CHUNK)throw new Error('Invalid UVF plaintext chunk.');
  const nonce=random(12);return concat(nonce,new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:concat(indexBytes(index),h.nonce)},h.key,bytes)));
}
export async function uvfDecryptChunk(bytes:Bytes,index:number,h:FileHeader):Promise<Bytes>{
  if(bytes.length<28||bytes.length>32768)throw new Error('Truncated UVF chunk.');
  try{return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12),additionalData:concat(indexBytes(index),h.nonce)},h.key,bytes.subarray(12)));}
  catch{throw new Error('UVF file chunk authentication failed.');}
}
export function uvfCleartextSize(size:number):number{
  const body=size-68,remainder=body%32768;
  if(!Number.isSafeInteger(size)||body<28||remainder<28||Math.floor(body/32768)+1>2**32)throw new Error('Truncated UVF file or missing EOF block.');
  return Math.floor(body/32768)*UVF_CHUNK+remainder-28;
}
export async function uvfSmallFile(bytes:Bytes,m:UvfMaterial,seedId=m.payload.latestSeed):Promise<Bytes>{
  const h=await uvfEncryptHeader(m,seedId),chunks=[h.bytes];
  for(let start=0;start<bytes.length;start+=UVF_CHUNK)chunks.push(await uvfEncryptChunk(bytes.subarray(start,start+UVF_CHUNK),start/UVF_CHUNK,h.header));
  if(bytes.length%UVF_CHUNK===0)chunks.push(await uvfEncryptChunk(new Uint8Array(),bytes.length/UVF_CHUNK,h.header));
  return concat(...chunks);
}
export async function uvfReadDirectory(bytes:Bytes,m:UvfMaterial):Promise<string>{
  if(uvfCleartextSize(bytes.length)!==32)throw new Error('Invalid UVF directory metadata.');
  const h=await uvfDecryptHeader(bytes.subarray(0,68),m),id=await uvfDecryptChunk(bytes.subarray(68),0,h);
  const token=await uvfDirectoryPath({id,seedId:h.seedId},m);m.directories.set(token,{id,seedId:h.seedId});return token;
}
export async function generateUvf(password:string,progress?:(p:number)=>void):Promise<VaultBootstrap>{
  if(!password)throw new Error('Choose a vault password.');
  progress?.(0);const raw=random(32),seed=random(32),seedId=toBase64Url(random(4));let m:UvfMaterial|undefined;
  const payload:Payload={fileFormat:'AES-256-GCM-32k',nameFormat:'AES-SIV-512-B64URL',kdf:'HKDF-SHA512',kdfSalt:toBase64Url(random(32)),seeds:{[seedId]:toBase64Url(seed)},initialSeed:seedId,latestSeed:seedId};
  try{
    const header={alg:PASSWORD_ALG,kid:'app.crypte.vaultpassword',p2s:toBase64Url(random(16)),p2c:PASSWORD_ITERATIONS};
    const kek=await passwordKey(password,header,'wrapKey'),cek=await crypto.subtle.importKey('raw',raw,'AES-GCM',true,['encrypt']);
    const protectedHeader=toBase64Url(utf8(JSON.stringify({enc:'A256GCM',cty:'json',crit:['uvf.spec.version'],'uvf.spec.version':1}))),iv=random(12),clear=utf8(JSON.stringify(payload));
    let ciphertext:Bytes;try{ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf8(protectedHeader)},cek,clear));}finally{clear.fill(0);}
    const meta:UvfMetadata={protected:protectedHeader,iv:toBase64Url(iv),ciphertext:toBase64Url(ciphertext.subarray(0,-16)),tag:toBase64Url(ciphertext.subarray(-16)),recipients:[{header,encrypted_key:toBase64Url(new Uint8Array(await crypto.subtle.wrapKey('raw',cek,kek,'AES-KW')))}]};
    m=await openUvf(meta,raw);const root=uvfDirectory(m,'');
    const result={family:'uvf' as const,masterkey:'',configuration:JSON.stringify(meta,null,2),rootPath:await uvfDirectoryPath(root,m),backup:await uvfSmallFile(root.id,m,root.seedId)};progress?.(1);return result;
  }finally{raw.fill(0);seed.fill(0);payload.seeds={};if(m)destroyUvf(m);}
}

import {chacha20poly1305} from '@noble/ciphers/chacha.js';
import {hkdf} from '@noble/hashes/hkdf.js';
import {hmac} from '@noble/hashes/hmac.js';
import {scryptAsync} from '@noble/hashes/scrypt.js';
import {sha256} from '@noble/hashes/sha2.js';
import {concat,random,toBase64,utf8,type Bytes} from './bytes';

/**
 * age v1 file encryption (https://age-encryption.org/v1), implemented from the
 * C2SP specification: scrypt passphrases, native X25519 recipients and identities,
 * the STREAM payload and ASCII armor. Plugin, SSH and post-quantum recipients are
 * reported as unsupported rather than ignored.
 *
 * Streams are async iterables of bytes. Yielded buffers are wiped when the generator
 * resumes, so consumers must copy (or finish writing) a chunk before requesting the next.
 */
export class AgeError extends Error {}
export const AGE_EXTENSION='.age';
/** The age CLI default: 256 MiB of scrypt memory. */
export const DEFAULT_WORK_FACTOR=18;
/** 1 GiB of scrypt memory. age's own limit (22, 4 GiB) is beyond what a browser tab can allocate. */
export const MAX_WORK_FACTOR=20;
export interface AgeRecipient {type:'X25519';publicKey:Bytes;text:string;}
export interface AgeIdentity {type:'X25519';privateKey:CryptoKey;publicKey:Bytes;recipient:string;}
export type AgeEncryptKeys={passphrase:string}|{recipients:AgeRecipient[]};
const unlockedKeys=new WeakMap<AgeUnlocked,Bytes>();
/** A file key recovered by unlockAge. Only the file it was unlocked from authenticates with it.
 * A class rather than a plain object, so reactive wrappers (such as Svelte state) keep its identity. */
export class AgeUnlocked {
  private constructor(readonly passphrase:boolean){}
  /** @internal */
  static create(passphrase:boolean,fileKey:Bytes):AgeUnlocked {const unlocked=new AgeUnlocked(passphrase);unlockedKeys.set(unlocked,fileKey);return unlocked;}
  dispose():void {unlockedKeys.get(this)?.fill(0);unlockedKeys.delete(this);}
}
export type AgeDecryptKeys={passphrase:string}|{identities:AgeIdentity[]}|{unlocked:AgeUnlocked};
export interface AgeOptions {
  armor?:boolean;
  /** scrypt log2(N): the work factor written when encrypting, or the maximum accepted when decrypting. */
  workFactor?:number;
  /** Passphrase derivation progress, from 0 to 1. */
  onKeyProgress?:(fraction:number)=>void;
  signal?:AbortSignal;
}
export interface AgeHeaderInfo {armored:boolean;passphrase:boolean;recipients:number;types:string[];workFactor?:number;}

const VERSION='age-encryption.org/v1';
const CHUNK=64*1024,TAG=16,FILE_KEY=16,BATCH=1024*1024;
const MAX_LINE=16*1024,MAX_HEADER=1024*1024,MAX_STANZAS=4096;
const ARMOR_BEGIN='-----BEGIN AGE ENCRYPTED FILE-----',ARMOR_END='-----END AGE ENCRYPTED FILE-----',ARMOR_SLACK=1024;
const ZERO_NONCE=new Uint8Array(12);
const SCRYPT_LABEL=utf8('age-encryption.org/v1/scrypt'),X25519_LABEL=utf8('age-encryption.org/v1/X25519');
const RAW_BASE64=/^[A-Za-z0-9+/]*$/,ARGUMENT=/^[\x21-\x7e]+$/;

interface Stanza {type:string;args:string[];body:Bytes;}
interface Header {stanzas:Stanza[];authenticated:Bytes;mac:Bytes;}

function rawBase64(bytes:Uint8Array):string {return toBase64(bytes).replace(/=+$/,'');}
function decodeRawBase64(value:string):Bytes {
  if(!RAW_BASE64.test(value)||value.length%4===1)throw new AgeError('Invalid base64 in the age header.');
  const bytes=Uint8Array.from(atob(value+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));
  if(rawBase64(bytes)!==value)throw new AgeError('Non-canonical base64 in the age header.');
  return bytes;
}
function latin1(bytes:Uint8Array):string {let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return value;}
function equal(a:Uint8Array,b:Uint8Array):boolean {
  if(a.length!==b.length)return false;
  let difference=0;for(let i=0;i<a.length;i++)difference|=a[i]^b[i];
  return difference===0;
}
function streamNonce(counter:number,last:boolean):Bytes {
  if(!Number.isSafeInteger(counter)||counter<0)throw new AgeError('The age payload is too large.');
  const nonce=new Uint8Array(12),view=new DataView(nonce.buffer);
  view.setUint32(3,Math.floor(counter/2**32));view.setUint32(7,counter>>>0);nonce[11]=last?1:0;
  return nonce;
}
const headerKey=(fileKey:Bytes)=>hkdf(sha256,fileKey,new Uint8Array(0),utf8('header'),32);
const payloadKey=(fileKey:Bytes,nonce:Bytes)=>hkdf(sha256,fileKey,nonce,utf8('payload'),32);
function headerMac(fileKey:Bytes,authenticated:Bytes):Bytes {const key=headerKey(fileKey);try{return hmac(sha256,key,authenticated);}finally{key.fill(0);}}

/** Buffered reader over an async byte stream. Internal copies are wiped once consumed. */
class Reader {
  private buffer:Bytes=new Uint8Array(0);private offset=0;private done=false;
  private iterator:AsyncIterator<Uint8Array>;
  constructor(source:AsyncIterable<Uint8Array>){this.iterator=source[Symbol.asyncIterator]();}
  private get available(){return this.buffer.length-this.offset;}
  private async fill():Promise<boolean>{
    while(!this.done){
      const next=await this.iterator.next();
      if(next.done){this.done=true;break;}
      if(!next.value.length)continue;
      const merged=new Uint8Array(this.available+next.value.length);
      merged.set(this.buffer.subarray(this.offset));merged.set(next.value,this.available);
      this.buffer.fill(0);this.buffer=merged;this.offset=0;
      return true;
    }
    return false;
  }
  async read(length:number):Promise<Bytes>{
    while(this.available<length&&await this.fill());
    const bytes=this.buffer.slice(this.offset,this.offset+Math.min(length,this.available));
    this.buffer.fill(0,this.offset,this.offset+bytes.length);this.offset+=bytes.length;
    return bytes;
  }
  async peek(length:number):Promise<Bytes>{while(this.available<length&&await this.fill());return this.buffer.slice(this.offset,this.offset+Math.min(length,this.available));}
  async eof():Promise<boolean>{return this.available===0&&!await this.fill();}
  /** Reads a line terminated by LF, without the terminator. Returns undefined at a clean end of stream. */
  async line(limit=MAX_LINE):Promise<string|undefined>{
    for(let searched=0;;){
      const index=this.buffer.subarray(this.offset+searched).indexOf(10);
      if(index>=0){
        const end=this.offset+searched+index;
        if(end-this.offset>limit)throw new AgeError('A line in the age file is too long.');
        const value=latin1(this.buffer.subarray(this.offset,end));this.offset=end+1;
        return value;
      }
      searched=this.available;
      if(searched>limit)throw new AgeError('A line in the age file is too long.');
      if(!await this.fill()){if(this.available)throw new AgeError('The age file is truncated.');return undefined;}
    }
  }
  async close():Promise<void>{this.buffer.fill(0);this.buffer=new Uint8Array(0);this.offset=0;if(!this.done){this.done=true;await this.iterator.return?.();}}
}

/* ---------- Bech32 (BIP 173, without the 90-character limit, as used by age) ---------- */
const CHARSET='qpzry9x8gf2tvdw0s3jn54khce6mua7l',GENERATOR=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];
function polymod(values:number[]):number {
  let checksum=1;
  for(const value of values){const top=checksum>>>25;checksum=((checksum&0x1ffffff)<<5)^value;for(let i=0;i<5;i++)if((top>>>i)&1)checksum^=GENERATOR[i];}
  return checksum>>>0;
}
const expand=(hrp:string)=>[...[...hrp].map(c=>c.charCodeAt(0)>>>5),0,...[...hrp].map(c=>c.charCodeAt(0)&31)];
function convert(data:ArrayLike<number>,from:number,to:number,pad:boolean):number[] {
  let accumulator=0,bits=0;const result:number[]=[],mask=(1<<to)-1;
  for(let i=0;i<data.length;i++){accumulator=(accumulator<<from|data[i])&0xffffff;bits+=from;while(bits>=to){bits-=to;result.push((accumulator>>>bits)&mask);}}
  if(pad){if(bits)result.push((accumulator<<(to-bits))&mask);}
  else if(bits>=from||((accumulator<<(to-bits))&mask))throw new AgeError('Invalid key encoding.');
  return result;
}
export function bech32Encode(hrp:string,data:Uint8Array,upper=false):string {
  const prefix=hrp.toLowerCase(),words=convert(data,8,5,true),checksum=polymod([...expand(prefix),...words,0,0,0,0,0,0])^1;
  const encoded=`${prefix}1${[...words,...Array.from({length:6},(_,i)=>(checksum>>>(5*(5-i)))&31)].map(word=>CHARSET[word]).join('')}`;
  return upper?encoded.toUpperCase():encoded;
}
export function bech32Decode(value:string):{hrp:string;data:Bytes} {
  if(value!==value.toLowerCase()&&value!==value.toUpperCase())throw new AgeError('Keys cannot mix upper and lower case.');
  const lower=value.toLowerCase(),separator=lower.lastIndexOf('1');
  if(separator<1||separator+7>lower.length||[...lower].some(c=>c.charCodeAt(0)<33||c.charCodeAt(0)>126))throw new AgeError('Invalid key encoding.');
  const hrp=lower.slice(0,separator),words=[...lower.slice(separator+1)].map(c=>CHARSET.indexOf(c));
  if(words.includes(-1)||polymod([...expand(hrp),...words])!==1)throw new AgeError('Invalid key checksum. Check that the key was copied completely.');
  return {hrp,data:Uint8Array.from(convert(words.slice(0,-6),5,8,false))};
}

/* ---------- X25519 keys (Web Crypto) ---------- */
const PKCS8_X25519=Uint8Array.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x6e,0x04,0x22,0x04,0x20]);
const BASEPOINT=Uint8Array.from({length:32},(_,i)=>i?0:9);
const X25519={name:'X25519'};
let x25519Support:Promise<boolean>|undefined;
/** Native X25519 is needed for public-key recipients and identities, not for passphrases. */
export function x25519Available():Promise<boolean> {
  return x25519Support??=(async()=>{try{await crypto.subtle.generateKey(X25519,false,['deriveBits']);return true;}catch{return false;}})();
}
async function requireX25519():Promise<void> {
  if(!await x25519Available())throw new AgeError('This browser does not support X25519 keys. Use a passphrase, or update to a current browser.');
}
async function sharedSecret(privateKey:CryptoKey,publicKey:Bytes):Promise<Bytes> {
  let shared:Bytes;
  try{
    const peer=await crypto.subtle.importKey('raw',publicKey,X25519,false,[]);
    shared=new Uint8Array(await crypto.subtle.deriveBits({name:'X25519',public:peer} as EcdhKeyDeriveParams,privateKey,256));
  }catch{throw new AgeError('Invalid X25519 public key.');}
  if(shared.every(byte=>byte===0))throw new AgeError('Invalid X25519 public key.');
  return shared;
}
async function importIdentity(scalar:Bytes):Promise<AgeIdentity> {
  await requireX25519();
  const pkcs8=concat(PKCS8_X25519,scalar);
  try{
    const privateKey=await crypto.subtle.importKey('pkcs8',pkcs8,X25519,false,['deriveBits']);
    const publicKey=new Uint8Array(await crypto.subtle.deriveBits({name:'X25519',public:await crypto.subtle.importKey('raw',BASEPOINT,X25519,false,[])} as EcdhKeyDeriveParams,privateKey,256));
    return {type:'X25519',privateKey,publicKey,recipient:bech32Encode('age',publicKey)};
  }finally{pkcs8.fill(0);}
}
/** Generates an identity in the age-keygen file format. */
export async function generateIdentity():Promise<{identity:string;recipient:string}> {
  await requireX25519();
  const pair=await crypto.subtle.generateKey(X25519,true,['deriveBits']) as CryptoKeyPair;
  const pkcs8=new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey));
  try{
    if(pkcs8.length!==48||!equal(pkcs8.subarray(0,16),PKCS8_X25519))throw new AgeError('Unexpected X25519 key format.');
    const recipient=bech32Encode('age',new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)));
    const created=new Date().toISOString().replace(/\.\d+Z$/,'Z');
    return {recipient,identity:`# created: ${created}\n# public key: ${recipient}\n${bech32Encode('AGE-SECRET-KEY-',pkcs8.subarray(16),true)}\n`};
  }finally{pkcs8.fill(0);}
}
function keyLines(text:string):{line:string;number:number}[] {
  return text.split(/\r?\n/).map((line,index)=>({line:line.trim(),number:index+1})).filter(({line})=>line&&!line.startsWith('#'));
}
/** Parses age recipients: one `age1…` public key per line, with `#` comments. */
export function parseRecipients(text:string):AgeRecipient[] {
  const recipients=new Map<string,AgeRecipient>();
  for(const {line,number} of keyLines(text)){
    const where=`Line ${number}`;
    if(/^(ssh-|ecdsa-)/.test(line))throw new AgeError(`${where}: SSH keys are not supported. Use an age public key (age1…).`);
    if(/^AGE-(SECRET-KEY|PLUGIN)-/i.test(line))throw new AgeError(`${where} is a secret key. Share and paste only public keys (age1…).`);
    let decoded:ReturnType<typeof bech32Decode>;
    try{decoded=bech32Decode(line);}catch(e){throw new AgeError(`${where}: ${e instanceof Error?e.message:'invalid key'}`);}
    if(decoded.hrp!=='age')throw new AgeError(decoded.hrp.startsWith('age1')?`${where}: “${decoded.hrp}” plugin and post-quantum recipients are not supported.`:`${where} is not an age public key.`);
    if(decoded.data.length!==32)throw new AgeError(`${where}: invalid X25519 public key length.`);
    const canonical=bech32Encode('age',decoded.data);
    recipients.set(canonical,{type:'X25519',publicKey:decoded.data,text:canonical});
  }
  if(!recipients.size)throw new AgeError('Add at least one age public key (age1…).');
  return [...recipients.values()];
}
/** Parses an age identity file: `AGE-SECRET-KEY-1…` lines, with `#` comments. */
export async function parseIdentities(text:string):Promise<AgeIdentity[]> {
  const trimmed=text.trimStart();
  if(trimmed.startsWith(VERSION)||trimmed.startsWith(ARMOR_BEGIN))throw new AgeError('This identity file is itself encrypted. Decrypt it first, then use the secret key inside.');
  const identities:AgeIdentity[]=[];
  for(const {line,number} of keyLines(text)){
    const where=`Line ${number}`;
    if(/^AGE-PLUGIN-/i.test(line))throw new AgeError(`${where}: plugin identities are not supported.`);
    if(/^age1/i.test(line))throw new AgeError(`${where} is a public key. Decryption needs the matching secret key (AGE-SECRET-KEY-1…).`);
    if(/^-----BEGIN/.test(line))throw new AgeError(`${where}: SSH keys are not supported.`);
    let decoded:ReturnType<typeof bech32Decode>;
    try{decoded=bech32Decode(line);}catch(e){throw new AgeError(`${where}: ${e instanceof Error?e.message:'invalid key'}`);}
    try{
      if(decoded.hrp!=='age-secret-key-')throw new AgeError(`${where} is not an age secret key.`);
      if(decoded.data.length!==32)throw new AgeError(`${where}: invalid X25519 secret key length.`);
      identities.push(await importIdentity(decoded.data));
    }finally{decoded.data.fill(0);}
  }
  if(!identities.length)throw new AgeError('Add an age secret key (AGE-SECRET-KEY-1…).');
  return identities;
}

/* ---------- Header ---------- */
function stanzaText(stanza:Stanza):string {
  const body=rawBase64(stanza.body);let text=`-> ${[stanza.type,...stanza.args].join(' ')}\n`;
  // The final body line is always shorter than 64 columns, so it may be empty.
  for(let i=0;i<=body.length;i+=64)text+=`${body.slice(i,i+64)}\n`;
  return text;
}
async function readHeader(reader:Reader):Promise<Header> {
  const start=latin1(await reader.peek(VERSION.length+1));
  if(start!==`${VERSION}\n`)throw new AgeError(start.startsWith(VERSION)?'Invalid age header.':start.startsWith('age-encryption.org/')?'This age file uses an unsupported format version.':'This is not an age encrypted file.');
  let text=`${await reader.line()}\n`;const stanzas:Stanza[]=[];
  for(;;){
    const line=await reader.line();
    if(line===undefined)throw new AgeError('The age header is truncated.');
    if(text.length+line.length>MAX_HEADER||stanzas.length>MAX_STANZAS)throw new AgeError('The age header is too large.');
    if(line.startsWith('--- ')){
      const mac=decodeRawBase64(line.slice(4));
      if(mac.length!==32||!stanzas.length)throw new AgeError('Invalid age header.');
      return {stanzas,authenticated:utf8(`${text}---`),mac};
    }
    if(!line.startsWith('-> '))throw new AgeError('Invalid age header.');
    const args=line.slice(3).split(' ');
    if(args.some(arg=>!ARGUMENT.test(arg)))throw new AgeError('Invalid age header stanza.');
    text+=`${line}\n`;let body='';
    for(;;){
      const bodyLine=await reader.line(64);
      if(bodyLine===undefined)throw new AgeError('The age header is truncated.');
      if(!RAW_BASE64.test(bodyLine))throw new AgeError('Invalid base64 in the age header.');
      text+=`${bodyLine}\n`;body+=bodyLine;
      if(text.length>MAX_HEADER)throw new AgeError('The age header is too large.');
      if(bodyLine.length<64)break;
    }
    stanzas.push({type:args[0],args:args.slice(1),body:decodeRawBase64(body)});
  }
}
function scryptParameters(stanza:Stanza,maximum:number):{salt:Bytes;workFactor:number} {
  if(stanza.args.length!==2||!/^[1-9][0-9]?$/.test(stanza.args[1]))throw new AgeError('Invalid passphrase stanza.');
  const salt=decodeRawBase64(stanza.args[0]),workFactor=Number(stanza.args[1]);
  if(salt.length!==16||stanza.body.length!==FILE_KEY+TAG)throw new AgeError('Invalid passphrase stanza.');
  if(workFactor>maximum)throw new AgeError(`This file needs a scrypt work factor of ${workFactor}; this browser tool accepts at most ${maximum}. Decrypt it with the age command-line tool instead.`);
  return {salt,workFactor};
}
async function scryptKey(passphrase:string,salt:Bytes,workFactor:number,options:AgeOptions):Promise<Bytes> {
  const password=utf8(passphrase);
  try{
    return await scryptAsync(password,concat(SCRYPT_LABEL,salt),{N:2**workFactor,r:8,p:1,dkLen:32,maxmem:2**(workFactor+10)+4096,onProgress:fraction=>{options.signal?.throwIfAborted();options.onKeyProgress?.(fraction);}});
  }finally{password.fill(0);}
}
function wrap(key:Bytes,fileKey:Bytes):Bytes {try{return chacha20poly1305(key,ZERO_NONCE).encrypt(fileKey);}finally{key.fill(0);}}
function unwrap(key:Bytes,body:Bytes):Bytes|undefined {try{return chacha20poly1305(key,ZERO_NONCE).decrypt(body);}catch{return undefined;}finally{key.fill(0);}}
async function recipientStanza(recipient:AgeRecipient,fileKey:Bytes):Promise<Stanza> {
  const ephemeral=await crypto.subtle.generateKey(X25519,false,['deriveBits']) as CryptoKeyPair;
  const share=new Uint8Array(await crypto.subtle.exportKey('raw',ephemeral.publicKey)),shared=await sharedSecret(ephemeral.privateKey,recipient.publicKey);
  try{return {type:'X25519',args:[rawBase64(share)],body:wrap(hkdf(sha256,shared,concat(share,recipient.publicKey),X25519_LABEL,32),fileKey)};}
  finally{shared.fill(0);}
}
async function fileKeyFrom(header:Header,keys:AgeDecryptKeys,options:AgeOptions):Promise<Bytes> {
  if('unlocked' in keys){
    const fileKey=unlockedKeys.get(keys.unlocked);
    if(!fileKey)throw new AgeError('The decryption key was cleared. Unlock the file again.');
    return fileKey.slice();
  }
  const passphraseStanzas=header.stanzas.filter(stanza=>stanza.type==='scrypt');
  if(passphraseStanzas.length&&header.stanzas.length!==1)throw new AgeError('Invalid age file: a passphrase stanza must be the only one.');
  if('passphrase' in keys){
    if(!passphraseStanzas.length)throw new AgeError('This file is encrypted to public keys, not a passphrase. Use the matching secret key instead.');
    const stanza=passphraseStanzas[0],{salt,workFactor}=scryptParameters(stanza,options.workFactor??MAX_WORK_FACTOR);
    const fileKey=unwrap(await scryptKey(keys.passphrase,salt,workFactor,options),stanza.body);
    if(!fileKey)throw new AgeError('Incorrect passphrase.');
    return fileKey;
  }
  if(passphraseStanzas.length)throw new AgeError('This file is protected by a passphrase. Enter the passphrase instead of a key.');
  for(const stanza of header.stanzas){
    if(stanza.type!=='X25519')continue;
    const share=stanza.args.length===1?decodeRawBase64(stanza.args[0]):undefined;
    if(share?.length!==32||stanza.body.length!==FILE_KEY+TAG)throw new AgeError('Invalid X25519 recipient stanza.');
    for(const identity of keys.identities){
      const shared=await sharedSecret(identity.privateKey,share);
      try{
        const fileKey=unwrap(hkdf(sha256,shared,concat(share,identity.publicKey),X25519_LABEL,32),stanza.body);
        if(fileKey)return fileKey;
      }finally{shared.fill(0);}
    }
  }
  throw new AgeError(header.stanzas.some(stanza=>stanza.type==='X25519')?'None of these secret keys can decrypt this file.':'This file uses a recipient type that is not supported here (such as an SSH, plugin or post-quantum key).');
}
function verifyHeader(header:Header,fileKey:Bytes):void {
  if(fileKey.length!==FILE_KEY||!equal(headerMac(fileKey,header.authenticated),header.mac))throw new AgeError('The age header failed authentication. The file is damaged or was modified.');
}

/* ---------- Armor ---------- */
const isSpace=(byte:number)=>byte===32||byte===9||byte===10||byte===13;
async function isArmored(reader:Reader):Promise<boolean> {
  const start=await reader.peek(ARMOR_SLACK+ARMOR_BEGIN.length),offset=start.findIndex(byte=>!isSpace(byte));
  return offset>=0&&latin1(start.subarray(offset,offset+ARMOR_BEGIN.length))===ARMOR_BEGIN;
}
const stripCR=(line:string|undefined)=>line?.endsWith('\r')?line.slice(0,-1):line;
async function* dearmor(reader:Reader):AsyncGenerator<Bytes> {
  let skipped=0;
  while(isSpace((await reader.peek(1))[0])){if(++skipped>ARMOR_SLACK)throw new AgeError('Invalid armored age file.');await reader.read(1);}
  if(stripCR(await reader.line(80))!==ARMOR_BEGIN)throw new AgeError('Invalid armored age file.');
  let pending:Bytes[]=[],size=0,short=false;
  for(;;){
    const line=stripCR(await reader.line(80));
    if(line===undefined)throw new AgeError('The armored age file is truncated.');
    if(line===ARMOR_END)break;
    if(short||!line.length||line.length>64||line.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(line))throw new AgeError('Invalid armored age file.');
    // Padding or a short line ends the data: only the END line may follow.
    if(line.length<64||line.endsWith('='))short=true;
    const bytes=Uint8Array.from(atob(line),c=>c.charCodeAt(0));
    if(toBase64(bytes)!==line)throw new AgeError('Invalid armored age file.');
    pending.push(bytes);size+=bytes.length;
    if(size>=BATCH){yield concat(...pending);pending=[];size=0;}
  }
  if(size)yield concat(...pending);
  const trailing=await reader.read(ARMOR_SLACK+1);
  if(trailing.length>ARMOR_SLACK||!trailing.every(isSpace))throw new AgeError('Unexpected data after the armored age file.');
}
async function* armor(source:AsyncIterable<Bytes>):AsyncGenerator<Bytes> {
  yield utf8(`${ARMOR_BEGIN}\n`);
  let pending:Bytes=new Uint8Array(0);
  for await(const chunk of source){
    pending=concat(pending,chunk);
    const whole=pending.length-pending.length%48;
    if(whole){yield utf8(toBase64(pending.subarray(0,whole)).replace(/.{64}/g,'$&\n'));pending=pending.slice(whole);}
  }
  yield utf8(`${pending.length?`${toBase64(pending)}\n`:''}${ARMOR_END}\n`);
}

/* ---------- Encryption and decryption ---------- */
/** Encrypts a byte stream to an age file. */
export async function* encryptAge(source:AsyncIterable<Uint8Array>,keys:AgeEncryptKeys,options:AgeOptions={}):AsyncGenerator<Bytes> {
  const binary=encryptBinary(source,keys,options);
  yield* options.armor?armor(binary):binary;
}
async function* encryptBinary(source:AsyncIterable<Uint8Array>,keys:AgeEncryptKeys,options:AgeOptions):AsyncGenerator<Bytes> {
  const fileKey=random(FILE_KEY),nonce=random(16),reader=new Reader(source);
  let key:Bytes|undefined,batch:Bytes[]=[],size=0;
  try{
    let stanzas:Stanza[];
    if('passphrase' in keys){
      if(!keys.passphrase)throw new AgeError('Choose a passphrase.');
      const workFactor=options.workFactor??DEFAULT_WORK_FACTOR;
      if(!Number.isInteger(workFactor)||workFactor<1||workFactor>MAX_WORK_FACTOR)throw new AgeError('Invalid scrypt work factor.');
      const salt=random(16);
      stanzas=[{type:'scrypt',args:[rawBase64(salt),String(workFactor)],body:wrap(await scryptKey(keys.passphrase,salt,workFactor,options),fileKey)}];
    }else{
      if(!keys.recipients.length)throw new AgeError('Add at least one age public key (age1…).');
      await requireX25519();
      stanzas=[];for(const recipient of keys.recipients)stanzas.push(await recipientStanza(recipient,fileKey));
    }
    options.signal?.throwIfAborted();
    const header=`${VERSION}\n${stanzas.map(stanzaText).join('')}---`;
    yield concat(utf8(`${header} ${rawBase64(headerMac(fileKey,utf8(header)))}\n`),nonce);
    key=payloadKey(fileKey,nonce);
    for(let counter=0;;counter++){
      options.signal?.throwIfAborted();
      const plaintext=await reader.read(CHUNK);
      try{
        const last=plaintext.length<CHUNK||await reader.eof();
        const ciphertext=chacha20poly1305(key,streamNonce(counter,last)).encrypt(plaintext);
        batch.push(ciphertext);size+=ciphertext.length;
        if(size>=BATCH||last){yield concat(...batch);batch=[];size=0;}
        if(last)return;
      }finally{plaintext.fill(0);}
    }
  }finally{fileKey.fill(0);key?.fill(0);await reader.close();}
}
/** Decrypts a binary or armored age file. Every yielded chunk has been authenticated;
 * truncation is only detected at the end, so discard partial output on error. */
export async function* decryptAge(source:AsyncIterable<Uint8Array>,keys:AgeDecryptKeys,options:AgeOptions={}):AsyncGenerator<Bytes> {
  const outer=new Reader(source);
  const reader=await isArmored(outer)?new Reader(dearmor(outer)):outer;
  let fileKey:Bytes|undefined,key:Bytes|undefined,batch:Bytes[]=[],size=0;
  const flush=()=>{const bytes=concat(...batch);for(const part of batch)part.fill(0);batch=[];size=0;return bytes;};
  try{
    const header=await readHeader(reader);
    fileKey=await fileKeyFrom(header,keys,options);
    verifyHeader(header,fileKey);
    options.signal?.throwIfAborted();
    const nonce=await reader.read(16);
    if(nonce.length!==16)throw new AgeError('The age file is truncated.');
    key=payloadKey(fileKey,nonce);
    for(let counter=0;;counter++){
      options.signal?.throwIfAborted();
      const ciphertext=await reader.read(CHUNK+TAG);
      if(ciphertext.length<TAG)throw new AgeError('The age file is truncated.');
      const last=ciphertext.length<CHUNK+TAG||await reader.eof();
      let plaintext:Bytes;
      try{plaintext=chacha20poly1305(key,streamNonce(counter,last)).decrypt(ciphertext);}
      catch{
        if(!last){try{chacha20poly1305(key,streamNonce(counter,true)).decrypt(ciphertext).fill(0);}catch{throw new AgeError(`Encrypted chunk ${counter+1} failed authentication. The file is damaged or was modified.`);}throw new AgeError('Unexpected data after the end of the encrypted file.');}
        throw new AgeError(`Encrypted chunk ${counter+1} failed authentication. The file is damaged, truncated or was modified.`);
      }
      if(last&&!plaintext.length&&counter>0)throw new AgeError('Invalid age payload: the final chunk is empty.');
      batch.push(plaintext);size+=plaintext.length;
      if(size>=BATCH||last){const bytes=flush();try{yield bytes;}finally{bytes.fill(0);}}
      if(last)return;
    }
  }finally{fileKey?.fill(0);key?.fill(0);for(const part of batch)part.fill(0);await reader.close();if(reader!==outer)await outer.close();}
}
/** Checks a passphrase or identities against the header and keeps the file key, so the
 * payload can be decrypted later (for example after choosing where to save it). */
export async function unlockAge(source:AsyncIterable<Uint8Array>,keys:AgeDecryptKeys,options:AgeOptions={}):Promise<AgeUnlocked> {
  const outer=new Reader(source),reader=await isArmored(outer)?new Reader(dearmor(outer)):outer;
  try{
    const header=await readHeader(reader),fileKey=await fileKeyFrom(header,keys,options);
    try{verifyHeader(header,fileKey);}catch(e){fileKey.fill(0);throw e;}
    return AgeUnlocked.create(header.stanzas[0].type==='scrypt',fileKey);
  }finally{await reader.close();if(reader!==outer)await outer.close();}
}
/** Reads only the header: whether a passphrase or keys are needed. */
export async function inspectAge(source:AsyncIterable<Uint8Array>):Promise<AgeHeaderInfo> {
  const outer=new Reader(source),armored=await isArmored(outer),reader=armored?new Reader(dearmor(outer)):outer;
  try{
    const {stanzas}=await readHeader(reader),passphrase=stanzas.find(stanza=>stanza.type==='scrypt');
    const workFactor=passphrase&&/^[1-9][0-9]?$/.test(passphrase.args[1]??'')?Number(passphrase.args[1]):undefined;
    return {armored,passphrase:Boolean(passphrase),recipients:passphrase?0:stanzas.length,types:[...new Set(stanzas.map(stanza=>stanza.type))],workFactor};
  }finally{await reader.close();if(reader!==outer)await outer.close();}
}
/** Upper bound of the encrypted size, used to decide whether an in-memory download is possible. */
export function encryptedSizeEstimate(size:number,recipients:number,armored:boolean):number {
  const binary=200+130*Math.max(1,recipients)+16+size+TAG*Math.max(1,Math.ceil(size/CHUNK));
  return armored?Math.ceil(binary/48)*65+80:binary;
}
export const isAgeName=(name:string)=>name.toLowerCase().endsWith(AGE_EXTENSION)&&name.length>AGE_EXTENSION.length;
/** The plaintext name for a decrypted file: removes `.age`, or appends `.decrypted`. */
export function decryptedName(name:string):string {
  return isAgeName(name)?name.slice(0,-AGE_EXTENSION.length):`${name}.decrypted`;
}

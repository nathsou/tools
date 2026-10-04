import { aessiv } from '@noble/ciphers/aes.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { base32, concat, digest, fromBase64, random, text, toBase64, toBase64Url, u64, utf8, type Bytes } from './bytes';
import type { CipherCombo } from './types';

export const CLEAR_CHUNK = 32768;
export interface MasterkeyFile {
  version: number; scryptSalt: string; scryptCostParam: number; scryptBlockSize: number;
  primaryMasterKey: string; hmacMasterKey: string; versionMac: string;
}
export interface VaultConfiguration { format: 8; cipherCombo: CipherCombo; jti: string; shorteningThreshold: number; }
export interface ParsedConfiguration { token: string; keyPath: string; payload: VaultConfiguration; signatureHash:'SHA-256'|'SHA-384'|'SHA-512'; }
export interface Material { raw: Bytes; siv: Bytes; enc: CryptoKey; mac: CryptoKey; combo: CipherCombo; }
export interface FileHeader { nonce: Bytes; key: CryptoKey; }
export interface VaultBootstrap { masterkey:string; configuration:string; rootPath:string; backup:Bytes; }
/** Runs in the vault worker. Only wrapped keys and encrypted metadata leave it. */
export async function generateVault(password:string,onProgress?:(p:number)=>void):Promise<VaultBootstrap> {
  if (!password) throw new Error('Choose a vault password.');
  const raw=random(64),salt=random(8),passwordBytes=utf8(password.normalize('NFC'));
  let kekBytes:Bytes|undefined,material:Material|undefined;
  try {
    material=await createMaterial(raw,'SIV_GCM');
    kekBytes=new Uint8Array(await scryptAsync(passwordBytes,salt,{N:32768,r:8,p:1,dkLen:32,maxmem:256*1024*1024,onProgress}));
    const kek=await crypto.subtle.importKey('raw',kekBytes,'AES-KW',false,['wrapKey']);
    const wrap=async(bytes:Bytes)=>{
      const key=await crypto.subtle.importKey('raw',bytes,'AES-CTR',true,['encrypt']);
      return toBase64(new Uint8Array(await crypto.subtle.wrapKey('raw',key,kek,'AES-KW')));
    };
    const version=new Uint8Array(4);new DataView(version.buffer).setUint32(0,999);
    const masterkey=JSON.stringify({version:999,scryptSalt:toBase64(salt),scryptCostParam:32768,scryptBlockSize:8,primaryMasterKey:await wrap(raw.subarray(0,32)),hmacMasterKey:await wrap(raw.subarray(32)),versionMac:toBase64(new Uint8Array(await crypto.subtle.sign('HMAC',material.mac,version)))},null,2);
    const header=toBase64Url(utf8(JSON.stringify({alg:'HS256',kid:'masterkeyfile:masterkey.cryptomator'})));
    const payload=toBase64Url(utf8(JSON.stringify({jti:crypto.randomUUID(),format:8,cipherCombo:'SIV_GCM',shorteningThreshold:220})));
    const signingKey=await crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const configuration=`${header}.${payload}.${toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC',signingKey,utf8(`${header}.${payload}`))))}`;
    return {masterkey,configuration,rootPath:await directoryPath('',material),backup:(await encryptHeader(material)).bytes};
  } finally {raw.fill(0);passwordBytes.fill(0);kekBytes?.fill(0);if(material)destroyMaterial(material);}
}
export const headerSize = (combo: CipherCombo): number => combo === 'SIV_GCM' ? 68 : 88;
export const chunkOverhead = (combo: CipherCombo): number => combo === 'SIV_GCM' ? 28 : 48;

export function parseConfiguration(token: string): ParsedConfiguration {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts.some(p => !p)) throw new Error('Invalid vault configuration.');
  let header: { alg?: string; kid?: string }; let payload: VaultConfiguration;
  try { header = JSON.parse(text(fromBase64(parts[0]))); payload = JSON.parse(text(fromBase64(parts[1]))); }
  catch { throw new Error('Invalid vault configuration.'); }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') throw new Error('Invalid vault configuration.');
  const hashes = { HS256:'SHA-256',HS384:'SHA-384',HS512:'SHA-512' } as const;
  if (!header.alg || !Object.hasOwn(hashes,header.alg)) throw new Error('Unsupported vault signature algorithm.');
  const signatureHash = hashes[header.alg as keyof typeof hashes];
  if (typeof header.kid !== 'string' || !header.kid.startsWith('masterkeyfile:')) throw new Error('This app supports password-protected vaults. Hub-managed vaults are not supported.');
  let keyPath: string;
  try { keyPath = decodeURIComponent(header.kid.slice('masterkeyfile:'.length)); }
  catch { throw new Error('Invalid masterkey location.'); }
  if (!keyPath || keyPath.startsWith('/') || keyPath.includes('\\') || keyPath.includes('\0') || keyPath.split('/').some(p => !p || p === '.' || p === '..') || keyPath.includes('?') || keyPath.includes('#')) throw new Error('The masterkey must be inside the selected vault.');
  return { token: token.trim(), keyPath, payload, signatureHash };
}
export function checkConfiguration(payload: VaultConfiguration): void {
  if (payload.format !== 8) throw new Error(`Unsupported vault format ${payload.format}. Formats 7 and 8 are supported.`);
  if (!['SIV_CTRMAC', 'SIV_GCM'].includes(payload.cipherCombo)) throw new Error(`Unsupported vault cipher: ${payload.cipherCombo}.`);
  if (typeof payload.jti !== 'string' || !payload.jti || !Number.isInteger(payload.shorteningThreshold) || payload.shorteningThreshold < 16 || payload.shorteningThreshold > 255) throw new Error('Invalid vault configuration fields.');
}
export function parseMasterkey(json: string): MasterkeyFile {
  let m: MasterkeyFile;
  try { m = JSON.parse(json); } catch { throw new Error('Invalid masterkey file.'); }
  if (!m || typeof m !== 'object') throw new Error('Invalid masterkey file.');
  if (!Number.isInteger(m.version) || m.version < 0 || m.version > 0xffffffff || !Number.isSafeInteger(m.scryptCostParam) || m.scryptCostParam < 2 || m.scryptCostParam > 1048576 || (m.scryptCostParam & (m.scryptCostParam - 1)) !== 0 || !Number.isInteger(m.scryptBlockSize) || m.scryptBlockSize < 1 || m.scryptBlockSize > 32) throw new Error('Invalid scrypt parameters in the masterkey file.');
  if (128 * m.scryptCostParam * m.scryptBlockSize + 128 * m.scryptBlockSize > 256 * 1024 * 1024) throw new Error('This vault requires more than 256 MB for password derivation.');
  for (const [field, size] of [['primaryMasterKey',40],['hmacMasterKey',40],['versionMac',32]] as const) {
    if (typeof m[field] !== 'string' || fromBase64(m[field]).length !== size) throw new Error('Invalid wrapped masterkeys.');
  }
  if (typeof m.scryptSalt !== 'string' || fromBase64(m.scryptSalt).length < 8 || fromBase64(m.scryptSalt).length > 64) throw new Error('Invalid password salt.');
  return m;
}
export async function unlockMasterkey(m: MasterkeyFile, password: string, onProgress?: (p: number) => void): Promise<Bytes> {
  const passwordBytes = utf8(password.normalize('NFC'));
  let kekBytes: Bytes | undefined;
  try {
    kekBytes = new Uint8Array(await scryptAsync(passwordBytes, fromBase64(m.scryptSalt), { N: m.scryptCostParam, r: m.scryptBlockSize, p: 1, dkLen: 32, maxmem: 256 * 1024 * 1024, onProgress }));
    const kek = await crypto.subtle.importKey('raw', kekBytes, 'AES-KW', false, ['unwrapKey']);
    const enc = await crypto.subtle.unwrapKey('raw', fromBase64(m.primaryMasterKey), kek, 'AES-KW', 'AES-CTR', true, ['decrypt']);
    const mac = await crypto.subtle.unwrapKey('raw', fromBase64(m.hmacMasterKey), kek, 'AES-KW', { name: 'HMAC', hash: 'SHA-256' }, true, ['verify']);
    const encBytes = new Uint8Array(await crypto.subtle.exportKey('raw', enc));
    const macBytes = new Uint8Array(await crypto.subtle.exportKey('raw', mac));
    try { return concat(encBytes, macBytes); } finally { encBytes.fill(0); macBytes.fill(0); }
  } catch (e) {
    if (e instanceof DOMException && ['OperationError','DataError'].includes(e.name)) throw new Error('Incorrect password, or the masterkey file is damaged.');
    throw e;
  } finally { passwordBytes.fill(0); kekBytes?.fill(0); }
}
export async function createMaterial(raw: Bytes, combo: CipherCombo): Promise<Material> {
  if (raw.length !== 64) throw new Error('Invalid vault key length.');
  return {
    raw: raw.slice(), siv: concat(raw.subarray(32), raw.subarray(0,32)), combo,
    enc: await crypto.subtle.importKey('raw', raw.subarray(0,32), combo === 'SIV_GCM' ? 'AES-GCM' : 'AES-CTR', false, ['encrypt','decrypt']),
    mac: await crypto.subtle.importKey('raw', raw.subarray(32), { name:'HMAC', hash:'SHA-256' }, false, ['sign','verify'])
  };
}
export async function verifyMasterkeyVersion(m: MasterkeyFile, material: Material): Promise<void> {
  const version = new Uint8Array(4); new DataView(version.buffer).setUint32(0, m.version);
  if (!await crypto.subtle.verify('HMAC', material.mac, fromBase64(m.versionMac), version)) throw new Error('Masterkey version authentication failed.');
}
export async function verifyConfiguration(config: ParsedConfiguration, raw: Bytes): Promise<void> {
  const [header, payload, signature] = config.token.split('.');
  const key = await crypto.subtle.importKey('raw', raw, { name:'HMAC', hash:config.signatureHash }, false, ['verify']);
  const signatureLength = config.signatureHash === 'SHA-256' ? 32 : config.signatureHash === 'SHA-384' ? 48 : 64;
  if (fromBase64(signature).length !== signatureLength || !await crypto.subtle.verify('HMAC', key, fromBase64(signature), utf8(`${header}.${payload}`))) throw new Error('Vault configuration authentication failed.');
  checkConfiguration(config.payload);
}
export async function directoryPath(directoryId: string, material: Material): Promise<string> {
  const encrypted = new Uint8Array(aessiv(material.siv).encrypt(utf8(directoryId)));
  const hash = base32(await digest(encrypted, 'SHA-1'));
  return `d/${hash.slice(0,2)}/${hash.slice(2)}`;
}
export function decryptName(ciphertextName: string, directoryId: string, material: Material): string {
  const name = text(aessiv(material.siv, utf8(directoryId)).decrypt(fromBase64(ciphertextName)));
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new Error('Invalid decrypted filename.');
  return name;
}
export function validateName(name:string):string {
  const normalized=name.normalize('NFC'), bytes=utf8(normalized);
  if (!normalized || normalized === '.' || normalized === '..' || /[/\\\x00-\x1f\x7f]/.test(normalized) || text(bytes) !== normalized || bytes.length > 255) throw new Error('Invalid filename or filename longer than 255 UTF-8 bytes.');
  return normalized;
}
export const paddedBase64Url = (bytes:Bytes):string => toBase64(bytes).replace(/\+/g,'-').replace(/\//g,'_');
export function encryptName(name:string,directoryId:string,material:Material):string {
  return `${paddedBase64Url(aessiv(material.siv,utf8(directoryId)).encrypt(utf8(validateName(name))))}.c9r`;
}
export async function encryptHeader(material:Material):Promise<{ bytes:Bytes; header:FileHeader }> {
  const nonce=random(material.combo === 'SIV_GCM' ? 12 : 16), contentKey=random(32), payload=concat(new Uint8Array(8).fill(255),contentKey);
  try {
    const key=await crypto.subtle.importKey('raw',contentKey,material.combo === 'SIV_GCM' ? 'AES-GCM' : 'AES-CTR',false,['encrypt']);
    const encrypted=new Uint8Array(await crypto.subtle.encrypt(material.combo === 'SIV_GCM' ? { name:'AES-GCM',iv:nonce } : { name:'AES-CTR',counter:nonce,length:128 },material.enc,payload));
    const body=concat(nonce,encrypted);
    const bytes=material.combo === 'SIV_GCM' ? body : concat(body,new Uint8Array(await crypto.subtle.sign('HMAC',material.mac,body)));
    return { bytes,header:{ nonce,key } };
  } finally {contentKey.fill(0);payload.fill(0);}
}
export async function encryptChunk(bytes:Bytes,index:number,header:FileHeader,material:Material):Promise<Bytes> {
  if (!bytes.length || bytes.length > CLEAR_CHUNK) throw new Error('Invalid plaintext chunk length.');
  const nonce=random(material.combo === 'SIV_GCM' ? 12 : 16);
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt(material.combo === 'SIV_GCM' ? { name:'AES-GCM',iv:nonce,additionalData:concat(u64(index),header.nonce) } : { name:'AES-CTR',counter:nonce,length:128 },header.key,bytes));
  const body=concat(nonce,ciphertext);
  return material.combo === 'SIV_GCM' ? body : concat(body,new Uint8Array(await crypto.subtle.sign('HMAC',material.mac,concat(header.nonce,u64(index),body))));
}
export function cleartextSize(encryptedSize: number, combo: CipherCombo): number {
  const body = encryptedSize - headerSize(combo);
  if (!Number.isSafeInteger(encryptedSize) || body < 0) throw new Error('Truncated encrypted file header.');
  const overhead = chunkOverhead(combo), full = CLEAR_CHUNK + overhead;
  const remainder = body % full;
  if (remainder > 0 && remainder <= overhead) throw new Error('Truncated encrypted file chunk.');
  return Math.floor(body / full) * CLEAR_CHUNK + (remainder ? remainder - overhead : 0);
}
export async function decryptHeader(bytes: Bytes, material: Material): Promise<FileHeader> {
  if (bytes.length !== headerSize(material.combo)) throw new Error('Truncated encrypted file header.');
  const nonceLength = material.combo === 'SIV_GCM' ? 12 : 16;
  const nonce = bytes.slice(0, nonceLength);
  let payload: Bytes;
  try {
    if (material.combo === 'SIV_GCM') payload = new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM', iv:nonce }, material.enc, bytes.subarray(12)));
    else {
      if (!await crypto.subtle.verify('HMAC', material.mac, bytes.subarray(56), bytes.subarray(0,56))) throw new Error('Invalid header authentication.');
      payload = new Uint8Array(await crypto.subtle.decrypt({ name:'AES-CTR', counter:nonce, length:128 }, material.enc, bytes.subarray(16,56)));
    }
  } catch { throw new Error('File header authentication failed. The file may be damaged.'); }
  try {
    if (payload.length !== 40) throw new Error('Invalid file header payload.');
    const key = await crypto.subtle.importKey('raw', payload.subarray(8), material.combo === 'SIV_GCM' ? 'AES-GCM' : 'AES-CTR', false, ['decrypt']);
    return { nonce, key };
  } finally { payload.fill(0); }
}
export async function decryptChunk(bytes: Bytes, index: number, header: FileHeader, material: Material): Promise<Bytes> {
  const overhead = chunkOverhead(material.combo);
  if (bytes.length <= overhead || bytes.length > CLEAR_CHUNK + overhead) throw new Error('Truncated encrypted file chunk.');
  try {
    if (material.combo === 'SIV_GCM') {
      return new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM', iv:bytes.subarray(0,12), additionalData:concat(u64(index),header.nonce) }, header.key, bytes.subarray(12)));
    }
    const authenticated = concat(header.nonce, u64(index), bytes.subarray(0,-32));
    if (!await crypto.subtle.verify('HMAC', material.mac, bytes.subarray(-32), authenticated)) throw new Error('Invalid chunk authentication.');
    return new Uint8Array(await crypto.subtle.decrypt({ name:'AES-CTR', counter:bytes.subarray(0,16), length:128 }, header.key, bytes.subarray(16,-32)));
  } catch { throw new Error(`File chunk ${index + 1} failed authentication. The file may be damaged.`); }
}
export function destroyMaterial(material: Material): void { material.raw.fill(0); material.siv.fill(0); }

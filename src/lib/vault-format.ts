/** Format boundary: shared vault operations never infer a format from key sizes. */
import * as cm from './crypto';
import * as uvf from './uvf';
import {concat,random,toBase64Url,utf8,type Bytes} from './bytes';
export {parseConfiguration,parseMasterkey,unlockMasterkey,verifyConfiguration,verifyMasterkeyVersion,createMaterial,validateName,paddedBase64Url} from './crypto';
export type {ParsedConfiguration,MasterkeyFile,FileHeader} from './crypto';
export type Material=cm.Material|uvf.UvfMaterial;
type Combo=Material['combo'];
export const chunkSize=(combo:Combo)=>combo==='UVF'?uvf.UVF_CHUNK:cm.CLEAR_CHUNK;
export const headerSize=(combo:Combo)=>combo==='UVF'?68:cm.headerSize(combo);
export const chunkOverhead=(combo:Combo)=>combo==='UVF'?28:cm.chunkOverhead(combo);
export const cleartextSize=(size:number,combo:Combo)=>combo==='UVF'?uvf.uvfCleartextSize(size):cm.cleartextSize(size,combo);
export const destroyMaterial=(m:Material)=>m.combo==='UVF'?uvf.destroyUvf(m):cm.destroyMaterial(m);
export const directoryPath=(id:string,m:Material)=>m.combo==='UVF'?uvf.uvfDirectoryPath(uvf.uvfDirectory(m,id),m):cm.directoryPath(id,m);
export const encryptName=(name:string,parent:string,m:Material)=>m.combo==='UVF'?uvf.uvfName(name,parent,m):cm.encryptName(name,parent,m);
export const decryptName=(name:string,parent:string,m:Material)=>m.combo==='UVF'?uvf.uvfName(name,parent,m,true):cm.decryptName(name,parent,m);
export const encryptHeader=(m:Material)=>m.combo==='UVF'?uvf.uvfEncryptHeader(m):cm.encryptHeader(m);
export const decryptHeader=(bytes:Bytes,m:Material)=>m.combo==='UVF'?uvf.uvfDecryptHeader(bytes,m):cm.decryptHeader(bytes,m);
export const encryptChunk=(bytes:Bytes,index:number,h:cm.FileHeader,m:Material)=>m.combo==='UVF'?uvf.uvfEncryptChunk(bytes,index,h):cm.encryptChunk(bytes,index,h,m);
export const decryptChunk=(bytes:Bytes,index:number,h:cm.FileHeader,m:Material)=>m.combo==='UVF'?uvf.uvfDecryptChunk(bytes,index,h):cm.decryptChunk(bytes,index,h,m);
export const layout=(m:Material)=>m.combo==='UVF'?{extension:'.uvf',directory:'dir.uvf',backup:'dir.uvf',symlink:'symlink.uvf'}:{extension:'.c9r',directory:'dir.c9r',backup:'dirid.c9r',symlink:'symlink.c9r'};
export async function createDirectory(m:Material){
  if(m.combo==='UVF'){
    const dir={id:random(32),seedId:m.payload.latestSeed},path=await uvf.uvfDirectoryPath(dir,m);
    m.directories.set(path,dir);
    return {id:path,path,marker:await uvf.uvfSmallFile(dir.id,m),backup:await uvf.uvfSmallFile(dir.id,m),backupName:'dir.uvf'};
  }
  const id=crypto.randomUUID(),h=await cm.encryptHeader(m);
  return {id,path:await cm.directoryPath(id,m),marker:utf8(id),backup:concat(h.bytes,await cm.encryptChunk(utf8(id),0,h.header,m)),backupName:'dirid.c9r'};
}
export const sessionToken=()=>toBase64Url(random(16));

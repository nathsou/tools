import {sha256} from '@noble/hashes/sha2.js';
import type { VaultClient } from './client';
import { safePath } from './filesystem';
import type { ImportPlan } from './types';
export interface ImportResult { added:string[]; errors:string[]; }
export async function vaultWriteLock<T>(vaultId:string,signal:AbortSignal,run:()=>Promise<T>):Promise<T> {
  return navigator.locks ? navigator.locks.request(`crypte-import:${vaultId}`,{signal},run) : run();
}
export async function writePermission(handle:FileSystemDirectoryHandle):Promise<void> {
  if (await handle.queryPermission({mode:'readwrite'}) !== 'granted' && await handle.requestPermission({mode:'readwrite'}) !== 'granted') throw new Error('Write access was not granted. The vault has not been changed.');
}
async function exists(folder:FileSystemDirectoryHandle,name:string):Promise<boolean> {
  try {await folder.getFileHandle(name);return true;}
  catch(e) {if(e instanceof DOMException && e.name==='NotFoundError')return false;if(e instanceof DOMException && e.name==='TypeMismatchError')return true;throw e;}
}
async function parent(root:FileSystemDirectoryHandle,path:string) {
  const parts=safePath(path);let folder=root;
  for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part);
  return {folder,name:parts.at(-1)!};
}
/** Filesystem writes stay on the page so lock/cancel can abort and clean up after
 * the cryptographic worker has already been terminated. Only ciphertext is written. */
export interface ReadableFile {name:string;size:number;symlink?:boolean;read:(start:number,end:number)=>Promise<Uint8Array<ArrayBuffer>>;}
export async function addFile(root:FileSystemDirectoryHandle,client:VaultClient,file:File|ReadableFile,directoryId:string,signal:AbortSignal,progress:(written:number)=>void):Promise<string> {
  signal.throwIfAborted();
  const plan:ImportPlan=await (file instanceof File ? client.beginImport(file,directoryId) : client.beginReadableImport(file.name,file.size,directoryId,file.symlink));
  let folder:FileSystemDirectoryHandle|undefined, targetName='', temporary='', ownsTemporary=false, ownsTarget=false, committed=false;
  const expected=sha256.create();
  let writer:FileSystemWritableFileStream|undefined;
  const abort=()=>{if(writer)void writer.abort().catch(()=>{});};
  signal.addEventListener('abort',abort);
  try {
    ({folder,name:targetName}=await parent(root,plan.nodePath));signal.throwIfAborted();
    temporary=`.crypte-import-${plan.id}.tmp`;
    if(await exists(folder,temporary))throw new Error('Temporary import name is already in use.');
    const stage=await folder.getFileHandle(temporary,{create:true});ownsTemporary=true;
    writer=await stage.createWritable();signal.throwIfAborted();expected.update(plan.header);await writer.write(plan.header);
    for(let written=0;written<plan.size;) {
      signal.throwIfAborted();const encrypted=file instanceof File ? await client.importChunk(plan.id) : await client.importBytes(plan.id,await file.read(written,Math.min(plan.size,written+4*1024*1024)));
      signal.throwIfAborted();expected.update(encrypted);await writer.write(encrypted);
      written=Math.min(plan.size,written+4*1024*1024);progress(written);
    }
    const tail=await client.finalizeImport(plan.id);signal.throwIfAborted();expected.update(tail);await writer.write(tail);
    signal.throwIfAborted();await writer.close();writer=undefined;
    // Stage a complete encrypted file before publishing its Cryptomator entry.
    // Recheck immediately before creating the target; never open an existing file.
    if(await exists(folder,targetName))throw new Error('The destination changed during import. Refresh and try again.');
    signal.throwIfAborted();
    let destination:FileSystemFileHandle;
    if(plan.shortened||plan.payloadName) {
      const node=await folder.getDirectoryHandle(targetName,{create:true});ownsTarget=true;
      if(plan.shortened){const mapping=await(await node.getFileHandle('name.c9s',{create:true})).createWritable();
      try {signal.throwIfAborted();await mapping.write(plan.encryptedName);signal.throwIfAborted();await mapping.close();}
      catch(e){await mapping.abort().catch(()=>{});throw e;}}
      destination=await node.getFileHandle(plan.payloadName??'contents.c9r',{create:true});
    } else {destination=await folder.getFileHandle(targetName,{create:true});ownsTarget=true;}
    writer=await destination.createWritable({mode:'exclusive'} as FileSystemCreateWritableOptions);
    const encryptedFile=await stage.getFile();
    for(let offset=0;offset<encryptedFile.size;offset+=4*1024*1024) {
      signal.throwIfAborted();await writer.write(await encryptedFile.slice(offset,offset+4*1024*1024).arrayBuffer());
    }
    signal.throwIfAborted();await writer.close();writer=undefined;
    const hash=sha256.create();try{const published=await destination.getFile();for(let offset=0;offset<published.size;offset+=4*1024*1024){signal.throwIfAborted();hash.update(new Uint8Array(await published.slice(offset,offset+4*1024*1024).arrayBuffer()));}if(String(hash.digest())!==String(expected.digest()))throw new Error('The encrypted copy could not be verified. The original has been kept.');}finally{hash.destroy();}
    signal.throwIfAborted();committed=true;
    return plan.name;
  } finally {
    expected.destroy();signal.removeEventListener('abort',abort);
    if(writer)await writer.abort().catch(()=>{});
    let cleanupError:unknown;
    if(folder && ownsTarget && !committed)await folder.removeEntry(targetName,{recursive:true}).catch(e=>cleanupError=e);
    if(folder && ownsTemporary)await folder.removeEntry(temporary).catch(()=>{});
    await client.endImport(plan.id).catch(()=>{});
    if(cleanupError)throw new Error('Import cleanup failed. Refresh the folder and check the incomplete entry before retrying.');
  }
}
export async function addFiles(root:FileSystemDirectoryHandle,client:VaultClient,files:File[],directoryId:string,vaultId:string,signal:AbortSignal,onProgress:(name:string,fraction:number)=>void):Promise<ImportResult> {
  await writePermission(root);signal.throwIfAborted();
  return vaultWriteLock(vaultId,signal,()=>addFilesUnlocked(root,client,files,directoryId,signal,onProgress));
}
export async function addFilesUnlocked(root:FileSystemDirectoryHandle,client:VaultClient,files:File[],directoryId:string,signal:AbortSignal,onProgress:(name:string,fraction:number)=>void):Promise<ImportResult> {
    const result:ImportResult={added:[],errors:[]};
    const total=files.reduce((sum,file)=>sum+Math.max(1,file.size),0);let completed=0;
    for(const file of files) {
      signal.throwIfAborted();onProgress(file.name,completed/total);
      try {result.added.push(await addFile(root,client,file,directoryId,signal,written=>onProgress(file.name,(completed+written)/total)));}
      catch(e){if(signal.aborted)throw e;result.errors.push(`${file.name}: ${e instanceof Error ? e.message : 'Unable to add this file.'}`);}
      completed+=Math.max(1,file.size);onProgress(file.name,completed/total);
    }
    return result;
}

import {removeCachedThumbnails} from './private-cache';
import { sha256 } from '@noble/hashes/sha2.js';
import { isFilesystemMetadata, safePath } from './filesystem';
import { vaultWriteLock,writePermission } from './imports';
import type { VaultClient } from './client';
import type { FileStamp,WriteOutcome,WritePlan,WriteRequest } from './types';

async function parent(root:FileSystemDirectoryHandle,path:string,create=false) {
  const parts=safePath(path);let folder=root;
  for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part,{create});
  return {folder,name:parts.at(-1)!};
}
async function exists(folder:FileSystemDirectoryHandle,name:string):Promise<boolean> {
  try {await folder.getFileHandle(name);return true;}
  catch(error){if(error instanceof DOMException && error.name==='TypeMismatchError')return true;if(error instanceof DOMException && error.name==='NotFoundError')return false;throw error;}
}
async function unchanged(root:FileSystemDirectoryHandle,plan:WritePlan):Promise<void> {
  for(const stamp of plan.sourceFiles) {
    const {folder,name}=await parent(root,stamp.path),file=await(await folder.getFileHandle(name)).getFile();
    if(file.size!==stamp.size || file.lastModified!==stamp.modified)throw new Error('The source changed during this operation. Refresh and try again.');
  }
  if(plan.sourcePath && plan.sourceFiles.every(file=>file.path!==plan.sourcePath)) {
    const {folder,name}=await parent(root,plan.sourcePath),node=await folder.getDirectoryHandle(name),names:string[]=[];
    for await(const [child,handle] of node.entries())if(!isFilesystemMetadata({name:child,kind:handle.kind}))names.push(child);
    if(names.length!==plan.sourceFiles.length || names.some(name=>!plan.sourceFiles.some(file=>file.path===`${plan.sourcePath}/${name}`)))throw new Error('The source entry changed during this operation.');
  }
}
async function checksum(file:File,signal:AbortSignal):Promise<string> {
  const hash=sha256.create();
  try {for(let offset=0;offset<file.size;offset+=4*1024*1024){signal.throwIfAborted();hash.update(new Uint8Array(await file.slice(offset,offset+4*1024*1024).arrayBuffer()));}return Array.from(hash.digest(),byte=>byte.toString(16).padStart(2,'0')).join('');}
  finally {hash.destroy();}
}
/** Only ciphertext and format-defined directory metadata are copied to disk.
 * The source survives until the complete destination has been verified. */
export async function executeWriteUnlocked(root:FileSystemDirectoryHandle,client:VaultClient,request:WriteRequest,signal:AbortSignal):Promise<WriteOutcome> {
  signal.throwIfAborted();const plan=await client.planWrite(request),warnings:string[]=[];
  let ownsTarget=false,ownsFolder=false,commitStarted=false,committed=false;
  let writer:FileSystemWritableFileStream|undefined;
  const abort=()=>{if(writer)void writer.abort().catch(()=>{});};signal.addEventListener('abort',abort);
  async function write(handle:FileSystemFileHandle,data:Uint8Array<ArrayBuffer>) {
    writer=await handle.createWritable({mode:'exclusive'} as FileSystemCreateWritableOptions);signal.throwIfAborted();await writer.write(data);signal.throwIfAborted();await writer.close();writer=undefined;
  }
  async function copy(stamp:FileStamp,destination:FileSystemFileHandle) {
    const source=await parent(root,stamp.path),file=await(await source.folder.getFileHandle(source.name)).getFile();
    writer=await destination.createWritable({mode:'exclusive'} as FileSystemCreateWritableOptions);
    const hash=sha256.create();let expected='';
    try {
      for(let offset=0;offset<file.size;offset+=4*1024*1024){signal.throwIfAborted();const bytes=new Uint8Array(await file.slice(offset,offset+4*1024*1024).arrayBuffer());hash.update(bytes);await writer.write(bytes);}
      signal.throwIfAborted();await writer.close();writer=undefined;expected=Array.from(hash.digest(),byte=>byte.toString(16).padStart(2,'0')).join('');
    } finally {hash.destroy();}
    const copied=await destination.getFile();if(copied.size!==file.size || await checksum(copied,signal)!==expected)throw new Error('The encrypted copy could not be verified. The original has been kept.');
    const fresh=await(await source.folder.getFileHandle(source.name)).getFile();
    if(await checksum(fresh,signal)!==expected)throw new Error('The source changed while copying. The original has been kept.');
  }
  try {
    signal.throwIfAborted();await unchanged(root,plan);
    if(plan.noop){committed=true;return {plan,warnings};}
    if(request.kind==='delete') {
      signal.throwIfAborted();const source=await parent(root,plan.sourcePath!);
      // Unlink first. From this commit point, finish cleanup even if the vault locks.
      commitStarted=true;await source.folder.removeEntry(source.name,{recursive:true});committed=true;
      for(const directory of plan.removedFolders) {
        try {const content=await parent(root,directory.path);await content.folder.removeEntry(content.name,{recursive:true});}
        catch(error){warnings.push(`Some encrypted folder data could not be removed: ${error instanceof Error?error.message:'filesystem cleanup failed'}`);}
      }
      try{await removeCachedThumbnails(root,plan);}catch{warnings.push("Some cached thumbnails could not be removed.");}
      return {plan,warnings};
    }
    const target=plan.target!,destination=await parent(root,target.path);
    if(await exists(destination.folder,destination.name))throw new Error('The destination changed. No existing item was replaced.');
    if(plan.createdFolder) {
      const content=await parent(root,plan.createdFolder.path,true);
      if(await exists(content.folder,content.name))throw new Error('The new folder storage already exists. Try again.');
      const directory=await content.folder.getDirectoryHandle(content.name,{create:true});ownsFolder=true;
      await write(await directory.getFileHandle(plan.createdFolder.backupName??'dirid.c9r',{create:true}),plan.createdFolder.backup);
      signal.throwIfAborted();
      if(await exists(destination.folder,destination.name))throw new Error('The destination changed. No existing item was replaced.');
    }
    let payload:FileSystemFileHandle;
    if(target.directory) {
      const node=await destination.folder.getDirectoryHandle(destination.name,{create:true});ownsTarget=true;
      if(target.mapping)await write(await node.getFileHandle('name.c9s',{create:true}),new TextEncoder().encode(target.mapping));
      payload=await node.getFileHandle(target.payloadName,{create:true});
    } else {payload=await destination.folder.getFileHandle(destination.name,{create:true});ownsTarget=true;}
    if(plan.createdFolder)await write(payload,plan.createdFolder.marker);
    else {
      const stamp=plan.sourceFiles.find(file=>!file.path.endsWith('/name.c9s'))!;await copy(stamp,payload);
      await unchanged(root,plan);signal.throwIfAborted();
      const source=await parent(root,plan.sourcePath!);
      // Once source removal starts, the verified destination must never be rolled back.
      commitStarted=true;await source.folder.removeEntry(source.name,{recursive:true});
    }
    committed=true;if(request.kind==='move'){try{await removeCachedThumbnails(root,plan);}catch{warnings.push("Some cached thumbnails could not be removed.");}}return {plan,warnings};
  } catch(error) {
    if(commitStarted && request.kind==='move')throw new Error(`The verified destination has been kept, but removing the source failed. Refresh both folders before retrying. ${error instanceof Error?error.message:''}`);
    throw error;
  } finally {
    signal.removeEventListener('abort',abort);if(writer)await writer.abort().catch(()=>{});
    let cleanupError:unknown;
    if(!committed && !commitStarted) {
      if(ownsTarget && plan.target){const target=await parent(root,plan.target.path);await target.folder.removeEntry(target.name,{recursive:true}).catch(error=>cleanupError=error);}
      if(ownsFolder && plan.createdFolder){const content=await parent(root,plan.createdFolder.path);await content.folder.removeEntry(content.name,{recursive:true}).catch(error=>cleanupError=error);}
    }
    await client.finishWrite(plan.id,committed).catch(()=>{});
    if(cleanupError)throw new Error('Cleanup could not remove an incomplete encrypted entry. Refresh the folder before retrying.');
  }
}
export async function executeWrite(root:FileSystemDirectoryHandle,client:VaultClient,request:WriteRequest,vaultId:string,signal:AbortSignal):Promise<WriteOutcome> {
  await writePermission(root);signal.throwIfAborted();return vaultWriteLock(vaultId,signal,()=>executeWriteUnlocked(root,client,request,signal));
}

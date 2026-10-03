import {digest,utf8,toBase64Url,type Bytes} from './bytes';
import type {VaultClient} from './client';
import type {VaultEntry,WritePlan} from './types';
import {safePath} from './filesystem';
import {vaultWriteLock} from './imports';
export const CACHE_FOLDER='.crype_cache';
const opaque=async(value:string)=>toBase64Url(await digest(utf8(value)));
const group=async(path:string)=>opaque(safePath(path).slice(0,3).join('/'));
const filename=async(path:string)=>(await opaque(path))+'.thumb';
const binding=(entry:VaultEntry)=>JSON.stringify(['thumbnail-v1',entry.id,entry.size,entry.modified]);
async function folder(root:FileSystemDirectoryHandle,path:string,create=false){let directory=root;for(const part of safePath(path))directory=await directory.getDirectoryHandle(part,{create});return directory;}
async function sourceFile(root:FileSystemDirectoryHandle,path:string){const parts=safePath(path),directory=await folder(root,parts.slice(0,-1).join('/'));return(await directory.getFileHandle(parts.at(-1)!)).getFile();}
export class PrivateThumbnailCache {
  constructor(private root:FileSystemDirectoryHandle,private client:VaultClient,private vaultId:string){}
  async get(entry:VaultEntry,signal:AbortSignal):Promise<Blob|undefined>{
    try {signal.throwIfAborted();const directory=await folder(this.root,`${CACHE_FOLDER}/v1/${await group(entry.path)}`),file=await(await directory.getFileHandle(await filename(entry.path))).getFile();
      if(file.size>1024*1024)return;const clear=await this.client.cacheCrypt(new Uint8Array(await file.arrayBuffer()),binding(entry),true);
      try{signal.throwIfAborted();return new Blob([clear],{type:'image/webp'});}finally{clear.fill(0);}
    }catch{signal.throwIfAborted();return;}
  }
  async put(entry:VaultEntry,blob:Blob,signal:AbortSignal):Promise<void>{
    if(blob.size>1024*1024)return;
    try {
      if(await this.root.queryPermission({mode:'readwrite'})!=='granted')return;
      const encrypted=await this.client.cacheCrypt(new Uint8Array(await blob.arrayBuffer()),binding(entry));signal.throwIfAborted();
      await vaultWriteLock(this.vaultId,signal,async()=>{
        signal.throwIfAborted();const fresh=await sourceFile(this.root,entry.path);if(fresh.lastModified!==entry.modified)return;
        const directory=await folder(this.root,`${CACHE_FOLDER}/v1/${await group(entry.path)}`,true),handle=await directory.getFileHandle(await filename(entry.path),{create:true});
        const writer=await handle.createWritable();try{signal.throwIfAborted();await writer.write(encrypted);signal.throwIfAborted();await writer.close();}catch(e){await writer.abort().catch(()=>{});throw e;}
      });
    }catch{signal.throwIfAborted();/* A private cache is optional, including on read-only disks. */}
  }
}
/** Called while the vault write lock is held, after a successful unlink. */
export async function removeCachedThumbnails(root:FileSystemDirectoryHandle,plan:WritePlan):Promise<void>{
  try{
    const cache=await folder(root,`${CACHE_FOLDER}/v1`);
    if(plan.entry){try{const directory=await cache.getDirectoryHandle(await group(plan.entry.path));await directory.removeEntry(await filename(plan.entry.path));}catch(e){if(!(e instanceof DOMException && e.name==='NotFoundError'))throw e;}}
    for(const directory of plan.removedFolders){try{await cache.removeEntry(await group(directory.path),{recursive:true});}catch(e){if(!(e instanceof DOMException && e.name==='NotFoundError'))throw e;}}
  }catch(e){if(!(e instanceof DOMException && e.name==='NotFoundError'))throw e;}
}
/** Random-access conversion spool. Only authenticated ciphertext reaches OPFS.
 * Each block has its own nonce and is bound to this random session and block index. */
export class EncryptedSpool {
  readonly id=crypto.randomUUID();size=0;private directory?:FileSystemDirectoryHandle;private disposed=false;
  constructor(private client:VaultClient,private signal:AbortSignal){}
  private readonly blockSize=256*1024;
  async init(){const root=await navigator.storage.getDirectory();this.signal.throwIfAborted();this.directory=await root.getDirectoryHandle(`crypte-conversion-${this.id}`,{create:true});}
  private async block(index:number):Promise<Bytes>{
    try{const file=await(await this.directory!.getFileHandle(String(index))).getFile();return await this.client.cacheCrypt(new Uint8Array(await file.arrayBuffer()),`conversion-v1:${this.id}:${index}`,true);}
    catch(e){if(e instanceof DOMException && e.name==='NotFoundError')return new Uint8Array(this.blockSize);throw e;}
  }
  async write(data:Bytes,position:number){
    this.signal.throwIfAborted();if(this.disposed)throw new Error('Conversion closed.');
    if(!Number.isSafeInteger(position)||position<0||!Number.isSafeInteger(position+data.length))throw new Error('Invalid conversion offset.');
    for(let offset=0;offset<data.length;){this.signal.throwIfAborted();const absolute=position+offset,index=Math.floor(absolute/this.blockSize),within=absolute%this.blockSize,count=Math.min(data.length-offset,this.blockSize-within),clear=await this.block(index);
      try {clear.set(data.subarray(offset,offset+count),within);const encrypted=await this.client.cacheCrypt(clear,`conversion-v1:${this.id}:${index}`);this.signal.throwIfAborted();const handle=await this.directory!.getFileHandle(String(index),{create:true}),writer=await handle.createWritable();
        try{await writer.write(encrypted);this.signal.throwIfAborted();await writer.close();}catch(e){await writer.abort().catch(()=>{});throw e;}
      }finally{if(clear.byteLength)clear.fill(0);}offset+=count;
    }
    this.size=Math.max(this.size,position+data.length);
  }
  async read(start:number,end:number):Promise<Bytes>{
    this.signal.throwIfAborted();if(this.disposed)throw new Error('Conversion closed.');if(start<0||end<start||end>this.size||end-start>8*1024*1024)throw new Error('Invalid conversion range.');
    const result=new Uint8Array(end-start);
    try{for(let offset=start;offset<end;){const index=Math.floor(offset/this.blockSize),within=offset%this.blockSize,count=Math.min(end-offset,this.blockSize-within),clear=await this.block(index);try{this.signal.throwIfAborted();result.set(clear.subarray(within,within+count),offset-start);}finally{clear.fill(0);}offset+=count;}return result;}catch(e){result.fill(0);throw e;}
  }
  async dispose(){this.disposed=true;const root=await navigator.storage.getDirectory();await root.removeEntry(`crypte-conversion-${this.id}`,{recursive:true}).catch(()=>{});}
}

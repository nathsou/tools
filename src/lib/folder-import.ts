import { safePath } from './filesystem';
import { addFilesUnlocked,vaultWriteLock,writePermission,type ImportResult } from './imports';
import { executeWriteUnlocked } from './writes';
import { validateName } from './crypto';
import type { VaultClient } from './client';
export interface FolderItem {path:string;file?:File;}
export async function readFolder(handle:FileSystemDirectoryHandle,vaultRoot:FileSystemDirectoryHandle,signal?:AbortSignal):Promise<FolderItem[]> {
  const items:FolderItem[]=[];
  async function walk(folder:FileSystemDirectoryHandle,path:string,depth:number) {
    signal?.throwIfAborted();
    if(depth>128 || items.length>100000)throw new Error('This folder is too large or deeply nested to import.');
    if(await folder.isSameEntry(vaultRoot))throw new Error('Choose a source folder outside the encrypted vault.');
    items.push({path});
    for await(const [name,child] of folder.entries()) {
      signal?.throwIfAborted();if(items.length>=100000)throw new Error('This folder contains too many items to import.');
      const childPath=`${path}/${name}`;
      if(child.kind==='directory')await walk(child as FileSystemDirectoryHandle,childPath,depth+1);
      else items.push({path:childPath,file:await(child as FileSystemFileHandle).getFile()});
    }
  }
  await walk(handle,handle.name,0);return items;
}
export async function addFolder(root:FileSystemDirectoryHandle,client:VaultClient,items:FolderItem[],parentId:string,vaultId:string,signal:AbortSignal,onProgress:(name:string,fraction:number)=>void):Promise<ImportResult> {
  // Validate the complete source tree before creating anything in the vault.
  if(items.length>100000)throw new Error('This folder contains too many items to import.');
  for(const item of items){const parts=safePath(item.path);if(parts.length>129)throw new Error('The source folder is too deeply nested.');for(const name of parts)validateName(name);}
  await writePermission(root);signal.throwIfAborted();
  return vaultWriteLock(vaultId,signal,async()=>{
    const folders=new Map<string,string>([['',parentId]]),result:ImportResult={added:[],errors:[]};
    const total=items.reduce((sum,item)=>sum+(item.file?Math.max(1,item.file.size):0),0);let completed=0;
    async function ensure(path:string):Promise<string> {
      signal.throwIfAborted();const known=folders.get(path);if(known!==undefined)return known;
      const parts=safePath(path),name=parts.pop()!,parent=await ensure(parts.join('/'));
      const listing=await client.list(parent),entry=listing.entries.find(entry=>entry.name.normalize('NFC').toLowerCase()===name.normalize('NFC').toLowerCase());
      let id:string;
      if(entry){if(entry.kind!=='folder')throw new Error(`“${name}” already exists as a file. Rename it or the source folder first.`);id=entry.directoryId!;}
      else {const outcome=await executeWriteUnlocked(root,client,{kind:'mkdir',parentId:parent,name},signal);id=outcome.plan.createdFolder!.id;}
      folders.set(path,id);return id;
    }
    for(const item of items) {
      signal.throwIfAborted();
      if(!item.file){await ensure(item.path);continue;}
      const parts=safePath(item.path);parts.pop();const target=await ensure(parts.join('/'));
      const imported=await addFilesUnlocked(root,client,[item.file],target,signal,(_name,fraction)=>onProgress(item.path,total?(completed+fraction*Math.max(1,item.file!.size))/total:1));
      result.added.push(...imported.added);result.errors.push(...imported.errors);completed+=Math.max(1,item.file.size);
    }
    onProgress('',1);return result;
  });
}

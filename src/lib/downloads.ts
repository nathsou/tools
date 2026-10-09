import type {VaultClient} from './client';
import type {VaultEntry} from './types';

export interface DownloadProgress {stage:'preparing'|'downloading';completed:number;total:number;bytes:number;totalBytes:number;}
export interface DownloadOptions {signal?:AbortSignal;progress?:(value:DownloadProgress)=>void;}
type Reader=Pick<VaultClient,'list'|'read'>;
export interface ArchiveItem {path:string;entry:VaultEntry;}
const BATCH=4*1024*1024, MEMORY_LIMIT=128*1024*1024, ZIP_LIMIT=0xffffffff;
const encoder=new TextEncoder();
function safeName(name:string):void {
  if(!name||name==='.'||name==='..'||/[\\/:\x00-\x1f\x7f]/.test(name)||/[. ]$/.test(name))throw new Error(`Cannot download unsafe or non-portable name: ${JSON.stringify(name)}.`);
}
function check(options:DownloadOptions){options.signal?.throwIfAborted();}
export async function folderInventory(client:Reader,root:VaultEntry,options:DownloadOptions={}):Promise<ArchiveItem[]> {
  if(root.kind!=='folder'||root.directoryId===undefined)throw new Error('Choose a folder to download.');
  const items:ArchiveItem[]=[],seen=new Set<string>(),names=new Set<string>();let bytes=0;
  const queue=[{entry:root,parent:'',depth:0}];
  for(let index=0;index<queue.length;index++){
    check(options);const {entry,parent,depth}=queue[index];safeName(entry.name);
    if(depth>128||items.length>=65534)throw new Error('This folder is too large or deeply nested for a ZIP download.');
    const path=parent+entry.name+(entry.kind==='folder'?'/':'');
    const key=path.replace(/\/$/,'').normalize('NFC').toLowerCase();
    if(names.has(key))throw new Error(`Ambiguous archive name: ${JSON.stringify(path)}.`);names.add(key);items.push({path,entry});
    if(entry.kind==='folder'){
      if(entry.directoryId===undefined||seen.has(entry.directoryId))throw new Error('The folder contains a duplicate or cyclic directory.');seen.add(entry.directoryId);
      const listing=await client.list(entry.directoryId);check(options);
      if(listing.warnings.length)throw new Error(`Cannot download the complete folder: ${listing.warnings.join(' ')}`);
      for(const child of listing.entries)queue.push({entry:child,parent:path,depth:depth+1});
      if(queue.length>65534)throw new Error('A ZIP download supports at most 65,534 entries.');
    }else bytes+=entry.size;
    options.progress?.({stage:'preparing',completed:items.length,total:0,bytes:0,totalBytes:bytes});
  }
  archiveSize(items);return items;
}
export function archiveSize(items:ArchiveItem[]):number {
  if(items.length>65534)throw new Error('Too many ZIP entries.');
  let size=22;
  for(const {path,entry} of items){
    const parts=path.replace(/\/$/,'').split('/');for(const part of parts)safeName(part);
    const length=encoder.encode(path).length;
    if(length>65535||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>=ZIP_LIMIT)throw new Error('A file exceeds the ZIP download limits.');
    size+=30+length+(entry.kind==='folder'?0:entry.size)+16+46+length;
  }
  if(size>=ZIP_LIMIT)throw new Error('Folder ZIP downloads must be smaller than 4 GiB. Download smaller subfolders separately.');
  return size;
}
const crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crcUpdate(crc:number,bytes:Uint8Array):number {for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return crc;}
function record(length:number,signature:number){const bytes=new Uint8Array(length),view=new DataView(bytes.buffer);view.setUint32(0,signature,true);return {bytes,view};}
/** ZIP STORE with UTF-8 paths and data descriptors; payload memory stays bounded. */
export async function* zipChunks(client:Reader,items:ArchiveItem[],options:DownloadOptions={}):AsyncGenerator<Uint8Array<ArrayBuffer>> {
  archiveSize(items);const central:Uint8Array<ArrayBuffer>[]=[],totalBytes=items.reduce((sum,i)=>sum+(i.entry.kind==='folder'?0:i.entry.size),0);
  let offset=0,completed=0,bytesRead=0;
  for(const {path,entry} of items){
    check(options);const name=encoder.encode(path),size=entry.kind==='folder'?0:entry.size;
    const local=record(30+name.length,0x04034b50);local.view.setUint16(4,20,true);local.view.setUint16(6,0x808,true);local.view.setUint16(12,33,true);local.view.setUint16(26,name.length,true);local.bytes.set(name,30);
    const start=offset;offset+=local.bytes.length;yield local.bytes;let crc=0xffffffff;
    if(entry.kind!=='folder'){
      if(!size){await client.read(entry,0,0);check(options);}
      for(let position=0;position<size;position+=BATCH){
        check(options);const bytes=await client.read(entry,position,Math.min(size,position+BATCH));
        try{check(options);if(bytes.length!==Math.min(BATCH,size-position))throw new Error('A file changed during download.');crc=crcUpdate(crc,bytes);offset+=bytes.length;bytesRead+=bytes.length;yield bytes;}
        finally{bytes.fill(0);}
        check(options);options.progress?.({stage:'downloading',completed,total:items.length,bytes:bytesRead,totalBytes});
      }
    }
    crc=(crc^0xffffffff)>>>0;
    const descriptor=record(16,0x08074b50);descriptor.view.setUint32(4,crc,true);descriptor.view.setUint32(8,size,true);descriptor.view.setUint32(12,size,true);offset+=16;yield descriptor.bytes;
    const directory=record(46+name.length,0x02014b50),v=directory.view;v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint16(8,0x808,true);v.setUint16(14,33,true);v.setUint32(16,crc,true);v.setUint32(20,size,true);v.setUint32(24,size,true);v.setUint16(28,name.length,true);v.setUint32(38,entry.kind==='folder'?0x10:0,true);v.setUint32(42,start,true);directory.bytes.set(name,46);central.push(directory.bytes);
    options.progress?.({stage:'downloading',completed:++completed,total:items.length,bytes:bytesRead,totalBytes});
  }
  const centralStart=offset;
  for(const bytes of central){check(options);offset+=bytes.length;yield bytes;}
  const end=record(22,0x06054b50);end.view.setUint16(8,items.length,true);end.view.setUint16(10,items.length,true);end.view.setUint32(12,offset-centralStart,true);end.view.setUint32(16,centralStart,true);check(options);yield end.bytes;
}
async function* fileChunks(client:Reader,entry:VaultEntry,options:DownloadOptions){
  if(!entry.size){await client.read(entry,0,0);check(options);}
  for(let start=0;start<entry.size;start+=BATCH){
    check(options);const bytes=await client.read(entry,start,Math.min(start+BATCH,entry.size));
    try{check(options);yield bytes;}finally{bytes.fill(0);}
    options.progress?.({stage:'downloading',completed:Math.min(start+BATCH,entry.size)===entry.size?1:0,total:1,bytes:Math.min(start+BATCH,entry.size),totalBytes:entry.size});
  }
}
export async function downloadEntry(client:Reader,entry:VaultEntry,options:DownloadOptions={}):Promise<void> {
  check(options);const folder=entry.kind==='folder',name=entry.name+(folder?'.zip':'');
  const picker=(window as Window&{showSaveFilePicker?:(options:{suggestedName:string})=>Promise<FileSystemFileHandle>}).showSaveFilePicker;
  // Request the save location while the click still grants transient activation.
  const handle=picker?await picker.call(window,{suggestedName:name}):undefined;check(options);
  const items=folder?await folderInventory(client,entry,options):undefined;
  const size=items?archiveSize(items):entry.size;
  if(!handle&&size>MEMORY_LIMIT)throw new Error('Downloads over 128 MiB require a browser with Save File support, such as desktop Chrome or Edge. Download smaller items instead.');
  options.progress?.({stage:'downloading',completed:0,total:items?.length??1,bytes:0,totalBytes:items?items.reduce((n,i)=>n+(i.entry.kind==='folder'?0:i.entry.size),0):entry.size});
  const chunks=items?zipChunks(client,items,options):fileChunks(client,entry,options);
  if(handle){
    const writable=await handle.createWritable();
    try{for await(const bytes of chunks){check(options);await writable.write(bytes);}check(options);await writable.close();}
    catch(error){await writable.abort().catch(()=>{});throw error;}
  }else{
    // Blob snapshots copy each chunk before the generator clears plaintext buffers.
    const parts:Blob[]=[];for await(const bytes of chunks){check(options);parts.push(new Blob([bytes]));}
    check(options);const blob=new Blob(parts,{type:folder?'application/zip':entry.mime||'application/octet-stream'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');
    try{anchor.href=url;anchor.download=name;anchor.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),30000);}
  }
}

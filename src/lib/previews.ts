import type { VaultClient } from './client';
import type { VaultEntry,WritePlan } from './types';
import {videoThumbnail} from './bunny';
import {PrivateThumbnailCache} from './private-cache';
import { decodeHeic,isHeic,nativeImage,checkDimensions } from './images';
import { ThumbnailCache } from './thumbnail-cache';
let thumbnailSession:{client:VaultClient;cache:ThumbnailCache;disk?:PrivateThumbnailCache}|undefined;
export function startThumbnailSession(client:VaultClient,root?:FileSystemDirectoryHandle,vaultId?:string):void {
  clearThumbnailCache();thumbnailSession={client,cache:new ThumbnailCache(),disk:root&&vaultId?new PrivateThumbnailCache(root,client,vaultId):undefined};
}
export function invalidateThumbnails(plan:WritePlan):void {
  if(!plan.entry)return;
  thumbnailSession?.cache.invalidate(key=>{const id=JSON.parse(key)[0] as string;return id===plan.entry!.id||plan.removedFolders.some(folder=>id.startsWith(folder.path+'/'));});
}
export function clearThumbnailCache():void {
  thumbnailSession?.cache.clear();thumbnailSession=undefined;
}
export function releaseThumbnail(url:string):void {
  if(thumbnailSession)thumbnailSession.cache.releaseURL(url);else URL.revokeObjectURL(url);
}
export const PREVIEW_LIMIT = 64 * 1024 * 1024;
export async function readBlob(client:VaultClient,entry:VaultEntry,limit=PREVIEW_LIMIT,signal?:AbortSignal):Promise<Blob> {
  if (entry.size > limit) throw new Error('This file is too large for an in-memory preview. You can export it instead.');
  const parts:Uint8Array<ArrayBuffer>[] = [];
  try {
    signal?.throwIfAborted();if (!entry.size) parts.push(await client.read(entry,0,0));
    for (let start=0; start<entry.size; start+=4*1024*1024) {signal?.throwIfAborted();parts.push(await client.read(entry,start,Math.min(start+4*1024*1024,entry.size)));}
    signal?.throwIfAborted();
    return new Blob(parts,{ type:entry.mime });
  } finally { for (const part of parts) part.fill(0); }
}
export async function exportFile(client:VaultClient,entry:VaultEntry):Promise<void> {
  const picker = (window as Window & { showSaveFilePicker?:(options:{ suggestedName:string })=>Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    const handle = await picker({ suggestedName:entry.name });
    const writable = await handle.createWritable();
    try {
      if (!entry.size) await client.read(entry,0,0);
      for (let start=0; start<entry.size; start+=4*1024*1024) {
        const bytes = await client.read(entry,start,Math.min(start+4*1024*1024,entry.size));
        try { await writable.write(bytes); } finally { bytes.fill(0); }
      }
      await writable.close();
    } catch (e) { await writable.abort(); throw e; }
    return;
  }
  // Bound fallback memory and authenticate before exposing a download.
  const blob = await readBlob(client,entry,128*1024*1024);
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = entry.name; anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
let thumbnailJobs = 0;
const thumbnailWaiters:(()=>void)[] = [];
async function acquire(signal:AbortSignal):Promise<void> {
  signal.throwIfAborted();
  if (thumbnailJobs < 2) { thumbnailJobs++; return; }
  await new Promise<void>((resolve,reject)=>{
    const next=()=>{signal.removeEventListener('abort',abort);resolve();};
    const abort=()=>{const index=thumbnailWaiters.indexOf(next);if(index>=0)thumbnailWaiters.splice(index,1);reject(new DOMException('Cancelled','AbortError'));};
    thumbnailWaiters.push(next);signal.addEventListener('abort',abort,{once:true});
  });
}
function release():void { const next = thumbnailWaiters.shift(); if (next) next(); else thumbnailJobs--; }
async function canvasBlob(image:CanvasImageSource,width:number,height:number,signal:AbortSignal):Promise<Blob> {
  signal.throwIfAborted();checkDimensions(width,height);
  const ratio=Math.min(1,480/Math.max(width,height)),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));
  try {
    canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);
    const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',0.8));signal.throwIfAborted();
    if(!blob)throw new Error('Unable to create thumbnail.');return blob;
  } finally{canvas.width=canvas.height=1;}
}
export async function thumbnail(client:VaultClient,entry:VaultEntry,callerSignal:AbortSignal,_streaming=false):Promise<string> {
  const session=thumbnailSession;
  if(!session || session.client!==client)throw new Error('The thumbnail session is locked.');
  const {cache}=session,signal=AbortSignal.any([callerSignal,cache.controller.signal]);
  const key=JSON.stringify([entry.id,entry.kind,entry.size,entry.modified]);
  signal.throwIfAborted();
  const cached=cache.get(key);if(cached)return cache.createURL(cached);
  await acquire(signal);
  try {
    signal.throwIfAborted();
    const ready=cache.get(key);if(ready)return cache.createURL(ready);
    const persisted=await session.disk?.get(entry,signal);if(persisted){cache.put(key,persisted);return cache.createURL(persisted);}
    let small:Blob;
    if(entry.kind==='video')small=await videoThumbnail(client,entry,signal);
    else {
      const blob=await readBlob(client,entry,24*1024*1024,signal);
      try{const native=await nativeImage(blob,signal);try{small=await canvasBlob(native.image,native.width,native.height,signal);}finally{native.close();}}
      catch(e){signal.throwIfAborted();if(!isHeic(entry))throw e;small=await decodeHeic(blob,480,signal);}
    }
    signal.throwIfAborted();await session.disk?.put(entry,small,signal);signal.throwIfAborted();cache.put(key,small);return cache.createURL(small);
  } finally { release(); }
}

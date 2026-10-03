import type { VaultEntry } from './types';
export const MAX_IMAGE_PIXELS=40_000_000;
export const isHeic=(entry:VaultEntry):boolean=>/^image\/hei[cf]/.test(entry.mime);
export function checkDimensions(width:number,height:number):void {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>MAX_IMAGE_PIXELS)throw new Error('Image exceeds the 40 megapixel preview limit. Export it to open in another app.');
}
export async function nativeImage(blob:Blob,signal:AbortSignal):Promise<{image:CanvasImageSource;width:number;height:number;close:()=>void}> {
  signal.throwIfAborted();
  try {
    const bitmap=await createImageBitmap(blob);
    try {signal.throwIfAborted();checkDimensions(bitmap.width,bitmap.height);}
    catch(e){bitmap.close();throw e;}
    return {image:bitmap,width:bitmap.width,height:bitmap.height,close:()=>bitmap.close()};
  } catch(e){if(signal.aborted)throw e;}
  // Safari can decode HEIC in <img> even when ImageBitmap decoding is unavailable.
  const image=new Image(),url=URL.createObjectURL(blob);
  const clear=()=>{image.removeAttribute('src');URL.revokeObjectURL(url);};
  signal.addEventListener('abort',clear,{once:true});
  try {
    image.src=url;await image.decode();signal.throwIfAborted();checkDimensions(image.naturalWidth,image.naturalHeight);
    return {image,width:image.naturalWidth,height:image.naturalHeight,close:clear};
  } catch(e){clear();throw e;}
  finally{signal.removeEventListener('abort',clear);}
}
export async function decodeHeic(blob:Blob,maxDimension:number,signal:AbortSignal):Promise<Blob> {
  signal.throwIfAborted();const bytes=await blob.arrayBuffer();signal.throwIfAborted();
  // A fresh worker makes decoder memory disposable on close, cancellation, or lock.
  const worker=new Worker(new URL('../image.worker.ts',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    const finish=(error?:Error,result?:Blob)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);worker.terminate();if(error)reject(error);else resolve(result!);};
    const abort=()=>finish(new DOMException('Cancelled','AbortError'));
    const timer=setTimeout(()=>finish(new Error('HEIC decoding timed out. Export this file to open it in another app.')),20000);
    signal.addEventListener('abort',abort,{once:true});
    worker.onerror=()=>finish(new Error('HEIC decoder could not start. Export this file to open it in another app.'));
    worker.onmessage=({data})=>finish(data.error?new Error(data.error):undefined,data.blob);
    try{worker.postMessage({bytes,maxDimension},[bytes]);}catch(e){finish(e instanceof Error?e:new Error('Unable to start HEIC decoding.'));}
  });
}
export async function imagePreview(blob:Blob,entry:VaultEntry,signal:AbortSignal):Promise<Blob> {
  if(!isHeic(entry))return blob;
  try{const native=await nativeImage(blob,signal);native.close();return blob;}
  catch(e){signal.throwIfAborted();return decodeHeic(blob,8192,signal);}
}

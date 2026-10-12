/** Saving generated files: streamed to disk with a save picker, or assembled in memory. */
export const MEMORY_LIMIT=128*1024*1024;
type Picker=(options:{suggestedName:string})=>Promise<FileSystemFileHandle>;
const picker=()=>typeof window==='undefined'?undefined:(window as Window&{showSaveFilePicker?:Picker}).showSaveFilePicker;
export const canStreamToDisk=()=>Boolean(picker());
/** Call directly from a click handler, before other awaits: the picker needs transient user activation.
 * Returns undefined when the browser only supports in-memory downloads. */
export async function chooseSaveTarget(suggestedName:string):Promise<FileSystemFileHandle|undefined> {
  const show=picker();
  return show?await show.call(window,{suggestedName}):undefined;
}
export async function* blobChunks(blob:Blob,signal?:AbortSignal,size=4*1024*1024):AsyncGenerator<Uint8Array<ArrayBuffer>> {
  for(let offset=0;offset<blob.size;offset+=size){signal?.throwIfAborted();yield new Uint8Array(await blob.slice(offset,offset+size).arrayBuffer());}
}
/** Writes chunks to the chosen file, or downloads them from memory. Nothing is kept if a chunk fails:
 * an aborted writable discards its swap file, and the in-memory download only starts at the end. */
export async function saveChunks(target:FileSystemFileHandle|undefined,name:string,mime:string,chunks:AsyncIterable<Uint8Array<ArrayBuffer>>,signal?:AbortSignal):Promise<void> {
  signal?.throwIfAborted();
  if(target){
    const writable=await target.createWritable();
    try{for await(const bytes of chunks){signal?.throwIfAborted();await writable.write(bytes);}signal?.throwIfAborted();await writable.close();}
    catch(error){await writable.abort().catch(()=>{});throw error;}
    return;
  }
  // Blob snapshots copy each chunk before generators wipe their buffers.
  const parts:Blob[]=[];let size=0;
  for await(const bytes of chunks){
    signal?.throwIfAborted();size+=bytes.length;
    if(size>MEMORY_LIMIT)throw new Error('Files over 128 MiB require a browser with Save File support, such as desktop Chrome or Edge.');
    parts.push(new Blob([bytes]));
  }
  signal?.throwIfAborted();
  const url=URL.createObjectURL(new Blob(parts,{type:mime||'application/octet-stream'})),anchor=document.createElement('a');
  try{anchor.href=url;anchor.download=name;anchor.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),30000);}
}

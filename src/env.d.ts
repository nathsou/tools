/// <reference types="vite/client" />
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  interface HeifImage {get_width():number;get_height():number;is_primary():boolean;free():void;display(data:ImageData,callback:(result:ImageData|null)=>void):void;}
  export default function factory(options?:{print:()=>void;printErr:()=>void}):Promise<{HeifDecoder:new()=>{decode(bytes:Uint8Array):HeifImage[]}}>;
}
interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}
interface Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;
}

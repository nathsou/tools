/** Private, bounded thumbnail storage for one unlocked vault session. */
export class ThumbnailCache {
  readonly controller=new AbortController();
  private blobs=new Map<string,Blob>();
  private urls=new Set<string>();
  private bytes=0;
  constructor(private maxBytes=16*1024*1024,private maxEntries=256) {}
  get(key:string):Blob|undefined {
    const blob=this.blobs.get(key);
    if(blob){this.blobs.delete(key);this.blobs.set(key,blob);}
    return blob;
  }
  put(key:string,blob:Blob):void {
    this.controller.signal.throwIfAborted();
    const previous=this.blobs.get(key);
    if(previous){this.bytes-=previous.size;this.blobs.delete(key);}
    if(blob.size>this.maxBytes || this.maxEntries<1)return;
    this.blobs.set(key,blob);this.bytes+=blob.size;
    while(this.bytes>this.maxBytes || this.blobs.size>this.maxEntries){
      const oldest=this.blobs.keys().next().value!;
      this.bytes-=this.blobs.get(oldest)!.size;this.blobs.delete(oldest);
    }
  }
  createURL(blob:Blob):string {
    this.controller.signal.throwIfAborted();
    const url=URL.createObjectURL(blob);this.urls.add(url);return url;
  }
  releaseURL(url:string):void {this.urls.delete(url);URL.revokeObjectURL(url);}
  invalidate(matches:(key:string)=>boolean):void {
    for(const [key,blob] of this.blobs)if(matches(key)){this.bytes-=blob.size;this.blobs.delete(key);}
  }
  clear():void {
    this.controller.abort();
    for(const url of this.urls)URL.revokeObjectURL(url);
    this.urls.clear();this.blobs.clear();this.bytes=0;
  }
}

import type { Bytes } from './bytes';
import type {VaultBootstrap} from './crypto';
import type { ImportPlan, Listing, PasskeyRecord, Source, VaultEntry, VaultInfo, WritePlan, WriteRequest,TextSnapshot,EditFingerprint,ReplacementPlan } from './types';
export class VaultClient {
  private worker: Worker;
  private sequence = 0;
  private closed = false;
  private pending = new Map<number,{ resolve:(v:any)=>void; reject:(e:Error)=>void; progress?:(p:number)=>void }>();
  constructor() {
    this.worker = new Worker(new URL('../vault.worker.ts',import.meta.url),{ type:'module' });
    this.worker.onmessage = ({ data }) => {
      const job = this.pending.get(data.id); if (!job) return;
      if ('progress' in data) { job.progress?.(data.progress); return; }
      this.pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
    };
    this.worker.onerror = () => this.close('The vault worker stopped. Unlock the vault again.');
  }
  private call<T>(action:string,args:unknown[],progress?:(p:number)=>void,transfer:Transferable[]=[]):Promise<T> {
    if (this.closed) return Promise.reject(new Error('The vault is locked.'));
    const id = ++this.sequence;
    return new Promise((resolve,reject) => {
      this.pending.set(id,{ resolve,reject,progress });
      try { this.worker.postMessage({ id, action, args },transfer); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  prepare(source:Source):Promise<VaultInfo> {
    // Copy plain records at the worker boundary: Svelte's state proxies cannot be structured-cloned.
    const plain:Source = source.type === 'handle' ? { type:'handle',handle:source.handle } : { type:'files',name:source.name,files:source.files.map(({ path,file })=>({ path,file })) };
    return this.call('prepare',[plain]);
  }
  unlock(password:string,progress?:(p:number)=>void):Promise<VaultInfo> { return this.call('unlock',[password],progress); }
  generate(password:string,progress?:(p:number)=>void):Promise<VaultBootstrap> {return this.call('generate',[password],progress);}
  list(id:string):Promise<Listing> { return this.call('list',[id]); }
  beginImport(file:File,directoryId:string):Promise<ImportPlan> {return this.call('begin-import',[file,directoryId]);}
  beginReadableImport(name:string,size:number,directoryId:string):Promise<ImportPlan> {return this.call('begin-readable-import',[name,size,directoryId]);}
  importBytes(id:string,bytes:Bytes):Promise<Bytes> {return this.call('import-chunk',[id,bytes],undefined,[bytes.buffer]);}
  cacheCrypt(bytes:Bytes,binding:string,open=false):Promise<Bytes> {return this.call('cache-crypt',[bytes,binding,open],undefined,[bytes.buffer]);}
  importChunk(id:string):Promise<Bytes> {return this.call('import-chunk',[id]);}
  endImport(id:string):Promise<void> {return this.call('end-import',[id]);}
  readText(entry:VaultEntry):Promise<TextSnapshot> {return this.call('read-text',[entry.id]);}
  beginReplacement(file:File,parentId:string,entry:VaultEntry,expected:EditFingerprint):Promise<ReplacementPlan> {return this.call('begin-replacement',[file,parentId,entry.id,{...expected}]);}
  planWrite(request:WriteRequest):Promise<WritePlan> {return this.call('plan-write',[{...request}]);}
  finishWrite(id:string,committed:boolean):Promise<void> {return this.call('finish-write',[id,committed]);}
  read(entry:VaultEntry,start=0,end=entry.size):Promise<Bytes> { return this.call('read',[entry.id,start,end]); }
  seal(prf:Bytes,record:Omit<PasskeyRecord,'iv'|'ciphertext'>):Promise<PasskeyRecord> { return this.call('seal',[prf,record],undefined,[prf.buffer]); }
  passkey(prf:Bytes,record:PasskeyRecord):Promise<VaultInfo> { return this.call('passkey',[prf,{ ...record }],undefined,[prf.buffer]); }
  close(message='The vault was locked.'):void {
    if (this.closed) return;
    this.closed = true; this.worker.terminate();
    for (const job of this.pending.values()) job.reject(new Error(message));
    this.pending.clear();
  }
}

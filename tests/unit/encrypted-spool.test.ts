import {test,expect} from 'bun:test';
import {EncryptedSpool} from '../../src/lib/private-cache';
import type {VaultClient} from '../../src/lib/client';
function directory(){
  const nodes=new Map<string,ReturnType<typeof directory>|Uint8Array>();
  return {
    nodes,
    async getDirectoryHandle(name:string,options?:{create?:boolean}):Promise<any>{
      if(!nodes.has(name)&&options?.create)nodes.set(name,directory());
      const node=nodes.get(name);if(!node||node instanceof Uint8Array)throw new DOMException('Missing','NotFoundError');return node;
    },
    async getFileHandle(name:string,options?:{create?:boolean}){
      if(!nodes.has(name)){if(!options?.create)throw new DOMException('Missing','NotFoundError');nodes.set(name,new Uint8Array());}
      return {
        async getFile(){return new File([nodes.get(name) as Uint8Array<ArrayBuffer>],name);},
        async createWritable(){return {async write(bytes:Uint8Array){nodes.set(name,bytes.slice());},async close(){},async abort(){}};}
      };
    },
    async removeEntry(name:string){nodes.delete(name);}
  };
}
test('conversion spooling preserves random writes across blocks, authenticates reads, and only persists ciphertext',async()=>{
  const root=directory();Object.defineProperty(navigator,'storage',{configurable:true,value:{getDirectory:async()=>root}});
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const client={async cacheCrypt(bytes:Uint8Array<ArrayBuffer>,binding:string,open=false){const iv=open?bytes.slice(0,12):crypto.getRandomValues(new Uint8Array(12));try{const result=new Uint8Array(await crypto.subtle[open?'decrypt':'encrypt']({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(binding)},key,open?bytes.subarray(12):bytes));if(open)return result;const packed=new Uint8Array(12+result.length);packed.set(iv);packed.set(result,12);return packed;}finally{bytes.fill(0);}}} as VaultClient;
  const abort=new AbortController(),spool=new EncryptedSpool(client,abort.signal);await spool.init();const original=new Uint8Array(800000).fill(71);await spool.write(original,0);await spool.write(new Uint8Array([1,2,3,4]),262142);const result=await spool.read(262140,262148);expect([...result]).toEqual([71,71,1,2,3,4,71,71]);expect(spool.size).toBe(800000);
  await spool.write(new Uint8Array([9,8]),900000);expect(spool.size).toBe(900002);expect([...await spool.read(899998,900002)]).toEqual([0,0,9,8]);
  const files=(await root.getDirectoryHandle(`crypte-conversion-${spool.id}`)).nodes as Map<string,Uint8Array>;expect(files.get('0')?.length).toBe(262144+28);expect(files.get('0')?.subarray(0,20)).not.toEqual(new Uint8Array(20).fill(71));files.get('0')![24]^=1;await expect(spool.read(0,1)).rejects.toThrow();
  abort.abort();await expect(spool.read(300000,300001)).rejects.toThrow();await spool.dispose();expect(root.nodes.size).toBe(0);
});

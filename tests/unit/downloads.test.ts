import {expect,test} from 'bun:test';
import {archiveSize,folderInventory,zipChunks,downloadEntry} from '../../src/lib/downloads';
import type {VaultEntry} from '../../src/lib/types';
const entry=(name:string,kind:VaultEntry['kind'],size=0):VaultEntry=>({id:name,path:name,name,kind,size,modified:0,mime:'text/plain',...(kind==='folder'?{directoryId:name}:{})});
function fixture(){
  const root=entry('Folder','folder'),empty=entry('Empty','folder'),nested=entry('Nested','folder');
  const contents=new Map([['.hidden',new TextEncoder().encode('123456789')],['café.txt',new TextEncoder().encode('Unicode 🌍')],['Empty.txt',new Uint8Array()],['Link',new TextEncoder().encode('../outside')],['Large.bin',new Uint8Array(4*1024*1024+7).fill(19)]]);
  const tree=new Map([['Folder',[empty,nested,...['.hidden','Empty.txt','Link','Large.bin'].map(name=>entry(name,name==='Link'?'symlink':'file',contents.get(name)!.length))]],['Empty',[]],['Nested',[entry('café.txt','text',contents.get('café.txt')!.length)]]]);
  const reads:string[]=[];
  const client={async list(id:string){return {entries:tree.get(id)!,warnings:[]};},async read(e:VaultEntry,a=0,b=e.size){reads.push(e.name);return contents.get(e.name)!.slice(a,b);}};
  return {root,tree,contents,client,reads};
}
async function archive(client:ReturnType<typeof fixture>['client'],items:Awaited<ReturnType<typeof folderInventory>>){
  const chunks:Uint8Array[]=[];for await(const chunk of zipChunks(client,items))chunks.push(chunk.slice());return Buffer.concat(chunks);
}
/** Read central directory records as an independent consumer, then locate stored payloads. */
function decode(bytes:Buffer){
  const end=bytes.length-22;expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  const records=new Map<string,{bytes:Buffer;crc:number;attributes:number}>();let cursor=bytes.readUInt32LE(end+16);
  for(let i=0;i<bytes.readUInt16LE(end+10);i++){
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);expect(bytes.readUInt16LE(cursor+10)).toBe(0);
    const length=bytes.readUInt16LE(cursor+28),name=bytes.subarray(cursor+46,cursor+46+length).toString('utf8'),local=bytes.readUInt32LE(cursor+42),size=bytes.readUInt32LE(cursor+24);
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);expect(bytes.readUInt16LE(local+6)&0x800).toBe(0x800);
    const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    records.set(name,{bytes:bytes.subarray(start,start+size),crc:bytes.readUInt32LE(cursor+16),attributes:bytes.readUInt32LE(cursor+38)});
    expect(bytes.readUInt32LE(start+size)).toBe(0x08074b50);
    cursor+=46+length+bytes.readUInt16LE(cursor+30)+bytes.readUInt16LE(cursor+32);
  }
  expect(cursor).toBe(end);return records;
}
test('folder ZIP preserves hidden/nested/Unicode/empty content and never creates symlinks',async()=>{
  const f=fixture(),items=await folderInventory(f.client,f.root),bytes=await archive(f.client,items),files=decode(bytes);
  expect(bytes.length).toBe(archiveSize(items));expect(files.has('Folder/Empty/')).toBe(true);expect(files.get('Folder/.hidden')!.crc).toBe(0xcbf43926);
  for(const [name,content] of f.contents)expect(files.get(name==='café.txt'?`Folder/Nested/${name}`:`Folder/${name}`)!.bytes).toEqual(Buffer.from(content));
  expect(files.get('Folder/Link')!.attributes).toBe(0);expect(f.reads).toContain('Empty.txt');
});
test('unsafe names, listing errors, cycles and ambiguous paths fail instead of producing partial archives',async()=>{
  for(const name of ['../escape','a/b','a\\b','a:b','..']){const f=fixture();f.root.name=name;await expect(folderInventory(f.client,f.root)).rejects.toThrow();}
  const f=fixture();f.tree.get('Folder')!.push(f.root);await expect(folderInventory(f.client,f.root)).rejects.toThrow('cyclic');
  const g=fixture();g.tree.get('Folder')!.push(entry('.HIDDEN','file'));await expect(folderInventory(g.client,g.root)).rejects.toThrow('Ambiguous');
  await expect(folderInventory({...g.client,async list(){return {entries:[],warnings:['Corrupt folder']};}},g.root)).rejects.toThrow('Corrupt folder');
});
test('ZIP enforces size limits before reading content',()=>{
  expect(()=>archiveSize([{path:'huge',entry:entry('huge','file',0xffffffff)}])).toThrow('limits');
  expect(()=>archiveSize([{path:'huge',entry:entry('huge','file',0xfffffffe)}])).toThrow('4 GiB');
});
test('cancellation and authentication failures stop ZIP creation, including empty files',async()=>{
  const f=fixture(),items=await folderInventory(f.client,f.root),controller=new AbortController();let finished=false;
  await expect((async()=>{for await(const bytes of zipChunks(f.client,items,{signal:controller.signal,progress(p){if(p.bytes>0)controller.abort();}})){void bytes;}finished=true;})()).rejects.toThrow();expect(finished).toBe(false);
  const empty=items.filter(i=>i.entry.name==='Empty.txt');await expect(archive({...f.client,async read(){throw new Error('Authentication failed');}},empty)).rejects.toThrow('Authentication');
});

test('oversized fallback downloads fail before decrypting payloads',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{value:{},configurable:true});
  try{const f=fixture();await expect(downloadEntry(f.client,entry('Large.bin','file',129*1024*1024))).rejects.toThrow('128 MiB');expect(f.reads).toEqual([]);}
  finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});

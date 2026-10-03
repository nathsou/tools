import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {Vault} from '../../src/lib/vault';
import {concat,utf8,text} from '../../src/lib/bytes';
import {decryptReference} from '../../scripts/reference-decrypt';
import type {Source} from '../../src/lib/types';
async function unlocked(name='gcm'){
  const root=`tests/fixtures/${name}`,paths:string[]=JSON.parse(await readFile(`${root}/index.json`,'utf8'));
  const source:Source={type:'files',name,files:await Promise.all(paths.map(async path=>({path,file:new File([await readFile(`${root}/${path}`)],path.split('/').at(-1)!,{lastModified:1234})})))},vault=new Vault(source);await vault.prepare();await vault.unlock('crypte-demo');return vault;
}
test('cache encryption uses fresh nonces, authenticates its binding and bytes, and requires an unlocked vault',async()=>{
  const vault=await unlocked(),binding='thumbnail-v1:opaque-path:1234',a=await vault.cacheCrypt(utf8('private thumbnail'),binding),b=await vault.cacheCrypt(utf8('private thumbnail'),binding);
  expect(a).not.toEqual(b);expect(Buffer.from(a).toString()).not.toContain('private thumbnail');expect(text(await vault.cacheCrypt(a.slice(),binding,true))).toBe('private thumbnail');
  await expect(vault.cacheCrypt(a.slice(),binding+'changed',true)).rejects.toThrow();const corrupted=a.slice();corrupted[15]^=1;await expect(vault.cacheCrypt(corrupted,binding,true)).rejects.toThrow();
  vault.lock();await expect(vault.cacheCrypt(a.slice(),binding,true)).rejects.toThrow('locked');await vault.unlock('crypte-demo');expect(text(await vault.cacheCrypt(a.slice(),binding,true))).toBe('private thumbnail');
});
for(const cipher of ['gcm','ctr','legacy'])test(`${cipher}: streamed conversion imports encrypt bytes independently and reject truncated streams`,async()=>{
  const vault=await unlocked(cipher),source=utf8('converted media '.repeat(400000)),plan=await vault.beginReadableImport('converted.webm',source.length,'');
  const chunks=[plan.header];for(let offset=0;offset<source.length;offset+=4*1024*1024)chunks.push(await vault.importChunk(plan.id,source.slice(offset,offset+4*1024*1024)));vault.endImport(plan.id);
  const raw=Buffer.from([...Array.from({length:32},(_,i)=>i+1),...Array.from({length:32},(_,i)=>128+i)]);expect(decryptReference(Buffer.from(concat(...chunks)),raw,cipher==='gcm'?'SIV_GCM':'SIV_CTRMAC')).toEqual(Buffer.from(source));
  const short=await vault.beginReadableImport('short.webm',100,'');await expect(vault.importChunk(short.id,new Uint8Array(90))).rejects.toThrow('source file changed');vault.endImport(short.id);
});

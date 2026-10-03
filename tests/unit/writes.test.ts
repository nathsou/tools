import {describe,test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {Vault} from '../../src/lib/vault';
import {decryptReference} from '../../scripts/reference-decrypt';
import {referenceSiv} from '../../scripts/reference-siv';
import type {Source} from '../../src/lib/types';
const raw=Buffer.concat([Buffer.from(Array.from({length:32},(_,index)=>index+1)),Buffer.from(Array.from({length:32},(_,index)=>index+128))]);
async function source(name:string):Promise<Extract<Source,{type:'files'}>> {
  const paths:string[]=JSON.parse(await readFile(`tests/fixtures/${name}/index.json`,'utf8'));
  return {type:'files',name,files:await Promise.all(paths.map(async path=>({path,file:new File([await readFile(`tests/fixtures/${name}/${path}`)],path.split('/').at(-1)!)})))};
}
async function open(input:Source){const vault=new Vault(input);await vault.prepare();await vault.unlock('crypte-demo');return vault;}
for(const fixture of ['gcm','ctr','legacy'])describe(`${fixture} write plans`,()=>{
  test('new folders have UUID markers, independent encrypted backups and shortened mappings',async()=>{
    const vault=await open(await source(fixture)),name='Long folder '+ 'x'.repeat(200);
    const plan=await vault.planWrite({kind:'mkdir',parentId:'',name});
    expect(plan.target!.path).toEndWith('.c9s');expect(plan.createdFolder!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new TextDecoder().decode(plan.createdFolder!.marker)).toBe(plan.createdFolder!.id);
    expect(decryptReference(Buffer.from(plan.createdFolder!.backup),raw,fixture==='gcm'?'SIV_GCM':'SIV_CTRMAC').toString()).toBe(plan.createdFolder!.id);
    const cipherName=plan.target!.mapping!.slice(0,-4).replace(/-/g,'+').replace(/_/g,'/');
    expect(referenceSiv(Buffer.concat([raw.subarray(32),raw.subarray(0,32)]),Buffer.from(name),Buffer.alloc(0))).toEqual(Buffer.from(cipherName,'base64'));
    await expect(vault.planWrite({kind:'mkdir',parentId:'',name:'Other'})).rejects.toThrow('Another vault write');
    vault.finishWrite(plan.id,false);vault.lock();
  });
  test('move plans bind names to the destination and preserve content locations',async()=>{
    const vault=await open(await source(fixture)),root=(await vault.list('')).entries,file=root.find(entry=>entry.name==='Field notes.txt')!,folder=root.find(entry=>entry.name==='Words & thoughts')!;
    const plan=await vault.planWrite({kind:'move',parentId:'',entryId:file.id,targetId:folder.directoryId!,name:file.name});
    expect(plan.sourcePath).toBe(file.path);expect(plan.target!.path).not.toBe(file.path);expect(plan.target!.directory).toBe(false);
    const cipher=referenceSiv(Buffer.concat([raw.subarray(32),raw.subarray(0,32)]),Buffer.from(file.name),Buffer.from(folder.directoryId!)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_')+'.c9r';
    expect(plan.target!.path).toEndWith(cipher);vault.finishWrite(plan.id,false);vault.lock();
  });
  test('collisions, invalid names, unknown entries and self moves leave no write plan',async()=>{
    const vault=await open(await source(fixture)),root=(await vault.list('')).entries,file=root.find(entry=>entry.name==='Field notes.txt')!,folder=root.find(entry=>entry.name==='Words & thoughts')!;
    await expect(vault.planWrite({kind:'mkdir',parentId:'',name:'field NOTES.txt'})).rejects.toThrow('already exists');
    await expect(vault.planWrite({kind:'mkdir',parentId:'',name:'../bad'})).rejects.toThrow('name');
    await expect(vault.planWrite({kind:'delete',parentId:'',entryId:'masterkey.cryptomator'})).rejects.toThrow('no longer');
    await expect(vault.planWrite({kind:'move',parentId:'',entryId:folder.id,targetId:folder.directoryId!,name:folder.name})).rejects.toThrow('itself');
    const unchanged=await vault.planWrite({kind:'move',parentId:'',entryId:file.id,targetId:'',name:file.name});expect(unchanged.noop).toBe(true);vault.finishWrite(unchanged.id,false);vault.lock();
  });
  test('recursive delete lists hashed content directories and lock invalidates plans',async()=>{
    const vault=await open(await source(fixture)),folder=(await vault.list('')).entries.find(entry=>entry.name==='Words & thoughts')!;
    const plan=await vault.planWrite({kind:'delete',parentId:'',entryId:folder.id});
    expect(plan.removedFolders.map(folder=>folder.id)).toEqual([folder.directoryId!]);expect(plan.removedFolders[0].path).toMatch(/^d\/[A-Z2-7]{2}\/[A-Z2-7]{30}$/);
    vault.lock();await expect(vault.planWrite({kind:'mkdir',parentId:'',name:'No'})).rejects.toThrow('locked');
  });
  test('duplicate directory IDs cannot delete shared folder contents',async()=>{
    const input=await source(fixture),vault=await open(input),folders=(await vault.list('')).entries.filter(entry=>entry.kind==='folder'),first=folders[0],second=folders[1];vault.lock();
    const damaged={...input,files:input.files.map(item=>item.path===`${first.path}/dir.c9r`?{...item,file:new File([second.directoryId!],'dir.c9r')}:item)};
    const bad=await open(damaged),folder=(await bad.list('')).entries.find(entry=>entry.id===first.id)!;
    await expect(bad.planWrite({kind:'delete',parentId:'',entryId:folder.id})).rejects.toThrow('duplicate');bad.lock();
  });
});

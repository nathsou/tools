import {describe,test,expect} from 'bun:test';
import {Vault} from '../../src/lib/vault';
import {concat,text} from '../../src/lib/bytes';
import {generateUvf,parseUvf,uvfCleartextSize,unlockUvf,destroyUvf} from '../../src/lib/uvf';
import {uvfFixture,uvfPassword,decryptUvfReference} from '../../scripts/reference-uvf';
import type {Source} from '../../src/lib/types';
const source=(files:Map<string,Uint8Array>):Source=>({type:'files',name:'UVF test',files:[...files].map(([path,b])=>({path,file:new File([Uint8Array.from(b)],path.split('/').at(-1)!)}))});
async function fixture(){const data=uvfFixture(),vault=new Vault(source(data.files));await vault.prepare();await vault.unlock(uvfPassword);return {...data,vault};}
describe('UVF independent interoperability',()=>{
  test('opens independent mixed-seed directories, files and symlinks',async()=>{
    const {vault}=await fixture(),listing=await vault.list('');expect(listing.warnings).toEqual([]);expect(listing.entries).toHaveLength(6);
    for(const entry of listing.entries.filter(e=>e.kind!=='folder'))expect((await vault.read(entry.id,0,entry.size)).length).toBe(entry.size);
    const folder=listing.entries.find(e=>e.kind==='folder')!,children=await vault.list(folder.directoryId!);expect(children.entries[0].name).toBe('café.txt');
    expect(text(await vault.read(children.entries[0].id,0,children.entries[0].size))).toContain('seed generations');vault.lock();
  });
  test('writes empty, exact, partial and multi-batch files readable by Node/OpenSSL',async()=>{
    const {vault}=await fixture();
    for(const length of [0,1,32739,32740,32741,65480,4*1024*1024+73]){
      const clear=new Uint8Array(length).fill(17),plan=await vault.beginImport(new File([clear],'import.bin'),'');const packets=[plan.header];
      for(let n=0;n<length;n+=4*1024*1024)packets.push(await vault.importChunk(plan.id));
      packets.push(await vault.finalizeImport(plan.id));const encrypted=concat(...packets);
      expect(decryptUvfReference(Buffer.from(encrypted))).toEqual(Buffer.from(clear));expect(uvfCleartextSize(encrypted.length)).toBe(length);vault.endImport(plan.id);
    }vault.lock();
  });
  test('rejects corrupted tails even when reading only the first byte',async()=>{
    for(const mutation of ['tail','truncate','header'] as const){const data=uvfFixture(),path=[...data.files.keys()].find(p=>data.files.get(p)!.length>65000)!;let bytes=Buffer.from(data.files.get(path)!);
      if(mutation==='truncate')bytes=bytes.subarray(0,-28);else bytes[mutation==='header'?24:bytes.length-1]^=1;
      data.files.set(path,bytes);const vault=new Vault(source(data.files));await vault.prepare();await vault.unlock(uvfPassword);const listing=await vault.list('');
      const entry=listing.entries.find(e=>e.path===path);if(entry)await expect(vault.read(entry.id,0,1)).rejects.toThrow();else expect(listing.warnings.length).toBeGreaterThan(0);vault.lock();
    }
  });
  test('directory moves keep identity and creation independently encrypts both metadata copies',async()=>{
    const {vault}=await fixture(),listing=await vault.list(''),entry=listing.entries.find(e=>e.kind==='folder')!;
    const move=await vault.planWrite({kind:'move',parentId:'',entryId:entry.id,targetId:'',name:'Renamed'});expect(move.target?.payloadName).toBe('dir.uvf');expect(move.entry?.directoryId).toBe(entry.directoryId);vault.finishWrite(move.id,false);
    const plan=await vault.planWrite({kind:'mkdir',parentId:'',name:'New'}),folder=plan.createdFolder!;
    expect(folder.marker).not.toEqual(folder.backup);expect(decryptUvfReference(Buffer.from(folder.marker))).toEqual(decryptUvfReference(Buffer.from(folder.backup)));expect(decryptUvfReference(Buffer.from(folder.marker))).toHaveLength(32);vault.lock();
  });
  test('rejects incorrect passwords, malformed algorithms and excessive KDF work',async()=>{
    const data=uvfFixture(),vault=new Vault(source(data.files));await vault.prepare();await expect(vault.unlock('wrong')).rejects.toThrow('Incorrect password');
    for(const count of [0,-1,2000001,1.5]){const m=structuredClone(data.meta);m.recipients[0].header.p2c=count;expect(()=>parseUvf(JSON.stringify(m))).toThrow();}
    const m=structuredClone(data.meta);m.protected=Buffer.from(JSON.stringify({enc:'A256GCM',cty:'json',crit:['unknown'],'uvf.spec.version':1})).toString('base64url');expect(()=>parseUvf(JSON.stringify(m))).toThrow('critical');
  });
  test('passkeys reopen authenticated metadata, cache uses isolated key material, and lock clears access',async()=>{
    const {vault,files}=await fixture(),prf=new Uint8Array(32).fill(8),record=await vault.seal(prf,{version:2,vaultId:vault.info.id,credentialId:'test',salt:Buffer.alloc(32,4).toString('base64'),origin:'https://example.org',created:1});
    expect(record.version).toBe(2);const encrypted=await vault.cacheCrypt(new Uint8Array([1,2,3]),'thumb');vault.lock();
    const reopened=new Vault(source(files));await reopened.prepare();await reopened.unlockPasskey(prf,record);expect(await reopened.cacheCrypt(encrypted.slice(),'thumb',true)).toEqual(new Uint8Array([1,2,3]));await expect(reopened.cacheCrypt(encrypted,'wrong',true)).rejects.toThrow();reopened.lock();await expect(reopened.list('')).rejects.toThrow('locked');
  });
  test('creates a password-protected vault that reopens with an authenticated empty root',async()=>{
    const b=await generateUvf('new password'),files=new Map([['vault.uvf',new TextEncoder().encode(b.configuration)],[`${b.rootPath}/dir.uvf`,b.backup]]),vault=new Vault(source(files));await vault.prepare();await vault.unlock('new password');expect(await vault.list('')).toEqual({entries:[],warnings:[]});vault.lock();
    const material=await unlockUvf(parseUvf(b.configuration),'new password');expect(material.raw).toHaveLength(32);destroyUvf(material);expect(material.raw.every(b=>b===0)).toBe(true);
  });
  test('migration inventories authenticate the full tree and have stable ciphertext fingerprints',async()=>{
    const {vault,files}=await fixture(),first=await vault.migrationInventory('cryptomator'),second=await vault.migrationInventory('cryptomator');
    expect(first.issues).toEqual([]);expect(first.fingerprint).toBe(second.fingerprint);expect(first.files).toBe(6);expect(first.folders).toBe(1);expect(first.items.some(i=>i.path==='New folder/café.txt')).toBe(true);
    const changed=new Map(files),path=[...changed.keys()].find(p=>p.endsWith('symlink.uvf'))!,bytes=Buffer.from(changed.get(path)!);bytes[bytes.length-1]^=1;changed.set(path,bytes);
    const broken=new Vault(source(changed));await broken.prepare();await broken.unlock(uvfPassword);const report=await broken.migrationInventory('cryptomator');expect(report.issues.some(i=>i.includes('authentication'))).toBe(true);expect(report.fingerprint).not.toBe(first.fingerprint);vault.lock();broken.lock();
  });
  test('an incomplete migration is blocked and preflight can be cancelled',async()=>{
    const {vault,files}=await fixture();files.set('.crypte-migration-incomplete',Buffer.from('pending'));const pending=new Vault(source(files));await expect(pending.prepare()).rejects.toThrow('incomplete migration');
    const scan=vault.migrationInventory('cryptomator');vault.cancelInventory();await expect(scan).rejects.toThrow('cancelled');vault.lock();
  });
});

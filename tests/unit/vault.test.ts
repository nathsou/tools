import { beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { Vault } from '../../src/lib/vault';
import { base32, concat, fromBase64, text, toBase64Url, utf8 } from '../../src/lib/bytes';
import { cleartextSize, createMaterial, decryptHeader, decryptName, directoryPath, encryptChunk, encryptHeader, encryptName, parseConfiguration, parseMasterkey, validateName } from '../../src/lib/crypto';
import { safePath } from '../../src/lib/filesystem';
import { referenceSiv } from '../../scripts/reference-siv';
import { decryptReference } from '../../scripts/reference-decrypt';
import type { Source, VaultEntry } from '../../src/lib/types';

async function fixture(name:string):Promise<Extract<Source,{type:'files'}>> {
  const root=`tests/fixtures/${name}`;
  const paths:string[]=JSON.parse(await readFile(`${root}/index.json`,'utf8'));
  return { type:'files',name:`Test ${name}`,files:await Promise.all(paths.map(async path=>({ path,file:new File([await readFile(`${root}/${path}`)],path.split('/').at(-1)!,{ lastModified:1234 }) }))) };
}
async function changed(source:Extract<Source,{type:'files'}>,path:string,transform:(b:Uint8Array)=>Uint8Array):Promise<Extract<Source,{type:'files'}>> {
  return { ...source,files:await Promise.all(source.files.map(async item=> item.path===path ? { path:item.path,file:new File([transform(new Uint8Array(await item.file.arrayBuffer()))],item.file.name) } : item)) };
}
for(const name of ['gcm','ctr','legacy'])describe(`${name} vault`,()=>{
  let source:Extract<Source,{type:'files'}>,vault:Vault,root:VaultEntry[];
  beforeAll(async()=>{source=await fixture(name);vault=new Vault(source);await vault.prepare();await vault.unlock('crypte-demo');root=(await vault.list('')).entries;});
  test('lists decrypted names, folders, images, symlinks and ignores dirid backup',async()=>{
    expect(root.find(e=>e.name==='Field notes.txt')?.kind).toBe('text');
    expect(root.filter(e=>e.kind==='image').length).toBe(4);
    expect(root.find(e=>e.name==='Small adventures')?.directoryId).toBeTruthy();
    expect(root.find(e=>e.name==='Link to field notes')?.kind).toBe('symlink');
    expect((await vault.list('')).warnings).toEqual([]);
  });
  test('ignores macOS sidecars without hiding real decrypted dotfiles or corrupt vault entries',async()=>{
    const sidecars=source.files.map(({path})=>{const parts=path.split('/');parts[parts.length-1]='._'+parts.at(-1);return {path:parts.join('/'),file:new File([new Uint8Array([0,5,22,7])],parts.at(-1)!)};});
    const decorated={...source,files:[...source.files,...sidecars]},v=new Vault(decorated);
    await v.prepare();await v.unlock('crypte-demo');
    const listing=await v.list('');expect(listing.warnings).toEqual([]);expect(listing.entries.map(e=>e.name)).toEqual(root.map(e=>e.name));
    expect(listing.entries.find(e=>e.name==='.DS_Store')).toBeDefined();
    const words=listing.entries.find(e=>e.name==='Words & thoughts')!,children=await v.list(words.directoryId!);expect(children.warnings).toEqual([]);
    const long=children.entries.find(e=>e.path.endsWith('/contents.c9r'))!,plan=await v.planWrite({kind:'move',parentId:words.directoryId!,entryId:long.id,targetId:words.directoryId!,name:'Short.txt'});
    expect(plan.sourceFiles).toHaveLength(2);expect(plan.sourceFiles.every(file=>!file.path.split('/').at(-1)!.startsWith('._'))).toBe(true);v.finishWrite(plan.id,false);
    const folderPlan=await v.planWrite({kind:'delete',parentId:'',entryId:words.id});expect(folderPlan.removedFolders).toHaveLength(1);v.finishWrite(folderPlan.id,false);v.lock();
    const path=root.find(e=>e.kind==='text')!.path.split('/').slice(0,-1).join('/')+'/invalid!.c9r';
    const damaged=new Vault({...decorated,files:[...decorated.files,{path,file:new File([new Uint8Array(100)],'invalid!.c9r')}]});await damaged.prepare();await damaged.unlock('crypte-demo');expect((await damaged.list('')).warnings).toHaveLength(1);
    await expect(damaged.planWrite({kind:'delete',parentId:'',entryId:words.id})).rejects.toThrow('unreadable entries');damaged.lock();
  });
  test('reads text and treats symlinks as text without following them',async()=>{
    const entry=root.find(e=>e.name==='Field notes.txt')!;
    expect(text(await vault.read(entry.id,0,entry.size))).toContain('FIELD NOTES');
    const link=root.find(e=>e.kind==='symlink')!;
    expect(text(await vault.read(link.id,0,link.size))).toBe('Field notes.txt');
  });
  test('reads shortened names, empty files and ranges across chunk boundaries',async()=>{
    const directory=root.find(e=>e.name==='Words & thoughts')!;
    const listing=await vault.list(directory.directoryId!);
    expect(listing.warnings).toEqual([]);
    const long=listing.entries.find(e=>e.name.startsWith('A very long name'))!;
    expect(long.path).toContain('.c9s/contents.c9r');
    expect(text(await vault.read(long.id,0,long.size))).toContain('Long filenames');
    const large=listing.entries.find(e=>e.name==='Across the chunks.txt')!;
    const expected='0123456789abcdef'.repeat(5000);
    for(const [start,end] of [[0,1],[32760,32790],[65530,65590],[0,80000],[79999,80000]]) expect(text(await vault.read(large.id,start,end))).toBe(expected.slice(start,end));
    const empty=listing.entries.find(e=>e.name==='Empty note.txt')!;
    expect(empty.size).toBe(0);expect((await vault.read(empty.id,0,0)).length).toBe(0);
    expect((await vault.list(root.find(e=>e.name==='Empty folder')!.directoryId!)).entries).toEqual([]);
  });
  test('rejects a wrong password',async()=>{const v=new Vault(source);await v.prepare();await expect(v.unlock('incorrect')).rejects.toThrow('Incorrect password');});
  test('rejects tampered configuration or masterkey version',async()=>{
    const path=name==='legacy'?'masterkey.cryptomator':'vault.cryptomator';
    const bad=await changed(source,path,b=>{
      if(name==='legacy'){const m=JSON.parse(text(b));m.versionMac='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';return utf8(JSON.stringify(m));}
      const parts=text(b).split('.');const payload=JSON.parse(text(fromBase64(parts[1])));payload.shorteningThreshold=200;parts[1]=toBase64Url(utf8(JSON.stringify(payload)));return utf8(parts.join('.'));
    });const v=new Vault(bad);await v.prepare();await expect(v.unlock('crypte-demo')).rejects.toThrow('authentication failed');
  });
  test('rejects a damaged header and damaged chunk without releasing plaintext',async()=>{
    const entry=root.find(e=>e.name==='Field notes.txt')!;
    for(const offset of [0,entry.size>0?(name==='gcm'?68:88)+17:0]){
      const bad=await changed(source,entry.path,b=>{b[offset]^=1;return b;});const v=new Vault(bad);await v.prepare();await v.unlock('crypte-demo');await v.list('');
      await expect(v.read(entry.id,0,entry.size)).rejects.toThrow(/authentication/);v.lock();
    }
  });
  test('passkey wrapping binds ciphertext to credential, vault and origin',async()=>{
    const prf=new Uint8Array(32).fill(7);
    const record=await vault.seal(prf,{version:1,vaultId:vault.info.id,credentialId:'credential-one',salt:'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',origin:'https://vault.example',created:1});
    const v=new Vault(source);await v.prepare();await v.unlockPasskey(prf,record);expect((await v.list('')).entries.length).toBe(root.length);v.lock();
    await expect(v.unlockPasskey(new Uint8Array(32).fill(9),record)).rejects.toThrow('Unable to unlock');
    await expect(v.unlockPasskey(prf,{...record,credentialId:'other-credential'})).rejects.toThrow('Unable to unlock');
    await expect(v.unlockPasskey(prf,{...record,origin:'https://another.example'})).rejects.toThrow('Unable to unlock');
    await expect(v.unlockPasskey(prf,{...record,vaultId:'another-vault'})).rejects.toThrow('another vault');
  });
  test('rejects arbitrary paths, oversized ranges, and reads after lock',async()=>{
    const entry=root.find(e=>e.name==='Field notes.txt')!;
    await expect(vault.read(entry.id,-1,10)).rejects.toThrow('Invalid');
    await expect(vault.read(entry.id,0,entry.size+1)).rejects.toThrow('Invalid');
    await expect(vault.read('masterkey.cryptomator',0,1)).rejects.toThrow('Unknown');
    await expect(vault.list('unknown-directory')).rejects.toThrow('Unknown');
    const v=new Vault(source);await v.prepare();await v.unlock('crypte-demo');await v.list('');v.lock();
    await expect(v.read(entry.id,0,1)).rejects.toThrow('locked');
  });
});

describe('reference vectors and input validation',()=>{
  for(const fixtureName of ['gcm','ctr'])test(`${fixtureName} imports preserve chunk indices across 4 MiB worker batches`,async()=>{
    const vault=new Vault(await fixture(fixtureName));await vault.prepare();await vault.unlock('crypte-demo');
    const plaintext=Buffer.alloc(4*1024*1024+79);
    for(let i=0;i<plaintext.length;i++)plaintext[i]=i%251;
    const plan=await vault.beginImport(new File([plaintext],'Batch boundary.bin'),'');
    const first=await vault.importChunk(plan.id),second=await vault.importChunk(plan.id);
    const raw=Buffer.from([...Array.from({length:32},(_,i)=>i+1),...Array.from({length:32},(_,i)=>128+i)]);
    expect(decryptReference(Buffer.from(concat(plan.header,first,second)),raw,fixtureName==='gcm'?'SIV_GCM':'SIV_CTRMAC')).toEqual(plaintext);
    await expect(vault.importChunk(plan.id)).rejects.toThrow('already been encrypted');
    vault.endImport(plan.id);await expect(vault.importChunk(plan.id)).rejects.toThrow('no longer active');vault.lock();
  });
  for(const scheme of ['SIV_GCM','SIV_CTRMAC'] as const)test(`${scheme} writes fresh authenticated ciphertext readable by Node/OpenSSL`,async()=>{
    const raw=Buffer.from(Array.from({length:64},(_,i)=>i)),material=await createMaterial(raw,scheme);
    const first=await encryptHeader(material),second=await encryptHeader(material);
    expect(first.header.nonce).not.toEqual(second.header.nonce);
    for(const plaintext of [Buffer.alloc(0),Buffer.from('Hello vault'),Buffer.from('0123456789abcdef'.repeat(5000))]) {
      const {bytes,header}=await encryptHeader(material),chunks=[bytes];
      for(let offset=0;offset<plaintext.length;offset+=32768)chunks.push(await encryptChunk(new Uint8Array(plaintext.subarray(offset,offset+32768)),offset/32768,header,material));
      const encrypted=Buffer.from(concat(...chunks));
      expect(decryptReference(encrypted,raw,scheme)).toEqual(plaintext);
      if(plaintext.length) {encrypted[encrypted.length-1]^=1;expect(()=>decryptReference(encrypted,raw,scheme)).toThrow();}
    }
    const expected=referenceSiv(Buffer.concat([raw.subarray(32),raw.subarray(0,32)]),Buffer.from('café.txt'),Buffer.from('folder')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_')+'.c9r';
    expect(encryptName('cafe\u0301.txt','folder',material)).toBe(expected);
    expect(validateName('cafe\u0301.txt')).toBe('café.txt');
    for(const invalid of ['..','../file','file/other','file\\other','file\0','a'.repeat(256)])expect(()=>validateName(invalid)).toThrow();
  });
  test('verifies all supported vault JWT HMAC algorithms and rejects malformed JSON objects',async()=>{
    const source=await fixture('gcm');
    const raw=Buffer.from([...Array.from({length:32},(_,i)=>i+1),...Array.from({length:32},(_,i)=>128+i)]);
    for(const [alg,hash] of [['HS256','sha256'],['HS384','sha384'],['HS512','sha512']]) {
      const signed=await changed(source,'vault.cryptomator',bytes=>{
        const parts=text(bytes).split('.');parts[0]=toBase64Url(utf8(JSON.stringify({alg,kid:'masterkeyfile:masterkey.cryptomator'})));
        parts[2]=createHmac(hash,raw).update(`${parts[0]}.${parts[1]}`).digest('base64url');return utf8(parts.join('.'));
      });
      const vault=new Vault(signed);await vault.prepare();await vault.unlock('crypte-demo');expect((await vault.list('')).warnings).toEqual([]);vault.lock();
    }
    expect(()=>parseMasterkey('null')).toThrow('Invalid masterkey');
    expect(()=>parseConfiguration('bnVsbA.bnVsbA.AAAA')).toThrow('Invalid vault configuration');
  });
  test('decrypts the Cryptomator cryptolib AES-CTR/HMAC golden header',async()=>{
    const material=await createMaterial(new Uint8Array(64),'SIV_CTRMAC');
    const golden='AAAAAAAAAAAAAAAAAAAAACNqP4ddv3Z2rUiiFJKEIIdTD4r7x0U2ualjtPHEy3OLzqdAPU1ga24VjC86+zlHN49BfMdzvHF3f9EE0LSnRLSsu6ps3IRcJg==';
    const header=await decryptHeader(fromBase64(golden),material);expect(header.nonce).toEqual(new Uint8Array(16));
    const iv=new Uint8Array(16),plaintext=utf8('interoperable');const key=await crypto.subtle.importKey('raw',new Uint8Array(32),'AES-CTR',false,['encrypt']);
    const cipher=await crypto.subtle.encrypt({name:'AES-CTR',counter:iv,length:128},key,plaintext);
    expect(new Uint8Array(await crypto.subtle.decrypt({name:'AES-CTR',counter:iv,length:128},header.key,cipher))).toEqual(plaintext);
  });
  test('independent SIV reference matches RFC 5297 deterministic vector',()=>{
    const key=Buffer.from('fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff','hex');
    const plaintext=Buffer.from('112233445566778899aabbccddee','hex'),ad=Buffer.from('101112131415161718191a1b1c1d1e1f2021222324252627','hex');
    expect(referenceSiv(key,plaintext,ad).toString('hex')).toBe('85632d07c6e8f37f950acd320a2ecc9340c02b9690c4dc04daef7f6afe5c');
  });
  test('filename and directory key order matches the independent reference',async()=>{
    const enc=new Uint8Array(32).fill(3),mac=new Uint8Array(32).fill(19),material=await createMaterial(concat(enc,mac),'SIV_GCM');
    const cipher=referenceSiv(Buffer.from(concat(mac,enc)),Buffer.from('café.txt'),Buffer.from('parent'));
    expect(decryptName(toBase64Url(cipher),'parent',material)).toBe('café.txt');
    expect(()=>decryptName(toBase64Url(cipher),'other-parent',material)).toThrow();
    const directory=referenceSiv(Buffer.from(concat(mac,enc)),Buffer.from('parent'));
    const hash=base32(new Uint8Array(await crypto.subtle.digest('SHA-1',directory)));
    expect(await directoryPath('parent',material)).toBe(`d/${hash.slice(0,2)}/${hash.slice(2)}`);
  });
  test('rejects traversal in storage paths and masterkey references',()=>{
    for(const path of ['../a','/a','a/../b','a\\b','a//b','a/./b','a\0b'])expect(()=>safePath(path)).toThrow();
    for(const kid of ['https://example.com/key','masterkeyfile:../key','masterkeyfile:%2e%2e/key']){
      const h=toBase64Url(utf8(JSON.stringify({alg:'HS256',kid})));expect(()=>parseConfiguration(`${h}.e30.AAAA`)).toThrow();
    }
  });
  test('rejects oversized KDFs and malformed/truncated content lengths',async()=>{
    const source=await fixture('gcm'),master=JSON.parse(await source.files.find(f=>f.path==='masterkey.cryptomator')!.file.text());
    expect(()=>parseMasterkey(JSON.stringify({...master,scryptCostParam:1048576}))).toThrow('256 MB');
    expect(()=>parseMasterkey(JSON.stringify({...master,scryptCostParam:3}))).toThrow();
    expect(()=>cleartextSize(67,'SIV_GCM')).toThrow();expect(()=>cleartextSize(68+27,'SIV_GCM')).toThrow();
    expect(cleartextSize(68,'SIV_GCM')).toBe(0);expect(cleartextSize(88+32768+48,'SIV_CTRMAC')).toBe(32768);
  });
});

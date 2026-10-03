import {describe,expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {Vault} from '../../src/lib/vault';
import {editableText,encodeEdit,TEXT_EDIT_LIMIT} from '../../src/lib/editing';
import {decryptReference} from '../../scripts/reference-decrypt';
import {concat,utf8} from '../../src/lib/bytes';
import type {Source} from '../../src/lib/types';
const raw=Buffer.from([...Array.from({length:32},(_,i)=>i+1),...Array.from({length:32},(_,i)=>i+128)]);
test('edits preserve UTF-8 BOM, Unicode, and dominant CRLF endings',()=>{
  const bytes=concat(new Uint8Array([0xef,0xbb,0xbf]),utf8('café 😀\r\nsecond\r\n'));
  const decoded=editableText(bytes);expect(decoded.text).toBe('café 😀\nsecond\n');
  expect(encodeEdit(decoded.text,decoded.format)).toEqual(bytes);
  expect(new TextDecoder().decode(encodeEdit('changed Ω\n',decoded.format))).toBe('changed Ω\r\n');
});
test('edits preserve both UTF-16 byte orders and empty files',()=>{
  for(const encoding of ['utf-16le','utf-16be'] as const){const format={encoding,bom:true,newline:'\r' as const};const bytes=encodeEdit('Ω 😀\n',format),decoded=editableText(bytes);expect(decoded.text).toBe('Ω 😀\n');expect(encodeEdit(decoded.text,decoded.format)).toEqual(bytes);}
  const decoded=editableText(new Uint8Array());expect(encodeEdit(decoded.text,decoded.format)).toHaveLength(0);
});
test('invalid encodings, binary files, invalid Unicode, and truncated/oversized edits are rejected',()=>{
  for(const bytes of [new Uint8Array([0xff]),new Uint8Array([0xff,0xfe,0x12]),new Uint8Array([0]),new Uint8Array(TEXT_EDIT_LIMIT+1)])expect(()=>editableText(bytes)).toThrow();
  const format=editableText(new Uint8Array()).format;
  for(const value of ['\ud800','\udfff','\0','a'.repeat(TEXT_EDIT_LIMIT+1)])expect(()=>encodeEdit(value,format)).toThrow();
});
for(const fixture of ['gcm','ctr','legacy'])describe(`${fixture} text replacement`,()=>{
  async function open(){const paths:string[]=JSON.parse(await readFile(`tests/fixtures/${fixture}/index.json`,'utf8'));const source:Source={type:'files',name:fixture,files:await Promise.all(paths.map(async path=>({path,file:new File([await readFile(`tests/fixtures/${fixture}/${path}`)],path.split('/').at(-1)!,{lastModified:123})})))};const vault=new Vault(source);await vault.prepare();await vault.unlock('crypte-demo');const entries=(await vault.list('')).entries;return {vault,entries};}
  test('fresh replacement encryption is independently readable and preserves the entry path',async()=>{
    const {vault,entries}=await open(),entry=entries.find(entry=>entry.name==='Field notes.txt')!,snapshot=await vault.readText(entry.id);
    expect(new TextDecoder().decode(snapshot.bytes)).toContain('FIELD NOTES');snapshot.bytes.fill(0);
    const file=new File(['Changed Ω 😀\n'],entry.name),plan=await vault.beginReplacement(file,'',entry.id,snapshot.fingerprint);
    expect(plan.import.nodePath).toBe(entry.path);const encrypted=concat(plan.import.header,await vault.importChunk(plan.import.id));
    expect(decryptReference(Buffer.from(encrypted),raw,fixture==='gcm'?'SIV_GCM':'SIV_CTRMAC').toString()).toBe('Changed Ω 😀\n');
    await expect(vault.beginImport(file,'')).rejects.toThrow('Another vault write');vault.endImport(plan.import.id);vault.lock();
  });
  test('stale fingerprints, wrong names and symlinks never authorize replacement',async()=>{
    const {vault,entries}=await open(),entry=entries.find(entry=>entry.name==='Field notes.txt')!,snapshot=await vault.readText(entry.id),file=new File(['Changed'],entry.name);
    for(const expected of [{...snapshot.fingerprint,digest:'wrong'},{...snapshot.fingerprint,modified:0},{...snapshot.fingerprint,path:'masterkey.cryptomator'}])await expect(vault.beginReplacement(file,'',entry.id,expected)).rejects.toThrow('changed');
    await expect(vault.beginReplacement(new File(['Changed'],'Different.txt'),'',entry.id,snapshot.fingerprint)).rejects.toThrow('original');
    await expect(vault.readText(entries.find(entry=>entry.kind==='symlink')!.id)).rejects.toThrow('plain text');snapshot.bytes.fill(0);vault.lock();
  });
});

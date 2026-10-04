import {test,expect} from 'bun:test';
import {createDecipheriv,createHash,createHmac,scryptSync} from 'node:crypto';
import {generateVault} from '../../src/lib/crypto';
import {Vault} from '../../src/lib/vault';
import {base32} from '../../src/lib/bytes';
import {referenceSiv} from '../../scripts/reference-siv';
import {decryptReference} from '../../scripts/reference-decrypt';
import {highlightCode} from '../../src/lib/highlighting';

function unwrap(encoded:string,kek:Buffer):Buffer {
  const wrapped=Buffer.from(encoded,'base64'),blocks=[1,2,3,4].map(i=>Buffer.from(wrapped.subarray(i*8,i*8+8)));
  let a=Buffer.from(wrapped.subarray(0,8));
  for(let j=5;j>=0;j--)for(let i=4;i>=1;i--){
    const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(4*j+i));
    const first=Buffer.from(a.map((value,index)=>value^counter[index]));
    const cipher=createDecipheriv('aes-256-ecb',kek,null);cipher.setAutoPadding(false);
    const bytes=Buffer.concat([cipher.update(Buffer.concat([first,blocks[i-1]])),cipher.final()]);
    a=bytes.subarray(0,8);blocks[i-1]=bytes.subarray(8);
  }
  expect(a).toEqual(Buffer.alloc(8,0xa6));return Buffer.concat(blocks);
}
test('new vault metadata independently unwraps, authenticates and locates a complete empty root',async()=>{
  const created=await generateVault('cafe\u0301 password'),master=JSON.parse(created.masterkey);
  const kek=scryptSync('café password',Buffer.from(master.scryptSalt,'base64'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  const raw=Buffer.concat([unwrap(master.primaryMasterKey,kek),unwrap(master.hmacMasterKey,kek)]);
  expect(raw.length).toBe(64);expect(master.version).toBe(999);
  const version=Buffer.alloc(4);version.writeUInt32BE(999);
  expect(createHmac('sha256',raw.subarray(32)).update(version).digest('base64')).toBe(master.versionMac);
  const [header,payload,signature]=created.configuration.split('.');
  expect(JSON.parse(Buffer.from(header,'base64url').toString())).toEqual({alg:'HS256',kid:'masterkeyfile:masterkey.cryptomator'});
  expect(JSON.parse(Buffer.from(payload,'base64url').toString())).toMatchObject({format:8,cipherCombo:'SIV_GCM',shorteningThreshold:220});
  expect(createHmac('sha256',raw).update(`${header}.${payload}`).digest('base64url')).toBe(signature);
  const hash=base32(createHash('sha1').update(referenceSiv(Buffer.concat([raw.subarray(32),raw.subarray(0,32)]),Buffer.alloc(0))).digest());
  expect(created.rootPath).toBe(`d/${hash.slice(0,2)}/${hash.slice(2)}`);
  expect(decryptReference(Buffer.from(created.backup),raw,'SIV_GCM')).toHaveLength(0);
  const files=[{path:'masterkey.cryptomator',file:new File([created.masterkey],'masterkey.cryptomator')},{path:'vault.cryptomator',file:new File([created.configuration],'vault.cryptomator')},{path:`${created.rootPath}/dirid.c9r`,file:new File([created.backup],'dirid.c9r')}];
  const vault=new Vault({type:'files',name:'New vault',files});await vault.prepare();
  await expect(vault.unlock('wrong')).rejects.toThrow('Incorrect password');
  await vault.unlock('café password');expect(await vault.list('')).toEqual({entries:[],warnings:[]});vault.lock();
  const another=await generateVault('café password');expect(another.masterkey).not.toBe(created.masterkey);expect(another.rootPath).not.toBe(created.rootPath);expect(another.configuration).not.toBe(created.configuration);
  await expect(generateVault('')).rejects.toThrow('password');
});
test('syntax highlighting escapes executable markup, preserves source and bounds large drafts',()=>{
  const code='const example = "<img src=x onerror=alert(1)>"; // comment';
  const highlighted=highlightCode(code,'test.js');
  expect(highlighted).toContain('hljs-keyword');expect(highlighted).not.toContain('<img');expect(highlighted).toContain('&lt;img');
  expect(highlightCode('<script>alert(1)</script>','notes.txt')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(highlightCode('a'.repeat(256*1024+1)+'<script>','large.js')).not.toContain('hljs-');
});

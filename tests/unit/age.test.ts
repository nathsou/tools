import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chacha20poly1305} from '@noble/ciphers/chacha.js';
import {hkdf} from '@noble/hashes/hkdf.js';
import {hmac} from '@noble/hashes/hmac.js';
import {scrypt} from '@noble/hashes/scrypt.js';
import {sha256} from '@noble/hashes/sha2.js';
import {bech32Decode,bech32Encode,decryptAge,decryptedName,encryptAge,encryptedSizeEstimate,generateIdentity,inspectAge,parseIdentities,parseRecipients,unlockAge,type AgeDecryptKeys} from '../../src/lib/age';

const fixture=(name:string)=>new Uint8Array(readFileSync(resolve('tests/fixtures/age',name)));
const identityText=readFileSync(resolve('tests/fixtures/age/identity.txt'),'utf8');
const pattern=(length:number)=>Uint8Array.from({length},(_,i)=>(i*31+7)%251);
const encoder=new TextEncoder();
async function* chunks(bytes:Uint8Array,size=Math.max(1,bytes.length)){for(let i=0;i<bytes.length;i+=size)yield bytes.slice(i,i+size);if(!bytes.length)yield bytes;}
async function collect(stream:AsyncIterable<Uint8Array>):Promise<Uint8Array>{const parts:Uint8Array[]=[];for await(const chunk of stream)parts.push(chunk.slice());return new Uint8Array(Buffer.concat(parts));}
const decrypt=(bytes:Uint8Array,keys:AgeDecryptKeys,workFactor?:number)=>collect(decryptAge(chunks(bytes,977),keys,{workFactor}));
const raw64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64').replace(/=+$/,'');

/** Builds a passphrase file independently of the implementation, so malformed payloads can be tested. */
function craft(plaintexts:Uint8Array[],lastFlags:boolean[],{passphrase='p',workFactor=4,extra=''}={}):Uint8Array {
  const salt=new Uint8Array(16).fill(3),fileKey=new Uint8Array(16).fill(5),nonce=new Uint8Array(16).fill(9);
  const key=scrypt(encoder.encode(passphrase),Buffer.concat([encoder.encode('age-encryption.org/v1/scrypt'),salt]),{N:2**workFactor,r:8,p:1,dkLen:32});
  const body=chacha20poly1305(key,new Uint8Array(12)).encrypt(fileKey);
  const header=`age-encryption.org/v1\n-> scrypt ${raw64(salt)} ${workFactor}\n${raw64(body)}\n${extra}---`;
  const mac=hmac(sha256,hkdf(sha256,fileKey,new Uint8Array(0),encoder.encode('header'),32),encoder.encode(header));
  const payload=hkdf(sha256,fileKey,nonce,encoder.encode('payload'),32);
  const sealed=plaintexts.map((plain,i)=>{const n=new Uint8Array(12);new DataView(n.buffer).setUint32(7,i);n[11]=lastFlags[i]?1:0;return chacha20poly1305(payload,n).encrypt(plain);});
  return new Uint8Array(Buffer.concat([encoder.encode(`${header} ${raw64(mac)}\n`),nonce,...sealed]));
}

describe('files from the age command-line tool',()=>{
  test('decrypts X25519, armored, empty and chunk-boundary files',async()=>{
    const identities=await parseIdentities(identityText);
    expect(new TextDecoder().decode(await decrypt(fixture('hello.age'),{identities}))).toBe('Hello from age.\n');
    expect(await decrypt(fixture('empty.age'),{identities})).toEqual(new Uint8Array(0));
    expect(await decrypt(fixture('chunk-boundary.age'),{identities})).toEqual(pattern(65536));
    expect(await decrypt(fixture('multi-chunk.armored.age'),{identities})).toEqual(pattern(70000));
  });
  test('decrypts a passphrase file and reports its header',async()=>{
    expect(new TextDecoder().decode(await decrypt(fixture('passphrase.age'),{passphrase:'crypte-demo'}))).toBe('Hello from age.\n');
    expect(await inspectAge(chunks(fixture('passphrase.age')))).toEqual({armored:false,passphrase:true,recipients:0,types:['scrypt'],workFactor:18});
    expect(await inspectAge(chunks(fixture('multi-chunk.armored.age'),100))).toEqual({armored:true,passphrase:false,recipients:1,types:['X25519'],workFactor:undefined});
    await expect(decrypt(fixture('passphrase.age'),{passphrase:'wrong'})).rejects.toThrow('Incorrect passphrase');
  },60000);
  test('derives the same public key as age-keygen',async()=>{
    const [identity]=await parseIdentities(identityText);
    expect(identity.recipient).toBe(identityText.match(/public key: (age1\w+)/)![1]);
  });
  test.skipIf(!Bun.which('age'))('the age command-line tool decrypts files written here',async()=>{
    const [identity]=await parseIdentities(identityText),plain=pattern(150000);
    for(const armor of [false,true]){
      const encrypted=await collect(encryptAge(chunks(plain,4096),{recipients:parseRecipients(identity.recipient)},{armor}));
      const result=Bun.spawnSync(['age','-d','-i',resolve('tests/fixtures/age/identity.txt')],{stdin:encrypted});
      expect(result.exitCode).toBe(0);expect(new Uint8Array(result.stdout)).toEqual(plain);
    }
  });
});

describe('encryption round trips',()=>{
  const sizes=[0,1,65535,65536,65537,3*65536,200001];
  test('passphrases, across chunk boundaries and source chunk sizes',async()=>{
    for(const size of sizes){
      const plain=pattern(size),encrypted=await collect(encryptAge(chunks(plain,3000),{passphrase:'pässwörd'},{workFactor:4}));
      expect(await decrypt(encrypted,{passphrase:'pässwörd'})).toEqual(plain);
    }
  });
  test('several recipients, with and without armor',async()=>{
    const first=await generateIdentity(),second=await generateIdentity();
    const recipients=parseRecipients(`# two keys\n${first.recipient}\n\n${second.recipient}\n${first.recipient}\n`);
    expect(recipients).toHaveLength(2);
    for(const armor of [false,true])for(const size of [0,65536,100000]){
      const plain=pattern(size),encrypted=await collect(encryptAge(chunks(plain,65536),{recipients},{armor}));
      expect(encrypted.length).toBeLessThanOrEqual(encryptedSizeEstimate(size,2,armor));
      for(const identity of [first,second])expect(await decrypt(encrypted,{identities:await parseIdentities(identity.identity)})).toEqual(plain);
      await expect(decrypt(encrypted,{identities:await parseIdentities(identityText)})).rejects.toThrow('None of these secret keys');
      await expect(decrypt(encrypted,{passphrase:'x'})).rejects.toThrow('encrypted to public keys');
    }
  });
  test('passphrase files refuse identities, and armor tolerates CRLF and surrounding whitespace',async()=>{
    const plain=pattern(5000),armored=new TextDecoder().decode(await collect(encryptAge(chunks(plain),{passphrase:'p'},{armor:true,workFactor:4})));
    await expect(decrypt(encoder.encode(armored),{identities:await parseIdentities(identityText)})).rejects.toThrow('protected by a passphrase');
    expect(await decrypt(encoder.encode(`\n  ${armored.replaceAll('\n','\r\n')}\n\n`),{passphrase:'p'})).toEqual(plain);
    await expect(decrypt(encoder.encode(`${armored}trailing`),{passphrase:'p'})).rejects.toThrow('Unexpected data after the armored');
    const lines=armored.split('\n');
    await expect(decrypt(encoder.encode([...lines.slice(0,2),lines[2].slice(0,40),...lines.slice(3)].join('\n')),{passphrase:'p'})).rejects.toThrow('Invalid armored');
  });
  test('unlocking checks keys once, then decrypts only the same file',async()=>{
    const plain=pattern(70000),encrypted=await collect(encryptAge(chunks(plain),{passphrase:'p'},{workFactor:4}));
    await expect(unlockAge(chunks(encrypted),{passphrase:'wrong'})).rejects.toThrow('Incorrect passphrase');
    const unlocked=await unlockAge(chunks(encrypted.slice(0,300)),{passphrase:'p'});
    expect(unlocked.passphrase).toBe(true);
    expect(await decrypt(encrypted,{unlocked})).toEqual(plain);
    const other=await collect(encryptAge(chunks(plain),{passphrase:'p'},{workFactor:4}));
    await expect(decrypt(other,{unlocked})).rejects.toThrow('header failed authentication');
    unlocked.dispose();
    await expect(decrypt(encrypted,{unlocked})).rejects.toThrow('cleared');
  });
  test('encryption can be cancelled while deriving the passphrase key',async()=>{
    const controller=new AbortController();
    const stream=encryptAge(chunks(pattern(10)),{passphrase:'p'},{workFactor:16,signal:controller.signal,onKeyProgress:()=>controller.abort()});
    await expect(collect(stream)).rejects.toThrow();
  });
});

describe('malformed and modified files',()=>{
  const full=pattern(65536);
  test('the independent construction decrypts',async()=>{
    expect(await decrypt(craft([full,pattern(5)],[false,true]),{passphrase:'p'})).toEqual(Buffer.concat([full,pattern(5)]));
    expect(await decrypt(craft([new Uint8Array(0)],[true]),{passphrase:'p'})).toEqual(new Uint8Array(0));
  });
  test('rejects truncation, trailing data and empty or missing final chunks',async()=>{
    const valid=craft([full,pattern(5)],[false,true]);
    await expect(decrypt(valid.slice(0,-1),{passphrase:'p'})).rejects.toThrow('failed authentication');
    await expect(decrypt(valid.slice(0,valid.length-21),{passphrase:'p'})).rejects.toThrow('failed authentication');
    await expect(decrypt(craft([full,pattern(5)],[false,false]),{passphrase:'p'})).rejects.toThrow('failed authentication');
    await expect(decrypt(craft([full],[false]),{passphrase:'p'})).rejects.toThrow('failed authentication');
    await expect(decrypt(craft([full,new Uint8Array(0)],[false,true]),{passphrase:'p'})).rejects.toThrow('final chunk is empty');
    await expect(decrypt(craft([full,full],[true,true]),{passphrase:'p'})).rejects.toThrow('Unexpected data after the end');
    await expect(decrypt(Buffer.concat([valid,new Uint8Array(1)]),{passphrase:'p'})).rejects.toThrow('failed authentication');
    const text=new TextDecoder('latin1').decode(valid),headerEnd=text.indexOf('\n',text.indexOf('--- '))+1;
    await expect(decrypt(valid.slice(0,headerEnd+16),{passphrase:'p'})).rejects.toThrow('truncated');
    await expect(decrypt(valid.slice(0,headerEnd+8),{passphrase:'p'})).rejects.toThrow('truncated');
    await expect(decrypt(valid.slice(0,headerEnd-5),{passphrase:'p'})).rejects.toThrow('truncated');
  });
  test('rejects modified headers and payloads',async()=>{
    const valid=craft([pattern(100)],[true]),text=new TextDecoder('latin1').decode(valid);
    const flip=(index:number)=>{const copy=valid.slice();copy[index]^=1;return copy;};
    await expect(decrypt(flip(text.indexOf('---')+5),{passphrase:'p'})).rejects.toThrow();
    await expect(decrypt(flip(valid.length-3),{passphrase:'p'})).rejects.toThrow('failed authentication');
    const macStart=text.indexOf('--- ')+4,mac=text.slice(macStart,macStart+43);
    const otherMac=mac.slice(0,-1)+(mac.endsWith('A')?'Q':'A');
    await expect(decrypt(encoder.encode(text.replace(mac,otherMac)),{passphrase:'p'})).rejects.toThrow();
    await expect(decrypt(craft([pattern(1)],[true],{extra:'-> grease x\n\n'}),{passphrase:'p'})).rejects.toThrow('must be the only one');
  });
  test('rejects non-canonical encodings and excessive work factors before deriving keys',async()=>{
    const valid=new TextDecoder('latin1').decode(craft([pattern(1)],[true]));
    await expect(decrypt(encoder.encode(valid.replace(' 4\n',' 21\n')),{passphrase:'p'})).rejects.toThrow('work factor of 21');
    await expect(decrypt(encoder.encode(valid.replace(' 4\n',' 12\n')),{passphrase:'p'},10)).rejects.toThrow('at most 10');
    await expect(decrypt(encoder.encode(valid.replace(' 4\n',' 04\n')),{passphrase:'p'})).rejects.toThrow('Invalid passphrase stanza');
    const salt=valid.split('\n')[1].split(' ')[2];
    await expect(decrypt(encoder.encode(valid.replace(salt,`${salt}==`)),{passphrase:'p'})).rejects.toThrow('base64');
    await expect(decrypt(encoder.encode(valid.replace('\n','\r\n')),{passphrase:'p'})).rejects.toThrow('Invalid age header');
    await expect(decrypt(encoder.encode('age-encryption.org/v2\n'),{passphrase:'p'})).rejects.toThrow('unsupported format version');
    await expect(decrypt(pattern(1000),{passphrase:'p'})).rejects.toThrow('not an age encrypted file');
  });
});

describe('keys',()=>{
  test('bech32 round trips and rejects corrupted or mixed-case keys',()=>{
    const data=pattern(32),encoded=bech32Encode('age',data);
    expect(bech32Decode(encoded)).toEqual({hrp:'age',data});
    expect(bech32Decode(encoded.toUpperCase()).data).toEqual(data);
    expect(()=>bech32Decode(encoded.slice(0,-1)+(encoded.endsWith('q')?'p':'q'))).toThrow('checksum');
    expect(()=>bech32Decode(encoded.slice(0,10)+encoded.slice(10).toUpperCase())).toThrow('mix');
  });
  test('recipient and identity parsing gives specific errors',async()=>{
    const {identity,recipient}=await generateIdentity(),secret=identity.split('\n')[2];
    expect(secret).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);expect(recipient).toMatch(/^age1[0-9a-z]{58}$/);
    expect(()=>parseRecipients(secret)).toThrow('secret key');
    expect(()=>parseRecipients('ssh-ed25519 AAAA')).toThrow('SSH keys are not supported');
    expect(()=>parseRecipients(bech32Encode('age1yubikey',pattern(33)))).toThrow('not supported');
    expect(()=>parseRecipients('# only a comment')).toThrow('at least one');
    await expect(parseIdentities(recipient)).rejects.toThrow('public key');
    await expect(parseIdentities('AGE-PLUGIN-YUBIKEY-1QQQ')).rejects.toThrow('plugin identities');
    await expect(parseIdentities('age-encryption.org/v1\n')).rejects.toThrow('itself encrypted');
    expect((await parseIdentities(secret.toLowerCase()))[0].recipient).toBe(recipient);
  });
  test('names decrypted files',()=>{
    expect(decryptedName('report.pdf.age')).toBe('report.pdf');
    expect(decryptedName('NOTES.AGE')).toBe('NOTES');
    expect(decryptedName('.age')).toBe('.age.decrypted');
    expect(decryptedName('archive.bin')).toBe('archive.bin.decrypted');
  });
});

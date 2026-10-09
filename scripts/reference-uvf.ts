/** Independent UVF fixture/oracle using Node/OpenSSL, never application codecs. */
import {createCipheriv,createDecipheriv,createHmac,hkdfSync,pbkdf2Sync} from 'node:crypto';
import {referenceSiv} from './reference-siv';
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64url');
export const uvfPassword='uvf-demo';
export const fixtureSalt=Buffer.alloc(32,7),fixtureSeeds=[Buffer.alloc(32,11),Buffer.alloc(32,22)],fixtureIds=['AAAAAA','AAAAAQ'];
export const derive=(seed:Buffer,context:string,length:number)=>Buffer.from(hkdfSync('sha512',seed,fixtureSalt,context,length));
function gcm(key:Buffer,nonce:Buffer,plain:Buffer,aad:Buffer){const c=createCipheriv('aes-256-gcm',key,nonce);c.setAAD(aad);return Buffer.concat([c.update(plain),c.final(),c.getAuthTag()]);}
function open(key:Buffer,nonce:Buffer,cipher:Buffer,aad:Buffer){const c=createDecipheriv('aes-256-gcm',key,nonce);c.setAAD(aad);c.setAuthTag(cipher.subarray(-16));return Buffer.concat([c.update(cipher.subarray(0,-16)),c.final()]);}
let sequence=0;
const nonce=()=>{const b=Buffer.alloc(12);b.writeUInt32BE(++sequence,8);return b;};
function wrapKey(key:Buffer,kek:Buffer):Buffer{
  let a=Buffer.alloc(8,0xa6);const blocks=[0,1,2,3].map(i=>key.subarray(i*8,i*8+8));
  for(let j=0;j<6;j++)for(let i=0;i<4;i++){
    const cipher=createCipheriv('aes-256-ecb',kek,null);cipher.setAutoPadding(false);
    const b=Buffer.concat([cipher.update(Buffer.concat([a,blocks[i]])),cipher.final()]);
    a=Buffer.from(b.subarray(0,8));const t=Buffer.alloc(8);t.writeBigUInt64BE(BigInt(4*j+i+1));for(let k=0;k<8;k++)a[k]^=t[k];blocks[i]=b.subarray(8);
  }return Buffer.concat([a,...blocks]);
}
export function referenceUvfFile(plain:Buffer,epoch=1):Buffer{
  const general=Buffer.concat([Buffer.from('uvf'),Buffer.from([1]),Buffer.from(fixtureIds[epoch],'base64url')]),iv=nonce(),key=Buffer.alloc(32,31+sequence%128);
  const result=[general,iv,gcm(derive(fixtureSeeds[epoch],'fileHeader',32),iv,key,general)];
  for(let offset=0;offset<=plain.length;offset+=32740){const block=plain.subarray(offset,offset+32740),counter=Buffer.alloc(4);counter.writeUInt32BE(offset/32740);const n=nonce();result.push(n,gcm(key,n,block,Buffer.concat([counter,iv])));if(block.length<32740)break;}
  return Buffer.concat(result);
}
export function decryptUvfReference(bytes:Buffer,seeds=fixtureSeeds,salt=fixtureSalt):Buffer{
  const epoch=bytes.readUInt32BE(4),headerKey=Buffer.from(hkdfSync('sha512',seeds[epoch],salt,'fileHeader',32)),iv=bytes.subarray(8,20);
  const key=open(headerKey,iv,bytes.subarray(20,68),bytes.subarray(0,8)),out:Buffer[]=[];
  if(bytes.length<96||(bytes.length-68)%32768<28)throw new Error('Missing EOF');
  for(let offset=68,index=0;offset<bytes.length;offset+=32768,index++){const b=bytes.subarray(offset,offset+32768),counter=Buffer.alloc(4);counter.writeUInt32BE(index);out.push(open(key,b.subarray(0,12),b.subarray(12),Buffer.concat([counter,iv])));}
  return Buffer.concat(out);
}
export function uvfFixture(){
  const base32=(b:Buffer)=>{const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0,out='';for(const byte of b){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;out+=alphabet[(value>>>bits)&31];}}return out;};
  const path=(id:Buffer,epoch:number)=>{const h=base32(createHmac('sha256',derive(fixtureSeeds[epoch],'hmac',64)).update(id).digest().subarray(0,20));return `d/${h.slice(0,2)}/${h.slice(2)}`;};
  const name=(n:string,id:Buffer,epoch:number)=>b64(referenceSiv(derive(fixtureSeeds[epoch],'siv',64),Buffer.from(n.normalize('NFC')),id))+'.uvf';
  const root=derive(fixtureSeeds[0],'rootDirId',32),child=Buffer.alloc(32,77),rootPath=path(root,0),childPath=path(child,1),files=new Map<string,Buffer>();
  files.set(`${rootPath}/dir.uvf`,referenceUvfFile(root,0));
  files.set(`${rootPath}/${name('New folder',root,0)}/dir.uvf`,referenceUvfFile(child,1));
  files.set(`${childPath}/dir.uvf`,referenceUvfFile(child,1));
  for(const [label,bytes] of [['Field notes.txt',Buffer.from('Hello from an independent UVF fixture.\n')],['Empty.txt',Buffer.alloc(0)],['Exact.bin',Buffer.alloc(32740,3)],['Across.bin',Buffer.alloc(65500,9)]] as const)files.set(`${rootPath}/${name(label,root,0)}`,referenceUvfFile(bytes));
  files.set(`${childPath}/${name('café.txt',child,1)}`,referenceUvfFile(Buffer.from('Nested across seed generations.')));
  files.set(`${rootPath}/${name('Link',root,0)}/symlink.uvf`,referenceUvfFile(Buffer.from('Field notes.txt')));
  const payload={fileFormat:'AES-256-GCM-32k',nameFormat:'AES-SIV-512-B64URL',kdf:'HKDF-SHA512',kdfSalt:b64(fixtureSalt),seeds:Object.fromEntries(fixtureIds.map((id,i)=>[id,b64(fixtureSeeds[i])])),initialSeed:fixtureIds[0],latestSeed:fixtureIds[1],'org.example.extra':42};
  const protectedHeader=b64(Buffer.from(JSON.stringify({enc:'A256GCM',cty:'json',crit:['uvf.spec.version'],'uvf.spec.version':1}))),iv=nonce(),cek=Buffer.alloc(32,99),cipher=gcm(cek,iv,Buffer.from(JSON.stringify(payload)),Buffer.from(protectedHeader));
  const alg='PBES2-HS512+A256KW',salt=Buffer.alloc(16,4),kek=pbkdf2Sync(uvfPassword,Buffer.concat([Buffer.from(alg),Buffer.alloc(1),salt]),1000,32,'sha512');
  const meta={protected:protectedHeader,iv:b64(iv),ciphertext:b64(cipher.subarray(0,-16)),tag:b64(cipher.subarray(-16)),recipients:[{header:{alg,kid:'org.example.password',p2s:b64(salt),p2c:1000},encrypted_key:b64(wrapKey(cek,kek))}]};
  files.set('vault.uvf',Buffer.from(JSON.stringify(meta)));
  return {files,meta,cek,rootPath,childPath};
}

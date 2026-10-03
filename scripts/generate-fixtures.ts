/** Synthetic vaults only. Independent Node crypto creates the wrapped keys and file ciphertext. */
import { createCipheriv, createHash, createHmac, scryptSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { referenceSiv } from './reference-siv.ts';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';
export type Scheme = 'SIV_GCM'|'SIV_CTRMAC';
const enc=Buffer.from(Array.from({length:32},(_,i)=>i+1));
const mac=Buffer.from(Array.from({length:32},(_,i)=>128+i));
const raw=Buffer.concat([enc,mac]), sivKey=Buffer.concat([mac,enc]);
const b64url=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64url');
const b64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');
const utf8=(s:string)=>Buffer.from(s,'utf8');
function base32(bytes:Uint8Array):string {
  let acc=0,bits=0,out='';
  for(const b of bytes){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;out+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(acc>>>bits)&31];}}
  if(bits)out+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(acc<<(5-bits))&31]; return out;
}
function dirPath(id:string):string {const hash=base32(createHash('sha1').update(referenceSiv(sivKey,utf8(id))).digest());return `d/${hash.slice(0,2)}/${hash.slice(2)}`;}
function nameCipher(name:string,dir:string):string {return `${b64(referenceSiv(sivKey,utf8(name.normalize('NFC')),utf8(dir))).replace(/\+/g,'-').replace(/\//g,'_')}.c9r`;}
function encrypt(data:Uint8Array,key:Buffer,iv:Buffer,scheme:Scheme,aad?:Buffer):Buffer {
  const cipher=createCipheriv(scheme === 'SIV_GCM' ? 'aes-256-gcm' : 'aes-256-ctr',key,iv);
  if(scheme === 'SIV_GCM' && aad)(cipher as any).setAAD(aad);
  const out=Buffer.concat([cipher.update(data),cipher.final()]);
  return scheme === 'SIV_GCM' ? Buffer.concat([out,(cipher as any).getAuthTag()]) : out;
}
export function* encryptedFileParts(size:number,readClear:(start:number,end:number)=>Uint8Array,scheme:Scheme,seed=1):Generator<Buffer> {
  const nonce=Buffer.alloc(scheme === 'SIV_GCM'?12:16,seed);
  const fileKey=Buffer.alloc(32,seed+1),payload=Buffer.concat([Buffer.alloc(8,255),fileKey]);
  const headerBody=Buffer.concat([nonce,encrypt(payload,enc,nonce,scheme)]);
  const header=scheme === 'SIV_GCM' ? headerBody : Buffer.concat([headerBody,createHmac('sha256',mac).update(headerBody).digest()]);
  yield header;
  for(let offset=0,index=0;offset<size;offset+=32768,index++){
    const chunkNonce=Buffer.alloc(nonce.length,seed+3);chunkNonce.writeUInt32BE(index,0);
    const number=Buffer.alloc(8);number.writeBigUInt64BE(BigInt(index));
    const chunkBody=Buffer.concat([chunkNonce,encrypt(readClear(offset,Math.min(offset+32768,size)),fileKey,chunkNonce,scheme,Buffer.concat([number,nonce]))]);
    yield scheme === 'SIV_GCM' ? chunkBody : Buffer.concat([chunkBody,createHmac('sha256',mac).update(nonce).update(number).update(chunkBody).digest()]);
  }
}
export function encryptFile(data:Uint8Array,scheme:Scheme,seed=1):Buffer {return Buffer.concat([...encryptedFileParts(data.length,(start,end)=>data.subarray(start,end),scheme,seed)]);}
export function makeVault(scheme:Scheme='SIV_GCM',legacy=false,benchmark?:Uint8Array,extras:{name:string;bytes:Uint8Array}[]=[]):Map<string,Buffer> {
  const files=new Map<string,Buffer>(),salt=Buffer.from('0102030405060708','hex');
  const kek=scryptSync('crypte-demo',salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  const wrap=(key:Buffer)=>{const cipher=createCipheriv('id-aes256-wrap',kek,Buffer.alloc(8,0xa6));return Buffer.concat([cipher.update(key),cipher.final()]);};
  const version=legacy?7:999,versionBytes=Buffer.alloc(4);versionBytes.writeUInt32BE(version);
  files.set('masterkey.cryptomator',utf8(JSON.stringify({version,scryptSalt:b64(salt),scryptCostParam:32768,scryptBlockSize:8,primaryMasterKey:b64(wrap(enc)),hmacMasterKey:b64(wrap(mac)),versionMac:b64(createHmac('sha256',mac).update(versionBytes).digest())})));
  if(!legacy){
    const header=b64url(utf8(JSON.stringify({alg:'HS256',kid:'masterkeyfile:masterkey.cryptomator'})));
    const payload=b64url(utf8(JSON.stringify({format:8,shorteningThreshold:220,jti:'crypte-synthetic-demo',cipherCombo:scheme})));
    const signed=`${header}.${payload}`;files.set('vault.cryptomator',utf8(`${signed}.${b64url(createHmac('sha256',raw).update(signed).digest())}`));
  }
  const add=(name:string,data:Uint8Array,dir='',seed=1)=>{
    const encryptedName=nameCipher(name,dir),base=dirPath(dir);
    if(encryptedName.length>220){const shortened=b64url(createHash('sha1').update(encryptedName).digest())+'.c9s';files.set(`${base}/${shortened}/name.c9s`,utf8(encryptedName));files.set(`${base}/${shortened}/contents.c9r`,encryptFile(data,scheme,seed));}
    else files.set(`${base}/${encryptedName}`,encryptFile(data,scheme,seed));
  };
  const folder=(name:string,id:string,parent='')=>{files.set(`${dirPath(parent)}/${nameCipher(name,parent)}/dir.c9r`,utf8(id));files.set(`${dirPath(id)}/dirid.c9r`,encryptFile(utf8(id),scheme,20));};
  files.set(`${dirPath('')}/dirid.c9r`,encryptFile(new Uint8Array(),scheme,19));
  folder('Small adventures','f62696f1-08d2-4f6a-ae51-559d038731a4');
  folder('Words & thoughts','f20d83b5-c3b6-484e-a5c1-3d3b90c6c23e');
  folder('Empty folder','ef367990-cf0c-4dfb-818d-1617774744c0');
  folder('.hidden folder','b26cd93d-c1ea-4419-9b98-d24c823f33aa');
  add('.DS_Store',utf8('Synthetic hidden file fixture.'),'',24);
  add('Visible note.txt',utf8('A file inside a dot-prefixed folder.'),'b26cd93d-c1ea-4419-9b98-d24c823f33aa',25);
  add('Field notes.txt',utf8('FIELD NOTES\nA small collection of things worth keeping.\n\n02 October\nThe light arrived slowly this morning.\nA cup of coffee, an open window, a little time.\n\nEverything here is synthetic demo content.\nYour own files are read locally and never uploaded.\n\nTry the pictures, watch a short film, or wander into a folder.\n'));
  add('Northern light.png',png(640,420,0),'',3);add('Still waters.png',png(640,420,1),'',5);add('Desert afternoon.png',png(640,420,2),'',7);add('A softer horizon.png',png(640,420,3),'',9);
  add('Morning walk.png',png(640,420,4),'f62696f1-08d2-4f6a-ae51-559d038731a4',11);
  add('A very long name '+ 'for the small things that make an ordinary day special '.repeat(4)+'.txt',utf8('Long filenames are supported through Cryptomator’s .c9s name mappings.\n'),'f20d83b5-c3b6-484e-a5c1-3d3b90c6c23e');
  add('Across the chunks.txt',utf8('0123456789abcdef'.repeat(5000)),'f20d83b5-c3b6-484e-a5c1-3d3b90c6c23e',13);
  add('Empty note.txt',new Uint8Array(),'f20d83b5-c3b6-484e-a5c1-3d3b90c6c23e',14);
  add('Quiet tone.wav',wav(),'f62696f1-08d2-4f6a-ae51-559d038731a4',15);
  const linkName=nameCipher('Link to field notes','');files.set(`${dirPath('')}/${linkName}/symlink.c9r`,encryptFile(utf8('Field notes.txt'),scheme,16));
  if(benchmark)add('Benchmark.bin',benchmark,'',23);
  extras.forEach((file,index)=>add(file.name,file.bytes,'',30+index));
  return files;
}
function crc32(bytes:Uint8Array):number {let crc=0xffffffff;for(const b of bytes){crc^=b;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function pngChunk(type:string,data:Buffer):Buffer {const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const body=Buffer.concat([utf8(type),data]),crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([length,body,crc]);}
function png(width:number,height:number,palette:number):Buffer {
  const colors=[[[192,210,190],[74,101,87],[37,70,65]],[[167,192,190],[69,111,122],[48,83,94]],[[228,188,151],[179,116,86],[127,74,60]],[[225,200,198],[161,148,152],[96,104,118]],[[205,206,167],[116,136,99],[63,93,77]]][palette];
  const pixels=Buffer.alloc(height*(1+width*3));
  for(let y=0;y<height;y++){for(let x=0;x<width;x++){
    let color=colors[0];const ridge=height*(.56+.12*Math.sin(x/width*8+palette)+.035*Math.sin(x/width*23));const front=height*(.79+.07*Math.cos(x/width*6+palette));
    if(y>ridge)color=colors[1];if(y>front)color=colors[2];
    const sun=(x-width*.72)**2+(y-height*.23)**2<(height*.075)**2;
    const shade=y<ridge?1-y/height*.13:1+(x/width-.5)*.04;
    for(let c=0;c<3;c++)pixels[y*(1+width*3)+1+x*3+c]=sun?[242,232,201][c]:Math.max(0,Math.min(255,Math.round(color[c]*shade)));
  }}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);
}
function wav():Buffer {
  const rate=22050,samples=rate*2,buffer=Buffer.alloc(44+samples*2);buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)buffer.writeInt16LE(Math.round(Math.sin(i/rate*Math.PI*440*2)*1500*Math.min(1,i/1000,(samples-i)/1000)),44+i*2);return buffer;
}
export async function writeVault(files:Map<string,Buffer>,destination:string):Promise<void> {
  for(const [path,bytes] of files){const target=resolve(destination,path);await mkdir(target.slice(0,target.lastIndexOf('/')),{recursive:true});await writeFile(target,bytes);}
  await writeFile(resolve(destination,'index.json'),JSON.stringify([...files.keys()]));
}
if(import.meta.main){
  for(const [name,scheme,legacy] of [['gcm','SIV_GCM',false],['ctr','SIV_CTRMAC',false],['legacy','SIV_CTRMAC',true]] as const){
    const files=makeVault(scheme,legacy);
    if(name==='gcm'){
      const path=`${dirPath('')}/${nameCipher('A moment in bloom.mp4','')}`;
      const video=await readFile('.tools/flower.mp4').catch(()=>undefined);
      if(video)files.set(path,encryptFile(video,scheme,17));
      else { const committed=await readFile(`tests/fixtures/gcm/${path}`).catch(()=>undefined); if(committed)files.set(path,committed); }
    }
    await writeVault(files,`tests/fixtures/${name}`);
  }
  const extras=[{name:'Sample.HEIC',bytes:await readFile('tests/assets/sample.heic')},{name:'Notes.rtf',bytes:await readFile('tests/assets/notes.rtf')},{name:'Invalid.heic',bytes:utf8('Not a HEIC file')},{name:'Unsupported.mp4',bytes:utf8('Not a video file')}];
  const media=makeVault('SIV_GCM',false,undefined,extras);
  const videoPath=`${dirPath('')}/${nameCipher('A moment in bloom.mp4','')}`;
  media.set(videoPath,await readFile(`tests/fixtures/gcm/${videoPath}`));
  await writeVault(media,'tests/fixtures/media');
  console.log('Generated synthetic format 7 / 8 test fixtures.');
}

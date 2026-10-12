import {AGE_EXTENSION,decryptAge,decryptedName,encryptAge,encryptedSizeEstimate,generateIdentity,inspectAge,parseIdentities,parseRecipients,unlockAge,x25519Available,type AgeEncryptKeys,type AgeHeaderInfo,type AgeUnlocked} from '../lib/age';
import {blobChunks,canStreamToDisk,chooseSaveTarget,MEMORY_LIMIT,saveChunks} from '../lib/save';

const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const input=(id:string)=>$<HTMLInputElement>(id);
const button=(id:string)=>$<HTMLButtonElement>(id);
const area=(id:string)=>$<HTMLTextAreaElement>(id);
const show=(id:string,visible=true)=>{$(id).hidden=!visible;};
const text=(id:string,value:string)=>{$(id).textContent=value;};
type Mode='encrypt'|'decrypt'|'keys';
const secure=isSecureContext&&Boolean(globalThis.crypto?.subtle);
const titles:Record<Mode,string>={encrypt:'Encrypt a file.',decrypt:'Decrypt a file.',keys:'Make a key pair.'};
let mode:Mode='encrypt',encryptFile:File|undefined,decryptFile:File|undefined,header:AgeHeaderInfo|undefined,unlocked:AgeUnlocked|undefined;
let controller:AbortController|undefined,generated:{identity:string;recipient:string}|undefined,inspection=0,keysSupported=true;

function formatSize(size:number):string {
  if(size<1024)return `${size} B`;
  const unit=Math.min(Math.floor(Math.log(size)/Math.log(1024)),4);
  return `${(size/1024**unit).toFixed(unit>1?1:0)} ${['B','KB','MB','GB','TB'][unit]}`;
}
const message=(e:unknown)=>e instanceof Error?e.message:'Something went wrong. Please try again.';
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError'||controller?.signal.aborted===true;
function error(value:unknown){text('notice',message(value));show('notice');}
function clearMessages(){show('notice',false);show('result',false);}
function result(title:string,detail:string){text('result-title',title);text('result-detail',detail);show('result');}
const method=()=>(document.querySelector<HTMLInputElement>('input[name=method]:checked')?.value??'passphrase') as 'passphrase'|'recipients';

function setMode(next:Mode){
  if(controller)return;
  mode=next;clearMessages();
  for(const name of ['encrypt','decrypt','keys'] as const){button(`mode-${name}`).setAttribute('aria-pressed',String(name===next));show(`${name}-panel`,name===next);}
  text('card-title',titles[next]);
}
function setBusy(busy:boolean){
  busy||=!secure;
  for(const id of ['mode-encrypt','mode-decrypt','mode-keys','encrypt-zone','decrypt-zone','unlock','save-decrypted','generate','load-identity'])button(id).disabled=busy;
  for(const element of document.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('#encrypt-panel input,#encrypt-panel textarea,#decrypt-panel input,#decrypt-panel textarea'))element.disabled=busy;
  if(!keysSupported){button('generate').disabled=true;const radio=document.querySelector<HTMLInputElement>('input[name=method][value=recipients]');if(radio)radio.disabled=true;}
  if(busy)button('encrypt').disabled=true;else updateEncrypt();
}
function progress(title:string,fraction:number|undefined,detail=''){
  text('progress-title',title);text('progress-detail',detail);
  const bar=$<HTMLProgressElement>('progress');
  if(fraction===undefined){bar.removeAttribute('value');text('progress-percent','');}
  else{bar.value=fraction;text('progress-percent',`${Math.round(fraction*100)}%`);}
  show('progress-block');
}
async function run(task:(signal:AbortSignal)=>Promise<void>){
  if(controller)return;
  const active=new AbortController();controller=active;clearMessages();setBusy(true);
  try{await task(active.signal);}
  catch(e){if(aborted(e))result('Cancelled.','Nothing was saved.');else error(e);}
  finally{controller=undefined;setBusy(false);show('progress-block',false);}
}
async function* counted(source:AsyncIterable<Uint8Array<ArrayBuffer>>,total:number,report:(fraction:number)=>void){
  let done=0;
  for await(const chunk of source){done+=chunk.length;report(total?Math.min(1,done/total):1);yield chunk;}
}

/* ---------- Encrypt ---------- */
function updateEncrypt(){
  const passphrase=method()==='passphrase';
  show('passphrase-fields',passphrase);show('recipient-fields',!passphrase);
  button('encrypt').disabled=Boolean(controller)||!encryptFile||(passphrase?!input('encrypt-passphrase').value||!input('encrypt-confirm').value:!area('recipients').value.trim());
}
function chooseEncrypt(file:File|undefined){
  if(!file||controller)return;
  encryptFile=file;clearMessages();
  text('encrypt-name',file.name);text('encrypt-detail',`${formatSize(file.size)} · saves as ${file.name}${AGE_EXTENSION}`);
  updateEncrypt();
}
async function encrypt(event:SubmitEvent){
  event.preventDefault();
  const file=encryptFile;if(!file||controller)return;
  clearMessages();
  let keys:AgeEncryptKeys;
  try{
    if(method()==='passphrase'){
      const passphrase=input('encrypt-passphrase').value;
      if(passphrase!==input('encrypt-confirm').value)throw new Error('The passphrases do not match.');
      keys={passphrase};
    }else keys={recipients:parseRecipients(area('recipients').value)};
  }catch(e){error(e);return;}
  const armor=input('armor').checked,name=`${file.name}${AGE_EXTENSION}`;
  if(!canStreamToDisk()&&encryptedSizeEstimate(file.size,'recipients' in keys?keys.recipients.length:1,armor)>MEMORY_LIMIT){error('Files over 128 MiB require a browser with Save File support, such as desktop Chrome or Edge.');return;}
  let target:FileSystemFileHandle|undefined;
  // The save picker needs the click's user activation, so it opens before key derivation.
  try{target=await chooseSaveTarget(name);}catch(e){if(!aborted(e))error(e);return;}
  await run(async signal=>{
    progress('passphrase' in keys?'Deriving key':'Encrypting',0);
    const source=counted(blobChunks(file,signal),file.size,fraction=>progress('Encrypting',fraction,`${formatSize(Math.round(fraction*file.size))} of ${formatSize(file.size)}`));
    await saveChunks(target,name,'application/octet-stream',encryptAge(source,keys,{armor,signal,onKeyProgress:fraction=>progress('Deriving key',fraction,'Stretching the passphrase with scrypt.')}),signal);
    input('encrypt-passphrase').value=input('encrypt-confirm').value='';updateEncrypt();
    result('Encrypted.',`${name} is ready. ${'passphrase' in keys?'Share the passphrase separately from the file.':`It can be opened by ${keys.recipients.length===1?'the holder of that key':`any of the ${keys.recipients.length} keys`}.`}`);
  });
}

/* ---------- Decrypt ---------- */
function resetUnlock(){unlocked?.dispose();unlocked=undefined;show('unlocked',false);show('unlock-fields',Boolean(header));}
async function chooseDecrypt(file:File|undefined){
  if(!file||controller)return;
  const ticket=++inspection;decryptFile=file;header=undefined;clearMessages();resetUnlock();
  text('decrypt-name',file.name);text('decrypt-detail',`${formatSize(file.size)} · reading header…`);
  try{
    const info=await inspectAge(blobChunks(file,undefined,64*1024));
    if(ticket!==inspection)return;
    header=info;
    text('decrypt-detail',`${formatSize(file.size)} · ${info.passphrase?'passphrase':info.recipients===1?'1 recipient':`${info.recipients} recipients`}${info.armored?' · armored':''}`);
    show('decrypt-passphrase-fields',info.passphrase);show('identity-fields',!info.passphrase);show('unlock-fields');
    (info.passphrase?input('decrypt-passphrase'):area('identities')).focus();
  }catch(e){if(ticket===inspection){text('decrypt-detail',`${formatSize(file.size)} · not readable`);error(e);}}
}
async function unlock(event:SubmitEvent){
  event.preventDefault();
  const file=decryptFile,info=header;if(!file||!info||controller)return;
  await run(async signal=>{
    const keys=info.passphrase?{passphrase:input('decrypt-passphrase').value}:{identities:await parseIdentities(area('identities').value)};
    if('passphrase' in keys&&!keys.passphrase)throw new Error('Enter the passphrase.');
    progress(info.passphrase?'Deriving key':'Checking keys',info.passphrase?0:undefined);
    unlocked=await unlockAge(blobChunks(file,signal,64*1024),keys,{signal,onKeyProgress:fraction=>progress('Deriving key',fraction,'Stretching the passphrase with scrypt.')});
    input('decrypt-passphrase').value='';
    text('unlocked-detail',`Choose where to save ${decryptedName(file.name)}. The file is authenticated as it is decrypted; nothing is kept if it was damaged.`);
    show('unlock-fields',false);show('unlocked');button('save-decrypted').focus();
  });
}
async function saveDecrypted(){
  const file=decryptFile,key=unlocked;if(!file||!key||controller)return;
  const name=decryptedName(file.name);
  if(!canStreamToDisk()&&file.size>MEMORY_LIMIT+64*1024){error('Files over 128 MiB require a browser with Save File support, such as desktop Chrome or Edge.');return;}
  let target:FileSystemFileHandle|undefined;
  try{target=await chooseSaveTarget(name);}catch(e){if(!aborted(e))error(e);return;}
  await run(async signal=>{
    progress('Decrypting',0);
    const source=counted(blobChunks(file,signal),file.size,fraction=>progress('Decrypting',fraction,`${formatSize(Math.round(fraction*file.size))} of ${formatSize(file.size)}`));
    await saveChunks(target,name,'application/octet-stream',decryptAge(source,{unlocked:key},{signal}),signal);
    result('Decrypted.',`${name} was verified and saved.`);
  });
}

/* ---------- Keys ---------- */
async function generate(){
  if(controller)return;
  try{
    generated=await generateIdentity();
    input('public-key').value=generated.recipient;area('secret-key').value=generated.identity;
    show('key-result');clearMessages();
  }catch(e){error(e);}
}
async function copyPublic(){
  try{await navigator.clipboard.writeText(input('public-key').value);text('copy-public','Copied');setTimeout(()=>text('copy-public','Copy'),1600);}
  catch{input('public-key').select();}
}
function saveIdentity(){
  if(!generated)return;
  const url=URL.createObjectURL(new Blob([generated.identity],{type:'text/plain'})),anchor=document.createElement('a');
  try{anchor.href=url;anchor.download='age-identity.txt';anchor.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),30000);}
}
function useKey(){
  if(!generated)return;
  const current=area('recipients').value.trim();
  area('recipients').value=current.includes(generated.recipient)?current:`${current?`${current}\n`:''}${generated.recipient}`;
  for(const radio of document.querySelectorAll<HTMLInputElement>('input[name=method]'))radio.checked=radio.value==='recipients';
  setMode('encrypt');updateEncrypt();
}

/* ---------- Wiring ---------- */
function dropTarget(zone:string,picker:string,choose:(file:File|undefined)=>void){
  const element=button(zone);
  element.addEventListener('click',()=>input(picker).click());
  input(picker).addEventListener('change',()=>{choose(input(picker).files?.[0]);input(picker).value='';});
  element.addEventListener('dragover',event=>{event.preventDefault();element.classList.add('dragging');});
  element.addEventListener('dragleave',()=>element.classList.remove('dragging'));
  element.addEventListener('drop',event=>{event.preventDefault();element.classList.remove('dragging');const files=event.dataTransfer?.files;if(files?.length!==1){error('Drop one file at a time.');return;}choose(files[0]);});
}
for(const name of ['encrypt','decrypt','keys'] as const)button(`mode-${name}`).addEventListener('click',()=>setMode(name));
dropTarget('encrypt-zone','encrypt-input',chooseEncrypt);
dropTarget('decrypt-zone','decrypt-input',file=>void chooseDecrypt(file));
$<HTMLFormElement>('encrypt-panel').addEventListener('submit',event=>void encrypt(event));
$<HTMLFormElement>('decrypt-panel').addEventListener('submit',event=>void unlock(event));
for(const id of ['encrypt-passphrase','encrypt-confirm'])input(id).addEventListener('input',updateEncrypt);
area('recipients').addEventListener('input',updateEncrypt);
for(const radio of document.querySelectorAll<HTMLInputElement>('input[name=method]'))radio.addEventListener('change',()=>{clearMessages();updateEncrypt();});
input('show-passphrase').addEventListener('change',()=>{for(const id of ['encrypt-passphrase','encrypt-confirm'])input(id).type=input('show-passphrase').checked?'text':'password';});
button('load-identity').addEventListener('click',()=>input('identity-input').click());
input('identity-input').addEventListener('change',async()=>{
  const file=input('identity-input').files?.[0];input('identity-input').value='';
  if(!file)return;
  if(file.size>64*1024){error('That file is too large to be an age identity file.');return;}
  area('identities').value=await file.text();clearMessages();
});
button('save-decrypted').addEventListener('click',()=>void saveDecrypted());
button('cancel').addEventListener('click',()=>controller?.abort());
button('generate').addEventListener('click',()=>void generate());
button('copy-public').addEventListener('click',()=>void copyPublic());
button('save-identity').addEventListener('click',saveIdentity);
button('use-key').addEventListener('click',useKey);
window.addEventListener('beforeunload',event=>{if(controller){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{controller?.abort();unlocked?.dispose();});
void x25519Available().then(available=>{
  if(available)return;
  keysSupported=false;show('keys-unsupported');setBusy(Boolean(controller));
});
if(!secure){error('Age needs a secure (HTTPS) connection to use your browser’s cryptography.');setBusy(true);}
updateEncrypt();

import {expect,test,type Page} from '@playwright/test';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {uvfFixture,uvfPassword,decryptUvfReference} from '../../scripts/reference-uvf';
async function setup(page:Page,files=uvfFixture().files){
  await page.addInitScript(()=>Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:async(options?:{id?:string})=>{const root=await navigator.storage.getDirectory();return options?.id==='crypte-vault'?root.getDirectoryHandle('Source'):root;}}));
  await page.goto('/crypte/');
  await page.evaluate(async(files)=>{const root=await(await navigator.storage.getDirectory()).getDirectoryHandle('Source',{create:true});for(const [path,encoded] of files){let folder=root;const parts=path.split('/');for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part,{create:true});const w=await(await folder.getFileHandle(parts.at(-1)!,{create:true})).createWritable();await w.write(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)));await w.close();}},[...files].map(([path,bytes])=>[path,bytes.toString('base64')]));
  await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();
}
async function unlock(page:Page,password=uvfPassword){await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();}
async function snapshot(page:Page,name='Source'){
  return page.evaluate(async name=>{const result:Record<string,string>={};async function walk(root:FileSystemDirectoryHandle,path=''){for await(const [name,handle] of root.entries()){if(name.startsWith('.crype'))continue;const p=path?`${path}/${name}`:name;if(handle.kind==='directory')await walk(handle as FileSystemDirectoryHandle,p);else{const bytes=new Uint8Array(await(await(handle as FileSystemFileHandle).getFile()).arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);result[p]=btoa(binary);}}}await walk(await(await navigator.storage.getDirectory()).getDirectoryHandle(name));return result;},name);
}
async function review(page:Page,name:string){
  await page.getByRole('button',{name:'Migrate vault',exact:true}).click();await page.getByLabel('New vault name',{exact:true}).fill(name);await page.getByRole('button',{name:'Choose migration location'}).click();await page.getByLabel('New vault password',{exact:true}).fill('destination password');await page.getByLabel('Confirm new password',{exact:true}).fill('destination password');await page.getByRole('button',{name:'Review migration'}).click();await expect(page.getByRole('button',{name:'Create verified copy'})).toBeVisible({timeout:30000});
}
async function migrate(page:Page,name:string){await review(page,name);if(name==='Cryptomator copy')await page.screenshot({path:'test-results/migration-review-desktop.png'});await page.getByRole('button',{name:'Create verified copy'}).click();await expect(page.getByRole('heading',{name:'Every file verified'})).toBeVisible({timeout:60000});await page.getByRole('button',{name:'Open new vault'}).click();await unlock(page,'destination password');}
async function action(page:Page,name:string,label:string){await page.getByRole('button',{name:`Actions for ${name}`,exact:true}).click();await page.locator('.entry-menu-popup').getByRole('button',{name:label,exact:true}).click();}

test('UVF native imports, editing, directories and independent ciphertext verification',async({page})=>{
  await setup(page);await expect(page.locator('.vault-format')).toContainText('UVF');await unlock(page);
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('independent UVF');await page.getByRole('button',{name:'Edit text',exact:true}).click();await page.getByLabel('Edit file contents').fill('Edited in UVF.');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('.reader')).toContainText('Edited in UVF.');await page.getByRole('button',{name:'Close preview'}).click();
  const imports=[{name:'Empty import.txt',mimeType:'text/plain',buffer:Buffer.alloc(0)},{name:'Boundary.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(4*1024*1024+99,19)}];await page.getByLabel('Files to add',{exact:true}).setInputFiles(imports);await expect(page.getByRole('button',{name:'Open Boundary.bin',exact:true})).toBeVisible();
  const encrypted=await snapshot(page),clear=Object.entries(encrypted).filter(([p])=>p.endsWith('.uvf')&&!p.endsWith('vault.uvf')).map(([,b])=>decryptUvfReference(Buffer.from(b,'base64')));expect(clear.some(b=>b.equals(imports[1].buffer))).toBe(true);expect(clear.some(b=>b.toString()==='Edited in UVF.')).toBe(true);expect(clear.some(b=>b.length===0)).toBe(true);
  await page.getByRole('button',{name:'New folder',exact:true}).click();await page.getByLabel('Folder name',{exact:true}).fill('Destination');await page.getByRole('button',{name:'Create folder',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await action(page,'New folder','Move to…');await page.getByRole('button',{name:'Choose Destination',exact:true}).click();await page.getByRole('button',{name:'Move here',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await page.getByRole('button',{name:'Open Destination',exact:true}).click();await page.getByRole('button',{name:'Open New folder',exact:true}).click();await page.getByRole('button',{name:'Open café.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('seed generations');
});

test('UVF to Cryptomator to UVF migration preserves contents, links, names and source bytes',async({page})=>{
  test.setTimeout(90000);await setup(page);await unlock(page);const original=await snapshot(page);
  await migrate(page,'Cryptomator copy');expect(await snapshot(page)).toEqual(original);
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('independent UVF');await page.getByRole('button',{name:'Close preview'}).click();
  const firstCopy=await snapshot(page,'Cryptomator copy');expect(firstCopy['vault.cryptomator']).toBeDefined();expect(firstCopy['.crypte-migration-incomplete']).toBeUndefined();
  await migrate(page,'UVF copy');expect(await snapshot(page,'Cryptomator copy')).toEqual(firstCopy);expect(await snapshot(page)).toEqual(original);
  await page.getByRole('button',{name:'Open Link',exact:true}).click();await expect(page.locator('.reader')).toContainText('Field notes.txt');await page.getByRole('button',{name:'Close preview'}).click();await page.getByRole('button',{name:'Open New folder',exact:true}).click();await page.getByRole('button',{name:'Open café.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('seed generations');
});

for(const fixture of ['gcm','ctr','legacy'])test(`${fixture} migration reports long names without creating a destination`,async({page})=>{
  const paths:string[]=JSON.parse(await readFile(`tests/fixtures/${fixture}/index.json`,'utf8')),files=new Map(await Promise.all(paths.map(async p=>[p,await readFile(`tests/fixtures/${fixture}/${p}`)] as const)));
  await setup(page,files);await unlock(page,'crypte-demo');const original=await snapshot(page);await review(page,'Blocked copy');await expect(page.getByRole('alert')).toContainText('172 UTF-8 bytes');await expect(page.getByRole('button',{name:'Create verified copy'})).toBeDisabled();
  expect(await page.evaluate(async()=>{try{await(await navigator.storage.getDirectory()).getDirectoryHandle('Blocked copy');return true;}catch{return false;}})).toBe(false);expect(await snapshot(page)).toEqual(original);
});

test('cancelled migration keeps the source and marks the destination incomplete',async({page})=>{
  await setup(page);await unlock(page);const original=await snapshot(page);await review(page,'Cancelled copy');
  await page.evaluate(()=>{const original=Worker.prototype.postMessage;Worker.prototype.postMessage=function(data:any,options:any){if(data.action==='begin-readable-import'){setTimeout(()=>original.call(this,data,options),1000);return;}return original.call(this,data,options);};});
  await page.getByRole('button',{name:'Create verified copy'}).click();await expect(page.getByRole('heading',{name:'Encrypting the copy'})).toBeVisible();await page.getByRole('button',{name:'Cancel migration',exact:true}).click();await expect(page.getByRole('alert')).toContainText('incomplete destination');expect(await snapshot(page)).toEqual(original);
  await page.getByRole('button',{name:'Close migration'}).click();await page.getByRole('button',{name:'Lock vault',exact:true}).click();await page.evaluate(()=>Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:async()=> (await navigator.storage.getDirectory()).getDirectoryHandle('Cancelled copy')}));await page.getByRole('button',{name:'Choose a different vault'}).click();await expect(page.getByRole('alert')).toContainText('incomplete migration');
});

for(const fixture of ['ctr','legacy'])test(`${fixture} migrates to UVF after long names are resolved`,async({page})=>{
  test.setTimeout(60000);const paths:string[]=JSON.parse(await readFile(`tests/fixtures/${fixture}/index.json`,'utf8'));
  const files=new Map(await Promise.all(paths.filter(p=>!p.includes('.c9s/')).map(async p=>[p,await readFile(`tests/fixtures/${fixture}/${p}`)] as const)));
  await setup(page,files);await unlock(page,'crypte-demo');const original=await snapshot(page);await migrate(page,`${fixture} UVF copy`);expect(await snapshot(page)).toEqual(original);
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('FIELD NOTES');await page.getByRole('button',{name:'Close preview'}).click();await page.getByRole('button',{name:'Open Words & thoughts',exact:true}).click();await expect(page.getByRole('button',{name:'Open Empty note.txt',exact:true})).toBeVisible();
});

test('migration refuses a source changed after review without creating the destination',async({page})=>{
  const fixture=uvfFixture();await setup(page,fixture.files);await unlock(page);await review(page,'Stale copy');
  const path=[...fixture.files.keys()].find(p=>p.endsWith('symlink.uvf'))!;
  await page.evaluate(async path=>{let dir=await(await navigator.storage.getDirectory()).getDirectoryHandle('Source');const parts=path.split('/');for(const p of parts.slice(0,-1))dir=await dir.getDirectoryHandle(p);const file=await dir.getFileHandle(parts.at(-1)!);const bytes=new Uint8Array(await(await file.getFile()).arrayBuffer());bytes[bytes.length-1]^=1;const w=await file.createWritable();await w.write(bytes);await w.close();},path);
  await page.getByRole('button',{name:'Create verified copy'}).click();await expect(page.getByRole('alert')).toContainText('source changed after preflight');
  expect(await page.evaluate(async()=>{try{await(await navigator.storage.getDirectory()).getDirectoryHandle('Stale copy');return true;}catch{return false;}})).toBe(false);
});

test('migration detects validly encrypted but altered destination content',async({page})=>{
  await setup(page);await unlock(page);const original=await snapshot(page);await review(page,'Altered copy');
  await page.evaluate(()=>{const post=Worker.prototype.postMessage;Worker.prototype.postMessage=function(data:any,options:any){if(data.action==='import-chunk'&&data.args[1]?.length)data.args[1][0]^=1;return post.call(this,data,options);};});
  await page.getByRole('button',{name:'Create verified copy'}).click();await expect(page.getByRole('alert')).toContainText('Content verification failed',{timeout:30000});expect(await snapshot(page)).toEqual(original);
  expect((await snapshot(page,'Altered copy'))['.crypte-migration-incomplete']).toBeDefined();
});

test('UVF creation and format choice work on mobile without overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.addInitScript(()=>Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:()=>navigator.storage.getDirectory()}));await page.goto('/crypte/');await page.getByRole('button',{name:'Create new vault'}).click();await page.getByRole('radio',{name:/UVF/}).check();await page.getByLabel('Vault name',{exact:true}).fill('Mobile UVF');await page.getByRole('button',{name:'Choose vault location'}).click();await page.getByLabel('New vault password',{exact:true}).fill('new password');await page.getByLabel('Confirm vault password',{exact:true}).fill('new password');
  await page.screenshot({path:'test-results/uvf-create-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button',{name:'Create vault',exact:true}).click();await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();await page.getByRole('button',{name:'Lock vault',exact:true}).click();await expect(page.locator('.vault-format')).toContainText('UVF');await unlock(page,'new password');expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('UVF passkey records unlock through the actual WebAuthn PRF flow',async({page,context})=>{
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:true}});
  await setup(page);await unlock(page);await page.getByRole('button',{name:'Preferences',exact:true}).click();await page.getByRole('button',{name:'Set up passkey',exact:true}).click();await expect(page.getByText('Enabled on this app address')).toBeVisible();
  const version=await page.evaluate(()=>new Promise<number>(resolve=>{const open=indexedDB.open('crypte',1);open.onsuccess=()=>{const request=open.result.transaction('passkeys').objectStore('passkeys').getAll();request.onsuccess=()=>resolve(request.result[0].version);};}));expect(version).toBe(2);
  await page.getByRole('button',{name:'Close preferences'}).click();await page.getByRole('button',{name:'Lock vault',exact:true}).click();await page.getByRole('button',{name:'Unlock with passkey',exact:true}).click();await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
});

test('UVF opens offline through the read-only folder fallback',async({page,context})=>{
  const root=await mkdtemp(join(tmpdir(),'uvf-fixture-'));try{
    for(const [path,bytes] of uvfFixture().files){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);}
    await page.addInitScript(()=>Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:undefined}));await page.goto('/crypte/');await page.getByLabel('Vault folder',{exact:true}).setInputFiles(root);await unlock(page);
    await expect(page.getByRole('button',{name:'Add files',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Migrate vault',exact:true})).toBeDisabled();await expect(page.getByText('Media streaming ready')).toBeVisible();
    await context.setOffline(true);await page.reload();await page.getByLabel('Vault folder',{exact:true}).setInputFiles(root);await unlock(page);await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('independent UVF');
  }finally{await context.setOffline(false);await rm(root,{recursive:true,force:true});}
});

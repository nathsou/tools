import { expect,test,chromium,type Page } from '@playwright/test';
import { resolve,join } from 'node:path';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { referenceSiv } from '../../scripts/reference-siv';
import { decryptReference } from '../../scripts/reference-decrypt';
import { base32 } from '../../src/lib/bytes';
import {encryptFile,encryptedFileParts} from '../../scripts/generate-fixtures';
async function openVault(page:Page) {
  await selectFixture(page,'gcm'); await passwordUnlock(page);
  await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
  await expect(page.getByText('Media streaming ready')).toBeVisible();
}
async function selectFixture(page:Page,name='ctr') {
  await page.addInitScript(()=>{ Object.defineProperty(window,'showDirectoryPicker',{ value:undefined,configurable:true }); });
  await page.goto('/crypte/'); await page.getByLabel('Vault folder',{exact:true}).setInputFiles(resolve(`tests/fixtures/${name}`));
  await expect(page.getByLabel('Vault password')).toBeVisible();
}
async function passwordUnlock(page:Page,password='crypte-demo') {
  await page.getByLabel('Vault password').fill(password); await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
}

test('vault gallery, folder browsing, text reader, image previews and keyboard controls',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await openVault(page);
  await expect(page.locator('.file-card')).toHaveCount(10);
  await expect(page.locator('.thumbnail img')).toHaveCount(5);
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();
  await expect(page.locator('.reader')).toContainText('FIELD NOTES');
  await page.getByLabel('Find in file').fill('coffee');await expect(page.locator('.reader-line.match')).toContainText('coffee');
  await page.getByRole('button',{name:'Close preview'}).click();
  await page.getByRole('button',{name:'Open Northern light.png',exact:true}).click();
  await expect(page.locator('.image-view img')).toBeVisible();
  await expect.poll(()=>page.locator('.image-view img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(640);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Open Words & thoughts',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Words & thoughts',exact:true})).toBeVisible();
  await page.getByRole('button',{name:/Open A very long name/}).click();await expect(page.locator('.reader')).toContainText('Long filenames');
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'Open Empty note.txt',exact:true}).click();await expect(page.locator('.reader')).toBeVisible();
  expect(errors).toEqual([]);
});

test('format 8 CTR vault directory fallback and incorrect-password recovery',async({page})=>{
  await selectFixture(page);
  await passwordUnlock(page,'wrong');await expect(page.getByRole('alert')).toContainText('Incorrect password');
  await passwordUnlock(page);await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'List view'}).click();await expect(page.locator('.file-row')).toHaveCount(9);
  await page.getByLabel('Find in this folder').fill('field');await expect(page.locator('.file-row')).toHaveCount(2);
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('FIELD NOTES');
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();await expect(page.getByLabel('Vault password')).toBeVisible();await expect(page.locator('.reader')).toHaveCount(0);
  await passwordUnlock(page);await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
});

test('format 7 vault and empty-directory browsing',async({page})=>{
  await selectFixture(page,'legacy');await expect(page.getByText(/Format 7/)).toBeVisible();await passwordUnlock(page);
  await page.getByRole('button',{name:'Open Empty folder',exact:true}).click();await expect(page.getByRole('heading',{name:'This folder is empty',exact:true})).toBeVisible();
});

test('browser Back and Forward restore folders, previews, preferences and breadcrumb visits',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await openVault(page);const appURL=page.url();
  await page.getByRole('button',{name:'Open Words & thoughts',exact:true}).click();
  await page.getByRole('button',{name:'Open Empty note.txt',exact:true}).click();
  await expect(page.locator('.reader')).toBeVisible();
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Preferences'})).toBeVisible();
  await page.goBack();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.reader')).toBeVisible();
  await page.goBack();await expect(page.locator('.preview-pane')).toHaveCount(0);await expect(page.locator('.explorer-heading h1')).toHaveText('Words & thoughts');
  await page.goBack();await expect(page.locator('.explorer-heading h1')).toHaveText('All files');
  await page.goForward();await expect(page.locator('.explorer-heading h1')).toHaveText('Words & thoughts');
  await page.goForward();await expect(page.locator('.preview-title h2')).toHaveText('Empty note.txt');
  await page.goForward();await expect(page.getByRole('dialog',{name:'Preferences'})).toBeVisible();
  await page.getByRole('button',{name:'Close preferences'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Close preview'}).click();await expect(page.locator('.preview-pane')).toHaveCount(0);
  await page.locator('.breadcrumbs button').first().click();await expect(page.locator('.explorer-heading h1')).toHaveText('All files');
  await page.goBack();await expect(page.locator('.explorer-heading h1')).toHaveText('Words & thoughts');
  await page.goForward();await expect(page.locator('.explorer-heading h1')).toHaveText('All files');
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('FIELD NOTES');
  await page.keyboard.press('ArrowRight');await expect(page.locator('.preview-title h2')).not.toHaveText('Field notes.txt');
  const nextName=await page.locator('.preview-title h2').textContent();
  await page.goBack();await expect(page.locator('.preview-title h2')).toHaveText('Field notes.txt');
  await page.goForward();await expect(page.locator('.preview-title h2')).toHaveText(nextName!);
  expect(page.url()).toBe(appURL);expect(errors).toEqual([]);
  const state=await page.evaluate(()=>history.state);
  expect(Object.keys(state)).toEqual(['crypteView']);expect(state.crypteView).toMatch(/^[0-9a-f-]{36}$/);
});

test('history preserves search, filters, layout and scroll without adding entries for refresh',async({page})=>{
  await page.setViewportSize({width:1440,height:650});await openVault(page);
  await page.getByRole('button',{name:'List view',exact:true}).click();
  await page.getByLabel('Sort files').selectOption('size');
  await page.getByLabel('Find in this folder').fill('Field');
  const length=await page.evaluate(()=>history.length);
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('FIELD NOTES');
  await page.goBack();await expect(page.locator('.preview-pane')).toHaveCount(0);
  await expect(page.getByLabel('Find in this folder')).toHaveValue('Field');await expect(page.getByLabel('Sort files')).toHaveValue('size');
  await expect(page.getByRole('button',{name:'List view'})).toHaveAttribute('aria-pressed','true');
  await page.getByLabel('Find in this folder').fill('');
  await page.getByRole('button',{name:'Refresh folder'}).click();await expect(page.locator('.file-row')).toHaveCount(10);
  expect(await page.evaluate(()=>history.length)).toBe(length+1);
  await page.getByLabel('Filter files').selectOption('image');await expect(page.getByLabel('Filter files')).toHaveValue('image');
  await page.getByRole('button',{name:'Videos',exact:true}).click();await expect(page.getByLabel('Filter files')).toHaveValue('video');
  await page.goBack();await expect(page.getByLabel('Filter files')).toHaveValue('image');
  await page.goBack();await expect(page.getByLabel('Filter files')).toHaveValue('all');
  await page.getByRole('button',{name:'Gallery view'}).click();
  const scroll=await page.locator('.explorer-content').evaluate(el=>{el.scrollTop=300;return el.scrollTop;});expect(scroll).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Open Northern light.png',exact:true}).click();await expect(page.locator('.image-view img')).toBeVisible();
  await page.keyboard.press('Space');await expect(page.locator('.preview-pane')).toHaveClass(/expanded/);
  await page.goBack();await expect(page.locator('.preview-pane')).toHaveCount(0);
  await expect.poll(()=>page.locator('.explorer-content').evaluate(el=>el.scrollTop)).toBe(scroll);
  await page.goForward();await expect(page.locator('.preview-pane')).toHaveClass(/expanded/);
});

test('history cannot reopen a locked vault or revive a preview after reload',async({page})=>{
  await openVault(page);await page.getByRole('button',{name:'Open A moment in bloom.mp4',exact:true}).click();
  await expect(page.locator('video')).toBeVisible();const mediaURL=await page.locator('video').getAttribute('src');
  await page.goBack();await expect(page.locator('video')).toHaveCount(0);
  expect(await page.evaluate(async url=>(await fetch(url!)).status,mediaURL)).toBe(403);
  await page.goBack();await expect(page.getByLabel('Vault password')).toBeVisible();
  await page.goForward();await expect(page.getByLabel('Vault password')).toBeVisible();await expect(page.locator('.app-shell')).toHaveCount(0);
  await passwordUnlock(page);await expect(page.locator('.app-shell')).toBeVisible();
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toBeVisible();
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();
  await page.goBack();await expect(page.getByLabel('Vault password')).toBeVisible();await expect(page.locator('.reader')).toHaveCount(0);
  await page.goForward();await expect(page.getByLabel('Vault password')).toBeVisible();
  await passwordUnlock(page);await expect(page.locator('.app-shell')).toBeVisible();
  await page.getByRole('button',{name:'Open Words & thoughts',exact:true}).click();await expect(page.locator('.explorer-heading h1')).toHaveText('Words & thoughts');
  await page.reload();await expect(page.getByRole('heading',{name:'Open a vault',exact:true})).toBeVisible();
  await page.goBack();await expect(page.locator('.app-shell')).toHaveCount(0);await expect(page.locator('.reader')).toHaveCount(0);
});

test('rapid history traversal discards stale folder loads and new navigation replaces the forward branch',async({page})=>{
  await page.addInitScript(()=>{
    const post=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(data:any,options:any){
      if(data?.action==='list' && data.args[0]!=='' && (window as any).__delayHistoryLists){
        (window as any).__delayedHistoryList=true;
        setTimeout(()=>post.call(this,data,options),300);
      } else post.call(this,data,options);
    };
  });
  await openVault(page);
  await page.getByRole('button',{name:'Open Words & thoughts',exact:true}).click();await expect(page.locator('.explorer-heading h1')).toHaveText('Words & thoughts');
  await page.locator('.breadcrumbs button').first().click();await expect(page.locator('.explorer-heading h1')).toHaveText('All files');
  await page.evaluate(()=>{(window as any).__delayHistoryLists=true;history.back();});
  await expect.poll(()=>page.evaluate(()=>(window as any).__delayedHistoryList)).toBe(true);
  await page.goForward();await expect(page.locator('.explorer-heading h1')).toHaveText('All files');
  await expect(page.getByText('Opening this folder…')).toHaveCount(0);
  // Wait for the deliberately delayed request to finish before checking the winning view.
  await page.waitForTimeout(400);await expect(page.locator('.explorer-heading h1')).toHaveText('All files');
  await page.evaluate(()=>{(window as any).__delayHistoryLists=false;});
  await page.goBack();await expect(page.locator('.explorer-heading h1')).toHaveText('Words & thoughts');
  await page.getByRole('button',{name:'Open Empty note.txt',exact:true}).click();await expect(page.locator('.reader')).toBeVisible();
  await page.goForward();await expect(page.locator('.preview-title h2')).toHaveText('Empty note.txt');await expect(page.locator('.explorer-heading h1')).toHaveText('Words & thoughts');
});

test('video playback, seeking, range responses, worker restart, and lock revocation',async({page,context})=>{
  await openVault(page);await page.getByRole('button',{name:'Open A moment in bloom.mp4',exact:true}).click();
  const video=page.locator('video');await expect(video).toBeVisible();
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThanOrEqual(1);
  const url=await video.getAttribute('src');expect(url).toContain('/__vault__/');
  await video.evaluate(async(v:HTMLVideoElement)=>{await v.play();});
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(0.05);
  await video.evaluate((v:HTMLVideoElement)=>{v.pause();v.currentTime=Math.min(3,v.duration/2);});
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(1);
  const range=await page.evaluate(async url=>{const r=await fetch(url!,{headers:{Range:'bytes=32760-32789'}});return {status:r.status,size:(await r.arrayBuffer()).byteLength,contentRange:r.headers.get('content-range'),cache:r.headers.get('cache-control')};},url);
  expect(range.status).toBe(206);expect(range.size).toBe(30);expect(range.contentRange).toMatch(/^bytes 32760-32789\//);expect(range.cache).toBe('no-store');
  const invalid=await page.evaluate(async url=>(await fetch(url!,{headers:{Range:'bytes=999999999-'}})).status,url);expect(invalid).toBe(416);
  const cdp=await context.newCDPSession(page);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
  const restarted=await page.evaluate(async url=>(await fetch(url!,{headers:{Range:'bytes=0-15'}})).status,url);expect(restarted).toBe(206);
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();
  const locked=await page.evaluate(async url=>(await fetch(url!)).status,url);expect(locked).toBe(403);
  await expect(page.locator('video')).toHaveCount(0);
});

test('passkey enrollment and passwordless unlock with an actual WebAuthn PRF flow',async({page,context})=>{
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:true}});
  await openVault(page);await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await page.getByRole('button',{name:'Set up passkey',exact:true}).click();await expect(page.getByText('Enabled on this app address')).toBeVisible();
  const saved=await page.evaluate(async()=>new Promise<any>((resolve,reject)=>{const open=indexedDB.open('crypte',1);open.onsuccess=()=>{const req=open.result.transaction('passkeys').objectStore('passkeys').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=reject;};}));
  expect(saved).toHaveLength(1);expect(saved[0].ciphertext).toBeTruthy();expect(saved[0].password).toBeUndefined();expect(Object.keys(saved[0]).sort()).toEqual(['ciphertext','created','credentialId','iv','origin','salt','vaultId','version']);
  await page.getByRole('button',{name:'Close preferences'}).click();await page.getByRole('button',{name:'Lock vault',exact:true}).click();
  await page.getByRole('button',{name:'Unlock with passkey',exact:true}).click();await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('FIELD NOTES');
  await page.getByRole('button',{name:'Preferences',exact:true}).click();await page.getByRole('button',{name:'Remove local unlock',exact:true}).click();await expect(page.getByRole('button',{name:'Set up passkey',exact:true})).toBeVisible();
});

test('PRF-unsupported authenticators cannot save an insecure unlock record',async({page,context})=>{
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:false}});
  await openVault(page);await page.getByRole('button',{name:'Preferences',exact:true}).click();await page.getByRole('button',{name:'Set up passkey',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(/PRF|passkey request/i);await expect(page.getByText('Enabled on this app address')).toHaveCount(0);
  await page.getByRole('button',{name:'Close preferences'}).click();await page.getByRole('button',{name:'Lock vault',exact:true}).click();await expect(page.getByRole('button',{name:'Unlock with passkey'})).toHaveCount(0);await passwordUnlock(page);await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
});

test('offline startup and vault access; plaintext is never placed in the offline cache',async({page,context})=>{
  await openVault(page);await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('FIELD NOTES');
  const cached=await page.evaluate(async()=>{const urls:string[]=[];for(const name of await caches.keys())for(const req of await(await caches.open(name)).keys())urls.push(req.url);return urls;});
  expect(cached.some(u=>u.includes('__vault__'))).toBe(false);expect(cached.some(u=>u.includes('vault.worker'))).toBe(true);
  expect(cached.some(u=>u.includes('demo-vault'))).toBe(false);
  await context.setOffline(true);await page.reload();await expect(page.getByRole('heading',{name:'Open a vault',exact:true})).toBeVisible();
  await page.getByLabel('Vault folder',{exact:true}).setInputFiles(resolve('tests/fixtures/gcm'));await passwordUnlock(page);await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
});

test('mobile layout and dark theme stay within the viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/crypte/');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button',{name:'Toggle theme'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.getByLabel('Vault folder',{exact:true}).setInputFiles(resolve('tests/fixtures/gcm'));await passwordUnlock(page);await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button',{name:'Close preview'}).click();await page.getByRole('button',{name:'Open Words & thoughts',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Words & thoughts',exact:true})).toBeVisible();
  expect(await page.locator('.explorer-heading').evaluate(el=>el.scrollWidth-el.clientWidth)).toBe(0);
});

test('dotfiles and dot-folders are hidden by default and the preference persists',async({page})=>{
  await openVault(page);
  await expect(page.getByRole('button',{name:'Open .DS_Store',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Open .hidden folder',exact:true})).toHaveCount(0);
  await expect(page.locator('.explorer-heading p')).toContainText('7 files · 3 folders');
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  const hide=page.getByRole('checkbox',{name:'Hide dotfiles',exact:true});await expect(hide).toBeChecked();await hide.uncheck();
  await page.getByRole('button',{name:'Close preferences'}).click();await expect(page.locator('.file-card')).toHaveCount(12);
  await expect(page.locator('.explorer-heading p')).toContainText('8 files · 4 folders');
  await page.getByRole('button',{name:'Open .hidden folder',exact:true}).click();await expect(page.getByRole('button',{name:'Open Visible note.txt',exact:true})).toBeVisible();
  await page.locator('.breadcrumbs button').first().click();
  await page.getByRole('button',{name:'List view'}).click();await expect(page.getByRole('button',{name:'Open .DS_Store',exact:true})).toBeVisible();
  await page.getByLabel('Find in this folder').fill('.DS_Store');await expect(page.locator('.file-row')).toHaveCount(1);
  await page.reload();await page.getByLabel('Vault folder',{exact:true}).setInputFiles(resolve('tests/fixtures/gcm'));await passwordUnlock(page);
  await expect(page.getByRole('button',{name:'Open .DS_Store',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open .hidden folder',exact:true}).click();await page.locator('.breadcrumbs button').first().click();
  await page.getByRole('button',{name:'Open .DS_Store',exact:true}).click();await expect(page.getByRole('region',{name:'File preview'})).toBeVisible();
  await page.getByRole('button',{name:'Preferences',exact:true}).click();await expect(hide).not.toBeChecked();await hide.check();
  await page.getByRole('button',{name:'Close preferences'}).click();
  await expect(page.getByRole('region',{name:'File preview'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Open .DS_Store',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Open .hidden folder',exact:true})).toHaveCount(0);
  await expect(page.locator('.sidebar .folder-name')).toHaveCount(0);
  await page.getByRole('button',{name:'List view'}).click();await expect(page.locator('.file-row')).toHaveCount(10);
});

test('system theme defaults to device appearance and reacts to changes; overrides persist',async({page})=>{
  await page.emulateMedia({colorScheme:'dark'});await page.goto('/crypte/');
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  expect(await page.evaluate(()=>localStorage.getItem('crypte-theme'))).toBe('system');
  await expect(page.getByRole('button',{name:/demo|Take a look around/i})).toHaveCount(0);
  await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await openVault(page);await page.getByRole('button',{name:'Preferences',exact:true}).click();
  const appearance=page.getByLabel('Appearance');await expect(appearance).toHaveValue('system');
  await appearance.selectOption('dark');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.getByRole('button',{name:'Close preferences'}).click();await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.getByLabel('Vault folder',{exact:true}).setInputFiles(resolve('tests/fixtures/gcm'));await passwordUnlock(page);
  await page.getByRole('button',{name:'Preferences',exact:true}).click();await appearance.selectOption('light');
  await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await appearance.selectOption('system');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
});

async function nativeSource(page:Page,fixture='gcm') {
  await page.addInitScript(()=>{
    Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:async()=> (await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture')});
    Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async({suggestedName}:{suggestedName:string})=> (await navigator.storage.getDirectory()).getFileHandle(suggestedName,{create:true})});
  });
  await page.goto('/crypte/');
  // Real browser FileSystemDirectoryHandles exercise worker transfer, getFile, entries, and IDB cloning.
  const paths:string[]=JSON.parse(await readFile(`tests/fixtures/${fixture}/index.json`,'utf8'));
  const files=await Promise.all(paths.map(async path=>({path,bytes:(await readFile(resolve(`tests/fixtures/${fixture}`,path))).toString('base64')})));
  await page.evaluate(async(files)=>{
    const root=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture',{create:true});
    const paths=files.map(file=>file.path);
    for(const path of paths) {
      const parts=path.split('/');let folder=root;
      for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part,{create:true});
      const writable=await(await folder.getFileHandle(parts.at(-1)!,{create:true})).createWritable();
      const file=files.find(file=>file.path===path)!;await writable.write(Uint8Array.from(atob(file.bytes),c=>c.charCodeAt(0)));await writable.close();
    }
  },files);
}

test('native directory handles, streamed export, and remembered-vault reopening',async({page})=>{
  await nativeSource(page);
  await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('FIELD NOTES');
  const remembered=await page.evaluate(async()=>new Promise<any[]>(resolve=>{const db=indexedDB.open('crypte',1);db.onsuccess=()=>{const req=db.result.transaction('recent').objectStore('recent').getAll();req.onsuccess=()=>resolve(req.result);};}));
  expect(remembered).toHaveLength(1);
  if(/Chrome\/153\./.test(await page.evaluate(()=>navigator.userAgent)))expect(remembered[0].handle).toBeUndefined();
  await page.getByRole('button',{name:'Export file',exact:true}).click();
  await expect.poll(()=>page.evaluate(async()=>{try{return await(await(await navigator.storage.getDirectory()).getFileHandle('Field notes.txt')).getFile().then(f=>f.text());}catch{return '';}})).toContain('FIELD NOTES');
  await page.reload();await page.getByRole('button',{name:'Handle fixture',exact:true}).click();await passwordUnlock(page);
  await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
});

test('persistent handle storage and reopening in a regular browser profile',async()=>{
  const profile=await mkdtemp(join(tmpdir(),'crypte-handles-'));
  // M153 private-context deserialization is broken upstream. Use a real regular
  // profile and emulate the prior UA solely to exercise the guarded storage branch.
  const context=await chromium.launchPersistentContext(profile,{baseURL:'http://localhost:4173',userAgent:'Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36'});
  try {
    const page=context.pages()[0];await nativeSource(page);
    await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
    await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
    const remembered=await page.evaluate(async()=>new Promise<any[]>(resolve=>{const db=indexedDB.open('crypte',1);db.onsuccess=()=>{const req=db.result.transaction('recent').objectStore('recent').getAll();req.onsuccess=()=>resolve(req.result);};}));
    expect(remembered[0].handle).toBeTruthy();
    await page.reload();
    // The persisted handle must work without invoking the picker again.
    await page.evaluate(()=>Object.defineProperty(window,'showDirectoryPicker',{value:()=>{throw new Error('Unexpected picker');},configurable:true}));
    await expect(page.getByLabel('Vault password')).toBeVisible();await passwordUnlock(page);
    await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('FIELD NOTES');
  } finally {await context.close();await rm(profile,{recursive:true,force:true});}
});

test('fallback export produces the authenticated plaintext file',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
  await openVault(page);await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Export file',exact:true}).click();
  const download=await pending;expect(download.suggestedFilename()).toBe('Field notes.txt');
  expect(await readFile((await download.path())!,'utf8')).toContain('FIELD NOTES');
});

test('media access stays in its unlocking tab and auto-lock revokes it',async({page,context})=>{
  await openVault(page);await page.getByRole('button',{name:'Open A moment in bloom.mp4',exact:true}).click();
  const url=await page.locator('video').getAttribute('src');
  const other=await context.newPage();await other.goto('/crypte/');
  expect(await other.evaluate(async url=>(await fetch(url!)).status,url)).toBe(403);await other.close();
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await expect(page.getByRole('button',{name:'Close preferences'})).toBeFocused();
  await page.getByLabel('Auto-lock timeout').selectOption('1');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Preferences',exact:true})).toBeFocused();
  await page.clock.install();await page.getByRole('button',{name:'Close preview'}).click();await page.clock.fastForward(60001);
  await expect(page.getByLabel('Vault password')).toBeVisible();
  expect(await page.evaluate(async url=>(await fetch(url!)).status,url)).toBe(403);
});

const fixtureRaw=Buffer.from([...Array.from({length:32},(_,i)=>i+1),...Array.from({length:32},(_,i)=>128+i)]);
test('image and video thumbnails include decoded HEIC; unsupported files retain icons',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await selectFixture(page,'media');await passwordUnlock(page);
  const video=page.getByRole('button',{name:'Open A moment in bloom.mp4',exact:true});
  const image=page.getByRole('button',{name:'Open Sample.HEIC',exact:true});await image.scrollIntoViewIfNeeded();
  await expect(image.locator('.thumbnail img')).toBeVisible({timeout:15000});await video.scrollIntoViewIfNeeded();
  await expect(video.locator('.thumbnail img')).toBeVisible();
  expect(await video.locator('img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(480);
  await image.scrollIntoViewIfNeeded();await image.click();
  await expect(page.locator('.image-view img')).toBeVisible({timeout:15000});
  await expect.poll(()=>page.locator('.image-view img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(640);
  await expect(page.getByRole('alert')).toHaveCount(0);await page.getByRole('button',{name:'Close preview'}).click();
  const broken=page.getByRole('button',{name:'Open Invalid.heic',exact:true});await broken.click();
  await expect(page.getByRole('alert')).toContainText(/damaged|unsupported|decode/i);await page.getByRole('button',{name:'Close preview'}).click();
  await expect(broken.locator('img')).toHaveCount(0);
  const unsupported=page.getByRole('button',{name:'Open Unsupported.mp4',exact:true});await unsupported.scrollIntoViewIfNeeded();await expect(unsupported.locator('img')).toHaveCount(0);
  await page.getByRole('button',{name:'List view'}).click();await video.scrollIntoViewIfNeeded();await expect(video.locator('.thumbnail img')).toBeVisible();await image.scrollIntoViewIfNeeded();await expect(image.locator('.thumbnail img')).toBeVisible({timeout:15000});
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();await expect(page.locator('.thumbnail img')).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('HEIC decoding works on first use after offline reload',async({page,context})=>{
  await openVault(page);
  const cached=await page.evaluate(async()=>{const urls:string[]=[];for(const key of await caches.keys())for(const request of await(await caches.open(key)).keys())urls.push(request.url);return urls;});
  expect(cached.some(url=>url.includes('image.worker'))).toBe(true);
  await context.setOffline(true);await page.reload();
  await page.getByLabel('Vault folder',{exact:true}).setInputFiles(resolve('tests/fixtures/media'));await passwordUnlock(page);
  const image=page.getByRole('button',{name:'Open Sample.HEIC',exact:true});await image.scrollIntoViewIfNeeded();
  await expect(image.locator('img')).toBeVisible({timeout:15000});await image.click();
  await expect.poll(()=>page.locator('.image-view img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(640);
  const privateCache=await page.evaluate(async()=>{for(const key of await caches.keys())for(const request of await(await caches.open(key)).keys())if(/__vault__|blob:/.test(request.url))return true;return false;});
  expect(privateCache).toBe(false);
});
test('RTF opens as readable escaped text and export preserves the original document',async({page})=>{
  await selectFixture(page,'media');await passwordUnlock(page);await page.getByRole('button',{name:'Open Notes.rtf',exact:true}).click();
  const reader=page.locator('.reader');await expect(reader).toContainText('This is readable text with café and Ω Unicode.');
  await expect(reader).toContainText('😀 A smile.');await expect(reader).toContainText('<img src=x onerror=alert(1)>');
  await expect(reader.locator('img,script,a')).toHaveCount(0);await expect(reader).not.toContainText('Metadata should not appear');await expect(reader).not.toContainText('HYPERLINK');
  await page.getByLabel('Find in file').fill('café');await expect(page.locator('.reader-line.match')).toContainText('café');
  await expect(page.getByText('RTF text extracted. Formatting and embedded objects are omitted.')).toBeVisible();
  await page.evaluate(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Export file',exact:true}).click();
  const download=await pending;expect(await readFile((await download.path())!)).toEqual(await readFile('tests/assets/notes.rtf'));
});
test('Mediabunny thumbnails work without service workers',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'serviceWorker',{value:undefined,configurable:true}));
  await selectFixture(page,'gcm');await passwordUnlock(page);
  const video=page.getByRole('button',{name:'Open A moment in bloom.mp4',exact:true});await expect(video.locator('img')).toBeVisible();
  await expect(page.getByText('In-memory previews',{exact:true})).toBeVisible();
});
test('locking cancels pending HEIC workers and revokes thumbnail URLs',async({page})=>{
  await page.addInitScript(()=>{
    const active=new Set<Worker>(),urls=new Set<string>();(window as any).__imageWorkers=active;(window as any).__previewURLs=urls;
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      held=false;
      constructor(url:string|URL,options?:WorkerOptions){super(url,options);this.held=String(url).includes('image.worker');if(this.held)active.add(this);}
      postMessage(message:any,transfer?:any){if(!this.held)super.postMessage(message,transfer);}
      terminate(){active.delete(this);super.terminate();}
    };
    const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
    URL.createObjectURL=function(blob){const url=create.call(this,blob);urls.add(url);return url;};
    URL.revokeObjectURL=function(url){urls.delete(url);return revoke.call(this,url);};
  });
  await selectFixture(page,'media');await passwordUnlock(page);
  const image=page.getByRole('button',{name:'Open Sample.HEIC',exact:true});await image.scrollIntoViewIfNeeded();await image.click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__imageWorkers.size)).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();await expect(page.getByLabel('Vault password')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as any).__imageWorkers.size)).toBe(0);
  await expect.poll(()=>page.evaluate(()=>(window as any).__previewURLs.size)).toBe(0);
});
test('large video thumbnails read authenticated ranges before streaming becomes available',async({page})=>{
  await page.addInitScript(()=>{
    const register=navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register=(...args)=>new Promise(resolve=>(window as any).__enableStreaming=()=>resolve(register(...args)));
  });
  await nativeSource(page);
  const movie=decryptReference(await readFile(resolve('tests/fixtures/gcm',importPath('A moment in bloom.mp4').path)),fixtureRaw,'SIV_GCM');
  const free=Buffer.alloc(25*1024*1024);free.writeUInt32BE(free.length,0);free.write('free',4);
  const bytes=encryptFile(Buffer.concat([movie,free]),'SIV_GCM',48).toString('base64');
  await page.evaluate(async({path,bytes})=>{
    let folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture');const parts=path.split('/');
    for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part);
    const writer=await(await folder.getFileHandle(parts.at(-1)!,{create:true})).createWritable();await writer.write(Uint8Array.from(atob(bytes),c=>c.charCodeAt(0)));await writer.close();
  },{path:importPath('Large video.mp4').path,bytes});
  await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  const video=page.getByRole('button',{name:'Open Large video.mp4',exact:true});await video.scrollIntoViewIfNeeded();
  await expect(page.getByText('Starting media streaming',{exact:true})).toBeVisible();await expect(video.locator('img')).toBeVisible({timeout:15000});
  await page.evaluate(()=>(window as any).__enableStreaming());
  await expect(page.getByText('Media streaming ready')).toBeVisible();await expect(video.locator('img')).toBeVisible({timeout:15000});
});
async function largeNativeMedia(page:Page,name:string,audio=false) {
  const source=audio?importPath('Quiet tone.wav','f62696f1-08d2-4f6a-ae51-559d038731a4').path:importPath('A moment in bloom.mp4').path;
  const original=decryptReference(await readFile(resolve('tests/fixtures/gcm',source)),fixtureRaw,'SIV_GCM');
  const paddingSize=129*1024*1024,padding=Buffer.alloc(8);
  if(audio){padding.write('JUNK',0);padding.writeUInt32LE(paddingSize,4);original.writeUInt32LE(original.length+padding.length+paddingSize-8,4);}
  else{padding.writeUInt32BE(paddingSize+8,0);padding.write('free',4);}
  const prefix=Buffer.concat([original,padding]),size=prefix.length+paddingSize;
  await page.evaluate(async path=>{
    let folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture');const parts=path.split('/');
    for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part);
    (window as any).__mediaWriter=await(await folder.getFileHandle(parts.at(-1)!,{create:true})).createWritable();
  },importPath(name).path);
  // Generate and write independent ciphertext in small packets; no huge test Blob or plaintext disk file.
  let packet:Buffer[]=[],length=0;
  const flush=async()=>{const bytes=Buffer.concat(packet).toString('base64');packet=[];length=0;await page.evaluate(async bytes=>(window as any).__mediaWriter.write(Uint8Array.from(atob(bytes),c=>c.charCodeAt(0))),bytes);};
  for(const part of encryptedFileParts(size,(start,end)=>{
    const clear=Buffer.alloc(end-start);if(start<prefix.length)prefix.copy(clear,0,start,Math.min(end,prefix.length));return clear;
  },'SIV_GCM',audio?53:52)) {packet.push(part);length+=part.length;if(length>=4*1024*1024)await flush();}
  if(length)await flush();await page.evaluate(async()=>{await(window as any).__mediaWriter.close();delete(window as any).__mediaWriter;});
  return size;
}
test('video above 128 MiB waits for startup, streams and revokes access on close',async({page})=>{
  test.setTimeout(60000);
  await page.addInitScript(()=>{
    const register=navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register=(...args)=>new Promise(resolve=>(window as any).__enableStreaming=()=>resolve(register(...args)));
    const create=URL.createObjectURL;(window as any).__largestBlob=0;
    URL.createObjectURL=function(blob){(window as any).__largestBlob=Math.max((window as any).__largestBlob,blob.size);return create.call(this,blob);};
  });
  await nativeSource(page);const size=await largeNativeMedia(page,'Long video.mp4');expect(size).toBeGreaterThan(128*1024*1024);
  // Fixture preparation can exceed the app's startup timeout. Start the gated
  // startup with the completed ciphertext already in OPFS, as a real vault is.
  await page.reload();
  await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  await page.getByRole('button',{name:'Open Long video.mp4',exact:true}).click();
  await expect(page.getByText('Preparing local media streaming…')).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(()=>(window as any).__enableStreaming());
  const video=page.locator('video');await expect(video).toBeVisible();
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThanOrEqual(1);
  await video.evaluate(async(v:HTMLVideoElement)=>{await v.play();});await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(0.05);
  const url=await video.getAttribute('src');expect(url).toContain('/__vault__/');
  const tail=await page.evaluate(async({url,size})=>{const response=await fetch(url!,{headers:{Range:`bytes=${size-4}-${size-1}`}});return {status:response.status,bytes:Array.from(new Uint8Array(await response.arrayBuffer()))};},{url,size});
  expect(tail).toEqual({status:206,bytes:[0,0,0,0]});
  expect(await page.evaluate(()=>(window as any).__largestBlob)).toBeLessThan(128*1024*1024);
  await page.getByRole('button',{name:'Close preview'}).click();expect(await page.evaluate(async url=>(await fetch(url!)).status,url)).toBe(403);
});
test('audio above 128 MiB shows streaming failure and Retry streaming recovers playback',async({page})=>{
  test.setTimeout(60000);
  await page.addInitScript(()=>{
    const register=navigator.serviceWorker.register.bind(navigator.serviceWorker);(window as any).__blockStreaming=true;
    navigator.serviceWorker.register=(...args)=>(window as any).__blockStreaming?Promise.reject(new DOMException('Service workers blocked by this browser setting.','SecurityError')):register(...args);
  });
  await nativeSource(page);expect(await largeNativeMedia(page,'Long audio.wav',true)).toBeGreaterThan(128*1024*1024);
  await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  await page.getByRole('button',{name:'Open Long audio.wav',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('needs streaming');await expect(page.getByText(/Media streaming could not start:.*Service workers blocked/)).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText('too large for an in-memory preview');
  await page.evaluate(()=>(window as any).__blockStreaming=false);await page.getByRole('button',{name:'Retry streaming',exact:true}).click();
  const audio=page.locator('audio');await expect(audio).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(()=>audio.evaluate((v:HTMLAudioElement)=>v.readyState)).toBeGreaterThanOrEqual(1);
  expect(await audio.getAttribute('src')).toContain('/__vault__/');await audio.evaluate(async(v:HTMLAudioElement)=>{await v.play();});
  await expect.poll(()=>audio.evaluate((v:HTMLAudioElement)=>v.currentTime)).toBeGreaterThan(0.05);
});
test('unsupported streaming is explained while small media keeps a bounded fallback',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'serviceWorker',{value:undefined,configurable:true}));
  await selectFixture(page,'gcm');await passwordUnlock(page);await page.getByRole('button',{name:'Open A moment in bloom.mp4',exact:true}).click();
  await expect(page.locator('video')).toBeVisible();expect(await page.locator('video').getAttribute('src')).toMatch(/^blob:/);
  await expect(page.getByText('This browser does not provide service workers here. Open the app in a browser window that allows them.')).toBeVisible();
  await page.getByRole('button',{name:'Retry streaming',exact:true}).click();await expect(page.locator('video')).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
});
function importPath(name:string,id='') {
  const siv=Buffer.concat([fixtureRaw.subarray(32),fixtureRaw.subarray(0,32)]);
  const hash=base32(createHash('sha1').update(referenceSiv(siv,Buffer.from(id))).digest());
  const encrypted=referenceSiv(siv,Buffer.from(name.normalize('NFC')),Buffer.from(id)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_')+'.c9r';
  const root=`d/${hash.slice(0,2)}/${hash.slice(2)}`;
  const short=createHash('sha1').update(encrypted).digest('base64').replace(/\+/g,'-').replace(/\//g,'_')+'.c9s';
  return {path:encrypted.length>220 ? `${root}/${short}/contents.c9r` : `${root}/${encrypted}`,encrypted,shortened:encrypted.length>220};
}
async function nativeBytes(page:Page,path:string):Promise<Buffer> {
  const bytes=await page.evaluate(async path=>{
    let folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture');const parts=path.split('/');
    for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part);
    return Array.from(new Uint8Array(await(await(await folder.getFileHandle(parts.at(-1)!)).getFile()).arrayBuffer()));
  },path);return Buffer.from(bytes);
}
for(const fixture of ['gcm','ctr','legacy'])test(`${fixture} adds files without replacing existing data, including long names and nested folders`,async({page})=>{
  await nativeSource(page,fixture);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  const original=await nativeBytes(page,importPath('Field notes.txt').path);
  await expect(page.getByRole('button',{name:'Add files',exact:true})).toBeEnabled();
  const long='Long import '+ 'x'.repeat(200)+'.txt',large=Buffer.from('vault data across chunks\n'.repeat(4000));
  await page.locator('input[aria-label="Files to add"]').setInputFiles([
    {name:'Field notes.txt',mimeType:'text/plain',buffer:Buffer.from('Keep both copies')},
    {name:'Field notes.txt',mimeType:'text/plain',buffer:Buffer.from('Third copy')},
    {name:'Empty import.txt',mimeType:'text/plain',buffer:Buffer.alloc(0)},
    {name:long,mimeType:'text/plain',buffer:large}
  ]);
  await expect(page.getByText('Added 4 files.',{exact:true})).toBeVisible();
  expect(await nativeBytes(page,importPath('Field notes.txt').path)).toEqual(original);
  const scheme=fixture==='gcm'?'SIV_GCM':'SIV_CTRMAC';
  for(const [name,expected] of [['Field notes (2).txt',Buffer.from('Keep both copies')],['Field notes (3).txt',Buffer.from('Third copy')],['Empty import.txt',Buffer.alloc(0)],[long,large]] as const) {
    const plan=importPath(name),ciphertext=await nativeBytes(page,plan.path);
    expect(decryptReference(ciphertext,fixtureRaw,scheme)).toEqual(expected);
    if(plan.shortened)expect((await nativeBytes(page,plan.path.replace('contents.c9r','name.c9s'))).toString()).toBe(plan.encrypted);
  }
  await page.getByRole('button',{name:'Open Field notes (2).txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('Keep both copies');
  await page.getByRole('button',{name:'Close preview'}).click();await page.getByRole('button',{name:'Open Words & thoughts',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Words & thoughts',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Add files',exact:true})).toBeEnabled();
  await page.locator('input[aria-label="Files to add"]').setInputFiles({name:'Nested import.txt',mimeType:'text/plain',buffer:Buffer.from('Inside the selected folder')});
  await expect(page.getByText('Added 1 file.',{exact:true})).toBeVisible();
  expect(decryptReference(await nativeBytes(page,importPath('Nested import.txt','f20d83b5-c3b6-484e-a5c1-3d3b90c6c23e').path),fixtureRaw,scheme).toString()).toBe('Inside the selected folder');
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();await passwordUnlock(page);
  await expect(page.getByRole('button',{name:'Open Field notes (3).txt',exact:true})).toBeVisible();
});

test('fallback vaults remain read-only and denied write permission leaves the vault unchanged',async({page})=>{
  await openVault(page);await expect(page.getByRole('button',{name:'Add files',exact:true})).toBeDisabled();
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  await page.evaluate(()=>{
    FileSystemDirectoryHandle.prototype.queryPermission=async(options:any)=>options?.mode==='readwrite'?'denied':'granted';
    FileSystemDirectoryHandle.prototype.requestPermission=async()=> 'denied';
  });
  await page.getByRole('button',{name:'Add files',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Write access was not granted');
  await expect(page.locator('.file-card')).toHaveCount(10);
});

test('locking during an import aborts writes and cleans up temporary ciphertext',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  await expect(page.getByRole('button',{name:'Add files',exact:true})).toBeEnabled();
  await page.evaluate(()=>{
    const write=FileSystemWritableFileStream.prototype.write;
    const gate=new Promise<void>(resolve=>(window as any).__releaseImport=resolve);
    FileSystemWritableFileStream.prototype.write=async function(data){await gate;return write.call(this,data);};
  });
  await page.locator('input[aria-label="Files to add"]').setInputFiles({name:'Cancelled import.txt',mimeType:'text/plain',buffer:Buffer.alloc(8*1024*1024,0x41)});
  await expect(page.getByRole('progressbar',{name:'File import progress'})).toBeVisible();
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();await expect(page.getByLabel('Vault password')).toBeVisible();
  await page.evaluate(()=>(window as any).__releaseImport());
  await expect.poll(async()=>page.evaluate(async()=>{
    let folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture');
    const names:string[]=[];const walk=async(handle:FileSystemDirectoryHandle)=>{for await(const [name,entry] of(handle as any).entries()){names.push(name);if(entry.kind==='directory')await walk(entry);}};
    await walk(folder);return names.some(name=>name.startsWith('.crypte-import-'));
  })).toBe(false);
  await passwordUnlock(page);await expect(page.getByRole('button',{name:'Open Cancelled import.txt',exact:true})).toHaveCount(0);
});

test('browser Back cancels an active import without replacing the restored folder listing',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  await page.getByRole('button',{name:'Open Words & thoughts',exact:true}).click();await expect(page.locator('.explorer-heading h1')).toHaveText('Words & thoughts');
  await page.evaluate(()=>{
    const write=FileSystemWritableFileStream.prototype.write;
    const gate=new Promise<void>(resolve=>(window as any).__releaseImport=resolve);
    FileSystemWritableFileStream.prototype.write=async function(data){(window as any).__importWriting=true;await gate;return write.call(this,data);};
  });
  await page.locator('input[aria-label="Files to add"]').setInputFiles({name:'Cancelled history import.txt',mimeType:'text/plain',buffer:Buffer.alloc(8*1024*1024,0x41)});
  await expect.poll(()=>page.evaluate(()=>(window as any).__importWriting)).toBe(true);
  await page.goBack();await expect(page.locator('.explorer-heading h1')).toHaveText('All files');
  await page.evaluate(()=>(window as any).__releaseImport());
  await expect(page.getByRole('progressbar',{name:'File import progress'})).toHaveCount(0);
  await expect(page.locator('.file-card')).toHaveCount(10);await expect(page.getByRole('alert')).toHaveCount(0);
  await page.goForward();await expect(page.locator('.explorer-heading h1')).toHaveText('Words & thoughts');
  await expect(page.getByRole('button',{name:'Open Cancelled history import.txt',exact:true})).toHaveCount(0);
  const temporary=await page.evaluate(async()=>{
    const root=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture');
    const names:string[]=[];const walk=async(folder:FileSystemDirectoryHandle)=>{for await(const [name,entry] of(folder as any).entries()){names.push(name);if(entry.kind==='directory')await walk(entry);}};
    await walk(root);return names.filter(name=>name.startsWith('.crypte-import-'));
  });expect(temporary).toEqual([]);
});

async function fileAction(page:Page,name:string,action:'Rename'|'Move to…'|'Delete') {
  await page.getByRole('button',{name:`Actions for ${name}`,exact:true}).click();await page.locator('.entry-menu-popup').getByRole('button',{name:action,exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('entry menus appear on hover and keyboard focus, stay open, and remain available on touchscreens',async({page,browser})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  const actions=page.getByRole('button',{name:'Actions for Field notes.txt',exact:true}),menu=actions.locator('..');
  await page.locator('.explorer-heading h1').hover();await expect(menu).toHaveCSS('opacity','0');
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).hover();await expect(menu).toHaveCSS('opacity','1');
  await actions.click();await page.locator('.explorer-heading h1').hover();await expect(menu).toHaveCSS('opacity','1');
  await expect(page.locator('.entry-menu-popup')).toBeVisible();await page.keyboard.press('Escape');
  await page.getByLabel('Find in this folder').focus();await expect(menu).toHaveCSS('opacity','0');
  await actions.focus();await expect(menu).toHaveCSS('opacity','1');
  await page.getByRole('button',{name:'List view',exact:true}).click();await page.locator('.explorer-heading h1').hover();
  await expect(menu).toHaveCSS('opacity','0');await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).hover();await expect(menu).toHaveCSS('opacity','1');
  const touch=await browser.newContext({baseURL:'http://localhost:4173',hasTouch:true,viewport:{width:390,height:844}});
  try{const mobile=await touch.newPage();await nativeSource(mobile);await mobile.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(mobile);
    expect(await mobile.evaluate(()=>matchMedia('(hover: none)').matches)).toBe(true);
    await expect(mobile.getByRole('button',{name:'Actions for Field notes.txt',exact:true}).locator('..')).toHaveCSS('opacity','1');
  }finally{await touch.close();}
});

test('video thumbnails seek beyond the intro and cached thumbnails survive navigation but are cleared on lock',async({page})=>{
  await page.addInitScript(()=>{
    const reads:Record<string,number>={},urls=new Set<string>(),seeks:number[]=[];
    Object.assign(window,{__thumbnailReads:reads,__thumbnailURLs:urls,__thumbnailSeeks:seeks});
    const post=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(data:any,options:any){if(data?.action==='read')reads[data.args[0]]=(reads[data.args[0]]??0)+1;post.call(this,data,options);};
    const decode=VideoDecoder.prototype.decode;VideoDecoder.prototype.decode=function(chunk){seeks.push(chunk.timestamp/1e6);decode.call(this,chunk);};
    const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
    URL.createObjectURL=function(blob){const url=create.call(this,blob);urls.add(url);return url;};
    URL.revokeObjectURL=function(url){urls.delete(url);return revoke.call(this,url);};
  });
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  const video=page.getByRole('button',{name:'Open A moment in bloom.mp4',exact:true}),image=page.getByRole('button',{name:'Open Northern light.png',exact:true});
  await expect(video.locator('img')).toBeVisible();await expect(image.locator('img')).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__thumbnailSeeks.some((time:number)=>time>1))).toBe(true);
  const paths=[importPath('A moment in bloom.mp4').path,importPath('Northern light.png').path];
  const counts=()=>page.evaluate(paths=>paths.map(path=>(window as any).__thumbnailReads[path]??0),paths);
  const initial=await counts(),oldURL=await video.locator('img').getAttribute('src');expect(initial.every(value=>value>0)).toBe(true);
  for(const view of ['List view','Gallery view']){await page.getByRole('button',{name:view,exact:true}).click();await video.scrollIntoViewIfNeeded();await expect(video.locator('img')).toBeVisible();await image.scrollIntoViewIfNeeded();await expect(image.locator('img')).toBeVisible();expect(await counts()).toEqual(initial);}
  await page.getByRole('button',{name:'Open Words & thoughts',exact:true}).click();await expect(page.locator('.explorer-heading h1')).toHaveText('Words & thoughts');
  await page.goBack();await expect(video.locator('img')).toBeVisible();await expect(image.locator('img')).toBeVisible();expect(await counts()).toEqual(initial);
  const replacement=encryptFile(decryptReference(await readFile(resolve('tests/fixtures/gcm',importPath('Desert afternoon.png').path)),fixtureRaw,'SIV_GCM'),'SIV_GCM',77).toString('base64');
  await page.evaluate(async({path,bytes})=>{let folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture');const parts=path.split('/');for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part);const writer=await(await folder.getFileHandle(parts.at(-1)!)).createWritable();await writer.write(Uint8Array.from(atob(bytes),c=>c.charCodeAt(0)));await writer.close();},{path:paths[1],bytes:replacement});
  await page.getByRole('button',{name:'Refresh folder',exact:true}).click();await expect(image.locator('img')).toBeVisible();
  const refreshed=await counts();expect(refreshed[1]).toBeGreaterThan(initial[1]);expect(refreshed[0]).toBe(initial[0]);
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();await expect(page.getByLabel('Vault password')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as any).__thumbnailURLs.size)).toBe(0);
  expect(await page.evaluate(async url=>{try{await fetch(url!);return true;}catch{return false;}},oldURL)).toBe(false);
  await passwordUnlock(page);await expect(video.locator('img')).toBeVisible();await expect(image.locator('img')).toBeVisible();
  const next=await counts();expect(next).toEqual(refreshed);
  expect(await page.evaluate(async()=>{for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())if(/blob:|__vault__/.test(request.url))return true;return false;})).toBe(false);
});
async function createFolder(page:Page,name:string) {
  await page.getByRole('button',{name:'New folder',exact:true}).click();await page.getByLabel('Folder name',{exact:true}).fill(name);
  await page.getByRole('button',{name:'Create folder',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:`Open ${name}`,exact:true})).toBeVisible();
}
async function folderId(page:Page,name:string,parentId=''):Promise<string> {
  const path=importPath(name,parentId).path;return(await nativeBytes(page,path.endsWith('/contents.c9r')?path.replace('/contents.c9r','/dir.c9r'):`${path}/dir.c9r`)).toString();
}
async function nativeHas(page:Page,path:string):Promise<boolean> {
  return page.evaluate(async path=>{try{let folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture');const parts=path.split('/');for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part);try{await folder.getFileHandle(parts.at(-1)!);}catch(error){if(error instanceof DOMException&&error.name==='TypeMismatchError')await folder.getDirectoryHandle(parts.at(-1)!);else throw error;}return true;}catch{return false;}},path);
}
function contentPath(id:string):string {const hash=base32(createHash('sha1').update(referenceSiv(Buffer.concat([fixtureRaw.subarray(32),fixtureRaw.subarray(0,32)]),Buffer.from(id))).digest());return `d/${hash.slice(0,2)}/${hash.slice(2)}`;}

for(const fixture of ['gcm','ctr','legacy'])test(`${fixture} creates, renames, moves and deletes files and folders with Cryptomator-compatible ciphertext`,async({page})=>{
  await nativeSource(page,fixture);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  const original=await nativeBytes(page,importPath('Field notes.txt').path),master=await nativeBytes(page,'masterkey.cryptomator');
  await createFolder(page,'Destination');const destinationId=await folderId(page,'Destination');
  expect(decryptReference(await nativeBytes(page,`${contentPath(destinationId)}/dirid.c9r`),fixtureRaw,fixture==='gcm'?'SIV_GCM':'SIV_CTRMAC').toString()).toBe(destinationId);
  await fileAction(page,'Field notes.txt','Move to…');await page.getByRole('button',{name:'Choose Destination',exact:true}).click();await page.getByRole('button',{name:'Move here',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);await page.getByRole('button',{name:'Open Destination',exact:true}).click();
  await expect(page.getByRole('button',{name:'Open Field notes.txt',exact:true})).toBeVisible();expect(await nativeBytes(page,importPath('Field notes.txt',destinationId).path)).toEqual(original);expect(await nativeHas(page,importPath('Field notes.txt').path)).toBe(false);
  const long='Renamed '+ 'x'.repeat(200)+'.txt';await fileAction(page,'Field notes.txt','Rename');await page.getByLabel('New name').fill(long);await page.getByRole('dialog').getByRole('button',{name:'Rename',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:`Open ${long}`,exact:true})).toBeVisible();
  expect(await nativeBytes(page,importPath(long,destinationId).path)).toEqual(original);
  await fileAction(page,long,'Rename');await page.getByLabel('New name').fill('Short.txt');await page.getByRole('dialog').getByRole('button',{name:'Rename',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);await page.getByRole('button',{name:'Open Short.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('FIELD NOTES');
  expect(await nativeBytes(page,importPath('Short.txt',destinationId).path)).toEqual(original);
  await fileAction(page,'Short.txt','Delete');await page.getByRole('button',{name:'Delete permanently',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Open Short.txt',exact:true})).toHaveCount(0);expect(await nativeHas(page,importPath('Short.txt',destinationId).path)).toBe(false);
  await page.locator('.breadcrumbs button').first().click();
  const wordsId=await folderId(page,'Words & thoughts'),wordsCipher=await nativeBytes(page,importPath('Across the chunks.txt',wordsId).path);
  await fileAction(page,'Words & thoughts','Move to…');await expect(page.getByRole('button',{name:'Choose Words & thoughts',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Choose Destination',exact:true}).click();await page.getByRole('button',{name:'Move here',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Open Destination',exact:true}).click();await page.getByRole('button',{name:'Open Words & thoughts',exact:true}).click();
  await expect(page.getByRole('button',{name:'Open Across the chunks.txt',exact:true})).toBeVisible();expect(await nativeBytes(page,importPath('Across the chunks.txt',wordsId).path)).toEqual(wordsCipher);expect(await folderId(page,'Words & thoughts',destinationId)).toBe(wordsId);
  await page.locator('.breadcrumbs button').first().click();await fileAction(page,'Destination','Delete');await page.getByRole('button',{name:'Delete permanently',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Open Destination',exact:true})).toHaveCount(0);expect(await nativeHas(page,contentPath(destinationId))).toBe(false);expect(await nativeHas(page,contentPath(wordsId))).toBe(false);
  expect(await nativeBytes(page,'masterkey.cryptomator')).toEqual(master);
});

test('folder uploads preserve hierarchy and empty folders, merge folders and retain originals',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  await page.evaluate(async()=>{
    const source=await(await navigator.storage.getDirectory()).getDirectoryHandle('Upload folder',{create:true});
    await source.getDirectoryHandle('Empty',{create:true});const nested=await source.getDirectoryHandle('Nested',{create:true});
    for(const [folder,name,text] of [[source,'Note.txt','Root document'],[nested,'Deep.txt','Nested document'],[nested,'.hidden.txt','Hidden document']] as [FileSystemDirectoryHandle,string,string][]){const writer=await(await folder.getFileHandle(name,{create:true})).createWritable();await writer.write(text);await writer.close();}
    Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:async()=>source});
  });
  await page.getByRole('button',{name:'Add folder',exact:true}).click();await expect(page.getByText('Folder imported. Added 3 files.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open Upload folder',exact:true}).click();await expect(page.getByRole('button',{name:'Open Empty',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open Empty',exact:true}).click();await expect(page.getByRole('heading',{name:'This folder is empty',exact:true})).toBeVisible();
  await page.locator('.breadcrumbs button').nth(1).click();await page.getByRole('button',{name:'Open Nested',exact:true}).click();
  await page.getByRole('button',{name:'Open Deep.txt',exact:true}).click();await expect(page.locator('.reader')).toHaveText(/Nested document/);
  const uploaded=await folderId(page,'Upload folder'),nested=await folderId(page,'Nested',uploaded);
  expect(decryptReference(await nativeBytes(page,importPath('.hidden.txt',nested).path),fixtureRaw,'SIV_GCM').toString()).toBe('Hidden document');
  expect(await page.evaluate(async()=>await(await(await(await navigator.storage.getDirectory()).getDirectoryHandle('Upload folder')).getFileHandle('Note.txt')).getFile().then(file=>file.text()))).toBe('Root document');
  await page.locator('.breadcrumbs button').first().click();await page.getByRole('button',{name:'Add folder',exact:true}).click();await expect(page.getByText('Folder imported. Added 3 files.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open Upload folder',exact:true}).click();await expect(page.getByRole('button',{name:'Open Note (2).txt',exact:true})).toBeVisible();
});

test('bulk selection and drag-and-drop move encrypted files, including symlinks without following them',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await createFolder(page,'Target');
  await page.getByRole('checkbox',{name:'Select Field notes.txt',exact:true}).check();await page.getByRole('checkbox',{name:'Select Link to field notes',exact:true}).check();
  await page.getByRole('button',{name:'Move selected',exact:true}).click();await page.getByRole('button',{name:'Choose Target',exact:true}).click();await page.getByRole('button',{name:'Move here',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Open Northern light.png',exact:true}).dragTo(page.getByRole('button',{name:'Open Target',exact:true}));
  await expect(page.getByText('Moved 1 item.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Open Target',exact:true}).click();
  await expect(page.getByRole('button',{name:'Open Northern light.png',exact:true})).toBeVisible();await page.getByRole('button',{name:'Open Link to field notes',exact:true}).click();await expect(page.locator('.reader')).toContainText('Field notes.txt');
  await page.getByRole('button',{name:'List view'}).click();await page.getByRole('button',{name:'Select items',exact:true}).click();await page.getByRole('checkbox',{name:'Select all visible items',exact:true}).check();
  await page.getByRole('button',{name:'Delete selected',exact:true}).click();await page.getByRole('button',{name:'Delete permanently',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('heading',{name:'This folder is empty',exact:true})).toBeVisible();
});

test('name collisions, invalid names, and denied permission never replace existing vault data',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);const original=await nativeBytes(page,importPath('Field notes.txt').path);
  await fileAction(page,'Field notes.txt','Rename');await page.getByLabel('New name').fill('Northern light.png');await page.getByRole('dialog').getByRole('button',{name:'Rename',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('already exists');
  await page.getByLabel('New name').fill('../masterkey.cryptomator');await page.getByRole('dialog').getByRole('button',{name:'Rename',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('name');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();expect(await nativeBytes(page,importPath('Field notes.txt').path)).toEqual(original);
  await page.evaluate(()=>{FileSystemDirectoryHandle.prototype.queryPermission=async()=> 'denied';FileSystemDirectoryHandle.prototype.requestPermission=async()=> 'denied';});
  await page.getByRole('button',{name:'New folder',exact:true}).click();await page.getByLabel('Folder name').fill('Denied');await page.getByRole('button',{name:'Create folder',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Write access was not granted');
  expect(await nativeHas(page,importPath('Denied').path)).toBe(false);expect(await nativeBytes(page,importPath('Field notes.txt').path)).toEqual(original);
});

test('a failed encrypted-copy verification removes the destination and preserves the source',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await createFolder(page,'Target');
  const id=await folderId(page,'Target'),original=await nativeBytes(page,importPath('Field notes.txt').path);
  await page.evaluate(()=>{const write=FileSystemWritableFileStream.prototype.write;FileSystemWritableFileStream.prototype.write=async function(data){if(data instanceof Uint8Array)data[0]^=1;return write.call(this,data);};});
  await fileAction(page,'Field notes.txt','Move to…');await page.getByRole('button',{name:'Choose Target',exact:true}).click();await page.getByRole('button',{name:'Move here',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('could not be verified');expect(await nativeBytes(page,importPath('Field notes.txt').path)).toEqual(original);expect(await nativeHas(page,importPath('Field notes.txt',id).path)).toBe(false);
});

test('canceling and locking during a move cleans up the copy while retaining original ciphertext',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await createFolder(page,'Target');
  const id=await folderId(page,'Target'),original=await nativeBytes(page,importPath('Field notes.txt').path);
  await page.evaluate(()=>{const write=FileSystemWritableFileStream.prototype.write;const gate=new Promise<void>(resolve=>(window as any).__releaseMove=resolve);FileSystemWritableFileStream.prototype.write=async function(data){(window as any).__moveWriting=true;await gate;return write.call(this,data);};});
  await fileAction(page,'Field notes.txt','Move to…');await page.getByRole('button',{name:'Choose Target',exact:true}).click();await page.getByRole('button',{name:'Move here',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__moveWriting)).toBe(true);
  await page.getByRole('button',{name:'Cancel operation',exact:true}).click();await page.getByRole('button',{name:'Lock vault',exact:true}).click();await page.evaluate(()=>(window as any).__releaseMove());
  await expect.poll(()=>nativeHas(page,importPath('Field notes.txt',id).path)).toBe(false);expect(await nativeBytes(page,importPath('Field notes.txt').path)).toEqual(original);await expect(page.getByLabel('Vault password')).toBeVisible();
});

test('source removal failure retains the verified destination and the original',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await createFolder(page,'Target');const id=await folderId(page,'Target'),path=importPath('Field notes.txt').path,original=await nativeBytes(page,path);
  await page.evaluate(name=>{const remove=FileSystemDirectoryHandle.prototype.removeEntry;FileSystemDirectoryHandle.prototype.removeEntry=function(entry,options){if(entry===name)return Promise.reject(new DOMException('Simulated source-removal failure','NotAllowedError'));return remove.call(this,entry,options);};},path.split('/').at(-1)!);
  await fileAction(page,'Field notes.txt','Move to…');await page.getByRole('button',{name:'Choose Target',exact:true}).click();await page.getByRole('button',{name:'Move here',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('destination has been kept');
  expect(await nativeBytes(page,path)).toEqual(original);expect(await nativeBytes(page,importPath('Field notes.txt',id).path)).toEqual(original);
});

test('long folder renames, moves and deletions keep browser history valid',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  const long='Folder '+ 'z'.repeat(205);await createFolder(page,long);const id=await folderId(page,long);
  await page.getByRole('button',{name:`Open ${long}`,exact:true}).click();await createFolder(page,'Child');const childId=await folderId(page,'Child',id);
  await page.getByRole('button',{name:'Open Child',exact:true}).click();await expect(page.getByRole('heading',{name:'This folder is empty',exact:true})).toBeVisible();
  await page.locator('.breadcrumbs button').first().click();await fileAction(page,long,'Rename');await page.getByLabel('New name').fill('Renamed folder');await page.getByRole('dialog').getByRole('button',{name:'Rename',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await folderId(page,'Renamed folder')).toBe(id);
  await page.goBack();await expect(page.locator('.explorer-heading h1')).toHaveText('Child');await expect(page.locator('.breadcrumbs')).toContainText('Renamed folder');await expect(page.locator('.breadcrumbs')).not.toContainText(long);
  await page.goForward();await expect(page.locator('.explorer-heading h1')).toHaveText('All files');await createFolder(page,'Destination');
  await fileAction(page,'Renamed folder','Move to…');await page.getByRole('button',{name:'Choose Destination',exact:true}).click();await page.getByRole('button',{name:'Move here',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goBack();await expect(page.locator('.explorer-heading h1')).toHaveText('Child');await expect(page.locator('.breadcrumbs')).toContainText('Destination');
  await page.goForward();await expect(page.locator('.explorer-heading h1')).toHaveText('All files');await fileAction(page,'Destination','Delete');await page.getByRole('button',{name:'Delete permanently',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goBack();await expect(page.locator('.explorer-heading h1')).toHaveText('All files');await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await nativeHas(page,contentPath(id))).toBe(false);expect(await nativeHas(page,contentPath(childId))).toBe(false);
});

test('read-only vaults expose disabled management controls and refuse importing the encrypted vault itself',async({page})=>{
  await openVault(page);await expect(page.getByRole('button',{name:'New folder',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Add folder',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Actions for Field notes.txt',exact:true})).toBeDisabled();
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  await page.getByRole('button',{name:'Add folder',exact:true}).click();await expect(page.getByRole('alert')).toContainText('outside the encrypted vault');await expect(page.locator('.file-card')).toHaveCount(10);
});

async function startEditing(page:Page,name='Field notes.txt') {
  await page.getByRole('button',{name:`Open ${name}`,exact:true}).click();await page.getByRole('button',{name:'Edit text',exact:true}).click();await expect(page.getByLabel('Edit file contents')).toBeVisible();
}
async function editArtifacts(page:Page):Promise<string[]> {
  return page.evaluate(async()=>{const root=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture'),names:string[]=[];async function walk(folder:FileSystemDirectoryHandle){for await(const [name,entry] of(folder as any).entries()){if(name.startsWith('.crypte-edit-'))names.push(name);if(entry.kind==='directory')await walk(entry);}}await walk(root);return names;});
}
for(const fixture of ['gcm','ctr','legacy'])test(`${fixture} edits text in place with fresh ciphertext, including empty files and shortened entries`,async({page})=>{
  await nativeSource(page,fixture);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  const path=importPath('Field notes.txt').path,original=await nativeBytes(page,path),master=await nativeBytes(page,'masterkey.cryptomator');
  await startEditing(page);await page.getByLabel('Edit file contents').fill('Edited café Ω 😀\n<script>alert(1)</script>\n');await page.keyboard.press('Control+s');
  await expect(page.getByLabel('Edit file contents')).toHaveCount(0);await expect(page.locator('.reader')).toContainText('Edited café Ω 😀');await expect(page.locator('.reader script')).toHaveCount(0);
  const saved=await nativeBytes(page,path);expect(saved).not.toEqual(original);expect(decryptReference(saved,fixtureRaw,fixture==='gcm'?'SIV_GCM':'SIV_CTRMAC').toString()).toBe('Edited café Ω 😀\n<script>alert(1)</script>\n');
  await page.getByRole('button',{name:'Edit text',exact:true}).click();await page.getByLabel('Edit file contents').fill('');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByLabel('Edit file contents')).toHaveCount(0);
  expect(decryptReference(await nativeBytes(page,path),fixtureRaw,fixture==='gcm'?'SIV_GCM':'SIV_CTRMAC')).toHaveLength(0);
  await page.getByRole('button',{name:'Close preview',exact:true}).click();await page.getByRole('button',{name:'Open Words & thoughts',exact:true}).click();
  const long=page.getByRole('button',{name:/Open A very long name/}),name=(await long.getAttribute('aria-label'))!.slice(5),id=await folderId(page,'Words & thoughts');
  const longPath=importPath(name,id).path.replace('=.c9s/','.c9s/'),mapping=await nativeBytes(page,longPath.replace('contents.c9r','name.c9s'));
  await startEditing(page,name);await page.getByLabel('Edit file contents').fill('Changed long filename');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByLabel('Edit file contents')).toHaveCount(0);
  expect(decryptReference(await nativeBytes(page,longPath),fixtureRaw,fixture==='gcm'?'SIV_GCM':'SIV_CTRMAC').toString()).toBe('Changed long filename');expect(await nativeBytes(page,longPath.replace('contents.c9r','name.c9s'))).toEqual(mapping);
  expect(await nativeBytes(page,'masterkey.cryptomator')).toEqual(master);expect(await editArtifacts(page)).toEqual([]);
});
test('unsaved text changes guard close and browser history, and locking clears drafts',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await startEditing(page);await page.getByLabel('Edit file contents').fill('Private unsaved draft');
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Close preview',exact:true}).click();await expect(page.getByLabel('Edit file contents')).toHaveValue('Private unsaved draft');
  page.once('dialog',dialog=>dialog.dismiss());await page.goBack();await expect(page.getByLabel('Edit file contents')).toHaveValue('Private unsaved draft');
  page.once('dialog',dialog=>dialog.accept());await page.goBack();await expect(page.locator('.preview-pane')).toHaveCount(0);
  await page.goForward();await expect(page.locator('.reader')).toContainText('FIELD NOTES');await page.getByRole('button',{name:'Edit text',exact:true}).click();await page.getByLabel('Edit file contents').fill('Discard on lock');
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();await expect(page.getByLabel('Vault password')).toBeVisible();await expect(page.getByText('Discard on lock')).toHaveCount(0);await passwordUnlock(page);
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toContainText('FIELD NOTES');
});
test('text saves reject external changes and retain the draft without overwriting them',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await startEditing(page);await page.getByLabel('Edit file contents').fill('My draft');
  const path=importPath('Field notes.txt').path,changed=encryptFile(Buffer.from('External edit'),'SIV_GCM',65);
  await page.evaluate(async({path,bytes})=>{let folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture');const parts=path.split('/');for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part);const writer=await(await folder.getFileHandle(parts.at(-1)!)).createWritable();await writer.write(Uint8Array.from(atob(bytes),c=>c.charCodeAt(0)));await writer.close();},{path,bytes:changed.toString('base64')});
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByRole('alert')).toContainText('changed since');await expect(page.getByLabel('Edit file contents')).toHaveValue('My draft');expect(await nativeBytes(page,path)).toEqual(changed);expect(await editArtifacts(page)).toEqual([]);
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();
});
test('read-only vaults cannot edit, and RTF and symbolic links remain previews',async({page})=>{
  await openVault(page);await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.getByRole('button',{name:'Edit text',exact:true})).toBeDisabled();
  await nativeSource(page,'media');await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await page.getByRole('button',{name:'Open Notes.rtf',exact:true}).click();await expect(page.locator('.reader')).toBeVisible();await expect(page.getByRole('button',{name:'Edit text',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Close preview',exact:true}).click();await page.getByRole('button',{name:'Open Link to field notes',exact:true}).click();await expect(page.locator('.reader')).toBeVisible();await expect(page.getByRole('button',{name:'Edit text',exact:true})).toHaveCount(0);
});
test('canceling or locking before text commit preserves originals and removes encrypted staging',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);const path=importPath('Field notes.txt').path,original=await nativeBytes(page,path);await startEditing(page);await page.getByLabel('Edit file contents').fill('Canceled save');
  await page.evaluate(()=>{const write=FileSystemWritableFileStream.prototype.write;const gate=new Promise<void>(resolve=>(window as any).__releaseEdit=resolve);FileSystemWritableFileStream.prototype.write=async function(data){(window as any).__editWriting=true;await gate;return write.call(this,data);};});
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__editWriting)).toBe(true);await page.getByRole('button',{name:'Cancel save',exact:true}).click();await page.getByRole('button',{name:'Lock vault',exact:true}).click();await page.evaluate(()=>(window as any).__releaseEdit());
  await expect.poll(()=>editArtifacts(page)).toEqual([]);expect(await nativeBytes(page,path)).toEqual(original);
});
test('a corrupted published text save restores the verified encrypted original',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);const path=importPath('Field notes.txt').path,original=await nativeBytes(page,path);await startEditing(page);await page.getByLabel('Edit file contents').fill('Corrupt the copy');
  await page.evaluate(()=>{const write=FileSystemWritableFileStream.prototype.write;FileSystemWritableFileStream.prototype.write=async function(data){if(data instanceof File&&data.name.endsWith('.tmp')){const bytes=new Uint8Array(await data.arrayBuffer());bytes[0]^=1;return write.call(this,bytes);}return write.call(this,data);};});
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByRole('alert')).toContainText('original file was restored');await expect(page.getByLabel('Edit file contents')).toHaveValue('Corrupt the copy');expect(await nativeBytes(page,path)).toEqual(original);expect(await editArtifacts(page)).toEqual([]);await page.getByRole('button',{name:'Lock vault',exact:true}).click();
});
test('editing preserves UTF-16 byte order and BOM with CRLF newlines',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  for(const big of [false,true]){
    const name=big?'Big endian.txt':'Little endian.txt',source=Buffer.from('\ufeffOriginal Ω\r\n','utf16le');if(big)source.swap16();
    await page.getByRole('button',{name:'Add files',exact:true}).click();await page.getByLabel('Files to add').setInputFiles({name,mimeType:'text/plain',buffer:source});await expect(page.getByRole('status')).toContainText('Added 1 file');
    await startEditing(page,name);await page.getByLabel('Edit file contents').fill('Changed 😀\nNext line\n');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByLabel('Edit file contents')).toHaveCount(0);
    const expected=Buffer.from('\ufeffChanged 😀\r\nNext line\r\n','utf16le');if(big)expected.swap16();expect(decryptReference(await nativeBytes(page,importPath(name).path),fixtureRaw,'SIV_GCM')).toEqual(expected);
    await page.getByRole('button',{name:'Close preview',exact:true}).click();
  }
});
test('oversized previews and invalid text encodings cannot overwrite the original through editing',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  await page.getByRole('button',{name:'Add files',exact:true}).click();await page.getByLabel('Files to add').setInputFiles([{name:'Large text.txt',mimeType:'text/plain',buffer:Buffer.alloc(2*1024*1024+1,65)},{name:'Invalid text.txt',mimeType:'text/plain',buffer:Buffer.from([0xff,0x81])}]);await expect(page.getByRole('status')).toContainText('Added 2 files');
  await page.getByRole('button',{name:'Open Large text.txt',exact:true}).click();await expect(page.getByRole('button',{name:'Edit text',exact:true})).toBeDisabled();await expect(page.getByText('Editing requires the complete file within 2 MiB.')).toBeVisible();await page.getByRole('button',{name:'Close preview',exact:true}).click();
  const path=importPath('Invalid text.txt').path,original=await nativeBytes(page,path);await page.getByRole('button',{name:'Open Invalid text.txt',exact:true}).click();await page.getByRole('button',{name:'Edit text',exact:true}).click();await expect(page.getByRole('alert')).toContainText('cannot be edited safely');await expect(page.getByLabel('Edit file contents')).toHaveCount(0);expect(await nativeBytes(page,path)).toEqual(original);
});

async function beginConversion(page:Page,name:string){await page.getByRole('button',{name:`Actions for ${name}`,exact:true}).click();await page.getByRole('button',{name:'Convert…',exact:true}).click();await expect(page.getByRole('dialog',{name:'Convert media'})).toBeVisible();await expect(page.getByRole('button',{name:'Convert and preview',exact:true})).toBeEnabled({timeout:15000});}
async function reviewConversion(page:Page){await page.getByRole('button',{name:'Convert and preview',exact:true}).click();await expect(page.getByRole('heading',{name:'Review conversion'})).toBeVisible({timeout:25000});await expect(page.getByLabel('I have checked the converted preview',{exact:true})).toBeEnabled({timeout:10000});await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);}
async function cachePaths(page:Page):Promise<string[]>{return page.evaluate(async()=>{const paths:string[]=[];const root=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture');async function walk(folder:FileSystemDirectoryHandle,prefix:string){for await(const [name,handle] of folder.entries()){if(handle.kind==='directory')await walk(handle as FileSystemDirectoryHandle,`${prefix}${name}/`);else paths.push(prefix+name);}}try{await walk(await root.getDirectoryHandle('.crype_cache'),'');}catch{}return paths.sort();});}

test('selection is quiet until hover or activation, supports modifier ranges and exits after actions',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);
  await page.mouse.move(0,0);await expect(page.locator('.selection-toolbar')).toHaveCount(0);const box=page.getByLabel('Select Field notes.txt',{exact:true});await expect(box).toHaveCSS('opacity','0');
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).hover();await expect(box).toHaveCSS('opacity','1');
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click({modifiers:['Meta']});await expect(box).toBeChecked();await expect(page.locator('.reader')).toHaveCount(0);
  await page.getByRole('button',{name:'Open Northern light.png',exact:true}).click({modifiers:['Shift']});await expect(page.getByLabel('Select Northern light.png',{exact:true})).toBeChecked();
  await page.getByRole('button',{name:'Done selecting',exact:true}).click();await expect(page.locator('.selection-toolbar')).toHaveCount(0);await expect(box).not.toBeChecked();
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();await expect(page.locator('.reader')).toBeVisible();
});

test('image conversion estimates actual bytes, previews, saves a verified encrypted copy and optionally removes the original',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);const name='Northern light.png',original=await nativeBytes(page,importPath(name).path);
  await beginConversion(page,name);await expect(page.locator('.conversion-estimate')).toContainText(/smaller|larger/);await reviewConversion(page);
  await expect(page.getByLabel('Remove original after saving',{exact:true})).toBeDisabled();expect(await nativeBytes(page,importPath(name).path)).toEqual(original);
  await expect(page.locator('.converted-preview img')).toBeVisible();expect(await page.locator('.converted-preview img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(640);
  const estimated=await page.locator('.conversion-estimate strong').innerText();expect(estimated).toMatch(/smaller|larger/);
  await page.getByLabel('I have checked the converted preview',{exact:true}).check();await page.getByLabel('Remove original after saving',{exact:true}).check();await page.getByRole('button',{name:'Save and remove original',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await nativeHas(page,importPath(name).path)).toBe(false);const converted=decryptReference(await nativeBytes(page,importPath('Northern light (converted).webp').path),fixtureRaw,'SIV_GCM');expect(converted.subarray(0,4).toString()).toBe('RIFF');expect(converted.subarray(8,12).toString()).toBe('WEBP');
  await page.getByRole('button',{name:'Open Northern light (converted).webp',exact:true}).click();await expect(page.locator('.image-view img')).toBeVisible();
  await expect.poll(()=>page.evaluate(async()=>{const paths:string[]=[];for await(const [name] of (await navigator.storage.getDirectory()).entries())if(name.startsWith('crypte-conversion-'))paths.push(name);return paths.length;})).toBe(0);
});

test('Mediabunny converts video with bounded encrypted staging and the saved video plays and seeks',async({page})=>{
  test.setTimeout(60000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await expect(page.getByText('Media streaming ready')).toBeVisible();
  const name='A moment in bloom.mp4',original=await nativeBytes(page,importPath(name).path);await beginConversion(page,name);await page.getByLabel('Video bitrate').selectOption('500000');await reviewConversion(page);
  const video=page.locator('.converted-preview video');await video.evaluate(async(video:HTMLVideoElement)=>{video.muted=true;await video.play();video.currentTime=2;});await expect.poll(()=>video.evaluate((video:HTMLVideoElement)=>video.currentTime)).toBeGreaterThan(2);
  await page.getByRole('button',{name:'Save copy',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await nativeBytes(page,importPath(name).path)).toEqual(original);
  const encrypted=await nativeBytes(page,importPath('A moment in bloom (converted).webm').path),clear=decryptReference(encrypted,fixtureRaw,'SIV_GCM');expect(clear.subarray(0,4).toString('hex')).toBe('1a45dfa3');
  await page.getByRole('button',{name:'Open A moment in bloom (converted).webm',exact:true}).click();await expect(page.locator('.video-view video')).toBeVisible();await page.locator('.video-view video').evaluate(async(video:HTMLVideoElement)=>{video.muted=true;await video.play();});expect(errors).toEqual([]);
});

test('conversion cancel and lock discard encrypted staging and preserve originals',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);const name='Northern light.png',original=await nativeBytes(page,importPath(name).path);
  await beginConversion(page,name);await reviewConversion(page);await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await nativeBytes(page,importPath(name).path)).toEqual(original);expect(await nativeHas(page,importPath('Northern light (converted).webp').path)).toBe(false);
  await beginConversion(page,name);await reviewConversion(page);await page.getByRole('dialog').getByRole('button',{name:'Lock vault',exact:true}).click();await expect(page.getByLabel('Vault password')).toBeVisible();await expect(page.locator('.converted-preview')).toHaveCount(0);
  await expect.poll(()=>page.evaluate(async()=>{let count=0;for await(const [name] of (await navigator.storage.getDirectory()).entries())if(name.startsWith('crypte-conversion-'))count++;return count;})).toBe(0);expect(await nativeBytes(page,importPath(name).path)).toEqual(original);
});

test('a changed original cannot be removed after conversion review',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);const name='Northern light.png';await beginConversion(page,name);await reviewConversion(page);
  await page.getByLabel('I have checked the converted preview',{exact:true}).check();await page.getByLabel('Remove original after saving',{exact:true}).check();
  const path=importPath(name).path;await page.evaluate(async path=>{let folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture');const parts=path.split('/');for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part);const handle=await folder.getFileHandle(parts.at(-1)!),file=await handle.getFile(),bytes=new Uint8Array(await file.arrayBuffer());bytes[0]^=1;const writer=await handle.createWritable();await writer.write(bytes);await writer.close();},path);
  await page.getByRole('button',{name:'Save and remove original',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('original changed');expect(await nativeHas(page,path)).toBe(true);expect(await nativeHas(page,importPath('Northern light (converted).webp').path)).toBe(false);
});

test('persistent thumbnail files are encrypted, authenticated and removed on media deletion',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await expect(page.getByRole('button',{name:'Open A moment in bloom.mp4',exact:true}).locator('img')).toBeVisible();await expect(page.getByRole('button',{name:'Open Northern light.png',exact:true}).locator('img')).toBeVisible();
  const paths=await cachePaths(page);expect(paths.length).toBeGreaterThanOrEqual(2);for(const path of paths){expect(path).not.toMatch(/Northern|bloom|\.png|\.mp4/);const bytes=await nativeBytes(page,`.crype_cache/${path}`);expect(bytes.subarray(0,4).toString()).not.toBe('RIFF');expect(bytes.subarray(1,4).toString()).not.toBe('PNG');}
  const key=createHash('sha256').update(importPath('Northern light.png').path).digest('base64url')+'.thumb',imagePath=paths.find(path=>path.endsWith(key))!;expect(imagePath).toBeTruthy();
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();await page.evaluate(async path=>{let directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('Handle fixture');const parts=path.split('/');for(const part of parts.slice(0,-1))directory=await directory.getDirectoryHandle(part);const handle=await directory.getFileHandle(parts.at(-1)!),bytes=new Uint8Array(await(await handle.getFile()).arrayBuffer());bytes[bytes.length-1]^=1;const writer=await handle.createWritable();await writer.write(bytes);await writer.close();},`.crype_cache/${imagePath}`);
  await passwordUnlock(page);await expect(page.getByRole('button',{name:'Open Northern light.png',exact:true}).locator('img')).toBeVisible();
  await fileAction(page,'Northern light.png','Delete');await page.getByRole('button',{name:'Delete permanently',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await cachePaths(page)).some(path=>path.endsWith(key))).toBe(false);
  const videoKey=createHash('sha256').update(importPath('A moment in bloom.mp4').path).digest('base64url')+'.thumb';await fileAction(page,'A moment in bloom.mp4','Delete');await page.getByRole('button',{name:'Delete permanently',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await cachePaths(page)).some(path=>path.endsWith(videoKey))).toBe(false);
});

test('recursive folder deletion removes its persisted thumbnail group',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await page.getByRole('button',{name:'Open Small adventures',exact:true}).click();const image=page.getByRole('button',{name:/Open .*\.png/});await expect(image.locator('img')).toBeVisible();
  const folder='f62696f1-08d2-4f6a-ae51-559d038731a4',group=createHash('sha256').update(contentPath(folder)).digest('base64url');expect((await cachePaths(page)).some(path=>path.startsWith(`v1/${group}/`))).toBe(true);
  await page.goBack();await fileAction(page,'Small adventures','Delete');await page.getByRole('button',{name:'Delete permanently',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await cachePaths(page)).some(path=>path.startsWith(`v1/${group}/`))).toBe(false);
});

test('failed conversion publication verification preserves the original and cleans the incomplete copy',async({page})=>{
  await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);const name='Northern light.png',original=await nativeBytes(page,importPath(name).path);await beginConversion(page,name);await reviewConversion(page);await page.getByLabel('I have checked the converted preview',{exact:true}).check();await page.getByLabel('Remove original after saving',{exact:true}).check();
  await page.evaluate(target=>{const create=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=async function(options){const writer=await create.call(this,options);if(this.name===target){const write=writer.write.bind(writer);writer.write=async data=>{if(data instanceof ArrayBuffer){const bytes=new Uint8Array(data);bytes[0]^=1;}return write(data);};}return writer;};},importPath('Northern light (converted).webp').path.split('/').at(-1)!);
  await page.getByRole('button',{name:'Save and remove original',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('encrypted copy could not be verified');expect(await nativeBytes(page,importPath(name).path)).toEqual(original);expect(await nativeHas(page,importPath('Northern light (converted).webp').path)).toBe(false);await page.getByRole('button',{name:'Cancel',exact:true}).click();
});

test('Mediabunny audio conversion retains sound and can remove the reviewed original',async({page})=>{
  test.setTimeout(45000);await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await expect(page.getByText('Media streaming ready')).toBeVisible();await page.getByRole('button',{name:'Open Small adventures',exact:true}).click();await beginConversion(page,'Quiet tone.wav');await reviewConversion(page);await expect(page.locator('.converted-preview audio')).toBeVisible();await page.locator('.converted-preview audio').evaluate(async(audio:HTMLAudioElement)=>{audio.muted=true;await audio.play();});
  await page.getByLabel('I have checked the converted preview',{exact:true}).check();await page.getByLabel('Remove original after saving',{exact:true}).check();await page.getByRole('button',{name:'Save and remove original',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Open Quiet tone (converted).weba',exact:true})).toBeVisible();expect(await nativeHas(page,importPath('Quiet tone.wav','f62696f1-08d2-4f6a-ae51-559d038731a4').path)).toBe(false);
});

test('Mediabunny MP4 conversion previews and saves with browser codecs',async({page})=>{
  test.setTimeout(60000);await nativeSource(page);await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await expect(page.getByText('Media streaming ready')).toBeVisible();await beginConversion(page,'A moment in bloom.mp4');await page.getByLabel('Conversion format').selectOption('mp4');await page.getByLabel('Video bitrate').selectOption('500000');await reviewConversion(page);
  await page.locator('.converted-preview video').evaluate(async(video:HTMLVideoElement)=>{video.muted=true;await video.play();});await page.getByRole('button',{name:'Save copy',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);const clear=decryptReference(await nativeBytes(page,importPath('A moment in bloom (converted).mp4').path),fixtureRaw,'SIV_GCM');expect(clear.subarray(4,8).toString()).toBe('ftyp');
});

test('video conversion reads inputs above the former in-memory limit without decrypting padding',async({page})=>{
  test.setTimeout(60000);await nativeSource(page);await largeNativeMedia(page,'Long video.mp4');await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();await passwordUnlock(page);await expect(page.getByText('Media streaming ready')).toBeVisible();
  await page.evaluate(()=>{const post=Worker.prototype.postMessage;Object.assign(window,{__conversionReadBytes:0});Worker.prototype.postMessage=function(data:any,options:any){if(data?.action==='read')(window as any).__conversionReadBytes+=data.args[2]-data.args[1];return post.call(this,data,options);};});
  await beginConversion(page,'Long video.mp4');await page.getByLabel('Video bitrate').selectOption('500000');await reviewConversion(page);expect(await page.evaluate(()=>(window as any).__conversionReadBytes)).toBeLessThan(64*1024*1024);
  await page.getByRole('button',{name:'Save copy',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await nativeHas(page,importPath('Long video.mp4').path)).toBe(true);expect(await nativeHas(page,importPath('Long video (converted).webm').path)).toBe(true);
});

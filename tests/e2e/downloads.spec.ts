import {expect,test,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
async function open(page:Page,scheme='gcm'){
  await page.addInitScript(()=>{Object.defineProperty(window,'showDirectoryPicker',{value:undefined,configurable:true});Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true});});
  await page.goto('/crypte/');await page.getByLabel('Vault folder',{exact:true}).setInputFiles(resolve(`tests/fixtures/${scheme}`));
  await page.getByLabel('Vault password').fill('crypte-demo');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
}
async function action(page:Page,name:string,folder=false){await page.getByRole('button',{name:`Actions for ${name}`,exact:true}).click();await page.locator('.entry-menu-popup').getByRole('button',{name:folder?'Download folder (.zip)':'Download file',exact:true}).click();}
function contents(bytes:Buffer){
  const result=new Map<string,Buffer>(),end=bytes.length-22;expect(bytes.readUInt32LE(end)).toBe(0x06054b50);let p=bytes.readUInt32LE(end+16);
  for(let n=0;n<bytes.readUInt16LE(end+10);n++){
    expect(bytes.readUInt32LE(p)).toBe(0x02014b50);const length=bytes.readUInt16LE(p+28),name=bytes.subarray(p+46,p+46+length).toString(),local=bytes.readUInt32LE(p+42),start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    result.set(name,bytes.subarray(start,start+bytes.readUInt32LE(p+24)));p+=46+length+bytes.readUInt16LE(p+30)+bytes.readUInt16LE(p+32);
  }return result;
}
test('read-only file menu downloads plaintext without opening a preview',async({page})=>{
  await open(page);await page.getByRole('button',{name:'Actions for Field notes.txt',exact:true}).click();
  await expect(page.locator('.entry-menu-popup').getByRole('button',{name:'Rename',exact:true})).toHaveCount(0);
  const pending=page.waitForEvent('download');await page.locator('.entry-menu-popup').getByRole('button',{name:'Download file',exact:true}).click();const download=await pending;
  expect(download.suggestedFilename()).toBe('Field notes.txt');expect(await readFile((await download.path())!,'utf8')).toContain('FIELD NOTES');await expect(page.getByLabel('File preview')).toHaveCount(0);
});
for(const scheme of ['gcm','ctr','legacy'])test(`${scheme} folder download preserves files and empty folders`,async({page})=>{
  await open(page,scheme);if(scheme==='ctr')await page.getByRole('button',{name:'List view',exact:true}).click();
  let pending=page.waitForEvent('download');await action(page,'Words & thoughts',true);let download=await pending;
  expect(download.suggestedFilename()).toBe('Words & thoughts.zip');const files=contents(await readFile((await download.path())!));
  expect(files.get('Words & thoughts/Empty note.txt')!.length).toBe(0);expect(files.get('Words & thoughts/Across the chunks.txt')!.toString()).toBe('0123456789abcdef'.repeat(5000));expect([...files.keys()].some(p=>p.includes('A very long name'))).toBe(true);
  pending=page.waitForEvent('download');await action(page,'Empty folder',true);download=await pending;expect([...contents(await readFile((await download.path())!)).keys()]).toEqual(['Empty folder/']);
});
test('native folder download streams a ZIP and exposes progress',async({page})=>{
  await open(page);await page.evaluate(()=>Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async(options:any)=>{(window as any).__name=options.suggestedName;const root=await navigator.storage.getDirectory();return root.getFileHandle('download.zip',{create:true});}}));
  await action(page,'Words & thoughts',true);await expect(page.getByRole('status')).toContainText('Download ready: Words & thoughts.zip');
  const encoded=await page.evaluate(async()=>{const file=await(await(await navigator.storage.getDirectory()).getFileHandle('download.zip')).getFile();return Array.from(new Uint8Array(await file.arrayBuffer()));});
  expect(contents(Buffer.from(encoded)).get('Words & thoughts/Across the chunks.txt')!.length).toBe(80000);expect(await page.evaluate(()=>(window as any).__name)).toBe('Words & thoughts.zip');
});
test('cancelling a streaming folder download aborts the output',async({page})=>{
  await open(page);await page.evaluate(()=>Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async()=>({async createWritable(){return {async write(){await new Promise(r=>setTimeout(r,100));},async close(){(window as any).__closed=true;},async abort(){(window as any).__aborted=true;}};}})}));
  await action(page,'Words & thoughts',true);await expect(page.getByRole('progressbar',{name:'Download progress'})).toBeVisible();await page.getByRole('button',{name:'Cancel download',exact:true}).click();await expect(page.getByRole('status')).toContainText('Download cancelled');
  expect(await page.evaluate(()=>(window as any).__aborted)).toBe(true);expect(await page.evaluate(()=>(window as any).__closed)).not.toBe(true);
});

test('folder download menu is usable on a narrow screen',async({page})=>{
  await page.setViewportSize({width:390,height:844});await open(page);await page.getByRole('button',{name:'Actions for Empty folder',exact:true}).click();
  const button=page.locator('.entry-menu-popup').getByRole('button',{name:'Download folder (.zip)',exact:true});await expect(button).toBeInViewport();
  await page.screenshot({path:'test-results/download-menu-mobile.png'});
  const pending=page.waitForEvent('download');await button.click();expect((await pending).suggestedFilename()).toBe('Empty folder.zip');
});
test('locking cancels the download and aborts its writable output',async({page})=>{
  await open(page);await page.evaluate(()=>Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async()=>({async createWritable(){return {async write(){await new Promise(r=>setTimeout(r,150));},async close(){(window as any).__closed=true;},async abort(){(window as any).__aborted=true;}};}})}));
  await action(page,'Words & thoughts',true);await expect(page.getByRole('progressbar',{name:'Download progress'})).toBeVisible();await page.getByRole('button',{name:'Lock vault',exact:true}).click();
  await expect(page.getByLabel('Vault password')).toBeVisible();await expect.poll(()=>page.evaluate(()=>(window as any).__aborted)).toBe(true);expect(await page.evaluate(()=>(window as any).__closed)).not.toBe(true);
});

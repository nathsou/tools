import {expect,test,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {decryptAge,encryptAge,parseIdentities,parseRecipients} from '../../src/lib/age';

const identityText=()=>readFile(resolve('tests/fixtures/age/identity.txt'),'utf8');
async function* once(bytes:Uint8Array){yield bytes;}
async function collect(stream:AsyncIterable<Uint8Array>){const parts:Uint8Array[]=[];for await(const chunk of stream)parts.push(chunk.slice());return Buffer.concat(parts);}
async function downloaded(page:Page,action:()=>Promise<void>){
  const [download]=await Promise.all([page.waitForEvent('download'),action()]);
  return {name:download.suggestedFilename(),bytes:await readFile(await download.path())};
}
const memoryDownloads=(page:Page)=>page.addInitScript(()=>{Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true});});

test('Age encrypts and decrypts with a passphrase, compatible with the shared implementation',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await memoryDownloads(page);await page.goto('/age/');
  await expect(page.getByRole('heading',{name:'Encrypt a file.',level:2})).toBeVisible();
  const plain=Buffer.from('Quarterly report\n'.repeat(5000));
  await page.getByLabel('File to encrypt').setInputFiles({name:'report.txt',mimeType:'text/plain',buffer:plain});
  await expect(page.getByText('saves as report.txt.age')).toBeVisible();
  await page.locator('#encrypt-passphrase').fill('a long passphrase');await page.locator('#encrypt-confirm').fill('different');
  await page.getByRole('button',{name:/Encrypt and save/}).click();await expect(page.getByRole('alert')).toContainText('do not match');
  await page.locator('#encrypt-confirm').fill('a long passphrase');
  const encrypted=await downloaded(page,()=>page.getByRole('button',{name:/Encrypt and save/}).click());
  expect(encrypted.name).toBe('report.txt.age');
  expect(encrypted.bytes.subarray(0,22).toString()).toBe('age-encryption.org/v1\n');
  expect(await collect(decryptAge(once(encrypted.bytes),{passphrase:'a long passphrase'}))).toEqual(plain);
  await expect(page.getByRole('status')).toContainText('Encrypted.');

  await page.getByRole('button',{name:'Decrypt',exact:true}).click();
  await page.getByLabel('File to decrypt').setInputFiles({name:'report.txt.age',mimeType:'application/octet-stream',buffer:encrypted.bytes});
  await expect(page.locator('#decrypt-detail')).toHaveText(/· passphrase$/);
  await page.locator('#decrypt-passphrase').fill('wrong');await page.getByRole('button',{name:/Unlock/}).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect passphrase');
  await page.locator('#decrypt-passphrase').fill('a long passphrase');await page.getByRole('button',{name:/Unlock/}).click();
  await expect(page.getByText('Unlocked.')).toBeVisible();
  const decrypted=await downloaded(page,()=>page.getByRole('button',{name:/Decrypt and save/}).click());
  expect(decrypted.name).toBe('report.txt');expect(decrypted.bytes).toEqual(plain);
  expect(errors).toEqual([]);
});

test('Age generates keys, encrypts to them, and opens files from the age CLI',async({page})=>{
  await memoryDownloads(page);await page.goto('/age/');
  await page.getByRole('button',{name:'Keys',exact:true}).click();
  await page.getByRole('button',{name:/Generate key pair/}).click();
  const recipient=await page.getByRole('textbox',{name:'Public key',exact:true}).inputValue(),identity=await page.getByLabel('Secret key (identity file)').inputValue();
  expect(recipient).toMatch(/^age1[02-9ac-hj-np-z]{58}$/);expect(identity).toContain(`# public key: ${recipient}`);
  const saved=await downloaded(page,()=>page.getByRole('button',{name:'Save identity file'}).click());
  expect(saved.bytes.toString()).toBe(identity);
  expect((await parseIdentities(identity))[0].recipient).toBe(recipient);
  await page.getByRole('button',{name:'Encrypt to this key'}).click();
  await expect(page.locator('#recipients')).toHaveValue(recipient);
  const plain=Buffer.alloc(200_000,7);
  await page.getByLabel('File to encrypt').setInputFiles({name:'data.bin',mimeType:'application/octet-stream',buffer:plain});
  await page.getByText('Output options').click();await page.getByLabel('ASCII armor').check();
  const encrypted=await downloaded(page,()=>page.getByRole('button',{name:/Encrypt and save/}).click());
  expect(encrypted.bytes.toString().startsWith('-----BEGIN AGE ENCRYPTED FILE-----\n')).toBe(true);
  expect(await collect(decryptAge(once(encrypted.bytes),{identities:await parseIdentities(identity)}))).toEqual(plain);

  await page.getByRole('button',{name:'Decrypt',exact:true}).click();
  await page.getByLabel('File to decrypt').setInputFiles(resolve('tests/fixtures/age/hello.age'));
  await expect(page.locator('#decrypt-detail')).toHaveText(/· 1 recipient$/);
  await page.getByLabel('Identity file',{exact:true}).setInputFiles(resolve('tests/fixtures/age/identity.txt'));
  await expect(page.getByLabel('Secret key',{exact:true})).toHaveValue(await identityText());
  await page.getByRole('button',{name:/Unlock/}).click();
  const decrypted=await downloaded(page,()=>page.getByRole('button',{name:/Decrypt and save/}).click());
  expect(decrypted.name).toBe('hello');expect(decrypted.bytes.toString()).toBe('Hello from age.\n');

  await page.getByLabel('File to decrypt').setInputFiles({name:'not-age.txt',mimeType:'text/plain',buffer:Buffer.from('plain text')});
  await expect(page.getByRole('alert')).toContainText('not an age encrypted file');
});

test('Age streams to a chosen file and stays usable on small screens in both themes',async({page})=>{
  await page.addInitScript(()=>{Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async({suggestedName}:{suggestedName:string})=>(await navigator.storage.getDirectory()).getFileHandle(suggestedName,{create:true})});});
  await page.goto('/age/');
  const recipients=parseRecipients((await identityText()).match(/public key: (age1\w+)/)![1]);
  await page.getByRole('group',{name:'Protect with'}).getByText('Public keys').click();
  await page.locator('#recipients').fill(`# test key\n${recipients[0].text}`);
  const plain=Buffer.alloc(3*65536+11,3);
  await page.getByLabel('File to encrypt').setInputFiles({name:'chunks.bin',mimeType:'application/octet-stream',buffer:plain});
  await page.getByRole('button',{name:/Encrypt and save/}).click();await expect(page.getByRole('status')).toContainText('Encrypted.');
  const stored=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await(await(await(await navigator.storage.getDirectory()).getFileHandle('chunks.bin.age')).getFile()).arrayBuffer()))));
  expect(await collect(decryptAge(once(stored),{identities:await parseIdentities(await identityText())}))).toEqual(plain);
  for(const scheme of ['light','dark'] as const){
    await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width:375,height:812});
    for(const mode of ['Encrypt','Decrypt','Keys']){await page.getByRole('button',{name:mode,exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);}
  }
});

test('the tools index links to Age without a service worker',async({page})=>{
  await page.goto('/');await page.getByRole('link',{name:'Open Age',exact:true}).click();
  await expect(page).toHaveURL(/\/age\/$/);await expect(page.getByRole('heading',{name:'Encrypt a file.',level:1})).toBeVisible();
  expect(await page.evaluate(()=>navigator.serviceWorker.controller)).toBeNull();
});

async function nativeVault(page:Page){
  await page.addInitScript(()=>{
    Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:async()=>(await navigator.storage.getDirectory()).getDirectoryHandle('Age vault')});
    Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async({suggestedName}:{suggestedName:string})=>(await navigator.storage.getDirectory()).getFileHandle(suggestedName,{create:true})});
  });
  await page.goto('/crypte/');
  const paths:string[]=JSON.parse(await readFile('tests/fixtures/gcm/index.json','utf8'));
  const files=await Promise.all(paths.map(async path=>({path,bytes:(await readFile(resolve('tests/fixtures/gcm',path))).toString('base64')})));
  await page.evaluate(async files=>{
    const root=await(await navigator.storage.getDirectory()).getDirectoryHandle('Age vault',{create:true});
    for(const {path,bytes} of files){
      const parts=path.split('/');let folder=root;
      for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part,{create:true});
      const writable=await(await folder.getFileHandle(parts.at(-1)!,{create:true})).createWritable();await writable.write(Uint8Array.from(atob(bytes),c=>c.charCodeAt(0)));await writable.close();
    }
  },files);
  await page.getByRole('button',{name:'Choose vault folder',exact:true}).click();
  await page.getByLabel('Vault password').fill('crypte-demo');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();
}
async function entryAction(page:Page,name:string,action:string){
  await page.getByRole('button',{name:`Actions for ${name}`,exact:true}).click();
  await page.locator('.entry-menu-popup').getByRole('button',{name:action,exact:true}).click();
}
const opfsFile=(page:Page,name:string)=>page.evaluate(async name=>Array.from(new Uint8Array(await(await(await(await navigator.storage.getDirectory()).getFileHandle(name)).getFile()).arrayBuffer())),name).then(bytes=>Buffer.from(bytes));

test('Crypte exports vault files as age files and decrypts age files into the vault',async({page})=>{
  test.setTimeout(60000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await nativeVault(page);

  await entryAction(page,'Field notes.txt','Encrypt with age…');
  const dialog=page.getByRole('dialog',{name:'Encrypt with age'});
  await dialog.getByLabel('Passphrase',{exact:true}).fill('vault export');await dialog.getByLabel('Confirm passphrase').fill('vault export');
  await dialog.getByRole('button',{name:'Encrypt and save…'}).click();
  await expect(dialog.getByText(/^Saved Field notes\.txt\.age\./)).toBeVisible();
  expect((await collect(decryptAge(once(await opfsFile(page,'Field notes.txt.age')),{passphrase:'vault export'}))).toString()).toContain('FIELD NOTES');
  await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(dialog).toBeHidden();

  const identities=await parseIdentities(await identityText());
  const secret=Buffer.from(await collect(encryptAge(once(Buffer.from('Secret plan, decrypted inside the vault.\n')),{recipients:parseRecipients(identities[0].recipient)})));
  await page.locator('input[aria-label="Files to add"]').setInputFiles([{name:'plan.txt.age',mimeType:'application/octet-stream',buffer:secret},{name:'note.age',mimeType:'application/octet-stream',buffer:await readFile(resolve('tests/fixtures/age/passphrase.age'))}]);
  await expect(page.getByRole('button',{name:'Open plan.txt.age',exact:true})).toBeVisible();

  await page.getByRole('button',{name:'Open plan.txt.age',exact:true}).click();
  await expect(page.getByRole('heading',{name:'age encrypted file'})).toBeVisible();
  await page.getByRole('button',{name:'Decrypt…'}).click();
  const decrypt=page.getByRole('dialog',{name:'Decrypt age file'});
  await expect(decrypt).toContainText('encrypted to one public key');
  await decrypt.getByLabel('Secret key').fill(await identityText());
  await decrypt.getByRole('button',{name:'Unlock'}).click();
  await expect(decrypt.getByLabel('Decrypted file name')).toHaveValue('plan.txt');
  await decrypt.getByRole('button',{name:'Save to this folder'}).click();
  await expect(decrypt.getByText('Saved “plan.txt” to this folder, encrypted by the vault.')).toBeVisible();
  await decrypt.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Open plan.txt',exact:true}).click();
  await expect(page.locator('.reader')).toContainText('Secret plan, decrypted inside the vault.');

  await entryAction(page,'note.age','Decrypt age file…');
  const note=page.getByRole('dialog',{name:'Decrypt age file'});
  await note.getByLabel('Passphrase').fill('wrong');await note.getByRole('button',{name:'Unlock'}).click();
  await expect(note.getByRole('alert')).toContainText('Incorrect passphrase');
  await note.getByLabel('Passphrase').fill('crypte-demo');await note.getByRole('button',{name:'Unlock'}).click();
  await note.getByLabel('Decrypted file name').fill('note.txt');
  await note.getByRole('button',{name:'Download'}).click();
  await expect(note.getByText('Downloaded note.txt. This is an unencrypted copy.')).toBeVisible();
  expect((await opfsFile(page,'note.txt')).toString()).toBe('Hello from age.\n');
  await page.keyboard.press('Escape');await expect(note).toBeHidden();
  expect(errors).toEqual([]);
});

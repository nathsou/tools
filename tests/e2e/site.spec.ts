import {expect,test} from '@playwright/test';
import {createServer,type Server} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
let server:Server,subpathURL:string;
test.beforeAll(async()=>{
  const root=resolve('dist'),types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.txt':'text/plain'};
  server=createServer(async(request,response)=>{
    try{
      const path=new URL(request.url!,'http://localhost').pathname;if(!path.startsWith('/tools/')){response.writeHead(404).end();return;}
      let file=resolve(root,decodeURIComponent(path.slice('/tools/'.length)));
      if(file!==root&&!file.startsWith(root+sep)){response.writeHead(403).end();return;}
      if((await stat(file)).isDirectory())file=resolve(file,'index.html');
      response.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream'});response.end(await readFile(file));
    }catch{response.writeHead(404).end();}
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test server address.');subpathURL=`http://127.0.0.1:${address.port}/tools/`;
});
test.afterAll(async()=>{await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));});

test('tools index opens Crypte and stays responsive in light and dark modes',async({page})=>{
  await page.goto('/');await expect(page.getByRole('heading',{name:'Tools for your browser.'})).toBeVisible();const link=page.getByRole('link',{name:'Open Crypte',exact:true});await expect(link).toHaveAttribute('href','./crypte/');
  for(const scheme of ['light','dark'] as const){await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await expect(link).toBeVisible();}
  await link.click();await expect(page).toHaveURL(/\/crypte\/$/);await expect(page.getByRole('heading',{name:'Open a vault',exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>navigator.serviceWorker.controller?.scriptURL)).toContain('/crypte/service-worker.js');
  await page.goto('/');expect(await page.evaluate(()=>navigator.serviceWorker.controller)).toBeNull();
});

test('Crypte works under a project subdirectory, including authenticated video streaming and offline workers',async({page,context})=>{
  await page.addInitScript(()=>Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:undefined}));
  await page.goto(subpathURL);await page.getByRole('link',{name:'Open Crypte',exact:true}).click();await expect(page).toHaveURL(subpathURL+'crypte/');await expect(page.getByRole('heading',{name:'Open a vault',exact:true})).toBeVisible();
  await page.getByLabel('Vault folder',{exact:true}).setInputFiles(resolve('tests/fixtures/gcm'));await page.getByLabel('Vault password').fill('crypte-demo');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await expect(page.getByText('Media streaming ready',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open A moment in bloom.mp4',exact:true}).click();const video=page.locator('.video-view video');await expect(video).toBeVisible();const url=await video.getAttribute('src');expect(url).toContain('/tools/crypte/__vault__/');
  const range=await page.evaluate(async url=>{const response=await fetch(url!,{headers:{Range:'bytes=0-15'}});return {status:response.status,bytes:(await response.arrayBuffer()).byteLength};},url);expect(range).toEqual({status:206,bytes:16});
  await context.setOffline(true);await page.reload();await expect(page.getByRole('heading',{name:'Open a vault',exact:true})).toBeVisible();await page.getByLabel('Vault folder',{exact:true}).setInputFiles(resolve('tests/fixtures/gcm'));await page.getByLabel('Vault password').fill('crypte-demo');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await expect(page.getByRole('heading',{name:'All files',exact:true})).toBeVisible();await expect(page.getByText('Media streaming ready',{exact:true})).toBeVisible();
});

test('Drop opens under a project subdirectory without inheriting a service worker', async ({ page }) => {
  await page.goto(subpathURL);
  await page.getByRole('link', { name: 'Open Drop', exact: true }).click();
  await expect(page).toHaveURL(subpathURL + 'drop/');
  await expect(page.getByRole('heading', { name: 'Make a connection.' })).toBeVisible();
  await expect(page.locator('#connection-status')).toContainText('Manual pairing');
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

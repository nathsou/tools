/** Reproducible visual review of the production build (run `mise run preview`). */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const output='.tools/screenshots';await mkdir(output,{recursive:true});
const browser=await chromium.launch();
try {
  const page=await browser.newPage({viewport:{width:1440,height:950}});
  await page.addInitScript(()=>Object.defineProperty(window,'showDirectoryPicker',{value:undefined,configurable:true}));
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:4173/crypte/');
  await page.screenshot({path:`${output}/welcome.png`,fullPage:true});
  await page.getByLabel('Vault folder',{exact:true}).setInputFiles(resolve('tests/fixtures/gcm'));
  await page.getByLabel('Vault password').fill('crypte-demo');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await page.getByRole('heading',{name:'All files',exact:true}).waitFor();
  await page.locator('.thumbnail img').first().waitFor();
  await page.getByRole('button',{name:'Open A moment in bloom.mp4',exact:true}).locator('img').waitFor();
  await page.screenshot({path:`${output}/gallery.png`,fullPage:true});
  await page.getByRole('button',{name:'Open Field notes.txt',exact:true}).click();
  await page.locator('.reader').waitFor();await page.screenshot({path:`${output}/reader.png`,fullPage:true});
  await page.getByRole('button',{name:'Close preview'}).click();
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await page.getByLabel('Appearance').selectOption('dark');
  await page.getByRole('button',{name:'Close preferences'}).click();
  await page.screenshot({path:`${output}/dark.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:`${output}/mobile.png`,fullPage:true});
  await page.setViewportSize({width:1440,height:950});await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:4173/crypte/');
  await page.getByLabel('Vault folder',{exact:true}).setInputFiles(resolve('tests/fixtures/media'));
  await page.getByLabel('Vault password').fill('crypte-demo');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  const heic=page.getByRole('button',{name:'Open Sample.HEIC',exact:true});await heic.locator('img').waitFor();await heic.click();
  await page.locator('.image-view img').waitFor();await page.screenshot({path:`${output}/heic.png`,fullPage:true});
  await page.getByRole('button',{name:'Close preview'}).click();await page.getByRole('button',{name:'Open Notes.rtf',exact:true}).click();
  await page.locator('.reader').waitFor();await page.screenshot({path:`${output}/rtf.png`,fullPage:true});
  console.log(`Saved visual review screenshots to ${output}.`);
} finally {await browser.close();}

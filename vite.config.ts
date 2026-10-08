import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createHash } from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
let offlineAssets:string[]=[];
export default defineConfig({
  base: './',
  plugins: [svelte(), {
    name: 'crypte-offline',
    generateBundle(_, bundle) {
      const files = [...new Set(['crypte/index.html', 'crypte/manifest.webmanifest', 'crypte/icon.svg', 'licenses/libheif.txt', 'licenses/libheif-js.txt', 'licenses/mediabunny.txt', ...Object.entries(bundle).filter(([name,file])=>name!=='crypte/service-worker.js'&&name!=='index.html'&&!name.startsWith('drop/')&&!name.startsWith('assets/drop-')&&!name.endsWith('.map')&&!(file.type==='chunk'&&file.name==='index')).map(([name])=>name)])];
      offlineAssets=files;
      const version = createHash('sha256').update(JSON.stringify(bundle)).digest('hex').slice(0, 12);
      const sw = bundle['crypte/service-worker.js'];
      if (sw?.type === 'chunk') {
        sw.code = sw.code.replace(/(['"`])__CRYPTE_PRECACHE__\1/g, JSON.stringify(files.map(path=>path.startsWith('crypte/')?path.slice(7):`../${path}`))).replaceAll('__CRYPTE_VERSION__', version);
      }
    },
    writeBundle(options){
      for(const file of offlineAssets)if(!existsSync(resolve(options.dir!,file)))throw new Error(`Missing Crypte offline asset: ${file}`);
    }
  }],
  worker:{format:'es',rollupOptions:{output:{entryFileNames:'crypte/assets/[name]-[hash].js',chunkFileNames:'crypte/assets/[name]-[hash].js'}}},
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { index:'index.html', crypte:'crypte/index.html', drop:'drop/index.html', 'service-worker': 'src/service-worker.ts' },
      output: { codeSplitting:{groups:[{name:'mediabunny',test:/node_modules[\/]mediabunny/}]}, entryFileNames: chunk => chunk.name === 'service-worker' ? 'crypte/service-worker.js' : 'assets/[name]-[hash].js' }
    }
  },
  server: { port: 5173, strictPort: true, headers: { 'Service-Worker-Allowed':'/' } },
  preview: { port: 4173, strictPort: true }
});

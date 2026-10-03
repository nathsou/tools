/** Run against `mise run dev`. Synthetic data only; no private vault is accessed. */
import { chromium } from '@playwright/test';
import { makeVault, type Scheme } from './generate-fixtures.ts';
const browser=await chromium.launch();
const page=await browser.newPage();
const results=[];
try {
  for(const scheme of ['SIV_GCM','SIV_CTRMAC'] as Scheme[]) {
    const data=Buffer.alloc(16*1024*1024,0x53);
    const files=[...makeVault(scheme,false,data)].map(([path,bytes])=>({path,bytes:bytes.toString('base64')}));
    await page.goto(process.env.BENCHMARK_URL ?? 'http://localhost:5173');
    const result=await page.evaluate(async({files,scheme})=>{
      const { VaultClient }=await import('/src/lib/client.ts');
      const client=new VaultClient();
      const source={type:'files',name:'Synthetic benchmark',files:files.map(({path,bytes})=>({path,file:new File([Uint8Array.from(atob(bytes),c=>c.charCodeAt(0))],path.split('/').at(-1)!)}))};
      const times:number[]=[],listTimes:number[]=[],readTimes:number[]=[];
      try {
        await client.prepare(source);
        for(let i=0;i<5;i++) {
          const start=performance.now(); await client.unlock('crypte-demo'); times.push(performance.now()-start);
        }
        let listing=await client.list('');
        for(let i=0;i<20;i++) { const start=performance.now(); listing=await client.list(''); listTimes.push(performance.now()-start); }
        const entry=listing.entries.find((e:any)=>e.name==='Benchmark.bin');
        // Include 32 KiB authentication, File.slice reads, worker transfer, and output clearing.
        // Discard the first full-file pass as warmup.
        for(let pass=0;pass<6;pass++) {
          const start=performance.now();
          for(let offset=0;offset<entry.size;offset+=4*1024*1024) {
            const bytes=await client.read(entry,offset,Math.min(entry.size,offset+4*1024*1024));
            if(bytes.some((byte:number)=>byte!==0x53))throw new Error('Benchmark plaintext mismatch.');
            bytes.fill(0);
          }
          if(pass)readTimes.push(performance.now()-start);
        }
        const median=(values:number[])=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
        return {scheme,cleartextMiB:entry.size/1048576,scrypt:{N:32768,r:8,p:1,medianMs:Math.round(median(times))},folderEntries:listing.entries.length,folderMedianMs:+median(listTimes).toFixed(2),readMedianMs:Math.round(median(readTimes)),readMiBPerSecond:+(entry.size/1048576/(median(readTimes)/1000)).toFixed(1),browser:navigator.userAgent};
      } finally {client.close();}
    },{files,scheme});
    results.push(result);
  }
  console.log(JSON.stringify({method:'Headless Chromium; in-memory synthetic File objects; median of five full 16 MiB reads; not a WASM comparison or a disk benchmark.',results},null,2));
} finally {await browser.close();}

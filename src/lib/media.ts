import { random, toBase64Url } from './bytes';
import type { VaultClient } from './client';
import type { VaultEntry } from './types';
// Vite serves a relative build base as '/' in development; keep this tool scoped.
export const baseURL = new URL(import.meta.env.DEV ? './' : import.meta.env.BASE_URL,location.href);
let session = '', reader:VaultClient|undefined;
const files = new Map<string,{entry:VaultEntry;read?:(start:number,end:number)=>Promise<Uint8Array<ArrayBuffer>>}>();
export function startMedia(client:VaultClient):void { stopMedia(); reader = client; session = toBase64Url(random(24)); }
export function stopMedia():void { session = ''; reader = undefined; files.clear(); }
export function mediaURL(entry:VaultEntry,read?:(start:number,end:number)=>Promise<Uint8Array<ArrayBuffer>>):string {
  const id = toBase64Url(random(16)); files.set(id,{entry,read});
  return new URL(`__vault__/${session}/${id}`,baseURL).href;
}
export function revokeMediaURL(url:string):void { files.delete(url.split('/').at(-1)!); }
const mediaScript=import.meta.env.DEV ? new URL('../src/service-worker.ts',baseURL) : new URL('service-worker.js',baseURL);
export interface StreamingStatus {available:boolean;reason:string;}
export function mediaStreamingReady():boolean {
  const controller=navigator.serviceWorker?.controller;
  if(!controller)return false;
  // Vite may add a cache-busting query to a development worker URL.
  const actual=new URL(controller.scriptURL);
  return actual.origin===mediaScript.origin&&actual.pathname===mediaScript.pathname;
}
function timeout<T>(operation:Promise<T>,milliseconds:number,message:string):Promise<T> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(message)),milliseconds);
    operation.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}
export async function probeMediaStreaming():Promise<boolean> {
  const controller=navigator.serviceWorker?.controller;
  if(!controller||!mediaStreamingReady())return false;
  return new Promise(resolve=>{
    const channel=new MessageChannel();
    const finish=(ready:boolean)=>{clearTimeout(timer);channel.port1.close();resolve(ready);};
    const timer=setTimeout(()=>finish(false),2000);
    channel.port1.onmessage=({data})=>finish(data?.protocol===1&&data?.scope===baseURL.href&&navigator.serviceWorker.controller===controller);
    try{controller.postMessage({type:'crypte-streaming-probe'},[channel.port2]);}catch{finish(false);}
  });
}
async function waitForStreaming(service:ServiceWorkerContainer,registration:ServiceWorkerRegistration):Promise<void> {
  await new Promise<void>((resolve,reject)=>{
    let settled=false;
    const worker=registration.installing??registration.waiting;
    const cleanup=()=>{settled=true;clearTimeout(timer);service.removeEventListener('controllerchange',check);worker?.removeEventListener('statechange',changed);};
    const timer=setTimeout(()=>{cleanup();reject(new Error('The media worker did not become ready. Retry streaming to finish setup.'));},20000);
    async function check(){if(settled)return;if(await probeMediaStreaming()&&!settled){cleanup();resolve();}}
    function changed(){if(worker?.state==='redundant'&&!settled){cleanup();reject(new Error('The media worker failed to install. Check that the app’s static files are available, then retry streaming.'));}else void check();}
    service.addEventListener('controllerchange',check);worker?.addEventListener('statechange',changed);void check();
  });
}
export async function registerServiceWorker():Promise<StreamingStatus> {
  if (!window.isSecureContext) return {available:false,reason:'Media streaming requires HTTPS or localhost. Open the app on a secure address.'};
  const service=navigator.serviceWorker;
  if (!service) return {available:false,reason:'This browser does not provide service workers here. Open the app in a browser window that allows them.'};
  try {
    // Always initiate an update, but keep a working controller usable offline.
    const installing=service.register(mediaScript,{type:'module',scope:baseURL.pathname,updateViaCache:'none'});
    void installing.catch(()=>{});
    if(mediaStreamingReady()&&await probeMediaStreaming()){return {available:true,reason:''};}
    const registration=await timeout(installing,15000,'Media streaming setup timed out. Retry when the app can finish loading.');
    // serviceWorker.ready can refer to an older worker from a different scope.
    // Wait for this tool’s actual controller and verify the range protocol instead.
    await waitForStreaming(service,registration);
    return {available:true,reason:''};
  } catch(e) {
    return {available:false,reason:`Media streaming could not start: ${e instanceof Error ? e.message : 'the browser rejected setup.'}`};
  }
}
navigator.serviceWorker?.addEventListener('message',async event => {
  const port = event.ports[0]; if (!port) return;
  const data = event.data;
  try {
    if (!reader || !session || data.session !== session) throw new Error('The vault is locked.');
    const item = files.get(data.fileId),entry=item?.entry;
    if (!entry) throw new Error('This preview has closed.');
    if (data.type === 'media-meta') port.postMessage({ result:{ size:entry.size, mime:entry.mime } });
    else if (data.type === 'media-read') {
      const currentReader = reader;
      const bytes = await (item!.read ? item!.read(data.start,data.end) : currentReader.read(entry,data.start,data.end));
      if (reader !== currentReader || session !== data.session || !files.has(data.fileId)) { bytes.fill(0); throw new Error('This preview has closed.'); }
      port.postMessage({ result:bytes.buffer },[bytes.buffer]);
    } else throw new Error('Unknown media request.');
  } catch (e) { port.postMessage({ error:e instanceof Error ? e.message : 'Unable to read media.' }); }
  finally { port.close(); }
});

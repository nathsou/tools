/// <reference lib="webworker" />
import { parseRange } from './lib/ranges';
declare const self:ServiceWorkerGlobalScope;
const manifest:unknown = '__CRYPTE_PRECACHE__';
const version = '__CRYPTE_VERSION__';
const cachePrefix = `crypte-${self.registration.scope}-`;
const cacheName = `${cachePrefix}${version}`;
const mediaPrefix = new URL('__vault__/',self.registration.scope).pathname;
const production = Array.isArray(manifest);
self.addEventListener('message',event=>{
  if(event.data?.type==='crypte-streaming-probe'){
    event.ports[0]?.postMessage({protocol:1,scope:self.registration.scope});event.ports[0]?.close();
  }
});
self.addEventListener('install',event => {
  event.waitUntil((async()=>{
    if (production) await (await caches.open(cacheName)).addAll((manifest as string[]).map(path=>new URL(path,self.registration.scope).href));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event => {
  event.waitUntil((async()=>{
    if (production) for (const name of await caches.keys()) if (name.startsWith(cachePrefix) && name !== cacheName) await caches.delete(name);
    await self.clients.claim();
  })());
});
function ask<T>(client:Client,message:unknown):Promise<T> {
  return new Promise((resolve,reject)=>{
    const channel = new MessageChannel();
    const timer = setTimeout(()=>{ channel.port1.close(); reject(new Error('The unlocked vault tab is unavailable.')); },30000);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); if (data.error) reject(new Error(data.error)); else resolve(data.result); };
    client.postMessage(message,[channel.port2]);
  });
}
async function serveMedia(event:FetchEvent):Promise<Response> {
  const request = event.request;
  if (!['GET','HEAD'].includes(request.method)) return new Response(null,{ status:405 });
  const url = new URL(request.url);
  const [session,fileId,...rest] = url.pathname.slice(mediaPrefix.length).split('/');
  if (rest.length || !/^[\w-]{32}$/.test(session ?? '') || !/^[\w-]{22}$/.test(fileId ?? '')) return new Response(null,{ status:404 });
  const client = event.clientId ? await self.clients.get(event.clientId) : undefined;
  if (!client) return new Response(null,{ status:401 });
  try {
    const meta = await ask<{ size:number; mime:string }>(client,{ type:'media-meta',session,fileId });
    const range = parseRange(request.headers.get('range'),meta.size);
    const headers = new Headers({ 'Content-Type':meta.mime, 'Accept-Ranges':'bytes', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'" });
    if (!range) { headers.set('Content-Range',`bytes */${meta.size}`); return new Response(null,{ status:416, headers }); }
    const length = range.end-range.start;
    headers.set('Content-Length',String(length));
    const partial = request.headers.has('range');
    if (partial) headers.set('Content-Range',`bytes ${range.start}-${range.end-1}/${meta.size}`);
    let position = range.start;
    const read = async (end:number) => {
      const result = await ask<ArrayBuffer>(client,{ type:'media-read',session,fileId,start:position,end });
      if (result.byteLength !== end-position) throw new Error('Incomplete decrypted media range.');
      position = end; return new Uint8Array(result);
    };
    // Authenticate the header/first chunk before sending response headers, including empty files and HEAD.
    const first = await read(request.method === 'HEAD' ? position : Math.min(position+262144,range.end));
    if (request.method === 'HEAD') return new Response(null,{ status:partial ? 206 : 200, headers });
    let initial:Uint8Array|undefined = first;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const bytes = initial ?? (position < range.end ? await read(Math.min(position+262144,range.end)) : undefined);
          initial = undefined;
          if (cancelled) { bytes?.fill(0); return; }
          if (bytes?.length) controller.enqueue(bytes);
          if (position >= range.end) controller.close();
        } catch (e) { if (!cancelled) controller.error(e); }
      },
      cancel() { cancelled = true; initial?.fill(0); initial = undefined; }
    },{ highWaterMark:1 });
    return new Response(body,{ status:partial ? 206 : 200, headers });
  } catch { return new Response('Vault locked or file authentication failed.',{ status:403, headers:{ 'Cache-Control':'no-store', 'Content-Type':'text/plain' } }); }
}
self.addEventListener('fetch',event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(mediaPrefix)) { event.respondWith(serveMedia(event)); return; }
  if (!production || event.request.method !== 'GET') return;
  event.respondWith((async()=>{
    const cache = await caches.open(cacheName);
    // Static app resources are identical for every caller. Module requests carry an Origin
    // header while install-time fetches do not; Vite's Vary: Origin must not defeat offline hits.
    const cached = await cache.match(event.request,{ ignoreSearch:true, ignoreVary:true });
    if (cached) return cached;
    try { return await fetch(event.request); }
    catch (e) {
      if (event.request.mode === 'navigate') {
        const index = await cache.match(new URL('index.html',self.registration.scope).href);
        if (index) return index;
      }
      throw e;
    }
  })());
});

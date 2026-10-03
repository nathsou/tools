// Retire the former root-scoped Crypte worker. Tool workers live at their own routes.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const prefix=`crypte-${self.registration.scope}-`;
  for(const name of await caches.keys())if(name.startsWith(prefix))await caches.delete(name);
  await self.registration.unregister();
})()));

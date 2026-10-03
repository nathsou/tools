import type { PasskeyRecord } from './types';
export interface RecentVault { id:string; name:string; opened:number; handle?:FileSystemDirectoryHandle; }
// M153 can crash the browser while deserializing IDB filesystem handles in private
// contexts (Chromium issue 564001201). Do not probe private mode: omit handles on
// this entire major version, while retaining names and encrypted passkey records.
export const canRememberHandles = ():boolean => !/(?:Chrome|Chromium)\/153\./.test(navigator.userAgent);
let connection:Promise<IDBDatabase>|undefined;
const dbPromise = ():Promise<IDBDatabase> => connection ??= new Promise((resolve,reject) => {
  const request = indexedDB.open('crypte',1);
  request.onupgradeneeded = () => { request.result.createObjectStore('passkeys',{ keyPath:'vaultId' }); request.result.createObjectStore('recent',{ keyPath:'id' }); };
  request.onsuccess = () => {
    request.result.onversionchange = () => { request.result.close(); connection=undefined; };
    resolve(request.result);
  };
  request.onerror = () => { connection=undefined; reject(new Error('Browser storage is unavailable. Password unlock still works.')); };
});
async function request<T>(store:string,mode:IDBTransactionMode,operation:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const db = await dbPromise();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(store,mode), op = operation(tx.objectStore(store));
    let result:T;
    op.onsuccess = () => { result = op.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(new Error('Unable to access browser storage.'));
  });
}
export const getPasskey = (id:string):Promise<PasskeyRecord|undefined> => request('passkeys','readonly',s=>s.get(id));
export const putPasskey = (record:PasskeyRecord):Promise<IDBValidKey> => request('passkeys','readwrite',s=>s.put(record));
export const deletePasskey = (id:string):Promise<undefined> => request('passkeys','readwrite',s=>s.delete(id));
export const saveRecent = (vault:RecentVault):Promise<IDBValidKey> => {
  const stored = canRememberHandles() ? vault : { id:vault.id,name:vault.name,opened:vault.opened };
  return request('recent','readwrite',s=>s.put(stored));
};
export const getRecents = ():Promise<RecentVault[]> => request('recent','readonly',s=>s.getAll());
export async function forgetVault(id:string):Promise<void> {
  await request('recent','readwrite',s=>s.delete(id)); await deletePasskey(id);
}

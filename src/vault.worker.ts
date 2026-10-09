/// <reference lib="webworker" />
import { Vault } from './lib/vault';
import {generateVault} from './lib/crypto';
import {generateUvf} from './lib/uvf';
import type { PasskeyRecord, Source } from './lib/types';
let vault: Vault | undefined;
self.onmessage = async (event: MessageEvent) => {
  const { id, action, args } = event.data;
  try {
    let result: unknown;
    switch (action) {
      case 'generate': result=await (args[1]==='uvf'?generateUvf:generateVault)(args[0],progress=>self.postMessage({id,progress}));break;
      case 'prepare': vault?.lock(); vault = new Vault(args[0] as Source); result = await vault.prepare(args[1]===true); break;
      case 'unlock': result = await vault!.unlock(args[0], progress => self.postMessage({ id, progress })); break;
      case 'list': result = await vault!.list(args[0]); break;
      case 'migration-inventory': result=await vault!.migrationInventory(args[0],args[1],inventoryProgress=>self.postMessage({id,inventoryProgress}));break;
      case 'cancel-inventory': vault?.cancelInventory();break;
      case 'read': result = await vault!.read(args[0],args[1],args[2]); break;
      case 'read-text': result=await vault!.readText(args[0]);break;
      case 'begin-replacement': result=await vault!.beginReplacement(args[0],args[1],args[2],args[3]);break;
      case 'begin-import': result=await vault!.beginImport(args[0],args[1]); break;
      case 'begin-readable-import': result=await vault!.beginReadableImport(args[0],args[1],args[2],undefined,args[3]);break;
      case 'cache-crypt': result=await vault!.cacheCrypt(args[0],args[1],args[2]);break;
      case 'import-chunk': result=await vault!.importChunk(args[0],args[1]); break;
      case 'end-import': vault!.endImport(args[0]); break;
      case 'finalize-import': result=await vault!.finalizeImport(args[0]);break;
      case 'plan-write': result=await vault!.planWrite(args[0]);break;
      case 'finish-write': vault!.finishWrite(args[0],args[1]);break;
      case 'seal': {
        const prf = args[0] as Uint8Array<ArrayBuffer>;
        try { result = await vault!.seal(prf,args[1]); } finally { prf.fill(0); } break;
      }
      case 'passkey': {
        const prf = args[0] as Uint8Array<ArrayBuffer>;
        try { result = await vault!.unlockPasskey(prf,args[1] as PasskeyRecord); } finally { prf.fill(0); } break;
      }
      default: throw new Error('Unknown vault operation.');
    }
    if (result instanceof Uint8Array) self.postMessage({ id, result }, [result.buffer]);
    else if(action==='read-text'){const snapshot=result as import('./lib/types').TextSnapshot;self.postMessage({id,result},[snapshot.bytes.buffer]);}
    else self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error:e instanceof Error ? e.message : 'Unable to read the vault.' });
  }
};

import {sha256} from '@noble/hashes/sha2.js';
import {VaultClient} from './client';
import {persistVault} from './creation';
import {MIGRATION_MARKER} from './filesystem';
import {addFile,vaultWriteLock} from './imports';
import {executeWriteUnlocked} from './writes';
import {toBase64Url} from './bytes';
import type {MigrationInventory,VaultFamily,VaultInfo} from './types';
export interface MigrationProgress {stage:'checking'|'creating'|'copying'|'verifying'|'complete';path:string;completed:number;total:number;fileProgress?:number;}
export interface MigrationOptions {source:VaultClient;sourceInfo:VaultInfo;sourceRoot?:FileSystemDirectoryHandle;parent:FileSystemDirectoryHandle;name:string;password:string;family:VaultFamily;inventory:MigrationInventory;signal:AbortSignal;progress:(value:MigrationProgress)=>void;}
/** A migration is a verified copy into a new vault. No source writes, plaintext
 * staging, silent skips, filename changes or automatic source deletion. */
export async function migrateVault(options:MigrationOptions):Promise<FileSystemDirectoryHandle>{
  const {source,sourceInfo,sourceRoot,parent,name,password,family,inventory,signal,progress}=options;
  if(inventory.issues.length)throw new Error('Resolve the preflight issues before migrating.');
  if(family===(sourceInfo.family??'cryptomator'))throw new Error('Choose the other vault format.');
  signal.throwIfAborted();
  if(sourceRoot&&await sourceRoot.resolve(parent)!==null)throw new Error('Choose a destination outside the source vault.');
  const destination=new VaultClient();let root:FileSystemDirectoryHandle|undefined,complete=false;
  const abort=()=>{destination.close('Migration cancelled.');void source.cancelInventory().catch(()=>{});};signal.addEventListener('abort',abort);
  try{return await vaultWriteLock(sourceInfo.id,signal,async()=>{
    progress({stage:'checking',path:'',completed:0,total:inventory.items.length});
    const fresh=await source.migrationInventory(family);signal.throwIfAborted();
    if(fresh.issues.length||fresh.fingerprint!==inventory.fingerprint)throw new Error('The source changed after preflight. Check the vault again.');
    progress({stage:'creating',path:'',completed:0,total:inventory.items.length});
    const bootstrap=await destination.generate(password,undefined,family);signal.throwIfAborted();
    root=await persistVault(parent,name,bootstrap,signal,true);signal.throwIfAborted();
    await destination.prepare({type:'handle',handle:root},true);await destination.unlock(password);signal.throwIfAborted();
    const targetFolders=new Map([['','']]),hashes=new Map<string,string>();let completed=0;
    for(const item of inventory.items){
      signal.throwIfAborted();const {entry,path}=item,parentPath=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'',parentId=targetFolders.get(parentPath);
      if(parentId===undefined)throw new Error('Migration directory order is invalid.');
      progress({stage:'copying',path,completed,total:inventory.items.length});
      if(entry.kind==='folder'){
        const result=await executeWriteUnlocked(root,destination,{kind:'mkdir',parentId,name:entry.name},signal);
        if(result.warnings.length)throw new Error(result.warnings.join(' '));targetFolders.set(path,result.plan.createdFolder!.id);
      }else{
        const hash=sha256.create();try{
          const copied=await addFile(root,destination,{name:entry.name,size:entry.size,symlink:entry.kind==='symlink',read:async(start,end)=>{signal.throwIfAborted();const bytes=await source.read(entry,start,end);hash.update(bytes);return bytes;}},parentId,signal,written=>progress({stage:'copying',path,completed,total:inventory.items.length,fileProgress:entry.size?written/entry.size:1}));
          if(copied!==entry.name)throw new Error(`The destination changed while copying ${path}.`);
          hashes.set(path,toBase64Url(hash.digest()));
        }finally{hash.destroy();}
      }
      completed++;
    }
    progress({stage:'verifying',path:'',completed:0,total:inventory.items.length});
    // Reopen the on-disk metadata and decrypt every published file, not staged bytes.
    await destination.prepare({type:'handle',handle:root},true);await destination.unlock(password);
    const actual=await destination.migrationInventory(family);signal.throwIfAborted();
    if(actual.issues.length||actual.items.length!==inventory.items.length)throw new Error('The destination failed verification.');
    const expected=new Map(inventory.items.map(item=>[item.path,item]));completed=0;
    for(const item of actual.items){
      signal.throwIfAborted();const original=expected.get(item.path);
      if(!original||original.entry.kind!==item.entry.kind||original.entry.size!==item.entry.size)throw new Error(`Verification failed for ${item.path}.`);
      if(item.entry.kind!=='folder'){
        const hash=sha256.create();try{for(let start=0;start<item.entry.size||start===0;start+=4*1024*1024){const bytes=await destination.read(item.entry,start,Math.min(item.entry.size,start+4*1024*1024));try{signal.throwIfAborted();hash.update(bytes);}finally{bytes.fill(0);}if(!item.entry.size)break;}
          if(toBase64Url(hash.digest())!==hashes.get(item.path))throw new Error(`Content verification failed for ${item.path}.`);
        }finally{hash.destroy();}
      }
      progress({stage:'verifying',path:item.path,completed:++completed,total:inventory.items.length});
    }
    const unchanged=await source.migrationInventory(family);signal.throwIfAborted();
    if(unchanged.issues.length||unchanged.fingerprint!==inventory.fingerprint)throw new Error('The source changed during migration. The copy is incomplete; repeat from a stable source.');
    const final=await destination.migrationInventory(family);signal.throwIfAborted();
    if(final.issues.length||final.fingerprint!==actual.fingerprint)throw new Error('The destination changed during verification. The copy is incomplete.');
    await root.removeEntry(MIGRATION_MARKER);complete=true;
    progress({stage:'complete',path:'',completed:inventory.items.length,total:inventory.items.length});return root;
  });}catch(error){
    const reason=signal.aborted?'Migration cancelled.':error instanceof Error?error.message:'Migration failed.';
    throw new Error(`${reason}${root&&!complete?` The incomplete destination “${name}” has been kept. Remove that folder before retrying with the same name.`:''} Your source vault is unchanged by Crypte.`);
  }finally{signal.removeEventListener('abort',abort);destination.close();}
}

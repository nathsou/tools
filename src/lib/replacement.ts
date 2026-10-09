import { digest,toBase64Url } from './bytes';
import { safePath } from './filesystem';
import { vaultWriteLock,writePermission } from './imports';
import type { VaultClient } from './client';
import type { EditFingerprint,VaultEntry } from './types';

async function checksum(file:File):Promise<string> {
  const bytes=new Uint8Array(await file.arrayBuffer());
  try{return toBase64Url(await digest(bytes));}finally{bytes.fill(0);}
}
/** Stage fresh ciphertext and retain a verified encrypted recovery copy until
 * publishing and verification complete. Never stage plaintext on disk. */
export async function saveText(root:FileSystemDirectoryHandle,client:VaultClient,entry:VaultEntry,file:File,parentId:string,vaultId:string,expected:EditFingerprint,signal:AbortSignal):Promise<string[]> {
  await writePermission(root);signal.throwIfAborted();
  return vaultWriteLock(vaultId,signal,async()=>{
    const plan=await client.beginReplacement(file,parentId,entry,expected),job=plan.import,warnings:string[]=[];
    const parts=safePath(job.nodePath);let folder=root;
    let writer:FileSystemWritableFileStream|undefined,stageName='',backupName='',ownsStage=false,ownsBackup=false,committing=false,keepBackup=false;
    const abort=()=>{if(writer&&!committing)void writer.abort().catch(()=>{});};signal.addEventListener('abort',abort);
    async function freshName(name:string) {
      try{await folder.getFileHandle(name);throw new Error('The encrypted recovery name is already in use.');}
      catch(error){if(!(error instanceof DOMException && error.name==='NotFoundError'))throw error;}
      return folder.getFileHandle(name,{create:true});
    }
    async function publish(handle:FileSystemFileHandle,blob:Blob,abortable:boolean) {
      writer=await handle.createWritable({mode:'exclusive'} as FileSystemCreateWritableOptions);
      for(let offset=0;offset<blob.size;offset+=4*1024*1024){if(abortable)signal.throwIfAborted();await writer.write(await blob.slice(offset,offset+4*1024*1024).arrayBuffer());}
      if(abortable)signal.throwIfAborted();await writer.close();writer=undefined;
    }
    try {
      for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part);
      signal.throwIfAborted();stageName=`.crypte-edit-${job.id}.tmp`;backupName=`.crypte-edit-${job.id}.bak`;
      const stage=await freshName(stageName);ownsStage=true;
      writer=await stage.createWritable();signal.throwIfAborted();await writer.write(job.header.slice());
      const packets:Uint8Array<ArrayBuffer>[]=[job.header];
      try {
        for(let offset=0;offset<job.size;offset+=4*1024*1024){signal.throwIfAborted();const bytes=await client.importChunk(job.id);packets.push(bytes);await writer.write(bytes.slice());}
        const tail=await client.finalizeImport(job.id);signal.throwIfAborted();packets.push(tail);await writer.write(tail.slice());
        signal.throwIfAborted();await writer.close();writer=undefined;
        const intended=await checksum(new File(packets,'ciphertext'));
        const staged=await stage.getFile();if(await checksum(staged)!==intended)throw new Error('The encrypted edit could not be verified. The original has been kept.');
        const target=await folder.getFileHandle(parts.at(-1)!),original=await target.getFile();
        if(original.size!==expected.size || original.lastModified!==expected.modified || await checksum(original)!==expected.digest)throw new Error('The file changed during saving. The original has been kept; reopen the editor.');
        signal.throwIfAborted();const backup=await freshName(backupName);ownsBackup=true;await publish(backup,original,true);
        if(await checksum(await backup.getFile())!==expected.digest)throw new Error('The encrypted recovery copy could not be verified. The original has been kept.');
        const current=await target.getFile();if(current.size!==expected.size || current.lastModified!==expected.modified || await checksum(current)!==expected.digest)throw new Error('The file changed during saving. Reopen the editor.');
        writer=await target.createWritable({mode:'exclusive'} as FileSystemCreateWritableOptions);
        signal.throwIfAborted();await writer.write(staged);signal.throwIfAborted();
        // Closing publishes the replacement. Complete verification or restore even
        // if the vault locks from this point; no keys or plaintext are needed.
        committing=true;
        try {
          await writer.close();writer=undefined;
          if(await checksum(await target.getFile())!==intended)throw new Error('The saved ciphertext could not be verified.');
        }catch(error){
          if(writer){await writer.abort().catch(()=>{});writer=undefined;}
          try{await publish(target,await backup.getFile(),false);if(await checksum(await target.getFile())!==expected.digest)throw new Error('Recovery verification failed.');}
          catch{keepBackup=true;throw new Error(`Saving and automatic recovery failed. The encrypted original is retained at ${[...parts.slice(0,-1),backupName].join('/')}. Keep this recovery copy and repair the vault before retrying.`);}
          throw new Error(`Saving failed; the original file was restored. ${error instanceof Error?error.message:''}`);
        }
      }finally{for(const packet of packets)packet.fill(0);}
      return warnings;
    }finally{
      signal.removeEventListener('abort',abort);if(writer)await writer.abort().catch(()=>{});
      if(ownsStage)await folder.removeEntry(stageName).catch(()=>warnings.push('An encrypted edit staging file could not be removed.'));
      if(ownsBackup&&!keepBackup)await folder.removeEntry(backupName).catch(()=>warnings.push('The encrypted recovery copy could not be removed.'));
      await client.endImport(job.id).catch(()=>{});
    }
  });
}

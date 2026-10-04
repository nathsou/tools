import {validateName,type VaultBootstrap} from './crypto';
import {safePath} from './filesystem';
import {vaultWriteLock,writePermission} from './imports';

/** Publish into a new child only; never initialize an existing directory. */
export async function persistVault(parent:FileSystemDirectoryHandle,name:string,bootstrap:VaultBootstrap,signal:AbortSignal):Promise<FileSystemDirectoryHandle> {
  name=validateName(name);
  if(/[<>:"|?*]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw new Error('Choose a vault name compatible with Windows, macOS and Linux.');
  await writePermission(parent);signal.throwIfAborted();
  return vaultWriteLock('vault-creation',signal,async()=>{
    for await(const [existing] of parent.entries())if(existing.toLocaleLowerCase()===name.toLocaleLowerCase())throw new Error('A file or folder with this vault name already exists. Choose another name.');
    signal.throwIfAborted();
    const root=await parent.getDirectoryHandle(name,{create:true});
    let committed=false,ownsRoot=false;
    try {
      for await(const _ of root.entries())throw new Error('The destination changed during creation. Choose another name.');
      ownsRoot=true;
      const write=async(folder:FileSystemDirectoryHandle,fileName:string,bytes:Uint8Array<ArrayBuffer>)=>{
        signal.throwIfAborted();const handle=await folder.getFileHandle(fileName,{create:true}),writer=await handle.createWritable();
        try{await writer.write(bytes);signal.throwIfAborted();await writer.close();}catch(e){await writer.abort().catch(()=>{});throw e;}
        const saved=new Uint8Array(await(await handle.getFile()).arrayBuffer());
        if(saved.length!==bytes.length||saved.some((byte,i)=>byte!==bytes[i]))throw new Error('The new vault metadata could not be verified.');
      };
      await write(root,'masterkey.cryptomator',new TextEncoder().encode(bootstrap.masterkey));
      let directory=root;for(const part of safePath(bootstrap.rootPath)){signal.throwIfAborted();directory=await directory.getDirectoryHandle(part,{create:true});}
      await write(directory,'dirid.c9r',bootstrap.backup);
      // The configuration is the final marker of a complete format-8 vault.
      await write(root,'vault.cryptomator',new TextEncoder().encode(bootstrap.configuration));
      signal.throwIfAborted();committed=true;return root;
    } catch(e) {
      if(!committed&&ownsRoot) {
        try{await parent.removeEntry(name,{recursive:true});}
        catch{throw new Error(`Vault creation failed and cleanup could not finish. Check “${name}” before retrying.`);}
      }
      throw e;
    }
  });
}

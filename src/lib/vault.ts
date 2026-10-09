import {parseUvf,unlockUvf,openUvf,uvfReadDirectory,type UvfMetadata} from './uvf';
import {sha256} from '@noble/hashes/sha2.js';
import {MIGRATION_MARKER} from './filesystem';
import { concat, digest, fromBase64, random, toBase64, toBase64Url, utf8, type Bytes } from './bytes';
import { chunkSize, layout, createDirectory, chunkOverhead, cleartextSize, createMaterial, decryptChunk, decryptHeader, decryptName, destroyMaterial, directoryPath, encryptChunk, encryptHeader, encryptName, headerSize, paddedBase64Url, parseConfiguration, parseMasterkey, unlockMasterkey, validateName, verifyConfiguration, verifyMasterkeyVersion, type FileHeader, type MasterkeyFile, type Material, type ParsedConfiguration } from './vault-format';
import { createStorage, isFilesystemMetadata, readSmall, type VaultStorage } from './filesystem';
import { classify, type ImportPlan, type Listing, type PasskeyRecord, type Source, type VaultEntry, type VaultInfo, type WritePlan, type WriteRequest,type TextSnapshot,type ReplacementPlan,type EditFingerprint } from './types';

export class Vault {
  private storage: VaultStorage;
  private config?: ParsedConfiguration;
  private uvf?: UvfMetadata;
  private metadataText='';
  private inventorySequence=0;
  private master!: MasterkeyFile;
  private material?: Material;
  private headers = new Map<string, { file:File; header:FileHeader }>();
  private files = new Map<string, VaultEntry>();
  private directories = new Set(['']);
  private imports = new Map<string,{ file?:File; size:number; header:FileHeader; material:Material; offset:number; pending:Bytes; index:number; finalized:boolean }>();
  private write?:{plan:WritePlan;request:WriteRequest};
  info!: VaultInfo;
  constructor(source: Source) { this.storage = createStorage(source); }
  async prepare(allowIncomplete=false): Promise<VaultInfo> {
    if(!allowIncomplete){let pending=false;try{await this.storage.file(MIGRATION_MARKER);pending=true;}catch(e){if(!(e instanceof DOMException&&e.name==='NotFoundError'))throw e;}if(pending)throw new Error('This vault is an incomplete migration. Your original vault is unchanged. Remove the incomplete destination and start a new migration.');}
    let configText = '';
    try { configText = await readSmall(this.storage, 'vault.cryptomator'); }
    catch (e) { if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e; }
    let uvfText='';
    try{uvfText=await readSmall(this.storage,'vault.uvf',1024*1024);}catch(e){if(!(e instanceof DOMException&&e.name==='NotFoundError'))throw e;}
    if(uvfText){
      let legacy=false;try{await this.storage.file('masterkey.cryptomator');legacy=true;}catch(e){if(!(e instanceof DOMException&&e.name==='NotFoundError'))throw e;}
      if(configText||legacy)throw new Error('This folder contains both UVF and Cryptomator metadata. Select a vault with one format.');
      this.uvf=parseUvf(uvfText);this.metadataText=uvfText;
      this.info={id:toBase64Url(await digest(utf8('uvf:v1:'+uvfText))),name:this.storage.name,family:'uvf',format:1,cipherCombo:'AES-256-GCM-32k'};return this.info;
    }
    if (configText) this.config = parseConfiguration(configText);
    const masterText = await readSmall(this.storage, this.config?.keyPath ?? 'masterkey.cryptomator');
    this.master = parseMasterkey(masterText);
    if (!this.config && this.master.version !== 7) throw new Error('Select the vault root containing vault.cryptomator and masterkey.cryptomator. Legacy formats before 7 are not supported.');
    this.info = { id:toBase64Url(await digest(utf8(`${configText}\n${masterText}`))), name:this.storage.name, family:'cryptomator', format:this.config ? this.config.payload.format : 7, cipherCombo:this.config?.payload.cipherCombo ?? 'SIV_CTRMAC' };
    return this.info;
  }
  async unlock(password: string, progress?: (p:number) => void): Promise<VaultInfo> {
    if(this.uvf)return this.acceptUvf(await unlockUvf(this.uvf,password,progress));
    const raw = await unlockMasterkey(this.master, password, progress);
    try { return await this.unlockRaw(raw); } finally { raw.fill(0); }
  }
  private async acceptUvf(material:import('./uvf').UvfMaterial):Promise<VaultInfo>{
    try{
      const path=await directoryPath('',material),file=await this.storage.file(`${path}/dir.uvf`);
      if(file.size!==128)throw new Error('Invalid UVF root directory metadata.');
      const token=await uvfReadDirectory(new Uint8Array(await file.arrayBuffer()),material);
      if(token!==path)throw new Error('UVF root directory metadata does not match the vault.');
      this.lock();this.material=material;return this.info;
    }catch(e){destroyMaterial(material);throw e;}
  }
  private async checkMetadata():Promise<void>{
    if(this.uvf&&await readSmall(this.storage,'vault.uvf',1024*1024)!==this.metadataText)throw new Error('Vault metadata changed. Lock and reopen the vault before writing.');
  }
  async migrationInventory(target:import('./types').VaultFamily):Promise<import('./types').MigrationInventory>{
    const ticket=++this.inventorySequence,check=()=>{this.unlocked();if(ticket!==this.inventorySequence)throw new Error('Vault check cancelled.');};
    const material=this.unlocked(),items:import('./types').MigrationItem[]=[],issues:string[]=[],hash=sha256.create();
    const queue=[{id:'',path:'',depth:0}],seen=new Set(['']);let bytes=0,files=0,folders=0;
    const add=async(path:string)=>{
      const file=await this.storage.file(path),h=sha256.create();
      try{for(let offset=0;offset<file.size;offset+=4*1024*1024){check();h.update(new Uint8Array(await file.slice(offset,offset+4*1024*1024).arrayBuffer()));}
        hash.update(utf8(JSON.stringify([path,file.size,toBase64Url(h.digest())])));
      }finally{h.destroy();}
    };
    try{
      for(const path of this.uvf?['vault.uvf']:this.config?['vault.cryptomator',this.config.keyPath]:['masterkey.cryptomator'])await add(path);
      for(let index=0;index<queue.length;index++){
        check();
        const current=queue[index];if(current.depth>128||items.length>100000)throw new Error('The vault is too large or deeply nested to migrate safely.');
        const listing=await this.list(current.id),names=new Set<string>();issues.push(...listing.warnings.map(w=>`${current.path||'/'}: ${w}`));
        const storagePath=await directoryPath(current.id,material);
        // Include directory metadata and name mappings in the source snapshot.
        for(const node of (await this.storage.list(storagePath)).sort((a,b)=>a.name.localeCompare(b.name))){
          if(isFilesystemMetadata(node)||!(node.name===layout(material).backup||node.name.endsWith(layout(material).extension)||(material.combo!=='UVF'&&node.name.endsWith('.c9s'))))continue;
          const path=`${storagePath}/${node.name}`;
          if(node.kind==='file')await add(path);
          else for(const child of (await this.storage.list(path)).sort((a,b)=>a.name.localeCompare(b.name))){if(isFilesystemMetadata(child))continue;if(child.kind!=='file'){issues.push(`${path}: unexpected nested encrypted directory.`);continue;}await add(`${path}/${child.name}`);}
        }
        for(const entry of listing.entries.sort((a,b)=>a.name.localeCompare(b.name))){
          check();
          const path=current.path?`${current.path}/${entry.name}`:entry.name;
          try{if(validateName(entry.name)!==entry.name)throw new Error('Filename is not NFC-normalized.');if(target==='uvf'&&utf8(entry.name).length>172)throw new Error('UVF supports names up to 172 UTF-8 bytes. Shorten this name first.');}
          catch(e){issues.push(`${path}: ${e instanceof Error?e.message:'Invalid name.'}`);}
          const normalized=entry.name.normalize('NFC').toLowerCase();if(names.has(normalized))issues.push(`${path}: case-insensitive filename collision. Rename one of the entries first.`);names.add(normalized);
          items.push({path,parentId:current.id,entry:{...entry}});
          if(entry.kind==='folder'){
            folders++;if(seen.has(entry.directoryId!)){issues.push(`${path}: duplicate or cyclic directory identity.`);continue;}seen.add(entry.directoryId!);queue.push({id:entry.directoryId!,path,depth:current.depth+1});
          }else{
            files++;bytes+=entry.size;if(!Number.isSafeInteger(bytes))throw new Error('Vault size exceeds the supported range.');
            if(target==='uvf'&&Math.floor(entry.size/32740)+1>2**32)issues.push(`${path}: file exceeds the UVF size limit.`);
            // Authenticate every source chunk during preflight, including empty files.
            for(let start=0;start<entry.size||start===0;start+=4*1024*1024){check();try{const clear=await this.read(entry.id,start,Math.min(entry.size,start+4*1024*1024));clear.fill(0);}catch(e){issues.push(`${path}: ${e instanceof Error?e.message:'Unreadable file.'}`);break;}if(!entry.size)break;}
            if(target==='uvf'&&entry.kind==='symlink'){
              if(entry.size>1024*1024)issues.push(`${path}: symlink target is too large.`);
              else try{const clear=await this.read(entry.id,0,entry.size);try{const target=new TextDecoder('utf-8',{fatal:true}).decode(clear);if(target!==target.normalize('NFC'))issues.push(`${path}: symlink target is not NFC-normalized.`);}finally{clear.fill(0);}}catch{issues.push(`${path}: invalid symlink target.`);}
            }
          }
        }
      }
      check();if(this.material!==material)throw new Error('The vault was locked.');
      return {items,fingerprint:toBase64Url(hash.digest()),issues,bytes,files,folders};
    }finally{hash.destroy();}
  }
  cancelInventory():void {this.inventorySequence++;}
  private async unlockRaw(raw: Bytes): Promise<VaultInfo> {
    if(this.uvf)return this.acceptUvf(await openUvf(this.uvf,raw));
    if (this.config) await verifyConfiguration(this.config, raw);
    const material = await createMaterial(raw, this.info.cipherCombo as import('./types').CipherCombo);
    try {
      await verifyMasterkeyVersion(this.master, material);
      await this.storage.list(await directoryPath('', material));
    } catch (e) { destroyMaterial(material); throw e; }
    this.lock(); this.material = material;
    return this.info;
  }
  private unlocked(): Material { if (!this.material) throw new Error('The vault is locked.'); return this.material; }
  async list(directoryId: string): Promise<Listing> {
    const material = this.unlocked();
    if (!this.directories.has(directoryId)) throw new Error('Unknown vault folder.');
    // A refresh must reopen File snapshots and reauthenticate their headers.
    this.headers.clear();
    const path = await directoryPath(directoryId, material), format=layout(material);
    if(material.combo==='UVF'){
      const backup=await this.storage.file(`${path}/dir.uvf`);
      if(backup.size!==128||await uvfReadDirectory(new Uint8Array(await backup.arrayBuffer()),material)!==path)throw new Error('UVF directory backup does not match its identity.');
    }
    const nodes = await this.storage.list(path);
    const entries: VaultEntry[] = [], warnings: string[] = [];
    for (const node of nodes) {
      if (isFilesystemMetadata(node) || node.name === format.backup || !(node.name.endsWith(format.extension)||(material.combo!=='UVF'&&node.name.endsWith('.c9s')))) continue;
      const nodePath = `${path}/${node.name}`;
      let name = node.name;
      try {
        let cipherName = node.name;
        if (material.combo!=='UVF'&&node.name.endsWith('.c9s')) {
          if (node.kind !== 'directory') throw new Error('Invalid shortened-name entry.');
          cipherName = await readSmall(this.storage, `${nodePath}/name.c9s`, 16384);
          if (!cipherName.endsWith('.c9r')) throw new Error('Invalid name mapping.');
        }
        name = decryptName(cipherName.slice(0,-4), directoryId, material);
        if (node.kind === 'directory') {
          const children = await this.storage.list(nodePath);
          if(material.combo==='UVF'){
            const metadata=children.filter(n=>!isFilesystemMetadata(n));
            if(metadata.length!==1||metadata[0].kind!=='file'||![format.directory,format.symlink].includes(metadata[0].name))throw new Error('Invalid or ambiguous UVF entry metadata.');
          }
          if (children.some(n => n.name === format.directory && n.kind === 'file')) {
            let id:string;
            if(material.combo==='UVF'){
              const file=await this.storage.file(`${nodePath}/${format.directory}`);
              if(file.size!==128)throw new Error('Invalid UVF directory metadata.');
              id=await uvfReadDirectory(new Uint8Array(await file.arrayBuffer()),material);
            }else{
              id=await readSmall(this.storage,`${nodePath}/${format.directory}`,36);
              if(!/^[\x20-\x7e]{1,36}$/.test(id))throw new Error('Invalid directory ID.');
            }
            this.directories.add(id);
            entries.push({ id:nodePath, name, kind:'folder', path:nodePath, directoryId:id, size:0, modified:0, mime:'' });
            continue;
          }
          if (children.some(n => n.name === format.symlink)) {
            const entry = await this.fileEntry(name, `${nodePath}/${format.symlink}`, material);
            entry.kind = 'symlink'; entry.mime = 'text/plain'; entries.push(entry); continue;
          }
          if (node.name.endsWith('.c9s') && children.some(n => n.name === 'contents.c9r')) {
            entries.push(await this.fileEntry(name, `${nodePath}/contents.c9r`, material)); continue;
          }
          throw new Error('Missing folder ID or file contents. The vault may not be fully synced.');
        }
        entries.push(await this.fileEntry(name, nodePath, material));
      } catch (e) { warnings.push(`${name}: ${e instanceof Error ? e.message : 'Unavailable entry.'}`); }
    }
    this.unlocked();
    return { entries, warnings };
  }
  private async fileEntry(name: string, path: string, material: Material): Promise<VaultEntry> {
    const file = await this.storage.file(path);
    const entry: VaultEntry = { id:path, path, name, ...classify(name), size:cleartextSize(file.size, material.combo), modified:file.lastModified };
    this.files.set(entry.id,entry); return entry;
  }
  async read(id: string, start: number, end: number): Promise<Bytes> {
    const material = this.unlocked(), CLEAR_CHUNK=chunkSize(material.combo);
    const entry = this.files.get(id);
    if (!entry) throw new Error('Unknown vault file.');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > entry.size || end - start > 8 * 1024 * 1024) throw new Error('Invalid or oversized file range.');
    let cached = this.headers.get(id);
    if (!cached) {
      const file = await this.storage.file(entry.path);
      if (cleartextSize(file.size,material.combo) !== entry.size) throw new Error('The file changed. Refresh the folder before opening it again.');
      const header = await decryptHeader(new Uint8Array(await file.slice(0,headerSize(material.combo)).arrayBuffer()),material);
      if(material.combo==='UVF'){
        const last=Math.floor((file.size-68)/32768),offset=68+last*32768;
        const tail=await decryptChunk(new Uint8Array(await file.slice(offset).arrayBuffer()),last,header,material);tail.fill(0);
      }
      cached = { file, header };
      if (this.headers.size >= 32) this.headers.delete(this.headers.keys().next().value!);
      this.headers.set(id,cached);
    }
    if (start === end) return new Uint8Array();
    const first = Math.floor(start / CLEAR_CHUNK), last = Math.floor((end - 1) / CLEAR_CHUNK);
    const output = new Uint8Array(end - start);
    const encryptedChunkSize = CLEAR_CHUNK + chunkOverhead(material.combo);
    try {
      for (let index = first; index <= last; index++) {
        this.unlocked();
        const offset = headerSize(material.combo) + index * encryptedChunkSize;
        const encrypted = new Uint8Array(await cached.file.slice(offset,offset + encryptedChunkSize).arrayBuffer());
        const clear = await decryptChunk(encrypted,index,cached.header,material);
        const a = Math.max(start,index * CLEAR_CHUNK), b = Math.min(end,(index+1) * CLEAR_CHUNK);
        output.set(clear.subarray(a-index*CLEAR_CHUNK,b-index*CLEAR_CHUNK),a-start); clear.fill(0);
      }
      if (this.material !== material) throw new Error('The vault was locked.');
      return output;
    } catch (e) { output.fill(0); throw e; }
  }
  async seal(prf: Bytes, record: Omit<PasskeyRecord,'iv'|'ciphertext'>): Promise<PasskeyRecord> {
    if (record.vaultId !== this.info.id) throw new Error('Passkey belongs to another vault.');
    const key = await wrappingKey(prf,record);
    const iv = random(12);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:binding(record) },key,this.unlocked().raw));
    return { ...record, version:this.uvf?2:1, iv:toBase64(iv), ciphertext:toBase64(ciphertext) };
  }
  async beginImport(file:File,directoryId:string):Promise<ImportPlan> {return this.beginReadableImport(file.name,file.size,directoryId,file);}
  async beginReadableImport(filename:string,size:number,directoryId:string,file?:File,symlink=false):Promise<ImportPlan> {
    const material=this.unlocked();
    await this.checkMetadata();
    if (this.imports.size || this.write) throw new Error('Another vault write is in progress.');
    if (!Number.isSafeInteger(size) || size < 0 || (material.combo==='UVF'?Math.floor(size/chunkSize(material.combo))+1:Math.ceil(size/chunkSize(material.combo))) > 2 ** 32) throw new Error('Unsupported file size.');
    const original=validateName(filename);
    const listing=await this.list(directoryId), folder=await directoryPath(directoryId,material);
    const names=new Set(listing.entries.map(entry=>entry.name.normalize('NFC').toLowerCase()));
    const occupied=new Set((await this.storage.list(folder)).map(entry=>entry.name));
    let name=original, encryptedName='', nodeName='', shortened=false;
    for(let number=1;number<=10000;number++) {
      if (number>1) name=numberedName(original,number);
      encryptedName=encryptName(name,directoryId,material);
      shortened=material.combo!=='UVF'&&encryptedName.length>(this.config?.payload.shorteningThreshold ?? 220);
      nodeName=shortened ? `${paddedBase64Url(await digest(utf8(encryptedName),'SHA-1'))}.c9s` : encryptedName;
      if (!names.has(name.toLowerCase()) && !occupied.has(nodeName)) break;
      if (number===10000) throw new Error('Unable to find an unused filename.');
    }
    const { bytes,header }=await encryptHeader(material), id=toBase64Url(random(16));
    if (this.material !== material) throw new Error('The vault was locked.');
    this.imports.set(id,{ file,size,header,material,offset:0,pending:new Uint8Array(),index:0,finalized:false });
    return { id,name,nodePath:`${folder}/${nodeName}`,encryptedName,shortened,size,header:bytes,payloadName:symlink?layout(material).symlink:undefined };
  }
  async importChunk(id:string,supplied?:Bytes):Promise<Bytes> {
    const job=this.imports.get(id);
    if (!job || job.material !== this.unlocked()) throw new Error('The file import is no longer active.');
    if(job.finalized)throw new Error('The file has already been encrypted.');
    const end=Math.min(job.size,job.offset+4*1024*1024);
    if(end===job.offset)throw new Error('The file has already been encrypted.');
    const plaintext=supplied ?? (job.file ? new Uint8Array(await job.file.slice(job.offset,end).arrayBuffer()) : undefined);
    if(!plaintext)throw new Error('Missing import bytes.');
    let combined:Bytes|undefined;
    try{
      if(plaintext.length!==end-job.offset)throw new Error('The source file changed while importing.');
      combined=concat(job.pending,plaintext);job.pending.fill(0);
      const chunks:Bytes[]=[],size=chunkSize(job.material.combo);
      let position=0;
      while(combined.length-position>=size){
        if(job.material!==this.unlocked())throw new Error('The vault was locked.');
        chunks.push(await encryptChunk(combined.subarray(position,position+size),job.index++,job.header,job.material));position+=size;
      }
      job.pending=combined.slice(position);job.offset=end;
      // Keep the established Cryptomator import API: its last batch includes the tail.
      if(end===job.size&&job.material.combo!=='UVF'&&job.pending.length){chunks.push(await encryptChunk(job.pending,job.index++,job.header,job.material));job.pending.fill(0);job.pending=new Uint8Array();}
      return concat(...chunks);
    }finally{plaintext.fill(0);combined?.fill(0);}
  }
  async finalizeImport(id:string):Promise<Bytes>{
    const job=this.imports.get(id);
    if(!job||job.material!==this.unlocked()||job.finalized)throw new Error('The file import is no longer active.');
    if(job.offset!==job.size)throw new Error('File import is incomplete.');
    await this.checkMetadata();job.finalized=true;
    try{return job.pending.length||job.material.combo==='UVF'?await encryptChunk(job.pending,job.index,job.header,job.material):new Uint8Array();}
    finally{job.pending.fill(0);}
  }
  private cacheKey?:Promise<CryptoKey>;
  async cacheCrypt(bytes:Bytes,binding:string,open=false):Promise<Bytes> {
    const material=this.unlocked();
    if(bytes.length>4*1024*1024+64 || binding.length>2048)throw new Error("Cache record is too large.");
    this.cacheKey ??= crypto.subtle.importKey("raw",material.combo==='UVF'?material.cacheSecret:material.raw,"HKDF",false,["deriveKey"]).then(key=>crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt:utf8(this.info.id),info:utf8("crypte-private-cache-v1")},key,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]));
    try {const key=await this.cacheKey,iv=open?bytes.slice(0,12):random(12);
      const result=new Uint8Array(await crypto.subtle[open?"decrypt":"encrypt"]({name:"AES-GCM",iv,additionalData:utf8(binding)},key,open?bytes.subarray(12):bytes));
      if(this.material!==material){result.fill(0);throw new Error("The vault was locked.");}
      return open?result:concat(iv,result);
    } finally {bytes.fill(0);}
  }
  endImport(id:string):void {this.imports.get(id)?.pending.fill(0);this.imports.delete(id);}
  async readText(id:string):Promise<TextSnapshot> {
    const material=this.unlocked(),entry=this.files.get(id);
    if(!entry || entry.kind!=='text' || entry.mime==='application/rtf')throw new Error('Only plain text files can be edited.');
    if(entry.size>2*1024*1024)throw new Error('Editing is limited to complete text files up to 2 MiB.');
    const file=await this.storage.file(entry.path);
    if(cleartextSize(file.size,material.combo)!==entry.size)throw new Error('The file changed. Refresh and reopen it before editing.');
    const encrypted=new Uint8Array(await file.arrayBuffer());let bytes:Bytes|undefined;
    try {
      const header=await decryptHeader(encrypted.subarray(0,headerSize(material.combo)),material);
      this.headers.set(id,{file,header});bytes=await this.read(id,0,entry.size);
      const fingerprint={path:entry.path,size:file.size,modified:file.lastModified,digest:toBase64Url(await digest(encrypted))};
      if(this.material!==material)throw new Error('The vault was locked.');
      return {bytes,fingerprint};
    }catch(error){bytes?.fill(0);throw error;}finally{encrypted.fill(0);}
  }
  async beginReplacement(file:File,parentId:string,entryId:string,expected:EditFingerprint):Promise<ReplacementPlan> {
    const material=this.unlocked();
    await this.checkMetadata();
    if(this.imports.size || this.write)throw new Error('Another vault write is in progress.');
    const listing=await this.list(parentId),entry=listing.entries.find(entry=>entry.id===entryId);
    if(!entry || entry.kind!=='text' || entry.mime==='application/rtf' || file.name!==entry.name)throw new Error('Only the original plain text file can be saved.');
    if(file.size>2*1024*1024 || entry.size>2*1024*1024)throw new Error('Text editing is limited to 2 MiB.');
    const source=await this.storage.file(entry.path),encrypted=new Uint8Array(await source.arrayBuffer());
    let fingerprint:EditFingerprint;
    try{fingerprint={path:entry.path,size:source.size,modified:source.lastModified,digest:toBase64Url(await digest(encrypted))};}finally{encrypted.fill(0);}
    if(expected.path!==fingerprint.path || expected.size!==fingerprint.size || expected.modified!==fingerprint.modified || expected.digest!==fingerprint.digest)throw new Error('The file changed since you opened the editor. Cancel and reopen it before saving; your draft has been kept.');
    const {bytes,header}=await encryptHeader(material),id=toBase64Url(random(16));
    if(this.material!==material)throw new Error('The vault was locked.');
    this.imports.set(id,{file,size:file.size,header,material,offset:0,pending:new Uint8Array(),index:0,finalized:false});
    return {source:fingerprint,import:{id,name:entry.name,nodePath:entry.path,encryptedName:'',shortened:false,size:file.size,header:bytes}};
  }
  private async destination(parentId:string,name:string,except?:string) {
    const material=this.unlocked(),listing=await this.list(parentId);
    if(listing.entries.some(entry=>entry.id!==except && !(except && entry.id.startsWith(`${except}/`)) && entry.name.normalize('NFC').toLowerCase()===name.toLowerCase()))throw new Error('An item with this name already exists. Choose another name.');
    const encrypted=encryptName(name,parentId,material),shortened=material.combo!=='UVF'&&encrypted.length>(this.config?.payload.shorteningThreshold ?? 220);
    const folder=await directoryPath(parentId,material),nodeName=shortened ? `${paddedBase64Url(await digest(utf8(encrypted),'SHA-1'))}.c9s` : encrypted;
    const path=`${folder}/${nodeName}`;
    if(path!==except && (await this.storage.list(folder)).some(node=>node.name===nodeName))throw new Error('The encrypted destination already exists. Refresh the folder.');
    return {path,shortened,encrypted};
  }
  private async directoryTree(material:Material) {
    const graph=new Map<string,{path:string;parent:string}>(),descendants=new Map<string,string[]>(),seen=new Set(['']),queue=[''];
    for(let index=0;index<queue.length;index++) {
      if(queue.length>100000)throw new Error('The folder tree is too large to validate safely.');
      const id=queue[index],children=await this.list(id);
      if(children.warnings.length)throw new Error('The vault has unreadable entries. Repair them in a compatible vault client before moving or recursively deleting folders.');
      descendants.set(id,children.entries.filter(child=>child.kind==='folder').map(child=>child.directoryId!));
      for(const child of children.entries.filter(child=>child.kind==='folder')) {
        const childId=child.directoryId!;
        if(seen.has(childId))throw new Error('The vault has duplicate or cyclic folder IDs. Repair it in a compatible vault client before changing folders.');
        seen.add(childId);queue.push(childId);graph.set(childId,{path:await directoryPath(childId,material),parent:id});
      }
    }
    return {graph,descendants};
  }
  async planWrite(request:WriteRequest):Promise<WritePlan> {
    const material=this.unlocked();
    await this.checkMetadata();
    if(this.imports.size || this.write)throw new Error('Another vault write is in progress.');
    const plan:WritePlan={id:toBase64Url(random(16)),kind:request.kind,name:'',sourceFiles:[],removedFolders:[]};
    if(request.kind==='mkdir') {
      plan.name=validateName(request.name);
      const target=await this.destination(request.parentId,plan.name);
      plan.target={path:target.path,directory:true,payloadName:layout(material).directory,mapping:target.shortened?target.encrypted:undefined};
      plan.createdFolder=await createDirectory(material);
    } else {
      const listing=await this.list(request.parentId),entry=listing.entries.find(entry=>entry.id===request.entryId);
      if(!entry)throw new Error('This item changed or is no longer in this folder. Refresh and try again.');
      plan.entry={...entry};plan.name=entry.name;
      const sourcePath=entry.kind==='folder' ? entry.path : entry.kind==='symlink' || entry.path.endsWith('/contents.c9r') ? entry.path.slice(0,entry.path.lastIndexOf('/')) : entry.path;
      plan.sourcePath=sourcePath;
      const payload=entry.kind==='folder' ? layout(material).directory : entry.kind==='symlink' ? layout(material).symlink : entry.path.endsWith('/contents.c9r') ? 'contents.c9r' : '';
      const paths=payload ? (await this.storage.list(sourcePath)).filter(node=>!isFilesystemMetadata(node)).map(node=>{
        if(node.kind!=='file' || ![payload,'name.c9s'].includes(node.name))throw new Error('This entry contains unexpected metadata. Repair it in a compatible vault client before changing it.');
        return `${sourcePath}/${node.name}`;
      }) : [sourcePath];
      for(const path of paths){const file=await this.storage.file(path);plan.sourceFiles.push({path,size:file.size,modified:file.lastModified});}
      if(request.kind==='move') {
        plan.name=validateName(request.name);
        if(entry.kind==='folder') {
          const {graph}=await this.directoryTree(material);
          let id=request.targetId;const seen=new Set<string>();
          while(id){if(id===entry.directoryId)throw new Error('A folder cannot be moved into itself or one of its subfolders.');if(seen.has(id))throw new Error('Invalid folder hierarchy.');seen.add(id);const parent=graph.get(id)?.parent;if(parent===undefined)throw new Error('Unknown destination folder.');id=parent;}
        }
        if(request.targetId===request.parentId && plan.name===entry.name){plan.noop=true;}
        else {
          const target=await this.destination(request.targetId,plan.name,sourcePath);
          plan.target={path:target.path,directory:entry.kind==='folder'||entry.kind==='symlink'||target.shortened,payloadName:entry.kind==='folder'?layout(material).directory:entry.kind==='symlink'?layout(material).symlink:target.shortened?'contents.c9r':'',mapping:target.shortened?target.encrypted:undefined};
        }
      } else if(entry.kind==='folder') {
        // Check the whole reachable graph before recursive deletion: duplicate IDs
        // would otherwise allow deleting another folder's shared content directory.
        const {graph,descendants}=await this.directoryTree(material);
        const pending=[entry.directoryId!];
        for(let index=0;index<pending.length;index++) {
          const id=pending[index],node=graph.get(id);if(!node)throw new Error('The source folder changed. Refresh and try again.');
          plan.removedFolders.push({id,path:node.path});
          pending.push(...(descendants.get(id) ?? []));
        }
        plan.removedFolders.reverse();
      }
    }
    if(this.material!==material)throw new Error('The vault was locked.');
    this.write={plan,request};return plan;
  }
  finishWrite(id:string,committed:boolean):void {
    if(this.write?.plan.id!==id)return;
    const {plan}=this.write;this.write=undefined;this.headers.clear();
    if(committed){
      if(plan.entry)this.files.delete(plan.entry.id);
      for(const [fileId,file] of this.files)if(plan.removedFolders.some(folder=>file.path.startsWith(`${folder.path}/`)))this.files.delete(fileId);
      if(plan.createdFolder)this.directories.add(plan.createdFolder.id);
      for(const folder of plan.removedFolders)this.directories.delete(folder.id);
    }
  }
  async unlockPasskey(prf: Bytes, record: PasskeyRecord): Promise<VaultInfo> {
    if (record.version !== (this.uvf?2:1) || record.vaultId !== this.info.id) throw new Error('Passkey belongs to another vault or the vault keys have changed.');
    const key = await wrappingKey(prf,record);
    let raw: Bytes;
    try { raw = new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM', iv:fromBase64(record.iv), additionalData:binding(record) },key,fromBase64(record.ciphertext))); }
    catch { throw new Error('Unable to unlock with this passkey. Use the vault password and set up the passkey again.'); }
    try { return await this.unlockRaw(raw); } finally { raw.fill(0); }
  }
  lock(): void {
    this.cancelInventory();
    for(const job of this.imports.values())job.pending.fill(0);
    if (this.material) destroyMaterial(this.material);
    this.material = undefined; this.cacheKey=undefined; this.headers.clear(); this.files.clear(); this.imports.clear(); this.directories = new Set(['']);this.write=undefined;
  }
}
function numberedName(original:string,number:number):string {
  const dot=original.lastIndexOf('.'), extension=dot>0 ? original.slice(dot) : '', suffix=` (${number})${extension}`;
  const stem=Array.from(dot>0 ? original.slice(0,dot) : original);
  while(stem.length && utf8(stem.join('')+suffix).length>255)stem.pop();
  return validateName(stem.join('')+suffix);
}
function binding(record: Pick<PasskeyRecord,'vaultId'|'credentialId'|'origin'>): Bytes { return utf8(`crypte:v1:${record.origin}:${record.vaultId}:${record.credentialId}`); }
async function wrappingKey(prf: Bytes, record: Pick<PasskeyRecord,'salt'|'vaultId'|'credentialId'|'origin'>): Promise<CryptoKey> {
  if (prf.length !== 32 || fromBase64(record.salt).length !== 32) throw new Error('Invalid passkey key material.');
  const input = await crypto.subtle.importKey('raw',prf,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({ name:'HKDF', hash:'SHA-256', salt:fromBase64(record.salt), info:binding(record) },input,{ name:'AES-GCM', length:256 },false,['encrypt','decrypt']);
}

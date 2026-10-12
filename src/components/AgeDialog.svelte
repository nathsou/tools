<script lang="ts">
  import {onDestroy,onMount} from 'svelte';
  import Icon from './Icon.svelte';
  import {focusDialog} from '../lib/focus';
  import type {VaultClient} from '../lib/client';
  import {classify,formatSize,type VaultEntry} from '../lib/types';
  import {AGE_EXTENSION,decryptAge,decryptedName,encryptAge,encryptedSizeEstimate,inspectAge,parseIdentities,parseRecipients,unlockAge,x25519Available,type AgeEncryptKeys,type AgeHeaderInfo,type AgeUnlocked} from '../lib/age';
  import {fileChunks} from '../lib/downloads';
  import {canStreamToDisk,chooseSaveTarget,MEMORY_LIMIT,saveChunks} from '../lib/save';
  import {EncryptedSpool} from '../lib/private-cache';
  let {mode,entry,client,canWrite,preparewrite,onsave,onbusy,onclose}:{mode:'encrypt'|'decrypt';entry:VaultEntry;client:VaultClient;canWrite:boolean;preparewrite:()=>Promise<void>;onsave:(name:string,spool:EncryptedSpool,signal:AbortSignal)=>Promise<string>;onbusy:(busy:boolean)=>void;onclose:()=>void}=$props();
  const HEADER_BATCH=64*1024;
  const lifetime=new AbortController();let task:AbortController|undefined;
  let method=$state<'passphrase'|'recipients'>('passphrase'),passphrase=$state(''),confirm=$state(''),recipients=$state(''),armor=$state(false),identities=$state(''),name=$state('');
  let header=$state.raw<AgeHeaderInfo>(),unlocked=$state.raw<AgeUnlocked>(),inspecting=$state(false),working=$state(''),fraction=$state<number>(),error=$state(''),done=$state(''),keysSupported=$state(true);
  let identityPicker=$state<HTMLInputElement>();
  const output=$derived(`${entry.name}${AGE_EXTENSION}`);
  const message=(e:unknown)=>e instanceof Error?e.message:'Something went wrong. Please try again.';
  const cancelled=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
  const progress=(value:{bytes:number;totalBytes:number})=>{fraction=value.totalBytes?value.bytes/value.totalBytes:1;};
  const keyProgress=(value:number)=>{working='Deriving key from passphrase';fraction=value;};
  onMount(()=>{
    name=decryptedName(entry.name);
    void x25519Available().then(value=>keysSupported=value);
    if(mode==='decrypt')void inspect();
  });
  onDestroy(()=>{lifetime.abort();unlocked?.dispose();passphrase=confirm=identities='';});
  async function inspect(){
    inspecting=true;
    try{header=await inspectAge(fileChunks(client,entry,{signal:lifetime.signal},HEADER_BATCH));}
    catch(e){if(!lifetime.signal.aborted)error=message(e);}
    finally{inspecting=false;}
  }
  async function run(label:string,job:(signal:AbortSignal)=>Promise<void>){
    if(working)return;
    const active=new AbortController(),signal=AbortSignal.any([lifetime.signal,active.signal]);
    task=active;working=label;fraction=undefined;error=done='';onbusy(true);
    try{await job(signal);}
    catch(e){if(!lifetime.signal.aborted){if(signal.aborted||cancelled(e))done='Cancelled. Nothing was saved.';else error=message(e);}}
    finally{if(task===active)task=undefined;if(!lifetime.signal.aborted){working='';fraction=undefined;onbusy(false);}}
  }
  async function encrypt(event:SubmitEvent){
    event.preventDefault();if(working)return;error=done='';
    let keys:AgeEncryptKeys;
    try{
      if(method==='passphrase'){if(!passphrase)throw new Error('Choose a passphrase.');if(passphrase!==confirm)throw new Error('The passphrases do not match.');keys={passphrase};}
      else keys={recipients:parseRecipients(recipients)};
    }catch(e){error=message(e);return;}
    if(!canStreamToDisk()&&encryptedSizeEstimate(entry.size,'recipients' in keys?keys.recipients.length:1,armor)>MEMORY_LIMIT){error='Files over 128 MiB require a browser with Save File support, such as desktop Chrome or Edge.';return;}
    let target:FileSystemFileHandle|undefined;
    // The save picker needs the click's user activation, so it opens before key derivation.
    try{target=await chooseSaveTarget(output);}catch(e){if(!cancelled(e))error=message(e);return;}
    await run('passphrase' in keys?'Deriving key from passphrase':'Encrypting',async signal=>{
      const source=fileChunks(client,entry,{signal,progress:value=>{working='Encrypting';progress(value);}});
      await saveChunks(target,output,'application/octet-stream',encryptAge(source,keys,{armor,signal,onKeyProgress:keyProgress}),signal);
      passphrase=confirm='';
      done=`Saved ${output}. ${'passphrase' in keys?'Share the passphrase separately from the file.':'Only the matching secret keys can open it.'} It opens with the Age tool, Crypte or the age command-line tools.`;
    });
  }
  async function unlock(event:SubmitEvent){
    event.preventDefault();const info=header;if(!info||working)return;
    await run(info.passphrase?'Deriving key from passphrase':'Checking keys',async signal=>{
      const keys=info.passphrase?{passphrase}:{identities:await parseIdentities(identities)};
      if('passphrase' in keys&&!keys.passphrase)throw new Error('Enter the passphrase.');
      unlocked=await unlockAge(fileChunks(client,entry,{signal},HEADER_BATCH),keys,{signal,onKeyProgress:keyProgress});
      passphrase=identities='';
    });
  }
  function outputName():string {const value=name.trim();if(!value)throw new Error('Enter a name for the decrypted file.');return value;}
  async function saveToVault(){
    const key=unlocked;if(!key||working)return;
    let target:string;try{target=outputName();await preparewrite();}catch(e){error=message(e);return;}
    await run('Decrypting',async signal=>{
      const spool=new EncryptedSpool(client,signal);
      try{
        await spool.init();let position=0;
        // Authenticate the complete payload into an encrypted spool before anything reaches the vault.
        for await(const chunk of decryptAge(fileChunks(client,entry,{signal,progress}),{unlocked:key},{signal})){await spool.write(chunk,position);position+=chunk.length;}
        working='Saving encrypted copy';fraction=undefined;
        const saved=await onsave(target,spool,signal);
        done=`Saved “${saved}” to this folder, encrypted by the vault.`;
      }finally{await spool.dispose();}
    });
  }
  async function download(){
    const key=unlocked;if(!key||working)return;
    let target:string;try{target=outputName();}catch(e){error=message(e);return;}
    if(!canStreamToDisk()&&entry.size>MEMORY_LIMIT+HEADER_BATCH){error='Files over 128 MiB require a browser with Save File support, such as desktop Chrome or Edge.';return;}
    let handle:FileSystemFileHandle|undefined;
    try{handle=await chooseSaveTarget(target);}catch(e){if(!cancelled(e))error=message(e);return;}
    await run('Decrypting',async signal=>{
      await saveChunks(handle,target,classify(target).mime,decryptAge(fileChunks(client,entry,{signal,progress}),{unlocked:key},{signal}),signal);
      done=`Downloaded ${target}. This is an unencrypted copy.`;
    });
  }
  async function loadIdentity(event:Event){
    const picker=event.currentTarget as HTMLInputElement,file=picker.files?.[0];picker.value='';
    if(!file)return;
    if(file.size>64*1024){error='That file is too large to be an age identity file.';return;}
    identities=await file.text();error='';
  }
</script>
<div class="modal-backdrop" role="presentation" onclick={event=>{if(event.target===event.currentTarget&&!working)onclose();}}>
  <div class="settings-dialog age-dialog" role="dialog" aria-modal="true" aria-label={mode==='encrypt'?'Encrypt with age':'Decrypt age file'} tabindex="-1" use:focusDialog>
    <div class="dialog-heading"><div><span class="card-eyebrow">AGE FILE ENCRYPTION</span><h2>{mode==='encrypt'?'Encrypt with age':'Decrypt age file'}</h2></div><button type="button" class="icon-button" aria-label="Close age encryption" onclick={onclose}><Icon name="close"/></button></div>
    <p class="conversion-filename">{entry.name} · {formatSize(entry.size)}</p>
    {#if mode==='encrypt'}
      <p class="dialog-description">Export an encrypted copy of this file in the standard age format, to share or store outside the vault. The vault is not changed.</p>
      <form onsubmit={encrypt}>
        <fieldset class="age-method" disabled={Boolean(working)}><legend>Protect with</legend>
          <label class:chosen={method==='passphrase'}><input type="radio" name="age-method" value="passphrase" bind:group={method}/><span><strong>Passphrase</strong><small>Share it privately</small></span></label>
          <label class:chosen={method==='recipients'}><input type="radio" name="age-method" value="recipients" bind:group={method} disabled={!keysSupported}/><span><strong>Public keys</strong><small>{keysSupported?'age1… recipients':'Unsupported in this browser'}</small></span></label>
        </fieldset>
        {#if method==='passphrase'}
          <label class="input-label" for="age-passphrase">Passphrase</label><input class="item-name-input" id="age-passphrase" type="password" autocomplete="new-password" bind:value={passphrase} disabled={Boolean(working)}/>
          <label class="input-label" for="age-confirm">Confirm passphrase</label><input class="item-name-input" id="age-confirm" type="password" autocomplete="new-password" bind:value={confirm} disabled={Boolean(working)}/>
          <p class="setting-note">Use a long, unique passphrase. It cannot be recovered.</p>
        {:else}
          <label class="input-label" for="age-recipients">Public keys</label><textarea class="item-name-input age-keys" id="age-recipients" rows="3" placeholder="age1…" spellcheck="false" autocomplete="off" bind:value={recipients} disabled={Boolean(working)}></textarea>
          <p class="setting-note">One age public key per line. SSH, plugin and post-quantum keys are not supported.</p>
        {/if}
        <label class="conversion-check"><input type="checkbox" bind:checked={armor} disabled={Boolean(working)}/>ASCII armor (printable text output)</label>
        {@render status()}
        <div class="dialog-actions"><button type="button" class="secondary-button" onclick={()=>working?task?.abort():onclose()}>{working?'Cancel':'Close'}</button><button class="primary-button" disabled={Boolean(working)||(method==='passphrase'?!passphrase||!confirm:!recipients.trim())}>Encrypt and save…</button></div>
      </form>
    {:else if !unlocked}
      {#if inspecting}<div class="action-working" role="status"><div class="spinner small"></div><span>Reading the age header…</span></div>
      {:else if header}
        <p class="dialog-description">{header.passphrase?'This file is protected by a passphrase.':`This file is encrypted to ${header.recipients===1?'one public key':`${header.recipients} public keys`}. Paste a matching secret key.`}{header.armored?' It uses ASCII armor.':''}</p>
        <form onsubmit={unlock}>
          {#if header.passphrase}
            <label class="input-label" for="age-unlock-passphrase">Passphrase</label><input class="item-name-input" id="age-unlock-passphrase" type="password" autocomplete="current-password" bind:value={passphrase} disabled={Boolean(working)}/>
          {:else}
            <label class="input-label" for="age-identities">Secret key</label><textarea class="item-name-input age-keys" id="age-identities" rows="3" placeholder="AGE-SECRET-KEY-1…" spellcheck="false" autocomplete="off" bind:value={identities} disabled={Boolean(working)||!keysSupported}></textarea>
            <input hidden type="file" bind:this={identityPicker} onchange={loadIdentity} aria-label="Identity file"/>
            <button type="button" class="text-button" disabled={Boolean(working)||!keysSupported} onclick={()=>identityPicker?.click()}>Load an identity file</button>
            <p class="setting-note">{keysSupported?'Keys are used only for this file and are not stored.':'This browser does not support X25519 keys.'}</p>
          {/if}
          {@render status()}
          <div class="dialog-actions"><button type="button" class="secondary-button" onclick={()=>working?task?.abort():onclose()}>{working?'Cancel':'Close'}</button><button class="primary-button" disabled={Boolean(working)||(header.passphrase?!passphrase:!identities.trim()||!keysSupported)}>Unlock</button></div>
        </form>
      {:else}
        {@render status()}
        <div class="dialog-actions"><button type="button" class="secondary-button" onclick={onclose}>Close</button></div>
      {/if}
    {:else}
      <p class="dialog-description">Unlocked. The contents are authenticated while decrypting; nothing is saved if the file is damaged.</p>
      <label class="input-label" for="age-output">Decrypted file name</label><input class="item-name-input" id="age-output" bind:value={name} disabled={Boolean(working)} autocomplete="off" spellcheck="false"/>
      {@render status()}
      <div class="dialog-actions"><button type="button" class="secondary-button" onclick={()=>working?task?.abort():onclose()}>{working?'Cancel':'Close'}</button><button type="button" class="secondary-button" disabled={Boolean(working)||!name.trim()} onclick={download}><Icon name="download" size={15}/>Download</button>{#if canWrite}<button type="button" class="primary-button" disabled={Boolean(working)||!name.trim()} onclick={saveToVault}>Save to this folder</button>{/if}</div>
      {#if !canWrite}<p class="setting-note">Saving into the vault requires native folder access. Downloads are unencrypted copies.</p>{/if}
    {/if}
  </div>
</div>
{#snippet status()}
  {#if error}<p class="error-banner" role="alert">{error}</p>{/if}
  {#if done}<p class="notice-banner" role="status">{done}</p>{/if}
  {#if working}<div class="action-working" role="status"><div class="spinner small"></div><span>{working}{fraction===undefined?'…':` · ${Math.round(fraction*100)}%`}</span></div><progress max="1" value={fraction} aria-label="Age progress"></progress>{/if}
{/snippet}
<style>
  .age-method{border:0;padding:0;margin:16px 0 18px;display:grid;grid-template-columns:1fr 1fr;gap:8px}.age-method legend{font-size:11px;color:var(--muted);margin-bottom:10px;font-weight:550}.age-method label{display:flex;gap:10px;align-items:center;border:1px solid var(--border);border-radius:10px;padding:12px;cursor:pointer;background:var(--input)}.age-method label.chosen{border-color:var(--strong);background:var(--surface)}.age-method label:focus-within{outline:2px solid var(--strong);outline-offset:2px}.age-method input{accent-color:var(--strong)}.age-method strong,.age-method small{display:block}.age-method strong{font-size:12px;font-weight:600}.age-method small{font-size:10px;color:var(--muted);margin-top:4px}
  .age-dialog .item-name-input{margin-bottom:12px}.age-keys{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6}
  .age-dialog .conversion-check{display:flex;gap:8px;align-items:center;font-size:12px;margin:8px 0 4px}
  .age-dialog .text-button{font-size:11px;color:var(--muted);text-decoration:underline;text-underline-offset:3px;background:none;padding:0;margin-bottom:4px}
  .age-dialog .error-banner,.age-dialog .notice-banner{margin-top:14px}
  .age-dialog .dialog-actions :global(svg){margin-right:6px;vertical-align:-2px}
  @media(max-width:560px){.age-method{grid-template-columns:1fr}}
</style>

<script lang="ts">
  import {onDestroy,untrack} from 'svelte';
  import Icon from './Icon.svelte';
  import MigrationMeter from './MigrationMeter.svelte';
  import {focusDialog} from '../lib/focus';
  import {migrateVault,type MigrationProgress} from '../lib/migration';
  import type {VaultClient} from '../lib/client';
  import {formatSize,type VaultInfo,type VaultFamily,type MigrationInventory} from '../lib/types';
  let {client,info,root,onclose,onopen,onbusy,onlock}:{client:VaultClient;info:VaultInfo;root:FileSystemDirectoryHandle;onclose:()=>void;onopen:(root:FileSystemDirectoryHandle)=>void;onbusy:(busy:boolean)=>void;onlock:()=>void}=$props();
  const family:VaultFamily=$derived(info.family==='uvf'?'cryptomator':'uvf'),label=$derived(family==='uvf'?'UVF':'Cryptomator');
  let name=$state(untrack(()=>`${info.name} — ${label}`)),password=$state(''),confirm=$state(''),parent=$state<FileSystemDirectoryHandle>();
  let skipSourceScan=$state(false);
  let inventory=$state<MigrationInventory>(),stage=$state<'setup'|'review'|'running'|'done'>('setup'),working=$state(false),error=$state('');
  let progress=$state<MigrationProgress>(),created=$state<FileSystemDirectoryHandle>(),controller:AbortController|undefined,disposed=false;
  const progressLabel=$derived(progress?.stage==='checking'?'Checking the source again':progress?.stage==='creating'?'Creating your new vault':progress?.stage==='copying'?'Encrypting the copy':'Verifying every file');
  async function location(){try{parent=await window.showDirectoryPicker!({mode:'readwrite',id:'crypte-migrate'});error='';}catch(e){if(!(e instanceof DOMException&&e.name==='AbortError'))error=String(e);}}
  async function review(event:SubmitEvent){
    event.preventDefault();if(working||!parent)return;
    if(password!==confirm){error='Passwords must match exactly.';return;}
    if(await root.resolve(parent)!==null){error='Choose a destination outside this vault.';return;}
    working=true;onbusy(true);error='';progress={stage:'checking',path:'',completed:0,total:0};
    try{const result=await client.migrationInventory(family,{skipContentVerification:skipSourceScan},scan=>{if(!disposed)progress={stage:'checking',path:scan.path,completed:scan.completed,total:scan.total,scan};});if(disposed)return;inventory=result;stage='review';}
    catch(e){if(!disposed)error=e instanceof Error?e.message:'Unable to check this vault.';}
    finally{if(!disposed){working=false;onbusy(false);}}
  }
  async function start(){
    if(!parent||!inventory||working||inventory.issues.length)return;
    controller=new AbortController();working=true;onbusy(true);stage='running';error='';progress=undefined;const secret=password;password=confirm='';
    try{const result=await migrateVault({source:client,sourceInfo:info,sourceRoot:root,parent,name,password:secret,family,inventory,signal:controller.signal,progress:value=>{if(!disposed)progress=value;}});if(!disposed){created=result;stage='done';}}
    catch(e){if(!disposed){error=e instanceof Error?e.message:'Migration failed.';stage='setup';}}
    finally{if(!disposed){working=false;onbusy(false);}controller=undefined;}
  }
  onDestroy(()=>{disposed=true;controller?.abort();if(working)void client.cancelInventory().catch(()=>{});password=confirm='';onbusy(false);});
</script>
<svelte:window onkeydown={event=>{if(event.key==='Escape'){event.stopImmediatePropagation();if(!working)onclose();}}}/>
<div class="modal-backdrop">
  <div class="settings-dialog migration-dialog" role="dialog" aria-modal="true" aria-label="Migrate vault" tabindex="-1" use:focusDialog>
    <div class="dialog-heading"><div><span class="card-eyebrow">A NEW FORMAT. THE SAME FILES.</span><h2>{stage==='done'?'Your copy is ready':'Migrate vault'}</h2></div><button class="icon-button" aria-label="Close migration" disabled={working} onclick={onclose}><Icon name="close"/></button></div>
    <div class="migration-route"><div><small>FROM</small><strong>{info.family==='uvf'?'UVF':'Cryptomator'}</strong><span>{info.name}</span></div><Icon name="arrow"/><div><small>TO</small><strong>{label}</strong><span>A separate encrypted vault</span></div></div>
    <ol class="migration-steps" aria-label="Migration steps"><li class:current={stage==='setup'}>1. Destination</li><li class:current={stage==='review'}>2. Review</li><li class:current={stage==='running'||stage==='done'}>3. Copy & verify</li></ol>
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    {#if stage==='setup'}
      <p class="migration-intro">Create a verified copy in {label}. Your original vault stays in place. Files are re-encrypted locally, including hidden files and empty folders.</p>
      {#if !working}<form class="create-vault-form" onsubmit={review}>
        <label class="input-label" for="migration-name">New vault name</label><input id="migration-name" bind:value={name} disabled={working} required/>
        <button class="secondary-button" type="button" onclick={location} disabled={working}>Choose migration location</button>
        <p class="setting-note">{parent?`${parent.name||'Selected location'} / ${name}`:'Choose a location outside the source vault, with room for a complete encrypted copy.'}</p>
        <label class="input-label" for="migration-password">New vault password</label><input id="migration-password" type="password" autocomplete="new-password" bind:value={password} disabled={working} required/>
        <label class="input-label" for="migration-confirm">Confirm new password</label><input id="migration-confirm" type="password" autocomplete="new-password" bind:value={confirm} disabled={working} required/>
        <p class="setting-note">Pause other apps that write to this vault until migration finishes. Keep the new password somewhere safe.</p>
        <label class="scan-choice"><input type="checkbox" bind:checked={skipSourceScan} disabled={working}/>Skip full source scan</label>
        <p class="setting-note">{skipSourceScan?'Names and structure are still checked. Damaged content is detected during copying; source changes are checked using size and timestamps. Every destination file is still verified.':'Recommended: authenticate every source file before creating the copy.'}</p>
        <button class="primary-button" disabled={working||!parent||!name||!password||!confirm}>Review migration<Icon name="arrow" size={17}/></button>
      </form>{/if}
      {#if working}<MigrationMeter {progress} title={skipSourceScan?"Checking source metadata":"Checking source files"}/><button class="text-button choose-another" onclick={()=>client.cancelInventory()}>Cancel check</button>{/if}
    {:else if stage==='review'&&inventory}
      <div class="migration-stats"><div><strong>{inventory.files}</strong><span>files & links</span></div><div><strong>{inventory.folders}</strong><span>folders</span></div><div><strong>{formatSize(inventory.bytes)}</strong><span>file contents</span></div></div>
      {#if inventory.issues.length}<div class="migration-issues" role="alert"><h3>Resolve {inventory.issues.length} {inventory.issues.length===1?'issue':'issues'} first</h3><p>No destination has been created. Return to your vault to fix these items, then check again.</p><ul>{#each inventory.issues as issue}<li>{issue}</li>{/each}</ul></div>
      {:else}<p class="migration-intro">{inventory.skipContentVerification?'Names and structure passed the compatibility check. The full source-content scan was skipped.':'All files passed the compatibility check.'} The copy will be saved as <strong>{parent?.name||'Selected location'} / {name}</strong>. Each file will be decrypted again and checked after writing.</p><p class="setting-note">Filenames, folder structure and link targets are preserved. Copied files receive new filesystem timestamps. Your local passkey and preview cache stay with the original vault.</p>{/if}
      <div class="migration-actions"><button class="secondary-button" onclick={()=>stage='setup'}>Back</button><button class="primary-button" onclick={start} disabled={inventory.issues.length>0}>Create verified copy<Icon name="arrow" size={17}/></button></div>
    {:else if stage==='running'}
      <MigrationMeter {progress} title={progressLabel}/>
      <p class="setting-note">Keep this tab open. Cancelling or locking stops the migration and leaves an incomplete encrypted destination. Your original vault stays intact.</p>
      <div class="migration-actions"><button class="secondary-button" onclick={onlock}><Icon name="lock" size={16}/>Lock vault</button><button class="secondary-button" onclick={()=>controller?.abort()}>Cancel migration</button></div>
    {:else if stage==='done'&&created}
      <div class="migration-success"><Icon name="check" size={32}/><h3>Every file verified</h3><p><strong>{name}</strong> is ready to open with your new password. Your original vault is still available.</p></div>
      <div class="migration-actions"><button class="secondary-button" onclick={onclose}>Stay here</button><button class="primary-button" onclick={()=>onopen(created!)}>Open new vault<Icon name="arrow" size={17}/></button></div>
    {/if}
  </div>
</div>
<style>
  .migration-dialog{max-width:610px}.migration-route{display:grid;grid-template-columns:1fr auto 1fr;gap:22px;align-items:center;background:var(--surface);border-radius:12px;padding:20px}.migration-route div{min-width:0}.migration-route small{display:block;color:var(--muted);font-size:9px;letter-spacing:1.5px}.migration-route strong{display:block;font-size:19px;margin:8px 0}.migration-route span{display:block;font-size:11px;color:var(--muted);overflow-wrap:anywhere}.migration-steps{list-style:none;display:flex;gap:15px;margin:24px 0;padding:0;color:var(--muted);font-size:11px}.migration-steps .current{color:var(--strong);font-weight:650}.migration-intro{font-size:13px;color:var(--muted);line-height:1.8;margin-bottom:24px;overflow-wrap:anywhere}.migration-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0}.migration-stats div{padding:18px 10px;border:1px solid var(--border);border-radius:10px;text-align:center}.migration-stats strong{display:block;font-size:22px;font-weight:500}.migration-stats span{font-size:10px;color:var(--muted)}.migration-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:25px}.migration-actions .primary-button,.migration-actions .secondary-button{width:auto;white-space:nowrap;flex-shrink:0}.migration-issues{font-size:12px;line-height:1.7}.migration-issues ul{max-height:220px;overflow:auto;padding-left:20px;overflow-wrap:anywhere}.migration-issues p,.setting-note{color:var(--muted);font-size:11px;line-height:1.8}.scan-choice{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--strong);margin-top:12px}.scan-choice input{width:auto;accent-color:var(--strong)}.migration-success{padding:30px 10px;text-align:center;color:var(--strong)}.migration-success h3{margin:15px 0}.migration-success p{font-size:13px;line-height:1.8;color:var(--muted);overflow-wrap:anywhere}@media(max-width:580px){.migration-route{gap:10px;padding:15px}.migration-route strong{font-size:17px}.migration-steps{gap:10px;font-size:10px}.migration-actions{flex-wrap:wrap}.migration-stats strong{font-size:18px}}
</style>

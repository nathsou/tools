<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { focusDialog } from '../lib/focus';
  import type { VaultClient } from '../lib/client';
  import type { VaultEntry } from '../lib/types';
  export type FileAction='mkdir'|'rename'|'move'|'delete';
  export interface ActionInput {name:string;destination:{name:string;id:string}[];}
  let {action,targets,client,vaultName,parentId,hideDotfiles,busy,onconfirm,oncancel}:{action:FileAction;targets:VaultEntry[];client:VaultClient;vaultName:string;parentId:string;hideDotfiles:boolean;busy:boolean;onconfirm:(input:ActionInput)=>Promise<void>;oncancel:()=>void}=$props();
  let name=$state(''),error=$state(''),submitting=$state(false),loading=$state(false);
  const working=$derived(submitting||busy);
  let destination=$state([{name:'Vault',id:''}]),folders=$state<VaultEntry[]>([]),loadTicket=0;
  const title=$derived(action==='mkdir'?'New folder':action==='rename'?'Rename item':action==='move'?'Move items':'Delete items');
  const blocked=$derived(new Set(targets.filter(entry=>entry.kind==='folder').map(entry=>entry.directoryId)));
  async function load(next:{name:string;id:string}[]) {
    const ticket=++loadTicket;loading=true;error='';
    try{const listing=await client.list(next.at(-1)!.id);if(ticket!==loadTicket)return;destination=next;folders=listing.entries.filter(entry=>entry.kind==='folder'&&(!hideDotfiles||!entry.name.startsWith('.'))).toSorted((a,b)=>a.name.localeCompare(b.name));if(listing.warnings.length)error='Some entries could not be read in this folder.';}
    catch(e){if(ticket===loadTicket)error=e instanceof Error?e.message:'Unable to open this folder.';}
    finally{if(ticket===loadTicket)loading=false;}
  }
  async function submit(event:SubmitEvent){event.preventDefault();if(working)return;submitting=true;error='';try{await onconfirm({name,destination:destination.map(({name,id})=>({name,id}))});}catch(e){error=e instanceof Error?e.message:'Unable to change the vault.';}finally{submitting=false;}}
  onMount(()=>{name=action==='rename'?targets[0].name:'';destination=[{name:vaultName,id:''}];if(action==='move')void load(destination);return()=>{loadTicket++;};});
</script>
<div class="modal-backdrop" role="presentation" onclick={event=>{if(event.target===event.currentTarget)oncancel();}}>
  <div class="settings-dialog file-action-dialog" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" use:focusDialog><form onsubmit={submit}>
    <div class="dialog-heading"><div><span class="card-eyebrow">VAULT FILES</span><h2>{title}</h2></div><button type="button" class="icon-button" aria-label="Close file actions" onclick={oncancel}><Icon name="close"/></button></div>
    {#if targets.length}<ul class="action-targets">{#each targets as entry}<li><Icon name={entry.kind} size={16}/><span>{entry.name}</span></li>{/each}</ul>{/if}
    {#if action==='mkdir'||action==='rename'}<label class="input-label" for="item-name">{action==='mkdir'?'Folder name':'New name'}</label><input class="item-name-input" id="item-name" bind:value={name} disabled={working} required autocomplete="off" spellcheck="false"/>{/if}
    {#if action==='delete'}<p class="delete-explanation">Permanently delete {targets.length===1?'this item':'these items'} from the vault? Folders include everything inside, including hidden files. This cannot be undone.</p>{/if}
    {#if action==='move'}
      <p class="dialog-description">Choose a destination folder.</p>
      <nav class="destination-breadcrumbs" aria-label="Destination folder">{#each destination as crumb,index}<button type="button" disabled={working||loading} onclick={()=>load(destination.slice(0,index+1))}>{crumb.name}</button>{#if index<destination.length-1}<Icon name="chevron" size={12}/>{/if}{/each}</nav>
      <div class="destination-folders">{#if loading}<div class="spinner"></div>{:else}{#each folders as folder}<button type="button" disabled={working||blocked.has(folder.directoryId)} aria-label={`Choose ${folder.name}`} onclick={()=>load([...destination,{name:folder.name,id:folder.directoryId!}])}><Icon name="folder" size={18}/><span>{folder.name}</span><Icon name="chevron" size={15}/></button>{/each}{#if !folders.length}<p>No subfolders here.</p>{/if}{/if}</div>
    {/if}
    {#if error}<p class="error-banner" role="alert">{error}</p>{/if}
    {#if working}<div class="action-working" role="status"><div class="spinner small"></div><span>{action==='delete'?'Deleting…':action==='move'?'Moving encrypted files…':'Saving…'}</span></div>{/if}
    <div class="dialog-actions"><button type="button" class="secondary-button" onclick={oncancel}>{working?'Cancel operation':'Cancel'}</button><button class="primary-button" class:danger-button={action==='delete'} disabled={working||loading||((action==='mkdir'||action==='rename')&&!name.trim())||(action==='move'&&destination.at(-1)!.id===parentId)}>{action==='mkdir'?'Create folder':action==='rename'?'Rename':action==='move'?'Move here':'Delete permanently'}</button></div>
  </form></div>
</div>

<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Icon from './components/Icon.svelte';
  import Thumbnail from './components/Thumbnail.svelte';
  import ConversionDialog from './components/ConversionDialog.svelte';
  import {sourceStamp,type ConvertedMedia} from './lib/conversion';
  import {executeWriteUnlocked} from './lib/writes';
  import Preview from './components/Preview.svelte';
  import EntryActions from './components/EntryActions.svelte';
  import FileActionsDialog, {type ActionInput,type FileAction} from './components/FileActionsDialog.svelte';
  import { VaultClient } from './lib/client';
  import { authenticatePasskey, friendlyPasskeyError, passkeysAvailable, registerPasskey } from './lib/passkeys';
  import { canRememberHandles, deletePasskey, forgetVault, getPasskey, getRecents, putPasskey, saveRecent, type RecentVault } from './lib/database';
  import { baseURL, mediaStreamingReady, probeMediaStreaming, registerServiceWorker, startMedia, stopMedia } from './lib/media';
  import { formatSize, type PasskeyRecord, type Source, type VaultEntry, type VaultInfo,type WriteOutcome,type WriteRequest,type EditFingerprint } from './lib/types';
  import { saveText as replaceText } from './lib/replacement';
  import { focusDialog } from './lib/focus';
  import { addFile,addFiles,writePermission,vaultWriteLock } from './lib/imports';
  import { ViewHistory } from './lib/history';
  import { executeWrite } from './lib/writes';
  import { addFolder,readFolder,type FolderItem } from './lib/folder-import';
  import { startThumbnailSession,clearThumbnailCache,invalidateThumbnails } from './lib/previews';

  type Crumb={name:string;id:string};
  type AppView={kind:'locked'}|{kind:'vault';breadcrumbs:Crumb[];selectedId?:string;expanded:boolean;settings:boolean;filter:string;search:string;sort:string;view:'grid'|'list';scroll:number};
  let appHistory:ViewHistory<AppView>|undefined;
  let explorerContent=$state<HTMLDivElement>();

  let source = $state<Source>();
  let editor=$state<{dirty:boolean;saving:boolean;discard:()=>void}|undefined>(),savingText=$state(false);
  let textSaveController:AbortController|undefined;
  let conversionEntry=$state<VaultEntry>(),convertingSave=$state(false),selecting=$state(false),selectionAnchor:string|undefined;
  let client = $state<VaultClient>();
  let info = $state<VaultInfo>();
  let unlocked = $state(false), busy = $state(false), loading = $state(false), password = $state(''), progress = $state(0);
  let error = $state(''), notice = $state(''), warnings = $state<string[]>([]);
  let recents = $state<RecentVault[]>([]), passkey = $state<PasskeyRecord>();
  let biometricAvailable = $state(false), streaming = $state(false), settings = $state(false), remember = $state(true);
  let streamingPending=$state(true),streamingError=$state(''),streamAttempt=0;
  let entries = $state<VaultEntry[]>([]), selected = $state<VaultEntry>(), expanded = $state(false);
  let view = $state<'grid'|'list'>('grid'), filter = $state('all'), search = $state(''), sort = $state('name');
  let theme = $state<'system'|'light'|'dark'>('system'), systemDark = $state(false), idleMinutes = $state(5), hideDotfiles = $state(true);
  let importing=$state(false), scanningImport=$state(false),importProgress=$state(0), importName=$state('');
  let manager=$state<{action:FileAction;targets:VaultEntry[]}>(),mutating=$state(false),menu=$state(''),marked=$state<string[]>([]);
  let mutationController:AbortController|undefined;
  let breadcrumbs = $state<{ name:string; id:string }[]>([{ name:'All files',id:'' }]);
  let visited = $state<{ name:string; id:string; ancestors:{ name:string; id:string }[] }[]>([]);
  let folderPicker:HTMLInputElement;
  let importPicker:HTMLInputElement;
  let folderImportPicker:HTMLInputElement;
  let searchInput = $state<HTMLInputElement>();
  let navigation = 0;
  let idleTimer:ReturnType<typeof setTimeout>|undefined, hiddenTimer:ReturnType<typeof setTimeout>|undefined;
  let authController:AbortController|undefined;
  let importController:AbortController|undefined;
  const currentDirectory = $derived(breadcrumbs.at(-1)!.id);
  const resolvedTheme = $derived(theme === 'system' ? (systemDark ? 'dark' : 'light') : theme);
  const browsable = $derived(entries.filter(entry=>!hideDotfiles || !entry.name.startsWith('.')));
  const visibleFolders = $derived(visited.filter(folder=>!hideDotfiles || !folder.name.startsWith('.')));
  const visible = $derived(browsable.filter(entry=>entry.name.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || entry.kind === 'folder' || entry.kind === filter)).toSorted((a,b)=>{
    if (a.kind === 'folder' && b.kind !== 'folder') return -1;
    if (b.kind === 'folder' && a.kind !== 'folder') return 1;
    if (sort === 'size') return b.size-a.size;
    if (sort === 'modified') return b.modified-a.modified;
    return a.name.localeCompare(b.name,undefined,{ numeric:true });
  }));
  const fileCount = $derived(browsable.filter(e=>e.kind !== 'folder').length);
  const folderCount = $derived(browsable.length-fileCount);
  const writeDisabled=$derived(source?.type!=='handle'||busy||loading||importing||scanningImport||mutating);
  const markedEntries=$derived(browsable.filter(entry=>marked.includes(entry.id)));

  function message(e:unknown):string { return e instanceof Error ? e.message : 'Something went wrong. Please try again.'; }
  function currentView():AppView {
    if(!unlocked)return {kind:'locked'};
    return {kind:'vault',breadcrumbs:breadcrumbs.map(({name,id})=>({name,id})),selectedId:selected?.id,expanded,settings,filter,search,sort,view,scroll:explorerContent?.scrollTop ?? 0};
  }
  function rememberView() {appHistory?.update(currentView());}
  function pushView() {appHistory?.push(currentView());}
  function canLeaveEditor():boolean {
    if(conversionEntry){error='Close the conversion preview before navigating.';return false;}
    if(savingText||editor?.saving){error='Wait for the save to finish, or lock the vault to cancel it.';return false;}
    if(editor?.dirty&&!confirm('Discard unsaved text changes?'))return false;
    editor?.discard();editor=undefined;return true;
  }
  function canRestoreView(target:AppView|undefined):boolean {
    return !conversionEntry&&target?.kind==='vault'&&target.selectedId===selected?.id&&target.breadcrumbs.at(-1)?.id===currentDirectory&&!savingText || canLeaveEditor();
  }
  async function restoreView(target:AppView|undefined) {
    closeManager();menu='';marked=[];
    if(target?.kind!=='vault' || !unlocked || !client) {
      if(unlocked)lock();else appHistory?.reset({kind:'locked'});
      return;
    }
    importController?.abort();
    if(target.breadcrumbs.at(-1)!.id!==currentDirectory) {
      if(!await navigate(target.breadcrumbs,'restore'))return;
    } else {navigation++;loading=false;}
    const ticket=navigation;
    filter=target.filter;search=target.search;sort=target.sort;view=target.view;settings=target.settings;
    selected=entries.find(entry=>entry.id===target.selectedId && entry.kind!=='folder' && (!hideDotfiles || !entry.name.startsWith('.')));
    expanded=Boolean(selected && target.expanded);activity();
    await tick();if(ticket===navigation && explorerContent)explorerContent.scrollTop=target.scroll;
  }
  function dismissPreview() {
    if(!selected||!canLeaveEditor())return;
    rememberView();
    if(appHistory?.backIf(target=>target.kind==='vault' && target.breadcrumbs.at(-1)!.id===currentDirectory && !target.selectedId && !target.settings))return;
    selected=undefined;expanded=false;pushView();
  }
  function openSettings() {if(!canLeaveEditor())return;rememberView();settings=true;pushView();}
  function dismissSettings() {
    rememberView();
    if(appHistory?.backIf(target=>target.kind==='vault' && target.breadcrumbs.at(-1)!.id===currentDirectory && target.selectedId===selected?.id && !target.settings))return;
    settings=false;pushView();
  }
  function chooseFilter(next:string) {if(next===filter)return;rememberView();filter=next;pushView();}
  function toggleExpanded() {expanded=!expanded;rememberView();}
  async function prepareStreaming() {
    const ticket=++streamAttempt;streamingPending=true;
    const result=await registerServiceWorker();if(ticket!==streamAttempt)return;
    streaming=result.available;streamingError=result.reason;streamingPending=false;
  }
  async function refreshRecents() { try { recents = (await getRecents()).toSorted((a,b)=>b.opened-a.opened).slice(0,6); } catch { /* Storage is optional. */ } }
  function clearSession() {
    navigation++; authController?.abort(); importController?.abort(); mutationController?.abort();textSaveController?.abort();client?.close(); client=undefined;
    editor=undefined;savingText=false;textSaveController=undefined;conversionEntry=undefined;convertingSave=false;selecting=false;selectionAnchor=undefined;
    clearThumbnailCache();stopMedia(); unlocked=false; entries=[]; selected=undefined; expanded=false; password=''; progress=0;
    breadcrumbs=[{ name:'All files',id:'' }]; visited=[]; warnings=[]; busy=false; loading=false; settings=false; search=''; filter='all'; importing=false; importProgress=0; importName='';
    manager=undefined;mutating=false;scanningImport=false;menu='';marked=[];mutationController=undefined;
    appHistory?.reset({kind:'locked'});
    clearTimeout(idleTimer); clearTimeout(hiddenTimer);
  }
  function lock() { clearSession(); notice='Vault locked. Your previews and session keys have been cleared.'; error=''; }
  function closeVault() { if(!canLeaveEditor())return;clearSession(); source=undefined; info=undefined; passkey=undefined; error=''; notice=''; }
  function activity() {
    if (!unlocked) return;
    clearTimeout(idleTimer);
    if (idleMinutes > 0) idleTimer=setTimeout(lock,idleMinutes*60000);
  }
  async function loadSource(next:Source) {
    clearSession(); source=next; info=undefined; passkey=undefined; notice=''; error=''; busy=true;
    const active = new VaultClient(); client=active;
    try {
      const result=await active.prepare(next);
      if (client !== active) return;
      info=result;
      try { const saved=await getPasskey(result.id); if (client === active) passkey=saved; } catch { /* Password unlock works without storage. */ }
    } catch (e) { if (client === active) { error=message(e); active.close(); client=undefined; source=undefined; } }
    finally { if (client === active || !client) busy=false; }
  }
  async function chooseVault() {
    navigation++; error='';
    if (window.showDirectoryPicker) {
      try { const handle=await window.showDirectoryPicker({ mode:'readwrite',id:'crypte-vault' }); await loadSource({ type:'handle',handle }); }
      catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) error=message(e); }
    } else folderPicker.click();
  }
  async function chooseFiles(event:Event) {
    const input=event.target as HTMLInputElement;
    const files=Array.from(input.files ?? []);
    if (!files.length) return;
    const name=files[0].webkitRelativePath.split('/')[0] || 'Vault';
    await loadSource({ type:'files', name, files:files.map(file=>({ file,path:file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name })) });
    input.value='';
  }
  async function reopen(recent:RecentVault) {
    if (!recent.handle) { notice='Select the vault folder again to reopen it.'; await chooseVault(); return; }
    try {
      if (await recent.handle.queryPermission({ mode:'read' }) !== 'granted' && await recent.handle.requestPermission({ mode:'read' }) !== 'granted') throw new Error('Read access was not granted. Select the vault folder again.');
      await loadSource({ type:'handle',handle:recent.handle });
    } catch (e) { error=message(e); }
  }
  async function ensureClient():Promise<VaultClient> {
    if (!source) throw new Error('Select a vault first.');
    if (!client) {
      const active=new VaultClient(); client=active;
      try { await active.prepare(source); }
      catch (e) { active.close(); if (client === active) client=undefined; throw e; }
      if (client !== active) throw new Error('The vault was locked.');
    }
    return client;
  }
  async function finishUnlock(active:VaultClient) {
    if (client !== active || !info) return;
    const listing=await active.list('');
    if (client !== active) return;
    startThumbnailSession(active,source?.type==='handle'?source.handle:undefined,info?.id);entries=listing.entries; warnings=listing.warnings; unlocked=true; startMedia(active); password=''; notice=''; activity();
    pushView();
    if (remember) {
      try {
        await saveRecent({ id:info.id,name:info.name,opened:Date.now(),handle:source?.type === 'handle' ? source.handle : undefined }); await refreshRecents();
        if (source?.type === 'handle' && !canRememberHandles()) notice='Vault remembered. This browser version requires selecting its folder again after a reload.';
      }
      catch { notice='This browser could not remember the vault. Browsing still works.'; }
    }
  }
  async function unlockPassword(event:SubmitEvent) {
    event.preventDefault(); if (busy || !password) return;
    busy=true; error=''; notice=''; progress=0;
    try { const active=await ensureClient(); const input=password; password=''; await active.unlock(input,p=>progress=p); await finishUnlock(active); }
    catch (e) { error=message(e); }
    finally { busy=false; }
  }
  async function unlockWithPasskey() {
    if (!passkey || busy) return;
    busy=true; error=''; authController=new AbortController();
    let prf:Uint8Array<ArrayBuffer>|undefined;
    try {
      // Start WebAuthn immediately from the click, before unrelated worker/storage awaits.
      prf=await authenticatePasskey(passkey,authController.signal);
      const active=await ensureClient(); await active.passkey(prf,passkey); await finishUnlock(active);
    } catch (e) { error=friendlyPasskeyError(e); }
    finally { if (prf?.byteLength) prf.fill(0); busy=false; authController=undefined; }
  }
  async function enrollPasskey() {
    if (!info || !client || busy) return;
    const active=client; busy=true; error=''; authController=new AbortController();
    let prf:Uint8Array<ArrayBuffer>|undefined;
    try {
      const registration=await registerPasskey(info,authController.signal); prf=registration.prf;
      if (client !== active) throw new Error('The vault was locked during passkey setup.');
      const record=await active.seal(prf,registration.record);
      if (client !== active) throw new Error('The vault was locked during passkey setup.');
      await putPasskey(record); passkey=record; notice='Passkey enabled. You can unlock this vault with Touch ID or your platform authenticator.';
    } catch (e) { error=friendlyPasskeyError(e); }
    finally { if (prf?.byteLength) prf.fill(0); busy=false; authController=undefined; activity(); }
  }
  async function removePasskey() {
    if (!info) return;
    try { await deletePasskey(info.id); passkey=undefined; notice='Local passkey unlock removed. The passkey itself can be removed in your device’s password settings.'; }
    catch (e) { error=message(e); }
  }
  async function navigate(next:Crumb[],mode:'push'|'restore'|'replace'='push'):Promise<boolean> {
    if (!client || !unlocked || ((importing || scanningImport || mutating) && mode!=='restore')) return false;
    if(mode!=='restore'&&!canLeaveEditor())return false;
    const changed=next.at(-1)!.id!==currentDirectory || Boolean(selected) || Boolean(search);
    if(mode!=='restore')rememberView();
    const active=client, ticket=++navigation; loading=true; error=''; selected=undefined; expanded=false; search='';marked=[];selecting=false;selectionAnchor=undefined;menu='';
    try {
      const listing=await active.list(next.at(-1)!.id);
      if (client !== active || ticket !== navigation) return false;
      breadcrumbs=next; entries=listing.entries; warnings=listing.warnings;
      const last=next.at(-1)!;
      if (last.id && !visited.some(v=>v.id === last.id)) visited=[...visited,{ ...last,ancestors:next }];
      if(mode!=='restore' && explorerContent)explorerContent.scrollTop=0;
      if(mode==='push' && changed)pushView();else if(mode==='replace' || mode==='push')rememberView();
      return true;
    } catch (e) { if (client === active && ticket === navigation) error=message(e); }
    finally { if (ticket === navigation) loading=false; activity(); }
    return false;
  }
  async function chooseImport() {
    if (!client || !unlocked || source?.type !== 'handle' || busy || loading) return;
    const active=client, ticket=navigation;
    try {error='';await writePermission(source.handle);if(client===active && ticket===navigation && unlocked && !busy && !loading)importPicker.click();}
    catch(e){if(!(e instanceof DOMException && e.name==='AbortError'))error=message(e);}
  }
  async function importSelected(event:Event) {
    const input=event.target as HTMLInputElement, files=Array.from(input.files ?? []);input.value='';
    if (!files.length || !client || !info || !unlocked || busy || loading || source?.type !== 'handle') return;
    const active=client, root=source.handle, target=[...breadcrumbs], ticket=navigation, controller=new AbortController();
    importController=controller;importing=true;busy=true;importProgress=0;error='';notice='';
    try {
      const result=await addFiles(root,active,files,currentDirectory,info.id,controller.signal,(name,fraction)=>{if(client===active){importName=name;importProgress=fraction;}});
      if(client!==active || ticket!==navigation)return;
      const listing=await active.list(target.at(-1)!.id);if(client!==active || ticket!==navigation)return;
      entries=listing.entries;warnings=listing.warnings;
      if(result.added.length)notice=`Added ${result.added.length} ${result.added.length===1?'file':'files'}.${hideDotfiles && result.added.some(name=>name.startsWith('.'))?' Dotfiles are hidden by your preference.':''}`;
      if(result.errors.length)error=result.errors.join('\n');
    } catch(e){if(client===active && ticket===navigation && !controller.signal.aborted)error=message(e);}
    finally {if(client===active){busy=false;importing=false;importController=undefined;activity();}}
  }
  async function chooseFolderImport() {
    if(writeDisabled || source?.type!=='handle')return;
    notice='';error='';
    if(!window.showDirectoryPicker){folderImportPicker.click();return;}
    const active=client!,root=source.handle,ticket=navigation;
    try {
      const folder=await window.showDirectoryPicker({mode:'read',id:'crypte-import-folder'});
      if(client!==active||ticket!==navigation)return;
      const controller=new AbortController();importController=controller;scanningImport=true;busy=true;
      let items:FolderItem[];
      try{items=await readFolder(folder,root,controller.signal);controller.signal.throwIfAborted();}
      finally{if(client===active){scanningImport=false;busy=false;importController=undefined;}}
      if(client===active&&ticket===navigation)await importFolderItems(items);
    } catch(e){if(client===active && !(e instanceof DOMException&&e.name==='AbortError'))error=message(e);}
  }
  async function folderImportSelected(event:Event) {
    const input=event.target as HTMLInputElement,files=Array.from(input.files??[]);input.value='';
    if(files.length)await importFolderItems(files.map(file=>({path:file.webkitRelativePath,file})));
  }
  async function importFolderItems(items:FolderItem[]) {
    if(writeDisabled||!client||!info||source?.type!=='handle')return;
    const active=client,ticket=navigation,controller=new AbortController();importController=controller;importing=true;busy=true;error='';notice='';importProgress=0;
    try {
      const result=await addFolder(source.handle,active,items,currentDirectory,info.id,controller.signal,(name,fraction)=>{if(client===active){importName=name;importProgress=fraction;}});
      if(client!==active||ticket!==navigation)return;
      const listing=await active.list(currentDirectory);if(client!==active||ticket!==navigation)return;entries=listing.entries;warnings=listing.warnings;
      notice=`Folder imported. Added ${result.added.length} ${result.added.length===1?'file':'files'}.`;error=result.errors.join('\n');
    } catch(e){if(client===active&&ticket===navigation&&!controller.signal.aborted){error=message(e);try{const listing=await active.list(currentDirectory);if(client===active&&ticket===navigation)entries=listing.entries;}catch{/* Original error is more useful. */}}}
    finally{if(client===active){importing=false;busy=false;importController=undefined;activity();}}
  }
  function mark(entry:VaultEntry,event?:MouseEvent){
    selecting=true;
    if(event?.shiftKey&&selectionAnchor){const a=visible.findIndex(e=>e.id===selectionAnchor),b=visible.findIndex(e=>e.id===entry.id);if(a>=0&&b>=0){marked=[...new Set([...marked,...visible.slice(Math.min(a,b),Math.max(a,b)+1).map(e=>e.id)])];return;}}
    marked=marked.includes(entry.id)?marked.filter(id=>id!==entry.id):[...marked,entry.id];selectionAnchor=entry.id;
  }
  function activateEntry(event:MouseEvent,entry:VaultEntry){if(source?.type==='handle'&&(selecting||event.metaKey||event.ctrlKey||event.shiftKey)){if(!writeDisabled)mark(entry,event);}else select(entry);}
  async function entryAction(action:FileAction|'convert',entry:VaultEntry){
    if(action!=='convert'){openManager(action,[entry]);return;}
    if(writeDisabled||!canLeaveEditor()||source?.type!=='handle')return;menu='';error='';
    const active=client;try{await writePermission(source.handle);if(client===active)conversionEntry=entry;}catch(e){error=message(e);}
  }
  async function commitConversion(result:ConvertedMedia,remove:boolean,stamp:Awaited<ReturnType<typeof sourceStamp>>,signal:AbortSignal){
    if(source?.type!=='handle'||!client||!info||!conversionEntry)throw new Error('The vault is locked.');
    const active=client,root=source.handle,original=conversionEntry,parentId=currentDirectory,vaultId=info.id;convertingSave=true;busy=true;
    try{
      await vaultWriteLock(vaultId,signal,async()=>{
        if(remove){const fresh=await sourceStamp(root,original,signal);if(fresh.digest!==stamp.digest||fresh.modified!==stamp.modified)throw new Error('The original changed during conversion. It has been kept.');}
        const saved=await addFile(root,active,{name:result.name,size:result.spool.size,read:(start,end)=>result.spool.read(start,end)},parentId,signal,()=>{});
        if(remove){const fresh=await sourceStamp(root,original,signal);if(fresh.digest!==stamp.digest||fresh.modified!==stamp.modified)throw new Error('The original changed while saving. Both files have been kept.');const outcome=await executeWriteUnlocked(root,active,{kind:'delete',parentId,entryId:original.id},signal);if(client===active)reconcileHistory(outcome,[...breadcrumbs]);}
        if(client===active)notice=remove?`Saved ${saved} and removed the original.`:`Saved ${saved}. The original has been kept.`;
      });
    }finally{
      if(client===active){convertingSave=false;busy=false;const listing=await active.list(parentId);if(client===active){entries=listing.entries;warnings=listing.warnings;if(remove)selected=undefined;activity();}}
    }
  }
  function closeConversion(){conversionEntry=undefined;convertingSave=false;activity();}

  function openManager(action:FileAction,targets:VaultEntry[]=[]) {if(writeDisabled)return;menu='';manager={action,targets};}
  function closeManager(){mutationController?.abort();manager=undefined;}
  function reconcileHistory(outcome:WriteOutcome,destination:Crumb[]) {
    invalidateThumbnails(outcome.plan);
    const {plan}=outcome,removed=new Set(plan.removedFolders.map(folder=>folder.id));
    function updateCrumbs(crumbs:Crumb[]):Crumb[] {
      const deleted=crumbs.findIndex(crumb=>removed.has(crumb.id));if(deleted>=0)return crumbs.slice(0,deleted);
      if(plan.kind==='move'&&plan.entry?.kind==='folder') {
        const index=crumbs.findIndex(crumb=>crumb.id===plan.entry!.directoryId);
        if(index>=0)return [...destination,{name:plan.name,id:plan.entry.directoryId!},...crumbs.slice(index+1)];
      }
      return crumbs;
    }
    appHistory?.rewrite(route=>{
      if(route.kind!=='vault')return route;
      const crumbs=updateCrumbs(route.breadcrumbs),changed=crumbs.length!==route.breadcrumbs.length;
      return {...route,breadcrumbs:crumbs,selectedId:changed||route.selectedId===plan.entry?.id?undefined:route.selectedId,expanded:changed||route.selectedId===plan.entry?.id?false:route.expanded};
    });
    visited=visited.filter(folder=>!removed.has(folder.id)).map(folder=>{const ancestors=updateCrumbs(folder.ancestors);return {...folder,name:ancestors.at(-1)!.name,ancestors};});
  }
  async function confirmActions(input:ActionInput) {
    if(!manager||!client||!info||source?.type!=='handle'||mutating)return;
    if(!canLeaveEditor())throw new Error('Keep editing, or discard the draft before changing vault entries.');
    const job=manager,active=client,ticket=navigation,parentId=currentDirectory,controller=new AbortController();
    mutationController=controller;mutating=true;busy=true;error='';notice='';const outcomes:WriteOutcome[]=[];
    const destination=job.action==='rename'?breadcrumbs.map(({name,id})=>({name,id})):input.destination;
    try {
      const requests:WriteRequest[]=job.action==='mkdir'?[{kind:'mkdir',parentId,name:input.name}]:job.targets.map(entry=>job.action==='delete'?{kind:'delete',parentId,entryId:entry.id}:{kind:'move',parentId,entryId:entry.id,targetId:job.action==='rename'?parentId:destination.at(-1)!.id,name:job.action==='rename'?input.name:entry.name});
      for(const request of requests){controller.signal.throwIfAborted();const outcome=await executeWrite(source.handle,active,request,info.id,controller.signal);outcomes.push(outcome);if(client===active)reconcileHistory(outcome,destination);}
      if(client!==active)return;
      notice=job.action==='mkdir'?`Created “${input.name}”.`:`${job.action==='delete'?'Deleted':job.action==='rename'?'Renamed':'Moved'} ${outcomes.length} ${outcomes.length===1?'item':'items'}.`;
      const cleanup=outcomes.flatMap(outcome=>outcome.warnings);if(cleanup.length)notice+=` ${cleanup.join(' ')}`;
      manager=undefined;
    } finally {
      if(client===active){
        mutating=false;busy=false;mutationController=undefined;marked=[];selecting=false;selectionAnchor=undefined;menu='';selected=undefined;expanded=false;
        if(ticket===navigation){entries=[];await tick();startMedia(active);try{const listing=await active.list(currentDirectory);if(client===active&&ticket===navigation){entries=listing.entries;warnings=listing.warnings;rememberView();}}catch(e){if(client===active)error=message(e);}}
        if(manager===job && outcomes.length){const done=new Set(outcomes.map(outcome=>outcome.plan.entry?.id));manager={...job,targets:job.targets.filter(entry=>!done.has(entry.id))};}
        activity();
      }
    }
  }
  function drag(event:DragEvent,entry:VaultEntry){if(writeDisabled)return;event.dataTransfer?.setData('application/x-crypte-entries',JSON.stringify(marked.includes(entry.id)?marked:[entry.id]));if(event.dataTransfer)event.dataTransfer.effectAllowed='move';}
  async function drop(event:DragEvent,folder:VaultEntry) {
    if(writeDisabled||!event.dataTransfer)return;const data=event.dataTransfer.getData('application/x-crypte-entries');if(!data)return;event.preventDefault();event.stopPropagation();
    try{const ids:unknown=JSON.parse(data);if(!Array.isArray(ids))return;const targets=entries.filter(entry=>ids.includes(entry.id));if(!targets.length)return;
      if(targets.some(entry=>entry.directoryId===folder.directoryId))throw new Error('A folder cannot be moved into itself.');
      manager={action:'move',targets};await confirmActions({name:'',destination:[...breadcrumbs,{name:folder.name,id:folder.directoryId!}]});
    }catch(e){if(!(e instanceof DOMException&&e.name==='AbortError'))error=message(e);}
  }
  function select(entry:VaultEntry) {
    if (entry.kind === 'folder') void navigate([...breadcrumbs,{ name:entry.name,id:entry.directoryId! }]);
    else if(selected?.id!==entry.id&&canLeaveEditor()) { rememberView();selected=entry; expanded=false;pushView(); }
    activity();
  }
  function adjacent(direction:number) {
    const files=visible.filter(e=>e.kind !== 'folder');
    const index=files.findIndex(e=>e.id === selected?.id);
    if (files.length) select(files[(index+direction+files.length)%files.length]);
  }
  async function saveEditedText(entry:VaultEntry,file:File,expected:EditFingerprint,signal:AbortSignal):Promise<void> {
    if(!client||!info||source?.type!=='handle'||busy||loading)throw new Error('Open the vault with the native folder picker to save changes.');
    const active=client,ticket=navigation,controller=new AbortController();textSaveController=controller;savingText=true;busy=true;error='';notice='';
    try {
      const cleanup=await replaceText(source.handle,active,entry,file,currentDirectory,info.id,expected,AbortSignal.any([signal,controller.signal]));
      if(client!==active||ticket!==navigation)return;
      const listing=await active.list(currentDirectory);if(client!==active||ticket!==navigation)return;
      entries=listing.entries;warnings=listing.warnings;selected=entries.find(item=>item.id===entry.id);notice=`Saved “${entry.name}”. ${cleanup.join(' ')}`.trim();rememberView();
    }finally{if(client===active){savingText=false;busy=false;textSaveController=undefined;activity();}}
  }
  function keyboard(event:KeyboardEvent) {
    activity();
    if(conversionEntry){if(event.key==='Escape')closeConversion();return;}
    if(manager){if(event.key==='Escape')closeManager();return;}
    if(event.key==='Escape'&&menu){menu='';return;}
    if (event.key === 'Escape') { if (settings) dismissSettings(); else if(selecting){marked=[];selecting=false;selectionAnchor=undefined;}else if (selected) dismissPreview(); }
    if (!unlocked || (event.target instanceof HTMLElement && ['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))) return;
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='a'&&!selected&&!settings&&!writeDisabled){event.preventDefault();selecting=true;marked=visible.map(entry=>entry.id);}
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput?.focus(); }
    if (event.key === 'ArrowRight' && selected) adjacent(1);
    if (event.key === 'ArrowLeft' && selected) adjacent(-1);
    if (event.key === ' ' && selected) { event.preventDefault(); toggleExpanded(); }
  }
  onMount(()=>{
    appHistory=new ViewHistory<AppView>({kind:'locked'},target=>{void restoreView(target);},canRestoreView);
    const appearance=window.matchMedia('(prefers-color-scheme: dark)');
    const updateAppearance=()=>systemDark=appearance.matches;
    updateAppearance(); appearance.addEventListener('change',updateAppearance);
    try {
      const savedTheme=localStorage.getItem('crypte-theme');
      theme=savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'system';
      hideDotfiles=localStorage.getItem('crypte-hide-dotfiles') !== 'false';
      const idle=Number(localStorage.getItem('crypte-idle') ?? '5'); idleMinutes=[1,5,15,0].includes(idle) ? idle : 5;
    } catch { /* Optional preferences. */ }
    const startup=navigation;
    void refreshRecents().then(async()=>{
      const recent=recents[0];
      if (startup !== navigation || source || !recent?.handle) return;
      try {
        const permission=await recent.handle.queryPermission({ mode:'read' });
        if (permission === 'granted' && startup === navigation && !source) await loadSource({ type:'handle',handle:recent.handle });
      } catch { /* A revoked/unavailable handle can be reopened from the recent list. */ }
    });
    const controlled=async()=>{const ticket=streamAttempt;if(mediaStreamingReady()&&await probeMediaStreaming()&&ticket===streamAttempt){streamAttempt++;streaming=true;streamingPending=false;streamingError='';}};
    navigator.serviceWorker?.addEventListener('controllerchange',controlled);
    void passkeysAvailable().then(value=>biometricAvailable=value);void prepareStreaming();
    const hidden=()=>{ clearTimeout(hiddenTimer); if (document.hidden && unlocked) hiddenTimer=setTimeout(lock,60000); else activity(); };
    const exit=()=>clearSession();
    document.addEventListener('visibilitychange',hidden); window.addEventListener('pagehide',exit);
    const beforeExit=(event:BeforeUnloadEvent)=>{if(editor?.dirty||savingText||convertingSave){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',beforeExit);
    return ()=>{streamAttempt++;navigator.serviceWorker?.removeEventListener('controllerchange',controlled);appearance.removeEventListener('change',updateAppearance); document.removeEventListener('visibilitychange',hidden); window.removeEventListener('pagehide',exit);window.removeEventListener('beforeunload',beforeExit); clearSession();appHistory?.destroy();appHistory=undefined; };
  });
  $effect(()=>{document.documentElement.dataset.theme=resolvedTheme;});
  $effect(()=>{
    try { localStorage.setItem('crypte-theme',theme); localStorage.setItem('crypte-idle',String(idleMinutes)); localStorage.setItem('crypte-hide-dotfiles',String(hideDotfiles)); } catch { /* Optional preferences. */ }
    activity();
  });
  $effect(()=>{ if (hideDotfiles && selected?.name.startsWith('.')) { selected=undefined; expanded=false;untrack(rememberView); } });
  $effect(()=>{const ids=new Set(browsable.map(entry=>entry.id));if(marked.some(id=>!ids.has(id)))marked=marked.filter(id=>ids.has(id));});
</script>

<svelte:window onkeydown={keyboard} onpointerdown={event=>{activity();if(!(event.target instanceof Element&&event.target.closest('.entry-menu')))menu='';}}/>
<input hidden tabindex="-1" bind:this={folderPicker} type="file" webkitdirectory multiple onchange={chooseFiles} aria-label="Vault folder"/>
<input hidden tabindex="-1" bind:this={importPicker} type="file" multiple onchange={importSelected} aria-label="Files to add"/>
<input hidden tabindex="-1" bind:this={folderImportPicker} type="file" webkitdirectory multiple onchange={folderImportSelected} aria-label="Folder to add"/>

{#if !unlocked}
  <div class="welcome-shell">
    <header class="welcome-header"><a class="brand" href={baseURL.href} onclick={(event)=>{ event.preventDefault(); closeVault(); }}><span class="brand-icon"><Icon name="lock" size={19}/></span>Crypte<span class="brand-dot">.</span></a><div class="header-right"><span class="local-label"><span></span>Local files</span><button class="icon-button" aria-label="Toggle theme" title={`Appearance: ${theme}`} onclick={()=>theme=theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system'}><Icon name={theme === 'system' ? 'system' : resolvedTheme === 'light' ? 'moon' : 'sun'}/></button></div></header>
    <main class="welcome-main">
      <section class="welcome-story">
        <div class="eyebrow"><span class="tiny-line"></span>LOCAL VAULT MANAGER</div>
        <h1>Cryptomator<br/>vault manager.</h1>
        <p class="welcome-description">Open an encrypted vault to organize files and preview text, images, audio, and video.</p>
        <div class="vault-illustration" aria-hidden="true"><div class="illustration-orbit orbit-one"></div><div class="illustration-orbit orbit-two"></div><div class="floating-card floating-photo"><svg viewBox="0 0 140 110"><rect width="140" height="110" rx="8" fill="#e3e6d7"/><circle cx="104" cy="29" r="13" fill="#c8d3ae"/><path d="M0 105l44-68 40 56 25-33 31 45" fill="#5c7566"/><path d="M44 37l-11 17 22-1" fill="#f9faf5"/></svg></div><div class="illustrated-vault"><div class="vault-handle"><Icon name="lock" size={50}/></div><span>ENCRYPTED VAULT</span></div><div class="floating-card floating-text"><div></div><div></div><div></div><div></div></div><span class="illustration-spark spark-one">✳</span><span class="illustration-spark spark-two">+</span></div>
        <div class="privacy-points"><span><Icon name="shield" size={18}/>Never uploaded</span><span><Icon name="folder" size={18}/>Local folder access</span><span><Icon name="cloud" size={18}/>No account needed</span></div>
      </section>
      <section class="unlock-card">
        <div class="card-eyebrow">{info ? 'LOCKED VAULT' : 'OPEN VAULT'}</div>
        <div class="unlock-emblem"><Icon name={info ? 'lock' : 'folder'} size={28}/></div>
        <h2>{info ? info.name : 'Open a vault'}</h2>
        <p>{info ? 'Enter your password to browse the vault.' : 'Choose the folder that contains your encrypted Cryptomator vault.'}</p>
        {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
        {#if notice}<div class="notice-banner" role="status">{notice}</div>{/if}
        {#if info}
          {#if passkey}<button class="primary-button passkey-unlock" onclick={unlockWithPasskey} disabled={busy}><Icon name="fingerprint"/>{busy ? 'Unlocking…' : 'Unlock with passkey'}</button><div class="or-divider"><span>or use your vault password</span></div>{/if}
          <form onsubmit={unlockPassword}>
            <label class="input-label" for="vault-password">Vault password</label><div class="password-input"><Icon name="lock" size={17}/><input id="vault-password" type="password" bind:value={password} autocomplete="current-password" placeholder="Enter your password" disabled={busy}/></div>
            <label class="remember-option"><input type="checkbox" bind:checked={remember}/>Remember this vault on this device</label>
            <button class="primary-button" type="submit" disabled={busy || !password}>{#if busy}<span class="spinner small"></span>Unlocking {Math.round(progress*100)}%{:else}Unlock vault<Icon name="arrow" size={18}/>{/if}</button>
          </form>
          <button class="text-button choose-another" onclick={chooseVault} disabled={busy}>Choose a different vault</button>
          <div class="vault-format">Format {info.format} <span>·</span> {info.cipherCombo}</div>
        {:else}
          <button class="primary-button" onclick={chooseVault} disabled={busy}><Icon name="folder" size={19}/>{busy ? 'Opening…' : 'Choose vault folder'}<Icon name="arrow" size={18}/></button>
          {#if recents.length}<div class="recent-vaults"><div class="input-label">RECENT VAULTS</div>{#each recents as recent}<div class="recent-row"><button onclick={()=>reopen(recent)} disabled={busy}><Icon name="clock" size={17}/><span>{recent.name}</span><Icon name="chevron" size={15}/></button><button class="icon-button" title={`Forget ${recent.name}`} onclick={async()=>{ await forgetVault(recent.id); await refreshRecents(); }}><Icon name="close" size={14}/></button></div>{/each}</div>{/if}
        {/if}
        <div class="unlock-footnote"><Icon name="shield" size={15}/><span>Your password and files stay on this device.</span></div>
      </section>
    </main>
    <footer class="welcome-footer"><span>Local Cryptomator manager</span><span>Cryptomator formats 7 & 8 <span class="footer-separator">/</span> Works offline after installation</span></footer>
  </div>
{:else if client && info}
  <div class="app-shell" inert={settings||Boolean(manager)||Boolean(conversionEntry)}>
    <header class="app-header"><button class="brand" onclick={closeVault}><span class="brand-icon"><Icon name="lock" size={19}/></span>Crypte<span class="brand-dot">.</span></button><span class="header-divider"></span><div class="header-vault"><Icon name="folder" size={17}/><span>{info.name}</span><span class="vault-status">Unlocked</span></div><div class="app-header-actions"><span class="local-label"><span></span>Local files</span><button class="icon-button" title="Preferences" onclick={openSettings}><Icon name="settings" size={19}/></button><button class="lock-button" onclick={lock}><Icon name="lock" size={15}/>Lock vault</button></div></header>
    <div class="app-body">
      <aside class="sidebar">
        <div class="sidebar-section-label">YOUR VAULT</div>
        <button class="sidebar-link" class:active={currentDirectory === ''} onclick={()=>navigate([{ name:'All files',id:'' }])}><Icon name="folder" size={18}/>All files<span>{browsable.length}</span></button>
        <button class="sidebar-link" class:active={filter === 'image'} onclick={()=>chooseFilter(filter === 'image' ? 'all' : 'image')}><Icon name="image" size={18}/>Pictures</button>
        <button class="sidebar-link" class:active={filter === 'video'} onclick={()=>chooseFilter(filter === 'video' ? 'all' : 'video')}><Icon name="video" size={18}/>Videos</button>
        <button class="sidebar-link" class:active={filter === 'text'} onclick={()=>chooseFilter(filter === 'text' ? 'all' : 'text')}><Icon name="text" size={18}/>Documents</button>
        {#if visibleFolders.length}<div class="sidebar-section-label folders-label">OPENED FOLDERS</div>{#each visibleFolders as folder}<button class="sidebar-link" class:active={currentDirectory === folder.id} onclick={()=>navigate(folder.ancestors)}><Icon name="folder" size={17}/><span class="folder-name">{folder.name}</span></button>{/each}{/if}
        <div class="sidebar-bottom"><div class="privacy-card"><Icon name="shield" size={23}/><h3>Local encryption</h3><p>Files are decrypted for previews and encrypted before being added to the vault.</p></div><button class="sidebar-link open-another" onclick={chooseVault} disabled={importing||scanningImport||mutating}><Icon name="plus" size={17}/>Open another vault</button></div>
      </aside>
      <main class="explorer" class:has-preview={selected} class:preview-expanded={expanded}>
        <div class="explorer-content" bind:this={explorerContent}>
          <nav class="breadcrumbs" aria-label="Breadcrumb">{#each breadcrumbs as crumb,index}{#if index}<Icon name="chevron" size={13}/>{/if}<button onclick={()=>navigate(breadcrumbs.slice(0,index+1))}>{index === 0 ? info.name : crumb.name}</button>{/each}</nav>
          <div class="explorer-heading"><div><div class="eyebrow">FILES AND FOLDERS</div><h1>{currentDirectory === '' ? 'All files' : breadcrumbs.at(-1)!.name}</h1><p>{fileCount} {fileCount === 1 ? 'file' : 'files'}{folderCount ? ` · ${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}` : ''}</p></div><div class="heading-actions"><button class="small-button" onclick={chooseImport} disabled={writeDisabled} title={source?.type === 'handle' ? 'Add files to this folder' : 'Adding files requires native folder access in a compatible browser'}><Icon name="plus" size={16}/>Add files</button><button class="small-button" onclick={chooseFolderImport} disabled={writeDisabled}><Icon name="folder" size={16}/>Add folder</button><button class="small-button" onclick={()=>openManager('mkdir')} disabled={writeDisabled}><Icon name="plus" size={16}/>New folder</button><button class="icon-button refresh-button" title="Refresh folder" disabled={loading || importing || scanningImport || mutating} onclick={()=>navigate([...breadcrumbs],'replace')}><Icon name="refresh"/></button></div></div>
          {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
          {#if notice}<div class="notice-banner compact" role="status">{notice}<button class="icon-button" title="Dismiss" onclick={()=>notice=''}><Icon name="close" size={14}/></button></div>{/if}
          <div class="explorer-toolbar"><label class="search-field"><Icon name="search" size={17}/><input bind:this={searchInput} value={search} oninput={event=>{search=event.currentTarget.value;rememberView();}} placeholder="Find in this folder" aria-label="Find in this folder"/><kbd>⌘ K</kbd></label><select aria-label="Filter files" value={filter} onchange={event=>chooseFilter(event.currentTarget.value)}><option value="all">All types</option><option value="image">Pictures</option><option value="video">Videos</option><option value="audio">Audio</option><option value="text">Text</option></select><select aria-label="Sort files" value={sort} onchange={event=>{sort=event.currentTarget.value;rememberView();}}><option value="name">Name</option><option value="modified">Newest</option><option value="size">Largest</option></select>{#if source?.type==='handle'&&!selecting}<button class="small-button" disabled={writeDisabled} onclick={()=>selecting=true}>Select items</button>{/if}<div class="view-switch"><button class:active={view === 'grid'} aria-label="Gallery view" aria-pressed={view === 'grid'} onclick={()=>{view='grid';rememberView();}}><Icon name="grid" size={17}/></button><button class:active={view === 'list'} aria-label="List view" aria-pressed={view === 'list'} onclick={()=>{view='list';rememberView();}}><Icon name="list" size={18}/></button></div></div>
          {#if source?.type==='handle'&&(selecting||marked.length)}<div class="selection-toolbar"><label><input type="checkbox" aria-label="Select all visible items" checked={visible.length>0&&visible.every(entry=>marked.includes(entry.id))} disabled={writeDisabled||!visible.length} onchange={event=>marked=event.currentTarget.checked?visible.map(entry=>entry.id):[]}/>Select all</label>{#if markedEntries.length}<span>{markedEntries.length} selected</span><button class="small-button" disabled={writeDisabled} onclick={()=>openManager('move',markedEntries)}><Icon name="move" size={15}/>Move selected</button><button class="small-button danger-text" disabled={writeDisabled} onclick={()=>openManager('delete',markedEntries)}><Icon name="trash" size={15}/>Delete selected</button><button class="icon-button" aria-label="Clear selection" onclick={()=>{marked=[];selecting=false;selectionAnchor=undefined;}}><Icon name="close" size={15}/></button>{/if}<button class="small-button" onclick={()=>{marked=[];selecting=false;selectionAnchor=undefined;}}>Done selecting</button></div>{/if}
          {#if scanningImport}<div class="import-status" role="status"><div><span>Reading source folder…</span><button class="small-button" onclick={()=>importController?.abort()}>Cancel</button></div></div>{/if}
          {#if importing}<div class="import-status" role="status"><div><span>Adding {importName || 'files'}</span><span>{Math.round(importProgress*100)}%</span></div><progress max="1" value={importProgress} aria-label="File import progress"></progress><p>Files are encrypted locally. Locking the vault cancels the active import.</p></div>{/if}
          {#if warnings.length}<details class="vault-warnings"><summary>{warnings.length} {warnings.length === 1 ? 'entry could' : 'entries could'} not be opened</summary><ul>{#each warnings as warning}<li>{warning}</li>{/each}</ul></details>{/if}
          {#if loading}<div class="files-empty"><div class="spinner"></div><p>Opening this folder…</p></div>
          {:else if !visible.length}<div class="files-empty"><Icon name={search ? 'search' : 'folder'} size={44}/><h2>{search || browsable.length ? 'No matching files' : 'This folder is empty'}</h2><p>{search ? 'Try another name or change the filter.' : 'There are no matching files in this folder.'}</p></div>
          {:else if view === 'grid'}<div class="file-grid">{#each visible as entry (entry.id)}<div class="file-tile" class:marked={marked.includes(entry.id)}>
            <button class="file-card" class:selected={selected?.id === entry.id} onclick={event=>activateEntry(event,entry)} aria-label={`Open ${entry.name}`} draggable={!writeDisabled} ondragstart={event=>drag(event,entry)} ondragover={event=>{if(entry.kind==='folder'&&!writeDisabled&&event.dataTransfer?.types.includes('application/x-crypte-entries'))event.preventDefault();}} ondrop={event=>{if(entry.kind==='folder')void drop(event,entry);}}><Thumbnail {entry} {client} {streaming}/><div class="file-card-info"><span class="file-name">{entry.name}</span><span class="file-meta">{entry.kind === 'folder' ? 'Folder' : formatSize(entry.size)}</span>{#if entry.kind === 'folder'}<span class="folder-arrow"><Icon name="chevron" size={14}/></span>{/if}</div></button>
            <EntryActions {entry} open={menu===entry.id} disabled={writeDisabled} marked={marked.includes(entry.id)} {selecting} ontoggle={()=>menu=menu===entry.id?'':entry.id} onmark={()=>mark(entry)} onaction={action=>entryAction(action,entry)}/>
          </div>{/each}</div>
          {:else}<div class="file-list"><div class="list-header"><span>Name</span><span>Size</span><span>Modified</span></div>{#each visible as entry (entry.id)}<div class="file-list-item" class:marked={marked.includes(entry.id)}>
            <button class="file-row" class:selected={selected?.id === entry.id} onclick={event=>activateEntry(event,entry)} aria-label={`Open ${entry.name}`} draggable={!writeDisabled} ondragstart={event=>drag(event,entry)} ondragover={event=>{if(entry.kind==='folder'&&!writeDisabled&&event.dataTransfer?.types.includes('application/x-crypte-entries'))event.preventDefault();}} ondrop={event=>{if(entry.kind==='folder')void drop(event,entry);}}><span class="row-name"><span class="row-icon" class:folder={entry.kind === 'folder'}>{#if entry.kind === 'image' || entry.kind === 'video'}<Thumbnail {entry} {client} {streaming} compact/>{:else}<Icon name={entry.kind} size={21}/>{/if}</span>{entry.name}</span><span>{entry.kind === 'folder' ? '—' : formatSize(entry.size)}</span><span>{entry.modified ? new Date(entry.modified).toLocaleDateString(undefined,{ month:'short',day:'numeric',year:'numeric' }) : '—'}</span></button>
            <EntryActions {entry} open={menu===entry.id} disabled={writeDisabled} marked={marked.includes(entry.id)} {selecting} ontoggle={()=>menu=menu===entry.id?'':entry.id} onmark={()=>mark(entry)} onaction={action=>entryAction(action,entry)}/>
          </div>{/each}</div>{/if}
          <div class="explorer-footer"><span><Icon name="shield" size={14}/>{source?.type === 'handle' ? 'Local vault' : 'Read-only vault'}</span><span>{streaming ? 'Media streaming ready' : streamingPending ? 'Starting media streaming' : 'In-memory previews'}<span class="status-dot"></span></span></div>
        </div>
        {#if selected}{#key selected.id}<Preview entry={selected} {client} {streaming} {streamingPending} {streamingError} onretryStreaming={prepareStreaming} {expanded} onclose={dismissPreview} onnext={()=>adjacent(1)} onprevious={()=>adjacent(-1)} ontoggle={toggleExpanded} canWrite={source?.type==='handle'&&!busy&&!loading} onsave={saveEditedText} oneditstate={state=>editor=state}/>{/key}{/if}
      </main>
    </div>
  </div>
{/if}

{#if conversionEntry && unlocked && client && source?.type==='handle'}<ConversionDialog entry={conversionEntry} {client} root={source.handle} {streaming} onclose={closeConversion} onlock={lock} oncommit={commitConversion}/>{/if}

{#if manager && unlocked && client && info}<FileActionsDialog action={manager.action} targets={manager.targets} {client} vaultName={info.name} parentId={currentDirectory} {hideDotfiles} busy={mutating} onconfirm={confirmActions} oncancel={closeManager}/>{/if}

{#if settings && unlocked}
  <div class="modal-backdrop" role="presentation" onclick={event=>{ if (event.target === event.currentTarget) dismissSettings(); }}>
    <div class="settings-dialog" role="dialog" aria-modal="true" aria-label="Preferences" tabindex="-1" use:focusDialog>
      <div class="dialog-heading"><div><span class="card-eyebrow">VAULT SETTINGS</span><h2>Preferences</h2></div><button class="icon-button" title="Close preferences" onclick={dismissSettings}><Icon name="close"/></button></div>
      <div class="setting-group"><div class="setting-icon"><Icon name="fingerprint" size={24}/></div><div><h3>Unlock with a passkey</h3><p>Use Touch ID or your platform authenticator. Your vault keys are encrypted with a key from your passkey and stored in this browser.</p>{#if passkey}<span class="enabled-label"><Icon name="check" size={15}/>Enabled on this app address</span><button class="secondary-button" onclick={removePasskey} disabled={busy}>Remove local unlock</button>{:else}<button class="primary-button" onclick={enrollPasskey} disabled={busy || !biometricAvailable}>{busy ? 'Setting up…' : 'Set up passkey'}<Icon name="fingerprint" size={17}/></button>{#if !biometricAvailable}<p class="setting-note">A compatible platform authenticator is unavailable. Password unlock remains available.</p>{/if}{/if}</div></div>
      {#if error}<div class="error-banner" role="alert">{error}</div>{/if}{#if notice}<div class="notice-banner" role="status">{notice}</div>{/if}
      <div class="setting-row"><div><h3>Auto-lock</h3><p>Lock after inactivity. Background tabs lock after one minute.</p></div><select aria-label="Auto-lock timeout" bind:value={idleMinutes}><option value={1}>1 minute</option><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={0}>Manual</option></select></div>
      <div class="setting-row"><div><h3>Hide dotfiles</h3><p>Hide files and folders whose names start with a dot.</p></div><input type="checkbox" aria-label="Hide dotfiles" bind:checked={hideDotfiles}/></div>
      <div class="setting-row"><div><h3>Appearance</h3><p>System follows your device’s light or dark appearance.</p></div><select aria-label="Appearance" bind:value={theme}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
      <p class="dialog-footnote">Passkeys are tied to this app’s address and browser storage. Keep your vault password for recovery.</p>
    </div>
  </div>
{/if}

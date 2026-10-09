<script lang="ts">
  import { onDestroy,tick } from 'svelte';
  import Icon from './Icon.svelte';
  import ImageViewer from './ImageViewer.svelte';
  import VideoTimeline from './VideoTimeline.svelte';
  import {highlightCode,syntaxLanguage} from '../lib/highlighting';
  import { readBlob } from '../lib/previews';
  import { mediaURL, revokeMediaURL } from '../lib/media';
  import { formatSize, type VaultEntry,type EditFingerprint } from '../lib/types';
  import { editableText,encodeEdit,TEXT_EDIT_LIMIT,type TextFormat } from '../lib/editing';
  import type { VaultClient } from '../lib/client';
  import { imagePreview } from '../lib/images';
  import { decodeText } from '../lib/text';
  let { entry, client, streaming, streamingPending, streamingError, onretryStreaming, onclose, onnext, onprevious, expanded, ontoggle,canWrite,ondownload,downloadDisabled,onsave,oneditstate }: { entry:VaultEntry; client:VaultClient; streaming:boolean; streamingPending:boolean; streamingError:string; onretryStreaming:()=>void; onclose:()=>void; onnext:()=>void; onprevious:()=>void; expanded:boolean; ontoggle:()=>void;canWrite:boolean;ondownload:(entry:VaultEntry)=>Promise<void>;downloadDisabled:boolean;onsave:(entry:VaultEntry,file:File,expected:EditFingerprint,signal:AbortSignal)=>Promise<void>;oneditstate:(state:{dirty:boolean;saving:boolean;discard:()=>void}|undefined)=>void } = $props();
  let loading = $state(true), error = $state(''), url = $state(''), content = $state(''), exporting = $state(false), wrap = $state(true), fontSize = $state(14);
  let textSearch = $state('');
  let editing=$state(false),openingEditor=$state(false),saving=$state(false),draft=$state(''),original=$state('');
  let format:TextFormat|undefined,fingerprint:EditFingerprint|undefined,editorController:AbortController|undefined;
  let editorArea=$state<HTMLTextAreaElement>();
  let highlighted=$state(''),highlightLayer=$state<HTMLPreElement>(),editorTop=$state(0),editorLeft=$state(0);
  $effect(()=>{const code=draft;if(!editing)return;const timer=setTimeout(()=>highlighted=highlightCode(code,entry.name),100);return()=>clearTimeout(timer);});
  const dirty=$derived(editing&&draft!==original);
  const editable=$derived(entry.kind==='text'&&entry.mime!=='application/rtf'&&entry.size<=TEXT_EDIT_LIMIT);
  $effect(()=>{oneditstate({dirty,saving,discard});});
  onDestroy(()=>{editorController?.abort();draft='';original='';fingerprint=undefined;oneditstate(undefined);});
  function discard(){editorController?.abort();editing=false;openingEditor=false;draft='';original='';fingerprint=undefined;format=undefined;}
  function cancelEdit(){if(saving){editorController?.abort();return;}if(dirty&&!confirm('Discard unsaved text changes?'))return;discard();}
  async function edit(){
    if(!editable||!canWrite||saving)return;editorController?.abort();const controller=new AbortController();editorController=controller;openingEditor=true;error='';
    try{const snapshot=await client.readText(entry);try{controller.signal.throwIfAborted();const decoded=editableText(snapshot.bytes);format=decoded.format;fingerprint=snapshot.fingerprint;draft=original=decoded.text;editing=true;}finally{snapshot.bytes.fill(0);}await tick();if(!controller.signal.aborted)editorArea?.focus();}
    catch(e){if(!controller.signal.aborted)error=e instanceof Error?e.message:'Unable to edit this file.';}
    finally{if(editorController===controller)openingEditor=false;}
  }
  async function save(){
    if(!editing||saving||!dirty||!format||!fingerprint)return;
    const controller=new AbortController();editorController=controller;saving=true;error='';let bytes:Uint8Array<ArrayBuffer>|undefined;
    try{bytes=encodeEdit(draft,format);const file=new File([bytes],entry.name,{type:entry.mime});await onsave(entry,file,fingerprint,controller.signal);if(!controller.signal.aborted)discard();}
    catch(e){if(!controller.signal.aborted)error=e instanceof Error?e.message:'Unable to save this file.';}
    finally{bytes?.fill(0);saving=false;}
  }
  const lines = $derived(content.split('\n'));
  let media = $state<HTMLVideoElement|HTMLAudioElement>();
  const mediaEntry=$derived(entry.kind==='video'||entry.kind==='audio');
  const preparingStreaming=$derived(mediaEntry&&!streaming&&streamingPending);
  $effect(()=>{
    const useStreaming=mediaEntry?streaming:false,waiting=mediaEntry&&!useStreaming?streamingPending:false;
    // Recreate a failed/fallback media preview when local streaming becomes ready.
    loading=true;error='';url='';content='';
    let alive = true, objectURL = '', virtualURL = '';const controller=new AbortController();
    (async()=>{
      try {
        if(waiting)return;
        if (entry.kind === 'text' || entry.kind === 'symlink') {
          if(entry.mime==='application/rtf'&&entry.size>2*1024*1024)throw new Error('RTF preview is limited to 2 MB. Export to open the full document.');
          const bytes = await client.read(entry,0,Math.min(entry.size,2*1024*1024));
          try{const decoded=decodeText(bytes,entry.mime);if(alive)content=decoded;}finally{bytes.fill(0);}
        } else if (entry.kind === 'video' || entry.kind === 'audio') {
          if (useStreaming) { virtualURL = mediaURL(entry); if (alive) url = virtualURL; }
          else {
            if(entry.size>128*1024*1024)throw new Error('This file needs streaming for playback. Local streaming is unavailable in this browser window.');
            const blob = await readBlob(client,entry,128*1024*1024,controller.signal); objectURL = URL.createObjectURL(blob); if (alive) url = objectURL;
          }
        } else if (entry.kind === 'image') {
          const blob=await imagePreview(await readBlob(client,entry,undefined,controller.signal),entry,controller.signal);objectURL=URL.createObjectURL(blob);if(alive)url=objectURL;
        }
      } catch (e) { if (alive) error = e instanceof Error ? e.message : 'Unable to preview this file.'; }
      finally { if (alive) loading = waiting; else if (objectURL) URL.revokeObjectURL(objectURL); }
    })();
    return ()=>{
      alive = false;controller.abort();
      if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
      if (objectURL) URL.revokeObjectURL(objectURL); if (virtualURL) revokeMediaURL(virtualURL);
      content = ''; url = '';
    };
  });
  async function download() {
    exporting = true; error = '';
    try { await ondownload(entry); }
    catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) error = e instanceof Error ? e.message : 'Unable to export.'; }
    finally { exporting = false; }
  }
</script>
<svelte:window onkeydown={event=>{if(editing&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void save();}}}/>
<section class="preview-pane" class:expanded aria-label="File preview">
  <div class="preview-toolbar">
    <span>{editing?'Text editor':'Preview'}</span><div>
      <button class="icon-button" title="Previous file" onclick={onprevious}><Icon name="back" size={17}/></button>
      <button class="icon-button" title="Next file" onclick={onnext}><Icon name="chevron" size={17}/></button>
      <button class="icon-button" title={expanded ? 'Shrink preview' : 'Expand preview'} onclick={ontoggle}><Icon name="expand" size={17}/></button>
      <button class="icon-button" title="Close preview" onclick={onclose}><Icon name="close" size={17}/></button>
    </div>
  </div>
  <div class="preview-title"><div class="file-badge"><Icon name={entry.kind} size={22}/></div><div><h2>{entry.name}</h2><p>{formatSize(entry.size)} <span>·</span> {entry.kind === 'symlink' ? 'Symbolic link' : entry.kind}</p></div></div>
  {#if editing}<div class="editor-actions"><span role="status">{saving?'Saving encrypted file…':dirty?'Unsaved changes':'No changes'}</span><button class="small-button" onclick={cancelEdit}>{saving?'Cancel save':'Cancel edit'}</button><button class="small-button active" disabled={saving||!dirty} onclick={save}>Save changes</button></div>
  {:else if entry.kind==='text'&&entry.mime!=='application/rtf'}<div class="editor-actions"><span>{!editable?'Editing requires the complete file within 2 MiB.':!canWrite?'Read-only vault':''}</span><button class="small-button" disabled={!editable||!canWrite||loading||openingEditor} onclick={edit}><Icon name="rename" size={14}/>{openingEditor?'Opening editor…':'Edit text'}</button></div>{/if}
  {#if error}<p class="error-banner" role="alert">{error}</p>{/if}
  {#if mediaEntry&&!streaming&&!streamingPending}<div class="preview-note"><p>{streamingError}</p><p>Large video and audio files can play without a full in-memory copy when local streaming is available.</p><button class="small-button" onclick={onretryStreaming}>Retry streaming</button></div>{/if}
  <div class="preview-content" class:text-preview={entry.kind === 'text' || entry.kind === 'symlink'}>
    {#if editing}<div class="highlight-editor" style:font-size={`${fontSize}px`}><pre aria-hidden="true" bind:this={highlightLayer} style:transform={`translate(${-editorLeft}px, ${-editorTop}px)`}><code>{@html highlighted}{'\n'}</code></pre><textarea class="text-editor" bind:this={editorArea} bind:value={draft} aria-label="Edit file contents" spellcheck="false" autocomplete="off" autocapitalize="off" disabled={saving} wrap="off" onscroll={event=>{editorTop=event.currentTarget.scrollTop;editorLeft=event.currentTarget.scrollLeft;}}></textarea></div><p class="preview-note">{syntaxLanguage(entry.name)&&draft.length<=256*1024?'Syntax highlighting enabled. ':''}Changes stay in memory until saved. Locking discards unsaved edits. ⌘/Ctrl S saves.</p>
    {:else if loading}<div class="preview-empty"><div class="spinner"></div><p>{preparingStreaming ? 'Preparing local media streaming…' : 'Opening your file…'}</p></div>
    {:else if entry.kind === 'text' || entry.kind === 'symlink'}
      <div class="reader-controls"><label><Icon name="search" size={15}/><input aria-label="Find in file" placeholder="Find in file" bind:value={textSearch}/></label><button class="small-button" class:active={wrap} onclick={()=>wrap=!wrap}>Wrap</button><button class="small-button" aria-label="Smaller text" onclick={()=>fontSize=Math.max(11,fontSize-1)}>A−</button><button class="small-button" aria-label="Larger text" onclick={()=>fontSize=Math.min(24,fontSize+1)}>A+</button></div>
      {#if entry.kind === 'symlink'}<p class="preview-note">Link target shown as text. Links are never followed.</p>{/if}
      {#if entry.mime==='application/rtf'}<p class="preview-note">RTF text extracted. Formatting and embedded objects are omitted.</p>{/if}
      <div class="reader" class:nowrap={!wrap} style:font-size={`${fontSize}px`}>
        {#each lines as line,index}<div class="reader-line" class:match={textSearch && line.toLowerCase().includes(textSearch.toLowerCase())}><span class="line-number">{index+1}</span><span>{line || ' '}</span></div>{/each}
      </div>
      {#if entry.size > 2*1024*1024}<p class="preview-note">Showing the first 2 MB. Export to read the entire file.</p>{/if}
    {:else if entry.kind === 'image' && url}<ImageViewer {url} name={entry.name} onerror={()=>{error='Image preview failed. The format may be unsupported or the file may be damaged. Export to open it in another app.';}}/>
    {:else if entry.kind === 'video' && url}<div class="video-view"><video bind:this={media} src={url} controls playsinline preload="metadata" onerror={()=>error='Playback failed. The codec may be unsupported, the vault may be locked, or the file could not be authenticated.'}><track kind="captions"/></video></div><VideoTimeline {client} {entry} {media}/>
    {:else if entry.kind === 'audio' && url}<div class="audio-view"><Icon name="audio" size={76}/><audio bind:this={media} src={url} controls preload="metadata" onerror={()=>error='Playback failed. Try exporting the file to a compatible player.'}></audio></div>
    {:else if !error}<div class="preview-empty"><Icon name="file" size={52}/><h3>No preview for this file type</h3><p>Export a decrypted copy to open it in another app.</p></div>{/if}
  </div>
  <div class="preview-footer"><span><Icon name="shield" size={15}/> Decrypted on your device</span><button class="small-button" disabled={exporting||saving||downloadDisabled} onclick={download}><Icon name="download" size={15}/>{exporting ? 'Downloading…' : editing?'Download original':'Download file'}</button></div>
</section>

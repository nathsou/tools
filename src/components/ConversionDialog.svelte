<script lang="ts">
  import {onDestroy,onMount,untrack} from 'svelte';
  import Icon from './Icon.svelte';
  import {focusDialog} from '../lib/focus';
  import type {VaultClient} from '../lib/client';
  import {classify,formatSize,type VaultEntry} from '../lib/types';
  import {convertImage,convertMedia,defaultSettings,estimatedSize,inspectMedia,reduction,sourceStamp,type ConvertedMedia,type MediaDetails,type ConvertSettings} from '../lib/conversion';
  import {mediaURL,revokeMediaURL} from '../lib/media';
  let {entry,client,root,streaming,onclose,onlock,oncommit}:{entry:VaultEntry;client:VaultClient;root:FileSystemDirectoryHandle;streaming:boolean;onclose:()=>void;onlock:()=>void;oncommit:(result:ConvertedMedia,remove:boolean,stamp:Awaited<ReturnType<typeof sourceStamp>>,signal:AbortSignal)=>Promise<void>}=$props();
  let settings=$state<ConvertSettings>(untrack(()=>defaultSettings(entry))),details=$state<MediaDetails>(),estimate=$state<number>(),error=$state(''),working=$state(false),saving=$state(false),progress=$state(0),result=$state<ConvertedMedia>(),url=$state(''),loaded=$state(false),reviewed=$state(false),remove=$state(false),estimating=$state(true),phase=$state('Preparing');
  const controller=new AbortController();let estimateController:AbortController|undefined,preparedImage:Blob|undefined;let stamp=$state<Awaited<ReturnType<typeof sourceStamp>>>();
  const image=$derived(entry.kind==='image');
  onMount(async()=>{try{stamp=await sourceStamp(root,entry,controller.signal);if(!image)details=await inspectMedia(client,entry,controller.signal);}catch(e){if(!controller.signal.aborted)error=e instanceof Error?e.message:'Unable to inspect this file.';}finally{if(!controller.signal.aborted)estimating=false;}});
  $effect(()=>{const options={...settings};if(!image||result)return;const task=new AbortController();estimateController?.abort();estimateController=task;preparedImage=undefined;estimate=undefined;estimating=true;
    const timer=setTimeout(async()=>{try{const blob=await convertImage(client,entry,options,AbortSignal.any([controller.signal,task.signal]));task.signal.throwIfAborted();preparedImage=blob;estimate=blob.size;}catch(e){if(!task.signal.aborted&&!controller.signal.aborted)error=e instanceof Error?e.message:'Unable to estimate image size.';}finally{if(!task.signal.aborted&&!controller.signal.aborted)estimating=false;}},250);
    return()=>{clearTimeout(timer);task.abort();};
  });
  const expected=$derived(image?estimate:details?estimatedSize(details,settings):undefined);
  function cleanupURL(){if(!url)return;if(image)URL.revokeObjectURL(url);else revokeMediaURL(url);url='';}
  onDestroy(()=>{controller.abort();estimateController?.abort();cleanupURL();preparedImage=undefined;void result?.spool.dispose();});
  async function convert(){
    if(working||!stamp)return;working=true;phase='Converting';error='';
    try{const converted=await convertMedia(client,entry,{...settings},controller.signal,p=>progress=p,preparedImage);controller.signal.throwIfAborted();result=converted;preparedImage=undefined;
      if(image){const parts:Uint8Array<ArrayBuffer>[]=[];try{for(let offset=0;offset<converted.spool.size;offset+=4*1024*1024)parts.push(await converted.spool.read(offset,Math.min(converted.spool.size,offset+4*1024*1024)));url=URL.createObjectURL(new Blob(parts,{type:converted.mime}));}finally{parts.forEach(part=>part.fill(0));}}
      else{const preview:VaultEntry={...entry,id:converted.spool.id,name:converted.name,size:converted.spool.size,...classify(converted.name),mime:converted.mime};url=mediaURL(preview,(start,end)=>converted.spool.read(start,end));}
    }catch(e){if(!controller.signal.aborted)error=e instanceof Error?e.message:'Conversion failed.';}finally{if(!controller.signal.aborted)working=false;}
  }
  async function save(){if(!result||!stamp||!loaded||saving||remove&&!reviewed)return;saving=true;phase='Saving encrypted copy';error='';try{await oncommit(result,remove,stamp,controller.signal);controller.signal.throwIfAborted();onclose();}catch(e){if(!controller.signal.aborted)error=e instanceof Error?e.message:'Unable to save conversion.';}finally{if(!controller.signal.aborted)saving=false;}}
  async function reset(){cleanupURL();await result?.spool.dispose();result=undefined;loaded=reviewed=remove=false;progress=0;}
</script>
<div class="modal-backdrop" role="presentation"><div class="settings-dialog conversion-dialog" role="dialog" aria-modal="true" aria-label="Convert media" tabindex="-1" use:focusDialog>
  <div class="dialog-heading"><div><span class="card-eyebrow">LOCAL CONVERSION</span><h2>{result?'Review conversion':'Convert media'}</h2></div><button class="icon-button" aria-label="Close conversion" onclick={onclose}><Icon name="close"/></button></div>
  <button class="small-button" onclick={onlock}><Icon name="lock" size={14}/>Lock vault</button>
  <p class="conversion-filename">{entry.name} · {formatSize(entry.size)}</p>
  {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
  {#if !result}
    <div class="conversion-options"><label>Format<select aria-label="Conversion format" bind:value={settings.format} disabled={working}>{#if image}<option value="webp">WebP</option><option value="jpeg">JPEG</option><option value="png">PNG (lossless)</option>{:else}<option value="webm">WebM · VP9 / Opus</option><option value="mp4">MP4 · H.264 / AAC</option>{/if}</select></label>
      {#if entry.kind!=='audio'}<label>{image?'Maximum height':'Video height'}<select aria-label="Conversion height" bind:value={settings.height} disabled={working}><option value={0}>Original</option><option value={2160}>2160 px</option><option value={1080}>1080 px</option><option value={720}>720 px</option><option value={480}>480 px</option></select></label>{/if}
      {#if image}<label>Quality<input aria-label="Image quality" type="range" min="0.2" max="1" step="0.01" bind:value={settings.quality} disabled={working||settings.format==='png'}/><span>{Math.round(settings.quality*100)}%</span></label>{:else}
        {#if entry.kind==='video'}<label>Video bitrate<select aria-label="Video bitrate" bind:value={settings.videoBitrate} disabled={working}><option value={500000}>0.5 Mbps</option><option value={1000000}>1 Mbps</option><option value={2000000}>2 Mbps</option><option value={4000000}>4 Mbps</option><option value={8000000}>8 Mbps</option></select></label>{/if}
        <label>Audio bitrate<select aria-label="Audio bitrate" bind:value={settings.audioBitrate} disabled={working}><option value={64000}>64 kbps</option><option value={128000}>128 kbps</option><option value={192000}>192 kbps</option></select></label>
      {/if}
    </div>
    <div class="conversion-estimate" role="status"><span>{image?'Estimated size':'Approximate size'}</span><strong>{expected===undefined?'Calculating…':reduction(entry.size,expected)}</strong><p>{image?'Measured from a trial encode with these settings.':'Based on duration and target bitrates. Actual size can vary, especially for short clips.'}</p></div>
    <p class="dialog-description">{image?'Conversion creates a still image and removes embedded metadata. Animated and multi-image files retain only one frame.':'Encoding depends on your browser’s codecs. All detected video and audio tracks must be supported. Subtitles, HDR and some metadata may be lost. Check picture and sound before removing the original.'}</p>
    {#if working}<div class="action-working" role="status">{phase}… {Math.round(progress*100)}%</div><progress max="1" value={progress} aria-label="Conversion progress"></progress>{/if}
    <div class="dialog-actions"><button class="secondary-button" onclick={onclose}>{working?'Cancel conversion':'Cancel'}</button><button class="primary-button" onclick={convert} disabled={working||estimating||!stamp||expected===undefined||!image&&!streaming}>{working?'Converting…':'Convert and preview'}</button></div>
    {#if !image&&!streaming}<p class="setting-note">Enable media streaming to review the converted file before saving.</p>{/if}
  {:else}
    <div class="converted-preview">{#if !url}<div class="action-working" role="status">Preparing preview…</div>{:else if image}<img src={url} alt="Converted preview" onload={()=>loaded=true} onerror={()=>{loaded=reviewed=remove=false;error='The converted image could not be previewed.';}}/>{:else if entry.kind==='audio'}<!-- svelte-ignore a11y_media_has_caption -->
<audio src={url} controls onloadeddata={()=>loaded=true} onerror={()=>{loaded=reviewed=remove=false;error='The converted audio could not be played.';}}></audio>{:else}<video src={url} controls playsinline onloadeddata={()=>loaded=true} onerror={()=>{loaded=reviewed=remove=false;error='The converted video could not be played.';}}><track kind="captions"/></video>{/if}</div>
    <div class="conversion-estimate"><span>Actual size</span><strong>{reduction(entry.size,result.spool.size)}</strong></div><p class="conversion-filename">Save as {result.name}</p>
    <label class="conversion-check"><input type="checkbox" aria-label="I have checked the converted preview" bind:checked={reviewed} disabled={!loaded||saving} onchange={event=>{if(!event.currentTarget.checked)remove=false;}}/>I have checked the converted preview{entry.kind==='video'?' and sound':''}</label>
    <label class="conversion-check"><input type="checkbox" aria-label="Remove original after saving" bind:checked={remove} disabled={!reviewed||saving}/>Remove the original after saving and verifying the copy</label>
    {#if saving}<div class="action-working" role="status">{phase}…</div>{/if}
    <div class="dialog-actions"><button class="secondary-button" onclick={onclose}>{saving?'Cancel save':'Cancel'}</button><button class="secondary-button" disabled={saving} onclick={reset}>Adjust settings</button><button class="primary-button" disabled={saving||!loaded||remove&&!reviewed} onclick={save}>{saving?'Saving…':remove?'Save and remove original':'Save copy'}</button></div>
  {/if}
</div></div>

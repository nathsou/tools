<script lang="ts">
  import {onMount} from 'svelte';
  import {videoFrames} from '../lib/bunny';
  import type {VaultClient} from '../lib/client';
  import type {VaultEntry} from '../lib/types';
  let {client,entry,media}:{client:VaultClient;entry:VaultEntry;media?:HTMLVideoElement|HTMLAudioElement}=$props();
  let frames=$state<{time:number;url:string}[]>([]),duration=$state(0),current=$state(0),hover=$state<number>(),error=$state(''),loading=$state(true);
  const time=(seconds:number)=>`${Math.floor(seconds/60)}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
  const hovered=$derived(hover===undefined?undefined:frames.reduce<{time:number;url:string}|undefined>((best,frame)=>!best||Math.abs(frame.time-hover!)<Math.abs(best.time-hover!)?frame:best,undefined));
  onMount(()=>{const controller=new AbortController(),urls:string[]=[];void videoFrames(client,entry,controller.signal,(timestamp,blob,total)=>{controller.signal.throwIfAborted();const url=URL.createObjectURL(blob);urls.push(url);frames.push({time:timestamp,url});duration=total;}).catch(()=>{if(!controller.signal.aborted)error='Timeline thumbnails are unavailable for this video.';}).finally(()=>{if(!controller.signal.aborted)loading=false;});return()=>{controller.abort();urls.forEach(url=>URL.revokeObjectURL(url));frames=[];};});
  $effect(()=>{const player=media;if(!player)return;const update=()=>{current=player.currentTime;if(Number.isFinite(player.duration))duration=player.duration;};player.addEventListener('timeupdate',update);player.addEventListener('loadedmetadata',update);update();return()=>{player.removeEventListener('timeupdate',update);player.removeEventListener('loadedmetadata',update);};});
  function seek(timestamp:number){if(!media||!Number.isFinite(timestamp))return;media.currentTime=timestamp;current=timestamp;}
</script>
<div class="video-timeline" aria-label="Video timeline">
  <div class="timeline-track" role="group" aria-label="Seek preview" onpointermove={event=>{const rect=event.currentTarget.getBoundingClientRect();hover=Math.max(0,Math.min(duration,(event.clientX-rect.left)/rect.width*duration));}} onpointerleave={()=>hover=undefined}>
    {#if hovered}<div class="timeline-hover" style:left={`${Math.max(15,Math.min(85,hover!/duration*100))}%`}><img src={hovered.url} alt={`Video at ${time(hovered.time)}`}/><span>{time(hovered.time)}</span></div>{/if}
    <input type="range" min="0" max={duration||1} step="0.01" value={current} disabled={!media||!duration} aria-label="Scrub video" oninput={event=>seek(Number(event.currentTarget.value))}/>
  </div>
  <div class="timeline-times"><span>{time(current)}</span><span>{time(duration)}</span></div>
  <div class="timeline-frames">{#each frames as frame}<button aria-label={`Seek to ${time(frame.time)}`} onclick={()=>seek(frame.time)}><img src={frame.url} alt={`Frame at ${time(frame.time)}`}/><span>{time(frame.time)}</span></button>{/each}</div>
  {#if loading}<p class="preview-note" role="status">Generating timeline thumbnails…</p>{/if}{#if error}<p class="preview-note">{error}</p>{/if}
</div>

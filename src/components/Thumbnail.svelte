<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { thumbnail,releaseThumbnail } from '../lib/previews';
  import type { VaultClient } from '../lib/client';
  import type { VaultEntry } from '../lib/types';
  let { entry, client, streaming, compact=false }: { entry:VaultEntry; client:VaultClient; streaming:boolean; compact?:boolean } = $props();
  let container:HTMLDivElement;
  let url = $state('');
  let retry=$state<(()=>void)>();
  $effect(()=>{streaming;const reload=retry;if(reload)untrack(reload);});
  $effect(()=>{
    const item={...entry},active=client;url='';
    let pending = false; let controller = new AbortController(); let alive = true, visible = false;
    async function load() {
      if (!['image','video'].includes(item.kind) || url || pending) return;
      pending = true; controller = new AbortController();
      const job = controller, streamAtStart=streaming;
      try { const next = await thumbnail(active,item,job.signal,streamAtStart); if (alive && !job.signal.aborted) url = next; else releaseThumbnail(next); }
      catch { /* Unsupported codecs or preview limits retain a file icon. */ }
      finally { pending = false; if (alive && visible && (job.signal.aborted || item.kind==='video' && !streamAtStart && streaming)) void load(); }
    }
    retry=()=>{if(visible)void load();};
    const observer = new IntersectionObserver(([item])=>{
      visible = item.isIntersecting;
      if (!visible) { controller.abort(); if (url) releaseThumbnail(url); url=''; }
      else void load();
    },{ rootMargin:'80px' });
    observer.observe(container);
    return ()=>{ alive=false;retry=undefined;controller.abort();observer.disconnect();if(url)releaseThumbnail(url); };
  });
</script>
<div bind:this={container} class="thumbnail" class:compact class:folder={entry.kind === 'folder'}>
  {#if url}<img src={url} alt="" />{:else}<Icon name={entry.kind} size={compact ? 21 : entry.kind === 'folder' ? 56 : 38}/>{/if}
  {#if entry.kind === 'video' && !compact}<span class="play-symbol">▶</span>{/if}
</div>

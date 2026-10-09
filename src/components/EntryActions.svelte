<script lang="ts">
  import Icon from './Icon.svelte';
  import type { VaultEntry } from '../lib/types';
  let {entry,open,disabled,canWrite,marked,selecting,ontoggle,onmark,onaction}:{entry:VaultEntry;open:boolean;disabled:boolean;canWrite:boolean;marked:boolean;selecting:boolean;ontoggle:()=>void;onmark:()=>void;onaction:(action:'rename'|'move'|'delete'|'convert'|'download')=>void}=$props();
</script>
<div class="entry-controls">
  {#if canWrite}<input class="item-select" class:show={selecting||marked} type="checkbox" aria-label={`Select ${entry.name}`} checked={marked} onchange={onmark} disabled={disabled}/>{/if}
  <div class="entry-menu" class:open style:margin-left="auto">
    <button class="icon-button" aria-label={`Actions for ${entry.name}`} aria-expanded={open} disabled={disabled} onclick={ontoggle}><Icon name="more" size={18}/></button>
    {#if open}<div class="entry-menu-popup">
      <button onclick={()=>onaction('download')}><Icon name="download" size={16}/>{entry.kind==='folder'?'Download folder (.zip)':'Download file'}</button>
      {#if canWrite}
      {#if ['image','video','audio'].includes(entry.kind)}<button onclick={()=>onaction('convert')}><Icon name="refresh" size={16}/>Convert…</button>{/if}
      <button onclick={()=>onaction('rename')}><Icon name="rename" size={16}/>Rename</button>
      <button onclick={()=>onaction('move')}><Icon name="move" size={16}/>Move to…</button>
      <button class="danger-text" onclick={()=>onaction('delete')}><Icon name="trash" size={16}/>Delete</button>
      {/if}
    </div>{/if}
  </div>
</div>

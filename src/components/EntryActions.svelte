<script lang="ts">
  import Icon from './Icon.svelte';
  import type { VaultEntry } from '../lib/types';
  let {entry,open,disabled,marked,selecting,ontoggle,onmark,onaction}:{entry:VaultEntry;open:boolean;disabled:boolean;marked:boolean;selecting:boolean;ontoggle:()=>void;onmark:()=>void;onaction:(action:'rename'|'move'|'delete'|'convert')=>void}=$props();
</script>
<div class="entry-controls">
  <input class="item-select" class:show={selecting||marked} type="checkbox" aria-label={`Select ${entry.name}`} checked={marked} onchange={onmark} disabled={disabled}/>
  <div class="entry-menu" class:open>
    <button class="icon-button" aria-label={`Actions for ${entry.name}`} aria-expanded={open} disabled={disabled} onclick={ontoggle}><Icon name="more" size={18}/></button>
    {#if open}<div class="entry-menu-popup">
      {#if ['image','video','audio'].includes(entry.kind)}<button onclick={()=>onaction('convert')}><Icon name="refresh" size={16}/>Convert…</button>{/if}
      <button onclick={()=>onaction('rename')}><Icon name="rename" size={16}/>Rename</button>
      <button onclick={()=>onaction('move')}><Icon name="move" size={16}/>Move to…</button>
      <button class="danger-text" onclick={()=>onaction('delete')}><Icon name="trash" size={16}/>Delete</button>
    </div>{/if}
  </div>
</div>

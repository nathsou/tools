<script lang="ts">
  import type {VaultFamily} from '../lib/types';
  let {value=$bindable<VaultFamily>('cryptomator'),disabled=false}:{value?:VaultFamily;disabled?:boolean}=$props();
</script>
<fieldset class="format-choice" {disabled}>
  <legend>Vault format</legend>
  <label class:chosen={value==='cryptomator'}><input type="radio" name="vault-format" value="cryptomator" bind:group={value}/><span><strong>Cryptomator</strong><small>Format 8 · familiar compatibility</small></span></label>
  <label class:chosen={value==='uvf'}><input type="radio" name="vault-format" value="uvf" bind:group={value}/><span><strong>UVF</strong><small>Unified Vault Format v1</small></span></label>
</fieldset>
<p class="format-help">{value==='uvf'?'For apps supporting UVF v1 password vaults. Filenames can use up to 172 UTF-8 bytes.':'Compatible with Cryptomator format 8 clients, including long filenames.'}</p>
<style>
  .format-choice{border:0;padding:0;margin:0 0 8px;display:grid;gap:8px}.format-choice legend{font-size:11px;color:var(--muted);margin-bottom:10px;font-weight:550}.format-choice label{display:flex;gap:12px;align-items:center;border:1px solid var(--border);border-radius:10px;padding:13px;cursor:pointer;background:var(--input)}.format-choice label.chosen{border-color:var(--strong);background:var(--surface)}.format-choice label:focus-within{outline:2px solid var(--strong);outline-offset:2px}.format-choice input{accent-color:var(--strong)}.format-choice strong,.format-choice small{display:block}.format-choice strong{font-size:12px;font-weight:600}.format-choice small{font-size:10px;color:var(--muted);margin-top:5px}.format-help{font-size:11px;line-height:1.7;color:var(--muted);margin-bottom:18px}
</style>

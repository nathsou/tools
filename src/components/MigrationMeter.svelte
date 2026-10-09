<script lang="ts">
  import type {MigrationProgress} from '../lib/migration';
  import {formatSize} from '../lib/types';
  let {progress,title}:{progress?:MigrationProgress;title:string}=$props();
  const scan=$derived(progress?.scan);
  const fraction=$derived(scan ? (scan.phase==='discovering'?undefined:scan.done?1:scan.bytesTotal?scan.bytesProcessed/scan.bytesTotal:0)
    : progress&&(progress.stage==='copying'||progress.stage==='verifying') ? progress.total?(progress.completed+(progress.fileProgress??0))/progress.total:1 : undefined);
  const percent=$derived(fraction===undefined?undefined:Math.floor(Math.max(0,Math.min(1,fraction))*100));
</script>
<div class="migration-meter">
  <h3 aria-live="polite">{title}</h3>
  <p>{scan?.done?'Check complete':scan?.phase==='discovering'?'Discovering files and folders…':progress?.detail||(scan?'Checking files…':progress?.stage==='copying'?'Copying encrypted files…':'Preparing…')}</p>
  <progress max="100" value={percent} aria-label={title}></progress>
  <div class="counts">
    <span>{scan?.phase==='discovering'?`${scan.total} entries found`:scan?`${scan.completed} of ${scan.total} entries`:progress?`${progress.completed} of ${progress.total} entries`:''}</span>
    <strong>{percent===undefined?'Working…':`${percent}%`}</strong>
  </div>
  {#if scan&&scan.phase==='checking'}<small>{formatSize(scan.bytesProcessed)} of {formatSize(scan.bytesTotal)} processed</small>{/if}
  {#if progress?.path}<p class="path">{progress.path}</p>{/if}
</div>
<style>
  .migration-meter{padding:20px 0}.migration-meter h3{font-size:17px;margin:0 0 12px}.migration-meter p{font-size:12px;color:var(--muted);margin:10px 0;overflow-wrap:anywhere}.migration-meter progress{display:block;width:100%;height:10px;accent-color:var(--strong)}.counts{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:var(--muted);margin-top:10px}.counts strong{color:var(--strong);font-variant-numeric:tabular-nums}.migration-meter small{display:block;color:var(--muted);font-size:10px;margin-top:8px}.path{max-height:3.6em;overflow:hidden}
</style>

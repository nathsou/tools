import type {ConversionProgress} from './convert-vault';

/** A single updating line on terminals; periodic, escape-free lines in logs. */
export function progressReporter(stream: {isTTY?: boolean; columns?: number; write(text: string): unknown}) {
  let lastKey = '', lastUpdate = 0, active = false;
  return {
    update(value: ConversionProgress) {
      const scan = value.scan, key = `${value.stage}:${value.detail ?? ''}:${scan?.phase ?? ''}`;
      const now = Date.now();
      if (key === lastKey && !scan?.done && now - lastUpdate < (stream.isTTY ? 100 : 1000)) return;
      const changed = key !== lastKey; lastKey = key; lastUpdate = now;
      const ratio = scan ? (scan.phase === 'discovering' ? undefined : scan.done ? 1 : scan.bytesTotal ? scan.bytesProcessed / scan.bytesTotal : 0)
        : value.total === undefined ? undefined : value.total ? ((value.completed ?? 0) + (value.fileProgress ?? 0)) / value.total : 1;
      const fraction = ratio === undefined ? undefined : Math.min(1, Math.max(0, ratio));
      const filled = fraction === undefined ? 0 : Math.floor(fraction * 20);
      const bar = fraction === undefined ? '[       ...          ]' : `[${'='.repeat(filled)}${' '.repeat(20 - filled)}] ${Math.floor(fraction * 100)}%`;
      const count = scan ? scan.phase === 'discovering' ? `${scan.total} entries found` : `${scan.completed}/${scan.total} entries`
        : value.total === undefined ? '' : `${value.completed ?? 0}/${value.total} entries`;
      const label = `${value.stage}${value.detail ? ` / ${value.detail}` : ''}`;
      const suffix = `${bar} ${scan?.phase === 'discovering' ? 'Discovering • ' : ''}${count}`;
      const room = stream.isTTY ? Math.max(8, (stream.columns ?? 80) - suffix.length - 3) : label.length;
      const line = `${label.slice(0, room)}: ${suffix}`;
      if (stream.isTTY) { if (active && changed) stream.write('\n'); stream.write(`\r\x1b[2K${line}`); active = true; }
      else stream.write(`${line}\n`);
    },
    finish() { if (active) { stream.write('\n'); active = false; } }
  };
}

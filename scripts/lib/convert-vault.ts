import {createHash} from 'node:crypto';
import {lstat, realpath} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {Vault} from '../../src/lib/vault';
import {generateUvf} from '../../src/lib/uvf';
import {MIGRATION_MARKER} from '../../src/lib/filesystem';
import type {MigrationInventory} from '../../src/lib/types';
import {DiskDestination, DiskStorage} from './disk-vault';

const BATCH = 4 * 1024 * 1024;
export interface ConversionProgress {
  stage: 'checking' | 'creating' | 'copying' | 'verifying';
  completed?: number;
  total?: number;
  bytes?: number;
}
export interface ConversionOptions {
  source: string;
  destination: string;
  password: string;
  destinationPassword?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  progress?: (value: ConversionProgress) => void | Promise<void>;
}
export interface ConversionResult {destination: string; files: number; folders: number; bytes: number; dryRun: boolean;}
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
async function paths(source: string, destination: string) {
  const storage = await DiskStorage.at(source);
  const requested = resolve(destination), parent = await realpath(dirname(requested)), target = join(parent, basename(requested));
  if (within(storage.root, target) || within(target, storage.root)) throw new Error('Source and destination must be separate, non-nested directories.');
  try { await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {storage, target}; throw error; }
  throw new Error('The destination already exists. Choose a new directory; nothing will be overwritten.');
}
function valid(inventory: MigrationInventory, label: string): void {
  if (inventory.issues.length) throw new Error(`${label} failed:\n${inventory.issues.slice(0, 20).map(issue => `  ${issue}`).join('\n')}${inventory.issues.length > 20 ? `\n  …and ${inventory.issues.length - 20} more issues.` : ''}`);
}

/** Read-only source -> exclusive new destination, then reopen and verify every byte. */
export async function convertCryptomatorToUvf(options: ConversionOptions): Promise<ConversionResult> {
  const signal = options.signal ?? new AbortController().signal;
  const report = async (value: ConversionProgress) => { signal.throwIfAborted(); await options.progress?.(value); signal.throwIfAborted(); };
  signal.throwIfAborted();
  const {storage, target} = await paths(options.source, options.destination);
  const source = new Vault(storage);
  let destination: Vault | undefined, output: DiskDestination | undefined;
  let marked = false, complete = false;
  const abort = () => { source.cancelInventory(); destination?.cancelInventory(); };
  signal.addEventListener('abort', abort);
  try {
    await report({stage: 'checking'});
    const info = await source.prepare();
    if (info.family !== 'cryptomator') throw new Error('The source must be a Cryptomator format 7 or 8 vault.');
    await source.unlock(options.password);
    const inventory = await source.migrationInventory('uvf');
    valid(inventory, 'Source preflight');
    signal.throwIfAborted();
    const result = {destination: target, files: inventory.files, folders: inventory.folders, bytes: inventory.bytes, dryRun: !!options.dryRun};
    if (options.dryRun) return result;
    const password = options.destinationPassword ?? options.password;
    if (!password) throw new Error('The destination password cannot be empty.');
    await report({stage: 'creating', total: inventory.items.length});
    const bootstrap = await generateUvf(password);
    signal.throwIfAborted();
    // Exclusive mkdir reserves the destination. Keep partial encrypted output on failure.
    output = await DiskDestination.create(target);
    await output.write(MIGRATION_MARKER, [new TextEncoder().encode('Incomplete Cryptomator to UVF conversion. Keep the original vault.\n')]);
    marked = true;
    await output.mkdir(bootstrap.rootPath);
    await output.write(`${bootstrap.rootPath}/dir.uvf`, [bootstrap.backup]);
    await output.write('vault.uvf', [new TextEncoder().encode(bootstrap.configuration)]);
    destination = new Vault(output);
    await destination.prepare(true); await destination.unlock(password);
    const folders = new Map([['', '']]), hashes = new Map<string, string>();
    let completed = 0, copied = 0;
    for (const item of inventory.items) {
      await report({stage: 'copying', completed, total: inventory.items.length, bytes: copied});
      const parentPath = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '', parentId = folders.get(parentPath);
      if (parentId === undefined) throw new Error('Invalid source directory order.');
      const {entry} = item;
      if (entry.kind === 'folder') {
        const plan = await destination.planWrite({kind: 'mkdir', parentId, name: entry.name});
        let committed = false;
        try {
          const folder = plan.createdFolder!, node = plan.target!;
          await output.mkdir(folder.path);
          await output.write(`${folder.path}/dir.uvf`, [folder.backup]);
          await output.mkdir(node.path);
          await output.write(`${node.path}/dir.uvf`, [folder.marker]);
          committed = true; folders.set(item.path, folder.id);
        } finally { destination.finishWrite(plan.id, committed); }
      } else {
        const plan = await destination.beginReadableImport(entry.name, entry.size, parentId, undefined, entry.kind === 'symlink');
        try {
          if (plan.name !== entry.name || plan.shortened) throw new Error('The destination changed while copying.');
          const hash = createHash('sha256'), writer = destination;
          let payload = plan.nodePath;
          if (plan.payloadName) { await output.mkdir(payload); payload += `/${plan.payloadName}`; }
          async function* chunks() {
            yield plan.header;
            for (let start = 0; start < entry.size; start += BATCH) {
              signal.throwIfAborted();
              const bytes = await source.read(entry.id, start, Math.min(entry.size, start + BATCH));
              try {
                hash.update(bytes);
                const encrypted = await writer.importChunk(plan.id, bytes);
                signal.throwIfAborted(); yield encrypted;
              } finally { bytes.fill(0); }
              copied += Math.min(BATCH, entry.size - start);
              await report({stage: 'copying', completed, total: inventory.items.length, bytes: copied});
            }
            signal.throwIfAborted();
            yield await writer.finalizeImport(plan.id); // UVF's authenticated EOF, including empty files.
          }
          await output.write(payload, chunks());
          hashes.set(item.path, hash.digest('hex'));
        } finally { destination.endImport(plan.id); }
      }
      completed++;
    }
    await report({stage: 'verifying', completed: 0, total: inventory.items.length});
    destination.lock();
    destination = new Vault(await DiskStorage.at(target));
    await destination.prepare(true); await destination.unlock(password);
    const actual = await destination.migrationInventory('uvf');
    valid(actual, 'Destination verification');
    if (actual.items.length !== inventory.items.length) throw new Error('Destination entry count does not match the source.');
    const expected = new Map(inventory.items.map(item => [item.path, item.entry]));
    completed = 0;
    for (const item of actual.items) {
      signal.throwIfAborted();
      const original = expected.get(item.path), entry = item.entry;
      if (!original || original.kind !== entry.kind || original.size !== entry.size) throw new Error(`Destination metadata does not match for ${JSON.stringify(item.path)}.`);
      expected.delete(item.path);
      if (entry.kind !== 'folder') {
        const hash = createHash('sha256');
        for (let start = 0; start < entry.size || start === 0; start += BATCH) {
          signal.throwIfAborted();
          const bytes = await destination.read(entry.id, start, Math.min(entry.size, start + BATCH));
          try { hash.update(bytes); } finally { bytes.fill(0); }
          if (!entry.size) break;
        }
        if (hash.digest('hex') !== hashes.get(item.path)) throw new Error(`Content verification failed for ${JSON.stringify(item.path)}.`);
      }
      await report({stage: 'verifying', completed: ++completed, total: inventory.items.length});
    }
    const unchanged = await source.migrationInventory('uvf');
    valid(unchanged, 'Final source check');
    if (unchanged.fingerprint !== inventory.fingerprint) throw new Error('The source changed during conversion. Retry from a stable source.');
    const final = await destination.migrationInventory('uvf');
    valid(final, 'Final destination check');
    if (final.fingerprint !== actual.fingerprint) throw new Error('The destination changed during verification.');
    signal.throwIfAborted();
    await output.removeMarker(MIGRATION_MARKER);
    complete = true;
    return result;
  } catch (error) {
    const message = signal.aborted ? 'Conversion cancelled.' : error instanceof Error ? error.message : 'Conversion failed.';
    throw new Error(`${message}${output && !complete ? `\nThe incomplete destination ${JSON.stringify(target)} was retained${marked ? ' with its incomplete-migration marker' : ''}. Remove it before retrying with the same name.` : ''}\nThe source was not modified by this script.`);
  } finally {
    signal.removeEventListener('abort', abort);
    source.lock(); destination?.lock();
  }
}

/** Filesystem adapters for the shared vault engine. No plaintext staging or browser APIs. */
import {constants, type BigIntStats} from 'node:fs';
import {lstat, mkdir, open, readdir, realpath, unlink, type FileHandle} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {safePath, type StorageEntry, type VaultFile, type VaultStorage} from '../../src/lib/filesystem';

const READ_AHEAD = 256 * 1024;
const MAX_READ = 8 * 1024 * 1024;
function missing(error: unknown): never {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new DOMException('Vault file or directory is missing.', 'NotFoundError');
  throw error;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export class DiskStorage implements VaultStorage {
  readonly name: string;
  protected constructor(readonly root: string, private identity: BigIntStats) { this.name = basename(root); }
  static async at(path: string): Promise<DiskStorage> {
    const root = await realpath(path), identity = await lstat(root, {bigint: true});
    if (!identity.isDirectory()) throw new Error('The vault path must be a directory.');
    return new DiskStorage(root, identity);
  }
  /** Do not traverse symlinks inside a vault, including its directory ancestors. */
  protected async directory(parts: string[]): Promise<string> {
    let path = this.root;
    const root = await lstat(path, {bigint: true});
    if (!root.isDirectory() || root.dev !== this.identity.dev || root.ino !== this.identity.ino) throw new Error('The vault directory changed during conversion.');
    for (const part of parts) {
      path = join(path, part);
      if (!(await lstat(path)).isDirectory()) throw new Error('Encrypted storage contains a symlink or a non-directory.');
    }
    return path;
  }
  async file(relative: string): Promise<VaultFile> {
    try {
      const parts = safePath(relative), parent = await this.directory(parts.slice(0, -1)), path = join(parent, parts.at(-1)!);
      const snapshot = await lstat(path, {bigint: true});
      if (!snapshot.isFile()) throw new Error('Encrypted storage contains a symlink or a non-regular file.');
      const size = Number(snapshot.size);
      if (!Number.isSafeInteger(size)) throw new Error('The encrypted file is too large.');
      let cache: {start: number; bytes: Uint8Array<ArrayBuffer>} | undefined;
      const read = async (start: number, end: number): Promise<ArrayBuffer> => {
        if (end - start > MAX_READ) throw new Error('Disk reads must be limited to 8 MiB.');
        if (cache && start >= cache.start && end <= cache.start + cache.bytes.length) return cache.bytes.slice(start - cache.start, end - cache.start).buffer;
        await this.directory(parts.slice(0, -1));
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          if (!sameFile(snapshot, await handle.stat({bigint: true}))) throw new Error('A vault file changed during conversion.');
          const readEnd = Math.min(size, Math.max(end, start + READ_AHEAD)), bytes = new Uint8Array(readEnd - start);
          for (let offset = 0; offset < bytes.length;) {
            const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, start + offset);
            if (!bytesRead) throw new Error('A vault file was truncated during conversion.');
            offset += bytesRead;
          }
          if (!sameFile(snapshot, await handle.stat({bigint: true}))) throw new Error('A vault file changed during conversion.');
          cache = bytes.length <= READ_AHEAD ? {start, bytes} : undefined;
          return bytes.slice(0, end - start).buffer;
        } finally { await handle.close(); }
      };
      const offset = (value: number) => value < 0 ? Math.max(size + value, 0) : Math.min(value, size);
      return {
        size, lastModified: Number(snapshot.mtimeMs),
        arrayBuffer: () => read(0, size),
        text: async () => new TextDecoder().decode(await read(0, size)),
        slice: (start = 0, end = size) => {
          const a = offset(start), b = Math.max(a, offset(end));
          return {arrayBuffer: () => read(a, b)};
        }
      };
    } catch (error) { return missing(error); }
  }
  async list(relative: string): Promise<StorageEntry[]> {
    try {
      const entries = await readdir(await this.directory(safePath(relative)), {withFileTypes: true});
      return entries.map(entry => {
        if (!entry.isFile() && !entry.isDirectory()) throw new Error('Encrypted storage contains a symlink or a non-regular entry.');
        return {name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file'};
      });
    } catch (error) { return missing(error); }
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose portable directory fsync. Individual files are still synced.
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.length;) {
    const {bytesWritten} = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new Error('Could not finish writing encrypted data.');
    offset += bytesWritten;
  }
}

/** Only instantiate for a newly created, exclusively owned destination directory. */
export class DiskDestination extends DiskStorage {
  static async create(path: string): Promise<DiskDestination> {
    await mkdir(path, {mode: 0o700}); // Deliberately not recursive: EEXIST must fail.
    return new DiskDestination(path, await lstat(path, {bigint: true}));
  }
  private async parents(parts: string[]): Promise<string> {
    for (let i = 0; i < parts.length; i++) {
      const parent = await this.directory(parts.slice(0, i));
      try { await mkdir(join(parent, parts[i]), {mode: 0o700}); await syncDirectory(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await this.directory(parts.slice(0, i + 1));
    }
    return this.directory(parts);
  }
  async mkdir(relative: string): Promise<void> {
    const parts = safePath(relative), parent = await this.parents(parts.slice(0, -1));
    await mkdir(join(parent, parts.at(-1)!), {mode: 0o700});
    await syncDirectory(parent);
  }
  async write(relative: string, chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<void> {
    const parts = safePath(relative), parent = await this.directory(parts.slice(0, -1));
    const handle = await open(join(parent, parts.at(-1)!), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { for await (const bytes of chunks) await writeAll(handle, bytes); await handle.sync(); }
    finally { await handle.close(); }
    await syncDirectory(parent);
  }
  async removeMarker(name: string): Promise<void> {
    if (safePath(name).length !== 1) throw new Error('Invalid completion marker.');
    const parent = await this.directory([]);
    await unlink(join(parent, name));
    try { await syncDirectory(parent); }
    catch (error) {
      // If committing the marker removal fails, restore the blocked state before
      // reporting failure. All encrypted data has already been synced and verified.
      await this.write(name, [new TextEncoder().encode('Completion could not be committed. Keep the source vault.\n')]);
      throw error;
    }
  }
}

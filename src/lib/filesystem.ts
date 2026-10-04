import type { Source } from './types';
export interface StorageEntry { name: string; kind: 'file' | 'directory'; }
/** macOS sidecars on the encrypted filesystem, not encrypted vault entries.
 * Check ciphertext storage names only: decrypted dotfiles are ordinary content. */
export const isFilesystemMetadata = (entry:StorageEntry):boolean => entry.kind === 'file' && (entry.name.startsWith('._') || entry.name === '.DS_Store');
export interface VaultStorage {
  name: string;
  file(path: string): Promise<File>;
  list(path: string): Promise<StorageEntry[]>;
}
export function safePath(path: string): string[] {
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/')) throw new Error('Invalid path inside vault.');
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw new Error('Invalid path inside vault.');
  return parts;
}
class HandleStorage implements VaultStorage {
  name: string;
  constructor(private root: FileSystemDirectoryHandle) { this.name = root.name; }
  private async directory(parts: string[]): Promise<FileSystemDirectoryHandle> {
    let handle = this.root;
    for (const part of parts) handle = await handle.getDirectoryHandle(part);
    return handle;
  }
  async file(path: string): Promise<File> {
    const parts = safePath(path);
    const dir = await this.directory(parts.slice(0, -1));
    return (await dir.getFileHandle(parts.at(-1)!)).getFile();
  }
  async list(path: string): Promise<StorageEntry[]> {
    const dir = await this.directory(safePath(path));
    const entries: StorageEntry[] = [];
    for await (const [name, entry] of dir.entries()) entries.push({ name, kind: entry.kind });
    return entries;
  }
}
class FileListStorage implements VaultStorage {
  private files = new Map<string, File>();
  private directories = new Map<string, Map<string, StorageEntry>>();
  name: string;
  constructor(source: Extract<Source, { type: 'files' }>) {
    this.name = source.name;
    for (const { file, path } of source.files) {
      const parts = safePath(path);
      this.files.set(path, file);
      for (let i = 0; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/');
        if (!this.directories.has(parent)) this.directories.set(parent, new Map());
        this.directories.get(parent)!.set(parts[i], { name: parts[i], kind: i === parts.length - 1 ? 'file' : 'directory' });
      }
    }
  }
  async file(path: string): Promise<File> {
    safePath(path);
    const file = this.files.get(path);
    if (!file) throw new DOMException(`Vault file is unavailable: ${path}`, 'NotFoundError');
    return file;
  }
  async list(path: string): Promise<StorageEntry[]> {
    safePath(path);
    const entries = this.directories.get(path);
    if (!entries) throw new DOMException('This folder is empty or not available in the selected files.', 'NotFoundError');
    return [...entries.values()];
  }
}
export const createStorage = (source: Source): VaultStorage => source.type === 'handle' ? new HandleStorage(source.handle) : new FileListStorage(source);
export async function readSmall(storage: VaultStorage, path: string, limit = 65536): Promise<string> {
  const file = await storage.file(path);
  if (file.size > limit) throw new Error(`Vault metadata is too large: ${path}`);
  return file.text();
}

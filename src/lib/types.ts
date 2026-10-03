export type CipherCombo = 'SIV_CTRMAC' | 'SIV_GCM';
export type FileKind = 'folder' | 'image' | 'video' | 'audio' | 'text' | 'file' | 'symlink';
export interface VaultInfo { id: string; name: string; format: number; cipherCombo: CipherCombo; }
export interface VaultEntry {
  id: string; name: string; kind: FileKind; path: string; directoryId?: string;
  size: number; modified: number; mime: string; error?: string;
}
export interface Listing { entries: VaultEntry[]; warnings: string[]; }
export interface ImportPlan { id:string; name:string; nodePath:string; encryptedName:string; shortened:boolean; size:number; header:Uint8Array<ArrayBuffer>; }
export type WriteRequest={kind:'mkdir';parentId:string;name:string}|{kind:'move';parentId:string;entryId:string;targetId:string;name:string}|{kind:'delete';parentId:string;entryId:string};
export interface FileStamp {path:string;size:number;modified:number;}
export interface EditFingerprint extends FileStamp {digest:string;}
export interface TextSnapshot {bytes:Uint8Array<ArrayBuffer>;fingerprint:EditFingerprint;}
export interface ReplacementPlan {import:ImportPlan;source:EditFingerprint;}
export interface WritePlan {
  id:string;kind:WriteRequest['kind'];name:string;sourcePath?:string;entry?:VaultEntry;sourceFiles:FileStamp[];
  target?:{path:string;directory:boolean;payloadName:string;mapping?:string;};
  createdFolder?:{id:string;path:string;marker:Uint8Array<ArrayBuffer>;backup:Uint8Array<ArrayBuffer>;};
  removedFolders:{id:string;path:string}[];noop?:boolean;
}
export interface WriteOutcome {plan:WritePlan;warnings:string[];}
export type Source = { type: 'handle'; handle: FileSystemDirectoryHandle } | { type: 'files'; files: { path: string; file: File }[]; name: string };
export interface PasskeyRecord {
  version: 1; vaultId: string; credentialId: string; salt: string; iv: string; ciphertext: string; origin: string; created: number;
}
export function classify(name: string): { kind: FileKind; mime: string } {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const images: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', heic:'image/heic', heif:'image/heif' };
  const videos: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg' };
  const audio: Record<string, string> = { weba:'audio/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' };
  if (images[ext]) return { kind: 'image', mime: images[ext] };
  if (videos[ext]) return { kind: 'video', mime: videos[ext] };
  if (audio[ext]) return { kind: 'audio', mime: audio[ext] };
  if(ext==='rtf')return {kind:'text',mime:'application/rtf'};
  if (['txt','text','md','markdown','mdx','json','jsonl','ndjson','csv','tsv','log','js','jsx','mjs','cjs','ts','tsx','css','scss','sass','less','html','htm','xml','yaml','yml','toml','ini','cfg','conf','sh','bash','zsh','rs','svelte','vue','py','c','h','cpp','hpp','go','java','kt','swift','rb','php','sql','tex','bib','diff','patch','properties','env'].includes(ext) || ['dockerfile','makefile','license','readme','.gitignore','.gitattributes','.editorconfig'].includes(name.toLowerCase())) return { kind: 'text', mime: 'text/plain;charset=utf-8' };
  return { kind: 'file', mime: 'application/octet-stream' };
}
export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${(size / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${['B','KB','MB','GB','TB'][unit]}`;
}

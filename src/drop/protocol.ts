/** Shared, dependency-free protocol primitives. Never put a pairing key in a request. */
export const VERSION = 1;
export const CHUNK_SIZE = 16 * 1024;
export const WINDOW_SIZE = 256 * 1024;
export const MEMORY_LIMIT = 128 * 1024 * 1024;
export const MAX_SIGNAL_SIZE = 64 * 1024;
export const DEFAULT_STUN = 'stun:stun.l.google.com:19302';
const encoder = new TextEncoder();

export function encode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid invitation. Ask for a new link.');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

export function newSecret(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function credentials(secret: string) {
  const raw = decode(secret);
  if (raw.length !== 32) throw new Error('Invalid invitation. Ask for a new link.');
  const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = (label: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('drop-v1'), info: encoder.encode(label) });
  const room = encode(new Uint8Array(await crypto.subtle.deriveBits(params('room'), material, 256)));
  const key = await crypto.subtle.deriveKey(params('signaling'), material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { room, key };
}

export async function seal(key: CryptoKey, value: unknown, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  if (plaintext.length > MAX_SIGNAL_SIZE / 2) throw new Error('Connection details are too large. Try another network.');
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, plaintext));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv); packed.set(ciphertext, iv.length);
  return encode(packed);
}

export async function unseal(key: CryptoKey, packed: string, context: string): Promise<unknown> {
  if (typeof packed !== 'string' || packed.length > MAX_SIGNAL_SIZE) throw new Error('Invalid connection details.');
  const bytes = decode(packed);
  if (bytes.length < 29) throw new Error('Invalid connection details.');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(context) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function description(value: unknown, type: 'offer' | 'answer'): RTCSessionDescriptionInit {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== type || !('sdp' in value) || typeof value.sdp !== 'string' || value.sdp.length > MAX_SIGNAL_SIZE / 2) {
    throw new Error('Invalid connection response. Ask for a new invitation.');
  }
  return { type, sdp: value.sdp };
}

export interface FileOffer { id: string; name: string; size: number; type: 'offer' }
export function fileOffer(value: unknown): FileOffer {
  const offer = value as Partial<FileOffer> | null;
  if (!offer || offer.type !== 'offer' || typeof offer.id !== 'string' || !/^[a-f0-9]{32}$/.test(offer.id) || typeof offer.name !== 'string' || !offer.name.length || offer.name.length > 255 || typeof offer.size !== 'number' || !Number.isSafeInteger(offer.size) || offer.size < 0 || offer.size > 16 * 1024 ** 4) throw new Error('The other device sent invalid file details.');
  return { type: 'offer', id: offer.id, name: safeName(offer.name), size: offer.size };
}

export function safeName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f/\\<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 200) || 'download';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** power).toFixed(power === 1 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB', 'TB'][power]}`;
}

export function stunServers(value: string, enabled = true): RTCIceServer[] {
  if (!enabled) return [];
  const url = value.trim() || DEFAULT_STUN;
  if (!/^stuns?:[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(url)) throw new Error('Enter a STUN URL such as stun:your-server.example:3478. TURN relays are not supported.');
  return [{ urls: url }];
}

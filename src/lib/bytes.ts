export type Bytes = Uint8Array<ArrayBuffer>;
export const utf8 = (s: string): Bytes => new TextEncoder().encode(s);
export const text = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b);
export const random = (length: number): Bytes => crypto.getRandomValues(new Uint8Array(length));
export function concat(...parts: Uint8Array[]): Bytes {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export function fromBase64(value: string): Bytes {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error('Invalid Base64 data.');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
export function toBase64(value: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < value.length; start += 8192) binary += String.fromCharCode(...value.subarray(start, start + 8192));
  return btoa(binary);
}
export const toBase64Url = (b: Uint8Array): string => toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function base32(value: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, accumulator = 0, result = '';
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += alphabet[(accumulator >>> bits) & 31]; }
  }
  if (bits) result += alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}
export function u64(value: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid chunk index.');
  const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(value)); return b;
}
export async function digest(value: Bytes, algorithm = 'SHA-256'): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, value));
}

import { describe, expect, test } from 'bun:test';
import { credentials, decode, description, encode, fileOffer, MEMORY_LIMIT, newSecret, safeName, seal, stunServers, unseal, WINDOW_SIZE } from '../../src/drop/protocol';
import { Transfer, type Sink } from '../../src/drop/transfer';
import worker, { DropRoom } from '../../cloudflare/drop-worker.js';

const offer = { type: 'offer', id: 'a'.repeat(32), name: 'hello.txt', size: 5 } as const;
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate: () => boolean) { for (let i = 0; i < 100 && !predicate(); i++) await tick(); expect(predicate()).toBe(true); }

class Channel extends EventTarget {
  readyState = 'open';
  remote!: Channel;
  sent: (string | ArrayBuffer)[] = [];
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
    queueMicrotask(() => this.remote.dispatchEvent(new MessageEvent('message', { data })));
  }
}
function connection(onOffer?: () => void, sink?: Sink) {
  const a = new Channel(), b = new Channel(); a.remote = b; b.remote = a;
  let received: Blob | undefined, done = false, stopped = '';
  const sender = new Transfer(a as unknown as RTCDataChannel, { offer() {}, progress() {}, complete() { done = true; }, stopped(message) { stopped = message; } }, 'host');
  const receiver = new Transfer(b as unknown as RTCDataChannel, {
    offer() { if (onOffer) onOffer(); else void receiver.accept(sink); }, progress() {}, complete(_, blob) { received = blob; }, stopped(message) { stopped = message; }
  }, 'guest');
  return { a, b, sender, receiver, get received() { return received; }, get done() { return done; }, get stopped() { return stopped; }, close() { sender.dispose(); receiver.dispose(); } };
}

describe('Drop authenticated pairing', () => {
  test('derives independent room identifiers and authenticates direction and tampering', async () => {
    const secret = newSecret(), first = await credentials(secret), second = await credentials(secret);
    expect(first.room).toBe(second.room); expect(first.room).not.toBe(secret);
    const packed = await seal(first.key, { type: 'offer', sdp: 'private' }, 'room:host:1');
    expect(await unseal(second.key, packed, 'room:host:1')).toEqual({ type: 'offer', sdp: 'private' });
    await expect(unseal(second.key, packed, 'room:guest:1')).rejects.toThrow();
    const bytes = decode(packed); bytes[bytes.length - 1] ^= 1;
    await expect(unseal(second.key, encode(bytes), 'room:host:1')).rejects.toThrow();
    await expect(unseal((await credentials(newSecret())).key, packed, 'room:host:1')).rejects.toThrow();
  });
  test('rejects malformed secrets, metadata, signaling, and relay configuration', async () => {
    await expect(credentials('a')).rejects.toThrow();
    expect(() => description({ type: 'answer', sdp: '' }, 'offer')).toThrow();
    for (const size of [-1, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) expect(() => fileOffer({ ...offer, size })).toThrow();
    expect(() => fileOffer({ ...offer, id: '../room' })).toThrow();
    expect(safeName('../a\\b\u202etxt.exe')).toBe('_a_b_txt.exe');
    expect(stunServers('')).toEqual([]);
    expect(stunServers('stun:example.com:3478')).toEqual([{ urls: 'stun:example.com:3478' }]);
    expect(() => stunServers('turn:example.com')).toThrow();
    expect(() => stunServers('https://example.com')).toThrow();
  });
});

describe('Drop file protocol', () => {
  test('transfers multiple windows byte-for-byte and handles zero-byte files', async () => {
    for (const size of [0, 1, WINDOW_SIZE * 3 + 17]) {
      const pair = connection();
      try {
        const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
        await pair.sender.send(new File([bytes], 'sample.bin'));
        expect(pair.done).toBe(true);
        expect(new Uint8Array(await pair.received!.arrayBuffer())).toEqual(bytes);
        expect(pair.sender.busy).toBe(false); expect(pair.receiver.busy).toBe(false);
      } finally { pair.close(); }
    }
  });
  test('sends no file bytes until accepted, and cancellation allows the next file', async () => {
    const pair = connection(() => {});
    try {
      const sending = pair.sender.send(new File(['private'], 'secret.txt')).catch(error => error);
      await until(() => pair.receiver.busy);
      expect(pair.a.sent.every(message => typeof message === 'string')).toBe(true);
      pair.receiver.cancel('Declined');
      expect(await sending).toBeInstanceOf(Error);
      expect(pair.sender.busy).toBe(false);
      const next = pair.sender.send(new File(['again'], 'next.txt'));
      await until(() => pair.receiver.busy);
      await pair.receiver.accept();
      await next;
      expect(await pair.received!.text()).toBe('again');
    } finally { pair.close(); }
  });
  test('writes to disk before acknowledging and closes before reporting success', async () => {
    let written = 0, closed = false;
    const sink: Sink = { async write(chunk) { await tick(); written += chunk.byteLength; }, async close() { closed = true; }, async abort() {} };
    const pair = connection(undefined, sink);
    try {
      await pair.sender.send(new File([new Uint8Array(32769)], 'disk.bin'));
      expect(written).toBe(32769); expect(closed).toBe(true); expect(pair.received).toBeUndefined(); expect(pair.done).toBe(true);
    } finally { pair.close(); }
  });
  test('limits fallback memory before acceptance and rejects unexpected binary frames', async () => {
    const pair = connection(() => {});
    try {
      pair.a.send(JSON.stringify({ ...offer, size: MEMORY_LIMIT + 1 }));
      await until(() => pair.receiver.busy);
      await expect(pair.receiver.accept()).rejects.toThrow('128 MB');
      pair.a.send(new ArrayBuffer(10));
      await until(() => !pair.receiver.busy);
      expect(pair.stopped).toContain('invalid data');
    } finally { pair.close(); }
  });
  test('disk failures abort without acknowledging completion', async () => {
    let aborted = false;
    const pair = connection(undefined, { async write() { throw new Error('Disk full'); }, async close() {}, async abort() { aborted = true; } });
    try {
      await expect(pair.sender.send(new File(['abc'], 'disk.txt'))).rejects.toThrow();
      expect(aborted).toBe(true); expect(pair.done).toBe(false);
    } finally { pair.close(); }
  });
});

describe('Drop signaling Worker', () => {
  test('rejects cross-origin upgrades and exposes no upload route', async () => {
    const config = await worker.fetch(new Request('https://drop.example/drop/api/config'), {});
    expect(await config.json()).toEqual({ protocol: 'drop-v1' });
    const url = `https://drop.example/drop/api/room/${'a'.repeat(43)}?role=host`;
    expect((await worker.fetch(new Request(url, { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } }), {})).status).toBe(403);
    expect((await worker.fetch(new Request(url), {})).status).toBe(426);
    expect((await worker.fetch(new Request('https://drop.example/drop/api/upload', { method: 'POST' }), {})).status).toBe(404);
  });
  test('forwards only bounded encrypted frames and expires sockets', async () => {
    const messages: string[] = [], closes: number[] = [];
    const socket = () => ({ state: { role: 'host', count: 0, bytes: 0 }, deserializeAttachment() { return { ...this.state }; }, serializeAttachment(value: any) { this.state = value; }, send(message: string) { messages.push(message); }, close(code: number) { closes.push(code); } });
    const a = socket(), b = socket();
    const data = new Map<string, unknown>([['expires', Date.now() + 1000]]);
    const room = new DropRoom({ getWebSockets: () => [a, b], storage: { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => data.set(key, value), setAlarm: async () => {}, deleteAll: async () => data.clear() } });
    await room.webSocketMessage(a, JSON.stringify({ seq: 1, data: 'encrypted' }));
    expect(messages).toEqual([JSON.stringify({ seq: 1, data: 'encrypted' })]);
    await room.webSocketMessage(a, new ArrayBuffer(1));
    expect(closes).toEqual([1008, 1008]);
    closes.length = 0;
    await room.alarm();
    expect(closes).toEqual([1008, 1008]);
    expect(data.get('expired')).toBe(true);
  });
});

// Test the complete authenticated negotiation independently of local ICE availability.
describe('Drop peer negotiation', () => {
  test('manual answers authenticate, reject tampering, and cannot be reused', async () => {
    const original = globalThis.RTCPeerConnection;
    class FakePC extends EventTarget {
      iceGatheringState = 'complete';
      remoteDescription: any = null;
      localDescription: any;
      createDataChannel() { return new EventTarget(); }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=candidate:host' }; }
      async createAnswer() { return { type: 'answer', sdp: 'v=0\r\na=candidate:guest' }; }
      async setLocalDescription(value: any) { this.localDescription = { ...value, toJSON: () => value }; }
      async setRemoteDescription(value: any) { this.remoteDescription = value; }
      close() {}
    }
    globalThis.RTCPeerConnection = FakePC as any;
    const { Peer } = await import('../../src/drop/peer');
    const secret = newSecret();
    const options = { secret, iceServers: [], onChannel() {}, onStatus() {}, onError() {} };
    const host = new Peer({ ...options, role: 'host' }), guest = new Peer({ ...options, role: 'guest' });
    try {
      const invitation = await host.manualOffer();
      const answer = await guest.manualAnswer(invitation);
      await expect(host.acceptAnswer('tampered')).rejects.toThrow();
      expect(host.pc.remoteDescription).toBeNull();
      await host.acceptAnswer(answer);
      expect(host.pc.remoteDescription?.type).toBe('answer');
      expect(guest.pc.remoteDescription?.type).toBe('offer');
      await expect(host.acceptAnswer(answer)).rejects.toThrow('already');
    } finally { host.close(); guest.close(); globalThis.RTCPeerConnection = original; }
  });

  test('automatic pairing exchanges authenticated SDP with role-bound sequence numbers', async () => {
    const originalPC = globalThis.RTCPeerConnection, originalWS = globalThis.WebSocket;
    class FakePC extends EventTarget {
      iceGatheringState = 'complete';
      remoteDescription: any = null;
      localDescription: any;
      createDataChannel() { return new EventTarget(); }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=candidate:host' }; }
      async createAnswer() { return { type: 'answer', sdp: 'v=0\r\na=candidate:guest' }; }
      async setLocalDescription(value: any) { this.localDescription = { ...value, toJSON: () => value }; }
      async setRemoteDescription(value: any) { this.remoteDescription = value; }
      close() {}
    }
    const sockets: FakeWS[] = [], frames: string[] = [];
    class FakeWS extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      onmessage?: (event: MessageEvent) => void;
      constructor() {
        super(); sockets.push(this);
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'));
          if (sockets.length === 2) for (const socket of sockets) socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'ready' }) }));
        });
      }
      send(data: string) {
        frames.push(data);
        const other = sockets.find(socket => socket !== this)!;
        queueMicrotask(() => other.onmessage?.(new MessageEvent('message', { data })));
      }
      close() { this.readyState = 3; }
    }
    globalThis.RTCPeerConnection = FakePC as any; globalThis.WebSocket = FakeWS as any;
    const { Peer } = await import('../../src/drop/peer');
    const errors: Error[] = [], secret = newSecret();
    const options = { secret, iceServers: [], onChannel() {}, onStatus() {}, onError(error: Error) { errors.push(error); } };
    const host = new Peer({ ...options, role: 'host' }), guest = new Peer({ ...options, role: 'guest' });
    try {
      await Promise.all([host.automatic(new URL('https://drop.example/drop/api')), guest.automatic(new URL('https://drop.example/drop/api'))]);
      await until(() => !!host.pc.remoteDescription && !!guest.pc.remoteDescription);
      expect(errors).toEqual([]);
      expect(frames).toHaveLength(2);
      expect(frames.every(frame => !frame.includes('candidate') && !frame.includes(secret))).toBe(true);
      expect(frames.map(frame => JSON.parse(frame).seq)).toEqual([1, 1]);
      // Replaying an otherwise authentic answer must terminate the connection.
      sockets[0].onmessage?.(new MessageEvent('message', { data: frames[1] }));
      await until(() => errors.length === 1);
      expect(errors[0].message).toContain('Unexpected signaling message');
    } finally { host.close(); guest.close(); globalThis.RTCPeerConnection = originalPC; globalThis.WebSocket = originalWS; }
  });
});

import { CHUNK_SIZE, WINDOW_SIZE, fileOffer, MEMORY_LIMIT, type FileOffer } from './protocol';

export interface Sink {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface Callbacks {
  offer(offer: FileOffer): void;
  progress(bytes: number, total: number): void;
  complete(offer: FileOffer, blob?: Blob): void;
  stopped(message: string): void;
}
interface Active {
  offer: FileOffer;
  direction: 'send' | 'receive';
  accepted: boolean;
  offset: number;
  sent: number;
  chunks: ArrayBuffer[];
  sink?: Sink;
  timer?: ReturnType<typeof setTimeout>;
}

/** An ordered DataChannel plus cumulative acknowledgments bounds receiver memory. */
export class Transfer {
  private active?: Active;
  private waiter?: { resolve: () => void; reject: (error: Error) => void; ready: () => boolean };
  private chain = Promise.resolve();
  private disposed = false;

  constructor(private channel: RTCDataChannel, private callbacks: Callbacks, private role: 'host' | 'guest') {
    channel.addEventListener('message', this.message);
    channel.addEventListener('close', this.closed);
  }
  get busy() { return !!this.active; }
  private message = (event: MessageEvent) => {
    this.chain = this.chain.then(() => this.receive(event.data)).catch(() => {
      this.cancel('The transfer failed: invalid data or a file could not be written.');
    });
  };
  private closed = () => this.stop('Connection lost. The incomplete file was discarded.');
  private control(type: string, extra: Record<string, unknown> = {}) {
    if (this.channel.readyState === 'open' && this.active) this.channel.send(JSON.stringify({ type, id: this.active.offer.id, ...extra }));
  }
  private touch(active: Active, timeout = 45_000) {
    clearTimeout(active.timer);
    active.timer = setTimeout(() => { if (this.active === active) this.cancel('Transfer timed out. Please try again.'); }, timeout);
  }
  private wake() { if (this.waiter?.ready()) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(); } }
  private wait(ready: () => boolean) {
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => { this.waiter = { resolve, reject, ready }; });
  }

  async send(file: File) {
    if (this.disposed || this.active || this.role !== 'host') throw new Error('A transfer is already in progress.');
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
    const offer = fileOffer({ type: 'offer', id, name: file.name, size: file.size });
    const active: Active = { offer, direction: 'send', accepted: false, offset: 0, sent: 0, chunks: [] };
    this.active = active;
    this.control('offer', { name: offer.name, size: offer.size });
    this.touch(active, 5 * 60_000);
    try {
      await this.wait(() => active.accepted);
      while (active.sent < file.size) {
        if (this.active !== active) throw new Error('Transfer cancelled.');
        const end = Math.min(active.sent + WINDOW_SIZE, file.size);
        while (active.sent < end) {
          const data = await file.slice(active.sent, Math.min(active.sent + CHUNK_SIZE, end)).arrayBuffer();
          if (this.active !== active) throw new Error('Transfer cancelled.');
          this.channel.send(data);
          active.sent += data.byteLength;
        }
        this.touch(active);
        await this.wait(() => active.offset === end);
      }
      this.control('end');
      this.touch(active);
      await this.wait(() => this.active !== active);
    } catch (error) {
      if (this.active === active) this.cancel(error instanceof Error ? error.message : 'Transfer interrupted.');
      throw error;
    }
  }

  async accept(sink?: Sink) {
    const active = this.active;
    if (!active || active.direction !== 'receive' || active.accepted) { await sink?.abort(); return; }
    if (!sink && active.offer.size > MEMORY_LIMIT) throw new Error('This file needs Save directly to disk. In browsers without that option, send files up to 128 MB.');
    active.sink = sink;
    active.accepted = true;
    this.touch(active);
    this.control('accept');
    this.callbacks.progress(0, active.offer.size);
  }

  cancel(message = 'Transfer cancelled. You can send another file.') {
    this.control('cancel');
    this.stop(message);
  }

  private stop(message: string) {
    const active = this.active;
    this.active = undefined;
    clearTimeout(active?.timer);
    active?.sink?.abort().catch(() => {});
    if (active) active.chunks = [];
    const waiter = this.waiter; this.waiter = undefined;
    waiter?.reject(new Error(message));
    if (active) this.callbacks.stopped(message);
  }

  private async receive(data: unknown) {
    if (this.disposed) return;
    if (data instanceof ArrayBuffer) {
      const active = this.active;
      // Drain already in-flight frames after a local cancellation.
      if (!active) return;
      if (active.direction !== 'receive' || !active.accepted || data.byteLength === 0 || data.byteLength > CHUNK_SIZE || active.offset + data.byteLength > active.offer.size) throw new Error('Unexpected chunk.');
      if (active.sink) await active.sink.write(data);
      else active.chunks.push(data);
      if (this.active !== active) return;
      active.offset += data.byteLength;
      this.touch(active);
      this.control('ack', { offset: active.offset });
      this.callbacks.progress(active.offset, active.offer.size);
      return;
    }
    if (typeof data !== 'string' || data.length > 4096) throw new Error('Invalid transfer message.');
    const message = JSON.parse(data);
    if (!message || typeof message !== 'object') throw new Error('Invalid message.');
    if (message.type === 'offer') {
      if (this.role !== 'guest' || this.active) throw new Error('Unexpected file offer.');
      const offer = fileOffer(message);
      this.active = { offer, direction: 'receive', accepted: false, offset: 0, sent: 0, chunks: [] };
      this.touch(this.active, 5 * 60_000);
      this.callbacks.offer(offer);
      return;
    }
    const active = this.active;
    if (!active || message.id !== active.offer.id) return;
    if (message.type === 'cancel') { this.stop('The other device cancelled this transfer.'); return; }
    if (active.direction === 'send') {
      if (message.type === 'accept' && !active.accepted) {
        active.accepted = true; this.touch(active); this.wake();
      } else if (message.type === 'ack' && active.accepted) {
        if (!Number.isSafeInteger(message.offset) || message.offset < active.offset || message.offset > active.sent) throw new Error('Invalid acknowledgment.');
        active.offset = message.offset;
        this.touch(active);
        this.callbacks.progress(active.offset, active.offer.size);
        this.wake();
      } else if (message.type === 'complete' && active.accepted && active.offset === active.offer.size && active.sent === active.offer.size) {
        clearTimeout(active.timer); this.active = undefined; this.wake();
        this.callbacks.complete(active.offer);
      } else throw new Error('Unexpected transfer response.');
    } else if (message.type === 'end' && active.accepted && active.offset === active.offer.size) {
      const blob = active.sink ? undefined : new Blob(active.chunks, { type: 'application/octet-stream' });
      await active.sink?.close();
      if (this.active !== active) return;
      this.control('complete');
      clearTimeout(active.timer); this.active = undefined;
      active.chunks = [];
      this.callbacks.complete(active.offer, blob);
    } else throw new Error('Unexpected transfer message.');
  }

  dispose() {
    this.disposed = true;
    this.channel.removeEventListener('message', this.message);
    this.channel.removeEventListener('close', this.closed);
    this.stop('Disconnected. Incomplete transfers were discarded.');
  }
}

import { credentials, description, MAX_SIGNAL_SIZE, seal, unseal } from './protocol';

type Role = 'host' | 'guest';
interface PeerOptions {
  secret: string;
  role: Role;
  iceServers: RTCIceServer[];
  onChannel: (channel: RTCDataChannel) => void;
  onStatus: (message: string) => void;
  onError: (error: Error) => void;
}

/** Only SDP crosses the signaling service. File data is never handled here. */
export class Peer {
  readonly pc: RTCPeerConnection;
  private socket?: WebSocket;
  private closed = false;
  private connected = false;
  private started = false;
  private sent = 0;
  private received = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private credential: ReturnType<typeof credentials>;
  private onClose = new AbortController();

  constructor(private options: PeerOptions) {
    this.credential = credentials(options.secret);
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers });
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (this.pc.connectionState === 'connected') {
        this.connected = true;
        clearTimeout(this.timer);
        clearTimeout(this.disconnectTimer);
        this.socket?.close(1000, 'Connected');
      } else if (this.pc.connectionState === 'failed') {
        this.fail(new Error(this.routeFailure('A direct connection could not be established.')));
      } else if (this.pc.connectionState === 'disconnected') {
        options.onStatus('Connection interrupted. Trying to reconnect…');
        this.disconnectTimer = setTimeout(() => this.fail(new Error('The other device disconnected. Create a new invitation to reconnect.')), 10_000);
      }
    };
    if (options.role === 'host') this.attach(this.pc.createDataChannel('drop-v1', { ordered: true }));
    else this.pc.ondatachannel = event => {
      if (event.channel.label !== 'drop-v1') { event.channel.close(); return; }
      this.attach(event.channel);
    };
  }

  private attach(channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (this.closed) return;
      this.connected = true;
      clearTimeout(this.timer);
      this.options.onChannel(channel);
    };
    channel.onclose = () => { if (!this.closed) this.fail(new Error('The connection closed. Create a new invitation to reconnect.')); };
    channel.onerror = () => { if (!this.closed) this.fail(new Error('The direct connection was interrupted. Please reconnect.')); };
  }

  private deadline(ms = 60_000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(new Error(this.routeFailure('Connection timed out.'))), ms);
  }

  private routeFailure(message: string) {
    return `${message} Keep both tabs open and try the same Wi-Fi. ${this.options.iceServers.length
      ? 'Check your VPN, firewall, or STUN server in Connection options.'
      : 'Enable STUN discovery in Connection options on both devices; local routes can fail even on the same Wi-Fi.'} Some networks require a relay, which Drop does not use.`;
  }

  private async local(type: 'offer' | 'answer') {
    if (this.closed) throw new Error('Connection cancelled.');
    await this.pc.setLocalDescription(type === 'offer' ? await this.pc.createOffer() : await this.pc.createAnswer());
    // Gather once instead of trickling. This also makes manual pairing possible.
    if (this.pc.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => done(new Error('Network discovery timed out. Check your STUN address or leave it blank.')), 15_000);
      const abort = () => done(new Error('Connection cancelled.'));
      const changed = () => { if (this.pc.iceGatheringState === 'complete') done(); };
      const done = (error?: Error) => {
        clearTimeout(timeout);
        this.pc.removeEventListener('icegatheringstatechange', changed);
        this.onClose.signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      this.pc.addEventListener('icegatheringstatechange', changed);
      this.onClose.signal.addEventListener('abort', abort, { once: true });
      changed();
    });
    if (this.closed) throw new Error('Connection cancelled.');
    if (!this.pc.localDescription?.sdp.includes('a=candidate:')) {
      throw new Error('Your browser did not expose a direct network route. Check browser WebRTC restrictions, try another browser or network, or configure your own STUN server.');
    }
    return this.pc.localDescription!.toJSON();
  }

  async manualOffer(): Promise<string> {
    const { key, room } = await this.credential;
    const offer = await seal(key, await this.local('offer'), `${room}:manual:host`);
    this.deadline(10 * 60_000);
    return offer;
  }

  async manualAnswer(offer: string): Promise<string> {
    const { key, room } = await this.credential;
    await this.pc.setRemoteDescription(description(await unseal(key, offer, `${room}:manual:host`), 'offer'));
    const answer = await seal(key, await this.local('answer'), `${room}:manual:guest`);
    this.deadline(10 * 60_000);
    return answer;
  }

  async acceptAnswer(answer: string) {
    if (this.pc.remoteDescription) throw new Error('A response has already been used.');
    const { key, room } = await this.credential;
    await this.pc.setRemoteDescription(description(await unseal(key, answer.trim(), `${room}:manual:guest`), 'answer'));
    this.deadline();
  }

  async automatic(endpoint: URL): Promise<void> {
    const { key, room } = await this.credential;
    if (this.closed) return;
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.pathname += `/room/${room}`;
    endpoint.searchParams.set('role', this.options.role);
    const socket = this.socket = new WebSocket(endpoint);
    this.deadline(10 * 60_000);
    let chain = Promise.resolve();
    const send = async (value: RTCSessionDescriptionInit) => {
      const seq = ++this.sent;
      const data = await seal(key, value, `${room}:${this.options.role}:${seq}`);
      if (!this.closed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ seq, data }));
    };
    socket.onmessage = event => {
      chain = chain.then(async () => {
        if (this.closed) return;
        if (typeof event.data !== 'string' || event.data.length > MAX_SIGNAL_SIZE) throw new Error('Invalid signaling message.');
        const message = JSON.parse(event.data);
        if (message.type === 'ready') {
          if (this.started) return;
          this.started = true;
          this.deadline();
          this.options.onStatus('Other device found. Establishing a private connection…');
          if (this.options.role === 'host') await send(await this.local('offer'));
        } else if (message.type === 'left') {
          if (!this.connected && !this.pc.remoteDescription) throw new Error('The other device left before connecting. Create a new invitation.');
        } else {
          if (!this.started || message.seq !== this.received + 1) throw new Error('Unexpected signaling message. Create a new invitation.');
          const remote = this.options.role === 'host' ? 'guest' : 'host';
          const value = await unseal(key, message.data, `${room}:${remote}:${message.seq}`);
          this.received = message.seq;
          await this.pc.setRemoteDescription(description(value, remote === 'host' ? 'offer' : 'answer'));
          if (this.options.role === 'guest') await send(await this.local('answer'));
        }
      }).catch(error => this.fail(new Error(`Could not authenticate the connection. ${error instanceof Error ? error.message : ''}`)));
    };
    socket.onclose = event => {
      if (!this.closed && !this.connected && !this.pc.remoteDescription) this.fail(new Error(event.code === 1008 ? 'This invitation expired or already has two devices. Ask for a new link.' : 'The signaling connection closed. Try again or use manual pairing.'));
    };
    socket.onerror = () => this.fail(new Error('Could not reach the signaling service. Try manual pairing in Connection options.'));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Signaling service unavailable. Use manual pairing.')), { once: true });
      socket.addEventListener('close', () => reject(new Error('Invitation unavailable. Create a new one.')), { once: true });
    });
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.close();
    this.options.onError(error);
  }

  close() {
    this.closed = true;
    this.onClose.abort();
    clearTimeout(this.timer);
    clearTimeout(this.disconnectTimer);
    this.socket?.close();
    this.pc.close();
  }
}

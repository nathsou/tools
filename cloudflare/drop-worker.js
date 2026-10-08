/** Cloudflare module Worker. No imports, packages, file storage, or file relay. */
const TTL = 10 * 60 * 1000;
const MAX_FRAME = 64 * 1024;
const secureHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/drop/api/config' && request.method === 'GET') {
      return Response.json({ protocol: 'drop-v1' }, { headers: secureHeaders });
    }
    const match = /^\/drop\/api\/room\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    if (match) {
      if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426, headers: secureHeaders });
      if (request.headers.get('Origin') !== url.origin) return new Response('Origin not allowed', { status: 403, headers: secureHeaders });
      if (!['host', 'guest'].includes(url.searchParams.get('role'))) return new Response('Invalid role', { status: 400, headers: secureHeaders });
      return env.DROP_ROOMS.get(env.DROP_ROOMS.idFromName(match[1])).fetch(request);
    }
    if (url.pathname.startsWith('/drop/api/')) return new Response('Not found', { status: 404, headers: secureHeaders });
    const response = await env.ASSETS.fetch(request);
    // Apply these headers only to Drop; preserve the other tools' policies.
    if (!url.pathname.startsWith('/drop/')) return response;
    const secured = new Response(response.body, response);
    for (const [name, value] of Object.entries(secureHeaders)) secured.headers.set(name, value);
    return secured;
  }
};

/** Rooms only persist expiry/used flags. Encrypted SDP is forwarded, never stored. */
export class DropRoom {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      let expires = await this.ctx.storage.get('expires');
      if (!expires) {
        expires = now + TTL;
        await this.ctx.storage.put('expires', expires);
        await this.ctx.storage.setAlarm(expires);
      }
      const role = new URL(request.url).searchParams.get('role');
      const peers = this.ctx.getWebSockets();
      if (now >= expires || await this.ctx.storage.get('used') || peers.length >= 2 || peers.some(peer => peer.deserializeAttachment().role === role)) {
        return new Response('Invitation expired or occupied', { status: 409 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ role, count: 0, bytes: 0 });
      this.ctx.acceptWebSocket(server);
      if (peers.length === 1) {
        await this.ctx.storage.put('used', true);
        server.send(JSON.stringify({ type: 'ready' }));
        peers[0].send(JSON.stringify({ type: 'ready' }));
      }
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  async webSocketMessage(socket, message) {
    const peers = this.ctx.getWebSockets();
    const attachment = socket.deserializeAttachment();
    const expires = await this.ctx.storage.get('expires');
    // Tight aggregate limits prevent using signaling as a general file relay.
    if (Date.now() >= expires || typeof message !== 'string' || message.length > MAX_FRAME || ++attachment.count > 4 || (attachment.bytes += message.length) > 128 * 1024) {
      for (const peer of peers) peer.close(1008, 'Signaling limit reached');
      return;
    }
    socket.serializeAttachment(attachment);
    try {
      const frame = JSON.parse(message);
      if (!Number.isSafeInteger(frame.seq) || frame.seq !== attachment.count || typeof frame.data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(frame.data)) throw new Error('Invalid frame');
      for (const peer of peers) if (peer !== socket) peer.send(JSON.stringify({ seq: frame.seq, data: frame.data }));
    } catch { for (const peer of peers) peer.close(1008, 'Invalid signaling frame'); }
  }

  async webSocketClose(socket) {
    socket.close(1000, 'Closed');
    for (const peer of this.ctx.getWebSockets()) if (peer !== socket) {
      try { peer.send(JSON.stringify({ type: 'left' })); } catch { /* Already closed. */ }
    }
  }
  async webSocketError(socket) { await this.webSocketClose(socket); }
  async alarm() {
    for (const peer of this.ctx.getWebSockets()) peer.close(1008, 'Invitation expired');
    // Retain a tombstone briefly to reject late joiners, then remove room metadata.
    if (!(await this.ctx.storage.get('expired'))) {
      await this.ctx.storage.put('expired', true);
      await this.ctx.storage.setAlarm(Date.now() + TTL);
    } else await this.ctx.storage.deleteAll();
  }
}

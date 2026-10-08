# Drop

Private, direct file sharing between two browsers at `/drop/`. Built with native WebRTC, Web Crypto, DOM and file APIs. Drop imports **no third-party runtime libraries**, adds no package dependencies, and contacts no third-party services by default. The repository's existing Vite/TypeScript tools build its frontend; Cloudflare's optional Worker provides signaling only.

## Use it

1. Open Drop on the sending computer. Choose or drop **one file** and select **Create invitation**.
2. Share the complete private invitation link with the other computer. Open it and select **Connect to sender**.
3. On static hosting, the receiver gets a **connection response**. Copy it back into the sender's tab and select **Complete connection**. Cloudflare hosting automates this exchange.
4. Select **Send file**. The receiver explicitly accepts or declines. On desktop browsers with a save picker, choose a destination to stream directly to disk; otherwise select **Save file** after receiving it.
5. Send more files over the same connection, or **Disconnect**. Keep both tabs open and devices awake until completion.

Invitations are valid while the sending tab waits, for up to ten minutes. Share them privately: possession authorizes a second browser to pair. Reloading discards the session. File offers expire after five minutes without acceptance; stalled transfers expire after 45 seconds. Transfer cancellation keeps the connection available for another file.

## Networking and browser support

- HTTPS or localhost is required. Use current Chrome, Edge, Firefox or Safari with WebRTC enabled.
- `iceServers` is empty by default. Start with two computers on the same Wi-Fi. Local network isolation, browser IP restrictions, VPNs and firewalls can prevent a direct connection even there.
- An optional **STUN URL** in Connection options can help across networks. Enter a server you operate or trust, on each device before connecting. There is no built-in public STUN provider. Its operator sees network metadata, not file contents. A normal Cloudflare Worker cannot host a UDP STUN server.
- **TURN is never configured**. If ICE cannot find a direct path, Drop reports the failure; there is no server file upload or relay fallback. Universal connectivity is incompatible with this constraint.
- Desktop Chromium's save picker supports files larger than memory. Other browsers receive at most **128 MiB per file** into memory and require a download click. The UI uses the familiar “128 MB” label for this binary limit.
- One sender and one receiver, one file at a time. No folders, resumable transfers, background transfers, nearby-device discovery, or automatic retry. A failed transfer must restart. Browser file pickers may enforce additional filename restrictions.
- A sender's “Delivered” message means the receiving browser acknowledged the complete file. In memory/download mode, the person may still need to click Save file.

## Development and static hosting

Use the existing repository toolchain:

```sh
mise exec -- bun install --frozen-lockfile
mise run dev
# http://localhost:5173/drop/
mise run check
mise run test
mise run build
```

Deploy `dist/` to any HTTPS static host, including Cloudflare Pages and GitHub Pages. Preserve the `/drop/` directory. Relative assets and invitation URLs support project subdirectories such as `/tools/drop/`.

The app probes its own `api/config` endpoint once. Without the optional backend, it uses manual pairing automatically. There is no external signaling service to configure, no CDN imports, no analytics and no Drop service worker. Crypte's offline worker excludes Drop's assets.

## Cloudflare automatic pairing

The optional module Worker in [`../cloudflare/drop-worker.js`](../cloudflare/drop-worker.js) serves the **same built site** with Workers Static Assets. Its Durable Object exchanges encrypted connection descriptions between two browsers. It does not receive, cache, upload or relay the selected file. Existing GitHub Pages deployment remains static/manual; this PR does not deploy a Cloudflare service.

Use the Cloudflare Wrangler CLI (deployment tooling, not an application dependency) with your account. Review pricing and account quotas for Workers/Durable Objects in that account.

```sh
mise run build
wrangler dev --config cloudflare/wrangler.toml
# Open http://localhost:8787/drop/ in both browsers.

# After testing, publish to your own Cloudflare account:
wrangler deploy --config cloudflare/wrangler.toml
```

The config creates the `DROP_ROOMS` SQLite Durable Object binding and hosts the entire `dist/` tree. Change `name` in `cloudflare/wrangler.toml` to your preferred Worker name. Automatic signaling expects `/drop/` at the origin root; static manual hosting also supports subdirectories. No API keys, databases for files, bucket storage, STUN credentials or runtime environment variables are needed.

Rooms admit only one host and one guest, disallow reuse after pairing, and expire after ten minutes. The Worker enforces same-origin WebSocket upgrades, frame and aggregate size limits, and a four-message limit per participant. Hibernating sockets do not require an in-process timer. Only expiry/used flags persist temporarily; an alarm closes sockets, then removes metadata after another ten minutes. Logging is disabled in the included Wrangler configuration. Cloudflare can still observe network and request metadata as the hosting provider. For an internet-facing deployment, configure appropriate account-level abuse controls; random room names do not prevent someone from creating many rooms.

## Protocol and trust boundaries

- Each invitation uses 32 random bytes from `crypto.getRandomValues`. The key lives in a URL **fragment**, which HTTP requests and referrers omit. The receiver clears it from the visible URL with `history.replaceState`; app code never persists it. Clipboard history, browser extensions and the messaging channel used to share it remain outside the app's control.
- HKDF-SHA-256 derives a public room identifier and a separate AES-256-GCM signaling key, with distinct labels. Each encrypted envelope has a fresh 96-bit nonce. Room, direction and message sequence are authenticated as additional data. Receivers reject unexpected sequences. SDP fingerprints are inside authenticated ciphertext, binding the WebRTC connection to the invitation.
- Manual invitations carry the encrypted gathered offer in the fragment. The returned answer is encrypted under a separate directional context. No signaling backend is required. Long invitation links can be awkward in some messengers; copy the complete link.
- Files and metadata travel through an ordered, reliable `RTCDataChannel`, protected by WebRTC DTLS. No application plaintext files cross the signaling service. Peers learn each other's network addresses.
- Transfer metadata is validated, filenames are sanitized, and incoming names use DOM text rather than HTML. Files use 16 KiB chunks with a 256 KiB acknowledgment window. Disk writes are awaited before acknowledging; the sink closes before the sender receives completion. Byte counts must match the declared size. There is no additional whole-file hash; transport integrity comes from DTLS/SCTP.
- Incomplete disk streams are aborted on cancellation or disconnection. Browser/OS behavior determines cleanup after a crash. Memory blobs are released on replacement or disconnect. Save a completed download before receiving another file.
- The frontend host is trusted. A host that serves modified JavaScript, a compromised browser, or a malicious peer with the invitation can compromise privacy. Authentication does not conceal IP addresses, traffic timing, or transfer size.

## Verification

```sh
mise run check
mise run test
mise run build
mise exec -- bunx playwright install chromium
mise exec -- bun run test:e2e tests/e2e/drop.spec.ts
```

The browser suite covers responsive light/dark layouts, invalid invitations, real manual WebRTC pairing, receiver consent, download bytes, repeated transfers, and tampered answers. Actual transfer tests explicitly skip when the browser exposes no direct ICE candidates (for example, a managed policy disabling non-proxied WebRTC). Unit tests still exercise chunking, exact bytes, zero-byte files, backpressure, cancellation, disk errors, limits and authenticated encryption.

To test the actual Cloudflare runtime, leave `wrangler dev --config cloudflare/wrangler.toml` running and run:

```sh
DROP_WORKER_URL=http://localhost:8787 mise exec -- bun run test:e2e tests/e2e/drop-worker.spec.ts
```

This checks the deployed-format assets/security headers, two-participant room admission, duplicate/third-device rejection, encrypted-frame forwarding and refusal to relay binary data. It does not require Cloudflare credentials or deploy anything.

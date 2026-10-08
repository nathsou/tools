import { Peer } from './peer';
import { Transfer, type Sink } from './transfer';
import { credentials, formatBytes, MEMORY_LIMIT, newSecret, stunServers, type FileOffer } from './protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, visible = true) => { $(id).hidden = !visible; };
const text = (id: string, value: string) => {
  const element = $(id);
  if (element.textContent !== value) element.textContent = value;
};
const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);
const panels = ['setup', 'invited', 'joining', 'connected'];
let file: File | undefined;
let peer: Peer | undefined;
let transfer: Transfer | undefined;
let role: 'host' | 'guest' = 'host';
let invitation: { secret: string; offer?: string } | undefined;
let backend = false;
let generation = 0;
let objectURL: string | undefined;
let started = 0;
let incoming: FileOffer | undefined;
const base = new URL('./', location.href);
base.hash = ''; base.search = '';
const endpoint = new URL('api', base);
const supported = isSecureContext && 'RTCPeerConnection' in window && !!crypto.subtle;
const picker = (window as typeof window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<Sink> }>;
}).showSaveFilePicker;

function status(message: string, label?: string) {
  text('connection-status', message);
  if (label) text('badge-label', label);
  $('status-badge').classList.toggle('live', label === 'Connected' || label === 'Transferring');
}
function error(value: unknown) {
  text('notice', value instanceof Error ? value.message : String(value));
  show('notice');
}
function panel(id: string) {
  for (const name of panels) show(name, name === id);
  show('reset', id !== 'setup');
}
function busyControls(busy: boolean) {
  button('send-file').disabled = busy;
  button('change-file').disabled = busy;
}
function clearDownload() {
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = undefined;
  $('download').removeAttribute('href');
  show('download', false);
}
function reset() {
  generation++;
  transfer?.dispose(); transfer = undefined;
  peer?.close(); peer = undefined;
  invitation = undefined; incoming = undefined;
  history.replaceState(null, '', base);
  clearDownload();
  for (const id of ['notice', 'result', 'transfer-progress', 'incoming', 'manual-response']) show(id, false);
  input('invitation').value = '';
  $<HTMLTextAreaElement>('response').value = '';
  $<HTMLTextAreaElement>('answer-input').value = '';
  for (const id of ['stun', 'manual']) input(id).disabled = false;
  busyControls(false);
  button('connect-answer').disabled = false;
  panel('setup');
  mode('host');
  status(backend ? 'Ready when you are. Files always travel directly.' : 'Static hosting detected. Manual pairing works here without a signaling server.', 'Not connected');
  text('reset', 'Cancel invitation');
}
function mode(next: 'host' | 'guest') {
  role = next;
  button('send-mode').setAttribute('aria-pressed', String(role === 'host'));
  button('receive-mode').setAttribute('aria-pressed', String(role === 'guest'));
  show('send-setup', role === 'host'); show('join-form', role === 'guest');
}
function selectFile(selected?: File) {
  if (!selected || transfer?.busy) return;
  file = selected;
  text('selection-name', selected.name);
  text('selection-detail', `${formatBytes(selected.size)} · Click to choose another file`);
  text('send-name', selected.name);
  text('send-size', formatBytes(selected.size));
  button('create').disabled = !supported;
  show('notice', false);
}
function makePeer(secret: string) {
  const current = generation;
  const iceServers = stunServers(input('stun').value);
  const created = new Peer({
    secret, role, iceServers,
    onStatus: message => { if (current === generation) status(message, 'Connecting'); },
    onError: value => {
      if (current !== generation) return;
      transfer?.dispose(); transfer = undefined;
      error(value); status('Create a fresh invitation to try again.', 'Disconnected');
      show('reset'); text('reset', 'Start again');
      busyControls(true);
    },
    onChannel: channel => {
      if (current !== generation) { channel.close(); return; }
      panel('connected');
      show('sender-controls', role === 'host');
      show('receiver-wait', role === 'guest');
      show('notice', false);
      status('Keep both tabs open and devices awake until the transfer finishes.', 'Connected');
      text('reset', 'Disconnect');
      transfer = new Transfer(channel, {
        offer: offer => {
          incoming = offer;
          show('receiver-wait', false); show('incoming');
          // Keep the previous download reachable until the next file is accepted.
          if (!objectURL) show('result', false);
          text('incoming-name', offer.name); text('incoming-size', formatBytes(offer.size));
          text('save-help', picker ? 'Choose where to save. The file will be written directly to disk.' : 'Your browser keeps this file in memory until you save it. Maximum: 128 MB.');
          button('accept-file').disabled = !picker && offer.size > MEMORY_LIMIT;
          text('accept-file', picker ? 'Save directly to disk' : 'Accept file');
          if (!picker && offer.size > MEMORY_LIMIT) text('save-help', 'This file exceeds the 128 MB memory limit. Decline it and use desktop Chrome or Edge to save directly to disk.');
          button('decline-file').focus();
        },
        progress: (bytes, total) => {
          show('transfer-progress');
          const percent = total ? Math.floor(bytes / total * 100) : 100;
          $<HTMLProgressElement>('progress').value = percent;
          text('progress-percent', `${percent}%`);
          text('progress-title', bytes === total ? 'Finishing up…' : role === 'host' ? 'Sending your file…' : 'Receiving your file…');
          const elapsed = Math.max((performance.now() - started) / 1000, 1);
          text('progress-detail', `${formatBytes(bytes)} of ${formatBytes(total)} · ${formatBytes(Math.round(bytes / elapsed))}/s`);
          status('Keep both tabs open until the file is saved.', 'Transferring');
        },
        complete: (offer, blob) => {
          show('transfer-progress', false); show('incoming', false); show('result');
          busyControls(false);
          clearDownload();
          if (blob) {
            objectURL = URL.createObjectURL(blob);
            const link = $<HTMLAnchorElement>('download'); link.href = objectURL; link.download = offer.name;
            show('download'); text('result-title', 'Your file is ready to save.');
            text('result-detail', `${offer.name} · ${formatBytes(offer.size)}. Save it before receiving another file or leaving this tab.`);
          } else {
            text('result-title', role === 'host' ? 'Delivered to the other browser.' : 'Saved to your device.');
            text('result-detail', `${offer.name} · ${formatBytes(offer.size)}${role === 'host' ? '. The receiver may still need to save their download.' : ''}`);
          }
          incoming = undefined;
          show('receiver-wait', role === 'guest');
          status('Connection is still open. You can send another file.', 'Connected');
        },
        stopped: message => {
          incoming = undefined;
          show('incoming', false); show('transfer-progress', false);
          show('receiver-wait', role === 'guest'); busyControls(false);
          status(message, 'Connected');
        }
      }, role);
    }
  });
  peer = created;
  for (const id of ['stun', 'manual']) input(id).disabled = true;
  return created;
}

async function create() {
  if (!file || !supported) return;
  show('notice', false);
  const current = ++generation;
  const secret = newSecret();
  const created = makePeer(secret);
  (document.querySelector('.options') as HTMLDetailsElement).open = false;
  panel('invited'); text('invite-title', 'Preparing your invitation…');
  button('copy-invite').disabled = true;
  show('answer-entry', false);
  status('Finding a direct route between your devices…', 'Preparing');
  const link = new URL(base);
  const params = new URLSearchParams({ v: '1', key: secret });
  const manual = input('manual').checked || !backend;
  try {
    if (manual) {
      params.set('offer', await created.manualOffer());
    } else await created.automatic(new URL(endpoint));
    if (current !== generation) return;
    link.hash = params.toString();
    input('invitation').value = link.href;
    button('copy-invite').disabled = false;
    text('invite-title', 'Invite your other device.');
    text('invite-help', manual ? 'Open this link in the other browser. Then paste its connection response below.' : 'Open this private link in the other browser. Keep this tab open.');
    show('answer-entry', manual);
    status(manual ? 'Manual pairing · Share the invitation, then bring back the response.' : 'Waiting for the other device to open your invitation…', 'Waiting');
  } catch (value) { if (current === generation) { created.close(); error(value); text('reset', 'Start again'); status('Could not create the invitation.', 'Disconnected'); } }
}

async function readInvitation(value: string) {
  const url = new URL(value);
  if (url.origin !== base.origin || url.pathname !== base.pathname || url.hash.length > 70_000) throw new Error('Use an invitation from this Drop address.');
  const params = new URLSearchParams(url.hash.slice(1));
  if (params.get('v') !== '1' || !params.get('key')) throw new Error('This invitation is invalid. Ask the sender to create a new one.');
  const secret = params.get('key')!;
  await credentials(secret);
  invitation = { secret, offer: params.get('offer') || undefined };
  role = 'guest';
  panel('joining');
  show('notice', false); show('manual-response', false); show('join-invitation');
  status('Only connect if you trust the person who shared this invitation.', 'Invitation ready');
  // Remove the secret from visible history once it has been read. Nothing is persisted.
  history.replaceState(null, '', base);
  $<HTMLTextAreaElement>('join-link').value = '';
}
async function join() {
  if (!invitation || !supported) return;
  const current = ++generation;
  const created = makePeer(invitation.secret);
  (document.querySelector('.options') as HTMLDetailsElement).open = false;
  button('join-invitation').disabled = true;
  status('Connecting to the sender…', 'Connecting');
  try {
    if (invitation.offer) {
      const answer = await created.manualAnswer(invitation.offer);
      if (current !== generation) return;
      $<HTMLTextAreaElement>('response').value = answer;
      show('manual-response'); show('join-invitation', false);
      status('Send the response back to the sender to finish pairing.', 'Waiting');
    } else {
      if (!backend) throw new Error('Automatic pairing is unavailable on this host. Ask the sender for a manual invitation.');
      await created.automatic(new URL(endpoint));
    }
  } catch (value) { if (current === generation) { created.close(); error(value); text('reset', 'Start again'); status('Could not connect.', 'Disconnected'); } }
  finally { button('join-invitation').disabled = false; }
}

async function copy(id: string, buttonId: string) {
  const element = $(id) as HTMLInputElement | HTMLTextAreaElement;
  try { await navigator.clipboard.writeText(element.value); const old = button(buttonId).textContent; text(buttonId, 'Copied!'); setTimeout(() => text(buttonId, old || 'Copy'), 2000); }
  catch { element.focus(); element.select(); status('The text is selected. Press Ctrl+C or ⌘C to copy it.'); }
}
function action(id: string, callback: () => void | Promise<void>) {
  button(id).addEventListener('click', () => { Promise.resolve().then(callback).catch(error); });
}
action('send-mode', () => mode('host'));
action('receive-mode', () => mode('guest'));
action('drop-zone', () => input('file-input').click());
action('change-file', () => input('file-input').click());
input('file-input').addEventListener('change', () => selectFile(input('file-input').files?.[0]));
const zone = $('drop-zone');
for (const name of ['dragenter', 'dragover']) zone.addEventListener(name, event => { event.preventDefault(); zone.classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) zone.addEventListener(name, event => { event.preventDefault(); zone.classList.remove('dragging'); });
zone.addEventListener('drop', event => {
  if (event.dataTransfer?.files.length !== 1) { error('Choose one file at a time. You can send another after it finishes.'); return; }
  selectFile(event.dataTransfer.files[0]);
});
// Prevent dropping files outside the target from navigating away and ending a transfer.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
action('create', create);
action('reset', reset);
action('copy-invite', () => copy('invitation', 'copy-invite'));
action('copy-response', () => copy('response', 'copy-response'));
action('join-invitation', join);
action('connect-answer', async () => {
  show('notice', false);
  try {
    await peer?.acceptAnswer($<HTMLTextAreaElement>('answer-input').value);
    button('connect-answer').disabled = true;
    status('Response accepted. Connecting directly…', 'Connecting');
  }
  catch { throw new Error('That response could not be authenticated. Copy the complete response from the other device and try again.'); }
});
$('join-form').addEventListener('submit', event => { event.preventDefault(); readInvitation($<HTMLTextAreaElement>('join-link').value.trim()).catch(() => error('This invitation is invalid or belongs to a different Drop address.')); });
action('send-file', async () => {
  if (!file || !transfer) return;
  const current = generation;
  show('notice', false); show('result', false); show('transfer-progress');
  busyControls(true); started = performance.now();
  text('progress-title', 'Waiting for acceptance…'); text('progress-percent', '0%');
  $<HTMLProgressElement>('progress').value = 0;
  text('progress-detail', 'The other device must approve this file.');
  try { await transfer.send(file); } catch (value) { if (current === generation) error(value); }
});
action('accept-file', async () => {
  const current = transfer;
  const offer = incoming;
  if (!current || !offer) return;
  button('accept-file').disabled = true;
  try {
    let sink: Sink | undefined;
    if (picker) sink = await (await picker.call(window, { suggestedName: offer.name })).createWritable();
    if (current !== transfer || offer !== incoming) { await sink?.abort(); return; }
    await current.accept(sink);
    clearDownload(); show('result', false);
    started = performance.now();
    show('incoming', false); show('transfer-progress');
  } catch (value) {
    if (!(value instanceof DOMException && value.name === 'AbortError')) error(value);
  } finally { button('accept-file').disabled = false; }
});
action('decline-file', () => transfer?.cancel('File declined. Nothing was received.'));
action('cancel-transfer', () => transfer?.cancel());
window.addEventListener('beforeunload', event => { if (transfer?.busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { transfer?.dispose(); peer?.close(); clearDownload(); });
window.addEventListener('pageshow', event => { if (event.persisted) reset(); });
window.addEventListener('hashchange', () => {
  if (!location.hash) return;
  const next = location.href;
  reset();
  readInvitation(next).catch(() => error('This invitation is invalid. Ask for a new link.'));
});

async function boot() {
  // Shared options stay reachable for an invitation opened on a different network.
  const options = document.querySelector('.options')!;
  $('connection-status').before(options);
  if (!supported) {
    error('Drop needs HTTPS (or localhost) and a browser with WebRTC and Web Crypto. Try a current version of Chrome, Edge, Firefox, or Safari.');
    for (const id of ['create', 'join-invitation', 'receive-mode']) button(id).disabled = true;
    status('This browser cannot make a secure connection.', 'Unavailable');
    return;
  }
  const fragment = location.hash;
  // Clear the fragment before making any request or reporting an invalid invitation.
  if (fragment) history.replaceState(null, '', base);
  try {
    const response = await fetch(new URL('api/config', base), { signal: AbortSignal.timeout(3000), cache: 'no-store', credentials: 'omit', redirect: 'error' });
    backend = response.ok && response.headers.get('content-type')?.includes('application/json') === true && (await response.json()).protocol === 'drop-v1';
  } catch { backend = false; }
  input('manual').checked = !backend;
  status(backend ? 'Ready when you are. Files always travel directly.' : 'Static hosting detected. Manual pairing works here without a signaling server.');
  if (fragment) await readInvitation(new URL(fragment, base).href);
}
boot().catch(() => { error('This invitation is invalid. Ask for a new link.'); status('Ready for a new invitation.'); });

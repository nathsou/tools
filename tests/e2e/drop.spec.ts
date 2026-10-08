import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function disableDiscovery(page: Page) {
  await page.getByText('Connection options', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Find a direct route with STUN' }).uncheck();
}

async function requireDirectNetworking(page: Page) {
  await page.goto('/drop/');
  const available = await page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    try {
      pc.createDataChannel('probe');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>(resolve => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const timeout = setTimeout(resolve, 3000);
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); } };
      });
      return pc.localDescription?.sdp.includes('a=candidate:') ?? false;
    } finally { pc.close(); }
  });
  if (process.env.CI) expect(available, 'CI must expose direct ICE candidates to validate real transfers').toBe(true);
  test.skip(!available, 'This browser/environment exposes no direct ICE candidates (for example, managed WebRtcIPHandling policy).');
}

async function pair(sender: Page, receiver: Page, file = { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('A private file, straight between two browsers.\n') }) {
  await sender.goto('/drop/');
  // Keep ordinary transfer tests local and independent of a public STUN service.
  await disableDiscovery(sender);
  await sender.getByLabel('Choose a file', { exact: true }).setInputFiles(file);
  await sender.getByRole('button', { name: 'Create invitation' }).click();
  const link = sender.getByLabel('Private invitation link');
  await expect(link).not.toHaveValue('');
  const invitation = await link.inputValue();
  expect(invitation).toContain('#v=1&key=');
  await receiver.goto(invitation);
  await disableDiscovery(receiver);
  await receiver.getByRole('button', { name: 'Connect to sender' }).click();
  const response = receiver.getByLabel('Your connection response');
  await expect(response).not.toHaveValue('');
  await sender.getByLabel('Response from the other device').fill(await response.inputValue());
  await sender.getByRole('button', { name: 'Complete connection' }).click();
  await expect(sender.getByRole('heading', { name: 'You’re connected.' })).toBeVisible();
  await expect(receiver.getByRole('heading', { name: 'You’re connected.' })).toBeVisible();
}

test('manual pairing transfers real bytes, requires consent, and supports repeated files', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }));
  const sender = await context.newPage(), receiver = await context.newPage();
  const requests: string[] = [], errors: string[] = [];
  context.on('request', request => requests.push(request.url()));
  sender.on('pageerror', error => errors.push(error.message)); receiver.on('pageerror', error => errors.push(error.message));
  try {
    await requireDirectNetworking(sender);
    await pair(sender, receiver);
    await sender.getByRole('button', { name: 'Send file', exact: true }).click();
    await expect(receiver.getByText('INCOMING FILE', { exact: true })).toBeVisible();
    await expect(sender.getByText('Waiting for acceptance…', { exact: true })).toBeVisible();
    await expect(receiver.getByRole('link', { name: 'Save file', exact: true })).not.toBeVisible();
    await receiver.getByRole('button', { name: 'Accept file', exact: true }).click();
    await expect(sender.getByText('Delivered to the other browser.')).toBeVisible();
    const downloadEvent = receiver.waitForEvent('download');
    await receiver.getByRole('link', { name: 'Save file', exact: true }).click();
    const download = await downloadEvent;
    expect(await readFile((await download.path())!, 'utf8')).toBe('A private file, straight between two browsers.\n');
    // Decline, then send a multi-window binary file over the same connection.
    await sender.getByRole('button', { name: 'Send file', exact: true }).click();
    await receiver.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(sender.getByRole('alert')).toContainText('cancelled');
    const bytes = Buffer.from(Array.from({ length: 600_013 }, (_, i) => i % 251));
    await sender.getByLabel('Choose a file', { exact: true }).setInputFiles({ name: 'binary.dat', mimeType: 'application/octet-stream', buffer: bytes });
    await sender.getByRole('button', { name: 'Send file', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept file', exact: true }).click();
    await expect(sender.getByText('Delivered to the other browser.')).toBeVisible();
    const secondEvent = receiver.waitForEvent('download');
    await receiver.getByRole('link', { name: 'Save file', exact: true }).click();
    expect(await readFile((await (await secondEvent).path())!)).toEqual(bytes);
    expect(errors).toEqual([]);
    expect(requests.every(url => !url.includes('key=') && !url.includes('offer='))).toBe(true);
    expect(requests.every(url => new URL(url).hostname === 'localhost' || url.startsWith('blob:'))).toBe(true);
  } finally { await context.close(); }
});

test('mobile and dark layouts, keyboard flow, and invalid invitations', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Open Drop', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make a connection.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create invitation' })).toBeDisabled();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
  await page.getByRole('button', { name: 'Receive a file' }).click();
  await page.getByLabel('Invitation link', { exact: true }).fill('https://evil.example/#key=bad');
  await page.getByRole('button', { name: 'Join connection' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid');
  await page.goto('/drop/#v=1&key=invalid');
  await expect(page.getByRole('alert')).toContainText('invalid');
  await expect.poll(() => new URL(page.url()).hash).toBe('');
});

test('discovery defaults work for either role, allow overrides, and stay off when disabled', async ({ browser }) => {
  const context = await browser.newContext();
  // Observe the actual Peer configuration without relying on public UDP services in CI.
  await context.addInitScript(() => {
    const NativePC = window.RTCPeerConnection;
    const configurations: RTCConfiguration[] = [];
    (window as any).dropConfigurations = configurations;
    window.RTCPeerConnection = class extends NativePC {
      constructor(configuration: RTCConfiguration = {}) {
        configurations.push(configuration);
        super({ ...configuration, iceServers: [] });
      }
    };
  });
  const sender = await context.newPage(), receiver = await context.newPage();
  const configuredServers = (page: Page) => page.evaluate(() => (window as any).dropConfigurations.at(-1).iceServers);
  try {
    await requireDirectNetworking(sender);
    await sender.getByLabel('Choose a file', { exact: true }).setInputFiles({ name: 'routes.txt', mimeType: 'text/plain', buffer: Buffer.from('Discovery regression') });
    await expect(sender.getByText('Network discovery uses Google STUN. Files travel directly between devices.')).toBeVisible();
    await sender.getByRole('button', { name: 'Create invitation' }).click();
    await expect(sender.getByLabel('Private invitation link')).not.toHaveValue('');
    const invitation = await sender.getByLabel('Private invitation link').inputValue();
    expect(await configuredServers(sender)).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    await receiver.goto(invitation);
    await receiver.getByRole('button', { name: 'Connect to sender' }).click();
    await expect(receiver.getByLabel('Your connection response')).not.toHaveValue('');
    expect(await configuredServers(receiver)).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);

    await sender.getByRole('button', { name: 'Cancel invitation', exact: true }).click();
    await sender.getByText('Connection options', { exact: true }).click();
    const discovery = sender.getByRole('checkbox', { name: 'Find a direct route with STUN' });
    const custom = sender.getByLabel('Custom STUN server', { exact: false });
    await custom.fill('stun:my-server.example:3478');
    await sender.getByRole('button', { name: 'Create invitation' }).click();
    await expect(sender.getByLabel('Private invitation link')).not.toHaveValue('');
    expect(await configuredServers(sender)).toEqual([{ urls: 'stun:my-server.example:3478' }]);
    await sender.getByText('Connection options', { exact: true }).click();
    await expect(discovery).toBeDisabled();
    await expect(custom).toBeDisabled();
    await sender.getByRole('button', { name: 'Cancel invitation', exact: true }).click();
    await expect(discovery).toBeEnabled();
    await custom.fill('turn:relay.example');
    await sender.getByRole('button', { name: 'Create invitation' }).click();
    await expect(sender.getByRole('alert')).toContainText('TURN relays are not supported');
    await discovery.uncheck();
    await expect(custom).toBeDisabled();
    await sender.getByRole('button', { name: 'Create invitation' }).click();
    await expect(sender.getByLabel('Private invitation link')).not.toHaveValue('');
    expect(await configuredServers(sender)).toEqual([]);
    await sender.getByRole('button', { name: 'Cancel invitation', exact: true }).click();
    await sender.getByText('Connection options', { exact: true }).click();
    await expect(discovery).not.toBeChecked();
    await expect(custom).toBeDisabled();
  } finally { await context.close(); }
});

test('tampered manual response is rejected without replacing the connection', async ({ browser }) => {
  const context = await browser.newContext();
  const sender = await context.newPage(), receiver = await context.newPage();
  try {
    await requireDirectNetworking(sender);
    await sender.goto('/drop/');
    await disableDiscovery(sender);
    await sender.getByLabel('Choose a file', { exact: true }).setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
    await sender.getByRole('button', { name: 'Create invitation' }).click();
    await expect(sender.getByLabel('Private invitation link')).not.toHaveValue('');
    await receiver.goto(await sender.getByLabel('Private invitation link').inputValue());
    await disableDiscovery(receiver);
    await receiver.getByRole('button', { name: 'Connect to sender' }).click();
    await expect(receiver.getByLabel('Your connection response')).not.toHaveValue('');
    await sender.getByLabel('Response from the other device').fill('not-the-response');
    await sender.getByRole('button', { name: 'Complete connection' }).click();
    await expect(sender.getByRole('alert')).toContainText('could not be authenticated');
    await sender.getByLabel('Response from the other device').fill(await receiver.getByLabel('Your connection response').inputValue());
    await sender.getByRole('button', { name: 'Complete connection' }).click();
    await expect(sender.getByRole('heading', { name: 'You’re connected.' })).toBeVisible();
    await expect(receiver.getByRole('heading', { name: 'You’re connected.' })).toBeVisible();
    await sender.getByRole('button', { name: 'Disconnect', exact: true }).click();
    // Native SCTP teardown can report either error or close first.
    await expect(receiver.getByRole('alert')).toBeVisible();
    await expect(receiver.locator('#badge-label')).toHaveText('Disconnected');
    await expect(receiver.getByRole('button', { name: 'Start again', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

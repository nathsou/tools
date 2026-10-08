import { expect, test } from '@playwright/test';

const workerURL = process.env.DROP_WORKER_URL;
test.describe('Drop Worker integration', () => {
  test.skip(!workerURL, 'Set DROP_WORKER_URL to a running local Wrangler server.');
  test('serves hardened assets and enforces two participants with bounded encrypted signaling', async ({ page, request }) => {
    await page.goto(`${workerURL}/drop/`);
    await expect(page.getByRole('status').first()).toContainText('Ready when you are');
    const response = await request.get(`${workerURL}/drop/`);
    expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
    expect(response.headers()['cache-control']).toBe('no-store');
    const result = await page.evaluate(async () => {
      const room = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      const url = `${location.origin.replace('http', 'ws')}/drop/api/room/${room}`;
      const host = new WebSocket(`${url}?role=host`);
      const wait = (socket: WebSocket, event: string) => new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 5000);
        socket.addEventListener(event, value => { clearTimeout(timeout); resolve(value); }, { once: true });
      });
      try {
        await wait(host, 'open');
        const duplicate = new WebSocket(`${url}?role=host`);
        const duplicateResult = await wait(duplicate, 'close');
        const hostReady = wait(host, 'message');
        const guest = new WebSocket(`${url}?role=guest`);
        try {
          const guestReady = wait(guest, 'message');
          await wait(guest, 'open');
          const ready = [JSON.parse((await hostReady).data), JSON.parse((await guestReady).data)];
          const forwarded = wait(guest, 'message');
          host.send(JSON.stringify({ seq: 1, data: 'opaque_authenticated_ciphertext' }));
          const frame = JSON.parse((await forwarded).data);
          const third = new WebSocket(`${url}?role=guest`);
          const thirdResult = await wait(third, 'close');
          const hostClosed = wait(host, 'close'), guestClosed = wait(guest, 'close');
          host.send(new Uint8Array([1, 2, 3]));
          const closed = [(await hostClosed).code, (await guestClosed).code];
          return { ready, frame, duplicateCode: duplicateResult.code, thirdCode: thirdResult.code, closed };
        } finally { guest.close(); }
      } finally { host.close(); }
    });
    expect(result.ready).toEqual([{ type: 'ready' }, { type: 'ready' }]);
    expect(result.frame).toEqual({ seq: 1, data: 'opaque_authenticated_ciphertext' });
    expect(result.duplicateCode).toBe(1006);
    expect(result.thirdCode).toBe(1006);
    expect(result.closed).toEqual([1008, 1008]);
  });
});

import { expect, test } from '@playwright/test';
import { installReadOnlySocketProbe } from './spectatorSocketRead';

export function registerSpectatorSocketProbeCase() {
  test('the synthetic refusal probe uses the routed browser socket', async ({ browser }) => {
    const context = await browser.newContext();
    let synthetic = false;
    let natural = 0;
    let refused = 0;
    try {
      await context.route('http://socket-probe.test/', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' })
      );
      await context.routeWebSocket('wss://engine.smarter.poker/ws/multi', (client) => {
        // Fully local routing: no connection or packet ever reaches an engine.
        client.onMessage(() => {
          if (synthetic) refused++;
          else {
            natural++;
            client.send('observed');
          }
        });
      });
      const page = await context.newPage();
      await page.goto('http://socket-probe.test/');
      await page.evaluate(installReadOnlySocketProbe, 'engine.smarter.poker');
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const socket = new WebSocket('wss://engine.smarter.poker/ws/multi');
            socket.onopen = () => socket.send(JSON.stringify({ type: 'SUBSCRIBE' }));
            socket.onmessage = () => resolve();
          })
      );
      expect(natural).toBe(1);
      synthetic = true;
      const routedPeers = await page.evaluate(() =>
        (window as unknown as { __a14ReadOnlySocketProbe: () => number }).__a14ReadOnlySocketProbe()
      );
      expect(routedPeers).toBe(1);
      await expect.poll(() => refused).toBe(1);
      expect(natural).toBe(1);
    } finally {
      await context.close();
    }
  });
}

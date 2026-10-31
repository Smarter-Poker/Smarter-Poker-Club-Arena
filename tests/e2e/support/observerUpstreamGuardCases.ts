import { createServer } from 'node:http';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { test, expect } from '@playwright/test';
import { requestObserverForegroundProbe } from './spectatorSocketRead';

/** Real browser, real EngineChannelClient and real local WebSocket transport only. */
export function registerObserverUpstreamGuardCases(): void {
  test('the observer foreground control traverses the routed application socket', async ({
    page,
    context,
  }) => {
    const bundle = await build({
      stdin: {
        contents: `import {EngineChannelClient} from './src/services/EngineStateClient';
          const client=new EngineChannelClient({baseUrl:location.origin,getToken:async()=> 'isolated-fixture'});
          window.fixtureClient=client;client.send({type:'JOIN_LOBBY'});`,
        resolveDir: process.cwd(),
        sourcefile: 'observer-upstream-fixture.ts',
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      define: { 'import.meta.env': '{}' },
      logLevel: 'silent',
    });
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<script>${bundle.outputFiles[0].text}</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const sockets = new WebSocketServer({ server });
    const physicalTypes: string[] = [];
    sockets.on('connection', (socket) => {
      socket.on('message', (bytes) => {
        const type = String(JSON.parse(String(bytes)).type);
        physicalTypes.push(type);
        if (type === 'CHANNEL_PING') socket.send(JSON.stringify({ type: 'CHANNEL_PONG' }));
        if (type === 'JOIN_LOBBY')
          socket.send(
            JSON.stringify({
              type: 'LOBBY_UPDATE',
              payload: { clubOnlineCounts: {}, ts: Date.now() },
            })
          );
      });
    });
    let guarded = false;
    const refusedTypes: string[] = [];
    let refusedHttp = 0;
    try {
      // Reproduce the old init order: this captures Playwright's NATIVE backing
      // socket, not the application-facing routed socket. It is loopback only.
      await context.addInitScript(() => {
        const send = WebSocket.prototype.send;
        const captured: { socket?: WebSocket } = {};
        WebSocket.prototype.send = function (data) {
          if (this.url.startsWith('ws://127.0.0.1:')) captured.socket = this;
          return send.call(this, data);
        };
        Object.defineProperty(window, '__oldObserverProbe', {
          value: () => {
            if (!captured.socket) throw new Error('No native fixture socket');
            captured.socket.send(JSON.stringify({ type: 'PING' }));
          },
        });
      });
      await context.route('**/*', async (route) => {
        const request = route.request();
        if (guarded && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
          refusedHttp++;
          await route.abort('blockedbyclient');
        } else if (new URL(request.url()).origin !== origin) {
          await route.abort('blockedbyclient');
        } else await route.continue();
      });
      await context.routeWebSocket(
        () => true,
        (client) => {
          if (new URL(client.url()).host !== `127.0.0.1:${port}`) {
            client.close();
            return;
          }
          const remote = client.connectToServer();
          remote.onMessage((message) => {
            if (!guarded) client.send(message);
          });
          client.onMessage((message) => {
            if (guarded) {
              refusedTypes.push(String(JSON.parse(String(message)).type));
              return;
            }
            remote.send(message);
          });
        }
      );
      await page.goto(origin);
      await expect.poll(() => physicalTypes.includes('JOIN_LOBBY')).toBe(true);
      await page.waitForFunction(
        () =>
          (
            window as unknown as { fixtureClient: { getStatus(): string } }
          ).fixtureClient.getStatus() === 'connected'
      );
      guarded = true;
      await page.evaluate(() =>
        (window as unknown as { __oldObserverProbe(): void }).__oldObserverProbe()
      );
      await expect.poll(() => physicalTypes.filter((type) => type === 'PING').length).toBe(1);
      expect(refusedTypes).toEqual([]);

      const before = physicalTypes.length;
      await page.evaluate(requestObserverForegroundProbe);
      await expect.poll(() => refusedTypes).toContain('CHANNEL_PING');
      await expect.poll(() => refusedTypes).toContain('JOIN_LOBBY');
      await page.evaluate(async () => {
        await fetch('/local-refusal-control', { method: 'POST', body: 'ui-only' }).catch(
          () => undefined
        );
      });
      expect(refusedHttp).toBe(1);
      expect(physicalTypes.length).toBe(before);
      // Close while the guards still hold: no synthetic client state resumes.
      await context.close();
      expect(guarded).toBe(true);
      expect(physicalTypes.length).toBe(before);
    } finally {
      await context.close();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

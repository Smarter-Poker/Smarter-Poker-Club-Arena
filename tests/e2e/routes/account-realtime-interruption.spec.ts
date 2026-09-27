import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { build } from 'esbuild';
import { installAccountRealtimeInterruption } from '../support/accountRealtimeInterruption';
import { observeAccountRealtime } from '../support/accountRealtimeObservation';

test('an existing account socket really closes and the SDK rejoins after the reserved interruption', async ({
  browser,
}) => {
  const bundle = await build({
    stdin: {
      contents: `import { createClient } from '@supabase/supabase-js';
        const client = createClient(location.origin, 'local-public-fixture', {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          realtime: { heartbeatIntervalMs: 100, reconnectAfterMs: () => 50 }
        });
        globalThis.accountTestClient = client;
        client.channel('global_db_sync:reserved').on('postgres_changes', {
          event:'*',schema:'public',table:'club_members',filter:'user_id=eq.reserved'
        }, () => {}).subscribe();`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
  });
  const server = createServer((request, response) => {
    response.setHeader(
      'Content-Type',
      request.url === '/client.js' ? 'text/javascript' : 'text/html'
    );
    response.end(
      request.url === '/client.js'
        ? bundle.outputFiles[0].text
        : '<script src="/client.js"></script>'
    );
  });
  const sockets = new WebSocketServer({ server, path: '/realtime/v1/websocket' });
  let joins = 0;
  sockets.on('connection', (socket) => {
    socket.on('message', (message) => {
      const frame = JSON.parse(String(message));
      const array = Array.isArray(frame);
      const topic = array ? frame[2] : frame.topic;
      const event = array ? frame[3] : frame.event;
      const ref = array ? frame[1] : frame.ref;
      if (event === 'phx_join') joins++;
      const payload = {
        status: 'ok',
        response:
          event === 'phx_join'
            ? {
                postgres_changes: [
                  {
                    id: 1,
                    event: '*',
                    schema: 'public',
                    table: 'club_members',
                    filter: 'user_id=eq.reserved',
                  },
                ],
              }
            : {},
      };
      socket.send(
        JSON.stringify(
          array
            ? [frame[0], ref, topic, 'phx_reply', payload]
            : { ref, topic, event: 'phx_reply', payload }
        )
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The local transport did not bind.');
  const origin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const interrupt = await installAccountRealtimeInterruption(context, origin);
    await expect(interrupt()).rejects.toThrow(
      'No reserved account Realtime transport was observed.'
    );
    const page = await context.newPage();
    const observation = observeAccountRealtime(page, 'reserved', 'unused');
    await page.goto(origin);
    await expect.poll(() => observation.membershipSubscriptions).toBe(1);
    const initialJoins = joins;
    await context.setOffline(true);
    // Counterexample: HTTP fails offline, while the SDK's established socket
    // remains open. The interruption must close it before a rejoin is claimed.
    const offline = await page.evaluate(async () => ({
      fetchFailed: await fetch('/offline-check').then(
        () => false,
        () => true
      ),
      connection: (
        globalThis as unknown as { accountTestClient: { realtime: { connectionState(): string } } }
      ).accountTestClient.realtime.connectionState(),
    }));
    expect(offline).toEqual({ fetchFailed: true, connection: 'open' });
    expect(observation.socketCloses).toBe(0);
    await context.setOffline(false);
    await interrupt();
    await expect.poll(() => observation.socketCloses).toBeGreaterThan(0);
    await expect.poll(() => joins).toBeGreaterThan(initialJoins);
    await expect.poll(() => observation.membershipSubscriptions).toBeGreaterThan(1);
  } finally {
    await context.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      sockets.close((error) => (error ? reject(error) : resolve()))
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

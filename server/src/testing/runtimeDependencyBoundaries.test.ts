import { execFile } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { defaultTextMapGetter, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { W3CBaggagePropagator } from '@opentelemetry/core';
import { v3, v5, v6 } from 'uuid';
import { WebSocket, WebSocketServer, type ServerOptions } from 'ws';
import { describe, expect, it } from 'vitest';

// These are real installed parsers and loopback sockets. Small limits exercise
// rejection without allocating an attack-sized message. Application protocol,
// authentication and rate-limit behavior remain covered by the transport suite.
async function withSocket(
  options: ServerOptions & { maxFragments?: number },
  run: (client: WebSocket, peer: WebSocket, server: WebSocketServer) => Promise<void>
): Promise<void> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    const [peer] = (await accepted) as [WebSocket];
    await once(client, 'open');
    await run(client, peer, server);
  } finally {
    client.terminate();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

describe('runtime dependency input boundaries', () => {
  it('keeps normal fragmented JSON intact and enables finite fragment/chunk limits by default', async () => {
    await withSocket({}, async (client, peer, server) => {
      const options = server.options as ServerOptions & {
        maxFragments: number;
        maxBufferedChunks: number;
      };
      expect(options.maxFragments).toBe(128 * 1024);
      expect(options.maxBufferedChunks).toBe(1024 * 1024);
      const received = once(peer, 'message');
      client.send('{"type":', { fin: false });
      client.send('"ping"}', { fin: true });
      const [data, binary] = await received;
      expect(binary).toBe(false);
      expect(JSON.parse(data.toString())).toEqual({ type: 'ping' });
    });
  });

  it('closes an excess-fragment message before delivering it to an application handler', async () => {
    await withSocket({ maxFragments: 4 }, async (client, peer) => {
      let delivered = false;
      peer.on('message', () => {
        delivered = true;
      });
      const rejected = once(peer, 'error');
      const closed = once(client, 'close');
      for (let index = 0; index < 5; index++) client.send('x', { fin: false });
      const [error] = await rejected;
      expect(error.code).toBe('WS_ERR_TOO_MANY_BUFFERED_PARTS');
      expect((await closed)[0]).toBe(1008);
      expect(delivered).toBe(false);
    });
  });

  it('rejects a multi-byte close reason and sends only the valid byte view', async () => {
    await withSocket({}, async (_client, peer) => {
      // The patch refuses multi-byte views instead of allocating from their
      // element count. Bypass static typing only to exercise that rejection.
      expect(() => peer.close(1000, new Float32Array(20) as unknown as Buffer)).toThrow(TypeError);
    });
    // close() has already entered CLOSING when validation throws. Valid close
    // behavior uses its own fresh connection, as every application call does.
    await withSocket({}, async (client, peer) => {
      const closed = once(client, 'close');
      const backing = Buffer.from('outside:auth:session_not_found:outside');
      peer.close(4401, backing.subarray(8, 30));
      const [code, reason] = await closed;
      expect(code).toBe(4401);
      expect(reason.toString()).toBe('auth:session_not_found');
    });
  });

  for (const [name, create] of [
    ['v3', (buffer: Uint8Array, offset: number) => v3('receipt', v3.URL, buffer, offset)],
    ['v5', (buffer: Uint8Array, offset: number) => v5('receipt', v5.URL, buffer, offset)],
    ['v6', (buffer: Uint8Array, offset: number) => v6({}, buffer, offset)],
  ] as const) {
    it(`${name} rejects truncated or out-of-bounds output without modifying the buffer`, () => {
      for (const [size, offset] of [
        [15, 0],
        [16, 1],
        [16, -1],
      ]) {
        const buffer = new Uint8Array(size).fill(0xa5);
        expect(() => create(buffer, offset)).toThrow(RangeError);
        expect(buffer).toEqual(new Uint8Array(size).fill(0xa5));
      }
      const buffer = new Uint8Array(18).fill(0xa5);
      expect(create(buffer, 1)).toBe(buffer);
      expect(buffer[0]).toBe(0xa5);
      expect(buffer[17]).toBe(0xa5);
    });
  }

  it('retains the RFC v5 string identity used by retry-safe financial receipts', () => {
    // RFC 9562 Appendix A.4: upgrading cannot change already-issued names.
    expect(v5('www.example.com', v5.DNS)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    // Golden outputs from the previous locked uuid 13.0.0, using both real
    // engine name formats. Existing transaction identity must survive upgrade.
    expect(v5('horse-rebuy:table-1:user-1:42', v5.URL)).toBe(
      '796e1bf1-2eb2-5e60-9285-6e465af1944c'
    );
    expect(v5(JSON.stringify(['club-arena.rabbit-hunt.v1', 'table-1', 42, 'user-1']), v5.URL)).toBe(
      '448754f4-3b20-5e24-a217-fffdb73e5be6'
    );
  });

  it('preserves ordinary baggage and caps aggregate entry count across repeated headers', () => {
    const parser = new W3CBaggagePropagator();
    const extract = (baggage: string | string[]) =>
      propagation.getBaggage(parser.extract(ROOT_CONTEXT, { baggage }, defaultTextMapGetter));
    expect(extract('table=alpha,region=us')?.getEntry('table')?.value).toBe('alpha');
    const headers = Array.from({ length: 3 }, (_, group) =>
      Array.from({ length: 100 }, (_, index) => `k${group * 100 + index}=v`).join(',')
    );
    const entries = extract(headers)?.getAllEntries() ?? [];
    expect(entries).toHaveLength(180);
    expect(entries.at(-1)?.[0]).toBe('k179');
  });

  it('bounds individual and total incoming baggage while keeping valid entries', () => {
    const parser = new W3CBaggagePropagator();
    const extract = (baggage: string) =>
      propagation.getBaggage(parser.extract(ROOT_CONTEXT, { baggage }, defaultTextMapGetter));
    const oversized = extract(`huge=${'x'.repeat(4096)},table=alpha`);
    expect(oversized?.getEntry('huge')).toBeUndefined();
    expect(oversized?.getEntry('table')?.value).toBe('alpha');
    const entries =
      extract(
        Array.from({ length: 12 }, (_, index) => `k${index}=${'x'.repeat(1000)}`).join(',')
      )?.getAllEntries() ?? [];
    expect(entries).toHaveLength(8);
    expect(
      entries.map(([key, value]) => `${key}=${value.value}`).join(',').length
    ).toBeLessThanOrEqual(8192);
  });

  it('initializes the real Sentry SDK and flushes an error through an offline transport', async () => {
    // A separate process contains global instrumentation and exception hooks.
    // The explicit transport sends no network requests or production events.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import * as Sentry from '@sentry/node';
      const envelopes = [];
      Sentry.init({
        dsn: 'https://public@example.invalid/1',
        environment: 'dependency-test',
        tracesSampleRate: 0.2,
        integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration()],
        transport: () => ({
          send: async envelope => { envelopes.push(envelope); return {statusCode: 200}; },
          flush: async () => true,
        }),
      });
      Sentry.captureException(new Error('offline dependency compatibility'), {
        tags: {server: 'game-engine'},
      });
      const flushed = await Sentry.flush(2000);
      await Sentry.close(2000);
      const events = envelopes.flatMap(envelope => envelope[1])
        .filter(item => item[0].type === 'event').map(item => item[1]);
      console.log(JSON.stringify({flushed, events: events.map(event => ({
        message: event.exception?.values?.[0]?.value, server: event.tags?.server,
      }))}));
    `,
      ],
      { cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: 'test' }, timeout: 5000 }
    );
    expect(JSON.parse(stdout.trim())).toEqual({
      flushed: true,
      events: [{ message: 'offline dependency compatibility', server: 'game-engine' }],
    });
  });
});

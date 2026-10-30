import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import {
  createPrivateRecordGatewayHealthHandler,
  gatewayListenTarget,
} from './privateRecordGatewayRuntime.js';

describe('gateway health HTTP routing', () => {
  it('serves cache-busted health with current source state and preserves unrelated 404s', async () => {
    const revision = 'a'.repeat(40);
    let sourceReady = true;
    const server = createServer(
      createPrivateRecordGatewayHealthHandler(revision, () => ({
        sourceReady,
        sourcePhase: sourceReady ? 'connecting' : 'unavailable',
      }))
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
      const base = `http://127.0.0.1:${address.port}`;
      for (const path of ['/health', '/health?proof=current-revision', '/health?audit=readback']) {
        const response = await fetch(base + path, { signal: AbortSignal.timeout(2000) });
        expect(response.status, path).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({
          service: 'private-record-gateway',
          revision,
          processReachable: true,
          sourceReady: true,
          sourcePhase: 'connecting',
        });
      }
      sourceReady = false;
      const unavailable = await fetch(`${base}/health?proof=source-loss`, {
        signal: AbortSignal.timeout(2000),
      });
      expect(unavailable.status).toBe(200);
      expect(await unavailable.json()).toMatchObject({
        processReachable: true,
        sourceReady: false,
        sourcePhase: 'unavailable',
      });
      for (const path of ['/', '/health/', '/health-extra?proof=other', '/other?path=/health']) {
        const response = await fetch(base + path, { signal: AbortSignal.timeout(2000) });
        expect(response.status, path).toBe(404);
        expect(await response.text()).toBe('');
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
describe('gateway host binding', () => {
  it('binds a production Unix socket only to its exact immutable revision', () => {
    const revision = 'a'.repeat(40);
    expect(
      gatewayListenTarget({
        PRIVATE_RECORD_GATEWAY_REVISION: revision,
        PRIVATE_RECORD_GATEWAY_SOCKET: `/run/ca-private-record-gateway/${revision}/listener.sock`,
      })
    ).toEqual({ socket: `/run/ca-private-record-gateway/${revision}/listener.sock` });
    expect(() =>
      gatewayListenTarget({
        PRIVATE_RECORD_GATEWAY_REVISION: revision,
        PRIVATE_RECORD_GATEWAY_SOCKET: '/run/other/escape.sock',
      })
    ).toThrow();
    expect(() =>
      gatewayListenTarget({
        PRIVATE_RECORD_GATEWAY_REVISION: revision,
        PRIVATE_RECORD_GATEWAY_SOCKET: `/run/ca-private-record-gateway/${'b'.repeat(40)}/listener.sock`,
      })
    ).toThrow();
  });
  it('rejects ambiguous or public network binding', () => {
    expect(() =>
      gatewayListenTarget({
        PRIVATE_RECORD_GATEWAY_PORT: '4782',
        PRIVATE_RECORD_GATEWAY_SOCKET: '/run/anything',
      })
    ).toThrow();
    expect(() => gatewayListenTarget({ PRIVATE_RECORD_GATEWAY_PORT: '80' })).toThrow();
    expect(gatewayListenTarget({ PRIVATE_RECORD_GATEWAY_PORT: '4782' })).toEqual({
      port: 4782,
      host: '127.0.0.1',
    });
  });
});

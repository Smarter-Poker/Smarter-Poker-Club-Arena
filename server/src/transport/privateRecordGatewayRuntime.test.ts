import { describe, expect, it } from 'vitest';
import { gatewayListenTarget } from './privateRecordGatewayRuntime.js';
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

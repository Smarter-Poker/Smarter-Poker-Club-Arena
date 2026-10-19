import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./handOutboxListener.js', () => ({ defaultOpenSession: vi.fn() }));
vi.mock('../leaseHeartbeatSession.js', () => ({ resolveEngineListenConnectionString: vi.fn() }));
vi.mock('./privateRecordTransportReady.js', () => ({ privateRecordTransportReady: vi.fn() }));
import { PrivateRecordListener, PRIVATE_RECORD_CHANNEL } from './privateRecordListener.js';
class Fake extends EventEmitter {
  queries: string[] = [];
  async connect() {}
  async query(sql: string) {
    this.queries.push(sql);
  }
  async end() {}
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
describe('private record LISTEN lifecycle', () => {
  it('requires installed source, dedicated session, rejects malformed signals and resyncs on reconnect', async () => {
    vi.useFakeTimers();
    const clients: Fake[] = [];
    const changed = vi.fn();
    const ready = vi.fn();
    const listener = new PrivateRecordListener(
      changed,
      ready,
      async () => 'test-only-session',
      () => {
        const client = new Fake();
        clients.push(client);
        return client;
      },
      async () => true
    );
    listener.start();
    await flush();
    expect(clients[0].queries).toEqual([`LISTEN ${PRIVATE_RECORD_CHANNEL}`]);
    expect(ready).toHaveBeenLastCalledWith(true);
    const topic = 'club-roster:11111111-1111-1111-1111-111111111111';
    clients[0].emit('notification', {
      channel: PRIVATE_RECORD_CHANNEL,
      payload: JSON.stringify({ topic, event: 'record_changed' }),
    });
    clients[0].emit('notification', { channel: PRIVATE_RECORD_CHANNEL, payload: 'not JSON' });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(topic);
    clients[0].emit('end');
    expect(ready).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(clients).toHaveLength(2);
    expect(ready).toHaveBeenLastCalledWith(true);
    await listener.stop();
  });
  it('bounds a blackholed socket probe on the existing heartbeat and cleans it on stop', async () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const client = new Fake();
    const listener = new PrivateRecordListener(
      vi.fn(),
      ready,
      async () => 'test-only-session',
      () => client,
      async () => true
    );
    listener.start();
    await flush();
    client.query = vi.fn(() => new Promise<void>(() => undefined));
    listener.probe();
    listener.probe();
    expect(client.query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8000);
    await flush();
    expect(ready).toHaveBeenLastCalledWith(false);
    await listener.stop();
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never advertises capability from a socket when the source is missing', async () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const listener = new PrivateRecordListener(
      vi.fn(),
      ready,
      async () => 'test-only-session',
      () => new Fake(),
      async () => false
    );
    listener.start();
    await flush();
    expect(listener.ready).toBe(false);
    expect(ready).not.toHaveBeenCalledWith(true);
    await listener.stop();
    await vi.runAllTimersAsync();
  });
});

/**
 * The LISTEN listener is a wake path, not a data path: every notification on
 * hand_projection_outbox becomes one wakeHandProjection('listen'), a lost
 * session reconnects with a jittered exponential backoff and resyncs once, and
 * an unset ENGINE_PG_LISTEN_URL disables the whole thing without touching the
 * worker. Nothing here opens a socket: the pg client is a fake EventEmitter.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReportError = vi.fn();
vi.mock('../errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
  describeError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// The listener imports the worker for its default wake. The spec injects its
// own wake, so the worker module must load without a Supabase client.
vi.mock('./client.js', () => ({ supabase: {} }));

const {
  HandOutboxListener,
  HAND_OUTBOX_CHANNEL,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  HEARTBEAT_MS,
  reconnectDelayMs,
} = await import('./handOutboxListener.js');
type OutboxListenerClient = import('./handOutboxListener.js').OutboxListenerClient;

class FakeClient extends EventEmitter implements OutboxListenerClient {
  queries: string[] = [];
  ended = false;
  connectImpl: () => Promise<void> = async () => undefined;
  queryImpl: (text: string) => Promise<unknown> = async () => ({ rows: [] });

  connect(): Promise<void> {
    return this.connectImpl();
  }
  query(text: string): Promise<unknown> {
    this.queries.push(text);
    return this.queryImpl(text);
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

const clients: FakeClient[] = [];
const wakes: string[] = [];
const wake = vi.fn(async (source: string) => {
  wakes.push(source);
  return { projected: 0, alreadyCompleted: 0, deferred: 0, failed: 0 };
});
const createClient = vi.fn(() => {
  const client = new FakeClient();
  clients.push(client);
  return client;
});

function makeListener(connectionString = 'postgresql://listener@pooler.invalid:5432/postgres') {
  return new HandOutboxListener({
    connectionString,
    createClient,
    wake,
    random: () => 0.5, // jitter factor exactly 1.0 so delays are deterministic
  });
}

// Fake timers are on for every test, so a real setTimeout(0) would never fire.
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  clients.length = 0;
  wakes.length = 0;
  wake.mockClear();
  createClient.mockClear();
  mockReportError.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HandOutboxListener', () => {
  it('is disabled without ENGINE_PG_LISTEN_URL and opens no connection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const listener = makeListener('');
      expect(listener.enabled).toBe(false);
      listener.start();
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);

      expect(createClient).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('ENGINE_PG_LISTEN_URL is not set');
      expect(listener.toPrometheus()).toContain('poker_hand_outbox_listener_enabled 0');
      await listener.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it('reads the connection string from the environment by default and never logs it', async () => {
    const secret = 'postgresql://listener:hunter2@pooler.invalid:5432/postgres';
    const previous = process.env.ENGINE_PG_LISTEN_URL;
    process.env.ENGINE_PG_LISTEN_URL = secret;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const listener = new HandOutboxListener({ createClient, wake, random: () => 0.5 });
      expect(listener.enabled).toBe(true);
      listener.start();
      await flush();
      expect(createClient).toHaveBeenCalledWith(secret);
      clients[0].emit('error', new Error('boom'));
      await flush();
      const everything = [
        ...log.mock.calls.flat(),
        ...mockReportError.mock.calls.flat().map((v) => (v instanceof Error ? v.message : v)),
        ...listener.toPrometheus(),
      ]
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        .join('\n');
      expect(everything).not.toContain('hunter2');
      expect(everything).not.toContain('pooler.invalid');
      await listener.stop();
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.ENGINE_PG_LISTEN_URL;
      else process.env.ENGINE_PG_LISTEN_URL = previous;
    }
  });

  it('LISTENs on connect, resyncs once, and wakes the worker per notification', async () => {
    const listener = makeListener();
    listener.start();
    await flush();

    expect(clients).toHaveLength(1);
    const client = clients[0];
    expect(client.queries).toEqual([`LISTEN ${HAND_OUTBOX_CHANNEL}`]);
    expect(listener.isConnected).toBe(true);
    expect(wakes).toEqual(['listen_resync']);

    client.emit('notification', { channel: HAND_OUTBOX_CHANNEL, payload: 'hand-1:table-1' });
    client.emit('notification', { channel: 'some_other_channel', payload: 'ignored' });
    client.emit('notification', { channel: HAND_OUTBOX_CHANNEL, payload: 'hand-2:table-1' });
    await flush();

    expect(wakes).toEqual(['listen_resync', 'listen', 'listen']);
    const metrics = listener.toPrometheus();
    expect(metrics).toContain('poker_hand_outbox_listener_connected 1');
    expect(metrics).toContain('poker_hand_outbox_listener_connects_total 1');
    expect(metrics).toContain('poker_hand_outbox_notifications_total 2');
    expect(mockReportError).not.toHaveBeenCalled();

    await listener.stop();
    expect(client.ended).toBe(true);
    expect(listener.isConnected).toBe(false);
  });

  it('reconnects after a lost session with growing backoff and resyncs on every reconnect', async () => {
    const failNextConnect = () =>
      createClient.mockImplementationOnce(() => {
        const client = new FakeClient();
        client.connectImpl = async () => {
          throw new Error('connect refused');
        };
        clients.push(client);
        return client;
      });

    const listener = makeListener();
    listener.start();
    await flush();
    expect(clients).toHaveLength(1);

    // First loss: attempt 0 -> 500 ms, then a clean reconnect resets the count.
    clients[0].emit('error', new Error('ECONNRESET'));
    await flush();
    expect(clients[0].ended).toBe(true);
    expect(listener.isConnected).toBe(false);
    expect(listener.reconnectAttempts).toBe(1);
    expect(mockReportError.mock.calls[0][1]).toBe('HandOutboxListener.connection_lost');
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS - 1);
    expect(clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(clients).toHaveLength(2);
    expect(listener.isConnected).toBe(true);
    expect(listener.reconnectAttempts).toBe(0);
    expect(wakes).toEqual(['listen_resync', 'listen_resync']);

    // Second loss followed by two refused connects: 500 ms, 1000 ms, 2000 ms.
    clients[1].emit('end');
    await flush();
    expect(listener.reconnectAttempts).toBe(1);
    failNextConnect();
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    await flush();
    expect(clients).toHaveLength(3);
    expect(listener.reconnectAttempts).toBe(2);
    failNextConnect();
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 2 - 1);
    expect(clients).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(clients).toHaveLength(4);
    expect(listener.reconnectAttempts).toBe(3);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 4 - 1);
    expect(clients).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(clients).toHaveLength(5);
    expect(listener.isConnected).toBe(true);
    expect(listener.reconnectAttempts).toBe(0);
    expect(wakes).toEqual(['listen_resync', 'listen_resync', 'listen_resync']);

    // Only sessions that had reached LISTEN count as disconnects.
    const metrics = listener.toPrometheus();
    expect(metrics).toContain('poker_hand_outbox_listener_disconnects_total 2');
    expect(metrics).toContain('poker_hand_outbox_listener_connects_total 3');
    await listener.stop();
  });

  it('backs off exponentially from 500 ms to a 30 s cap with +/-25% jitter', () => {
    expect(reconnectDelayMs(0, () => 0.5)).toBe(500);
    expect(reconnectDelayMs(1, () => 0.5)).toBe(1_000);
    expect(reconnectDelayMs(2, () => 0.5)).toBe(2_000);
    expect(reconnectDelayMs(6, () => 0.5)).toBe(30_000);
    expect(reconnectDelayMs(20, () => 0.5)).toBe(30_000);
    expect(reconnectDelayMs(0, () => 0)).toBe(375);
    expect(reconnectDelayMs(0, () => 0.999)).toBeLessThanOrEqual(625);
    expect(reconnectDelayMs(20, () => 0.999)).toBeLessThanOrEqual(37_500);
  });

  it('a failed connect schedules a retry with the next delay instead of giving up', async () => {
    createClient.mockImplementationOnce(() => {
      const client = new FakeClient();
      client.connectImpl = async () => {
        throw new Error('ENOTFOUND');
      };
      clients.push(client);
      return client;
    });
    const listener = makeListener();
    listener.start();
    await flush();
    expect(clients).toHaveLength(1);
    expect(listener.isConnected).toBe(false);
    expect(wakes).toEqual([]);
    expect(listener.reconnectAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    await flush();
    expect(clients).toHaveLength(2);
    expect(listener.isConnected).toBe(true);
    expect(wakes).toEqual(['listen_resync']);
    // A connect that never reached LISTEN is not counted as a disconnect.
    expect(listener.toPrometheus()).toContain('poker_hand_outbox_listener_disconnects_total 0');
    await listener.stop();
  });

  it('heartbeats every 30 s and treats a failed heartbeat as a lost connection', async () => {
    const listener = makeListener();
    listener.start();
    await flush();
    const client = clients[0];

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(client.queries).toEqual([`LISTEN ${HAND_OUTBOX_CHANNEL}`, 'SELECT 1']);

    client.queryImpl = async () => {
      throw new Error('socket hang up');
    };
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await flush();
    expect(listener.isConnected).toBe(false);
    expect(client.ended).toBe(true);

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    await flush();
    expect(clients).toHaveLength(2);
    expect(listener.isConnected).toBe(true);
    await listener.stop();
  });

  it('stop() ends the session, cancels the reconnect timer and heartbeat, and wakes nothing more', async () => {
    const listener = makeListener();
    listener.start();
    await flush();
    clients[0].emit('error', new Error('gone'));
    await flush();

    await listener.stop();
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);
    expect(clients).toHaveLength(1);
    expect(wakes).toEqual(['listen_resync']);

    // A late error from the old client is ignored, not reconnected.
    clients[0].emit('error', new Error('late'));
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);
    expect(clients).toHaveLength(1);
  });
});

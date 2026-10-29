import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { PrivateRecordGateway } from './PrivateRecordGateway.js';
const topic = 'club-roster:11111111-1111-1111-1111-111111111111';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  vi.useRealTimers();
});
async function fixture() {
  let allowed = true;
  let available = true;
  let changed!: (topic: string) => void;
  let readiness!: (ready: boolean, phase: 'connecting' | 'unavailable') => void;
  const source = {
    ready: true,
    phase: 'connecting' as 'connecting' | 'unavailable',
    start() {},
    probe() {},
    async stop() {},
  };
  const gateway = new PrivateRecordGateway({
    origins: new Set(['https://smarter.poker']),
    authenticate: async () =>
      available ? { userId: 'viewer' } : { denied: 'unavailable', code: 'auth_unavailable' },
    authorize: async (_token, user, requested) =>
      allowed && user === 'viewer' && requested === topic,
    source: (change, status) => {
      changed = change;
      readiness = status;
      return source;
    },
  });
  const server = createServer();
  gateway.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const sockets: WebSocket[] = [];
  cleanups.push(async () => {
    sockets.forEach((s) => s.terminate());
    await gateway.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  function connect(origin = 'https://smarter.poker') {
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws/channel`,
      ['bearer', 'test.payload.signature'],
      { origin }
    );
    socket.on('error', () => {});
    sockets.push(socket);
    return socket;
  }
  return {
    gateway,
    connect,
    changed,
    readiness,
    source,
    deny: () => {
      allowed = false;
    },
    outage: () => {
      available = false;
    },
  };
}
async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('expected gateway frame within 1s')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
const frame = async (ws: WebSocket) => JSON.parse(String((await once(ws, 'message'))[0]));
describe('independent private record gateway', () => {
  it('delivers authorized readiness and changes without an engine or ChannelHub', async () => {
    const f = await fixture();
    const ws = f.connect();
    await once(ws, 'open');
    const ready = frame(ws);
    ws.send(JSON.stringify({ type: 'JOIN_PRIVATE_RECORD', topic }));
    expect(await ready).toMatchObject({ type: 'PRIVATE_RECORD_STATUS', topic, ready: true });
    const update = frame(ws);
    f.changed(topic);
    expect(await update).toEqual({ type: 'PRIVATE_RECORD_CHANGED', topic });
  });
  it('announces listener loss and recovery so readers refresh missed commits', async () => {
    const f = await fixture();
    const ws = f.connect();
    await once(ws, 'open');
    const initial = frame(ws);
    ws.send(JSON.stringify({ type: 'JOIN_PRIVATE_RECORD', topic }));
    await initial;
    const lost = frame(ws);
    f.source.ready = false;
    f.readiness(false, 'unavailable');
    expect(await lost).toMatchObject({ ready: false });
    const recovered = frame(ws);
    f.source.ready = true;
    f.readiness(true, 'connecting');
    expect(await recovered).toMatchObject({ ready: true });
  });
  it('rechecks authority before an actual update and closes a revoked topic', async () => {
    const f = await fixture();
    const ws = f.connect();
    await once(ws, 'open');
    const initial = frame(ws);
    ws.send(JSON.stringify({ type: 'JOIN_PRIVATE_RECORD', topic }));
    await initial;
    const received: string[] = [];
    ws.on('message', (x) => received.push(String(x)));
    const closed = once(ws, 'close');
    f.deny();
    f.changed(topic);
    expect((await within(closed))[0]).toBe(4403);
    expect(received).toEqual([]);
  });
  it('sends an application heartbeat so the browser watchdog does not discard an idle healthy link', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await fixture();
    const ws = f.connect();
    await once(ws, 'open');
    const heartbeat = frame(ws);
    vi.advanceTimersByTime(25_000);
    expect(await within(heartbeat)).toEqual({ type: 'CHANNEL_PING' });
  });
  it('refuses an unauthorized initial topic rather than leaving a connecting subscription forever', async () => {
    const f = await fixture();
    f.deny();
    const ws = f.connect();
    await once(ws, 'open');
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'JOIN_PRIVATE_RECORD', topic }));
    expect((await within(closed))[0]).toBe(4403);
  });
  it('drains existing peers without replacing their source, then retires on the final close', async () => {
    const f = await fixture();
    const ws = f.connect();
    await once(ws, 'open');
    const initial = frame(ws);
    ws.send(JSON.stringify({ type: 'JOIN_PRIVATE_RECORD', topic }));
    await initial;
    let drained = false;
    let finish!: () => void;
    const drainedDone = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.gateway.drain(() => {
      drained = true;
      finish();
    });
    expect(drained).toBe(false);
    const update = frame(ws);
    f.changed(topic);
    expect(await update).toEqual({ type: 'PRIVATE_RECORD_CHANGED', topic });
    const newcomer = f.connect();
    const rejected = once(newcomer, 'unexpected-response');
    expect((await rejected)[1].statusCode).toBe(503);
    newcomer.terminate();
    const closed = once(ws, 'close');
    ws.close();
    await closed;
    await within(drainedDone);
    expect(drained).toBe(true);
  });
  it('refuses other origins before accepting a socket', async () => {
    const f = await fixture();
    const ws = f.connect('https://stranger.invalid');
    const response = once(ws, 'unexpected-response');
    expect((await response)[1].statusCode).toBe(403);
    ws.terminate();
  });
  it('keeps an auth outage distinct from a revoked session', async () => {
    const f = await fixture();
    f.outage();
    const ws = f.connect();
    const response = once(ws, 'unexpected-response');
    expect((await response)[1].statusCode).toBe(503);
    ws.terminate();
  });
  it('never accepts gameplay or financial commands', async () => {
    const f = await fixture();
    const ws = f.connect();
    await once(ws, 'open');
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'JOIN_CLUB', clubId: 'anything' }));
    expect((await closed)[0]).toBe(4400);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ReadRequest = { handId: string; signal?: AbortSignal };
const readHand = vi.hoisted(() => vi.fn());
vi.mock('../services/supabase.js', () => ({
  supabase: {
    auth: { getUser: vi.fn() },
    from: () => {
      const request: ReadRequest = { handId: '' };
      const query = {
        select: () => query,
        eq: (_key: string, value: string) => {
          request.handId = value;
          return query;
        },
        limit: () => query,
        abortSignal: (signal: AbortSignal) => {
          request.signal = signal;
          return query;
        },
        maybeSingle: () => readHand(request),
      };
      return query;
    },
  },
  default: {},
}));

import { ChannelWebSocketServer } from './ChannelWebSocketServer.js';

class FakeWs {
  readyState = 1;
  sent: Array<{ type: string; handId?: string; code?: string; event?: { frame?: string } }> = [];
  handlers = new Map<string, (arg?: unknown) => void>();
  on(event: string, callback: (arg?: unknown) => void) {
    this.handlers.set(event, callback);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.handlers.get('close')?.();
  }
  receive(frame: unknown) {
    this.handlers.get('message')?.(Buffer.from(JSON.stringify(frame)));
  }
}

function deferred() {
  let resolve!: (value: { data: unknown; error: unknown }) => void;
  const promise = new Promise<{ data: unknown; error: unknown }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function hand(userId: string, actions: unknown[] = [{ action: 'check' }]) {
  return { id: 'hand', players: [{ userId }], actions, ended_at: '2026-09-13T12:00:00Z' };
}
function request(ws: FakeWs, handId = 'hand') {
  ws.receive({ type: 'REQUEST_HAND_REPLAY', handId });
}
function replayFrames(ws: FakeWs) {
  return ws.sent.filter((frame) => frame.type === 'HAND_REPLAY_EVENT');
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

let server: ChannelWebSocketServer;
let sockets: FakeWs[];
let outstanding: Array<ReturnType<typeof deferred>>;
let serial = 0;
let user: string;
function socket(id = user) {
  const ws = new FakeWs();
  sockets.push(ws);
  (server as unknown as { onUpgraded(ws: unknown, userId: string): void }).onUpgraded(ws, id);
  return ws;
}
function holdReads() {
  readHand.mockImplementation(() => {
    const pending = deferred();
    outstanding.push(pending);
    return pending.promise;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  readHand.mockReset();
  server = new ChannelWebSocketServer();
  sockets = [];
  outstanding = [];
  user = `replay-owner-${++serial}`;
  readHand.mockResolvedValue({ data: hand(user), error: null });
});
afterEach(async () => {
  for (const ws of sockets) ws.close();
  for (const pending of outstanding) pending.resolve({ data: null, error: null });
  await flush();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('hand replay work belongs to its initiating connection', () => {
  it('coalesces duplicate requests into one read and one delayed stream', async () => {
    holdReads();
    const ws = socket();
    for (let i = 0; i < 30; i++) request(ws);
    expect(readHand).toHaveBeenCalledTimes(1);
    outstanding[0].resolve({ data: hand(user, Array(10).fill({ action: 'check' })), error: null });
    await flush();
    expect(replayFrames(ws).map((frame) => frame.event?.frame)).toEqual(['META']);
    expect(vi.getTimerCount()).toBe(1);
    vi.setSystemTime(Date.now() + 1001);
    for (let i = 0; i < 10; i++) request(ws);
    expect(readHand).toHaveBeenCalledTimes(1);
  });

  it('bounds distinct requests per connection without starting excess reads', () => {
    holdReads();
    const ws = socket();
    for (let i = 0; i < 30; i++) request(ws, `hand-${i}`);
    expect(readHand).toHaveBeenCalledTimes(4);
    expect(
      ws.sent.some((frame) => frame.type === 'CHANNEL_ERROR' && frame.code === 'REPLAY_LIMIT')
    ).toBe(true);
  });

  it('bounds process-wide reads and keeps aborted reads charged until they settle', async () => {
    holdReads();
    for (let owner = 0; owner < 16; owner++) {
      const ws = socket(`${user}-${owner}`);
      for (let i = 0; i < 4; i++) request(ws, `hand-${i}`);
    }
    expect(readHand).toHaveBeenCalledTimes(64);
    for (const ws of sockets) ws.close();
    const replacement = socket(`${user}-replacement`);
    request(replacement);
    expect(readHand).toHaveBeenCalledTimes(64);
    expect(replacement.sent.some((frame) => frame.code === 'REPLAY_LIMIT')).toBe(true);
    outstanding[0].resolve({ data: null, error: null });
    await flush();
    request(replacement);
    expect(readHand).toHaveBeenCalledTimes(65);
  });

  it('delivers replay frames only to the requesting socket, not another device', async () => {
    const requester = socket();
    const otherDevice = socket();
    request(requester);
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    expect(replayFrames(requester).map((frame) => frame.event?.frame)).toEqual([
      'META',
      'ACTION',
      'END',
    ]);
    expect(replayFrames(otherDevice)).toEqual([]);
  });

  it('aborts a disconnected read and ignores its late result instead of sending to a replacement', async () => {
    holdReads();
    const requester = socket();
    request(requester);
    const sentRead = readHand.mock.calls[0][0] as ReadRequest;
    requester.close();
    const replacement = socket();
    expect(sentRead.signal?.aborted).toBe(true);
    outstanding[0].resolve({ data: hand(user), error: null });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(replayFrames(requester)).toEqual([]);
    expect(replayFrames(replacement)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles and clears an owned frame timer on disconnect without sending END', async () => {
    const requester = socket();
    const otherDevice = socket();
    request(requester);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    requester.close();
    expect(vi.getTimerCount()).toBe(0);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(replayFrames(requester).map((frame) => frame.event?.frame)).toEqual(['META']);
    expect(replayFrames(otherDevice)).toEqual([]);
  });

  it('shutdown cancels reads before close handshakes complete and refuses new replay work', async () => {
    holdReads();
    const requester = socket();
    request(requester);
    // A close handshake is not completion; simulate one that stays OPEN.
    requester.close = () => {};
    await server.close();
    expect((readHand.mock.calls[0][0] as ReadRequest).signal?.aborted).toBe(true);
    request(requester, 'new-after-shutdown');
    expect(readHand).toHaveBeenCalledTimes(1);
    outstanding[0].resolve({ data: hand(user), error: null });
    await flush();
    expect(replayFrames(requester)).toEqual([]);
  });

  it('shutdown settles replay delay even while its close handshake remains open', async () => {
    const requester = socket();
    request(requester);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    requester.close = () => {};
    await server.close();
    expect(vi.getTimerCount()).toBe(0);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(replayFrames(requester).map((frame) => frame.event?.frame)).toEqual(['META']);
  });

  it('socket error retires the read even before readyState changes', async () => {
    holdReads();
    const requester = socket();
    request(requester);
    requester.handlers.get('error')?.(new Error('transport lost'));
    expect(requester.readyState).toBe(1);
    expect((readHand.mock.calls[0][0] as ReadRequest).signal?.aborted).toBe(true);
    const replacement = socket();
    outstanding[0].resolve({ data: hand(user), error: null });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(replayFrames(requester)).toEqual([]);
    expect(replayFrames(replacement)).toEqual([]);
  });

  it('releases capacity after normal completion so the same hand can be replayed again', async () => {
    const ws = socket();
    request(ws);
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    request(ws);
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    expect(readHand).toHaveBeenCalledTimes(2);
    expect(replayFrames(ws).map((frame) => frame.event?.frame)).toEqual([
      'META',
      'ACTION',
      'END',
      'META',
      'ACTION',
      'END',
    ]);
  });

  it.each(['missing', 'unfinished', 'not-participant'])(
    'preserves the completed-participant gate for %s hands',
    async (kind) => {
      const row =
        kind === 'missing' ? null : hand(kind === 'not-participant' ? 'someone-else' : user);
      if (row && kind === 'unfinished') row.ended_at = null as unknown as string;
      readHand.mockResolvedValue({ data: row, error: null });
      const ws = socket();
      const otherDevice = socket();
      request(ws);
      await flush();
      expect(replayFrames(ws)).toEqual([]);
      expect(ws.sent.some((frame) => frame.type === 'CHANNEL_ERROR')).toBe(true);
      expect(otherDevice.sent).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      request(ws);
      await flush();
      expect(readHand).toHaveBeenCalledTimes(2);
    }
  );

  it('a rejected read releases the slot and reports only to its owner', async () => {
    readHand.mockRejectedValueOnce(new Error('read unavailable'));
    const ws = socket();
    const otherDevice = socket();
    request(ws);
    await flush();
    expect(ws.sent.some((frame) => frame.code === 'REPLAY_ERROR')).toBe(true);
    expect(otherDevice.sent).toEqual([]);
    request(ws);
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    expect(readHand).toHaveBeenCalledTimes(2);
    expect(replayFrames(ws).at(-1)?.event?.frame).toBe('END');
  });

  it('separate connections retain independent bounded replay intent', async () => {
    const first = socket();
    const second = socket();
    request(first, 'first-hand');
    request(second, 'second-hand');
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    expect(new Set(replayFrames(first).map((frame) => frame.handId))).toEqual(
      new Set(['first-hand'])
    );
    expect(new Set(replayFrames(second).map((frame) => frame.handId))).toEqual(
      new Set(['second-hand'])
    );
  });
});

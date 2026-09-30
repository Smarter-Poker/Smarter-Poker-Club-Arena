/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A LOBBY JOIN ANSWERS ONLY THE JOINER, AND A FAN-OUT SERIALIZES ONCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Diamond Phase 11 line 5, measured 2026-09-30 on the engine's real transport
 * (server/scripts/measure-realtime-envelope.ts, evidence in
 * docs/evidence/diamond-phase-11/operating-envelope.md).
 *
 * Every page holds the lobby channel (useMaintenanceBreak subscribes for the
 * maintenance banner), and every reconnect replays JOIN_LOBBY. The server
 * answered each JOIN_LOBBY with broadcastLobbyUpdate(), which sends to EVERY
 * lobby subscriber - so N clients arriving together, as they do after every
 * engine restart, cost N(N+1)/2 sends on the main realtime loop. The other
 * subscribers learned nothing from it: a lobby join changes no club's online
 * count, and the thirty-second interval refreshes everyone anyway.
 *
 * And ChannelHub stringified inside its per-socket loop, the defect
 * TableStateHub fixed as C16 on 2026-08-15 and ChannelHub never received: a
 * message to N subscribers was serialized N times.
 *
 * THE PINS
 *   1. N clients joining the lobby produce exactly N LOBBY_UPDATE frames, one
 *      each, never N(N+1)/2.
 *   2. The joiner still gets its immediate lobby update, on every tab it holds.
 *   3. A lobby broadcast to N sockets serializes once, and every socket gets
 *      the identical frame.
 *   4. A club presence join serializes its member list once for the whole
 *      club, and still skips the joiner in the join fan-out.
 *
 * IF THIS FILE GOES RED, YOUR CHANGE IS THE BUG.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/supabase.js', () => ({
  supabase: {
    auth: { getUser: vi.fn() },
    from: vi.fn(),
  },
  default: {},
}));

import { ChannelWebSocketServer } from './ChannelWebSocketServer.js';
import { ChannelHub, channelHub } from '../hub/ChannelHub.js';

class FakeWs {
  readyState = 1;
  sent: string[] = [];
  handlers = new Map<string, (arg?: unknown) => void>();
  on(event: string, cb: (arg?: unknown) => void): void {
    this.handlers.set(event, cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.handlers.get('close')?.();
  }
  terminate(): void {
    this.readyState = 3;
  }
  _receive(obj: unknown): void {
    this.handlers.get('message')?.(Buffer.from(JSON.stringify(obj)));
  }
}

function upgraded(server: ChannelWebSocketServer, userId: string): FakeWs {
  const ws = new FakeWs();
  (server as unknown as { onUpgraded(ws: unknown, userId: string): void }).onUpgraded(ws, userId);
  return ws;
}

const lobbyFrames = (ws: FakeWs) =>
  ws.sent.filter((s) => (JSON.parse(s) as { type: string }).type === 'LOBBY_UPDATE').length;

describe('A lobby join answers only the joiner (Diamond Phase 11 line 5)', () => {
  let server: ChannelWebSocketServer;
  const sockets: FakeWs[] = [];

  beforeEach(() => {
    server = new ChannelWebSocketServer();
    sockets.length = 0;
  });
  afterEach(() => {
    for (const ws of sockets) ws.close();
  });

  it('N joins cost N lobby frames, not N(N+1)/2', () => {
    const N = 50;
    for (let i = 0; i < N; i++) sockets.push(upgraded(server, `lobby-user-${i}`));
    for (const ws of sockets) ws._receive({ type: 'JOIN_LOBBY' });
    const total = sockets.reduce((a, ws) => a + lobbyFrames(ws), 0);
    expect(total).toBe(N);
    expect(total).not.toBe((N * (N + 1)) / 2);
  });

  it('the joiner still gets its immediate lobby update, on every tab it holds', () => {
    const early = upgraded(server, 'early-user');
    sockets.push(early);
    early._receive({ type: 'JOIN_LOBBY' });
    const tabA = upgraded(server, 'two-tab-user');
    const tabB = upgraded(server, 'two-tab-user');
    sockets.push(tabA, tabB);
    tabA._receive({ type: 'JOIN_LOBBY' });
    expect(lobbyFrames(tabA)).toBe(1);
    expect(lobbyFrames(tabB)).toBe(1);
    // The earlier subscriber is not re-sent anything by someone else's join.
    expect(lobbyFrames(early)).toBe(1);
    const frame = JSON.parse(tabA.sent.find((s) => s.includes('LOBBY_UPDATE')) ?? '{}');
    expect(frame.payload).toHaveProperty('clubOnlineCounts');
  });

  it('the interval broadcast still reaches every lobby subscriber', () => {
    for (let i = 0; i < 5; i++) {
      const ws = upgraded(server, `interval-user-${i}`);
      sockets.push(ws);
      ws._receive({ type: 'JOIN_LOBBY' });
    }
    channelHub.broadcastLobbyUpdate();
    for (const ws of sockets) expect(lobbyFrames(ws)).toBe(2);
  });
});

describe('A ChannelHub fan-out serializes once (TableStateHub C16, ported)', () => {
  let hub: ChannelHub;
  let stringify: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hub = new ChannelHub();
    hub.close();
  });
  afterEach(() => stringify?.mockRestore());

  it('a lobby broadcast to N sockets stringifies once and every socket gets the same frame', () => {
    const socks: FakeWs[] = [];
    for (let i = 0; i < 40; i++) {
      const ws = new FakeWs();
      socks.push(ws);
      hub.addConnection(`u${i}`, ws as never);
      hub.joinLobby(`u${i}`);
    }
    stringify = vi.spyOn(JSON, 'stringify');
    hub.broadcastToLobby({
      type: 'LOBBY_UPDATE',
      kind: 'maintenance',
      payload: { active: true },
    } as never);
    expect(stringify).toHaveBeenCalledTimes(1);
    const frames = new Set(socks.map((ws) => ws.sent[0]));
    expect(frames.size).toBe(1);
    expect(socks.every((ws) => ws.sent.length === 1)).toBe(true);
  });

  it('a club presence join serializes its member list once and skips the joiner', () => {
    const socks: FakeWs[] = [];
    for (let i = 0; i < 30; i++) {
      const ws = new FakeWs();
      socks.push(ws);
      hub.addConnection(`m${i}`, ws as never);
      hub.joinClub(`m${i}`, 'club-1');
    }
    const joiner = new FakeWs();
    hub.addConnection('newcomer', joiner as never);
    for (const ws of socks) ws.sent.length = 0;
    stringify = vi.spyOn(JSON, 'stringify');
    hub.joinClub('newcomer', 'club-1');
    // One for the joiner's sync, one for everyone else's join event.
    expect(stringify).toHaveBeenCalledTimes(2);
    expect(joiner.sent.map((s) => JSON.parse(s).event)).toEqual(['sync']);
    for (const ws of socks) {
      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0]).event).toBe('join');
    }
  });

  it('a closed socket is skipped and a fan-out to nobody serializes nothing', () => {
    const open = new FakeWs();
    const closed = new FakeWs();
    closed.readyState = 3;
    hub.addConnection('open-user', open as never);
    hub.addConnection('closed-user', closed as never);
    hub.joinLobby('open-user');
    hub.joinLobby('closed-user');
    hub.broadcastToLobby({ type: 'LOBBY_UPDATE', kind: 'maintenance', payload: {} } as never);
    expect(open.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
    stringify = vi.spyOn(JSON, 'stringify');
    hub.broadcastToTournament('no-such-tournament', { type: 'TOURNAMENT_EVENT' } as never);
    expect(stringify).not.toHaveBeenCalled();
  });
});

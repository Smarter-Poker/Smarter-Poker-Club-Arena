/**
 * ChannelWebSocketServer — heartbeat protocol compatibility.
 *
 * THE BUG THIS PINS (2026-08-24): the sweep sent CHANNEL_PING and accepted
 * ONLY CHANNEL_PONG as proof of life, while the deployed client answers
 * heartbeats with {type:'PONG'} (and its JOIN_* / UPDATE_PRESENCE frames were
 * not counted as liveness either). Result: every single /ws/channel
 * connection was force-closed 60 seconds after it opened, forever — killing
 * wallet FINANCIAL_UPDATEs, tournament events, club events and lobby updates
 * once a minute for every user on the platform.
 *
 * The contract now:
 *   1. The sweep sends BOTH {type:'PING'} and {type:'CHANNEL_PING'}.
 *   2. ANY well-formed inbound frame refreshes liveness — PONG, CHANNEL_PONG,
 *      JOIN_LOBBY, anything the router parses.
 *   3. A connection with 60s of total inbound silence is still closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/supabase.js', () => ({
  supabase: {
    auth: { getUser: vi.fn() },
    from: vi.fn(),
  },
  default: {},
}));

import { ChannelWebSocketServer } from './ChannelWebSocketServer.js';

// Minimal ws double — just enough surface for onUpgraded + the sweep.
class FakeWs {
  readyState = 1; // ws.OPEN
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  terminated = false;
  handlers = new Map<string, (arg?: unknown) => void>();

  on(event: string, cb: (arg?: unknown) => void): void {
    this.handlers.set(event, cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = 3;
    this.handlers.get('close')?.();
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Push an inbound frame through the server's message handler. */
  _receive(obj: unknown): void {
    this.handlers.get('message')?.(Buffer.from(JSON.stringify(obj)));
  }
  /** Push raw (possibly malformed) bytes through the message handler. */
  _receiveRaw(raw: string): void {
    this.handlers.get('message')?.(Buffer.from(raw));
  }
}

interface ConnState {
  userId: string;
  lastPongAt: number;
}

function upgraded(server: ChannelWebSocketServer, userId: string): FakeWs {
  const ws = new FakeWs();
  (server as unknown as { onUpgraded(ws: unknown, userId: string): void }).onUpgraded(ws, userId);
  return ws;
}

function connOf(server: ChannelWebSocketServer, ws: FakeWs): ConnState {
  const map = (server as unknown as { connections: Map<unknown, ConnState> }).connections;
  const state = map.get(ws);
  if (!state) throw new Error('connection not registered');
  return state;
}

function sweep(server: ChannelWebSocketServer): void {
  (server as unknown as { heartbeatSweep(): void }).heartbeatSweep();
}

function sentTypes(ws: FakeWs): string[] {
  return ws.sent.map((s) => (JSON.parse(s) as { type: string }).type);
}

describe('ChannelWebSocketServer heartbeat compatibility', () => {
  let server: ChannelWebSocketServer;

  beforeEach(() => {
    server = new ChannelWebSocketServer();
  });

  it('sweep sends BOTH PING and CHANNEL_PING dialects', () => {
    const ws = upgraded(server, 'user-ping');
    sweep(server);
    const types = sentTypes(ws);
    expect(types).toContain('PING');
    expect(types).toContain('CHANNEL_PING');
    // The old stray unsolicited CHANNEL_PONG must be gone — it answered
    // nothing and made traces lie about who was ponging whom.
    expect(types).not.toContain('CHANNEL_PONG');
  });

  it("a client answering with plain PONG (the deployed client's dialect) is kept alive", () => {
    const ws = upgraded(server, 'user-pong');
    const conn = connOf(server, ws);
    conn.lastPongAt = Date.now() - 55_000; // near death under the old rule
    ws._receive({ type: 'PONG', ts: 123 });
    expect(Date.now() - conn.lastPongAt).toBeLessThan(1_000);
    sweep(server);
    expect(ws.closed).toHaveLength(0);
  });

  it('CHANNEL_PONG still counts as liveness', () => {
    const ws = upgraded(server, 'user-cpong');
    const conn = connOf(server, ws);
    conn.lastPongAt = Date.now() - 55_000;
    ws._receive({ type: 'CHANNEL_PONG' });
    sweep(server);
    expect(ws.closed).toHaveLength(0);
  });

  it('ANY well-formed frame (JOIN_LOBBY) refreshes liveness', () => {
    const ws = upgraded(server, 'user-join');
    const conn = connOf(server, ws);
    conn.lastPongAt = Date.now() - 55_000;
    ws._receive({ type: 'JOIN_LOBBY' });
    sweep(server);
    expect(ws.closed).toHaveLength(0);
  });

  it('60s of total inbound silence still closes the connection', () => {
    const ws = upgraded(server, 'user-silent');
    const conn = connOf(server, ws);
    conn.lastPongAt = Date.now() - 61_000;
    sweep(server);
    expect(ws.closed.length).toBeGreaterThan(0);
    expect(ws.closed[0]?.code).toBe(1001);
  });

  it('malformed frames do NOT count as liveness', () => {
    const ws = upgraded(server, 'user-garbage');
    const conn = connOf(server, ws);
    conn.lastPongAt = Date.now() - 61_000;
    ws._receiveRaw('not json');
    sweep(server);
    expect(ws.closed.length).toBeGreaterThan(0);
  });
});

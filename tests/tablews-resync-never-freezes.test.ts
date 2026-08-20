/**
 * A failed resync must never wedge the table.
 *
 * `handleGameEvent` queues an out-of-sequence event and returns WITHOUT
 * advancing `lastSequence`, on the promise that `requestResync()` will repair
 * it. `GameServerAPI.getTableState` never throws — it resolves `null` on a
 * non-OK status, on an unreachable engine, and whenever the circuit breaker is
 * open. The old code checked `if (data)` and simply fell out of the function on
 * null, so the sequence was never repaired: every later event was also a gap,
 * was also queued, and `processPendingEvents` (strictly in-order) could never
 * drain. The felt froze mid-hand with no error and no banner, and only a page
 * reload recovered it.
 *
 * These tests pin the recovery, not the implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getTableState = vi.fn();

vi.mock('../src/services/GameServerAPI', () => ({
  default: { getTableState: (...a: unknown[]) => getTableState(...a) },
  getTableState: (...a: unknown[]) => getTableState(...a),
}));
vi.mock('../src/lib/supabase', () => ({ supabase: { channel: vi.fn() } }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { TableWebSocket, type GameEvent } from '../src/services/TableWebSocket';

const ev = (sequence: number, type = 'PLAYER_ACTION'): GameEvent =>
  ({ type, tableId: 't1', data: { sequence }, timestamp: 0, sequence }) as GameEvent;

// handleGameEvent is private; the sequence logic is what we are pinning.
const feed = (ws: TableWebSocket, e: GameEvent) =>
  (ws as unknown as { handleGameEvent: (e: GameEvent) => void }).handleGameEvent(e);
const seq = (ws: TableWebSocket) => (ws as unknown as { lastSequence: number }).lastSequence;
const queued = (ws: TableWebSocket) =>
  (ws as unknown as { pendingEvents: GameEvent[] }).pendingEvents.length;

describe('TableWebSocket resync', () => {
  let ws: TableWebSocket;
  let seen: GameEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    getTableState.mockReset();
    ws = new TableWebSocket('t1', 'u1', 'hero');
    seen = [];
    ws.onEvent((e) => seen.push(e));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
  };

  it('recovers the live stream when the engine never answers', async () => {
    getTableState.mockResolvedValue(null); // every attempt fails

    feed(ws, ev(0));
    expect(seq(ws)).toBe(0);

    feed(ws, ev(5)); // gap: 1..4 missing
    await settle();

    // The gap is accepted rather than held forever.
    expect(queued(ws)).toBe(0);
    expect(seq(ws)).toBe(5);

    // ...and the table keeps tracking the hand afterwards.
    feed(ws, ev(6));
    expect(seq(ws)).toBe(6);
    expect(seen.map((e) => e.sequence)).toContain(6);
  });

  it('retries a null before giving up', async () => {
    getTableState.mockResolvedValue(null);
    feed(ws, ev(0));
    feed(ws, ev(3));
    await settle();
    // The old code wrapped this in retryAsync, which only retries THROWN errors,
    // so a null was one attempt. It must actually retry.
    expect(getTableState.mock.calls.length).toBeGreaterThan(1);
  });

  it('uses the authoritative snapshot when the engine does answer', async () => {
    getTableState.mockResolvedValue({ sequence: 9, pot: 42 });

    feed(ws, ev(0));
    feed(ws, ev(4)); // gap
    await settle();

    expect(seq(ws)).toBe(9);
    expect(queued(ws)).toBe(0);
    const sync = seen.find((e) => e.type === 'GAME_START');
    expect(sync).toBeTruthy();
    expect((sync!.data as Record<string, unknown>).pot).toBe(42);
  });

  it('does not fire a resync per event during a burst of gaps', async () => {
    let resolveIt: (v: unknown) => void = () => {};
    getTableState.mockReturnValue(
      new Promise((r) => {
        resolveIt = r;
      })
    );

    feed(ws, ev(0));
    feed(ws, ev(5));
    feed(ws, ev(6));
    feed(ws, ev(7));

    expect(getTableState.mock.calls.length).toBe(1);
    resolveIt({ sequence: 7 });
    await settle();
  });
});

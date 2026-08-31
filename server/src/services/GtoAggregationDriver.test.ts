/**
 * V30 — the aggregation driver (Dan 2026-08-29).
 *
 * Every pin here is a bug that actually happened in production on the day
 * this shipped:
 *  - the RPC failed on the engine's path (PostgREST safe-update) while
 *    passing under a privileged SQL probe, and the driver swallowed it;
 *  - the adaptive batch settled at the floor and then oscillated back into
 *    a guaranteed timeout every eleventh tick;
 *  - a timeout is a rolled-back no-op, not an error worth reporting, and
 *    must not be hammered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
const reported: unknown[] = [];
vi.mock('./errorReporter.js', () => ({
  reportError: (e: unknown) => {
    reported.push(e);
  },
}));

const { gtoAggregationTick, _resetGtoAggregationDriver, gtoAggregationFinished } =
  await import('./GtoAggregationDriver.js');

const ok = (processed: number, done = false) => ({
  data: [{ processed, new_last_id: 'x', street_done: done }],
  error: null,
});
const timeout = { data: null, error: { code: '57014', message: 'canceling statement' } };

beforeEach(() => {
  rpc.mockReset();
  reported.length = 0;
  _resetGtoAggregationDriver();
});

describe('GtoAggregationDriver', () => {
  it('folds several batches per tick, bounded, always at the measured batch size', async () => {
    rpc.mockResolvedValue(ok(100));
    const rows = await gtoAggregationTick();
    expect(rpc.mock.calls.length).toBe(8); // the hard per-tick cap
    expect(rows).toBe(800);
    // THE BATCH IS FIXED, AND IT IS NOT THE LARGEST THAT FITS. Measured
    // 2026-08-30 on the engine's own path: 100 rows costs ~0.9s, 200 costs
    // ~8s and is cancelled outright a third of the time. Cost is
    // super-linear, so the big batch is both slower per row and the one
    // that gets thrown away. If this ever reads 200 again, the driver has
    // regressed to ~10 rows/s.
    for (const [, args] of rpc.mock.calls) {
      expect((args as { p_batch: number }).p_batch).toBe(100);
    }
  });

  it('starts on the turn and only moves to the river when the turn is done', async () => {
    rpc.mockResolvedValueOnce(ok(100, true)).mockResolvedValue(ok(100));
    await gtoAggregationTick();
    const streets = rpc.mock.calls.map((c) => (c[1] as { p_street: string }).p_street);
    expect(streets[0]).toBe('turn');
    expect(streets[1]).toBe('river');
  });

  it('a timeout ends the tick quietly - it is a rolled-back no-op, not an incident', async () => {
    rpc.mockResolvedValueOnce(ok(100)).mockResolvedValueOnce(timeout).mockResolvedValue(ok(100));
    const rows = await gtoAggregationTick();
    expect(rows).toBe(100); // stopped at the timeout, did not hammer on
    expect(rpc.mock.calls.length).toBe(2);
    expect(reported).toHaveLength(0);
  });

  /**
   * THE BUG THAT COST A NIGHT: the RPC returned 21000 "DELETE requires a
   * WHERE clause" on every call through PostgREST while working perfectly
   * under the MCP's postgres role. A real error must be REPORTED, or the
   * driver spins silently forever and the cursor never moves.
   */
  it('a real error is reported, not swallowed', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '21000', message: 'DELETE requires a WHERE clause' },
    });
    await gtoAggregationTick();
    expect(reported).toHaveLength(1);
    expect(String((reported[0] as Error).message)).toContain('WHERE clause');
  });

  it('goes permanently silent once both streets are done', async () => {
    rpc.mockResolvedValue(ok(10, true));
    await gtoAggregationTick();
    expect(gtoAggregationFinished()).toBe(true);
    rpc.mockClear();
    await gtoAggregationTick();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('backs off after repeated stalled ticks instead of hammering a busy database', async () => {
    rpc.mockResolvedValue(timeout);
    for (let i = 0; i < 5; i++) await gtoAggregationTick();
    const callsBefore = rpc.mock.calls.length;
    await gtoAggregationTick(); // inside the back-off window
    expect(rpc.mock.calls.length).toBe(callsBefore);
    expect(reported).toHaveLength(0);
  });
});

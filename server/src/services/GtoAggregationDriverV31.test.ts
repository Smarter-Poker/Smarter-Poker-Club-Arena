/**
 * V31 — the v2 aggregation driver (2026-08-30).
 *
 * Every pin here is a real hazard measured on the day this shipped, not a
 * hypothetical:
 *  - batch 25 was comfortable under a privileged SQL session (~657ms) and
 *    took 20.5s through the engine's own RPC path, where authenticator
 *    carries statement_timeout=8s. The batch number is the measurement;
 *    if it drifts up, the driver stops making progress entirely;
 *  - both aggregations walk the same 79 GB table, so V31 must not start
 *    while V30 is still running, and must not start when it cannot TELL;
 *  - a 57014 is a rolled-back no-op with the cursor unmoved, not an
 *    incident, and must not be hammered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const rpc = vi.fn();
const progressSelect = vi.fn();
vi.mock('./supabase/client.js', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (t: string) => ({ select: (...a: unknown[]) => progressSelect(t, ...a) }),
  },
}));
const reported: unknown[] = [];
vi.mock('./errorReporter.js', () => ({
  reportError: (e: unknown) => {
    reported.push(e);
  },
}));

const {
  gtoV31AggregationTick,
  _resetGtoAggregationDriverV31,
  gtoV31AggregationFinished,
  v30IsComplete,
  BATCH,
  MAX_CALLS_PER_TICK,
} = await import('./GtoAggregationDriverV31.js');

const ok = (processed: number, done = false) => ({
  data: [{ processed, last_at: '2026-07-24T16:38:11.634945+00:00', last_id: 'x', is_done: done }],
  error: null,
});
const timeout = { data: null, error: { code: '57014', message: 'canceling statement' } };

const v30Done = () => ({
  data: [
    { street: 'turn', done: true },
    { street: 'river', done: true },
  ],
  error: null,
});
const v30Running = () => ({
  data: [
    { street: 'turn', done: true },
    { street: 'river', done: false },
  ],
  error: null,
});

beforeEach(() => {
  rpc.mockReset();
  progressSelect.mockReset();
  reported.length = 0;
  _resetGtoAggregationDriverV31();
  progressSelect.mockResolvedValue(v30Done());
});

describe('GtoAggregationDriverV31', () => {
  /**
   * THE GATE. V30 owns the only consult reading solver cells today, and both
   * walk the same 79 GB relation behind the 2026-08-15 liveness incident. A
   * V31 that starts early does not fail loudly — it just makes V30 slower,
   * which is the kind of harm nobody attributes correctly.
   */
  it('does no work at all while the V30 aggregation is still running', async () => {
    progressSelect.mockResolvedValue(v30Running());
    const rows = await gtoV31AggregationTick();
    expect(rows).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('fails CLOSED - an unreadable progress table means "do not start"', async () => {
    progressSelect.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await v30IsComplete()).toBe(false);
    await gtoV31AggregationTick();
    expect(rpc).not.toHaveBeenCalled();

    // an empty table is equally unreadable: it does not say "done"
    progressSelect.mockResolvedValue({ data: [], error: null });
    expect(await v30IsComplete()).toBe(false);
  });

  it('starts once every V30 street reports done', async () => {
    rpc.mockResolvedValue(ok(BATCH));
    const rows = await gtoV31AggregationTick();
    expect(rows).toBe(BATCH * MAX_CALLS_PER_TICK);
    expect(rpc.mock.calls.length).toBe(MAX_CALLS_PER_TICK); // the hard per-tick cap
  });

  /**
   * THE BATCH IS THE MEASUREMENT, AND THE MEASUREMENT WAS RE-TAKEN.
   *
   * The original table (5 -> 1.18s, 10 -> 6.67s, 15 -> 4.90s, 25 -> 9.06s
   * CANCELLED) was measured while every batch ALSO re-read every row the
   * driver had already processed: the keyset was an un-sargable OR chain, so
   * a batch scanned idx_solved_spots_gold_solved_v2_at from the start and
   * discarded the prefix - 761 ms and ~4.8 GB of buffers, growing with
   * progress. Migration 20260908034500 made it a seek (0.082 ms, 12 buffers)
   * and the batch was re-measured on this same RPC path: 25 -> 4.53s cold and
   * 1.15/1.30/1.38s warm, comfortably inside the 8s ceiling; 50 and 100 still
   * cancel. 25 is the largest size with a COLD sample behind it.
   *
   * The number this pins is deliberately the constant, not a literal: the
   * rule it guards is "the driver asks for the size that was measured", and
   * the measurement is recorded beside the constant in the driver.
   */
  it('always asks for the measured batch', async () => {
    expect(BATCH).toBe(25);
    rpc.mockResolvedValue(ok(BATCH));
    await gtoV31AggregationTick();
    for (const [, args] of rpc.mock.calls) {
      expect((args as { p_batch: number }).p_batch).toBe(BATCH);
    }
  });

  it('a timeout ends the tick quietly - rolled back, cursor unmoved, not an incident', async () => {
    rpc
      .mockResolvedValueOnce(ok(BATCH))
      .mockResolvedValueOnce(timeout)
      .mockResolvedValue(ok(BATCH));
    const rows = await gtoV31AggregationTick();
    expect(rows).toBe(BATCH); // stopped at the timeout, did not hammer on
    expect(rpc.mock.calls.length).toBe(2);
    expect(reported).toHaveLength(0);
  });

  /**
   * The V30 equivalent of this pin cost a night: the RPC returned 21000
   * through PostgREST while working perfectly under a privileged role, and
   * the driver swallowed it. A real error must be REPORTED or the cursor
   * silently never moves.
   */
  it('a real error is reported, not swallowed', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '21000', message: 'DELETE requires a WHERE clause' },
    });
    await gtoV31AggregationTick();
    expect(reported).toHaveLength(1);
    expect(String((reported[0] as Error).message)).toContain('WHERE clause');
  });

  it('goes permanently silent once the build reports done', async () => {
    rpc.mockResolvedValue(ok(3, true));
    await gtoV31AggregationTick();
    expect(gtoV31AggregationFinished()).toBe(true);
    rpc.mockClear();
    await gtoV31AggregationTick();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('backs off after repeated stalled ticks instead of hammering a busy database', async () => {
    rpc.mockResolvedValue(timeout);
    for (let i = 0; i < 5; i++) await gtoV31AggregationTick();
    const callsBefore = rpc.mock.calls.length;
    await gtoV31AggregationTick(); // inside the back-off window
    expect(rpc.mock.calls.length).toBe(callsBefore);
    expect(reported).toHaveLength(0);
  });

  it('reads the V30 cursor table, not its own, to decide whether to start', async () => {
    rpc.mockResolvedValue(ok(10));
    await gtoV31AggregationTick();
    expect(progressSelect.mock.calls[0][0]).toBe('gto_agg_progress');
  });
});

/** Prepared source-only regression cases. No RPC, database or native run has occurred. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionRecord } from '../types.js';

type RpcRow = Record<string, unknown>;
type RpcReply = { data?: unknown; error: null | { message: string; code?: string } };
const transport = vi.hoisted(() => ({
  rpc: vi.fn<(name: string, args: { rows: RpcRow[] }) => Promise<RpcReply>>(),
  report: vi.fn<(error: unknown, context: string) => void>(),
}));
vi.mock('./supabase.js', () => ({ supabase: { rpc: transport.rpc } }));
vi.mock('./errorReporter.js', () => ({ reportError: transport.report }));

type Mind = typeof import('../engine/HorseMind.js').HorseMind;
type Persistence = typeof import('./HorseMindPersistence.js');
type Lane = {
  name: string;
  rpc: string;
  seed: (mind: Mind, id: string, count: number) => void;
  dirty: (mind: Mind) => number;
  flush: (service: Persistence) => Promise<{ flushed: number; failed: number }>;
  key: (row: RpcRow) => unknown;
  counter: (row: RpcRow) => unknown;
};
const victim = '20000000-0000-4000-8000-000000000001';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lanes: Lane[] = [
  {
    name: 'pooled',
    rpc: 'upsert_horse_mind_stats',
    seed: (m, user_id, hands) => {
      m.importStats([{ user_id, hands, vpip: hands, rHands: hands }]);
      m.requeueDirty([user_id]);
    },
    dirty: (m) => m.dirtyCount(),
    flush: (s) => s.flushHorseMind(),
    key: (r) => r.user_id,
    counter: (r) => r.hands,
  },
  {
    name: 'pairs',
    rpc: 'upsert_horse_mind_pairs',
    seed: (m, attacker_id, n3) => {
      m.importPairs([{ attacker_id, victim_id: victim, n3, opp3: n3 }]);
      m.requeueDirtyPairs([{ attacker_id, victim_id: victim }]);
    },
    dirty: (m) => m.dirtyPairsCount(),
    flush: (s) => s.flushHorseMindPairs(),
    key: (r) => r.attacker_id,
    counter: (r) => r.n3,
  },
  {
    name: 'scoped',
    rpc: 'upsert_horse_mind_stats_scoped',
    seed: (m, user_id, hands) => {
      m.importScoped([{ user_id, scope: 'holdem:hu', hands, vpip: hands }]);
      m.requeueDirtyScoped([{ user_id, scope: 'holdem:hu' }]);
    },
    dirty: (m) => m.dirtyScopedCount(),
    flush: (s) => s.flushHorseMindScoped(),
    key: (r) => r.user_id,
    counter: (r) => r.hands,
  },
];
const unavailable: RpcReply = { error: { message: 'synthetic transport unavailable' } };
const permanent: RpcReply = { error: { message: 'synthetic integer refusal', code: '22P02' } };
let mind: Mind;
let service: Persistence;
const releaseGates: Array<() => void> = [];
function pending() {
  let finish!: (value: RpcReply) => void;
  const promise = new Promise<RpcReply>((resolve) => {
    finish = resolve;
  });
  releaseGates.push(() => finish(unavailable));
  return { promise, finish };
}
function calls(lane: Lane) {
  return transport.rpc.mock.calls
    .filter(([name]) => name === lane.rpc)
    .map(([, args]) => args.rows);
}
function onlyRow(lane: Lane): RpcRow {
  const rows = calls(lane).at(-1);
  expect(rows).toHaveLength(1);
  const row = rows?.[0];
  if (!row) throw new Error('fixture_expected_row');
  return row;
}
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  transport.rpc
    .mockReset()
    .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
  transport.report.mockReset();
  mind = (await import('../engine/HorseMind.js')).HorseMind;
  service = await import('./HorseMindPersistence.js');
  mind.reset();
});
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  transport.rpc
    .mockReset()
    .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
  await service.stopHorseMindPersistence();
  mind.reset();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe.each(lanes)('$name dirty-row delivery', (lane) => {
  it('does not call transport for empty memory', async () => {
    expect(await lane.flush(service)).toEqual({ flushed: 0, failed: 0 });
    expect(transport.rpc).not.toHaveBeenCalled();
  });

  it('clears a successful snapshot and preserves its serialized counter', async () => {
    lane.seed(mind, id(1), 4);
    expect(await lane.flush(service)).toEqual({ flushed: 1, failed: 0 });
    expect(lane.counter(onlyRow(lane))).toBe(4);
    expect(lane.dirty(mind)).toBe(0);
    expect(await lane.flush(service)).toEqual({ flushed: 0, failed: 0 });
    expect(calls(lane)).toHaveLength(1);
  });

  it('keeps successful individual recoveries clear after a failed chunk', async () => {
    lane.seed(mind, id(1), 1);
    lane.seed(mind, id(2), 2);
    transport.rpc.mockResolvedValueOnce(unavailable);
    expect(await lane.flush(service)).toEqual({ flushed: 2, failed: 0 });
    expect(lane.dirty(mind)).toBe(0);
    expect(calls(lane).map((r) => r.length)).toEqual([2, 1, 1]);
    expect(transport.report).toHaveBeenCalledTimes(1);
  });

  it.each(['returned_error', 'rejected_promise', 'synchronous_throw'] as const)(
    'retains unchanged failed memory after %s and sends it on the next invocation',
    async (failure) => {
      lane.seed(mind, id(1), 7);
      if (failure === 'returned_error') transport.rpc.mockResolvedValue(unavailable);
      else if (failure === 'rejected_promise')
        transport.rpc.mockRejectedValue(new Error('synthetic rejection'));
      else
        transport.rpc.mockImplementation(() => {
          throw new Error('synthetic throw');
        });
      expect(await lane.flush(service)).toEqual({ flushed: 0, failed: 1 });
      expect(lane.dirty(mind)).toBe(1);
      expect(calls(lane)).toHaveLength(2);
      transport.rpc
        .mockReset()
        .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
      expect(await lane.flush(service)).toEqual({ flushed: 1, failed: 0 });
      expect(lane.key(onlyRow(lane))).toBe(id(1));
      expect(lane.counter(onlyRow(lane))).toBe(7);
      expect(lane.dirty(mind)).toBe(0);
    }
  );

  it('requeues only the unsuccessful individual from a partially recovered chunk', async () => {
    lane.seed(mind, id(1), 1);
    lane.seed(mind, id(2), 2);
    lane.seed(mind, id(3), 3);
    transport.rpc.mockImplementation(async (_name, { rows }) =>
      rows.length > 1 || lane.key(rows[0]) === id(2)
        ? unavailable
        : { data: rows.length, error: null }
    );
    expect(await lane.flush(service)).toEqual({ flushed: 2, failed: 1 });
    expect(lane.dirty(mind)).toBe(1);
    transport.rpc
      .mockReset()
      .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
    expect(await lane.flush(service)).toEqual({ flushed: 1, failed: 0 });
    expect(lane.key(onlyRow(lane))).toBe(id(2));
  });

  it('keeps the 400-row boundary and does not revisit requeued rows in the same call', async () => {
    for (let n = 1; n <= 401; n++) lane.seed(mind, id(n), n);
    transport.rpc.mockResolvedValue(unavailable);
    expect(await lane.flush(service)).toEqual({ flushed: 0, failed: 401 });
    const sizes = calls(lane).map((rows) => rows.length);
    expect(sizes).toHaveLength(403); // ceil(401/400) chunks plus 401 individual attempts
    expect(sizes[0]).toBe(400);
    expect(sizes.slice(1).every((size) => size === 1)).toBe(true);
    expect(lane.dirty(mind)).toBe(401);
    expect(transport.report).toHaveBeenCalledTimes(2);
  });

  it('retains a permanent refusal without blocking healthy rows or multiplying retry keys', async () => {
    lane.seed(mind, id(1), 3);
    for (let round = 0; round < 3; round++) {
      lane.seed(mind, id(2), round + 1);
      transport.rpc
        .mockReset()
        .mockImplementation(async (_name, { rows }) =>
          rows.length > 1 || lane.key(rows[0]) === id(1)
            ? permanent
            : { data: rows.length, error: null }
        );
      expect(await lane.flush(service)).toEqual({ flushed: 1, failed: 1 });
      expect(calls(lane).map((rows) => rows.length)).toEqual([2, 1, 1]);
      expect(lane.dirty(mind)).toBe(1);
    }
    expect(transport.report).toHaveBeenCalledTimes(3);
  });

  it('retries the latest memory after learning changes during a failed snapshot', async () => {
    lane.seed(mind, id(1), 1);
    const gate = pending();
    transport.rpc.mockImplementationOnce(() => gate.promise).mockResolvedValue(unavailable);
    const flush = lane.flush(service);
    lane.seed(mind, id(1), 9);
    gate.finish(unavailable);
    expect(await flush).toEqual({ flushed: 0, failed: 1 });
    expect(lane.dirty(mind)).toBe(1);
    transport.rpc
      .mockReset()
      .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
    await lane.flush(service);
    expect(lane.counter(onlyRow(lane))).toBe(9);
  });

  it('does not clear newer dirty memory when the older snapshot succeeds', async () => {
    lane.seed(mind, id(1), 1);
    const gate = pending();
    transport.rpc.mockImplementationOnce(() => gate.promise);
    const flush = lane.flush(service);
    lane.seed(mind, id(1), 6);
    gate.finish({ data: 1, error: null });
    expect(await flush).toEqual({ flushed: 1, failed: 0 });
    expect(lane.dirty(mind)).toBe(1);
    expect(lane.counter(calls(lane)[0][0])).toBe(1);
    await lane.flush(service);
    expect(lane.counter(onlyRow(lane))).toBe(6);
  });

  it('conservatively requeues current keys after a newer overlapping flush succeeded', async () => {
    lane.seed(mind, id(1), 1);
    const gate = pending();
    transport.rpc.mockImplementationOnce(() => gate.promise);
    const older = lane.flush(service);
    lane.seed(mind, id(1), 8);
    expect(await lane.flush(service)).toEqual({ flushed: 1, failed: 0 });
    transport.rpc.mockResolvedValue(unavailable);
    gate.finish(unavailable);
    expect(await older).toEqual({ flushed: 0, failed: 1 });
    expect(lane.dirty(mind)).toBe(1);
    transport.rpc
      .mockReset()
      .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
    await lane.flush(service);
    expect(lane.counter(onlyRow(lane))).toBe(8);
  });

  it('does not resurrect memory cleared while the snapshot was in flight', async () => {
    lane.seed(mind, id(1), 5);
    const gate = pending();
    transport.rpc.mockImplementationOnce(() => gate.promise).mockResolvedValue(unavailable);
    const flush = lane.flush(service);
    mind.reset();
    gate.finish(unavailable);
    expect(await flush).toEqual({ flushed: 0, failed: 1 });
    expect(lane.dirty(mind)).toBe(0);
    expect(await lane.flush(service)).toEqual({ flushed: 0, failed: 0 });
  });

  it('retries unchanged failed rows on the next existing timer interval', async () => {
    lane.seed(mind, id(1), 2);
    transport.rpc.mockResolvedValue(unavailable);
    service.startHorseMindPersistence();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls(lane)).toHaveLength(2);
    expect(lane.dirty(mind)).toBe(1);
    transport.rpc
      .mockReset()
      .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
    await vi.advanceTimersByTimeAsync(299_999);
    expect(calls(lane)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls(lane)).toHaveLength(1);
    expect(lane.counter(onlyRow(lane))).toBe(2);
    expect(lane.dirty(mind)).toBe(0);
  });

  it('retains failed final-stop rows in memory without a new timer or repeated stop retry', async () => {
    lane.seed(mind, id(1), 2);
    transport.rpc.mockResolvedValue(permanent);
    service.startHorseMindPersistence();
    await service.stopHorseMindPersistence();
    expect(calls(lane)).toHaveLength(2);
    expect(lane.dirty(mind)).toBe(1); // still volatile: not a durable shutdown claim
    await service.stopHorseMindPersistence();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls(lane)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('joins an in-flight timer failure before the final stop flush consumes retained keys', async () => {
    lane.seed(mind, id(1), 2);
    const gate = pending();
    transport.rpc.mockImplementationOnce(() => gate.promise).mockResolvedValueOnce(unavailable);
    service.startHorseMindPersistence();
    vi.advanceTimersByTime(300_000);
    const stopping = service.stopHorseMindPersistence();
    expect(calls(lane)).toHaveLength(1);
    gate.finish(unavailable);
    await stopping;
    expect(calls(lane).map((rows) => rows.length)).toEqual([1, 1, 1]);
    expect(lane.dirty(mind)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('shared observation and lifecycle controls', () => {
  it('keeps import free of persistence RPCs and persistence timers', () => {
    expect(transport.rpc).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries all three actual observed memory exports without replaying the hand', async () => {
    const history: ActionRecord[] = [
      { seat: 1, userId: victim, action: 'raise', amount: 6, timestamp: 1000, stage: 'preflop' },
      { seat: 2, userId: id(1), action: 'raise', amount: 20, timestamp: 1001, stage: 'preflop' },
      { seat: 1, userId: victim, action: 'fold', amount: 0, timestamp: 1002, stage: 'preflop' },
    ];
    mind.setDecisionScope('holdem:hu');
    mind.observe(history, []);
    mind.setDecisionScope(null);
    const dirty = [mind.dirtyCount(), mind.dirtyPairsCount(), mind.dirtyScopedCount()];
    expect(dirty).toEqual([2, 1, 2]);
    transport.rpc.mockResolvedValue(unavailable);
    const failed = await Promise.all(lanes.map((lane) => lane.flush(service)));
    expect(failed.map((r) => r.failed)).toEqual(dirty);
    transport.rpc
      .mockReset()
      .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
    const retried = await Promise.all(lanes.map((lane) => lane.flush(service)));
    expect(retried.map((r) => r.flushed)).toEqual(dirty);
    expect(calls(lanes[0])[0].map((r) => r.hands)).toEqual([1, 1]);
    expect(onlyRow(lanes[1])).toMatchObject({ n3: 1, opp3: 1 });
    expect(calls(lanes[2])[0].map((r) => r.scope)).toEqual(['holdem:hu', 'holdem:hu']);
  });

  it('retains a failing lane while the other two progress through the real timer', async () => {
    for (const lane of lanes) lane.seed(mind, id(1), 4);
    transport.rpc.mockImplementation(async (name, { rows }) =>
      name === lanes[1].rpc ? unavailable : { data: rows.length, error: null }
    );
    service.startHorseMindPersistence();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(lanes.map((lane) => lane.dirty(mind))).toEqual([0, 1, 0]);
    expect(lanes.map((lane) => calls(lane).length)).toEqual([1, 2, 1]);
    transport.rpc
      .mockReset()
      .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(lanes.map((lane) => calls(lane).length)).toEqual([0, 1, 0]);
  });
});

const unconfirmedReceipts: Array<{ name: string; data: unknown }> = [
  { name: 'null', data: null },
  { name: 'missing', data: undefined },
  { name: 'zero', data: 0 },
  { name: 'negative', data: -1 },
  { name: 'overreported', data: 2 },
  { name: 'fractional', data: 1.5 },
  { name: 'numeric string', data: '1' },
  { name: 'array', data: [1] },
  { name: 'object', data: { count: 1 } },
  { name: 'boolean', data: true },
  { name: 'NaN', data: Number.NaN },
  { name: 'infinite', data: Number.POSITIVE_INFINITY },
];

describe.each(lanes)('$name processed-row receipts', (lane) => {
  it.each(unconfirmedReceipts)(
    'retains an unconfirmed $name chunk without immediate replay',
    async ({ data }) => {
      lane.seed(mind, id(1), 7);
      transport.rpc.mockResolvedValue({ data, error: null });
      expect(await lane.flush(service)).toEqual({ flushed: 0, failed: 1 });
      expect(calls(lane)).toHaveLength(1);
      expect(lane.dirty(mind)).toBe(1);
      expect(transport.report).toHaveBeenCalledTimes(1);
      expect(transport.report.mock.calls[0][0]).toEqual(
        new Error('horse_mind_persistence_receipt_unconfirmed')
      );
      transport.rpc
        .mockReset()
        .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
      expect(await lane.flush(service)).toEqual({ flushed: 1, failed: 0 });
      expect(lane.counter(onlyRow(lane))).toBe(7);
      expect(lane.dirty(mind)).toBe(0);
    }
  );

  it.each(unconfirmedReceipts)(
    'retains an unconfirmed $name individual after an explicit chunk error',
    async ({ data }) => {
      lane.seed(mind, id(1), 5);
      transport.rpc.mockResolvedValueOnce(unavailable).mockResolvedValue({ data, error: null });
      expect(await lane.flush(service)).toEqual({ flushed: 0, failed: 1 });
      expect(calls(lane).map((rows) => rows.length)).toEqual([1, 1]);
      expect(lane.dirty(mind)).toBe(1);
      // Original chunk failure is reported once; no private response is logged.
      expect(transport.report).toHaveBeenCalledTimes(1);
    }
  );

  it('retains every key when a partial count cannot identify the omitted row', async () => {
    lane.seed(mind, id(1), 2);
    lane.seed(mind, id(2), 4);
    transport.rpc.mockResolvedValue({ data: 1, error: null });
    expect(await lane.flush(service)).toEqual({ flushed: 0, failed: 2 });
    expect(calls(lane).map((rows) => rows.length)).toEqual([2]);
    expect(lane.dirty(mind)).toBe(2);
    lane.seed(mind, id(2), 9);
    transport.rpc
      .mockReset()
      .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
    expect(await lane.flush(service)).toEqual({ flushed: 2, failed: 0 });
    expect(calls(lane)[0].map(lane.counter)).toEqual([2, 9]);
  });

  it('does not accept an overreported chunk as a complete write', async () => {
    lane.seed(mind, id(1), 2);
    lane.seed(mind, id(2), 4);
    transport.rpc.mockResolvedValue({ data: 3, error: null });
    expect(await lane.flush(service)).toEqual({ flushed: 0, failed: 2 });
    expect(calls(lane)).toHaveLength(1);
    expect(lane.dirty(mind)).toBe(2);
  });

  it('retains current memory after an older write returns no qualified receipt', async () => {
    lane.seed(mind, id(1), 1);
    const gate = pending();
    transport.rpc.mockImplementationOnce(() => gate.promise);
    const oldFlush = lane.flush(service);
    lane.seed(mind, id(1), 8);
    gate.finish({ data: 0, error: null });
    expect(await oldFlush).toEqual({ flushed: 0, failed: 1 });
    expect(calls(lane)).toHaveLength(1);
    expect(lane.dirty(mind)).toBe(1);
    expect(await lane.flush(service)).toEqual({ flushed: 1, failed: 0 });
    expect(lane.counter(onlyRow(lane))).toBe(8);
  });

  it('does not recreate reset memory after an unconfirmed receipt', async () => {
    lane.seed(mind, id(1), 3);
    const gate = pending();
    transport.rpc.mockImplementationOnce(() => gate.promise);
    const flushing = lane.flush(service);
    mind.reset();
    gate.finish({ data: 0, error: null });
    expect(await flushing).toEqual({ flushed: 0, failed: 1 });
    expect(lane.dirty(mind)).toBe(0);
    expect(calls(lane)).toHaveLength(1);
    expect(await lane.flush(service)).toEqual({ flushed: 0, failed: 0 });
  });

  it('keeps exact individual successes while retaining an unconfirmed sibling', async () => {
    lane.seed(mind, id(1), 2);
    lane.seed(mind, id(2), 3);
    transport.rpc.mockImplementation(async (_name, { rows }) =>
      rows.length > 1 ? unavailable : { data: lane.key(rows[0]) === id(1) ? 1 : 0, error: null }
    );
    expect(await lane.flush(service)).toEqual({ flushed: 1, failed: 1 });
    expect(calls(lane).map((rows) => rows.length)).toEqual([2, 1, 1]);
    expect(lane.dirty(mind)).toBe(1);
    transport.rpc
      .mockReset()
      .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
    expect(await lane.flush(service)).toEqual({ flushed: 1, failed: 0 });
    expect(lane.key(onlyRow(lane))).toBe(id(2));
  });

  it('gives an explicit transport error precedence over a matching count', async () => {
    lane.seed(mind, id(1), 4);
    transport.rpc.mockResolvedValue({ data: 1, error: unavailable.error });
    expect(await lane.flush(service)).toEqual({ flushed: 0, failed: 1 });
    expect(calls(lane)).toHaveLength(2);
    expect(lane.dirty(mind)).toBe(1);
  });

  it('uses the next existing timer cycle for an unconfirmed batch', async () => {
    lane.seed(mind, id(1), 6);
    transport.rpc.mockResolvedValue({ data: 0, error: null });
    service.startHorseMindPersistence();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls(lane)).toHaveLength(1);
    expect(lane.dirty(mind)).toBe(1);
    transport.rpc
      .mockReset()
      .mockImplementation(async (_name, { rows }) => ({ data: rows.length, error: null }));
    await vi.advanceTimersByTimeAsync(299_999);
    expect(calls(lane)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls(lane)).toHaveLength(1);
    expect(lane.dirty(mind)).toBe(0);
  });

  it('keeps final-stop uncertainty volatile without restarting a timer', async () => {
    lane.seed(mind, id(1), 6);
    transport.rpc.mockResolvedValue({ data: 0, error: null });
    service.startHorseMindPersistence();
    await service.stopHorseMindPersistence();
    expect(calls(lane)).toHaveLength(1);
    expect(lane.dirty(mind)).toBe(1);
    await service.stopHorseMindPersistence();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls(lane)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('receipt boundaries across actual memory lanes', () => {
  it('keeps a bad receipt lane dirty while exact receipts advance its neighbors', async () => {
    for (const lane of lanes) lane.seed(mind, id(1), 3);
    transport.rpc.mockImplementation(async (name, { rows }) => ({
      data: name === lanes[1].rpc ? 0 : rows.length,
      error: null,
    }));
    expect(await Promise.all(lanes.map((lane) => lane.flush(service)))).toEqual([
      { flushed: 1, failed: 0 },
      { flushed: 0, failed: 1 },
      { flushed: 1, failed: 0 },
    ]);
    expect(lanes.map((lane) => lane.dirty(mind))).toEqual([0, 1, 0]);
    expect(lanes.map((lane) => calls(lane).length)).toEqual([1, 1, 1]);
  });

  it('accepts exact counts at the existing 400-row chunk boundary', async () => {
    for (const lane of lanes) for (let n = 1; n <= 401; n++) lane.seed(mind, id(n), n);
    expect(await Promise.all(lanes.map((lane) => lane.flush(service)))).toEqual(
      lanes.map(() => ({ flushed: 401, failed: 0 }))
    );
    for (const lane of lanes) expect(calls(lane).map((rows) => rows.length)).toEqual([400, 1]);
    expect(lanes.map((lane) => lane.dirty(mind))).toEqual([0, 0, 0]);
  });
});

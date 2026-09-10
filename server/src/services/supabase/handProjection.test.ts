/**
 * Accepted-hand projection is deliberately outside the money transaction,
 * but it is not best effort: the transaction creates a durable outbox claim
 * and every process-wide wake (local commit, LISTEN, Realtime, the 5 s safety
 * poll) drains those claims in hand-number order.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from '../../testHelpers/sourceWindow.js';
import {
  currentTournamentDataAuthority,
  dataActorHeaders,
  runWithTournamentDataAuthority,
} from './dataActorContext.js';

type OutboxReply = {
  data: Array<{ hand_id: string; table_id?: string; hand_number: number }> | null;
  error: unknown;
};
type RpcReply = { data: unknown; error: unknown };

const outboxReplies: Array<OutboxReply | Promise<OutboxReply>> = [];
const projectionReplies: RpcReply[] = [];
/** Replies keyed by p_hand_id, consulted before the FIFO queue; a promise holds the RPC open. */
const projectionRepliesById = new Map<string, RpcReply | Promise<RpcReply>>();
/** Concurrency observed at the fake RPC: how many fn_project_hand_side_effects calls were open at once. */
const rpcInFlight = { now: 0, max: 0 };
const queryCalls: Array<{
  table: string;
  columns?: string;
  after?: number;
  ascending?: boolean;
  limit?: number;
}> = [];
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const requestActors: string[] = [];
const channels: FakeChannel[] = [];
const removedChannels: FakeChannel[] = [];

type StatusCallback = (status: string) => void;

class FakeChannel {
  changeCallback: (() => void) | null = null;
  statusCallback: StatusCallback | null = null;
  filter: Record<string, unknown> | null = null;

  on(_kind: string, filter: Record<string, unknown>, callback: () => void): this {
    this.filter = filter;
    this.changeCallback = callback;
    return this;
  }

  subscribe(callback: StatusCallback): this {
    this.statusCallback = callback;
    return this;
  }
}

vi.mock('./client.js', () => ({
  supabase: {
    from: (table: string) => {
      requestActors.push(dataActorHeaders().get('x-smarter-data-actor')!);
      const call = { table } as (typeof queryCalls)[number];
      queryCalls.push(call);
      const query = {
        select(columns: string) {
          call.columns = columns;
          return query;
        },
        gt(_column: string, value: number) {
          call.after = value;
          return query;
        },
        order(_column: string, options: { ascending: boolean }) {
          call.ascending = options.ascending;
          return query;
        },
        limit(value: number) {
          call.limit = value;
          return Promise.resolve(outboxReplies.shift() ?? { data: [], error: null });
        },
      };
      return query;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      requestActors.push(dataActorHeaders().get('x-smarter-data-actor')!);
      rpcCalls.push({ fn, args });
      rpcInFlight.now++;
      rpcInFlight.max = Math.max(rpcInFlight.max, rpcInFlight.now);
      try {
        const byId = projectionRepliesById.get(String(args.p_hand_id));
        if (byId) {
          projectionRepliesById.delete(String(args.p_hand_id));
          return await byId;
        }
        return (
          projectionReplies.shift() ?? {
            data: { ok: false, reason: 'missing_test_reply' },
            error: null,
          }
        );
      } finally {
        rpcInFlight.now--;
      }
    },
    channel: () => {
      const channel = new FakeChannel();
      channels.push(channel);
      return channel;
    },
    removeChannel: async (channel: FakeChannel) => {
      removedChannels.push(channel);
      return 'ok';
    },
  },
}));

const mockReportError = vi.fn();
vi.mock('../errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

const worker = await import('./handProjection.js');

beforeEach(async () => {
  await worker.stopHandProjectionWorker();
  outboxReplies.length = 0;
  projectionReplies.length = 0;
  projectionRepliesById.clear();
  rpcInFlight.now = 0;
  rpcInFlight.max = 0;
  vi.unstubAllEnvs();
  queryCalls.length = 0;
  rpcCalls.length = 0;
  channels.length = 0;
  removedChannels.length = 0;
  mockReportError.mockReset();
  worker.startHandProjectionWorker();
  await vi.waitFor(() => expect(queryCalls).toHaveLength(1));
  queryCalls.length = 0;
  rpcCalls.length = 0;
  mockReportError.mockReset();
  requestActors.length = 0;
});

describe('the accepted-hand projection worker', () => {
  it('drains durable claims in hand-number order and classifies concurrent ownership', async () => {
    outboxReplies.push({
      data: [
        { hand_id: 'h-101', hand_number: 101 },
        { hand_id: 'h-102', hand_number: 102 },
        { hand_id: 'h-103', hand_number: 103 },
      ],
      error: null,
    });
    projectionReplies.push(
      { data: { ok: true, hand_id: 'h-101' }, error: null },
      { data: { ok: false, reason: 'not_pending' }, error: null },
      { data: { ok: false, reason: 'predecessor_pending' }, error: null }
    );

    const summary = await worker.wakeHandProjection();

    expect(summary).toEqual({ projected: 1, alreadyCompleted: 1, deferred: 1, failed: 0 });
    expect(queryCalls).toEqual([
      {
        table: 'hand_projection_outbox',
        columns: 'hand_id,table_id,hand_number',
        after: 0,
        ascending: true,
        limit: 100,
      },
    ]);
    expect(rpcCalls).toEqual([
      { fn: 'fn_project_hand_side_effects', args: { p_hand_id: 'h-101' } },
      { fn: 'fn_project_hand_side_effects', args: { p_hand_id: 'h-102' } },
      { fn: 'fn_project_hand_side_effects', args: { p_hand_id: 'h-103' } },
    ]);
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('names semantic and transport failures instead of deleting or calling them complete', async () => {
    // Two tables: a refusal at one table stops only that table's chain.
    outboxReplies.push({
      data: [
        { hand_id: 'h-201', table_id: 't-a', hand_number: 201 },
        { hand_id: 'h-202', table_id: 't-b', hand_number: 202 },
      ],
      error: null,
    });
    projectionRepliesById.set('h-201', {
      data: { ok: false, reason: 'projection_refused' },
      error: null,
    });
    projectionRepliesById.set('h-202', { data: null, error: { message: 'transport unavailable' } });

    await expect(worker.wakeHandProjection()).resolves.toEqual({
      projected: 0,
      alreadyCompleted: 0,
      deferred: 0,
      failed: 2,
    });
    expect(mockReportError.mock.calls.map((call) => call[1]).sort()).toEqual([
      'HandProjection.rpc_failed',
      'HandProjection.semantic_refusal',
    ]);
  });

  it('coalesces simultaneous signals, then performs one follow-up drain so no wake is lost', async () => {
    let releaseFirst!: (reply: OutboxReply) => void;
    const firstReply = new Promise<OutboxReply>((resolve) => {
      releaseFirst = resolve;
    });
    outboxReplies.push(firstReply, { data: [], error: null });

    const first = worker.wakeHandProjection();
    const joined = worker.wakeHandProjection();
    expect(joined).toBe(first);

    releaseFirst({ data: [], error: null });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryCalls).toHaveLength(2);
    expect(rpcCalls).toHaveLength(0);
  });

  it('continues after its bounded work budget without waiting for another notification', async () => {
    for (let page = 0; page < 10; page++) {
      outboxReplies.push({
        data: Array.from({ length: 100 }, (_, index) => {
          const handNumber = page * 100 + index + 1;
          return { hand_id: `h-${handNumber}`, hand_number: handNumber };
        }),
        error: null,
      });
    }
    outboxReplies.push({ data: [], error: null });
    projectionReplies.push(
      ...Array.from({ length: 1_000 }, (_, index) => ({
        data: { ok: true, hand_id: `h-${index + 1}` },
        error: null,
      }))
    );

    await expect(worker.wakeHandProjection()).resolves.toEqual({
      projected: 1_000,
      alreadyCompleted: 0,
      deferred: 0,
      failed: 0,
    });
    await vi.waitFor(() => expect(queryCalls).toHaveLength(11));

    expect(rpcCalls).toHaveLength(1_000);
    expect(queryCalls[10]).toMatchObject({ after: 0, limit: 100 });
  });

  it('subscribes before startup drain and removes the exact channel on stop', async () => {
    outboxReplies.push(
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null }
    );

    expect(channels).toHaveLength(1);
    expect(channels[0].filter).toEqual({
      event: 'INSERT',
      schema: 'public',
      table: 'hand_projection_outbox',
    });

    channels[0].statusCallback?.('SUBSCRIBED');
    channels[0].changeCallback?.();
    await worker.wakeHandProjection();
    await worker.stopHandProjectionWorker();

    expect(removedChannels).toEqual([channels[0]]);
  });

  it('retries a transiently failed durable row without requiring another insert', async () => {
    vi.useFakeTimers();
    try {
      outboxReplies.push(
        { data: [{ hand_id: 'h-301', hand_number: 301 }], error: null },
        { data: [{ hand_id: 'h-301', hand_number: 301 }], error: null }
      );
      projectionReplies.push(
        { data: null, error: { message: 'connection reset' } },
        { data: { ok: true, hand_id: 'h-301' }, error: null }
      );

      await expect(worker.wakeHandProjection()).resolves.toMatchObject({ failed: 1 });
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(rpcCalls).toHaveLength(2));

      expect(rpcCalls.map((call) => call.args.p_hand_id)).toEqual(['h-301', 'h-301']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a dependency-deferred row without requiring a later-row wake', async () => {
    vi.useFakeTimers();
    try {
      outboxReplies.push(
        { data: [{ hand_id: 'h-401', hand_number: 401 }], error: null },
        { data: [{ hand_id: 'h-401', hand_number: 401 }], error: null }
      );
      projectionReplies.push(
        { data: { ok: false, reason: 'predecessor_pending' }, error: null },
        { data: { ok: true, hand_id: 'h-401' }, error: null }
      );

      await expect(worker.wakeHandProjection()).resolves.toMatchObject({ deferred: 1 });
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(rpcCalls).toHaveLength(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the exact retry generation and joins active work on stop', async () => {
    vi.useFakeTimers();
    try {
      outboxReplies.push({
        data: [{ hand_id: 'h-501', hand_number: 501 }],
        error: null,
      });
      projectionReplies.push({ data: null, error: { message: 'connection reset' } });

      await expect(worker.wakeHandProjection()).resolves.toMatchObject({ failed: 1 });
      await worker.stopHandProjectionWorker();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(rpcCalls).toHaveLength(1);
      await expect(worker.wakeHandProjection()).resolves.toEqual({
        projected: 0,
        alreadyCompleted: 0,
        deferred: 0,
        failed: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the 5 s safety poll is the only interval and it yields to a running drain and an armed retry', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./handProjection.ts', import.meta.url)),
      'utf8'
    );
    const executable = blankNonCode(source);
    // One interval: the safety poll. The causal retry stays the one setTimeout.
    expect(executable.match(/\bsetInterval\s*\(/g)).toHaveLength(1);
    expect(executable.match(/\bsetTimeout\s*\(/g)).toHaveLength(1);
    expect(source).toContain('if (!workerActive || stopping) return;');
    expect(source).toContain('drainRunning: drainPromise !== null,');
    expect(source).toContain('retryArmed: retryTimer !== null,');
    expect(source).toContain('causalRetryOwed = summary.failed > 0 || summary.deferred > 0');
    expect(source).toContain('cancelCausalRetry(true)');
  });

  it('pollIsDue: a running drain always wins, an armed retry wins only while it can still fire', () => {
    const pollMs = worker.HAND_PROJECTION_POLL_MS;
    expect(
      worker.pollIsDue({
        drainRunning: true,
        retryArmed: false,
        msSinceLastDrainStart: 1e9,
        pollMs,
      })
    ).toBe(false);
    expect(
      worker.pollIsDue({ drainRunning: false, retryArmed: false, msSinceLastDrainStart: 0, pollMs })
    ).toBe(true);
    // An armed retry fires within 15 s (RETRY_MAX_MS); it holds the poll off for that plus two intervals.
    expect(
      worker.pollIsDue({
        drainRunning: false,
        retryArmed: true,
        msSinceLastDrainStart: 15_000 + 2 * pollMs,
        pollMs,
      })
    ).toBe(false);
    // Past that bound no drain has started, so the retry is not doing its job and the poll drains anyway.
    expect(
      worker.pollIsDue({
        drainRunning: false,
        retryArmed: true,
        msSinceLastDrainStart: 15_000 + 2 * pollMs + 1,
        pollMs,
      })
    ).toBe(true);
  });

  it('the poll interval and drain concurrency read their env vars with safe bounds', () => {
    // HAND_PROJECTION_POLL_MS is fixed at import: 5 s by default, never 0 (a
    // copied empty .env.example line is Number("") === 0).
    expect(worker.HAND_PROJECTION_POLL_MS).toBe(5_000);
    expect(worker.HAND_PROJECTION_DRAIN_CONCURRENCY_DEFAULT).toBe(4);
    vi.stubEnv('HAND_PROJECTION_DRAIN_CONCURRENCY', '');
    expect(worker.handProjectionDrainConcurrency()).toBe(4);
    vi.stubEnv('HAND_PROJECTION_DRAIN_CONCURRENCY', 'lots');
    expect(worker.handProjectionDrainConcurrency()).toBe(4);
    vi.stubEnv('HAND_PROJECTION_DRAIN_CONCURRENCY', '0');
    expect(worker.handProjectionDrainConcurrency()).toBe(1);
    vi.stubEnv('HAND_PROJECTION_DRAIN_CONCURRENCY', '999');
    expect(worker.handProjectionDrainConcurrency()).toBe(
      worker.HAND_PROJECTION_DRAIN_CONCURRENCY_MAX
    );
    vi.stubEnv('HAND_PROJECTION_DRAIN_CONCURRENCY', '2');
    expect(worker.handProjectionDrainConcurrency()).toBe(2);
    expect(worker.handProjectionWakesToPrometheus()).toContain(
      'poker_hand_projection_drain_concurrency 2'
    );
  });

  it('start() twice arms one poll interval; stop() then start() arms a fresh one', async () => {
    await worker.stopHandProjectionWorker();
    channels.length = 0;
    vi.useFakeTimers();
    try {
      worker.startHandProjectionWorker();
      worker.startHandProjectionWorker();
      await vi.advanceTimersByTimeAsync(0);
      expect(channels).toHaveLength(1);
      queryCalls.length = 0;
      const before = worker.handProjectionWakeCounts().poll;
      await vi.advanceTimersByTimeAsync(worker.HAND_PROJECTION_POLL_MS);
      // One interval, one wake, one read - not two of each.
      expect(worker.handProjectionWakeCounts().poll).toBe(before + 1);
      expect(queryCalls).toHaveLength(1);

      // The :55 restart cycle in one process: stop, then start again.
      await worker.stopHandProjectionWorker();
      worker.startHandProjectionWorker();
      await vi.advanceTimersByTimeAsync(0);
      queryCalls.length = 0;
      await vi.advanceTimersByTimeAsync(worker.HAND_PROJECTION_POLL_MS * 2);
      expect(worker.handProjectionWakeCounts().poll).toBe(before + 3);
      expect(queryCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a wake during a drain is kept as a follow-up drain, not dropped', async () => {
    let release!: (reply: OutboxReply) => void;
    outboxReplies.push(
      new Promise<OutboxReply>((resolve) => {
        release = resolve;
      }),
      { data: [{ hand_id: 'h-follow', hand_number: 7 }], error: null }
    );
    projectionReplies.push({ data: { ok: true, hand_id: 'h-follow' }, error: null });

    const running = worker.wakeHandProjection('local');
    const joined = worker.wakeHandProjection('poll');
    expect(joined).toBe(running);
    release({ data: [], error: null });
    await running;
    // The row committed during the first drain is projected by the follow-up
    // pass the second wake queued, with no further signal.
    await vi.waitFor(() => expect(rpcCalls.map((c) => c.args.p_hand_id)).toEqual(['h-follow']));
    expect(queryCalls).toHaveLength(2);
  });

  it('counts every wake by source on the metrics registry', async () => {
    // Each drain's completion callback releases the worker one macrotask after
    // the summary resolves; yield so the next wake starts its own drain rather
    // than joining the previous one.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const before = worker.handProjectionWakeCounts();
    await worker.wakeHandProjection('listen');
    await settle();
    await worker.wakeHandProjection('listen_resync');
    await settle();
    await worker.wakeHandProjection();
    await settle();
    const after = worker.handProjectionWakeCounts();

    expect(after.listen).toBe(before.listen + 1);
    expect(after.listen_resync).toBe(before.listen_resync + 1);
    expect(after.local).toBe(before.local + 1);
    expect(after.startup).toBeGreaterThanOrEqual(1);
    // A LISTEN wake drains the same outbox the local wake does.
    expect(queryCalls.map((call) => call.table)).toEqual([
      'hand_projection_outbox',
      'hand_projection_outbox',
      'hand_projection_outbox',
    ]);

    const lines = worker.handProjectionWakesToPrometheus();
    expect(lines[0]).toContain('# HELP poker_hand_projection_wakes_total');
    expect(lines).toContain(`poker_hand_projection_wakes_total{source="listen"} ${after.listen}`);
    expect(lines).toContain(`poker_hand_projection_wakes_total{source="poll"} ${after.poll}`);
    expect(lines).toContain(
      `poker_hand_projection_wakes_total{source="realtime"} ${after.realtime}`
    );
  });

  it('polls every 5 s only while no drain is running', async () => {
    await worker.stopHandProjectionWorker();
    vi.useFakeTimers();
    try {
      worker.startHandProjectionWorker();
      await vi.advanceTimersByTimeAsync(0);
      queryCalls.length = 0;
      const before = worker.handProjectionWakeCounts().poll;

      // Idle: one poll wake per interval, each one bounded read of an empty outbox.
      await vi.advanceTimersByTimeAsync(worker.HAND_PROJECTION_POLL_MS - 1);
      expect(worker.handProjectionWakeCounts().poll).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(worker.handProjectionWakeCounts().poll).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(worker.HAND_PROJECTION_POLL_MS);
      expect(worker.handProjectionWakeCounts().poll).toBe(before + 2);
      expect(queryCalls).toHaveLength(2);
      expect(rpcCalls).toHaveLength(0);

      // Busy: a drain that has not returned owns the outbox; the poll stays out.
      let release!: (reply: OutboxReply) => void;
      outboxReplies.push(
        new Promise<OutboxReply>((resolve) => {
          release = resolve;
        })
      );
      const drain = worker.wakeHandProjection();
      await vi.advanceTimersByTimeAsync(worker.HAND_PROJECTION_POLL_MS * 4);
      expect(worker.handProjectionWakeCounts().poll).toBe(before + 2);
      release({ data: [], error: null });
      await drain;
      await vi.advanceTimersByTimeAsync(0);

      // Idle again: the poll resumes.
      await vi.advanceTimersByTimeAsync(worker.HAND_PROJECTION_POLL_MS);
      expect(worker.handProjectionWakeCounts().poll).toBe(before + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the poll never resets an armed causal retry backoff', async () => {
    await worker.stopHandProjectionWorker();
    vi.useFakeTimers();
    try {
      worker.startHandProjectionWorker();
      await vi.advanceTimersByTimeAsync(0);
      queryCalls.length = 0;
      const before = worker.handProjectionWakeCounts().poll;

      // Six consecutive transport failures on one durable row arm retries at
      // 250, 500, 1000, 2000, 4000 and 8000 ms. Across those 15.75 s the poll
      // interval elapses three times and must not fire once, or the backoff
      // would collapse to 5 s forever.
      for (let i = 0; i < 6; i++) {
        outboxReplies.push({ data: [{ hand_id: 'h-601', hand_number: 601 }], error: null });
        projectionReplies.push({ data: null, error: { message: 'connection reset' } });
      }
      await expect(worker.wakeHandProjection()).resolves.toMatchObject({ failed: 1 });
      await vi.advanceTimersByTimeAsync(15_750);
      expect(rpcCalls).toHaveLength(6);
      expect(worker.handProjectionWakeCounts().poll).toBe(before);

      // Once the row commits and no retry is armed, the poll resumes.
      outboxReplies.push({ data: [{ hand_id: 'h-601', hand_number: 601 }], error: null });
      projectionReplies.push({ data: { ok: true, hand_id: 'h-601' }, error: null });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(rpcCalls).toHaveLength(7);
      await vi.advanceTimersByTimeAsync(worker.HAND_PROJECTION_POLL_MS * 2);
      expect(worker.handProjectionWakeCounts().poll).toBeGreaterThanOrEqual(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() clears the poll so a stopped worker never reads the outbox again', async () => {
    await worker.stopHandProjectionWorker();
    vi.useFakeTimers();
    try {
      worker.startHandProjectionWorker();
      await vi.advanceTimersByTimeAsync(0);
      await worker.stopHandProjectionWorker();
      queryCalls.length = 0;
      const before = worker.handProjectionWakeCounts().poll;
      await vi.advanceTimersByTimeAsync(worker.HAND_PROJECTION_POLL_MS * 5);
      expect(queryCalls).toHaveLength(0);
      expect(worker.handProjectionWakeCounts().poll).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the drain projects one ordered chain per table, N tables at a time', () => {
  const deferred = () => {
    let resolve!: (reply: RpcReply) => void;
    const promise = new Promise<RpcReply>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('keeps hand_number order inside a table and never exceeds the configured concurrency', async () => {
    vi.stubEnv('HAND_PROJECTION_DRAIN_CONCURRENCY', '2');
    outboxReplies.push({
      data: [
        { hand_id: 'A1', table_id: 'A', hand_number: 1 },
        { hand_id: 'B2', table_id: 'B', hand_number: 2 },
        { hand_id: 'A3', table_id: 'A', hand_number: 3 },
        { hand_id: 'C4', table_id: 'C', hand_number: 4 },
        { hand_id: 'B5', table_id: 'B', hand_number: 5 },
        { hand_id: 'A6', table_id: 'A', hand_number: 6 },
        { hand_id: 'D7', table_id: 'D', hand_number: 7 },
      ],
      error: null,
    });
    const gates = new Map<string, ReturnType<typeof deferred>>();
    for (const id of ['A1', 'B2', 'A3', 'C4', 'B5', 'A6', 'D7']) {
      const gate = deferred();
      gates.set(id, gate);
      projectionRepliesById.set(id, gate.promise);
    }
    const started = () => rpcCalls.map((c) => String(c.args.p_hand_id));

    const drain = worker.wakeHandProjection();
    await settle();
    // Two lanes: the first row of table A and the first row of table B are in
    // flight; A3 waits for A1 and C4 waits for a free lane.
    expect(started()).toEqual(['A1', 'B2']);
    expect(rpcInFlight.now).toBe(2);

    gates.get('B2')!.resolve({ data: { ok: true }, error: null });
    await settle();
    expect(started()).toEqual(['A1', 'B2', 'B5']);
    expect(rpcInFlight.now).toBe(2);

    gates.get('A1')!.resolve({ data: { ok: true }, error: null });
    await settle();
    expect(started()).toEqual(['A1', 'B2', 'B5', 'A3']);

    gates.get('B5')!.resolve({ data: { ok: true }, error: null });
    await settle();
    expect(started()).toEqual(['A1', 'B2', 'B5', 'A3', 'C4']);

    gates.get('A3')!.resolve({ data: { ok: true }, error: null });
    gates.get('C4')!.resolve({ data: { ok: true }, error: null });
    await settle();
    expect(started()).toEqual(['A1', 'B2', 'B5', 'A3', 'C4', 'A6', 'D7']);
    gates.get('A6')!.resolve({ data: { ok: true }, error: null });
    gates.get('D7')!.resolve({ data: { ok: true }, error: null });

    await expect(drain).resolves.toEqual({
      projected: 7,
      alreadyCompleted: 0,
      deferred: 0,
      failed: 0,
    });
    expect(rpcInFlight.max).toBe(2);
    // Inside every table the RPCs were issued in ascending hand_number.
    const byTable = new Map<string, number[]>();
    for (const call of rpcCalls) {
      const id = String(call.args.p_hand_id);
      const list = byTable.get(id[0]) ?? [];
      list.push(Number(id.slice(1)));
      byTable.set(id[0], list);
    }
    for (const numbers of byTable.values()) {
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    }
  });

  it('a failed hand stops only its own table; later rows of that table are deferred without a round-trip', async () => {
    vi.stubEnv('HAND_PROJECTION_DRAIN_CONCURRENCY', '4');
    outboxReplies.push({
      data: [
        { hand_id: 'A1', table_id: 'A', hand_number: 1 },
        { hand_id: 'B2', table_id: 'B', hand_number: 2 },
        { hand_id: 'A3', table_id: 'A', hand_number: 3 },
        { hand_id: 'A4', table_id: 'A', hand_number: 4 },
        { hand_id: 'B5', table_id: 'B', hand_number: 5 },
      ],
      error: null,
    });
    projectionRepliesById.set('A1', { data: null, error: { message: 'connection reset' } });
    projectionRepliesById.set('B2', { data: { ok: true }, error: null });
    projectionRepliesById.set('B5', { data: { ok: true }, error: null });

    await expect(worker.wakeHandProjection()).resolves.toEqual({
      projected: 2,
      alreadyCompleted: 0,
      deferred: 2,
      failed: 1,
    });
    expect(rpcCalls.map((c) => c.args.p_hand_id).sort()).toEqual(['A1', 'B2', 'B5']);
    expect(mockReportError.mock.calls.map((call) => call[1])).toEqual([
      'HandProjection.rpc_failed',
    ]);
    // The pass owes a causal retry for table A; the retry re-reads the outbox.
    outboxReplies.push({ data: [], error: null });
    await vi.waitFor(() => expect(queryCalls).toHaveLength(2), { timeout: 2_000 });
  });

  it('a dependency-deferred hand blocks its table across pages of the same pass', async () => {
    vi.stubEnv('HAND_PROJECTION_DRAIN_CONCURRENCY', '4');
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      hand_id: `T${i + 1}`,
      table_id: i === 0 ? 'A' : `X${i}`,
      hand_number: i + 1,
    }));
    outboxReplies.push(
      { data: page1, error: null },
      { data: [{ hand_id: 'A101', table_id: 'A', hand_number: 101 }], error: null }
    );
    projectionRepliesById.set('T1', {
      data: { ok: false, reason: 'predecessor_pending' },
      error: null,
    });
    for (let i = 2; i <= 100; i++)
      projectionRepliesById.set(`T${i}`, { data: { ok: true }, error: null });

    await expect(worker.wakeHandProjection()).resolves.toEqual({
      projected: 99,
      alreadyCompleted: 0,
      deferred: 2,
      failed: 0,
    });
    expect(rpcCalls.map((c) => c.args.p_hand_id)).not.toContain('A101');
    expect(queryCalls.map((c) => c.after)).toEqual([0, 100]);
  });

  it('a hand another process already finished does not stop its table', async () => {
    vi.stubEnv('HAND_PROJECTION_DRAIN_CONCURRENCY', '1');
    outboxReplies.push({
      data: [
        { hand_id: 'A1', table_id: 'A', hand_number: 1 },
        { hand_id: 'A2', table_id: 'A', hand_number: 2 },
      ],
      error: null,
    });
    projectionRepliesById.set('A1', { data: { ok: false, reason: 'not_pending' }, error: null });
    projectionRepliesById.set('A2', { data: { ok: true }, error: null });
    await expect(worker.wakeHandProjection()).resolves.toEqual({
      projected: 1,
      alreadyCompleted: 1,
      deferred: 0,
      failed: 0,
    });
    expect(rpcCalls.map((c) => c.args.p_hand_id)).toEqual(['A1', 'A2']);
  });

  it('counts every outcome on the metrics registry', async () => {
    const before = worker.handProjectionDrainResultCounts();
    outboxReplies.push({
      data: [
        { hand_id: 'A1', table_id: 'A', hand_number: 1 },
        { hand_id: 'B2', table_id: 'B', hand_number: 2 },
      ],
      error: null,
    });
    projectionRepliesById.set('A1', { data: { ok: true }, error: null });
    projectionRepliesById.set('B2', { data: { ok: false, reason: 'not_pending' }, error: null });
    await worker.wakeHandProjection();
    const after = worker.handProjectionDrainResultCounts();
    expect(after.projected).toBe(before.projected + 1);
    expect(after.already_completed).toBe(before.already_completed + 1);
    const lines = worker.handProjectionWakesToPrometheus();
    expect(lines).toContain(
      `poker_hand_projection_drain_results_total{result="projected"} ${after.projected}`
    );
    expect(lines.some((l) => l.startsWith('poker_hand_projection_drains_total '))).toBe(true);
  });

  it('stop() during a fan-out drain lets in-flight RPCs finish and starts no new chain', async () => {
    vi.stubEnv('HAND_PROJECTION_DRAIN_CONCURRENCY', '1');
    outboxReplies.push({
      data: [
        { hand_id: 'A1', table_id: 'A', hand_number: 1 },
        { hand_id: 'B2', table_id: 'B', hand_number: 2 },
      ],
      error: null,
    });
    const gate = deferred();
    projectionRepliesById.set('A1', gate.promise);
    projectionRepliesById.set('B2', { data: { ok: true }, error: null });
    const drain = worker.wakeHandProjection();
    await settle();
    expect(rpcCalls.map((c) => c.args.p_hand_id)).toEqual(['A1']);
    const stopped = worker.stopHandProjectionWorker();
    gate.resolve({ data: { ok: true }, error: null });
    await stopped;
    await expect(drain).resolves.toMatchObject({ projected: 1 });
    expect(rpcCalls.map((c) => c.args.p_hand_id)).toEqual(['A1']);
    worker.startHandProjectionWorker();
    await vi.waitFor(() => expect(queryCalls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('projection worker owns its request context', () => {
  const authority = {
    tournamentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    leaseGeneration: '11111111-1111-4111-8111-111111111111',
  };
  it('a tournament wake cannot lend its lease to the global projection drain', async () => {
    outboxReplies.push({
      data: [{ hand_id: 'h-other-tournament', hand_number: 901 }],
      error: null,
    });
    projectionReplies.push({ data: { ok: true }, error: null });
    await runWithTournamentDataAuthority(authority, async () => {
      const result = await worker.wakeHandProjection();
      expect(result.projected).toBe(1);
      expect(currentTournamentDataAuthority()).toEqual(authority);
    });
    expect(requestActors).toEqual(['service', 'service']);
    expect(currentTournamentDataAuthority()).toBeNull();
  });
  it('a manager cannot establish a new service worker owner', async () => {
    await worker.stopHandProjectionWorker();
    requestActors.length = 0;
    expect(() =>
      runWithTournamentDataAuthority(authority, () => worker.startHandProjectionWorker())
    ).toThrow('must start outside tournament authority');
    await expect(worker.wakeHandProjection()).resolves.toMatchObject({ projected: 0 });
    expect(requestActors).toEqual([]);
    worker.startHandProjectionWorker();
    await vi.waitFor(() => expect(requestActors).toEqual(['service']));
  });

  it('a retry caused by a tournament wake retains worker ownership after the caller returns', async () => {
    outboxReplies.push(
      { data: [{ hand_id: 'h-retry', hand_number: 902 }], error: null },
      { data: [{ hand_id: 'h-retry', hand_number: 902 }], error: null }
    );
    projectionReplies.push(
      { data: null, error: { message: 'temporary failure' } },
      { data: { ok: true }, error: null }
    );
    await runWithTournamentDataAuthority(authority, () => worker.wakeHandProjection());
    await vi.waitFor(() => expect(rpcCalls).toHaveLength(2));
    expect(requestActors).toEqual(['service', 'service', 'service', 'service']);
  });
});

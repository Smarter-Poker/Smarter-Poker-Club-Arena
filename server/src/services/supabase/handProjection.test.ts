/**
 * Accepted-hand projection is deliberately outside the money transaction,
 * but it is not best effort: the transaction creates a durable outbox claim
 * and every process-wide wake drains those claims in hand-number order.
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
  data: Array<{ hand_id: string; hand_number: number }> | null;
  error: unknown;
};
type RpcReply = { data: unknown; error: unknown };

const outboxReplies: Array<OutboxReply | Promise<OutboxReply>> = [];
const projectionReplies: RpcReply[] = [];
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
      return (
        projectionReplies.shift() ?? {
          data: { ok: false, reason: 'missing_test_reply' },
          error: null,
        }
      );
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
        columns: 'hand_id,hand_number',
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
    outboxReplies.push({
      data: [
        { hand_id: 'h-201', hand_number: 201 },
        { hand_id: 'h-202', hand_number: 202 },
      ],
      error: null,
    });
    projectionReplies.push(
      { data: { ok: false, reason: 'projection_refused' }, error: null },
      { data: null, error: { message: 'transport unavailable' } }
    );

    await expect(worker.wakeHandProjection()).resolves.toEqual({
      projected: 0,
      alreadyCompleted: 0,
      deferred: 0,
      failed: 2,
    });
    expect(mockReportError.mock.calls.map((call) => call[1])).toEqual([
      'HandProjection.semantic_refusal',
      'HandProjection.rpc_failed',
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

  it('contains no periodic polling loop as a substitute for transaction correctness', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./handProjection.ts', import.meta.url)),
      'utf8'
    );
    const executable = blankNonCode(source);
    expect(executable).not.toMatch(/\bsetInterval\s*\(/);
    expect(executable.match(/\bsetTimeout\s*\(/g)).toHaveLength(1);
    expect(source).toContain('causalRetryOwed = summary.failed > 0 || summary.deferred > 0');
    expect(source).toContain('cancelCausalRetry(true)');
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

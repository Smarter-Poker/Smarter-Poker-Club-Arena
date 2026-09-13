import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueAdaptiveJournalWork as enqueue,
  processAdaptiveJournalWork as processOne,
} from './HorseAdaptiveJournalWork.js';
import { prepareAdaptiveJournalBatch } from './HorseAdaptiveObservationJournal.js';
import type { CommittedObservationSnapshot } from './HorseCommittedObservationSnapshot.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mocks.rpc } }));
const now = Date.UTC(2026, 8, 13, 18);
// An empty retained snapshot is valid work; it must never invent observations.
const source = (): CommittedObservationSnapshot => ({
  status: 'snapshot',
  version: 1,
  actorKey: 'a'.repeat(64),
  source: {
    coverage: 'retained_committed_roster_rows',
    fromMs: now - 1000,
    throughMs: now,
    readAtMs: now,
    snapshotId: '1:1:',
    hands: 0,
    sourceBytes: 0,
    sourceDigest: 'b'.repeat(64),
  },
  observations: [],
  rejected: {},
});
function batch() {
  const b = prepareAdaptiveJournalBatch(source());
  if (b.status !== 'prepared') throw Error('fixture');
  return b;
}
type Request = { name: string; args: Record<string, unknown>; signal: AbortSignal };
const trace: Request[] = [];
let handler: (r: Request) => unknown;
const good = (r: Request) => {
  const b = batch();
  if (r.name === 'fn_queue_horse_adaptive_batch') return { version: 1, ...b, status: 'durable' };
  if (r.name === 'fn_claim_horse_adaptive_batch')
    return { version: 1, ...b, status: 'claimed', leaseToken: r.args.p_lease_token };
  if (r.name === 'fn_append_horse_adaptive_observations')
    return { version: 1, ...b, status: 'recorded' };
  if (r.name === 'fn_finish_horse_adaptive_batch')
    return {
      version: 1,
      batchKey: b.batchKey,
      status:
        r.args.p_outcome === 'recorded'
          ? 'completed'
          : r.args.p_outcome === 'unknown'
            ? 'deferred'
            : 'quarantined',
    };
  throw Error('Unexpected RPC');
};
beforeEach(() => {
  trace.length = 0;
  handler = good;
  mocks.rpc.mockImplementation((name, args) => ({
    abortSignal: async (signal: AbortSignal) => {
      const r = { name, args, signal };
      trace.push(r);
      return { data: await handler(r), error: null };
    },
  }));
});
afterEach(() => vi.clearAllMocks());
describe('durable adaptive journal work boundary', () => {
  it('records exact prepared bytes before any journal write and verifies the durable receipt', async () => {
    const b = batch();
    expect(await enqueue(source())).toEqual({
      status: 'durable',
      batchKey: b.batchKey,
      batchDigest: b.batchDigest,
      observations: 0,
    });
    expect(trace.map((r) => r.name)).toEqual(['fn_queue_horse_adaptive_batch']);
    expect(trace[0].args).toEqual({ p_payload: b.payload });
    expect(trace[0].signal).toBeInstanceOf(AbortSignal);
  });
  it.each(['capacity_busy', 'queue_full', 'batch_conflict', 'legacy_batch_payload_unavailable'])(
    'preserves %s without writing or claiming source completeness',
    async (reason) => {
      handler = () => ({ version: 1, status: 'unavailable', reason });
      expect(await enqueue(source())).toEqual({ status: 'unavailable', reason });
      expect(trace).toHaveLength(1);
    }
  );
  it('keeps a lost enqueue reply unknown', async () => {
    handler = () => {
      throw Error('lost response');
    };
    expect(await enqueue(source())).toMatchObject({ status: 'unknown' });
  });
  it('refuses an incorrect enqueue receipt', async () => {
    handler = (r) => ({ ...good(r), batchDigest: 'c'.repeat(64) });
    expect(await enqueue(source())).toMatchObject({ status: 'unknown' });
  });
  it('rejects an unavailable source before enqueueing', async () => {
    expect(await enqueue({ status: 'unavailable', reason: 'source_unavailable' })).toMatchObject({
      status: 'unavailable',
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('runs one claimed batch through the real journal boundary and exact completion acknowledgment', async () => {
    expect(await processOne()).toEqual({ status: 'completed', batchKey: batch().batchKey });
    expect(trace.map((r) => r.name)).toEqual([
      'fn_claim_horse_adaptive_batch',
      'fn_append_horse_adaptive_observations',
      'fn_finish_horse_adaptive_batch',
    ]);
    expect(trace[1].args.p_batch).toBe(batch().payload);
    expect(trace[2].args).toEqual({
      p_batch_key: batch().batchKey,
      p_lease_token: trace[0].args.p_lease_token,
      p_outcome: 'recorded',
    });
    for (const r of trace) expect(r.signal).toBeInstanceOf(AbortSignal);
  });
  it('returns idle without reading history or submitting a write', async () => {
    handler = () => ({ version: 1, status: 'idle' });
    expect(await processOne()).toEqual({ status: 'idle' });
    expect(trace).toHaveLength(1);
  });
  it.each(['token', 'key', 'digest', 'count', 'payload', 'status'])(
    'leaves a malformed claim %s for a fresh read instead of writing or quarantining it',
    async (kind) => {
      handler = (r) => {
        const data = good(r) as Record<string, unknown>;
        if (kind === 'token') data.leaseToken = 'different';
        if (kind === 'key') data.batchKey = 'wrong';
        if (kind === 'digest') data.batchDigest = 'c'.repeat(64);
        if (kind === 'count') data.observations = 1;
        if (kind === 'payload') data.payload = '{}';
        if (kind === 'status') data.status = 'complete';
        return data;
      };
      expect(await processOne()).toEqual({ status: 'unavailable', reason: 'invalid_claim' });
      expect(trace).toHaveLength(1);
    }
  );
  it('keeps claim transport failures unavailable', async () => {
    handler = () => {
      throw Error('connection lost');
    };
    expect(await processOne()).toEqual({ status: 'unavailable', reason: 'claim_unavailable' });
  });
  it('defers a lost journal reply instead of asserting rollback or completion', async () => {
    handler = (r) => {
      if (r.name === 'fn_append_horse_adaptive_observations') throw Error('committed reply lost');
      return good(r);
    };
    expect(await processOne()).toEqual({ status: 'deferred', batchKey: batch().batchKey });
    expect(trace[2].args.p_outcome).toBe('unknown');
  });
  it('quarantines only a known database rejection', async () => {
    mocks.rpc.mockImplementation((name, args) => ({
      abortSignal: async (signal: AbortSignal) => {
        const r = { name, args, signal };
        trace.push(r);
        return name === 'fn_append_horse_adaptive_observations'
          ? {
              data: null,
              error: { code: 'P0001', message: 'ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT' },
            }
          : { data: good(r), error: null };
      },
    }));
    expect(await processOne()).toEqual({ status: 'quarantined', batchKey: batch().batchKey });
    expect(trace[2].args.p_outcome).toBe('rejected');
  });
  it.each(['lost', 'wrong_key', 'wrong_status'])(
    'keeps an acknowledgment %s unknown after a successful journal write',
    async (kind) => {
      handler = (r) => {
        if (r.name !== 'fn_finish_horse_adaptive_batch') return good(r);
        if (kind === 'lost') throw Error('ack lost');
        return {
          ...good(r),
          ...(kind === 'wrong_key' ? { batchKey: 'c'.repeat(64) } : { status: 'deferred' }),
        };
      };
      expect(await processOne()).toEqual({ status: 'unknown', batchKey: batch().batchKey });
    }
  );
  it('accepts a lease-loss refusal without retrying or overriding the new worker', async () => {
    handler = (r) =>
      r.name === 'fn_finish_horse_adaptive_batch'
        ? { version: 1, status: 'lease_lost', batchKey: batch().batchKey }
        : good(r);
    expect(await processOne()).toEqual({ status: 'lease_lost', batchKey: batch().batchKey });
    expect(trace).toHaveLength(3);
  });
});

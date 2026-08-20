/**
 * hand_history write path — retry, idempotency, and the background queue.
 *
 * Why these invariants: hand_history writes go to ZERO platform-wide for
 * 30-120s at a time under load while the much smaller atomic_distribute_rake
 * RPC still gets through. Measured over 3 days on 2026-08-20: 320 rake rows
 * banked with a null hand_id, 315 of them for hands with no hand_history row in
 * existence — all 320 landing inside 32 distinct minutes, 291 of those inside
 * 14 minutes that had 5+ failures, peaking at 57 in one minute across 44
 * different tables. Before this change a single timeout lost the hand forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── A minimal chainable PostgREST double ────────────────────────────────────
interface Call {
  table: string;
  op: 'insert' | 'select';
  filters: Record<string, unknown>;
  row?: Record<string, unknown>;
}

const calls: Call[] = [];
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

/** Queue of results the NEXT inserts will produce, oldest first. */
let insertResults: { data: unknown; error: unknown }[] = [];
/** What a hand_number existence lookup finds. */
let existingByHandNumber: Record<number, string> = {};

function builder(table: string) {
  const call: Call = { table, op: 'select', filters: {} };
  const api: Record<string, unknown> = {};
  const chain = () => api;
  api.insert = (row: Record<string, unknown>) => {
    call.op = 'insert';
    call.row = row;
    calls.push(call);
    return api;
  };
  api.select = () => api;
  api.update = (row: Record<string, unknown>) => {
    call.op = 'insert';
    call.row = row;
    return api;
  };
  api.eq = (col: string, val: unknown) => {
    call.filters[col] = val;
    return chain();
  };
  api.is = (col: string, val: unknown) => {
    call.filters[col] = val;
    return chain();
  };
  api.order = () => chain();
  api.limit = () => chain();
  api.maybeSingle = async () => {
    if (call.op === 'insert') {
      const next = insertResults.shift() ?? { data: { id: 'inserted' }, error: null };
      return next;
    }
    calls.push(call);
    const hn = call.filters['hand_number'] as number | undefined;
    const found = hn !== undefined ? existingByHandNumber[hn] : undefined;
    return { data: found ? { id: found } : null, error: null };
  };
  return api;
}

vi.mock('./client.js', () => ({
  supabase: {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: 1, error: null };
    },
  },
}));

const mockReportError = vi.fn();
vi.mock('../errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

import {
  logHandHistory,
  drainHandHistoryQueue,
  handHistoryQueueDepth,
  buildHandHistoryTiers,
} from './handHistory.js';

const GLOBAL_HAND = 1_400_001;

function params(handNumber = GLOBAL_HAND) {
  return {
    tableId: '11111111-1111-1111-1111-111111111111',
    handNumber,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    potSize: 40,
    rakeAmount: 2,
    communityCards: ['As', 'Kd', '7c'],
    winners: [{ userId: 'u1', amount: 38 }],
    players: [
      { userId: 'u1', username: 'A', seat: 1, stack: 100, cards: [] },
      { userId: 'u2', username: 'B', seat: 2, stack: 100, cards: [] },
    ],
    actions: [
      { seat: 1, userId: 'u1', action: 'bet', amount: 20, stage: 'flop' },
      { seat: 2, userId: 'u2', action: 'fold', stage: 'flop' },
    ],
  };
}

const inserts = () => calls.filter((c) => c.op === 'insert' && c.table === 'hand_history');

beforeEach(async () => {
  // Empty any queue left over from a previous test.
  for (let i = 0; i < 5 && handHistoryQueueDepth() > 0; i++) {
    existingByHandNumber = { ...existingByHandNumber };
    insertResults = [];
    await drainHandHistoryQueue();
  }
  calls.length = 0;
  rpcCalls.length = 0;
  insertResults = [];
  existingByHandNumber = {};
  mockReportError.mockReset();
});

describe('logHandHistory', () => {
  it('writes ONE row — the guaranteed-400 4-tier attempt is gone', async () => {
    const res = await logHandHistory(params());

    expect(res.handId).toBe('inserted');
    expect(inserts()).toHaveLength(1);
    // For four months every hand posted these four columns to a table that has
    // never had them: a 400 followed by a 201, ~238,000 failing requests a day.
    const row = inserts()[0].row!;
    expect(row).not.toHaveProperty('raw_events');
    expect(row).not.toHaveProperty('audit_log');
    expect(row).not.toHaveProperty('player_summaries');
    expect(row).not.toHaveProperty('dispute_review');
    expect(row.hand_number).toBe(GLOBAL_HAND);
  });

  it('retries a transient failure instead of losing the hand', async () => {
    insertResults = [{ data: null, error: { message: 'fetch failed' } }];

    const res = await logHandHistory(params());

    expect(res.handId).toBe('inserted');
    expect(inserts()).toHaveLength(2);
    expect(handHistoryQueueDepth()).toBe(0);
  });

  it('does not duplicate the hand when the write landed but the response was lost', async () => {
    // 4 of the 320 measured failures were exactly this: the hand_history row
    // exists, written BEFORE the rake row, and the rake row still got a null id.
    insertResults = [{ data: null, error: { message: 'socket hang up' } }];
    existingByHandNumber[GLOBAL_HAND] = 'already-there';

    const res = await logHandHistory(params());

    expect(res.handId).toBe('already-there');
    expect(inserts()).toHaveLength(1); // never re-inserted
  });

  it('queues the payload when every in-line attempt fails, and reports it', async () => {
    insertResults = [
      { data: null, error: { message: 'timeout' } },
      { data: null, error: { message: 'timeout' } },
      { data: null, error: { message: 'timeout' } },
    ];

    const res = await logHandHistory(params());

    expect(res.handId).toBeNull();
    expect(handHistoryQueueDepth()).toBe(1);
    expect(mockReportError).toHaveBeenCalled();
    expect(String(mockReportError.mock.calls[0][1])).toContain('logHandHistory.insert_failed');
  });

  it('drains the queue later and relinks the rake row to the recovered hand', async () => {
    insertResults = [
      { data: null, error: { message: 'timeout' } },
      { data: null, error: { message: 'timeout' } },
      { data: null, error: { message: 'timeout' } },
    ];
    await logHandHistory(params());
    expect(handHistoryQueueDepth()).toBe(1);

    calls.length = 0;
    insertResults = [{ data: { id: 'late-id' }, error: null }];
    const summary = await drainHandHistoryQueue();

    expect(summary.written).toBe(1);
    expect(handHistoryQueueDepth()).toBe(0);
    // Without this the money stays unattributable — the open financial_alerts
    // signal that started the whole investigation.
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('fn_relink_rake_record_to_hand');
    expect(rpcCalls[0].args).toMatchObject({
      p_hand_number: GLOBAL_HAND,
      p_hand_id: 'late-id',
    });
  });

  it('never retries a hand number below the global floor — it is not unique', async () => {
    // uq_hand_history_global_hand_number only covers hand_number >= 1000000.
    // Retrying below that could duplicate the hand instead of deduping it.
    insertResults = [{ data: null, error: { message: 'timeout' } }];

    const res = await logHandHistory(params(42));

    expect(res.handId).toBeNull();
    expect(inserts()).toHaveLength(1);
    expect(handHistoryQueueDepth()).toBe(0);
  });
});

describe('buildHandHistoryTiers (Bible V8 §2.18, derived not stored)', () => {
  it('produces all four tiers from a stored hand', () => {
    const tiers = buildHandHistoryTiers({ ...params(), showdownResults: [] });

    expect(tiers.raw_events).toHaveLength(2);
    expect(tiers.raw_events[0]).toMatchObject({ seq: 0, seat: 1, action: 'bet', amount: 20 });
    expect(tiers.audit_log).toMatchObject({ hand_number: GLOBAL_HAND, pot_size: 40, rake: 2 });
    expect(tiers.player_summaries).toHaveLength(2);
    expect(tiers.player_summaries[0]).toMatchObject({ userId: 'u1', netResult: 38 });
    expect(tiers.player_summaries[1]).toMatchObject({ userId: 'u2', folded: true, netResult: 0 });
    // Tier 4 is the other three plus the showdown material — which is exactly
    // why storing it would have tripled the largest payload on the platform.
    expect(tiers.dispute_review.raw_events).toEqual(tiers.raw_events);
    expect(tiers.dispute_review.player_summaries).toEqual(tiers.player_summaries);
  });
});

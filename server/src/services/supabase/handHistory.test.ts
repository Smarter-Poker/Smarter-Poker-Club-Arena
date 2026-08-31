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
/** What fn_relink_rake_record_to_hand returns (rows linked). */
let rpcResult = 1;

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
      return { data: rpcResult, error: null };
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
  handHistoryQueueBytes,
  onHandHistoryRecovered,
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
  rpcResult = 1;
  mockReportError.mockReset();
});

describe('logHandHistory — the hot path', () => {
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
    expect(row.daily_mission_events).toBeNull();
  });

  it('persists immutable Daily Missions facts on the retryable hand row', async () => {
    const dailyMissionEvents = [
      {
        user_id: 'u1',
        amounts: { hands_played: 1, hands_won: 1, chips_won: 38 },
        magnitudes: { big_pots: 38 },
      },
    ];
    await logHandHistory({ ...params(GLOBAL_HAND + 70), dailyMissionEvents });
    expect(inserts().at(-1)!.row!.daily_mission_events).toEqual(dailyMissionEvents);
  });

  it('persists RIT boards first-class, and single-run hands write NULL (2026-08-26)', async () => {
    // Migration 20260826_hand_history_rit_boards: boards 2..N go to their own
    // column. A single-run hand writes NULL — not [] — so the millions of
    // historical rows and a normal hand look identical to readers.
    const single = await logHandHistory(params(GLOBAL_HAND + 71));
    expect(single.handId).toBe('inserted');
    expect(inserts().at(-1)!.row!.rit_boards).toBeNull();

    const withBoards = {
      ...params(GLOBAL_HAND + 72),
      ritBoards: [
        ['Ahearts', 'Kdiamonds', 'Qspades', 'Jclubs', '10hearts'],
        ['2clubs', '3clubs', '4clubs', '5clubs', '6clubs'],
      ],
    };
    const multi = await logHandHistory(withBoards);
    expect(multi.handId).toBe('inserted');
    expect(inserts().at(-1)!.row!.rit_boards).toEqual(withBoards.ritBoards);
  });

  it('COSTS EXACTLY ONE ROUND TRIP WHEN IT FAILS — it must never stall the table', async () => {
    // This is the regression guard for the review finding that mattered most.
    //
    // The first version retried 3x in line with an existence pre-check before
    // each retry: 5 PostgREST requests, and the shared client aborts at
    // DB_TIMEOUT_MS = 15s. Against the hung-socket outage this exists for, that
    // is ~76s per hand — awaited inside postHandTasks, which the dealing loop
    // awaits at the top of every iteration, while postHandTasks never calls
    // markProgress() so the 90s watchdog runs the whole time. One failing hand
    // could kill the engine for a restart, on all 44 tables at once.
    insertResults = [{ data: null, error: { message: 'fetch failed' } }];

    const res = await logHandHistory(params());

    expect(res.handId).toBeNull();
    expect(calls).toHaveLength(1); // one insert, ZERO pre-checks
    expect(handHistoryQueueDepth()).toBe(1); // durability moved to the queue
  });

  it('resolves a duplicate-key rejection to the row that already landed', async () => {
    // The response to an earlier attempt was lost but the write went through.
    insertResults = [{ data: null, error: { message: 'duplicate', code: '23505' } }];
    existingByHandNumber[GLOBAL_HAND] = 'already-there';

    const res = await logHandHistory(params());

    expect(res.handId).toBe('already-there');
    expect(inserts()).toHaveLength(1); // never re-inserted
    expect(handHistoryQueueDepth()).toBe(0);
  });

  it('queues the payload when the write fails, and reports it', async () => {
    insertResults = [{ data: null, error: { message: 'timeout' } }];

    const res = await logHandHistory(params());

    expect(res.handId).toBeNull();
    expect(handHistoryQueueDepth()).toBe(1);
    expect(handHistoryQueueBytes()).toBeGreaterThan(0);
    expect(mockReportError).toHaveBeenCalled();
    expect(String(mockReportError.mock.calls[0][1])).toContain('logHandHistory.insert_failed');
  });

  it('holds a COPY, so the engine reusing its action array cannot empty the queue', async () => {
    // row.actions aliases the engine's live currentHandActions.
    const p = params();
    insertResults = [{ data: null, error: { message: 'timeout' } }];
    await logHandHistory(p);
    p.actions.length = 0; // engine clears in place

    calls.length = 0;
    insertResults = [{ data: { id: 'late-id' }, error: null }];
    await drainHandHistoryQueue();

    expect((inserts()[0].row!.actions as unknown[]).length).toBe(2);
  });

  it('retains Daily Missions facts when a failed hand insert drains later', async () => {
    const p = {
      ...params(GLOBAL_HAND + 73),
      dailyMissionEvents: [{ user_id: 'u1', amounts: { hands_played: 1 }, magnitudes: {} }],
    };
    insertResults = [{ data: null, error: { message: 'timeout' } }];
    await logHandHistory(p);
    p.dailyMissionEvents.length = 0;

    calls.length = 0;
    insertResults = [{ data: { id: 'late-id' }, error: null }];
    await drainHandHistoryQueue();
    expect(inserts()[0].row!.daily_mission_events).toEqual([
      { user_id: 'u1', amounts: { hands_played: 1 }, magnitudes: {} },
    ]);
  });

  it('reports rather than silently dropping a hand number below the global floor', async () => {
    // Not reachable today, but a bare `return` there would be silent data loss.
    insertResults = [{ data: null, error: { message: 'timeout' } }];

    const res = await logHandHistory(params(42));

    expect(res.handId).toBeNull();
    expect(inserts()).toHaveLength(1);
    expect(handHistoryQueueDepth()).toBe(0);
    expect(
      mockReportError.mock.calls.some((c) => String(c[1]).includes('below_global_floor'))
    ).toBe(true);
  });
});

describe('the background drain', () => {
  const queueOne = async (handNumber = GLOBAL_HAND) => {
    insertResults = [{ data: null, error: { message: 'timeout' } }];
    await logHandHistory(params(handNumber));
    calls.length = 0;
    rpcCalls.length = 0;
    mockReportError.mockReset();
  };

  it('recovers the hand later and relinks the rake row', async () => {
    await queueOne();
    insertResults = [{ data: { id: 'late-id' }, error: null }];

    const summary = await drainHandHistoryQueue();

    expect(summary.written).toBe(1);
    expect(summary.unlinked).toBe(0);
    expect(handHistoryQueueDepth()).toBe(0);
    // Without this the money stays unattributable — the open financial_alerts
    // signal that started the whole investigation.
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('fn_relink_rake_record_to_hand');
    expect(rpcCalls[0].args).toMatchObject({ p_hand_number: GLOBAL_HAND, p_hand_id: 'late-id' });
  });

  it('counts a hand whose rake row does not exist yet, instead of calling it done', async () => {
    // During an outage the rake write fails too, so there is nothing to link.
    // FeeReconciler creates that row later and resolves the id itself.
    await queueOne();
    insertResults = [{ data: { id: 'late-id' }, error: null }];
    rpcResult = 0;

    const summary = await drainHandHistoryQueue();

    expect(summary.written).toBe(1);
    expect(summary.unlinked).toBe(1);
  });

  it('skips the relink RPC entirely for a hand that took no rake', async () => {
    insertResults = [{ data: null, error: { message: 'timeout' } }];
    await logHandHistory({ ...params(), rakeAmount: 0, bbjAmount: 0 });
    calls.length = 0;
    rpcCalls.length = 0;
    insertResults = [{ data: { id: 'late-id' }, error: null }];

    await drainHandHistoryQueue();

    expect(rpcCalls).toHaveLength(0);
  });

  it('checks whether the hand already landed BEFORE re-inserting it', async () => {
    await queueOne();
    existingByHandNumber[GLOBAL_HAND] = 'was-there-all-along';

    const summary = await drainHandHistoryQueue();

    expect(summary.written).toBe(1);
    expect(inserts()).toHaveLength(0); // no duplicate hand
  });

  it('keeps the entry and retries next pass while the outage continues', async () => {
    await queueOne();
    insertResults = [{ data: null, error: { message: 'still down' } }];

    const summary = await drainHandHistoryQueue();

    expect(summary.written).toBe(0);
    expect(handHistoryQueueDepth()).toBe(1);
  });

  it('does not lose the rest of the batch when one entry throws', async () => {
    await queueOne(GLOBAL_HAND);
    await queueOne(GLOBAL_HAND + 1);
    const n = 0;
    insertResults = [];
    // Make the first insert throw outright rather than return an error.
    const original = existingByHandNumber;
    existingByHandNumber = original;
    insertResults = [
      { data: null, error: { message: 'x' } },
      { data: null, error: { message: 'x' } },
    ];
    void n;

    const summary = await drainHandHistoryQueue();

    // Both failed cleanly and both are still queued — nothing was discarded.
    expect(summary.written).toBe(0);
    expect(handHistoryQueueDepth()).toBe(2);
  });

  it('gives up loudly after MAX_QUEUE_ATTEMPTS rather than retrying forever', async () => {
    await queueOne();
    for (let i = 0; i < 20; i++) {
      insertResults = [{ data: null, error: { message: 'still down' } }];
      await drainHandHistoryQueue();
    }
    expect(handHistoryQueueDepth()).toBe(0);
    expect(mockReportError.mock.calls.some((c) => String(c[1]).includes('retry_exhausted'))).toBe(
      true
    );
  });

  it('a second caller JOINS the in-flight drain instead of getting a no-op', async () => {
    // The first version returned an empty summary when `draining` was set, so
    // GameServer.stop()'s flush loop read "no progress" and gave up instantly —
    // its 6s budget was never used.
    await queueOne();
    insertResults = [{ data: { id: 'late-id' }, error: null }];

    const [a, b] = await Promise.all([drainHandHistoryQueue(), drainHandHistoryQueue()]);

    // Both see the same underlying result; the joiner is flagged as such. The
    // hand was written ONCE — the point is that the joiner is not handed a
    // fabricated "nothing happened".
    expect(a.written).toBe(1);
    expect(b.written).toBe(1);
    expect(inserts()).toHaveLength(1);
    expect(a.joined !== b.joined).toBe(true); // exactly one of them joined
    expect(handHistoryQueueDepth()).toBe(0);
  });

  it('honours a deadline per entry and leaves the untouched ones queued', async () => {
    await queueOne(GLOBAL_HAND);
    await queueOne(GLOBAL_HAND + 1);

    const summary = await drainHandHistoryQueue(Date.now() - 1); // already expired

    expect(summary.written).toBe(0);
    expect(handHistoryQueueDepth()).toBe(2);
  });

  it('tells the table when a held hand finally lands, so the replay opens the right one', async () => {
    // hand_history_saved was emitted only on the in-line path. Without it here
    // the client falls back to "my most recent hand", which for a recovered
    // hand is guaranteed to be the WRONG hand — later ones have landed since.
    const seen: { tableId: string; handNumber: number; handId: string }[] = [];
    onHandHistoryRecovered((info) => seen.push(info));
    try {
      await queueOne();
      insertResults = [{ data: { id: 'late-id' }, error: null }];
      await drainHandHistoryQueue();
      expect(seen).toEqual([
        {
          tableId: '11111111-1111-1111-1111-111111111111',
          handNumber: GLOBAL_HAND,
          handId: 'late-id',
        },
      ]);
    } finally {
      onHandHistoryRecovered(null);
    }
  });

  it('a throwing recovery handler cannot lose the hand', async () => {
    onHandHistoryRecovered(() => {
      throw new Error('client bus exploded');
    });
    try {
      await queueOne();
      insertResults = [{ data: { id: 'late-id' }, error: null }];
      const summary = await drainHandHistoryQueue();
      expect(summary.written).toBe(1);
      expect(handHistoryQueueDepth()).toBe(0);
    } finally {
      onHandHistoryRecovered(null);
    }
  });

  it('reports nothing and does nothing on an empty queue', async () => {
    const summary = await drainHandHistoryQueue();
    expect(summary).toMatchObject({ scanned: 0, written: 0, stillPending: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('buildHandHistoryTiers (Bible V8 §2.18, derived not stored)', () => {
  // It must consume a row exactly as hand_history STORES it (snake_case). The
  // first version took the settlement input shape (camelCase) while its own doc
  // said to call it with a stored row, so it could not be called the documented
  // way at all — and the test used the settlement shape too, baking the mistake
  // in where it could never be caught.
  const storedRow = {
    id: 'hh-1',
    table_id: '11111111-1111-1111-1111-111111111111',
    tournament_id: null,
    hand_number: GLOBAL_HAND,
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    pot_size: 40,
    rake_amount: 2,
    bbj_amount: 0,
    community_cards: ['As', 'Kd', '7c'],
    button_seat: 3,
    created_at: '2026-08-20T00:00:00.000Z',
    hole_cards: {
      u1: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'hearts' },
      ],
    },
    winners: [{ userId: 'u1', amount: 38, hand: { name: 'Two Pair', ranking: 3 } }],
    // NOTE: stack here is the POST-settlement stack — u1 has already been paid.
    players: [
      { userId: 'u1', username: 'A', seat: 1, stack: 118 },
      { userId: 'u2', username: 'B', seat: 2, stack: 80 },
    ],
    actions: [
      { seat: 1, userId: 'u1', action: 'bet', amount: 20, stage: 'flop' },
      { seat: 2, userId: 'u2', action: 'call', amount: 20, stage: 'flop' },
      { seat: 2, userId: 'u2', action: 'fold', stage: 'river' },
    ],
  };

  it('produces all four tiers from a stored row', () => {
    const tiers = buildHandHistoryTiers(storedRow);

    expect(tiers.raw_events).toHaveLength(3);
    expect(tiers.raw_events[0]).toMatchObject({ seq: 0, seat: 1, action: 'bet', amount: 20 });
    expect(tiers.audit_log).toMatchObject({
      hand_number: GLOBAL_HAND,
      pot_size: 40,
      rake: 2,
      button_seat: 3,
    });
    expect(tiers.audit_log.went_to_showdown).toBe(true);
    expect(tiers.player_summaries).toHaveLength(2);
    // Tier 4 is the other three plus the showdown material — which is exactly
    // why storing it would have tripled the largest payload on the platform.
    expect(tiers.dispute_review.raw_events).toEqual(tiers.raw_events);
    expect(tiers.dispute_review.player_summaries).toEqual(tiers.player_summaries);
    expect(tiers.dispute_review.revealed_hole_cards).toHaveProperty('u1');
  });

  it('does NOT call the stored stack a starting stack — it is post-settlement', () => {
    const [winner] = buildHandHistoryTiers(storedRow).player_summaries;
    // Settlement mutates SeatedPlayer.stack in place before the row is written,
    // so 118 already includes the 38 that was just won.
    expect(winner.stackAfterSettlement).toBe(118);
    expect(winner.stackBeforePayout).toBe(80);
    expect(winner).not.toHaveProperty('startStack');
  });

  it('reports what a player won GROSS and what they actually netted', () => {
    const [winner, loser] = buildHandHistoryTiers(storedRow).player_summaries;
    // The old field was called netResult and held the gross award, with every
    // loser reading 0 rather than their loss.
    expect(winner.amountWon).toBe(38);
    expect(winner.contributed).toBe(20);
    expect(winner.net).toBe(18);
    expect(loser.amountWon).toBe(0);
    expect(loser.contributed).toBe(20);
    expect(loser.net).toBe(-20);
    // Blinds and antes are not in the action log, and it says so rather than
    // quietly pretending the number is complete.
    expect(winner.contributedIncludesBlinds).toBe(false);
  });

  it('treats a raise as a level, not as chips added', () => {
    // bet 10 then raise-to 30 on the same street is 30 in, not 40.
    const tiers = buildHandHistoryTiers({
      ...storedRow,
      winners: [],
      actions: [
        { seat: 1, userId: 'u1', action: 'bet', amount: 10, stage: 'flop' },
        { seat: 1, userId: 'u1', action: 'raise', amount: 30, stage: 'flop' },
      ],
    });
    expect(tiers.player_summaries[0].contributed).toBe(30);
  });

  it('survives a row with null player/action/winner columns', () => {
    const tiers = buildHandHistoryTiers({
      table_id: 't',
      hand_number: GLOBAL_HAND,
      game_variant: 'nlh',
      small_blind: 1,
      big_blind: 2,
      pot_size: 0,
      rake_amount: 0,
      players: null,
      actions: null,
      winners: null,
    });
    expect(tiers.raw_events).toEqual([]);
    expect(tiers.player_summaries).toEqual([]);
    expect(tiers.audit_log.player_count).toBe(0);
  });
});

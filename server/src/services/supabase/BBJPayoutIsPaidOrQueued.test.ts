/**
 * A DETECTED JACKPOT IS PAID OR QUEUED, NEVER DROPPED
 * ═══════════════════════════════════════════════════════════════════════════
 * BBJ full audit, 2026-09-05.
 *
 * `processBBJPayout` used to make ONE call to bbj_atomic_payout_v2 and return
 * null on any error. The engine's memory of the hit lives for one hand, so a
 * transient failure - a PostgREST schema-cache reload (28 s on this database),
 * a dropped socket, the :55 maintenance freeze refusing the write - meant a
 * jackpot that had been DETECTED from a witnessed showdown and ANNOUNCED to
 * the table (`bbj_hit` goes out before the payout) was never paid, never
 * recorded, never retried. No bbj_payouts row existed for anything downstream
 * to notice. The pool kept the money.
 *
 * The RPC is idempotent on (pool, table, hand): a retry after a success whose
 * response was lost returns already_paid and re-drives any missing credit. So
 * retrying is free, and these pins say the module retries what is worth
 * retrying, gives up on what is not, and when it does give up it leaves a
 * durable record (the queue) and a loud one (a CRITICAL financial alert) -
 * both carrying every parameter needed to re-drive the payout by hand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
const from = vi.fn();
vi.mock('./client.js', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
}));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
const raiseFinancialAlert = vi.fn().mockResolvedValue({ persisted: true, alertId: 'alert-1' });
vi.mock('../financialAlerts.js', () => ({
  raiseFinancialAlert: (...a: unknown[]) => raiseFinancialAlert(...a),
}));

import { processBBJPayout, setBBJPayoutQueueWriter, resolveJackpotSiblingClubIds } from './bbj.js';

const POOL = 'f9806a7f-e7a2-47d2-a676-36336e3a5337';
const PARAMS = {
  tableId: 'c5c742e5-c29d-41e0-94c2-e56ec7b2d2cd',
  clubId: 'fade0000-0000-0000-0000-000000000001',
  handNumber: 6237804,
  loserUserId: 'loser-uuid',
  winnerUserId: 'winner-uuid',
  loserHandName: 'Full House',
  winnerHandName: 'Four of a Kind',
  dealtInPlayerIds: ['loser-uuid', 'winner-uuid', 'p3', 'p4', 'p5'],
  seatedUserIds: ['loser-uuid', 'winner-uuid', 'p3'],
  payoutTotalPercent: 25,
};

/** A chainable stand-in for the query builder that resolves to `result`. */
function table(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order', 'limit', 'insert']) {
    chain[m] = () => chain;
  }
  chain.maybeSingle = () => Promise.resolve(result);
  // `await supabase.from(...).select(...).eq(...)` with no maybeSingle:
  chain.then = (res: (v: unknown) => void) => res(result);
  return chain;
}

function appliedRow(over: Record<string, unknown> = {}) {
  return {
    applied: true,
    already_paid: false,
    recovered: false,
    payout_id: 'payout-1',
    total_payout: 26099.19,
    loser_share: 13049.59,
    winner_share: 6524.8,
    table_share: 6524.8,
    per_player_share: 2174.93,
    balance_after: 78297.56,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  setBBJPayoutQueueWriter(null);
  from.mockImplementation((name: string) => {
    if (name === 'clubs') return table({ data: { union_id: 'union-1' }, error: null });
    if (name === 'bbj_pools')
      return table({
        data: { id: POOL, main_balance: 104396.75, backup_balance: 32081.72 },
        error: null,
      });
    if (name === 'notifications') return table({ data: null, error: null });
    return table({ data: null, error: null });
  });
});

async function run(p = processBBJPayout(PARAMS)) {
  // Drain every backoff timer the retry loop schedules. Each attempt is a
  // chain of awaited reads before its timer exists, so drain a few rounds.
  for (let i = 0; i < 8; i++) await vi.runAllTimersAsync();
  return p;
}

describe('the happy path is unchanged', () => {
  it('pays once and returns the shares the RPC applied', async () => {
    rpc.mockResolvedValueOnce({ data: [appliedRow()], error: null });
    const result = await run();
    expect(result).toEqual({
      totalPayout: 26099.19,
      loserShare: 13049.59,
      winnerShare: 6524.8,
      tableShare: 6524.8,
      perPlayerShare: 2174.93,
      poolId: POOL,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('bbj_atomic_payout_v2');
    expect(raiseFinancialAlert).not.toHaveBeenCalled();
  });

  it('a replay (already_paid) returns null and raises nothing - the RPC re-drove the credits', async () => {
    rpc.mockResolvedValueOnce({
      data: [appliedRow({ applied: false, already_paid: true, recovered: true })],
      error: null,
    });
    expect(await run()).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(raiseFinancialAlert).not.toHaveBeenCalled();
  });
});

describe('a transient failure is retried, and the second attempt pays', () => {
  it.each([
    'PGRST002: Could not query the database for the schema cache',
    'fetch failed',
    'canceling statement due to statement timeout (57014)',
    'PLATFORM_FROZEN: the platform is on a scheduled maintenance break',
    'deadlock detected',
  ])('retries after: %s', async (message) => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message } })
      .mockResolvedValueOnce({ data: [appliedRow()], error: null });
    const result = await run();
    expect(result?.totalPayout).toBe(26099.19);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(raiseFinancialAlert).not.toHaveBeenCalled();
  });

  it('a transient read error on the pool lookup is retried too - it is not "no pool"', async () => {
    let poolReads = 0;
    from.mockImplementation((name: string) => {
      if (name === 'clubs') return table({ data: { union_id: 'union-1' }, error: null });
      if (name === 'bbj_pools') {
        poolReads++;
        return poolReads === 1
          ? table({ data: null, error: { message: 'fetch failed' } })
          : table({ data: { id: POOL, main_balance: 1000, backup_balance: 0 }, error: null });
      }
      return table({ data: null, error: null });
    });
    rpc.mockResolvedValueOnce({ data: [appliedRow()], error: null });
    const result = await run();
    expect(result?.poolId).toBe(POOL);
    expect(poolReads).toBe(2);
  });
});

describe('when every attempt fails, the hit is queued and alarmed, never dropped', () => {
  it('queues the full parameter set and raises a CRITICAL alert carrying it', async () => {
    const queued: unknown[] = [];
    setBBJPayoutQueueWriter(async (params, lastError) => {
      queued.push({ params, lastError });
    });
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });

    expect(await run()).toBeNull();

    // Four attempts, not one.
    expect(rpc).toHaveBeenCalledTimes(4);
    // The durable copy...
    expect(queued).toHaveLength(1);
    expect((queued[0] as { params: unknown }).params).toEqual(PARAMS);
    // ...and the loud one, with everything a human needs to re-drive it.
    expect(raiseFinancialAlert).toHaveBeenCalledTimes(1);
    const [severity, source, message, context] = raiseFinancialAlert.mock.calls[0];
    expect(severity).toBe('critical');
    expect(source).toBe('processBBJPayout.exhausted');
    expect(message).toContain(PARAMS.tableId);
    expect(message).toContain(`#${PARAMS.handNumber}`);
    expect(context).toMatchObject({ ...PARAMS, attempts: 4, queued: true });
  });

  it('a non-retryable refusal is not retried and not queued (retrying cannot change it)', async () => {
    const queue = vi.fn();
    setBBJPayoutQueueWriter(queue);
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'bbj payout percent 0 out of range (0,100]' },
    });
    expect(await run()).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
  });

  it('an empty pool is final: nothing to pay, nothing to queue', async () => {
    from.mockImplementation((name: string) => {
      if (name === 'clubs') return table({ data: { union_id: null }, error: null });
      if (name === 'bbj_pools')
        return table({ data: { id: POOL, main_balance: 0, backup_balance: 500 }, error: null });
      return table({ data: null, error: null });
    });
    const queue = vi.fn();
    setBBJPayoutQueueWriter(queue);
    expect(await run()).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it('a re-drive from the queue does not re-queue itself or re-alarm; the reconciler owns the row', async () => {
    const queue = vi.fn();
    setBBJPayoutQueueWriter(queue);
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    expect(await run(processBBJPayout(PARAMS, { fromQueue: true }))).toBeNull();
    expect(queue).not.toHaveBeenCalled();
    expect(raiseFinancialAlert).not.toHaveBeenCalled();
  });
});

describe('every recipient is told, seated or not (phase 1), and the note says where the chips went', () => {
  it('notifies seated and departed alike when fromQueue', async () => {
    const inserted: unknown[] = [];
    from.mockImplementation((name: string) => {
      if (name === 'clubs') return table({ data: { union_id: 'union-1' }, error: null });
      if (name === 'bbj_pools')
        return table({ data: { id: POOL, main_balance: 1000, backup_balance: 0 }, error: null });
      if (name === 'notifications') {
        return {
          insert: (rows: unknown[]) => {
            inserted.push(...rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      return table({ data: null, error: null });
    });
    rpc.mockResolvedValueOnce({ data: [appliedRow()], error: null });
    await run(processBBJPayout(PARAMS, { fromQueue: true }));
    expect(inserted.map((r) => (r as { user_id: string }).user_id).sort()).toEqual(
      [...PARAMS.dealtInPlayerIds].sort()
    );
  });

  it('notifies EVERY recipient on the live path, seated ones told the chips are on their stack', async () => {
    const inserted: Array<{ user_id: string; message: string; metadata: { placed: string } }> = [];
    from.mockImplementation((name: string) => {
      if (name === 'clubs') return table({ data: { union_id: 'union-1' }, error: null });
      if (name === 'bbj_pools')
        return table({ data: { id: POOL, main_balance: 1000, backup_balance: 0 }, error: null });
      if (name === 'notifications') {
        return {
          insert: (rows: unknown[]) => {
            inserted.push(...(rows as typeof inserted));
            return Promise.resolve({ error: null });
          },
        };
      }
      return table({ data: null, error: null });
    });
    rpc.mockResolvedValueOnce({ data: [appliedRow()], error: null });
    await run();
    expect(inserted.map((r) => r.user_id).sort()).toEqual([...PARAMS.dealtInPlayerIds].sort());
    const seated = inserted.find((r) => r.user_id === 'loser-uuid')!;
    const departed = inserted.find((r) => r.user_id === 'p4')!;
    expect(seated.message).toContain('added to your stack at the table');
    expect(seated.message).toContain('You took the bad beat');
    expect(seated.metadata.placed).toBe('table_stack');
    expect(departed.message).toContain('credited to your wallet');
    expect(departed.metadata.placed).toBe('club_wallet');
  });
});

describe('the club-wide announcement fans out to the whole union', () => {
  it('returns every club in the union for a union club', async () => {
    from.mockImplementation((name: string) => {
      if (name === 'clubs') {
        // First call: the club row (maybeSingle). Second: the siblings list.
        const chain = table({ data: { union_id: 'union-1' }, error: null });
        chain.then = (res: (v: unknown) => void) =>
          res({ data: [{ id: 'club-a' }, { id: 'club-b' }, { id: 'shell' }], error: null });
        return chain;
      }
      return table({ data: null, error: null });
    });
    const ids = await resolveJackpotSiblingClubIds('club-a');
    expect(new Set(ids)).toEqual(new Set(['club-a', 'club-b', 'shell']));
  });

  it('returns the club alone when it is standalone', async () => {
    from.mockImplementation(() => table({ data: { union_id: null }, error: null }));
    expect(await resolveJackpotSiblingClubIds('solo')).toEqual(['solo']);
  });

  it('never throws - a failed lookup falls back to the hitting club', async () => {
    from.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await resolveJackpotSiblingClubIds('solo')).toEqual(['solo']);
  });
});

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

import {
  processBBJPayout,
  processMiniBBJPayout,
  setBBJPayoutQueue,
  resolveJackpotSiblingClubIds,
} from './bbj.js';

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
  setBBJPayoutQueue(null);
  from.mockImplementation((name: string) => {
    if (name === 'clubs') return table({ data: { union_id: 'union-1' }, error: null });
    if (name === 'bbj_contributions') return table({ data: { pool_id: POOL }, error: null });
    if (name === 'bbj_unclaimed_shares') return table({ data: [], error: null });
    if (name === 'bbj_payout_recipients')
      return table({
        data: PARAMS.dealtInPlayerIds.map((user_id) => ({
          user_id,
          amount:
            user_id === 'loser-uuid' ? 13049.59 : user_id === 'winner-uuid' ? 6524.8 : 2174.93,
        })),
        error: null,
      });
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
    const outcome = await run();
    expect(outcome).toEqual({
      status: 'paid',
      result: {
        totalPayout: 26099.19,
        loserShare: 13049.59,
        winnerShare: 6524.8,
        tableShare: 6524.8,
        perPlayerShare: 2174.93,
        poolId: POOL,
      },
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
    expect(await run()).toEqual({ status: 'already_paid' });
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
    const outcome = await run();
    expect(outcome.status === 'paid' && outcome.result.totalPayout).toBe(26099.19);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(raiseFinancialAlert).not.toHaveBeenCalled();
  });

  it('a transient read error on the pool lookup is retried too - it is not "no pool"', async () => {
    let poolReads = 0;
    from.mockImplementation((name: string) => {
      if (name === 'clubs') return table({ data: { union_id: 'union-1' }, error: null });
      if (name === 'bbj_contributions') return table({ data: { pool_id: POOL }, error: null });
      if (name === 'bbj_unclaimed_shares') return table({ data: [], error: null });
      if (name === 'bbj_payout_recipients')
        return table({
          data: PARAMS.dealtInPlayerIds.map((user_id) => ({
            user_id,
            amount:
              user_id === 'loser-uuid' ? 13049.59 : user_id === 'winner-uuid' ? 6524.8 : 2174.93,
          })),
          error: null,
        });
      if (name === 'bbj_pools') {
        poolReads++;
        return poolReads === 1
          ? table({ data: null, error: { message: 'fetch failed' } })
          : table({ data: { id: POOL, main_balance: 1000, backup_balance: 0 }, error: null });
      }
      return table({ data: null, error: null });
    });
    rpc.mockResolvedValueOnce({ data: [appliedRow()], error: null });
    const outcome = await run();
    expect(outcome.status === 'paid' && outcome.result.poolId).toBe(POOL);
    expect(poolReads).toBe(2);
  });
});

describe('when every attempt fails, the hit is queued and alarmed, never dropped', () => {
  it('claims BEFORE trying, refreshes the note after, and raises a CRITICAL alert', async () => {
    const queued: Array<{ params: unknown; note: string }> = [];
    setBBJPayoutQueue({
      claim: async (params, note) => {
        queued.push({ params, note });
        return true;
      },
      settle: async () => undefined,
    });
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });

    const outcome = await run();
    expect(outcome.status).toBe('queued');
    expect(outcome.status === 'queued' && outcome.lastError).toContain('fetch failed');

    // Four attempts, not one.
    expect(rpc).toHaveBeenCalledTimes(4);

    /* TWO claims, and that is the write-ahead working (phase 2.1). The first
       goes on disk BEFORE the first attempt, while the money is still in the
       pool - so a process killed mid-payout still leaves a record that a
       jackpot was owed, which is the one gap the queue could not close when
       the row was only written after everything had already failed. The
       second refreshes that row's note with the real error. Both carry the
       full parameter set a human needs to re-drive it. */
    expect(queued).toHaveLength(2);
    expect(queued[0].params).toEqual(PARAMS);
    expect(queued[0].note).toContain('write-ahead');
    expect(queued[1].params).toEqual(PARAMS);
    expect(queued[1].note).toContain('fetch failed');

    // ...and the loud one, with everything a human needs to re-drive it.
    expect(raiseFinancialAlert).toHaveBeenCalledTimes(1);
    const [severity, source, message, context] = raiseFinancialAlert.mock.calls[0];
    expect(severity).toBe('critical');
    expect(source).toBe('processBBJPayout.exhausted');
    expect(message).toContain(PARAMS.tableId);
    expect(message).toContain(`#${PARAMS.handNumber}`);
    expect(context).toMatchObject({ ...PARAMS, attempts: 4, queued: true });
  });

  it('a paid jackpot CLOSES its claim, so the drain never re-drives a settled hand', async () => {
    const claim = vi.fn();
    const settle = vi.fn();
    setBBJPayoutQueue({ claim, settle });
    rpc.mockResolvedValueOnce({ data: [appliedRow()], error: null });

    expect((await run()).status).toBe('paid');
    expect(claim).toHaveBeenCalledTimes(1);
    expect(String(claim.mock.calls[0][1])).toContain('write-ahead');
    expect(settle).toHaveBeenCalledTimes(1);
    expect(String(settle.mock.calls[0][1])).toContain('paid 26099.19');
  });

  it('a replay closes the claim too - the money was already placed', async () => {
    const settle = vi.fn();
    setBBJPayoutQueue({ claim: vi.fn(), settle });
    rpc.mockResolvedValueOnce({
      data: [appliedRow({ applied: false, already_paid: true, recovered: true })],
      error: null,
    });

    expect(await run()).toEqual({ status: 'already_paid' });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(String(settle.mock.calls[0][1])).toContain('already paid');
  });

  it('a non-retryable refusal is not retried, and its claim is CLOSED rather than left open', async () => {
    const claim = vi.fn();
    const settle = vi.fn();
    setBBJPayoutQueue({ claim, settle });
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'bbj payout percent 0 out of range (0,100]' },
    });

    expect(await run()).toEqual({ status: 'nothing_to_pay', reason: 'rpc_refused' });
    expect(rpc).toHaveBeenCalledTimes(1);
    /* The write-ahead claim is made before anyone can know the hand is
       unpayable, so what matters is that it is SETTLED. An open claim for a
       hand that can never pay would be re-driven 25 times and end in a
       CRITICAL alert about nothing - and an alarm that fires on correct
       behaviour is how real alarms get ignored. */
    expect(claim).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(String(settle.mock.calls[0][1])).toContain('nothing to pay');
  });

  it('an empty pool is final: nothing to pay, and the claim is closed', async () => {
    rpc.mockResolvedValue({ data: [{ applied: false, already_paid: false }], error: null });
    from.mockImplementation((name: string) => {
      if (name === 'clubs') return table({ data: { union_id: null }, error: null });
      if (name === 'bbj_contributions') return table({ data: { pool_id: POOL }, error: null });
      if (name === 'bbj_unclaimed_shares') return table({ data: [], error: null });
      if (name === 'bbj_payout_recipients')
        return table({
          data: PARAMS.dealtInPlayerIds.map((user_id) => ({
            user_id,
            amount:
              user_id === 'loser-uuid' ? 13049.59 : user_id === 'winner-uuid' ? 6524.8 : 2174.93,
          })),
          error: null,
        });
      if (name === 'bbj_pools')
        return table({ data: { id: POOL, main_balance: 0, backup_balance: 500 }, error: null });
      return table({ data: null, error: null });
    });
    const claim = vi.fn();
    const settle = vi.fn();
    setBBJPayoutQueue({ claim, settle });

    expect(await run()).toEqual({ status: 'nothing_to_pay', reason: 'no_pool_or_empty' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('a re-drive from the queue neither claims nor settles nor re-alarms; the reconciler owns the row', async () => {
    const claim = vi.fn();
    const settle = vi.fn();
    setBBJPayoutQueue({ claim, settle });
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });

    expect((await run(processBBJPayout(PARAMS, { fromQueue: true }))).status).toBe('queued');
    expect(claim).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(raiseFinancialAlert).not.toHaveBeenCalled();
  });
});

describe('every recipient is told, seated or not (phase 1), and the note says where the chips went', () => {
  it('notifies seated and departed alike when fromQueue', async () => {
    const inserted: unknown[] = [];
    from.mockImplementation((name: string) => {
      if (name === 'clubs') return table({ data: { union_id: 'union-1' }, error: null });
      if (name === 'bbj_contributions') return table({ data: { pool_id: POOL }, error: null });
      if (name === 'bbj_unclaimed_shares') return table({ data: [], error: null });
      if (name === 'bbj_payout_recipients')
        return table({
          data: PARAMS.dealtInPlayerIds.map((user_id) => ({
            user_id,
            amount:
              user_id === 'loser-uuid' ? 13049.59 : user_id === 'winner-uuid' ? 6524.8 : 2174.93,
          })),
          error: null,
        });
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
      if (name === 'bbj_contributions') return table({ data: { pool_id: POOL }, error: null });
      if (name === 'bbj_unclaimed_shares') return table({ data: [], error: null });
      if (name === 'bbj_payout_recipients')
        return table({
          data: PARAMS.dealtInPlayerIds.map((user_id) => ({
            user_id,
            amount:
              user_id === 'loser-uuid' ? 13049.59 : user_id === 'winner-uuid' ? 6524.8 : 2174.93,
          })),
          error: null,
        });
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
    expect(seated.message).toContain('confirmed jackpot credit');
    expect(seated.message).toContain('You took the bad beat');
    expect(seated.metadata.placed).toBe('credited');
    expect(departed.message).toContain('confirmed jackpot credit');
    expect(departed.metadata.placed).toBe('credited');
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

describe('Mini payouts retain the original durable jackpot operation', () => {
  const miniParams = { ...PARAMS, tierId: 'low', metadata: { rule: 'near_miss' } };
  it('claims before attempting, retries transport failure and invokes only the Mini RPC', async () => {
    const order: string[] = [];
    const claim = vi.fn(async (_params: unknown, _note: string) => {
      order.push('claim');
    });
    const settle = vi.fn(async () => {
      order.push('settle');
    });
    setBBJPayoutQueue({ claim, settle });
    rpc
      .mockImplementationOnce(async () => {
        order.push('rpc');
        return { data: null, error: { message: 'fetch failed' } };
      })
      .mockImplementationOnce(async () => {
        order.push('rpc');
        return { data: [appliedRow()], error: null };
      });
    const pending = processMiniBBJPayout(miniParams);
    for (let i = 0; i < 8; i++) await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.status).toBe('paid');
    expect(order.slice(0, 3)).toEqual(['claim', 'rpc', 'rpc']);
    expect(claim.mock.calls[0][0]).toMatchObject({ kind: 'mini', tierId: 'low' });
    expect(rpc.mock.calls.slice(0, 2).every(([name]) => name === 'fn_bbj_mini_payout')).toBe(true);
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_payout_total_percent');
  });
  it('keeps database failures pending instead of calling them skipped', async () => {
    const claim = vi.fn();
    const settle = vi.fn();
    setBBJPayoutQueue({ claim, settle });
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const pending = processMiniBBJPayout(miniParams);
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe('queued');
    expect(settle).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalled();
  });
  it('closes a persisted business-rule refusal without retrying it', async () => {
    const claim = vi.fn();
    const settle = vi.fn();
    setBBJPayoutQueue({ claim, settle });
    rpc.mockResolvedValue({
      data: [{ applied: false, already_paid: false, refused: 'reserve_at_floor' }],
      error: null,
    });
    expect(await processMiniBBJPayout(miniParams)).toEqual({
      status: 'skipped',
      reason: 'reserve_at_floor',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });
  it('lets the RPC replay an existing hand even when the current Main bank is empty', async () => {
    from.mockImplementation((name: string) =>
      name === 'bbj_payouts'
        ? table({ data: { pool_id: POOL }, error: null })
        : table({ data: { id: POOL, main_balance: 0, backup_balance: 1000 }, error: null })
    );
    rpc.mockResolvedValue({
      data: [appliedRow({ applied: false, already_paid: true })],
      error: null,
    });
    expect(await processBBJPayout(PARAMS)).toEqual({ status: 'already_paid' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('unknown payout receipts cannot close the durable claim', () => {
  it.each([
    {},
    { applied: false },
    { applied: 'true', already_paid: false },
    { applied: false, already_paid: 'true' },
    { applied: true, already_paid: true },
    [appliedRow(), appliedRow()],
  ])('keeps malformed settlement response pending: %j', async (data) => {
    const claim = vi.fn().mockResolvedValue(undefined);
    const settle = vi.fn().mockResolvedValue(undefined);
    setBBJPayoutQueue({ claim, settle });
    rpc.mockResolvedValue({ data, error: null });
    expect((await run()).status).toBe('queued');
    expect(claim).toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('recipient notifications follow recorded delivery', () => {
  it.each(['parked', 'read_error', 'missing', 'duplicate', 'mismatch'])(
    'does not invent a successful delivery for %s',
    async (scenario) => {
      const original = from.getMockImplementation()!;
      const inserted: Array<{ user_id: string; title: string; message: string }> = [];
      from.mockImplementation((name: string) => {
        if (name === 'bbj_unclaimed_shares')
          return table({
            data: scenario === 'parked' ? [{ user_id: 'loser-uuid', amount: 13049.59 }] : [],
            error: null,
          });
        if (name === 'bbj_payout_recipients')
          return table({
            data:
              scenario === 'missing'
                ? []
                : PARAMS.dealtInPlayerIds
                    .filter((id) => scenario !== 'parked' || id !== 'loser-uuid')
                    .map((id) => ({
                      user_id: id,
                      amount:
                        id === 'loser-uuid' ? 13049.59 : id === 'winner-uuid' ? 6524.8 : 2174.93,
                    }))
                    .concat(scenario === 'duplicate' ? [{ user_id: 'p3', amount: 2174.93 }] : [])
                    .map((row) => (scenario === 'mismatch' ? { ...row, amount: -1 } : row)),
            error: scenario === 'read_error' ? { message: 'unreadable' } : null,
          });
        if (name === 'notifications')
          return {
            insert: async (rows: typeof inserted) => {
              inserted.push(...rows);
              return { error: null };
            },
          };
        return original(name);
      });
      rpc.mockResolvedValue({ data: [appliedRow()], error: null });
      await run();
      if (scenario === 'parked') {
        const note = inserted.find((r) => r.user_id === 'loser-uuid');
        expect(note?.title).toContain('Pending');
        expect(note?.message).not.toContain('was added');
        expect(note?.message).not.toContain('was credited');
      } else expect(inserted).toEqual([]);
    }
  );
});

it('sends one recorded-credit notice per person without guessing seat or wallet delivery', async () => {
  const original = from.getMockImplementation()!;
  const inserted: Array<{ user_id: string; message: string }> = [];
  from.mockImplementation((name: string) =>
    name === 'notifications'
      ? {
          insert: async (rows: typeof inserted) => {
            inserted.push(...rows);
            return { error: null };
          },
        }
      : original(name)
  );
  rpc.mockResolvedValue({ data: [appliedRow()], error: null });
  await run(
    processBBJPayout({
      ...PARAMS,
      dealtInPlayerIds: [...PARAMS.dealtInPlayerIds, 'p3', 'loser-uuid'],
    })
  );
  expect(inserted).toHaveLength(5);
  expect(new Set(inserted.map((row) => row.user_id)).size).toBe(5);
  expect(inserted.every((row) => row.message.includes('confirmed jackpot credit'))).toBe(true);
  expect(inserted.some((row) => /stack|wallet/.test(row.message))).toBe(false);
});

describe('queue durability is a confirmed write, not writer registration', () => {
  it.each([false, undefined, true])('reports the writer receipt %j accurately', async (receipt) => {
    setBBJPayoutQueue({ claim: vi.fn().mockResolvedValue(receipt), settle: vi.fn() });
    rpc.mockResolvedValue({ data: null, error: { message: 'refused connection' } });
    await run();
    expect(raiseFinancialAlert).toHaveBeenCalledWith(
      'critical',
      'processBBJPayout.exhausted',
      expect.any(String),
      expect.objectContaining({ queued: receipt === true })
    );
  });
  it('does not claim durability when the registered writer throws', async () => {
    setBBJPayoutQueue({
      claim: vi.fn().mockRejectedValue(new Error('queue unavailable')),
      settle: vi.fn(),
    });
    rpc.mockResolvedValue({ data: null, error: { message: 'refused connection' } });
    await run();
    expect(raiseFinancialAlert).toHaveBeenCalledWith(
      'critical',
      'processBBJPayout.exhausted',
      expect.stringContaining('not confirmed'),
      expect.objectContaining({ queued: false })
    );
  });
});

describe('applied BBJ shares require valid cent amounts before confirmation', () => {
  for (const field of [
    'total_payout',
    'loser_share',
    'winner_share',
    'table_share',
    'per_player_share',
  ]) {
    it.each([null, undefined, -1, Infinity, 0.001, '', false, 'invalid'])(
      `keeps invalid ${field} pending: %j`,
      async (value) => {
        const settle = vi.fn();
        setBBJPayoutQueue({ claim: vi.fn(), settle });
        rpc.mockResolvedValue({ data: [appliedRow({ [field]: value })], error: null });
        expect((await run()).status).toBe('queued');
        expect(settle).not.toHaveBeenCalled();
        expect(from.mock.calls.some(([name]) => name === 'notifications')).toBe(false);
      }
    );
  }
  it('does not confirm shares that exceed the total payout by one cent', async () => {
    rpc.mockResolvedValue({ data: [appliedRow({ loser_share: 13049.6 })], error: null });
    expect((await run()).status).toBe('queued');
  });
  it('does not confirm an applied receipt without a payout identity', async () => {
    rpc.mockResolvedValue({ data: [appliedRow({ payout_id: null })], error: null });
    expect((await run()).status).toBe('queued');
  });
  it('accepts PostgreSQL decimal strings with unchanged amounts', async () => {
    const receipt = appliedRow();
    for (const key of [
      'total_payout',
      'loser_share',
      'winner_share',
      'table_share',
      'per_player_share',
    ]) {
      (receipt as Record<string, unknown>)[key] = String((receipt as Record<string, unknown>)[key]);
    }
    rpc.mockResolvedValue({ data: [receipt], error: null });
    expect((await run()).status).toBe('paid');
  });
});

/**
 * THE RECONCILER RE-DRIVES A QUEUED JACKPOT
 * ═══════════════════════════════════════════════════════════════════════════
 * BBJ full audit, 2026-09-05. The other half of BBJPayoutIsPaidOrQueued: once
 * a jackpot the engine could not pay sits in pending_fee_distributions as
 * kind 'bbj_payout', the 5-minute drain must call the payout with the frozen
 * parameters, re-read who is STILL seated (a fact about now, not about the
 * hit), resolve the row when the ledger shows the payout landed, and never
 * mistake a queued jackpot for a fee contribution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const processBBJPayout = vi.fn();
const logBBJCollection = vi.fn();
const rpc = vi.fn();
const from = vi.fn();

vi.mock('./supabase.js', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
  logBBJCollection: (...a: unknown[]) => logBBJCollection(...a),
}));
vi.mock('./supabase/bbj.js', () => ({
  processBBJPayout: (...a: unknown[]) => processBBJPayout(...a),
  setBBJPayoutQueue: vi.fn(),
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn().mockResolvedValue({ persisted: true, alertId: 'a' }),
}));

import { reconcilePendingFees } from './FeeReconciler.js';
import { reportError } from './errorReporter.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

const PARAMS = {
  tableId: 'table-1',
  clubId: 'club-1',
  handNumber: 6237804,
  loserUserId: 'bb',
  winnerUserId: 'hw',
  loserHandName: 'Full House',
  winnerHandName: 'Four of a Kind',
  dealtInPlayerIds: ['bb', 'hw', 'p3', 'p4'],
  seatedUserIds: ['bb', 'hw', 'p3', 'p4'],
  payoutTotalPercent: 25,
};

const QUEUED_ROW = {
  id: 'row-1',
  table_id: 'table-1',
  club_id: 'club-1',
  hand_id: 'hand-1',
  hand_number: 6237804,
  rake: 0,
  bbj: 0,
  pot: 0,
  num_players: 4,
  contributions: PARAMS,
  returned_uncalled: null,
  rake_method: null,
  tournament_id: null,
  big_blind: null,
  kind: 'bbj_payout',
  attempts: 0,
};

/** Minimal builder: every method chains; the terminal resolves to `result`. */
function table(
  result: { data: unknown; error: unknown; count?: number | null },
  onUpdate?: (patch: unknown) => void
) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'lt', 'order', 'limit', 'insert']) chain[m] = () => chain;
  chain.update = (patch: unknown) => {
    onUpdate?.(patch);
    return chain;
  };
  chain.maybeSingle = () => Promise.resolve(result);
  chain.then = (res: (v: unknown) => void) =>
    res({ ...result, count: 'count' in result ? result.count : 1 });
  return chain;
}

let patches: unknown[];
let bbjPayoutRows: unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  patches = [];
  bbjPayoutRows = [];
  from.mockImplementation((name: string) => {
    if (name === 'pending_fee_distributions')
      return table({ data: [QUEUED_ROW], error: null }, (p) => patches.push(p));
    if (name === 'table_seats')
      // p4 has left since the hit; the others are still in their chairs.
      return table({
        data: [{ user_id: 'bb' }, { user_id: 'hw' }, { user_id: 'p3' }],
        error: null,
      });
    if (name === 'bbj_payouts') return table({ data: bbjPayoutRows[0] ?? null, error: null });
    if (name === 'hand_history') return table({ data: { id: 'hand-1' }, error: null });
    return table({ data: null, error: null });
  });
});

describe('a queued bbj_payout row', () => {
  it('is re-driven through processBBJPayout with the frozen parameters and the LIVE seat set', async () => {
    processBBJPayout.mockResolvedValue({
      status: 'paid',
      result: {
        totalPayout: 100,
        loserShare: 50,
        winnerShare: 25,
        tableShare: 25,
        perPlayerShare: 12.5,
        poolId: 'pool',
      },
    });
    const summary = await reconcilePendingFees();
    expect(summary).toMatchObject({ scanned: 1, resolved: 1, stillFailing: 0, exhausted: 0 });
    expect(logBBJCollection).not.toHaveBeenCalled(); // never mistaken for a contribution
    expect(processBBJPayout).toHaveBeenCalledTimes(1);
    const [params, opts] = processBBJPayout.mock.calls[0];
    expect(params).toMatchObject({
      tableId: 'table-1',
      clubId: 'club-1',
      handNumber: 6237804,
      loserUserId: 'bb',
      winnerUserId: 'hw',
      dealtInPlayerIds: ['bb', 'hw', 'p3', 'p4'],
      payoutTotalPercent: 25,
    });
    // p4 left since the hit: paid to the wallet, not to an empty chair.
    expect(params.seatedUserIds).toEqual(['bb', 'hw', 'p3']);
    expect(opts).toEqual({ fromQueue: true });
    expect(patches[0]).toMatchObject({ attempts: 1, last_error: null });
    expect((patches[0] as { resolved_at?: string }).resolved_at).toBeTruthy();
  });

  it('resolves when the payout returns null but the ledger shows the hand was already paid', async () => {
    // The live attempt succeeded and only its response was lost; the RPC
    // answered already_paid on the re-drive, so processBBJPayout returns null.
    processBBJPayout.mockResolvedValue({ status: 'already_paid' });
    bbjPayoutRows = [{ id: 'payout-1' }];
    const summary = await reconcilePendingFees();
    expect(summary.resolved).toBe(1);
    expect((patches[0] as { resolved_at?: string }).resolved_at).toBeTruthy();
  });

  it('stays open, attempts bumped, when the payout fails again and nothing is in the ledger', async () => {
    processBBJPayout.mockResolvedValue({ status: 'queued', lastError: 'fetch failed' });
    const summary = await reconcilePendingFees();
    expect(summary).toMatchObject({ resolved: 0, stillFailing: 1 });
    expect(patches[0]).toMatchObject({ attempts: 1 });
    expect((patches[0] as { resolved_at?: string }).resolved_at).toBeUndefined();
    expect((patches[0] as { last_error: string }).last_error).toContain('fetch failed');
  });

  it('refuses a row whose parameters are missing rather than paying the wrong people', async () => {
    from.mockImplementation((name: string) => {
      if (name === 'pending_fee_distributions')
        return table(
          { data: [{ ...QUEUED_ROW, contributions: { tableId: 'table-1' } }], error: null },
          (p) => patches.push(p)
        );
      return table({ data: null, error: null });
    });
    const summary = await reconcilePendingFees();
    expect(processBBJPayout).not.toHaveBeenCalled();
    expect(summary.stillFailing).toBe(1);
    expect((patches[0] as { last_error: string }).last_error).toContain('missing its parameters');
  });
});

it('preserves the Mini kind, tier and metadata when reconstructing a stored operation', async () => {
  const original = from.getMockImplementation()!;
  from.mockImplementation((name: string) =>
    name === 'pending_fee_distributions'
      ? table(
          {
            data: [
              {
                ...QUEUED_ROW,
                contributions: {
                  ...PARAMS,
                  kind: 'mini',
                  payoutTotalPercent: 0,
                  tierId: 'low',
                  metadata: { rule: 'near_miss' },
                },
              },
            ],
            error: null,
          },
          (p) => patches.push(p)
        )
      : original(name)
  );
  processBBJPayout.mockResolvedValue({ status: 'already_paid' });
  await reconcilePendingFees();
  expect(processBBJPayout.mock.calls[0][0]).toMatchObject({
    kind: 'mini',
    tierId: 'low',
    metadata: { rule: 'near_miss' },
  });
});

/**
 * THE DRAIN IS FOR JACKPOT CLAIMS ONLY (2026-09-22).
 *
 * The rake and the BBJ drop of an accepted hand are carried by its post-commit
 * envelope, which the only hand door refuses to commit without, and banked in
 * one transaction by fn_ca_process_hand_post_commit_obligations. The drain's
 * rake and BBJ-drop re-drive compensated for the split write that envelope
 * removed. Worse, a rake claim re-driven here was banked on the claim's own
 * methodology, and an equal-split claim filed by the hourly re-queue for a
 * hand whose envelope was merely late would win atomic_distribute_rake's first
 * write and erase the hand's weighted attribution for good. So the drain asks
 * the queue for bbj_payout rows only, and a row of any other kind that still
 * reached it is neither re-driven nor written.
 */
describe('the drain never re-drives a fee the hand already owes', () => {
  it('asks the queue for jackpot payout claims only', async () => {
    const filters: Array<[string, unknown]> = [];
    from.mockImplementation((name: string) => {
      const chain = table({ data: [], error: null });
      if (name === 'pending_fee_distributions') {
        chain.eq = (column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        };
      }
      return chain;
    });
    const summary = await reconcilePendingFees();
    expect(filters).toContainEqual(['kind', 'bbj_payout']);
    expect(summary).toMatchObject({ scanned: 0, resolved: 0, stillFailing: 0 });
  });

  it.each(['rake', 'bbj_contribution'])(
    'leaves a queued %s row untouched even when a read returns one',
    async (kind) => {
      from.mockImplementation((name: string) =>
        name === 'pending_fee_distributions'
          ? table(
              {
                data: [{ ...QUEUED_ROW, kind, rake: 4, bbj: 1, contributions: { p3: 40 } }],
                error: null,
              },
              (p) => patches.push(p)
            )
          : table({ data: null, error: null })
      );
      rpc.mockResolvedValue({
        data: [{ applied: true, already_processed: false, rake_record_id: 'rake-1' }],
        error: null,
      });
      logBBJCollection.mockResolvedValue(true);

      const summary = await reconcilePendingFees();

      // Not banked: no atomic_distribute_rake, no BBJ drop, no jackpot payout.
      expect(rpc).not.toHaveBeenCalled();
      expect(logBBJCollection).not.toHaveBeenCalled();
      expect(processBBJPayout).not.toHaveBeenCalled();
      // Not written: not resolved, and not even its attempt counter bumped.
      expect(patches).toEqual([]);
      // Counted as still open, and said out loud: the read broke its own filter.
      expect(summary).toMatchObject({ scanned: 1, resolved: 0, stillFailing: 1, exhausted: 0 });
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        'FeeReconciler.not_a_jackpot_claim'
      );
    }
  );
});

it.each([
  { count: 0, error: null },
  { count: null, error: null },
  { count: 2, error: null },
  { count: 1, error: { message: 'write rejected' } },
])('does not report a resolved queue row when its write is unconfirmed: %j', async (receipt) => {
  const original = from.getMockImplementation()!;
  from.mockImplementation((name: string) => {
    if (name !== 'pending_fee_distributions') return original(name);
    return {
      ...table({ data: [QUEUED_ROW], error: null }),
      update: () => table({ data: null, ...receipt }),
    };
  });
  processBBJPayout.mockResolvedValue({ status: 'already_paid' });
  expect(await reconcilePendingFees()).toMatchObject({ scanned: 1, resolved: 0, stillFailing: 1 });
});

it.each([
  { tableId: 'different-table' },
  { clubId: 'different-club' },
  { handNumber: 42 },
  { handNumber: NaN },
  { handNumber: 1.5 },
  { payoutTotalPercent: NaN },
  { payoutTotalPercent: Infinity },
  { payoutTotalPercent: -1 },
  { payoutTotalPercent: 101 },
  { loserUserId: PARAMS.winnerUserId },
  { dealtInPlayerIds: ['bb', 'hw', null] },
])(
  'does not execute a queued jackpot with mismatched identity or invalid parameters: %j',
  async (override) => {
    const original = from.getMockImplementation()!;
    from.mockImplementation((name: string) =>
      name === 'pending_fee_distributions'
        ? table(
            { data: [{ ...QUEUED_ROW, contributions: { ...PARAMS, ...override } }], error: null },
            (p) => patches.push(p)
          )
        : original(name)
    );
    processBBJPayout.mockResolvedValue({ status: 'already_paid' });
    const summary = await reconcilePendingFees();
    expect(processBBJPayout).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ resolved: 0, stillFailing: 1 });
    expect((patches[0] as { resolved_at?: string }).resolved_at).toBeUndefined();
  }
);

it('retains the captured row hand number for a legacy payload without handNumber', async () => {
  const original = from.getMockImplementation()!;
  const { handNumber: _omitted, ...legacy } = PARAMS;
  from.mockImplementation((name: string) =>
    name === 'pending_fee_distributions'
      ? table({ data: [{ ...QUEUED_ROW, contributions: legacy }], error: null }, (p) =>
          patches.push(p)
        )
      : original(name)
  );
  processBBJPayout.mockResolvedValue({ status: 'already_paid' });
  await reconcilePendingFees();
  expect(processBBJPayout.mock.calls[0][0].handNumber).toBe(QUEUED_ROW.hand_number);
});

/**
 * THE SWEEP CHECKS THE FREEZE (section 13 rule 5, 2026-09-11).
 *
 * Re-driving a queued jackpot credits a seat, which is a chip movement, and
 * during the maintenance break the platform is stopped. `GameServer` already
 * returns early from the whole reconcile cycle while frozen, and
 * `processBBJPayout` refuses the credit itself - this is the check at the
 * money move, so a second caller of `reconcilePendingFees` cannot miss it.
 *
 * The row is left UNTOUCHED rather than attempted and failed: bumping its
 * attempt counter and writing a failure message would read in the log as a
 * payout that failed, when what happened is a break we scheduled.
 */
describe('a queued jackpot is not re-driven through a maintenance break', () => {
  afterEach(() => setMaintenanceFrozen(false));

  it('skips the row without touching it, and counts the deferral', async () => {
    setMaintenanceFrozen(true);
    const summary = await reconcilePendingFees();
    /* Scanned but deliberately not looked at: deferred is its own outcome and
       must not be folded into resolved or stillFailing (CLAUDE.md 10.86). */
    expect(summary.deferredFrozen).toBeGreaterThan(0);
    expect(summary.resolved).toBe(0);
    expect(summary.stillFailing).toBe(0);
    expect(processBBJPayout).not.toHaveBeenCalled();
  });
});

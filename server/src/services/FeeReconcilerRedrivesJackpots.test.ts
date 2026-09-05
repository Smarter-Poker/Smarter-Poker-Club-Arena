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
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  setBBJPayoutQueueWriter: vi.fn(),
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn().mockResolvedValue({ persisted: true, alertId: 'a' }),
}));

import { reconcilePendingFees } from './FeeReconciler.js';

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
function table(result: { data: unknown; error: unknown }, onUpdate?: (patch: unknown) => void) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'lt', 'order', 'limit', 'insert']) chain[m] = () => chain;
  chain.update = (patch: unknown) => {
    onUpdate?.(patch);
    return chain;
  };
  chain.maybeSingle = () => Promise.resolve(result);
  chain.then = (res: (v: unknown) => void) => res(result);
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
      totalPayout: 100,
      loserShare: 50,
      winnerShare: 25,
      tableShare: 25,
      perPlayerShare: 12.5,
      poolId: 'pool',
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
    processBBJPayout.mockResolvedValue(null);
    bbjPayoutRows = [{ id: 'payout-1' }];
    const summary = await reconcilePendingFees();
    expect(summary.resolved).toBe(1);
    expect((patches[0] as { resolved_at?: string }).resolved_at).toBeTruthy();
  });

  it('stays open, attempts bumped, when the payout fails again and nothing is in the ledger', async () => {
    processBBJPayout.mockResolvedValue(null);
    const summary = await reconcilePendingFees();
    expect(summary).toMatchObject({ resolved: 0, stillFailing: 1 });
    expect(patches[0]).toMatchObject({ attempts: 1 });
    expect((patches[0] as { resolved_at?: string }).resolved_at).toBeUndefined();
    expect((patches[0] as { last_error: string }).last_error).toContain('no bbj_payouts row');
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

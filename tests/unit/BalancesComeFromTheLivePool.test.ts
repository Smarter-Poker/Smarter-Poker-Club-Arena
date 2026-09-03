/**
 * THE BALANCE ON SCREEN COMES FROM THE POOL THE MONEY IS ACTUALLY IN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Regression pin for 2026-08-27. `WalletService.getBalances` read
 * `public.wallets` — a pool that has taken no write since 2026-08-21 00:59
 * UTC. It feeds `useWalletStore`, which feeds `useCanAfford` and the
 * "Playable Now" / "Chips In Escrow" figures on PlayerWalletPage.
 *
 * WHY IT SURVIVED SIX DAYS: the table still HOLDS numbers, so the reads never
 * produced the tell-tale zero that the deprecated-table gate was written to
 * catch. They produced stale, plausible, formatted lies. Measured on
 * production that day: the frozen PLAYER pool summed to 732,581,244.32
 * against a live economy of 121,018,710.03 — six times the chips that exist —
 * and one sampled player read 3,313,727.73 against a true 34,818.60.
 *
 * Two guards, because they fail differently:
 *   - the CI gate (scripts/ci/check-deprecated-tables.mjs) fails the BUILD on
 *     any future read of the retired table, anywhere in src/ or server/src;
 *   - these tests pin the BEHAVIOUR — that the numbers are summed from the
 *     live club-scoped pool, and that a missing spendable answer degrades to
 *     "unknown" rather than to a six-day-old number.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const tableReads: string[] = [];
let clubMemberRows: any[] = [];
let agentRow: any = null;

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => mockRpc(...args),
    from: (table: string) => {
      tableReads.push(table);
      const rowsFor = () => (table === 'club_members' ? clubMemberRows : []);
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        range: () => builder,
        maybeSingle: async () =>
          table === 'agents' ? { data: agentRow, error: null } : { data: null, error: null },
        then: (resolve: any) => resolve({ data: rowsFor(), error: null }),
      };
      return builder;
    },
  },
}));

vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: { getState: () => ({ currentClubId: 'club-1' }) },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
vi.mock('../../src/services/FinancialAlertService', () => ({ FinancialAlertService: {} }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (x: string) => x }));
vi.mock('../../src/utils/retryAsync', () => ({ retryAsync: (fn: any) => fn() }));

import { WalletService } from '../../src/services/WalletService';

describe('getBalances reads the LIVE pools, never the frozen one', () => {
  beforeEach(() => {
    tableReads.length = 0;
    mockRpc.mockReset();
    clubMemberRows = [];
    agentRow = null;
  });

  it('never touches the retired global wallet table', async () => {
    clubMemberRows = [{ chip_balance: 100, promo_balance: 0, locked_chips: 0 }];
    await WalletService.getBalances('u1');
    expect(tableReads).not.toContain('wallets');
  });

  it('sums the player chips across every club the player belongs to', async () => {
    // The frozen table stored ONE global number per player. The live pool is
    // club-scoped, so a player in three clubs has three rows and the total is
    // their sum — getting this wrong is how a multi-club player would have
    // seen only a fraction of their own chips.
    clubMemberRows = [
      { chip_balance: 10_000, promo_balance: 5, locked_chips: 1_000 },
      { chip_balance: 24_818.6, promo_balance: 0, locked_chips: 0 },
      { chip_balance: 0, promo_balance: 10, locked_chips: 0 },
    ];
    const balances = await WalletService.getBalances('u1');
    const player = balances.find((b) => b.walletType === 'PLAYER')!;
    expect(player.balance).toBeCloseTo(34_818.6, 2);
    expect(player.lockedBalance).toBe(1_000);
    // Available is what is NOT already committed to a table.
    expect(player.availableBalance).toBeCloseTo(33_818.6, 2);

    const promo = balances.find((b) => b.walletType === 'PROMO')!;
    expect(promo.balance).toBe(15);
  });

  it('a non-agent has no agents row, and that is a zero rather than a throw', async () => {
    clubMemberRows = [{ chip_balance: 1, promo_balance: 0, locked_chips: 0 }];
    agentRow = null;
    const balances = await WalletService.getBalances('u1');
    expect(balances.find((b) => b.walletType === 'BUSINESS')!.balance).toBe(0);
  });

  it('never renders a negative "Playable Now" when a lock is mid-flight', async () => {
    // locked_chips can briefly exceed chip_balance while a buy-in is landing.
    clubMemberRows = [{ chip_balance: 50, promo_balance: 0, locked_chips: 80 }];
    const balances = await WalletService.getBalances('u1');
    expect(balances.find((b) => b.walletType === 'PLAYER')!.availableBalance).toBe(0);
  });
});

describe('readPlayerBalance degrades to unknown, not to a stale number', () => {
  beforeEach(() => {
    tableReads.length = 0;
    mockRpc.mockReset();
  });

  it('returns the RPC answer when the spendable RPC responds', async () => {
    mockRpc.mockResolvedValue({ data: { balance: 250 }, error: null });
    const res = await WalletService.readPlayerBalance('u1');
    expect(res).toEqual({ balance: 250, source: 'rpc' });
  });

  it('recovers a transient PostgREST schema-cache miss before reporting unknown', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST002', message: 'schema cache is reconnecting' },
      })
      .mockResolvedValueOnce({ data: { balance: 375 }, error: null });

    const res = await WalletService.readPlayerBalance('u1');

    expect(res).toEqual({ balance: 375, source: 'rpc' });
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('returns null (unknown) — NOT a frozen fallback — when the RPC fails', async () => {
    // The old code fell back to the retired table here. A confident wrong
    // number could authorise a spend against six-day-old chips; null means
    // "ask the server", and the buy-in RPC refuses an underfunded entry.
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission denied' },
    });
    const res = await WalletService.readPlayerBalance('u1');
    expect(res.balance).toBeNull();
    expect(res.source).toBe('failed');
    expect(tableReads).not.toContain('wallets');
  });
});

describe('ensureWalletsExist no longer provisions rows in the frozen pool', () => {
  it('writes nothing at all', async () => {
    tableReads.length = 0;
    await WalletService.ensureWalletsExist('u1', ['BUSINESS', 'PROMO']);
    expect(tableReads).toEqual([]);
  });
});

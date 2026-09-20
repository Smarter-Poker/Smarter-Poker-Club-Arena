/**
 * DiamondService.getWalletSummary: one RPC, parsed honestly, null on failure.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const { DiamondService } = await import('../../src/services/DiamondService');

const payload = {
  user_id: 'u-1',
  on_hand: 1200,
  collateral: '200',
  sendable: 1000,
  in_arena: 350,
  arena_seats: 1,
  arena_entries: 0,
  arena: {
    club_id: '002c2d27-9584-4e52-835a-bb2be148fc81',
    name: 'Diamond Arena',
    slug: 'diamond-arena',
    cash_games_enabled: false,
    tournaments_enabled: false,
  },
  lifetime_earned: 4095,
  lifetime_spent: 12,
  read_at: '2026-09-13T18:00:00Z',
};

describe('DiamondService.getWalletSummary', () => {
  beforeEach(() => rpc.mockReset());

  it('calls fn_diamond_wallet_summary with no arguments (own user only) and maps every figure', async () => {
    rpc.mockResolvedValueOnce({ data: payload, error: null });
    const s = await DiamondService.getWalletSummary();
    expect(rpc).toHaveBeenCalledWith('fn_diamond_wallet_summary');
    expect(s).toEqual({
      onHand: 1200,
      collateral: 200,
      sendable: 1000,
      inArena: 350,
      arenaSeats: 1,
      arenaEntries: 0,
      arena: {
        clubId: '002c2d27-9584-4e52-835a-bb2be148fc81',
        name: 'Diamond Arena',
        slug: 'diamond-arena',
        cashGamesEnabled: false,
        tournamentsEnabled: false,
        openCashTables: 0,
        minCashBuyIn: null,
        cheapestTable: null,
      },
      lifetimeEarned: 4095,
      lifetimeSpent: 12,
      readAt: '2026-09-13T18:00:00Z',
    });
  });

  it('parses the cheapest seat and open-table count when the arena reports them (phase 3)', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ...payload,
        arena: {
          ...payload.arena,
          open_cash_tables: 17,
          min_cash_buy_in: '80',
          cheapest_table: { id: 't-1', name: 'NLH 1/2', small_blind: 1, big_blind: 2 },
        },
      },
      error: null,
    });
    const s = await DiamondService.getWalletSummary();
    expect(s?.arena?.openCashTables).toBe(17);
    expect(s?.arena?.minCashBuyIn).toBe(80);
    expect(s?.arena?.cheapestTable).toEqual({
      id: 't-1',
      name: 'NLH 1/2',
      smallBlind: 1,
      bigBlind: 2,
    });
  });

  it('accepts a one-row array payload', async () => {
    rpc.mockResolvedValueOnce({ data: [payload], error: null });
    expect((await DiamondService.getWalletSummary())?.inArena).toBe(350);
  });

  it('a missing arena block is null, not a fabricated club', async () => {
    rpc.mockResolvedValueOnce({ data: { ...payload, arena: null }, error: null });
    expect((await DiamondService.getWalletSummary())?.arena).toBeNull();
  });

  it('the open flags are booleans read strictly: "true" the string is not open', async () => {
    rpc.mockResolvedValueOnce({
      data: { ...payload, arena: { ...payload.arena, cash_games_enabled: 'true' } },
      error: null,
    });
    expect((await DiamondService.getWalletSummary())?.arena?.cashGamesEnabled).toBe(false);
  });

  it('a failed read is null, never zeros (10.86)', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect(await DiamondService.getWalletSummary()).toBeNull();
    rpc.mockResolvedValueOnce({ data: { ...payload, on_hand: 'x' }, error: null });
    expect(await DiamondService.getWalletSummary()).toBeNull();
    rpc.mockRejectedValueOnce(new Error('network'));
    expect(await DiamondService.getWalletSummary()).toBeNull();
  });
});

describe('the summary is wired into the wallet page', () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
  const page = read('src/pages/PlayerWalletPage.tsx');
  const hook = read('src/hooks/useDiamondWalletSummary.ts');

  it('the page reads the summary through one hook and refreshes it with the balances', () => {
    expect(page).toContain(
      "import { useDiamondWalletSummary } from '../hooks/useDiamondWalletSummary';"
    );
    expect(page).toContain('useDiamondWalletSummary(\n    user?.id,\n    isMounted\n  )');
    expect(page).toContain('void loadWalletSummary();');
    expect(hook).toContain(
      "masterBus.subscribeDebounced('BALANCE_UPDATED', () => void load(), 1200)"
    );
    expect(hook).toContain('DiamondService.getWalletSummary()');
  });

  it('the Send pane tells the truth about what can be sent, and says when it could not read it', () => {
    expect(page).toContain('const sendable = walletSummary ? walletSummary.sendable : diamonds;');
    expect(page).toContain('if (amount > sendable) {');
    expect(page).toContain('max={Math.max(MIN_DIAMOND_SEND, sendable)}');
    expect(page).toContain('Sendable: ${fmtNum(sendable)} Diamonds');
    expect(page).toContain('(Sendable Amount Could Not Be Read)');
    expect(page).toContain('Bought Recently Are Held Until The Refund Window Closes');
  });

  it('the hook has three outcomes: reading, failed, known', () => {
    expect(hook).toContain('useState<DiamondWalletSummary | null | undefined>(undefined)');
    expect(hook).toContain('if (!isMounted.current || seq !== seqRef.current) return;');
  });
});

describe('sit down from the wallet (phase 3)', () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
  const page = read('src/pages/PlayerWalletPage.tsx');
  const market = read('src/pages/MarketplacePage.tsx');
  const diamondsTab = read('src/pages/marketplace/DiamondsTab.tsx');
  const migration = read(
    'supabase/migrations/20260914101812_the_wallet_knows_the_cheapest_seat_in_the_diamond_arena.sql'
  );

  it("the cheapest seat comes from the buy-in RPC's own table predicate, never a guess", () => {
    for (const clause of [
      "t.game_variant = 'nlh'",
      't.tournament_id IS NULL',
      't.cluster_id IS NULL',
      "t.status IN ('waiting', 'running', 'playing', 'active')",
      'NOT COALESCE(t.bomb_pot_enabled, false)',
      'NOT COALESCE(t.straddle_enabled, false)',
      'ORDER BY t.min_buy_in ASC',
    ]) {
      expect(migration).toContain(clause);
    }
    // The SQL body reads no chip table or column; the header states the rule.
    const body = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION'),
      migration.indexOf('COMMENT ON FUNCTION')
    );
    expect(body).not.toMatch(/chip/i);
  });

  it('a short player is sent to the store carrying a validated way back', () => {
    expect(page).toContain(
      '`/marketplace?tab=diamonds&next=${encodeURIComponent(`/clubs/${DIAMOND_ARENA_SLUG}`)}`'
    );
    expect(page).toContain('onClick={short > 0 ? onBuyToSitDown : onArena}');
    expect(market).toContain("import { safeInAppRedirect } from '../lib/signIn';");
    expect(market).toContain(
      "const safe = safeInAppRedirect(nextParam);\n    return safe === '/' ? null : safe;"
    );
    expect(diamondsTab).toContain("${nextPath ? `&next=${encodeURIComponent(nextPath)}` : ''}");
  });

  it('after the purchase lands the store offers the way onward, and only then', () => {
    /* Re-landed 2026-09-19 on the hardened shape #4805 shipped: the offer is
       made only from a VERIFIED checkout receipt (`receipt.accountId`), is
       owned by the account that paid, and is dropped when the account or the
       validated `next` changes. The archived pin named the older
       `continueOffered` latch; the behaviour it guarded is the same. */
    expect(market).toContain(
      'setVerifiedContinuation({ ownerId: receipt.accountId, path: nextPath });'
    );
    expect(market).toContain(
      '{verifiedContinuation?.ownerId === user?.id && verifiedContinuation?.path === nextPath && ('
    );
    expect(market).toContain("? 'Continue To The Diamond Arena'\n      : 'Continue'");
    // The way onward is a navigation, never a window.location write, and it
    // refuses a continuation that belongs to another account.
    const onward = market.slice(
      market.indexOf('const goOnward = () => {'),
      market.indexOf('const goOnward = () => {') + 300
    );
    expect(onward).toContain('navigate(destination);');
    expect(onward).toContain('verifiedContinuation.ownerId !== user?.id) return;');
    expect(onward).not.toMatch(/window\.location/);
  });

  it("the freeroll countdown is the Home card's own clock, read only while the plate is mounted", () => {
    expect(page).toContain(
      "import { useDiamondFreerollCountdown } from '../hooks/useNextDiamondFreeroll';"
    );
    expect(page).toContain(
      'nextFreerollAt !== undefined ? nextFreerollAt : arena ? undefined : null'
    );
    // No component cross-import: DiamondArenaCard carries ClubCardPanel.css,
    // which must not reach the wallet bundle.
    expect(page).not.toContain('components/club/DiamondArenaCard');
    expect(page).not.toContain('function useCountdown');
  });
});

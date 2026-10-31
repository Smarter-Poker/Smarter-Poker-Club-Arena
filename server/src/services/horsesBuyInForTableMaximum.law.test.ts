import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bankrollPolicyFor } from './HorseBankroll.js';
import { horseRebuyAmount } from './HorseRebuyPolicy.js';
import { cappedAutoTopUp } from './HorseTopUpStyle.js';
import { readFileSync } from 'node:fs';
import { horseCashMinimum, horseMaximumBuyIn } from './HorseBehavior.js';

const wallet = vi.hoisted(() => ({ balance: undefined as number | undefined, throws: false }));
vi.mock('./supabase/wallets.js', () => ({
  readSeatWalletClub: async () => 'seat-club',
  readClubChipBalances: async (_club: string, ids: string[]) => {
    if (wallet.throws) throw new Error('wallet unavailable');
    return wallet.balance === undefined ? new Map() : new Map([[ids[0], wallet.balance]]);
  },
}));

describe('owner maximum cash reload', () => {
  const request = {
    userId: 'maximum-reload-horse',
    clubId: 'club',
    tableId: 'table',
    bigBlind: 2,
    minBuyIn: 200,
    maxBuyIn: 400,
    rebuysTaken: 0,
  };
  beforeEach(() => {
    wallet.balance = 100_000;
    wallet.throws = false;
  });
  it('requests 400 rather than the former 200', async () => {
    expect(await horseRebuyAmount(request)).toBe(400);
    expect(await horseRebuyAmount({ ...request, maxBuyIn: 597.25 })).toBe(597.25);
  });
  it('requests the same maximum when a wallet read is unknown or throws', async () => {
    wallet.balance = undefined;
    expect(await horseRebuyAmount(request)).toBe(400);
    wallet.throws = true;
    expect(await horseRebuyAmount(request)).toBe(400);
  });
  it('declines rather than taking a partial bankroll-capped buy-in', async () => {
    const policy = bankrollPolicyFor(request.userId);
    wallet.balance = 300 / policy.maxBankrollFraction;
    expect(await horseRebuyAmount(request)).toBe(0);
  });
  it('preserves the session stop-loss even with ample funds', async () => {
    expect(
      await horseRebuyAmount({
        ...request,
        rebuysTaken: bankrollPolicyFor(request.userId).stopLossBuyIns - 1,
      })
    ).toBe(0);
  });
  it('declines a partial auto top-up instead of purchasing a short stack', () => {
    expect(
      cappedAutoTopUp({
        userId: request.userId,
        wanted: 280,
        wallet: 400 / bankrollPolicyFor(request.userId).maxBankrollFraction,
        investedThisTable: 200,
        bigBlind: 2,
        minBuyIn: 80,
        maxBuyIn: 400,
      })
    ).toBe(0);
  });
  it('the manual Add Chips path targets maximum with no personality jitter', () => {
    const source = readFileSync(new URL('./HorseSessionRotator.ts', import.meta.url), 'utf8');
    expect(source).toContain('const target = tableMax;');
    expect(source).toContain('if (amount < desiredTopUp) amount = 0;');
  });
  it('uses the standard 200bb table ceiling only when no maximum was supplied', async () => {
    expect(await horseRebuyAmount({ ...request, maxBuyIn: undefined })).toBe(400);
  });
});

describe('2/5 PLO5 Horse minimum is 500, with maximum purchases preferred', () => {
  const table = { game_variant: 'plo5', small_blind: 2, big_blind: 5 };
  it('raises only the scoped minimum and respects a higher configured floor', () => {
    expect(horseCashMinimum(table, 200)).toBe(500);
    expect(horseCashMinimum(table, 800)).toBe(800);
    expect(horseCashMinimum({ ...table, game_variant: 'plo4' }, 200)).toBe(200);
    expect(horseCashMinimum({ ...table, small_blind: 1 }, 200)).toBe(200);
  });
  it('chooses the maximum or declines a table capped below 500', () => {
    const minimum = horseCashMinimum(table, 200);
    expect(horseMaximumBuyIn(minimum, 1000)).toBe(1000);
    expect(horseMaximumBuyIn(minimum, 500)).toBe(500);
    expect(horseMaximumBuyIn(minimum, 499.99)).toBe(0);
  });
  it('applies the same minimum to both rebuy paths', async () => {
    const request = {
      userId: 'maximum-reload-horse',
      clubId: '',
      bigBlind: 5,
      smallBlind: 2,
      variant: 'plo5',
      minBuyIn: 200,
      maxBuyIn: 1000,
      rebuysTaken: 0,
    };
    expect(await horseRebuyAmount(request)).toBe(1000);
    expect(await horseRebuyAmount({ ...request, maxBuyIn: 499.99 })).toBe(0);
    for (const file of ['ServerTableEngineDealing.ts', 'ServerTableEngineSettlement.ts']) {
      const source = readFileSync(new URL('../engine/' + file, import.meta.url), 'utf8');
      const requestSource = source.slice(
        source.indexOf('const rebuyAmount = await horseRebuyAmount({')
      );
      expect(requestSource.slice(0, requestSource.indexOf('});'))).toContain(
        'variant: this.tableInfo?.game_variant'
      );
    }
    const fleet = readFileSync(new URL('./HorseFleetManager.ts', import.meta.url), 'utf8');
    expect(fleet).toContain(
      'horseCashMinimum(table, Number(table.min_buy_in) || table.big_blind * 40)'
    );
  });
});

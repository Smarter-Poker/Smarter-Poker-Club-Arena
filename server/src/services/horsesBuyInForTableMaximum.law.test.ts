import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bankrollPolicyFor } from './HorseBankroll.js';
import { horseRebuyAmount } from './HorseRebuyPolicy.js';
import { cappedAutoTopUp } from './HorseTopUpStyle.js';
import { readFileSync } from 'node:fs';

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

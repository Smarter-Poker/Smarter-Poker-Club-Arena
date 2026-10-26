import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cappedAutoTopUp,
  balancedHorseAutoTopUps,
  horseAutoTopUpWanted,
  horseCashTopUpStyle,
  horseSitsWithAutoTopUp,
  isPlo5Variant,
} from './HorseTopUpStyle.js';

// Dan 2026-10-24: "70% OF HORSES SHOULD BE ADDING ON IN THE PLO5 GAME. 30%
// SHOULD BE ON 'AUTO TOP UP'."
describe('PLO5 horse top-up style', () => {
  const ids = Array.from({ length: 20_000 }, () => randomUUID());
  const autoId = ids.find((x) => horseCashTopUpStyle(x, 'plo5') === 'auto_top_up')!;
  const addOnId = ids.find((x) => horseCashTopUpStyle(x, 'plo5') === 'add_on')!;

  it('splits the fleet 30% Auto Top Up / 70% add-on in PLO5', () => {
    const auto = ids.filter((id) => horseCashTopUpStyle(id, 'plo5') === 'auto_top_up').length;
    const share = auto / ids.length;
    expect(share).toBeGreaterThan(0.28);
    expect(share).toBeLessThan(0.32);
    expect(ids.every((id) => horseCashTopUpStyle(id, 'plo5') !== null)).toBe(true);
  });

  it('gives each horse one habit for life', () => {
    const sample = Array.from({ length: 200 }, () => randomUUID());
    for (const id of sample) {
      expect(horseCashTopUpStyle(id, 'plo5')).toBe(horseCashTopUpStyle(id, 'PLO5'));
      expect(horseSitsWithAutoTopUp(id, 'plo5')).toBe(
        horseCashTopUpStyle(id, 'plo5') === 'auto_top_up'
      );
    }
  });

  it('leaves every other game alone', () => {
    for (const v of ['nlh', 'plo4', 'plo', 'plo6', 'plo-6', '', null, undefined]) {
      expect(isPlo5Variant(v)).toBe(false);
      expect(horseCashTopUpStyle(autoId, v)).toBeNull();
      expect(horseSitsWithAutoTopUp(autoId, v)).toBe(false);
      expect(horseAutoTopUpWanted({ userId: autoId, variant: v, stack: 1, maxBuyIn: 400 })).toBe(0);
    }
    expect(isPlo5Variant('PLO 5')).toBe(true);
    expect(isPlo5Variant('plo-5')).toBe(true);
  });

  it('only an Auto Top Up horse wants the shortfall to the table maximum', () => {
    const w = (userId: string, stack: number) =>
      horseAutoTopUpWanted({ userId, variant: 'plo5', stack, maxBuyIn: 400 });
    expect(w(autoId, 120.37)).toBe(279.63);
    expect(w(autoId, 399.5)).toBe(0.5);
    expect(w(autoId, 400)).toBe(0);
    expect(w(autoId, 900)).toBe(0);
    // Add-on horses add on through HorseSessionRotator, never here.
    expect(w(addOnId, 50)).toBe(0);
    // A busted stack is a rebuy, and a bad number prices nothing.
    expect(w(autoId, 0)).toBe(0);
    expect(w(autoId, NaN)).toBe(0);
    expect(horseAutoTopUpWanted({ userId: autoId, variant: 'plo5', stack: 10, maxBuyIn: 0 })).toBe(
      0
    );
  });

  const table = { bigBlind: 2, minBuyIn: 80, maxBuyIn: 400 };

  it('holds an Auto Top Up to the bankroll policy and the wallet', () => {
    // A deep roll and a fresh session: the whole shortfall.
    expect(
      cappedAutoTopUp({
        userId: autoId,
        wanted: 280,
        wallet: 100_000,
        investedThisTable: 200,
        ...table,
      })
    ).toBe(280);
    // A sliver of a reload is not a reload.
    expect(
      cappedAutoTopUp({
        userId: autoId,
        wanted: 0.5,
        wallet: 100_000,
        investedThisTable: 200,
        ...table,
      })
    ).toBe(0);
    // Already past the stop-loss on this table: no top-up at all.
    expect(
      cappedAutoTopUp({
        userId: autoId,
        wanted: 280,
        wallet: 100_000,
        investedThisTable: 400 * 20,
        ...table,
      })
    ).toBe(0);
    // A roll that cannot carry the stake after paying: nothing.
    expect(
      cappedAutoTopUp({
        userId: autoId,
        wanted: 280,
        wallet: 300,
        investedThisTable: 200,
        ...table,
      })
    ).toBe(0);
  });

  it('holds for every temperament, not just one sampled horse', () => {
    const autos = ids.filter((x) => horseCashTopUpStyle(x, 'plo5') === 'auto_top_up');
    expect(autos.length).toBeGreaterThan(1000);
    for (const userId of autos) {
      const pay = (wallet: number, investedThisTable: number) =>
        cappedAutoTopUp({ userId, wanted: 280, wallet, investedThisTable, ...table });
      expect(pay(100_000, 200)).toBe(280);
      expect(pay(100_000, 200 * 20)).toBe(0);
      expect(pay(300, 200)).toBe(0);
    }
  });

  it('never tops up on an unknown wallet or session total', () => {
    expect(
      cappedAutoTopUp({
        userId: autoId,
        wanted: 280,
        wallet: undefined,
        investedThisTable: 200,
        ...table,
      })
    ).toBe(0);
    expect(
      cappedAutoTopUp({
        userId: autoId,
        wanted: 280,
        wallet: 100_000,
        investedThisTable: undefined,
        ...table,
      })
    ).toBe(0);
    expect(
      cappedAutoTopUp({
        userId: autoId,
        wanted: 280,
        wallet: NaN,
        investedThisTable: 200,
        ...table,
      })
    ).toBe(0);
  });

  it('is wired end to end', () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    // Seats carry the flag, written at the buy-in door, never on Lightning.
    const fleet = read('./HorseFleetManager.ts');
    expect(fleet).not.toContain('p_auto_rebuy: false');
    expect(fleet.match(/await this\.sitsWithAutoTopUp\(/g)?.length).toBe(2);
    expect(fleet).toContain(".eq('lightning_enabled', true)");
    // The engine tops up only a seat whose own flag is on, inside the policy,
    // in the seats lane after the rebuys, with its own funding key.
    const settle = read('../engine/ServerTableEngineSettlement.ts');
    expect(settle).toMatch(/horse_rebuys: 'seats',\s*horse_top_ups: 'seats',/);
    expect(settle).toContain(
      'this.topUpPlo5Horses(players, snap.handNumber, horsesReloadedThisHand)'
    );
    expect(settle).toMatch(/handNumber,\s*'topup'\s*\)/);
    const step = settle.slice(
      settle.indexOf('protected async topUpPlo5Horses('),
      settle.indexOf('protected async postHandTasks(')
    );
    expect(step).toContain('if (this.clusterLightningEnabled === true) return;');
    expect(step).toContain('const batch = await readHorseTopUpBatch(');
    expect(step).toContain('const seat = batch.get(horse.user_id);');
    expect(step).toContain('autoTopUp: seat.autoTopUp,');
    expect(step).not.toContain('await readHorseTopUpSeat(');
    expect(step).not.toContain('await readClubChipBalances(');
    expect(step).toContain('cappedAutoTopUp({');
    expect(read('./supabase/wallets.ts')).toContain("'horse-topup:'");
    // A seat on Auto Top Up does not also add on through the rotator.
    const rotator = read('./HorseSessionRotator.ts');
    expect(rotator).toContain('is_sitting_out, auto_rebuy, tables!');
    expect(rotator).toContain(
      'if ((seat as { auto_rebuy?: boolean }).auto_rebuy === true) continue;'
    );
  });
});

describe('the seated roster has the nearest whole-horse 30% share', () => {
  const roster = Array.from({ length: 10 }, (_, i) => ({ userId: `horse-${i}`, autoTopUp: false }));
  it('rounds every roster size and deduplicates horse ids', () => {
    for (let n = 0; n <= 10; n++) {
      const seats = roster.slice(0, n);
      expect(balancedHorseAutoTopUps([...seats, ...seats]).size).toBe(Math.round(n * 0.3));
    }
  });
  it('keeps existing habits when the quota is already right', () => {
    const seats = roster.map((s, i) => ({ ...s, autoTopUp: i < 3 }));
    expect([...balancedHorseAutoTopUps(seats)].sort()).toEqual(['horse-0', 'horse-1', 'horse-2']);
    expect([...balancedHorseAutoTopUps([...seats].reverse())].sort()).toEqual([
      'horse-0',
      'horse-1',
      'horse-2',
    ]);
  });
  it('changes only the minimum number after arrivals and departures', () => {
    const chosen = balancedHorseAutoTopUps(roster);
    const seats = roster.map((s) => ({ ...s, autoTopUp: chosen.has(s.userId) }));
    const gone = seats.filter((s) => s.userId !== [...chosen][0]);
    const after = balancedHorseAutoTopUps(gone);
    expect(after.size).toBe(3);
    expect([...after].filter((x) => chosen.has(x))).toHaveLength(2);
  });
  it('prices the persisted Auto Top Up choice even when it differs from the hash', () => {
    const id = roster.find((s) => horseCashTopUpStyle(s.userId, 'plo5') === 'add_on')!.userId;
    expect(
      horseAutoTopUpWanted({
        userId: id,
        variant: 'plo5',
        stack: 125,
        maxBuyIn: 200,
        autoTopUp: true,
      })
    ).toBe(75);
    expect(
      horseAutoTopUpWanted({
        userId: id,
        variant: 'plo5',
        stack: 125,
        maxBuyIn: 200,
        autoTopUp: false,
      })
    ).toBe(0);
  });
});

describe('cent-exact PLO5 refills', () => {
  const id = Array.from({ length: 30 }, (_, i) => `cent-horse-${i}`).find((x) =>
    horseSitsWithAutoTopUp(x, 'plo5')
  )!;
  it('fills the observed 191.31 stack to 200 without losing a cent to binary subtraction', () => {
    expect(
      horseAutoTopUpWanted({
        userId: id,
        variant: 'plo5',
        stack: 191.31,
        maxBuyIn: 200,
        autoTopUp: true,
      })
    ).toBe(8.69);
  });
  it('does not floor the same already priced cent twice', () => {
    expect(
      cappedAutoTopUp({
        userId: id,
        wanted: 8.03,
        wallet: 100000,
        investedThisTable: 100,
        bigBlind: 1,
        minBuyIn: 40,
        maxBuyIn: 200,
      })
    ).toBe(8.03);
  });
});

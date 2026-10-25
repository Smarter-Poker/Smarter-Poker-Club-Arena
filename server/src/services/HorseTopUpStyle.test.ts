import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cappedAutoTopUp,
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
    expect(settle).toMatch(/snap\.handNumber,\s*'topup'\s*\)/);
    const step = settle.slice(settle.indexOf("runStep('horse_top_ups'"));
    expect(step).toContain('if (this.clusterLightningEnabled === true) return;');
    expect(step).toContain('if (!seat || !seat.autoTopUp || !seat.clubId) continue;');
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

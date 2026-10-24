import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  capTopUpToWallet,
  ADD_ON_LINE_MAX,
  ADD_ON_LINE_MIN,
  horseAddOnLine,
  horseCashTopUpStyle,
  horseSitsWithAutoTopUp,
  horseTopUpAmount,
  isPlo5Variant,
} from './HorseTopUpStyle.js';

// Dan 2026-10-24: "70% OF HORSES SHOULD BE ADDING ON IN THE PLO5 GAME. 30%
// SHOULD BE ON 'AUTO TOP UP'."
describe('PLO5 horse top-up style', () => {
  const ids = Array.from({ length: 20_000 }, () => randomUUID());

  it('splits the fleet 30% Auto Top Up / 70% add-on in PLO5', () => {
    const auto = ids.filter((id) => horseCashTopUpStyle(id, 'plo5') === 'auto_top_up').length;
    const share = auto / ids.length;
    expect(share).toBeGreaterThan(0.28);
    expect(share).toBeLessThan(0.32);
    expect(ids.every((id) => horseCashTopUpStyle(id, 'plo5') !== null)).toBe(true);
  });

  it('gives each horse one habit for life', () => {
    for (const id of ids.slice(0, 200)) {
      expect(horseCashTopUpStyle(id, 'plo5')).toBe(horseCashTopUpStyle(id, 'PLO5'));
      expect(horseSitsWithAutoTopUp(id, 'plo5')).toBe(
        horseCashTopUpStyle(id, 'plo5') === 'auto_top_up'
      );
    }
  });

  it('leaves every other game alone', () => {
    for (const v of ['nlh', 'plo4', 'plo', 'plo6', 'plo-6', '', null, undefined]) {
      expect(isPlo5Variant(v)).toBe(false);
      expect(horseCashTopUpStyle(ids[0], v)).toBeNull();
      expect(horseSitsWithAutoTopUp(ids[0], v)).toBe(false);
      expect(horseTopUpAmount({ userId: ids[0], variant: v, stack: 1, maxBuyIn: 400 })).toBe(0);
    }
    expect(isPlo5Variant('PLO 5')).toBe(true);
    expect(isPlo5Variant('plo-5')).toBe(true);
  });

  it('auto top-up horses refill any shortfall to the table maximum', () => {
    const id = ids.find((x) => horseCashTopUpStyle(x, 'plo5') === 'auto_top_up')!;
    expect(horseTopUpAmount({ userId: id, variant: 'plo5', stack: 399.5, maxBuyIn: 400 })).toBe(
      0.5
    );
    expect(horseTopUpAmount({ userId: id, variant: 'plo5', stack: 120.37, maxBuyIn: 400 })).toBe(
      279.63
    );
    expect(horseTopUpAmount({ userId: id, variant: 'plo5', stack: 400, maxBuyIn: 400 })).toBe(0);
    expect(horseTopUpAmount({ userId: id, variant: 'plo5', stack: 900, maxBuyIn: 400 })).toBe(0);
  });

  it('add-on horses add back to the maximum only under their comfort line', () => {
    const id = ids.find((x) => horseCashTopUpStyle(x, 'plo5') === 'add_on')!;
    const line = horseAddOnLine(id);
    expect(line).toBeGreaterThanOrEqual(ADD_ON_LINE_MIN);
    expect(line).toBeLessThan(ADD_ON_LINE_MAX);
    expect(
      horseTopUpAmount({ userId: id, variant: 'plo5', stack: 400 * line + 1, maxBuyIn: 400 })
    ).toBe(0);
    expect(horseTopUpAmount({ userId: id, variant: 'plo5', stack: 100, maxBuyIn: 400 })).toBe(300);
  });

  it('never tops up a busted stack (that is a rebuy) or prices off a bad number', () => {
    for (const id of ids.slice(0, 50)) {
      expect(horseTopUpAmount({ userId: id, variant: 'plo5', stack: 0, maxBuyIn: 400 })).toBe(0);
      expect(horseTopUpAmount({ userId: id, variant: 'plo5', stack: 10, maxBuyIn: 0 })).toBe(0);
      expect(horseTopUpAmount({ userId: id, variant: 'plo5', stack: NaN, maxBuyIn: 400 })).toBe(0);
    }
  });

  it('pays a top-up from the horse wallet only, and never on an unknown balance', () => {
    expect(capTopUpToWallet(300, 1000)).toBe(300);
    expect(capTopUpToWallet(300, 120.555)).toBe(120.55);
    expect(capTopUpToWallet(300, 0)).toBe(0);
    expect(capTopUpToWallet(300, undefined)).toBe(0);
    expect(capTopUpToWallet(300, NaN)).toBe(0);
    expect(capTopUpToWallet(0, 500)).toBe(0);
  });

  it('is wired: seats carry the flag and settlement runs the top-up with its own key', () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const fleet = read('./HorseFleetManager.ts');
    expect(fleet).not.toContain('p_auto_rebuy: false');
    expect(fleet.match(/await this\.sitsWithAutoTopUp\(/g)?.length).toBe(2);
    expect(fleet).toContain(".eq('lightning_enabled', true)");
    const settle = read('../engine/ServerTableEngineSettlement.ts');
    expect(settle).toContain("runStep('horse_top_ups'");
    expect(settle).toMatch(/snap\.handNumber,\s*'topup'\s*\)/);
    const step = settle.slice(settle.indexOf("runStep('horse_top_ups'"));
    expect(step).toContain('if (this.clusterLightningEnabled === true) return;');
    expect(step).toContain('capTopUpToWallet(wanted, wallet)');
    const wallets = read('./supabase/wallets.ts');
    expect(wallets).toContain("'horse-topup:'");
  });
});

import { describe, expect, it } from 'vitest';
import {
  PLINKO_DROPS,
  plinkoBudget,
  plinkoDenomination,
  validPlinkoBudget,
  validSpinAmount,
  bonusTotal,
  bonusWalletDebit,
  validBonusBudget,
  defaultBonusBudget,
  earnedReceiptBudget,
} from '../../src/utils/bonusGameBudget';
describe('every Plinko game is ten drops of a tenth of the entry', () => {
  it('derives the drop value from the entry and never offers a choice', () => {
    expect(PLINKO_DROPS).toBe(10);
    expect(plinkoDenomination(100)).toBe(10);
    expect(plinkoDenomination(2500)).toBe(250);
    expect(plinkoDenomination(7500)).toBe(750);
    for (const n of [25, 37, 0, -10, 2.5, NaN, Infinity]) expect(plinkoDenomination(n)).toBeNull();
    for (let entry = 100; entry <= 7500; entry += 100)
      expect(plinkoDenomination(entry)! * PLINKO_DROPS).toBe(entry);
  });
  it('re-derives a saved drop value from before ten drops became the one setting', () => {
    const saved = { base: 2500, doubled: false, denomination: 5 };
    expect(plinkoBudget(saved)).toEqual({ base: 2500, doubled: false, denomination: 250 });
    expect(validPlinkoBudget(saved)).toBe(false);
    expect(validPlinkoBudget(plinkoBudget(saved))).toBe(true);
    const doubled = { base: 2500, doubled: true, denomination: 250 };
    expect(plinkoBudget(doubled).denomination).toBe(500);
    expect(plinkoBudget(defaultBonusBudget())).toEqual(defaultBonusBudget());
    expect(defaultBonusBudget().denomination).toBe(10);
  });
  it('leaves an invalid budget alone so the entry check reports it', () => {
    const invalid = { base: 24, doubled: false, denomination: 1 };
    expect(plinkoBudget(invalid)).toBe(invalid);
    expect(validPlinkoBudget(invalid)).toBe(false);
  });
  it('enforces the starting spin range and whole diamonds', () => {
    for (const n of [0, 24, 25.5, 2501, NaN, Infinity]) expect(validSpinAmount(n)).toBe(false);
    for (const n of [25, 100, 2500]) expect(validSpinAmount(n)).toBe(true);
  });
});

describe('wheel funding is distinct from the original stake', () => {
  const award = {
    id: '00000000-0000-0000-0000-000000000001',
    entryDiamonds: 100,
    boostMultiplier: 2 as const,
  };
  it('adds the original 100 stake to the upgraded 200 funded award', () => {
    const budget = { base: 200, doubled: true, denomination: 30, award };
    expect(validBonusBudget(budget)).toBe(true);
    expect(bonusTotal(budget)).toBe(300);
    expect(bonusWalletDebit(budget)).toBe(100);
    expect(bonusWalletDebit({ ...budget, doubled: false })).toBe(0);
  });
  it('permits 7500 only with the exact upgraded 2500 stake and refuses substituted funding', () => {
    const budget = {
      base: 5000,
      doubled: true,
      denomination: 750,
      award: { ...award, entryDiamonds: 2500 },
    };
    expect(validBonusBudget(budget)).toBe(true);
    expect(bonusTotal(budget)).toBe(7500);
    expect(validBonusBudget({ ...budget, award: undefined })).toBe(false);
    expect(validBonusBudget({ ...budget, base: 4999 })).toBe(false);
    expect(validBonusBudget({ ...budget, award: { ...award, entryDiamonds: 2501 } })).toBe(false);
  });
  it('reads a funded receipt into a budget whose drop value is the tenth of the entry', () => {
    const budget = earnedReceiptBudget({
      award_id: award.id,
      bet_diamonds: 300,
      bonus: {
        base_diamonds: 200,
        entry_diamonds: 100,
        boost_multiplier: 2,
        added_diamonds: 100,
        total_diamonds: 300,
      },
    });
    expect(budget).toEqual({ base: 200, doubled: true, denomination: 30, award });
  });
});

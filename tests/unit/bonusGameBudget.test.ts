import { describe, expect, it } from 'vitest';
import {
  plinkoAllocations,
  validSpinAmount,
  bonusTotal,
  bonusWalletDebit,
  validBonusBudget,
} from '../../src/utils/bonusGameBudget';
describe('the spin balance is conserved across Plinko denominations', () => {
  it('offers each supported whole-diamond choice for a 100 diamond spin', () => {
    expect(plinkoAllocations(100).map((x) => [x.drops, x.diamondsPerDrop])).toEqual([
      [100, 1],
      [50, 2],
      [25, 4],
      [20, 5],
      [10, 10],
      [5, 20],
      [4, 25],
      [2, 50],
      [1, 100],
    ]);
  });
  it('never silently drops a remainder', () => {
    for (let balance = 25; balance <= 2500; balance++) {
      for (const option of plinkoAllocations(balance))
        expect(option.drops * option.diamondsPerDrop).toBe(balance);
    }
    expect(plinkoAllocations(25).map((x) => x.diamondsPerDrop)).toEqual([1, 5, 25]);
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
    const budget = { base: 200, doubled: true, denomination: 20, award };
    expect(validBonusBudget(budget)).toBe(true);
    expect(bonusTotal(budget)).toBe(300);
    expect(bonusWalletDebit(budget)).toBe(100);
    expect(bonusWalletDebit({ ...budget, doubled: false })).toBe(0);
  });
  it('permits 7500 only with the exact upgraded 2500 stake and refuses substituted funding', () => {
    const budget = {
      base: 5000,
      doubled: true,
      denomination: 100,
      award: { ...award, entryDiamonds: 2500 },
    };
    expect(validBonusBudget(budget)).toBe(true);
    expect(bonusTotal(budget)).toBe(7500);
    expect(validBonusBudget({ ...budget, award: undefined })).toBe(false);
    expect(validBonusBudget({ ...budget, base: 4999 })).toBe(false);
    expect(validBonusBudget({ ...budget, award: { ...award, entryDiamonds: 2501 } })).toBe(false);
  });
});

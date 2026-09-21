import { describe, expect, it } from 'vitest';
import {
  PLINKO_DIAMONDS_PER_DROP,
  PLINKO_MAX_DROPS,
  PLINKO_MIN_DROPS,
  plinkoAllocations,
  plinkoBudget,
  plinkoDrops,
  validPlinkoBudget,
  validPlinkoDenomination,
  validSpinAmount,
  bonusTotal,
  bonusWalletDebit,
  validBonusBudget,
  defaultBonusBudget,
  earnedReceiptBudget,
} from '../../src/utils/bonusGameBudget';
/**
 * THE PLAYER CHOOSES THE DROP (Dan 2026-09-21, R6: "On Plinko the player must
 * choose how many diamonds to drop and the value of each drop. Today it is
 * just defaulted at 10 diamonds"). This moves the 2026-09-19 pin that every
 * game was ten drops of a tenth: the value now comes from a fixed list, it must
 * divide the stake, the drops stay between 1 and 100, and NOTHING is chosen
 * for the player.
 */
describe('the player chooses the Plinko drop value', () => {
  it('offers exactly the values that divide the stake into 1 to 100 drops, smallest first', () => {
    expect(PLINKO_DIAMONDS_PER_DROP).toEqual([1, 2, 4, 5, 10, 20, 25, 50, 100, 250, 500]);
    expect(PLINKO_MIN_DROPS).toBe(1);
    expect(PLINKO_MAX_DROPS).toBe(100);
    // 100 diamonds: 1 a drop is 100 drops (allowed), and every listed divisor.
    expect(plinkoAllocations(100).map((a) => [a.diamondsPerDrop, a.drops])).toEqual([
      [1, 100],
      [2, 50],
      [4, 25],
      [5, 20],
      [10, 10],
      [20, 5],
      [25, 4],
      [50, 2],
      [100, 1],
    ]);
    // 2,500 diamonds: 1 to 20 a drop would be more than 100 drops, so they are not offered.
    expect(plinkoAllocations(2500).map((a) => a.diamondsPerDrop)).toEqual([25, 50, 100, 250, 500]);
    expect(plinkoAllocations(2500).find((a) => a.diamondsPerDrop === 25)?.drops).toBe(100);
    // 7,500 diamonds (a Super award with the addition): 750 is not on the list.
    expect(plinkoAllocations(7500).map((a) => a.diamondsPerDrop)).toEqual([100, 250, 500]);
    // 25 diamonds: only 1, 5 and 25 divide it.
    expect(plinkoAllocations(25).map((a) => a.diamondsPerDrop)).toEqual([1, 5, 25]);
    // A stake no listed value splits into at most 100 drops offers nothing rather
    // than inventing a value: 101 diamonds would be 101 single-diamond drops.
    expect(plinkoAllocations(37).map((a) => a.diamondsPerDrop)).toEqual([1]);
    expect(plinkoAllocations(101)).toEqual([]);
    for (const n of [0, -10, 2.5, NaN, Infinity]) expect(plinkoAllocations(n)).toEqual([]);
  });
  it('validates a chosen value against the list, the stake and the drop range', () => {
    expect(validPlinkoDenomination(100, 10)).toBe(true);
    expect(validPlinkoDenomination(100, 3)).toBe(false);
    expect(validPlinkoDenomination(100, 250)).toBe(false);
    expect(validPlinkoDenomination(2500, 10)).toBe(false);
    expect(validPlinkoDenomination(2500, 25)).toBe(true);
    expect(validPlinkoDenomination(100, null)).toBe(false);
    expect(validPlinkoDenomination(NaN, 10)).toBe(false);
  });
  it('never pre-selects a drop value: the default budget has none and cannot start', () => {
    expect(defaultBonusBudget().denomination).toBeNull();
    expect(validPlinkoBudget(defaultBonusBudget())).toBe(false);
    expect(plinkoDrops(defaultBonusBudget())).toBeNull();
    const chosen = { base: 2500, doubled: false, denomination: 250 };
    expect(validPlinkoBudget(chosen)).toBe(true);
    expect(plinkoDrops(chosen)).toBe(10);
  });
  it('clears a saved value that no longer fits the stake instead of re-deriving one', () => {
    // Twenty a drop on 2,500 would be 125 drops: cleared, so the player chooses again.
    const saved = { base: 2500, doubled: false, denomination: 20 };
    expect(plinkoBudget(saved)).toEqual({ base: 2500, doubled: false, denomination: null });
    // Adding the diamonds changes the stake: 250 still divides 5,000 into 20 drops.
    const doubled = { base: 2500, doubled: true, denomination: 250 };
    expect(plinkoBudget(doubled)).toBe(doubled);
    // 500 a drop on 2,500 is five drops; on a doubled 5,000 it is ten. Both stay.
    expect(plinkoBudget({ base: 2500, doubled: true, denomination: 500 }).denomination).toBe(500);
    // A value off the list from an older rule is cleared too.
    expect(plinkoBudget({ base: 2500, doubled: true, denomination: 750 }).denomination).toBeNull();
    expect(plinkoBudget(defaultBonusBudget())).toEqual(defaultBonusBudget());
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
    const budget = { base: 200, doubled: true, denomination: 50, award };
    expect(validBonusBudget(budget)).toBe(true);
    expect(bonusTotal(budget)).toBe(300);
    expect(bonusWalletDebit(budget)).toBe(100);
    expect(bonusWalletDebit({ ...budget, doubled: false })).toBe(0);
  });
  it('permits 7500 only with the exact upgraded 2500 stake and refuses substituted funding', () => {
    const budget = {
      base: 5000,
      doubled: true,
      denomination: 500,
      award: { ...award, entryDiamonds: 2500 },
    };
    expect(validBonusBudget(budget)).toBe(true);
    expect(bonusTotal(budget)).toBe(7500);
    expect(plinkoDrops(budget)).toBe(15);
    expect(validBonusBudget({ ...budget, award: undefined })).toBe(false);
    expect(validBonusBudget({ ...budget, base: 4999 })).toBe(false);
    expect(validBonusBudget({ ...budget, award: { ...award, entryDiamonds: 2501 } })).toBe(false);
  });
  it('reads a funded receipt into a budget carrying the drop value it was dealt', () => {
    const funding = {
      award_id: award.id,
      bet_diamonds: 300,
      bonus: {
        base_diamonds: 200,
        entry_diamonds: 100,
        boost_multiplier: 2,
        added_diamonds: 100,
        total_diamonds: 300,
      },
    };
    expect(earnedReceiptBudget({ ...funding, diamonds_per_drop: 50 })).toEqual({
      base: 200,
      doubled: true,
      denomination: 50,
      award,
    });
    // A Crash or a Choice receipt has no drop value.
    expect(earnedReceiptBudget(funding)).toEqual({
      base: 200,
      doubled: true,
      denomination: null,
      award,
    });
  });
});

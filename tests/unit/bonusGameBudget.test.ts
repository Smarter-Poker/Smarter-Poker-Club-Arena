import { describe, expect, it } from 'vitest';
import { plinkoAllocations, validSpinAmount } from '../../src/utils/bonusGameBudget';
describe('the spin balance is conserved across Plinko denominations', () => {
  it('offers the six requested choices for a 100 diamond spin', () => {
    expect(plinkoAllocations(100).map((x) => [x.drops, x.diamondsPerDrop])).toEqual([
      [100, 1],
      [20, 5],
      [10, 10],
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

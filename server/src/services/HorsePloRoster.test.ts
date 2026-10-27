import { describe, expect, it } from 'vitest';
import {
  __setPloRosterForTest,
  ploRosterAllows,
  __setCashRosterForTest,
  cashRosterAllows,
} from './HorsePloRoster.js';

describe('PLO eligibility is bankroll based, never profit-history based', () => {
  it('allows every PLO variant and stake regardless of the historical list', () => {
    for (const roster of [null, [], ['another-horse']]) {
      __setPloRosterForTest(roster);
      for (const variant of ['nlh', 'plo4', 'plo5', 'plo6', 'plo8']) {
        for (const blind of [0.25, 0.5, 1, 2, 5, 50, undefined]) {
          expect(ploRosterAllows('cash-horse', variant, blind)).toBe(true);
        }
      }
    }
  });
});

describe('only the top cash performance roster can enter cash', () => {
  it('distinguishes unknown membership from a known bench', () => {
    __setCashRosterForTest(null);
    expect(cashRosterAllows('horse')).toBeUndefined();
    __setCashRosterForTest(['top-horse']);
    expect(cashRosterAllows('top-horse')).toBe(true);
    expect(cashRosterAllows('benched-horse')).toBe(false);
    __setCashRosterForTest([]);
    expect(cashRosterAllows('horse')).toBe(false);
  });
});

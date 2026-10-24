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

// Historical rankings never turn a scheduled horse into an ineligible horse.
describe('the entire scheduled fleet can enter cash', () => {
  it('admits off-roster horses even before a ranking read completes', () => {
    for (const ids of [null, [], ['another-horse']]) {
      __setCashRosterForTest(ids);
      expect(cashRosterAllows('scheduled-horse')).toBe(true);
    }
  });
});

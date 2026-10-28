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

describe('the Club Arena cash roster does not bench Diamond Arena horses', () => {
  const diamond = {
    club_id: 'arena',
    union_id: null,
    arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
  };
  it('admits all 1000 registered candidates at Diamond cash with only 500 Club cash members', () => {
    const fleet = Array.from({ length: 1000 }, (_, i) => `horse-${i}`);
    __setCashRosterForTest(fleet.slice(0, 500));
    expect(fleet.filter((id) => cashRosterAllows(id)).length).toBe(500);
    expect(fleet.filter((id) => cashRosterAllows(id, diamond)).length).toBe(1000);
  });
  it('does not infer Diamond exemption from a club id, currency label or malformed identity', () => {
    __setCashRosterForTest(['selected']);
    for (const table of [
      undefined,
      { club_id: 'arena' },
      { ...diamond, club_id: 'other' },
      { ...diamond, union_id: 'union' },
      { ...diamond, arena: { ...diamond.arena, is_platform: false } },
      { club_id: 'chip', arena: { id: 'chip', asset: 'chips', is_platform: false } },
    ]) {
      expect(cashRosterAllows('off-roster', table)).toBe(false);
    }
    __setCashRosterForTest(null);
    expect(cashRosterAllows('off-roster', { club_id: 'unknown' })).toBeUndefined();
    expect(cashRosterAllows('off-roster', diamond)).toBe(true);
  });
});

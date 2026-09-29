/**
 * The hand surfaces print one figure one way.
 *
 * These are not formatting-preference tests. Every case below was a REAL
 * difference between two copies of the same function rendering the same value
 * on screens a player compares side by side, and the point of the module is
 * that the difference can no longer exist.
 */

import { describe, it, expect } from 'vitest';
import { money, blindLabel, stamp, gameTypeLabel } from '../../src/utils/handFormat';

describe('money', () => {
  it('always prints two decimals', () => {
    expect(money(5)).toBe('5.00');
    expect(money(0)).toBe('0.00');
    expect(money(12.5)).toBe('12.50');
  });

  it('groups thousands', () => {
    expect(money(80993.61)).toBe('80,993.61');
  });

  it('prints 0.00 for a non-number, never the string NaN', () => {
    // HandDetailModal.fmt reached for `Math.abs(n) >= 1` first, which is false
    // for NaN, so it fell through to NaN.toFixed(2) and printed "NaN" into a
    // chip figure while the tab beside it printed 0.00 for the same value.
    expect(money(NaN)).toBe('0.00');
    expect(money(null)).toBe('0.00');
    expect(money(undefined)).toBe('0.00');
    expect(money(Infinity)).toBe('0.00');
  });

  it('honours an explicit decimal count', () => {
    expect(money(1234.56, 0)).toBe('1,235');
  });

  it('keeps the sign of a negative, for an uncalled bet returned', () => {
    expect(money(-40)).toBe('-40.00');
  });
});

describe('blindLabel', () => {
  it('prints stakes as they are named, not as a balance', () => {
    // 0.05/0.1 is a game. 0.05/0.10 is a bank statement.
    expect(blindLabel(0.05)).toBe('0.05');
    expect(blindLabel(0.1)).toBe('0.1');
    expect(blindLabel(1)).toBe('1');
    expect(blindLabel(2)).toBe('2');
  });

  it('is NaN-safe like the rest', () => {
    expect(blindLabel(NaN)).toBe('0');
    expect(blindLabel(null)).toBe('0');
  });
});

describe('stamp', () => {
  it('renders an absolute local timestamp', () => {
    expect(stamp('2026-08-27T14:05:09.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('returns empty for a missing or unparseable value', () => {
    // One of the three copies guarded null and two did not, so the same
    // absent timestamp rendered as blank on one surface and "NaN-NaN-NaN
    // NaN:NaN:NaN" on another.
    expect(stamp(null)).toBe('');
    expect(stamp(undefined)).toBe('');
    expect(stamp('')).toBe('');
    expect(stamp('not a date')).toBe('');
  });
});

describe('gameTypeLabel', () => {
  it('prints the lobby names', () => {
    expect(gameTypeLabel('nlh')).toBe('NLH');
    expect(gameTypeLabel('plo')).toBe('PLO');
    expect(gameTypeLabel('plo5')).toBe('PLO5');
    expect(gameTypeLabel('plo6')).toBe('PLO6');
    expect(gameTypeLabel('plo8')).toBe('PLO8');
  });

  it('never shows a player a column key', () => {
    // Two copies mapped short_deck and the third printed the raw value, so the
    // same table read "Short Deck" in the popup and "short_deck" on the page.
    expect(gameTypeLabel('short_deck')).toBe('Short Deck');
    expect(gameTypeLabel('sixplus')).toBe('Short Deck');
    /* MOVED, NOT WEAKENED 2026-09-22: this pinned 'OFC', and that label was the
       defect. Every `ofc_pineapple` row was a Crazy Pineapple table (retired
       2026-08-23), and Open-Face Chinese is excluded by owner decision, so the
       legacy spelling reads as the game it was and a bare `ofc`, which no row
       ever carried, names no game. tests/ofc-is-not-offered.law.test.ts. */
    expect(gameTypeLabel('ofc_pineapple')).toBe('Crazy Pineapple');
    expect(gameTypeLabel('OFC_PINEAPPLE')).toBe('Crazy Pineapple');
    expect(gameTypeLabel('ofc')).toBe('Poker');
    // Anything unrecognised still arrives as words, not as an identifier.
    expect(gameTypeLabel('some_new_variant')).toBe('Some New Variant');
  });

  it('returns null for an absent variant so the chip can be omitted', () => {
    // Not '' - a caller rendering `{label && <chip/>}` on an empty string draws
    // nothing, but one rendering `<chip>{label}</chip>` draws an empty chip.
    expect(gameTypeLabel(null)).toBeNull();
    expect(gameTypeLabel(undefined)).toBeNull();
    expect(gameTypeLabel('   ')).toBeNull();
  });

  it('is case-insensitive, because the column is not normalised', () => {
    expect(gameTypeLabel('NLH')).toBe('NLH');
    expect(gameTypeLabel('PLO5')).toBe('PLO5');
  });
});

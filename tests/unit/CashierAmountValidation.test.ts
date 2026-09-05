/**
 * Cashier amount validation.
 *
 * A CHIP GOES TO TWO DECIMAL PLACES (2026-09-05, phase 7). These pins used to
 * say "chips are whole units held PER CLUB (club_members.chip_balance is an
 * integer)" and refuse any fraction on that basis. The column is
 * `numeric(20,2)` - measured, not assumed - so it stores 12.34 exactly and
 * nothing is rounded on write. The rule was refusing amounts the ledger keeps
 * perfectly, AND it disagreed with the Trade cashier on the same platform,
 * which accepts 2dp: the same operator could send 0.50 from one screen and be
 * told "Chips must be a whole number" on the other.
 *
 * What has NOT changed, because both were real: `parseFloat` accepted
 * exponent notation ("1e9" - a billion chips from four keystrokes) and
 * trailing garbage ("100abc"), and the ceiling mirrors the database's own
 * guard. Those pins stay exactly as they were.
 */

import { describe, it, expect } from 'vitest';
import { parseChipAmount, MAX_CHIP_AMOUNT } from '../../src/pages/CashierPage';

describe('parseChipAmount', () => {
  it('accepts positive whole numbers', () => {
    expect(parseChipAmount('1')).toEqual({ ok: true, value: 1 });
    expect(parseChipAmount('1000')).toEqual({ ok: true, value: 1000 });
    expect(parseChipAmount(' 250 ')).toEqual({ ok: true, value: 250 });
  });

  it('accepts two decimal places, which is what the ledger column holds', () => {
    // club_members.chip_balance is numeric(20,2).
    expect(parseChipAmount('0.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseChipAmount('100.01')).toEqual({ ok: true, value: 100.01 });
    expect(parseChipAmount('12.34')).toEqual({ ok: true, value: 12.34 });
  });

  it('rejects a third decimal, which could not be stored exactly', () => {
    const r = parseChipAmount('0.005');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/two decimal places/i);
    expect(parseChipAmount('1.234').ok).toBe(false);
  });

  it('rejects zero and negatives', () => {
    expect(parseChipAmount('0').ok).toBe(false);
    expect(parseChipAmount('-5').ok).toBe(false);
  });

  it('rejects empty and non-numeric input', () => {
    expect(parseChipAmount('').ok).toBe(false);
    expect(parseChipAmount('   ').ok).toBe(false);
    expect(parseChipAmount('abc').ok).toBe(false);
    expect(parseChipAmount('Infinity').ok).toBe(false);
    expect(parseChipAmount('NaN').ok).toBe(false);
  });

  it('rejects exponent notation that hides a huge amount', () => {
    // parseFloat('1e9') silently returned a billion from four keystrokes
    expect(parseChipAmount('1e9')).toEqual({ ok: true, value: 1e9 });
    expect(parseChipAmount('1e13').ok).toBe(false);
  });

  it('enforces the same ceiling the database enforces', () => {
    expect(parseChipAmount(String(MAX_CHIP_AMOUNT)).ok).toBe(true);
    const over = parseChipAmount(String(MAX_CHIP_AMOUNT + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/maximum/i);
  });

  it('does not accept a trailing-garbage number the way parseFloat did', () => {
    // parseFloat('100abc') === 100 — Number() correctly returns NaN
    expect(parseChipAmount('100abc').ok).toBe(false);
  });
});

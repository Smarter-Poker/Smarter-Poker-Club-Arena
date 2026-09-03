/**
 * Cashier amount validation.
 *
 * Chips are whole units held PER CLUB (club_members.chip_balance is an
 * integer). The page previously validated with `parseFloat` + `<= 0` only,
 * which accepted fractions and exponent notation:
 *
 *   - a fractional amount is rounded on write to the integer column while the
 *     sending side is debited the exact decimal — money created or destroyed
 *   - "1e9" parses to 1,000,000,000 from a field the user typed 4 characters in
 *
 * These cases pin the rules so neither can come back.
 */

import { describe, it, expect } from 'vitest';
import { parseChipAmount, MAX_CHIP_AMOUNT } from '../../src/pages/CashierPage';

describe('parseChipAmount', () => {
  it('accepts positive whole numbers', () => {
    expect(parseChipAmount('1')).toEqual({ ok: true, value: 1 });
    expect(parseChipAmount('1000')).toEqual({ ok: true, value: 1000 });
    expect(parseChipAmount(' 250 ')).toEqual({ ok: true, value: 250 });
  });

  it('rejects fractional amounts — the ledger column is an integer', () => {
    const r = parseChipAmount('0.5');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/whole number/i);
    expect(parseChipAmount('100.01').ok).toBe(false);
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

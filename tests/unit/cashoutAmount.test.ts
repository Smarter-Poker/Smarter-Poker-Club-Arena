import { describe, it, expect } from 'vitest';
import { validateCashoutAmount, cashoutPercentage } from '../../src/utils/cashoutAmount';
describe('cashout exact cents', () => {
  it.each([0.01, 0.29, 1.25, 308.5, 1e9])('preserves numeric and decimal %s', (amount) => {
    for (const input of [amount, String(amount)])
      expect(validateCashoutAmount(input)).toEqual({
        ok: true,
        amount,
        cents: Math.round(amount * 100),
      });
  });
  it.each([
    NaN,
    Infinity,
    -Infinity,
    0,
    -1,
    1.001,
    0.30000000000000004,
    1e9 + 0.01,
    Number.MAX_SAFE_INTEGER,
    '',
    '1.00000000000000001',
    '0.290000000000000001',
    '1000000000.000000001',
  ])('refuses without normalizing %s', (input) =>
    expect(validateCashoutAmount(input).ok).toBe(false)
  );
  it('accepts exact trailing zeros and leading decimal', () => {
    expect(validateCashoutAmount('1.2500')).toEqual({ ok: true, amount: 1.25, cents: 125 });
    expect(validateCashoutAmount('29e-2')).toEqual({ ok: true, amount: 0.29, cents: 29 });
    expect(validateCashoutAmount('1001e-3').ok).toBe(false);
    expect(validateCashoutAmount('.29')).toEqual({ ok: true, amount: 0.29, cents: 29 });
  });
  it('presets floor cents and show their exact selected value', () => {
    expect(cashoutPercentage(1.25, 25)).toBe('0.31');
    expect(cashoutPercentage(1.25, 50)).toBe('0.62');
    expect(cashoutPercentage(1.25, 100)).toBe('1.25');
    expect(cashoutPercentage(0.01, 25)).toBeNull();
    expect(cashoutPercentage(0.01, 100)).toBe('0.01');
  });
});

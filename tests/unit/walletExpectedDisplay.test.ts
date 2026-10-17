import { describe, expect, it } from 'vitest';
import { expectedWalletChipDisplay } from '../e2e/support/walletExpectedDisplay';

describe('production wallet display expectation', () => {
  it.each([
    [0, '0.00'],
    [0.2, '0.20'],
    [12.5, '12.50'],
    [999.99, '999.99'],
    [1_000, '1,000.00'],
    [12_345.67, '12,345.67'],
    [999_999.99, '999,999.99'],
    [1_000_000, '1M'],
    [1_999_999.99, '1.9M'],
    [999_999_999, '999.9M'],
    [1_000_000_000, '1B'],
    [1_299_999_999, '1.2B'],
    [-1_000.5, '-1,000.50'],
  ] as const)('certifies the exact owner reading for %s', (amount, expected) => {
    expect(expectedWalletChipDisplay(amount)).toBe(expected);
  });

  it('distinguishes changed amounts and malformed precision from the expected figure', () => {
    const expected = expectedWalletChipDisplay(1_234.5);
    for (const wrong of ['1,234.51', '1,235.50', '1234.50', '1,234.5', '1.2K', '-']) {
      expect(expected).not.toBe(wrong);
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses unread amounts instead of manufacturing a zero (%s)',
    (amount) => {
      expect(() => expectedWalletChipDisplay(amount)).toThrow();
    }
  );
});

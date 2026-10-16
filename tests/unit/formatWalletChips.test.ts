import { describe, it, expect } from 'vitest';
import { formatWalletChips, compactChips } from '../../src/utils/format';
describe('Wallet Amounts', () => {
  it.each([
    [0, '0.00'],
    [10, '10.00'],
    [1000, '1,000.00'],
    [1250.5, '1,250.50'],
    [999999.99, '999,999.99'],
    [-1000.5, '-1,000.50'],
    [1000000, '1M'],
    [1250000, '1.2M'],
  ])('prints %s as %s', (value, text) => expect(formatWalletChips(Number(value))).toBe(text));
  it('keeps unknown distinct from zero', () => {
    expect(formatWalletChips(NaN)).toBe('-');
    expect(formatWalletChips(null)).toBe('-');
  });
  it('preserves compact statistics', () => expect(compactChips(1250)).toBe('1.2K'));
});

import { describe, it, expect } from 'vitest';
import { formatWalletChips, formatWalletDiamonds, compactChips } from '../../src/utils/format';
describe('Wallet Amounts', () => {
  it.each([
    [0, '0.00'],
    [10, '10.00'],
    [1000, '1,000.00'],
    [1250.5, '1,250.50'],
    [999999.99, '999,999.99'],
    [-1000.5, '-1,000.50'],
    [6000, '6,000.00'],
    [1000000, '1,000,000.00'],
    [1250000, '1,250,000.00'],
    [79345678.12, '79,345,678.12'],
    [1000000000, '1,000,000,000.00'],
    [-1250000.5, '-1,250,000.50'],
  ])('prints %s as %s', (value, text) => expect(formatWalletChips(Number(value))).toBe(text));
  it('keeps unknown distinct from zero', () => {
    expect(formatWalletChips(NaN)).toBe('-');
    expect(formatWalletChips(null)).toBe('-');
  });
  it('preserves compact statistics', () => expect(compactChips(1250)).toBe('1.2K'));
});

describe('Diamond Wallet Amounts', () => {
  it.each([
    [0, '0'],
    [1000, '1,000'],
    [1250, '1,250'],
    [999999, '999,999'],
    [1000000, '1M'],
  ])('prints %s as %s', (amount, expected) => {
    expect(formatWalletDiamonds(Number(amount))).toBe(expected);
  });
  it('keeps an unavailable balance distinct from zero', () => {
    for (const amount of [null, undefined, NaN, Infinity])
      expect(formatWalletDiamonds(amount)).toBe('-');
  });
});

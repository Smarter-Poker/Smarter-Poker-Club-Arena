import { describe, expect, it } from 'vitest';
import { isExactCashierWalletFigure } from '../e2e/support/cashierFigureFormat';

describe('production wallet precision certificate', () => {
  it.each([
    '0.00',
    '0.20',
    '12.50',
    '1,000.00',
    '12,164.92',
    '999,999.99',
    '-1,000.50',
    '1M',
    '1.2M',
    '1B',
  ])('accepts the owner wallet reading %s', (value) => {
    expect(isExactCashierWalletFigure(value)).toBe(true);
  });
  it.each([
    '0',
    '1000.00',
    '1,00.00',
    '1,000',
    '12.5',
    '12.345',
    '1K',
    '999.9K',
    '1,000,000.00',
    '0.5M',
    'Unavailable',
    '-',
  ])('rejects a malformed, abbreviated-small or unread balance %s', (value) => {
    expect(isExactCashierWalletFigure(value)).toBe(false);
  });
});

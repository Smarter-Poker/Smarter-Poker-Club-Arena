import { describe, expect, it } from 'vitest';
import { playerRecordMoney } from '../src/utils/playerRecordMoney';

describe('player record monetary precision', () => {
  it.each([
    [0, '0.00'],
    [-0, '0.00'],
    [0.01, '+0.01'],
    [-0.01, '-0.01'],
    [-0.4, '-0.40'],
    [-450.9, '-450.90'],
    [999.99, '+999.99'],
    [1000.01, '+1,000.01'],
    [10234.57, '+10,234.57'],
    [-1250.75, '-1,250.75'],
    [1000000.99, '+1,000,000.99'],
  ])('retains every cent of signed %s', (amount, expected) => {
    expect(playerRecordMoney(amount, true)).toBe(expected);
  });

  it('prints unsigned financial stats with the same full precision', () => {
    expect(playerRecordMoney(12345.67)).toBe('12,345.67');
    expect(playerRecordMoney(18)).toBe('18.00');
  });

  it('keeps restricted and unavailable figures distinct from zero', () => {
    expect(playerRecordMoney(null)).toBe('Restricted');
    expect(playerRecordMoney(undefined, true)).toBe('Restricted');
    expect(playerRecordMoney(NaN)).toBe('-');
    expect(playerRecordMoney(Infinity, true)).toBe('-');
  });
});

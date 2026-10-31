import { describe, expect, it } from 'vitest';
import { formatSessionProfit } from '../src/utils/formatSessionProfit';

describe('recorded session profit precision', () => {
  it.each([
    [3.3, '3.30'],
    [0.01, '0.01'],
    [0, '0.00'],
    [1234.56, '1,234.56'],
  ])('preserves cents for %s', (amount, label) => {
    expect(formatSessionProfit(amount)).toBe(label);
  });
});

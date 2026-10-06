import { describe, expect, it } from 'vitest';
import { compactChips } from '../../src/utils/format';

describe('compactChips', () => {
  it('never prints a negative zero for a sub-unit loss', () => {
    expect(compactChips(-0.5)).toBe('0');
  });
});

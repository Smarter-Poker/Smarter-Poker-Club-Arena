/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableKeyboard
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { useTableKeyboard } from '../../src/hooks/useTableKeyboard';

describe('useTableKeyboard', () => {
  it('should export useTableKeyboard as a function', () => {
    expect(typeof useTableKeyboard).toBe('function');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useFocusTrap
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';
import { useFocusTrap } from '../../src/hooks/useFocusTrap';

describe('useFocusTrap', () => {
  it('should export useFocusTrap as a function', () => {
    expect(typeof useFocusTrap).toBe('function');
  });
});

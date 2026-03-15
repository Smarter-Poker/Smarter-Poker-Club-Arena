/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableModals
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { useTableModals } from '../../src/hooks/useTableModals';

describe('useTableModals', () => {
  it('should export useTableModals as a function', () => {
    expect(typeof useTableModals).toBe('function');
  });
});

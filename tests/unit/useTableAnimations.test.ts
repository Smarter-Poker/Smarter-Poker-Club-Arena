/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableAnimations
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { useTableAnimations } from '../../src/hooks/useTableAnimations';

describe('useTableAnimations', () => {
  it('should export useTableAnimations as a function', () => {
    expect(typeof useTableAnimations).toBe('function');
  });
});

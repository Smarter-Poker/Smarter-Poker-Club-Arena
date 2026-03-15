/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useSwipeAction
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { useSwipeAction } from '../../src/hooks/useSwipeAction';

describe('useSwipeAction', () => {
  it('should export useSwipeAction as a function', () => {
    expect(typeof useSwipeAction).toBe('function');
  });
});

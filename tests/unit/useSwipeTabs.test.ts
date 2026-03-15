/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useSwipeTabs
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { useSwipeTabs } from '../../src/hooks/useSwipeTabs';

describe('useSwipeTabs', () => {
  it('should export useSwipeTabs as a function', () => {
    expect(typeof useSwipeTabs).toBe('function');
  });
});

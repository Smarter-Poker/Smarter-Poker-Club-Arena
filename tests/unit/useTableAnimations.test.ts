/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableAnimations
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTableAnimations } from '../../src/hooks/useTableAnimations';

describe('useTableAnimations', () => {
  it('should export useTableAnimations as a function', () => {
    expect(typeof useTableAnimations).toBe('function');
  });

  it('should return animation state for a given seat count', () => {
    const { result } = renderHook(() => useTableAnimations(6));
    expect(result.current).toBeDefined();
    expect(typeof result.current).toBe('object');
  });
});

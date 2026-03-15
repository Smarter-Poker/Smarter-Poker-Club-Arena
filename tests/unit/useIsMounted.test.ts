/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useIsMounted
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useIsMounted } from '../../src/hooks/useIsMounted';

describe('useIsMounted', () => {
  it('should return a ref object', () => {
    const { result } = renderHook(() => useIsMounted());
    expect(result.current).toBeDefined();
    expect(typeof result.current).toBe('object');
  });

  it('should be true while mounted', () => {
    const { result } = renderHook(() => useIsMounted());
    expect(result.current.current).toBe(true);
  });

  it('should be false after unmount', () => {
    const { result, unmount } = renderHook(() => useIsMounted());
    unmount();
    expect(result.current.current).toBe(false);
  });
});

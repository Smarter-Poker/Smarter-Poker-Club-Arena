/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useVisibilityRefresh
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVisibilityRefresh } from '../../src/hooks/useVisibilityRefresh';

describe('useVisibilityRefresh', () => {
  it('should accept a refresh function', () => {
    const refreshFn = vi.fn();
    const { unmount } = renderHook(() => useVisibilityRefresh(refreshFn));
    unmount();
    // Just verifying it doesn't throw
  });

  it('should be a function export', () => {
    expect(typeof useVisibilityRefresh).toBe('function');
  });

  it('should not call refresh on mount', () => {
    const refreshFn = vi.fn();
    renderHook(() => useVisibilityRefresh(refreshFn));
    expect(refreshFn).not.toHaveBeenCalled();
  });
});

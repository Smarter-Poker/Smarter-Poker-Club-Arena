/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useOptimisticMutation
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOptimisticMutation } from '../../src/hooks/useOptimisticMutation';

describe('useOptimisticMutation', () => {
  it('should be a function export', () => {
    expect(typeof useOptimisticMutation).toBe('function');
  });

  it('should return mutation result object with mutate', () => {
    const { result } = renderHook(() =>
      useOptimisticMutation({
        mutationFn: vi.fn().mockResolvedValue({}),
        onSuccess: vi.fn(),
        onError: vi.fn(),
      })
    );
    expect(result.current).toBeDefined();
    expect(typeof result.current.mutate).toBe('function');
  });

  it('should start with isPending false', () => {
    const { result } = renderHook(() =>
      useOptimisticMutation({
        mutationFn: vi.fn().mockResolvedValue({}),
        onSuccess: vi.fn(),
        onError: vi.fn(),
      })
    );
    expect(result.current.isPending).toBe(false);
  });

  it('should start with pendingCount 0', () => {
    const { result } = renderHook(() =>
      useOptimisticMutation({
        mutationFn: vi.fn().mockResolvedValue({}),
        onSuccess: vi.fn(),
        onError: vi.fn(),
      })
    );
    expect(result.current.pendingCount).toBe(0);
  });

  it('should start with no error', () => {
    const { result } = renderHook(() =>
      useOptimisticMutation({
        mutationFn: vi.fn().mockResolvedValue({}),
        onSuccess: vi.fn(),
        onError: vi.fn(),
      })
    );
    expect(result.current.error).toBeNull();
  });
});

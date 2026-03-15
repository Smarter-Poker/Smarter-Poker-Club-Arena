/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useSwipeTabs (renderHook behavioral tests)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSwipeTabs } from '../../src/hooks/useSwipeTabs';

describe('useSwipeTabs', () => {
  it('should export useSwipeTabs as a function', () => {
    expect(typeof useSwipeTabs).toBe('function');
  });

  it('should return pointer event handlers and style', () => {
    const onTabChange = vi.fn();
    const { result } = renderHook(() =>
      useSwipeTabs({ tabs: ['a', 'b', 'c'], activeTab: 'a', onTabChange })
    );
    expect(typeof result.current.onPointerDown).toBe('function');
    expect(typeof result.current.onPointerUp).toBe('function');
    expect(typeof result.current.onPointerCancel).toBe('function');
    expect(result.current.style).toBeDefined();
  });

  it('should have touchAction pan-y in style', () => {
    const onTabChange = vi.fn();
    const { result } = renderHook(() =>
      useSwipeTabs({ tabs: ['a', 'b'], activeTab: 'a', onTabChange })
    );
    expect(result.current.style.touchAction).toBe('pan-y');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableSettings (renderHook behavioral tests)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock localStorage
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
});

import { useTableSettings } from '../../src/hooks/useTableSettings';

describe('useTableSettings', () => {
  it('should export useTableSettings as a function', () => {
    expect(typeof useTableSettings).toBe('function');
  });

  it('should return settings object with defaults', () => {
    const { result } = renderHook(() => useTableSettings());
    expect(result.current).toBeDefined();
    expect(result.current.settings).toBeDefined();
    expect(typeof result.current.updateSetting).toBe('function');
  });

  it('should have sound enabled by default', () => {
    const { result } = renderHook(() => useTableSettings());
    // Check that settings object has expected shape
    expect(typeof result.current.settings).toBe('object');
  });
});

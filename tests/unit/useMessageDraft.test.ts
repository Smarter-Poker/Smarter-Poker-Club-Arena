/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useMessageDraft (renderHook behavioral tests)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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

import { useMessageDraft } from '../../src/hooks/useMessageDraft';

describe('useMessageDraft', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
  });

  it('should export useMessageDraft as a function', () => {
    expect(typeof useMessageDraft).toBe('function');
  });

  it('should return [draft, setDraft, clearDraft]', () => {
    const { result } = renderHook(() => useMessageDraft('conv-1'));
    expect(result.current).toHaveLength(3);
    expect(typeof result.current[0]).toBe('string');
    expect(typeof result.current[1]).toBe('function');
    expect(typeof result.current[2]).toBe('function');
  });

  it('should start with empty draft', () => {
    const { result } = renderHook(() => useMessageDraft('conv-new'));
    expect(result.current[0]).toBe('');
  });

  it('should update draft when setDraft is called', () => {
    const { result } = renderHook(() => useMessageDraft('conv-2'));
    act(() => {
      result.current[1]('Hello world');
    });
    expect(result.current[0]).toBe('Hello world');
  });

  it('should clear draft', () => {
    const { result } = renderHook(() => useMessageDraft('conv-3'));
    act(() => {
      result.current[1]('Some text');
    });
    act(() => {
      result.current[2]();
    });
    expect(result.current[0]).toBe('');
  });
});

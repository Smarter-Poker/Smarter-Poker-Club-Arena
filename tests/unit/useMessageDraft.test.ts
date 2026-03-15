/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useMessageDraft
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

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
  it('should export useMessageDraft as a function', () => {
    expect(typeof useMessageDraft).toBe('function');
  });
});

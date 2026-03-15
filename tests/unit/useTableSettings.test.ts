/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableSettings
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

import { useTableSettings } from '../../src/hooks/useTableSettings';

describe('useTableSettings', () => {
  it('should export useTableSettings as a function', () => {
    expect(typeof useTableSettings).toBe('function');
  });
});

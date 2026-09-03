/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — staleCacheReaper
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

// Mock indexedDB
vi.stubGlobal('indexedDB', {
  open: vi.fn().mockReturnValue({
    addEventListener: vi.fn(),
    result: { objectStoreNames: { contains: vi.fn(() => false) } },
  }),
});

import { scheduleStaleCacheReaper } from '../../src/utils/staleCacheReaper';

describe('staleCacheReaper', () => {
  it('should export scheduleStaleCacheReaper as a function', () => {
    expect(typeof scheduleStaleCacheReaper).toBe('function');
  });

  it('should not throw when called', () => {
    scheduleStaleCacheReaper();
  });
});

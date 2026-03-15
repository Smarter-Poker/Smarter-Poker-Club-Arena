/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — usePrefetch
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPrefetchedData, clearPrefetch } from '../../src/hooks/usePrefetch';
import usePrefetch from '../../src/hooks/usePrefetch';

describe('usePrefetch', () => {
  it('should export usePrefetch as a function', () => {
    expect(typeof usePrefetch).toBe('function');
  });

  it('should export getPrefetchedData as a function', () => {
    expect(typeof getPrefetchedData).toBe('function');
  });

  it('should export clearPrefetch as a function', () => {
    expect(typeof clearPrefetch).toBe('function');
  });

  it('should return undefined for non-existent key', () => {
    expect(getPrefetchedData('nonexistent-key')).toBeUndefined();
  });

  it('should clear prefetch without throwing', () => {
    clearPrefetch('some-key');
  });
});

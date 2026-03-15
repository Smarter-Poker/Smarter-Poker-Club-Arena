/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — lazyWithRetry
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import lazyWithRetry from '../../src/utils/lazyWithRetry';

describe('lazyWithRetry', () => {
  it('should export lazyWithRetry as a function', () => {
    expect(typeof lazyWithRetry).toBe('function');
  });

  it('should return a lazy component', () => {
    const LazyComponent = lazyWithRetry(() => import('../../src/App') as any);
    expect(LazyComponent).toBeDefined();
  });
});

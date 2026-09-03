/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTabKeepAlive
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('Worker', vi.fn());

import {
  workerTimeout,
  cancelWorkerTimeout,
  useTabKeepAlive,
} from '../../src/hooks/useTabKeepAlive';

describe('useTabKeepAlive', () => {
  it('should export workerTimeout as a function', () => {
    expect(typeof workerTimeout).toBe('function');
  });

  it('should export cancelWorkerTimeout as a function', () => {
    expect(typeof cancelWorkerTimeout).toBe('function');
  });

  it('should export useTabKeepAlive as a function', () => {
    expect(typeof useTabKeepAlive).toBe('function');
  });

  it('should cancel without throwing for unknown id', () => {
    cancelWorkerTimeout(999);
  });
});

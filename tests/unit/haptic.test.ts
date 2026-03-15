/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — haptic
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('navigator', { vibrate: vi.fn() });

import haptic from '../../src/utils/haptic';

describe('haptic', () => {
  it('should be a function', () => {
    expect(typeof haptic).toBe('function');
  });

  it('should not throw with default style', () => {
    haptic();
  });

  it('should not throw with light style', () => {
    haptic('light');
  });

  it('should not throw with medium style', () => {
    haptic('medium');
  });

  it('should not throw with heavy style', () => {
    haptic('heavy');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ScreenShake
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { triggerScreenShake, useScreenShake } from '../../src/utils/ScreenShake';

describe('ScreenShake', () => {
  it('should export triggerScreenShake as a function', () => {
    expect(typeof triggerScreenShake).toBe('function');
  });

  it('should export useScreenShake as a function', () => {
    expect(typeof useScreenShake).toBe('function');
  });

  it('should return cleanup fn for light intensity', () => {
    const cleanup = triggerScreenShake('light');
    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('should return cleanup fn for medium intensity', () => {
    const cleanup = triggerScreenShake('medium');
    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('should return cleanup fn for heavy intensity', () => {
    const cleanup = triggerScreenShake('heavy');
    expect(typeof cleanup).toBe('function');
    cleanup();
  });
});

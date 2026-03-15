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

  it('should not throw when called without DOM', () => {
    triggerScreenShake({ intensity: 'light' });
  });

  it('should accept medium intensity', () => {
    triggerScreenShake({ intensity: 'medium' });
  });

  it('should accept heavy intensity', () => {
    triggerScreenShake({ intensity: 'heavy' });
  });
});

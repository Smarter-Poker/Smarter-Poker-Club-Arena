/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — usePoker (7 exported hooks)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import {
  useCountdown,
  useBlindTimer,
  useActionTimer,
  useChipAnimations,
  usePotOdds,
  useHandHistory,
  useBetSlider,
} from '../../src/hooks/usePoker';

describe('usePoker exports', () => {
  it('should export useCountdown', () => {
    expect(typeof useCountdown).toBe('function');
  });

  it('should export useBlindTimer', () => {
    expect(typeof useBlindTimer).toBe('function');
  });

  it('should export useActionTimer', () => {
    expect(typeof useActionTimer).toBe('function');
  });

  it('should export useChipAnimations', () => {
    expect(typeof useChipAnimations).toBe('function');
  });

  it('should export usePotOdds', () => {
    expect(typeof usePotOdds).toBe('function');
  });

  it('should export useHandHistory', () => {
    expect(typeof useHandHistory).toBe('function');
  });

  it('should export useBetSlider', () => {
    expect(typeof useBetSlider).toBe('function');
  });
});

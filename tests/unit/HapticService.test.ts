/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — HapticService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests HAPTIC_PATTERNS, isHapticSupported, triggerHaptic, stopHaptic,
 * useHaptic hook, and haptic convenience object.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isHapticSupported,
  triggerHaptic,
  stopHaptic,
  useHaptic,
  haptic,
} from '../../src/services/HapticService';
import { __resetVibrationCoalescing } from '../../src/utils/vibrationGate';

describe('HapticService', () => {
  const mockVibrate = vi.fn();

  beforeEach(() => {
    // Mock navigator.vibrate
    Object.defineProperty(navigator, 'vibrate', {
      value: mockVibrate,
      writable: true,
      configurable: true,
    });
    vi.clearAllMocks();
    // fireVibration coalesces within a 60ms window and suppresses any pattern
    // that is not STRONGER than the previous one. Every case in this file runs
    // inside that window, so without a reset the first heavy/error pattern
    // silently swallowed the five that followed it — the suite went red on main
    // and the failures looked like HapticService bugs rather than test bleed.
    // The gate ships `__resetVibrationCoalescing` for exactly this; it was just
    // never wired up.
    __resetVibrationCoalescing();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isHapticSupported', () => {
    it('should return true when navigator.vibrate exists', () => {
      expect(isHapticSupported()).toBe(true);
    });
  });

  describe('triggerHaptic', () => {
    it('should call navigator.vibrate with light pattern (10ms)', () => {
      triggerHaptic('light');
      expect(mockVibrate).toHaveBeenCalledWith(10);
    });

    it('should call navigator.vibrate with medium pattern (25ms)', () => {
      triggerHaptic('medium');
      expect(mockVibrate).toHaveBeenCalledWith(25);
    });

    it('should call navigator.vibrate with heavy pattern (50ms)', () => {
      triggerHaptic('heavy');
      expect(mockVibrate).toHaveBeenCalledWith(50);
    });

    it('should call navigator.vibrate with success pattern', () => {
      triggerHaptic('success');
      expect(mockVibrate).toHaveBeenCalledWith([10, 50, 30]);
    });

    it('should call navigator.vibrate with warning pattern', () => {
      triggerHaptic('warning');
      expect(mockVibrate).toHaveBeenCalledWith([30, 30, 30]);
    });

    it('should call navigator.vibrate with error pattern', () => {
      triggerHaptic('error');
      expect(mockVibrate).toHaveBeenCalledWith([50, 100, 50, 100]);
    });

    it('should call navigator.vibrate with selection pattern (5ms)', () => {
      triggerHaptic('selection');
      expect(mockVibrate).toHaveBeenCalledWith(5);
    });

    it('should default to light when no type specified', () => {
      triggerHaptic();
      expect(mockVibrate).toHaveBeenCalledWith(10);
    });

    it('should return true on success', () => {
      expect(triggerHaptic('light')).toBe(true);
    });
  });

  describe('stopHaptic', () => {
    it('should call navigator.vibrate(0)', () => {
      stopHaptic();
      expect(mockVibrate).toHaveBeenCalledWith(0);
    });
  });

  describe('useHaptic', () => {
    it('should return triggerHaptic function', () => {
      expect(useHaptic()).toBe(triggerHaptic);
    });
  });

  describe('haptic convenience object', () => {
    it('should have all 7 haptic types', () => {
      expect(typeof haptic.light).toBe('function');
      expect(typeof haptic.medium).toBe('function');
      expect(typeof haptic.heavy).toBe('function');
      expect(typeof haptic.success).toBe('function');
      expect(typeof haptic.warning).toBe('function');
      expect(typeof haptic.error).toBe('function');
      expect(typeof haptic.selection).toBe('function');
    });

    it('haptic.heavy() should trigger heavy vibration', () => {
      haptic.heavy();
      expect(mockVibrate).toHaveBeenCalledWith(50);
    });
  });
});

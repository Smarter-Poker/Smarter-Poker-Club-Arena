/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HapticService — Haptic Feedback for Club Arena
 * ═══════════════════════════════════════════════════════════════════════════════
 * Provides tactile feedback on supported devices (mobile)
 */

import { fireVibration, stopVibration, isVibrationCapable } from '../utils/vibrationGate';

export type HapticType =
  | 'light'
  | 'medium'
  | 'heavy'
  | 'success'
  | 'warning'
  | 'error'
  | 'selection';

/**
 * Vibration patterns for different haptic types (in milliseconds)
 */
const HAPTIC_PATTERNS: Record<HapticType, number | number[]> = {
  light: 10,
  medium: 25,
  heavy: 50,
  success: [10, 50, 30], // Short pause long
  warning: [30, 30, 30], // Three quick pulses
  error: [50, 100, 50, 100], // Two strong pulses
  selection: 5, // Ultra-light tap
};

/**
 * Check if haptic feedback is supported on this device
 */
export function isHapticSupported(): boolean {
  /* `'vibrate' in navigator` was false on every iPhone and iPad, because Apple
     has never shipped the Vibration API. Since 2026-09-05 the gate can buzz an
     iPhone through a native switch control, so support is the gate's question
     to answer, not a property sniff's. */
  return isVibrationCapable();
}

/**
 * Trigger haptic feedback
 * @param type - The type of haptic feedback to trigger
 * @returns true if haptic was triggered, false if not supported
 */
/**
 * ANIMATION/SOUND AUDIT 2026-08-20: this read only 'vibrationsEnabled', so the
 * IN-TABLE vibration toggle did nothing to any haptic routed through here.
 * Both switches now live in one shared gate used by every implementation.
 */
export function triggerHaptic(type: HapticType = 'light'): boolean {
  return fireVibration(HAPTIC_PATTERNS[type]);
}

/**
 * Stop any ongoing haptic feedback
 */
export function stopHaptic(): void {
  stopVibration();
}

/**
 * React hook for haptic feedback
 * Usage: const haptic = useHaptic();
 *        onClick={() => { haptic('medium'); doSomething(); }}
 */
export function useHaptic() {
  return triggerHaptic;
}

// Convenience methods for common haptic types
export const haptic = {
  light: () => triggerHaptic('light'),
  medium: () => triggerHaptic('medium'),
  heavy: () => triggerHaptic('heavy'),
  success: () => triggerHaptic('success'),
  warning: () => triggerHaptic('warning'),
  error: () => triggerHaptic('error'),
  selection: () => triggerHaptic('selection'),
};

export default haptic;

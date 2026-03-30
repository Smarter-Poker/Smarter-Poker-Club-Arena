/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HapticService — Haptic Feedback for Club Arena
 * ═══════════════════════════════════════════════════════════════════════════════
 * Provides tactile feedback on supported devices (mobile)
 */

import { reportError } from '../utils/errorReporter';

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
  return typeof navigator !== 'undefined' && 'vibrate' in navigator;
}

/**
 * Trigger haptic feedback
 * @param type - The type of haptic feedback to trigger
 * @returns true if haptic was triggered, false if not supported
 */
export function triggerHaptic(type: HapticType = 'light'): boolean {
  if (!isHapticSupported()) {
    return false;
  }

  // Respect user's vibration preference from HamburgerMenu toggle
  try {
    const vibrationPref = localStorage.getItem('vibrationsEnabled');
    if (vibrationPref === 'false') return false;
  } catch {
    // localStorage unavailable — allow vibration
  }

  try {
    const pattern = HAPTIC_PATTERNS[type];
    navigator.vibrate(pattern);
    return true;
  } catch (error: unknown) {
    reportError(error, 'HapticService.trigger');
    return false;
  }
}

/**
 * Stop any ongoing haptic feedback
 */
export function stopHaptic(): void {
  if (isHapticSupported()) {
    navigator.vibrate(0);
  }
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

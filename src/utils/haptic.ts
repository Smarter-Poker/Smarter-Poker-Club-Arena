/**
 * Haptic Feedback Utility — Club Arena
 * Centralized mobile vibration patterns for premium UX.
 * Safe no-op on unsupported browsers.
 *
 * Usage: import { haptic } from '../utils/haptic';
 *        haptic('success');
 */

type HapticStyle = 'light' | 'medium' | 'heavy' | 'success' | 'error' | 'double' | 'allIn' | 'tap';

const PATTERNS: Record<HapticStyle, number[]> = {
  light: [10],
  medium: [30],
  heavy: [50],
  success: [15, 50, 15],
  error: [30, 30, 30],
  double: [20, 40, 20],
  allIn: [50, 30, 80],
  tap: [8],
};

export function haptic(style: HapticStyle = 'light'): void {
  if (typeof navigator === 'undefined' || !navigator.vibrate) return;
  try {
    navigator.vibrate(PATTERNS[style] || PATTERNS.light);
  } catch {
    /* silently ignore on restricted contexts */
  }
}

export default haptic;

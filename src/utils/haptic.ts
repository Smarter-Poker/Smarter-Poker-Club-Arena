/**
 * Haptic Feedback Utility — Club Arena
 * Centralized mobile vibration patterns for premium UX.
 * Safe no-op on unsupported browsers.
 *
 * Usage: import { haptic } from '../utils/haptic';
 *        haptic('success');
 */

import { fireVibration } from './vibrationGate';

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

/**
 * ANIMATION/SOUND AUDIT 2026-08-20: this used to call navigator.vibrate
 * directly, checking nothing. It was the one haptic path that honoured NEITHER
 * vibration switch — so a player who turned vibration off was still buzzed by
 * every call site importing this helper. Routed through the shared gate.
 */
export function haptic(style: HapticStyle = 'light'): void {
  fireVibration(PATTERNS[style] || PATTERNS.light);
}

export default haptic;

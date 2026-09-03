/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  POPUPS STAY QUIET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21, with two screenshots taken during play:
 *
 *   "The Table Is Busy - Please Try Again"
 *   "Connection Problem. Please Check Your Internet And Try Again."
 *
 * "You need to stop these pop ups to users. The only thing that should ever
 * appear is a disconnection notification. And it shouldn't just keep popping
 * it up over and over and over."
 *
 * Both are the client narrating its own recovery. The first is a 429 that four
 * backoff retries had already exhausted; the second is a fetch the next poll
 * will repeat in two seconds. Neither asks the player to do anything, and the
 * loops that produce them produce them again, which is the "over and over".
 *
 * These tests pin the rule and, just as importantly, pin its LIMIT: an error
 * that answers something the player deliberately did must still be shown, or
 * a player taps Buy In with no chips and the app simply does nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldSurfaceError,
  isSelfHealingMessage,
  SILENT_ERROR_CATEGORIES,
  categorizeError,
} from '../../src/utils/safeErrorMessage';

describe('popups the player must never be interrupted by', () => {
  it('silences the exact two messages from the screenshots', () => {
    expect(shouldSurfaceError('The table is busy - please try again')).toBe(false);
    // The raw form that becomes "Connection Problem..." for the player.
    expect(shouldSurfaceError('TypeError: Failed to fetch')).toBe(false);
  });

  it('silences everything the client is already recovering from', () => {
    for (const m of [
      'The table is busy - please try again',
      'Server unreachable',
      'Server error (503)',
      'Table not ready - reconnecting',
      'Your seat is out of sync with the table - resyncing',
    ]) {
      expect(isSelfHealingMessage(m), `"${m}" should be self-healing`).toBe(true);
      expect(shouldSurfaceError(m), `"${m}" reached the player`).toBe(false);
    }
  });

  it('silences the transient infrastructure categories', () => {
    for (const cat of SILENT_ERROR_CATEGORIES) {
      expect(['network', 'timeout', 'rateLimit', 'server']).toContain(cat);
    }
    expect(categorizeError('TypeError: Failed to fetch')).toBe('network');
    expect(shouldSurfaceError('request timed out')).toBe(false);
  });

  it('never shows an empty popup', () => {
    expect(shouldSurfaceError('')).toBe(false);
    expect(shouldSurfaceError(null)).toBe(false);
    expect(shouldSurfaceError(undefined)).toBe(false);
  });

  // ── THE LIMIT ────────────────────────────────────────────────────────────
  // Suppression must not become "swallow everything". Each of these answers a
  // deliberate player action and has something for them to do about it.
  it('still shows errors the player can act on', () => {
    for (const m of [
      'Not enough chips',
      'You do not have permission',
      'Raise is below the minimum',
      'Your session expired',
    ]) {
      expect(shouldSurfaceError(m), `"${m}" was wrongly suppressed`).toBe(true);
    }
  });

  it('does not swallow a real message just because it says busy', () => {
    // "busy" as a loose keyword would also eat a seat-level message a player
    // genuinely needs. Only the distinctive phrase is matched.
    expect(isSelfHealingMessage('That seat is busy right now')).toBe(false);
    expect(shouldSurfaceError('That seat is busy right now')).toBe(true);
  });
});

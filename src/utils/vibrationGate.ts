/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  VIBRATION GATE — the single place that decides whether the phone buzzes
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ANIMATION/SOUND AUDIT 2026-08-20.
 *
 * Club Arena grew THREE separate haptic implementations, and two of them were
 * wrong in different ways:
 *
 *   src/services/SoundService.ts  `haptic`        honoured BOTH preference keys
 *   src/services/HapticService.ts `triggerHaptic` honoured only ONE
 *   src/utils/haptic.ts           `haptic()`      honoured NEITHER — it went
 *                                                 straight to navigator.vibrate
 *
 * There are also two switches a player can reach, writing different keys:
 *
 *   'vibrationsEnabled'      — Settings / HamburgerMenu (synced to the profile)
 *   'ca_vibration_enabled'   — the in-table toggle (useTableSound)
 *
 * So "turn vibration off" worked or didn't depending on which switch you used
 * and which code path happened to fire. Turning it off in the table and still
 * being buzzed by a fold or a keypad tap is the kind of thing that reads as the
 * app ignoring you.
 *
 * ONE gate now, and it fails CLOSED on the user's intent: either switch being
 * off silences everything. Every implementation delegates here, so a future
 * fourth one can only be added by going through this file.
 */

const SETTINGS_KEY = 'vibrationsEnabled'; // Settings / HamburgerMenu
const IN_TABLE_KEY = 'ca_vibration_enabled'; // in-table toggle (useTableSound)

/** True when the device can vibrate AND the player has not switched it off. */
export function isVibrationAllowed(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    return false;
  }
  try {
    // EITHER switch being off wins. Absent means "not configured" -> allowed.
    if (localStorage.getItem(IN_TABLE_KEY) === 'false') return false;
    if (localStorage.getItem(SETTINGS_KEY) === 'false') return false;
    return true;
  } catch {
    // localStorage unavailable (private mode, embedded webview): the player has
    // expressed no preference we can read, so fall back to allowing it.
    return true;
  }
}

/**
 * The PREFERENCE only, ignoring whether this device can vibrate at all.
 *
 * `isVibrationAllowed` answers "should we buzz right now", so it returns false
 * on a desktop with no vibrate API — correct for firing a buzz, wrong for
 * painting a switch. A desktop player whose haptics control reads permanently
 * OFF because their hardware has no motor is being told they turned something
 * off that they did not.
 *
 * Same two keys, same fail-closed rule: either being off means off.
 */
export function isVibrationPreferred(): boolean {
  try {
    if (localStorage.getItem(IN_TABLE_KEY) === 'false') return false;
    if (localStorage.getItem(SETTINGS_KEY) === 'false') return false;
    return true;
  } catch {
    return true; // no readable preference is not a preference to be silent
  }
}

export function setVibrationAllowed(allowed: boolean): void {
  const val = allowed ? 'true' : 'false';
  /* The one function in this file, and in soundGate, that was not guarded.
     `setItem` THROWS in Safari private mode and in storage-restricted webviews
     — the environments the catch above names by name — and the only caller runs
     inside a MasterBus subscriber, so the throw escaped into a bus dispatch and
     took the emit after it (and possibly the remaining subscribers) with it. */
  try {
    localStorage.setItem(IN_TABLE_KEY, val);
    localStorage.setItem(SETTINGS_KEY, val);
  } catch {
    /* private mode: the buzz still follows the in-memory decision this call
       came from; only the memory of it across a reload is lost. */
  }
}

/**
 * ─── COALESCING ────────────────────────────────────────────────────────────
 *
 * One game event must produce ONE buzz. Sixteen call sites fire a haptic AND
 * a soundService.play*(), and every play method ends with its own haptic — so
 * a check, a flop card, a disconnect, a squeeze, a throwable impact and a
 * mystery-bounty reveal all buzzed the phone twice, milliseconds apart. Two
 * pulses where one was designed reads as a stutter, not as emphasis.
 *
 * Deleting the explicit calls would have been the obvious fix and would have
 * been wrong: the internal haptic sits AFTER `shouldPlay()`, which returns
 * false when sound is muted or when a higher-priority sound already claimed
 * the 50ms window. So the internal buzz is silently coupled to sound —
 * muting sound would take vibration with it, even though vibration has its
 * own switch. The explicit calls are what keep haptics working for a player
 * who plays muted.
 *
 * So: keep both calls, and coalesce here. Within one window the STRONGEST
 * intent wins, because when `light` and `strong` describe the same instant the
 * player should feel the strong one.
 */
const COALESCE_MS = 60;
let lastFireAt = 0;
let lastWeight = 0;

/** Total buzz time in a pattern — our proxy for "how emphatic". */
function weigh(pattern: number | number[]): number {
  return Array.isArray(pattern)
    ? pattern.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0)
    : pattern;
}

/**
 * Fire a vibration pattern, subject to the gate and to coalescing.
 * Returns whether it actually fired — callers that need to know (tests, the
 * HapticService API) can use it; most should just call and forget.
 */
export function fireVibration(pattern: number | number[]): boolean {
  if (!isVibrationAllowed()) return false;

  const now = Date.now();
  const weight = weigh(pattern);
  if (now - lastFireAt < COALESCE_MS && weight <= lastWeight) {
    // Same instant, and no stronger than what the player is already feeling.
    return false;
  }
  lastFireAt = now;
  lastWeight = weight;

  try {
    navigator.vibrate(pattern);
    return true;
  } catch {
    // Restricted contexts (cross-origin iframe, some webviews) throw rather
    // than no-op. Never let a buzz break the caller.
    return false;
  }
}

/** Test-only: forget the coalescing window between cases. */
export function __resetVibrationCoalescing(): void {
  lastFireAt = 0;
  lastWeight = 0;
}

/** Cancel any in-flight vibration. Not gated — stopping is always allowed. */
export function stopVibration(): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(0);
  } catch {
    /* ignore */
  }
}

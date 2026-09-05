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
/* ═══════════════════════════════════════════════════════════════════════════
   iOS HAS NO VIBRATION API, AND NEVER HAS
   ═══════════════════════════════════════════════════════════════════════════
   Every iOS browser is WebKit, and Apple has never shipped `navigator.vibrate`
   there. So `isVibrationAllowed()` above returns false on every iPhone and
   iPad, and every haptic in Club Arena - the turn alert, the keypad, the
   card-slide peel - has been silently doing nothing on the platform most of
   our players hold. Verified 2026-09-05: desktop Chromium HAS the function and
   `navigator.vibrate(1)` returns false (no motor); iOS does not have it at all.

   THE ONE THING THAT DOES BUZZ on iOS is a native switch control changing
   state: `<input type="checkbox" switch>`. Toggling one plays the system
   haptic. That is the whole trick, and it is the mechanism behind
   `ios-vibrator-pro-max` (ISC, https://vibrator.dev).

   WE DO NOT USE THAT LIBRARY, DELIBERATELY. To make `navigator.vibrate()` work
   ANYWHERE - including with no user gesture - it reparents document.body into
   a <label>, redefines `document.body` with a getter, and runs two
   MutationObservers over the whole subtree. This app measures the DOM to place
   seats (tableGeometry), hides background tables with display:none, and has a
   law about animations never dropping frames. A global body reparent and a
   subtree observer are not things to take on for a buzz.

   We do not need any of it, because we do not need the no-gesture case: every
   haptic here is already fired from inside a real pointer or click handler.
   So this is the mechanism alone - one hidden switch, toggled - and nothing
   else. If Apple closes it, this returns false and we are exactly where we
   were, with no other part of the app touched. */

/** Cache: null = not built yet, false = cannot build here. */
let iosSwitch: HTMLInputElement | null | false = null;

/** iOS/iPadOS WebKit, which is the only place this technique applies. */
function isIosWebkit(): boolean {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports a Mac UA, and is told apart by having touch points.
  const iPadOS = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  if (!/iPhone|iPad|iPod/.test(ua) && !iPadOS) return false;
  // Chrome/Firefox on iOS are WebKit underneath, so they count too. Exclude
  // anything that is not WebKit-backed.
  return /AppleWebKit/.test(ua);
}

function getIosSwitch(): HTMLInputElement | null {
  if (iosSwitch !== null) return iosSwitch || null;
  try {
    if (!document.body) {
      // Called before body exists; try again on a later buzz.
      return null;
    }
    const label = document.createElement('label');
    // Off-screen rather than display:none - a control that is not rendered at
    // all is not guaranteed to produce the system haptic.
    label.setAttribute(
      'style',
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;'
    );
    label.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    iosSwitch = input;
    return input;
  } catch {
    iosSwitch = false;
    return null;
  }
}

/**
 * One toggle per PULSE in the pattern. A Vibration API pattern alternates
 * buzz/pause starting with a buzz, so the even indices are the pulses and the
 * odd ones are the gaps between them.
 *
 * The first pulse is synchronous, because that is the one still inside the
 * user's gesture and therefore the one iOS 18.4+ will honour. Later pulses are
 * scheduled and may be dropped by the platform; a missing third buzz is a much
 * smaller problem than no buzz at all.
 */
function fireIosHaptic(pattern: number | number[]): boolean {
  const input = getIosSwitch();
  if (!input) return false;
  const list = typeof pattern === 'number' ? [pattern] : pattern;
  const toggle = () => {
    try {
      input.checked = !input.checked;
      input.click();
    } catch {
      /* never let a buzz break the caller */
    }
  };
  toggle();
  // Cap the tail: our longest pattern is three pulses, and an unbounded loop
  // over a caller-supplied array is a timer leak waiting to happen.
  let offset = 0;
  let fired = 1;
  for (let i = 0; i < list.length - 1 && fired < 3; i += 2) {
    offset += (list[i] || 0) + (list[i + 1] || 0);
    fired += 1;
    window.setTimeout(toggle, offset);
  }
  return true;
}

export function fireVibration(pattern: number | number[]): boolean {
  /* THE PREFERENCE, not the capability. This used to ask
     `isVibrationAllowed()`, which is preference AND `navigator.vibrate`
     existing - so on iOS, where it never exists, every caller was refused
     before the fallback below could be reached. Both switches are still
     honoured, and either being off still silences everything. */
  if (!isVibrationPreferred()) return false;
  const canNative = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  if (!canNative && !isIosWebkit()) return false;

  const now = Date.now();
  const weight = weigh(pattern);
  if (now - lastFireAt < COALESCE_MS && weight <= lastWeight) {
    // Same instant, and no stronger than what the player is already feeling.
    return false;
  }
  lastFireAt = now;
  lastWeight = weight;

  try {
    // `vibrate()` returns false where the API exists but no motor does - every
    // desktop browser. Fall through to the iOS path only when the API is
    // genuinely absent, so a desktop never pays for a technique it cannot use.
    if (canNative) {
      navigator.vibrate(pattern);
      return true;
    }
    return fireIosHaptic(pattern);
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
  iosSwitch = null;
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

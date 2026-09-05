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

/**
 * CAN THIS DEVICE PRODUCE A HAPTIC AT ALL - preference not consulted.
 *
 * Not the same question as "does navigator.vibrate exist". It does not exist on
 * any iPhone, and until 2026-09-05 that made this file answer "no motor here"
 * for the platform most of our players hold, which in turn made every UI that
 * asks report haptics as unsupported and the hamburger's own toggle unable to
 * turn them OFF (it computed the new value as `!isVibrationAllowed()`, which
 * was `!false` every single time). The iOS switch path below is a real
 * capability, so it belongs in the real capability check.
 */
export function isVibrationCapable(): boolean {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') return true;
  return isIosHapticSupported();
}

/** True when the device can vibrate AND the player has not switched it off. */
export function isVibrationAllowed(): boolean {
  if (!isVibrationCapable()) return false;
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
/* ===========================================================================
   iOS HAS NO VIBRATION API, AND NEVER HAS
   ===========================================================================
   Every iOS browser is WebKit, and Apple has never shipped `navigator.vibrate`
   there. So `isVibrationAllowed()` above returns false on every iPhone and
   iPad, and every haptic in Club Arena - the turn alert, the keypad, the
   card-slide peel - has been silently doing nothing on the platform most of
   our players hold. Verified 2026-09-05: desktop Chromium HAS the function and
   `navigator.vibrate(1)` returns false (no motor); iOS does not have it at all.

   THE ONE THING THAT DOES BUZZ on iOS is a native switch control changing
   state: `<input type="checkbox" switch>`. Activating one plays the system
   haptic. That is the whole trick, and it is the mechanism behind
   `ios-vibrator-pro-max` (ISC, https://vibrator.dev).

   WE DO NOT IMPORT THAT LIBRARY, DELIBERATELY. To make `navigator.vibrate()`
   work ANYWHERE - including with no user gesture at all - it reparents
   document.body into a <label>, redefines `document.body` with a getter, and
   runs two MutationObservers over the whole subtree. This app measures the DOM
   to place seats (tableGeometry), hides background tables with display:none,
   and has a law about animations never dropping frames. A global body reparent
   and a subtree observer are not things to take on for a buzz.

   We do not need any of it, because we do not need the no-gesture case: every
   haptic here is fired from inside a real pointer or click handler.

   ---------------------------------------------------------------------------
   CORRECTED 2026-09-05 AFTER DAN TESTED IT AND FELT NOTHING.
   ---------------------------------------------------------------------------
   The first version of this code was written from the description of the
   technique rather than from its source, and got three things wrong. Read
   against ios-vibrator-pro-max@3.0.3 `dist/vibration.js` + `dist/methods/
   click-grant/index.js`, which is what it actually does:

     1. IT CLICKS THE LABEL, NEVER THE INPUT.  `hiddenTrigger.label.click()`.
        We were clicking the input. Activating the label is what runs the
        switch's activation behaviour the way a real tap does.

     2. IT NEVER TOUCHES `.checked`.  We set `input.checked = !input.checked`
        and then called click(), whose own activation behaviour toggles it
        back - so the control ended every "buzz" in the state it started in.

     3. THE TRIGGER IS NEVER IN THE DOCUMENT.  Its label is created detached
        and stays detached; the input inside it carries
        `display: none !important`. We were appending an off-screen,
        opacity:0, fixed-position label to document.body on the belief that an
        unrendered control would not fire - the opposite of what the library
        proves. Detached is better here anyway: nothing for the seat-geometry
        measurements or anyone's MutationObserver to trip over.

   And one thing it knows that we did not ask about at all: THERE IS A VERSION
   FLOOR. `dist/utils/supported-versions.js` only uses this click-inside-a-
   gesture path ("granted") at Safari/iOS >= 18.4. Between 18.0 and 18.4 the
   ONLY thing that works is the body-reparent, and below 18 nothing does. So
   under 18.4 we return false and say so, rather than returning true and
   leaving a caller believing the phone buzzed.

   If Apple closes this, the version check stops matching or the click stops
   buzzing, this returns false, and we are exactly where we were - with no
   other part of the app touched. */

/** iOS/iPadOS version as a number, or null when this is not iOS WebKit. */
export function iosWebkitVersion(): number | null {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return null;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports a Mac UA and is told apart by having touch points.
  const iPadOS = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  if (!/iPhone|iPad|iPod/.test(ua) && !iPadOS) return null;
  if (!/AppleWebKit/.test(ua)) return null;

  /* Two shapes, and the second one is not an edge case - it is Dan.
       Safari tab:  "... Version/18.5 Mobile/15E148 Safari/604.1"
       PWA / Chrome on iOS: no "Version/" and no "Safari" at all, just
                    "... CPU iPhone OS 18_5 like Mac OS X ... Mobile/15E148"
     A home-screen install is the case most likely to be holding a table, so
     read the OS token first and fall back to Version/ for the desktop-class
     iPad UA, which has no OS token. */
  const os = /(?:iPhone|CPU) OS (\d+)(?:_(\d+))?/.exec(ua);
  if (os) return Number.parseFloat(`${os[1]}.${os[2] || 0}`);
  const ver = /Version\/(\d+)(?:\.(\d+))?/.exec(ua);
  if (ver) return Number.parseFloat(`${ver[1]}.${ver[2] || 0}`);
  return null;
}

/**
 * The floor from ios-vibrator-pro-max's own support table: below this, a click
 * on the switch inside a user gesture does not buzz, and the only thing that
 * would is the body reparent we have refused.
 */
export const IOS_HAPTIC_MIN_VERSION = 18.4;

/** True when the switch trick is available on this device. */
export function isIosHapticSupported(): boolean {
  const v = iosWebkitVersion();
  return v !== null && v >= IOS_HAPTIC_MIN_VERSION;
}

/** Cache: null = not built yet, false = cannot build here. */
let iosTrigger: HTMLLabelElement | null | false = null;

function getIosTrigger(): HTMLLabelElement | null {
  if (iosTrigger !== null) return iosTrigger || null;
  try {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    // The `switch` attribute is what makes WebKit render - and haptically
    // announce - this as a native switch rather than a tick box.
    input.setAttribute('switch', '');
    input.setAttribute('style', 'display: none !important');
    input.tabIndex = -1;
    label.tabIndex = -1;
    label.appendChild(input);
    // Deliberately NOT appended anywhere. See point 3 above.
    iosTrigger = label;
    return label;
  } catch {
    iosTrigger = false;
    return null;
  }
}

/**
 * One label click per PULSE in the pattern. A Vibration API pattern alternates
 * buzz/pause starting with a buzz, so the even indices are the pulses and the
 * odd ones are the gaps between them.
 *
 * The first pulse is synchronous, because that is the one still inside the
 * user's gesture. Later pulses are scheduled, and land while the platform's
 * activation grant is still open - measured at ~850ms in the library, which
 * every pattern we send is comfortably inside.
 */
function fireIosHaptic(pattern: number | number[]): boolean {
  const label = getIosTrigger();
  if (!label) return false;
  const list = typeof pattern === 'number' ? [pattern] : pattern;
  const toggle = () => {
    try {
      label.click();
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
  if (!canNative && !isIosHapticSupported()) return false;

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
  iosTrigger = null;
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

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  isIosWeb,
  isVibrationPreferred,
  markSwitchTap,
  VIBRATION_PREFERENCE_EVENT,
} from '../../utils/vibrationGate';
import styles from './TapHaptic.module.css';

/**
 * A TAP THAT BUZZES ON AN iPHONE BROWSER (2026-09-26).
 *
 * Dan: "there are no buzzing or haptics". Apple never shipped the Vibration
 * API in any iOS browser, and iOS 26.5 closed the scripted switch toggle the
 * vibration gate used to fake one with. The one haptic a web page can still get
 * on an iPhone is the tick iOS plays when a FINGER toggles a real
 * `<input type="checkbox" switch>`. So a tap target that should buzz renders
 * this inside itself: an invisible switch over its whole face. The finger
 * lands on the switch, iOS plays the tick, and the click bubbles on to the
 * host's own onClick exactly as before.
 *
 * The host's own NATIVE action (submit, reset) is finished by the switch too:
 * see finishHostActivation below.
 *
 * Rendered only where it is needed and wanted: an iPhone or iPad browser (the
 * app has the real Taptic Engine through @capacitor/haptics, Android has
 * navigator.vibrate), the player's Vibrations switch on, and the host enabled
 * (a disabled button must not tick). It is invisible, out of the tab order and
 * hidden from assistive technology; the host keeps its role, name and keys.
 *
 * One deliberate exception to the markup rules, written down so nobody
 * "fixes" it: HTML and axe's nested-interactive rule say a button should not
 * contain another control. This one has to be INSIDE the host, because it
 * must be the thing the finger lands on while the click still reaches the
 * host's own handler. It is aria-hidden and tabIndex -1, so assistive
 * technology and the keyboard see only the host (and the shared focus traps
 * skip input[tabindex="-1"]); it exists only on iPhone and iPad browsers.
 * Where a host clips its children (overflow: hidden), its 1px border strip
 * still acts on a tap but does not tick.
 *
 * The host must be a positioned box (its stylesheet says so; tests/components/
 * TapHaptic.test.tsx checks every host) and passes its corner radius so the hit
 * area matches its shape.
 */
/**
 * THE HOST STILL DOES WHAT A TAP ON IT DOES (2026-10-17).
 *
 * The click BUBBLES to the host, so its React onClick runs exactly as before.
 * What does NOT happen is the host's own native action. A click has one
 * activation target, the innermost element that has activation behaviour, and
 * that is this checkbox: so a `type="submit"` host never submitted its form and
 * a `type="reset"` host never reset it. On an iPhone browser, ENTER ARENA on
 * Complete Your Profile (a submit plate tied to its form with `form=`) did
 * nothing at all. TomTomTamale and Dinodollars both picked an avatar, tapped
 * ENTER ARENA, watched nothing happen, and sat on that screen until they
 * reloaded. CreateUnionModal, CreateTournamentModal and GameManagementPage have
 * submit plates in pop-ups too, so they had the same dead button.
 *
 * So the switch finishes the job, ONCE: after the tap has finished
 * dispatching, if the form did not submit (or reset) by itself and nobody
 * called preventDefault, the host's form is asked to, exactly as the browser
 * would have: requestSubmit(host), which runs constraint validation, sets the
 * submitter and fires the form's own submit handler. An engine that did run
 * the host's native submit is seen through the submit event and is not asked
 * twice. Pinned by tests/components/TapHaptic.test.tsx and
 * tests/the-iphone-tap-still-submits.law.test.ts.
 */
function finishHostActivation(input: HTMLInputElement, click: Event) {
  const host = input.parentElement;
  if (!(host instanceof HTMLButtonElement) || host.disabled) return;
  const kind = host.type;
  if (kind !== 'submit' && kind !== 'reset') return;
  const form = host.form;
  if (!form) return;
  const eventName = kind === 'submit' ? 'submit' : 'reset';
  let happened = false;
  const saw = () => {
    happened = true;
  };
  form.addEventListener(eventName, saw, { capture: true, once: true });
  // A task, not a microtask: microtasks run between a click's listeners,
  // before the browser's own activation behaviour has had its turn.
  setTimeout(() => {
    form.removeEventListener(eventName, saw, { capture: true });
    if (happened || click.defaultPrevented) return;
    if (!host.isConnected || host.disabled || host.form !== form) return;
    if (kind === 'reset') {
      form.reset();
      return;
    }
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit(host);
      return;
    }
    // A WebKit too old for requestSubmit: fire the submit event the form's own
    // handler listens for, and let the form go only if nobody stopped it.
    if (form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) form.submit();
  }, 0);
}

export function TapHaptic({
  disabled = false,
  radius,
  ignorePreference = false,
}: {
  disabled?: boolean;
  radius?: string;
  /** The Vibrations switch itself and the Test Vibration button tick whatever the preference says. */
  ignorePreference?: boolean;
}) {
  const [ios] = useState(() => isIosWeb());
  const [wanted, setWanted] = useState(() => isVibrationPreferred());
  useEffect(() => {
    if (!ios || typeof window === 'undefined') return;
    const update = () => setWanted(isVibrationPreferred());
    window.addEventListener(VIBRATION_PREFERENCE_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(VIBRATION_PREFERENCE_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, [ios]);
  const attach = useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    // `switch` is what makes WebKit treat this as a native switch, the only
    // control whose toggle plays the system haptic.
    input.setAttribute('switch', '');
    // Cover the host's border box: an absolute child is placed inside the
    // border, so the switch reaches out by the host's own border widths.
    const host = input.parentElement;
    if (!host || typeof getComputedStyle !== 'function') return;
    const cs = getComputedStyle(host);
    for (const [side, key] of [
      ['Top', 'bt'],
      ['Right', 'br'],
      ['Bottom', 'bb'],
      ['Left', 'bl'],
    ] as const) {
      const width = cs.getPropertyValue(`border-${side.toLowerCase()}-width`) || '0px';
      input.style.setProperty(`--tap-haptic-${key}`, width);
    }
  }, []);
  if (!ios || (!wanted && !ignorePreference) || disabled) return null;
  return (
    <input
      ref={attach}
      type="checkbox"
      className={styles.switch}
      data-tap-haptic=""
      aria-hidden="true"
      tabIndex={-1}
      style={radius ? ({ '--tap-haptic-radius': radius } as CSSProperties) : undefined}
      // iOS has played the tick; a scripted buzz asked for by the host's own
      // handler inside this same tap is not played again (vibrationGate).
      // Then the host does what a tap on it does natively (see below).
      onClick={(event) => {
        markSwitchTap();
        finishHostActivation(event.currentTarget, event.nativeEvent);
      }}
    />
  );
}

export default TapHaptic;

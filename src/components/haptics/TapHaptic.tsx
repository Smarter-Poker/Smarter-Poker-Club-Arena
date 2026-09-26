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
 * Rendered only where it is needed and wanted: an iPhone or iPad browser (the
 * app has the real Taptic Engine through @capacitor/haptics, Android has
 * navigator.vibrate), the player's Vibrations switch on, and the host enabled
 * (a disabled button must not tick). It is invisible, out of the tab order and
 * hidden from assistive technology; the host keeps its role, name and keys.
 *
 * The host must be a positioned box (its stylesheet says so; tests/components/
 * TapHaptic.test.tsx checks every host) and passes its corner radius so the hit
 * area matches its shape.
 */
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
      onClick={() => markSwitchTap()}
    />
  );
}

export default TapHaptic;

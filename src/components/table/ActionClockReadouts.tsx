import { memo, useEffect } from 'react';
import { useActionClockSeconds, type ActionClockStore } from '../../hooks/actionClockStore';
import { soundService } from '../../services/SoundService';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ACTION CLOCK READOUTS — the only two places TablePage still spends on the tick
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Both of these used to live inline in TablePage and read `actionTimeRemaining`
 * out of that component's state, which is why the whole page re-rendered for the
 * length of every turn. They subscribe to the clock store directly now. One
 * renders a single <span>; the other renders nothing at all.
 *
 * The acting seat is the third consumer and it subscribes inside SeatSlot,
 * because only the seat knows whether it is the one on the clock.
 */

export interface ActionClockSecondsProps {
  clock: ActionClockStore;
  className?: string;
}

/**
 * The control-strip numeral. Byte-for-byte the same output as the inline
 * `{Math.ceil(actionTimeRemaining) || 0}s` it replaced, including the `|| 0`
 * that turns a NaN into a zero rather than printing "NaNs".
 */
export const ActionClockSeconds = memo(function ActionClockSeconds({
  clock,
  className,
}: ActionClockSecondsProps) {
  const seconds = useActionClockSeconds(clock) ?? 0;
  return <span className={className}>{Math.ceil(seconds) || 0}s</span>;
});

export interface ActionClockWarningProps {
  clock: ActionClockStore;
  /**
   * Hero is the seat on the clock and a hand is in progress. Everything else
   * about the warning window is the clock's business; this is the part only the
   * page knows.
   */
  armed: boolean;
  /** Sound switches: master enable AND the ambient-sounds permission. */
  soundEnabled: boolean;
}

/**
 * The final-three-seconds warning: a ticking sound and a heavy haptic, once a
 * second, while hero's own clock is inside the last three seconds.
 *
 * Dan 2026-08-20: the window is the FINAL 3 SECONDS (it was 5), and it buzzes as
 * well as ticks. The haptic is deliberately NOT gated on the sound switches — a
 * player with sound off still gets the physical warning, and HapticService
 * itself honours the user's vibration setting.
 *
 * AUDIT-2 2026-08-20 (machine-gun ticking) is the reason the trigger is a
 * BOOLEAN and not the countdown: an effect that depends on the number re-runs on
 * every publication, and `startTimerWarning` plays a tick immediately, so the
 * player got a tick every ~66ms instead of one a second. Collapsed to a boolean,
 * these effects run exactly twice a turn — once when the window opens, once when
 * it closes — and this component re-renders once a second while the window is
 * approaching, which costs nothing because it has no DOM.
 */
export const ActionClockWarning = memo(function ActionClockWarning({
  clock,
  armed,
  soundEnabled,
}: ActionClockWarningProps) {
  const seconds = useActionClockSeconds(clock, armed) ?? 0;

  const isWindow = armed && seconds <= 3 && seconds > 0;
  const isAudible = isWindow && soundEnabled;

  useEffect(() => {
    if (isAudible) {
      soundService.startTimerWarning();
      return () => soundService.stopTimerWarning();
    }
    soundService.stopTimerWarning();
  }, [isAudible]);

  useEffect(() => {
    if (!isWindow) return;
    // Heavy pulse immediately, then once per second while the window is open
    // (mirrors the 1s cadence of soundService.startTimerWarning).
    void import('../../services/HapticService').then(({ haptic }) => haptic.heavy());
    const buzz = window.setInterval(() => {
      void import('../../services/HapticService').then(({ haptic }) => haptic.heavy());
    }, 1000);
    return () => clearInterval(buzz);
  }, [isWindow]);

  return null;
});

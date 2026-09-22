import { useEffect, useRef, useState } from 'react';

/** One foreground decision window. Hidden tabs, dialogs and unavailable funds
 * cannot spend it, and an elapsed window never starts a second spin.
 *
 * The wheel's idle spin uses the default thirty seconds; a won game starts on
 * a shorter window (useAwardAutoStart). */
export function useIdleSpinCountdown(
  armed: boolean,
  ready: boolean,
  resetKey: string,
  onElapsed: () => void,
  windowMs = 30_000
) {
  const remaining = useRef(windowMs);
  const fired = useRef(false);
  const callback = useRef(onElapsed);
  callback.current = onElapsed;
  const [seconds, setSeconds] = useState(Math.ceil(windowMs / 1000));
  useEffect(() => {
    remaining.current = windowMs;
    fired.current = false;
    setSeconds(Math.ceil(windowMs / 1000));
  }, [armed, resetKey, windowMs]);
  useEffect(() => {
    if (!armed || !ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started: number | null = null;
    const pause = () => {
      if (timer) clearTimeout(timer);
      if (started !== null)
        remaining.current = Math.max(0, remaining.current - (performance.now() - started));
      started = null;
    };
    const tick = () => {
      pause();
      if (fired.current) return;
      setSeconds(Math.ceil(remaining.current / 1000));
      if (document.hidden) return;
      if (remaining.current <= 0) {
        fired.current = true;
        callback.current();
        return;
      }
      started = performance.now();
      timer = setTimeout(tick, Math.min(250, remaining.current));
    };
    const visibility = () => {
      pause();
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', visibility);
    tick();
    return () => {
      pause();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [armed, ready, resetKey, windowMs]);
  return seconds;
}

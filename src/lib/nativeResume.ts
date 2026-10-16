/**
 * THE NATIVE APP COMING TO THE FOREGROUND IS A RESUME (2026-10-05).
 *
 * The table transports resync on `pageshow` and `visibilitychange`. Inside the
 * Capacitor shell neither is guaranteed when the OS brings the app back: the
 * reliable signal is `App.appStateChange { isActive: true }`, and until today
 * the shell used it only to resume audio. A phone returning to a hand could
 * sit on a stale felt until the next 30-second retry or watchdog tick.
 *
 * The shell dispatches this window event on that edge, and every
 * EngineStateClient handles it exactly as a `pageshow`: a healthy link runs
 * its bounded resync, a broken one takes the single-flight reconnect path.
 * A window event rather than a direct import keeps the transports out of the
 * native shell's lazy chunk.
 */
export const NATIVE_RESUME_EVENT = 'ca:native-resume';
export const NATIVE_PAUSE_EVENT = 'ca:native-pause';
let nativeAppActive = true;

export function isNativeAppActive(): boolean {
  return nativeAppActive;
}

export function announceNativePause(): void {
  nativeAppActive = false;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NATIVE_PAUSE_EVENT));
}

export function announceNativeResume(): void {
  nativeAppActive = true;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(NATIVE_RESUME_EVENT));
}

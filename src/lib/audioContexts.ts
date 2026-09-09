/**
 * Every AudioContext the app creates, in one place, so the native shell can
 * resume them all when the app comes back to the foreground.
 *
 * Why: iOS moves a context to 'interrupted' during a phone call, a Siri
 * prompt or a FaceTime ring, and does not always fire `visibilitychange`
 * when the call ends (the app never left the screen). The three engines
 * (SoundService, PremiumSFX, ThrowableSoundService) each resume on
 * visibilitychange already; this is the second net, driven by Capacitor's
 * `appStateChange` in src/lib/nativeShell.ts. On the web nothing calls
 * resumeTrackedAudioContexts(), so registering here changes nothing there.
 *
 * The three engines are singletons that live as long as the app does, so a
 * plain Set is the right container; a closed context is dropped on the next
 * sweep.
 */

const tracked = new Set<AudioContext>();

export function trackAudioContext(ctx: AudioContext | null | undefined): void {
  if (!ctx) return;
  tracked.add(ctx);
}

/** Resume every tracked context that is not running. Returns how many were asked to resume. */
export function resumeTrackedAudioContexts(): number {
  let asked = 0;
  for (const ctx of tracked) {
    if (ctx.state === 'closed') {
      tracked.delete(ctx);
      continue;
    }
    // 'interrupted' is iOS-only and not in the TS union.
    if ((ctx.state as string) !== 'running') {
      asked += 1;
      ctx.resume().catch(() => {
        /* only a user gesture can lift some suspensions; the next tap will */
      });
    }
  }
  return asked;
}

/** Test seam. */
export function __trackedAudioContextCount(): number {
  return tracked.size;
}

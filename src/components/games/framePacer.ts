/**
 * HOW OFTEN A DIAMOND SCENE DRAWS (2026-10-01).
 *
 * Crash and Plinko used to draw at most once every 30 ms, about 33 frames a
 * second, on phones whose screens refresh 60 or 120 times a second. The flight
 * and the falling diamonds moved in visible steps even on a fast iPhone, which
 * is the "choppy" Dan first reported. And every scene kept animating its idle
 * attract forever while a player sat on it, which costs heat and battery for a
 * picture nobody is watching change.
 *
 * One rule for every scene now:
 *   - MOVING (a flight, a drop, a walk, a reveal, and a short grace after it so
 *     a landing's flash and ring finish smoothly): draw on every display frame,
 *     60 or 120 a second. The quality governor still steps a phone down if it
 *     cannot keep up.
 *   - SETTLED (between rounds, the attract breathing): about 30 a second, which
 *     is all a slow glow needs.
 *   - PARKED (settled and nobody has touched anything for PARK_AFTER_MS): no
 *     draws at all. The last frame stays on screen. Any tap, key or scroll on
 *     the page, or any change in what the scene is showing, wakes it at once.
 * Reduced motion keeps each scene's own slow pace, and parks the same way.
 */

/** The display frame the quality governor judges a moving scene against. */
export const DISPLAY_FRAME_MS = 1000 / 60;
/** Between rounds: the attract only needs about 30 frames a second. */
export const SETTLED_FRAME_MS = 33;
/** After a scene stops moving it keeps full rate this long, for the landing's tail. */
export const SETTLE_GRACE_MS = 1500;
/** Settled and untouched this long: the scene stops drawing until something happens. */
export const PARK_AFTER_MS = 20_000;

const WAKE_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'wheel'] as const;

export interface FramePacer {
  /**
   * The milliseconds this frame should wait since the last draw (0: draw now,
   * Infinity: parked). `moving` and `signature` describe what the scene is
   * showing; a new signature (a new round, a new phase, a new drop) is activity.
   */
  pace(now: number, state: { reduced: boolean; moving: boolean; signature: string }): number;
  /** The interval to hand the quality governor for a frame drawn at this pace. */
  governorInterval(pace: number): number;
  /** True while the scene is parked (for tests and the device check). */
  readonly parked: boolean;
  dispose(): void;
}

export function createFramePacer(options: { reducedMs: number; now?: () => number }): FramePacer {
  const clock = options.now ?? (() => performance.now());
  let lastActivity = clock();
  let lastMotion = lastActivity;
  let signature: string | null = null;
  let parked = false;
  const wake = () => {
    lastActivity = clock();
  };
  const target = typeof window === 'undefined' ? null : window;
  for (const name of WAKE_EVENTS) target?.addEventListener(name, wake, { passive: true });
  return {
    pace(now, state) {
      if (state.signature !== signature) {
        signature = state.signature;
        lastActivity = now;
      }
      if (state.moving) lastMotion = now;
      const sinceMotion = now - lastMotion;
      if (sinceMotion < SETTLE_GRACE_MS) {
        parked = false;
        return state.reduced ? options.reducedMs : 0;
      }
      const quiet = now - Math.max(lastActivity, lastMotion);
      parked = quiet >= PARK_AFTER_MS;
      if (parked) return Number.POSITIVE_INFINITY;
      return state.reduced ? options.reducedMs : SETTLED_FRAME_MS;
    },
    governorInterval(pace) {
      return Number.isFinite(pace) ? Math.max(pace, DISPLAY_FRAME_MS) : DISPLAY_FRAME_MS;
    },
    get parked() {
      return parked;
    },
    dispose() {
      for (const name of WAKE_EVENTS) target?.removeEventListener(name, wake);
    },
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FRAME SAMPLER (spec 63, 64) — did the flip actually hold its frame rate?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ROUND 2 2026-09-05. The engine already reports expected vs actual DURATION,
 * which catches an animation that was cut short or torn out. It says nothing
 * about whether the frames in between arrived: a squeeze that takes exactly
 * 560ms and paints six frames is a stutter, and duration telemetry calls it a
 * success.
 *
 * This counts the frames the browser actually painted across one presentation
 * and reports the effective rate. It is SAMPLED (see TELEMETRY_SAMPLE_RATE at
 * the call site) because a river happens tens of thousands of times a day
 * across the fleet, and a rAF loop on every one of them would itself be the
 * jank it is measuring.
 *
 * It never blocks, never delays, and never influences the animation: it reads
 * the clock, and the animation is CSS on the compositor either way. Cancelling
 * a presentation cancels the sampler with it (spec 99).
 */

/** Below this, the flip visibly stutters on the devices this ships to. */
export const DEGRADED_FPS_THRESHOLD = 45;

export interface FrameSample {
  /** Frames the browser painted while the presentation was on screen. */
  readonly frames: number;
  /** Effective frames per second across the sampled window. */
  readonly fps: number;
  /** How long the sampler actually ran, in ms. */
  readonly elapsedMs: number;
  /** Frames missed against a 60fps ideal, never below zero. */
  readonly droppedFrames: number;
}

/**
 * Starts sampling; returns a cancel function. `done` fires once, either when
 * the window elapses or - if cancelled first - not at all.
 */
export type FrameSamplerStart = (durationMs: number, done: (s: FrameSample) => void) => () => void;

/** The real one. A no-op (returning a cancel that does nothing) without rAF. */
export const rafFrameSampler: FrameSamplerStart = (durationMs, done) => {
  if (
    typeof requestAnimationFrame !== 'function' ||
    typeof cancelAnimationFrame !== 'function' ||
    durationMs <= 0
  ) {
    return () => {};
  }
  const clock =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now();

  const startedAt = clock();
  let frames = 0;
  let handle = 0;
  let live = true;

  const tick = () => {
    if (!live) return;
    frames += 1;
    const elapsedMs = clock() - startedAt;
    if (elapsedMs >= durationMs) {
      live = false;
      const fps = elapsedMs > 0 ? (frames * 1000) / elapsedMs : 0;
      done({
        frames,
        fps,
        elapsedMs,
        droppedFrames: Math.max(0, Math.round((elapsedMs / 1000) * 60) - frames),
      });
      return;
    }
    handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);

  return () => {
    live = false;
    if (handle) cancelAnimationFrame(handle);
  };
};

/** Test double: never schedules anything. */
export const noopFrameSampler: FrameSamplerStart = () => () => {};

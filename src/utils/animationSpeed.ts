/**
 * IMPROVEMENT PASS 2026-08-19 — single source of truth for the user's
 * animation-speed preference on the JS side.
 *
 * `--animation-speed` is a DURATION MULTIPLIER (1 = normal, <1 faster,
 * >1 slower) written to :root by useTableSettings and consumed by most of
 * the table stylesheets via calc(). Several JS timing windows (deal flight,
 * newly-dealt board window, fold/flip class removal) were hardcoded and
 * drifted out of sync with the CSS the moment a player changed speed —
 * classes were stripped mid-keyframe. Scale every JS window through this.
 */
export function getAnimationSpeed(): number {
  if (typeof window === 'undefined') return 1;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--animation-speed');
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v > 0) return Math.min(3, Math.max(0.25, v));
  } catch {
    /* jsdom / SSR */
  }
  return 1;
}

/** True when the OS asks for reduced motion — rAF-driven animations must honor
 *  this themselves (CSS media queries cannot reach requestAnimationFrame). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

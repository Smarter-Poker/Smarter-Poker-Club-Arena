/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MOTION BUDGET — shed ambient animation on devices that cannot afford it
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 * `useFrameBudgetMonitor` measures frame health but is explicitly dev-only
 * (`if (!enabled || import.meta.env.PROD) return`) and only ever console.warns.
 * So in production nothing measures the thing that matters and nothing reacts.
 *
 * That was fine when the table's only avatar motion was one-shot gestures. It
 * is not fine now: breathing, the time-pressure tremor and the VIP holo sweep
 * all run FOREVER, and MultiTablePage keeps up to four tables mounted, so a
 * phone can be carrying dozens of infinite animations at once.
 *
 * WHAT IT SHEDS, AND WHAT IT KEEPS
 * Only the infinite ones. One-shot gestures stay: they are under a second, they
 * fire on a real event, and they are the half of the system that carries
 * MEANING — a fold you cannot see is a worse outcome than a dropped frame.
 * Ambient life is the luxury, so ambient life is what gets cut.
 *
 * HONESTY ABOUT MEASUREMENT
 * A single slow frame means nothing — a GC pause, a layout, another tab waking
 * up. This samples a window and looks at the MEDIAN, so one spike cannot demote
 * a device that is actually fine. It also refuses to measure while the tab is
 * hidden, because a backgrounded tab is throttled to ~1fps by the browser and
 * would otherwise be declared incapable every time a player looks away.
 *
 * IT ONLY EVER REMOVES MOTION
 * The failure mode of a bug here is "the table is a bit less lively", never a
 * broken seat. That asymmetry is deliberate.
 */

/** Attribute on <html>. CSS keys off it; nothing else reads it. */
export const MOTION_ATTR = 'data-sp-motion';
/** Value meaning "this device is struggling, drop the ambient layer". */
export const MOTION_LITE = 'lite';

/** Frames sampled before deciding. ~1s at 60fps, ~2s at 30fps. */
const SAMPLE_FRAMES = 60;
/**
 * Median frame time above which the device is declared unable to afford ambient
 * motion. 32ms is two missed 60fps frames — i.e. sustained sub-30fps, which is
 * where a poker table stops feeling responsive. Deliberately not 16ms: plenty
 * of perfectly good phones sit just above one frame and shedding motion there
 * would be pure superstition.
 */
const LITE_THRESHOLD_MS = 32;

let started = false;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Applies (or clears) the lite flag. Exported for tests. */
export function setMotionLite(lite: boolean): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (lite) el.setAttribute(MOTION_ATTR, MOTION_LITE);
  else el.removeAttribute(MOTION_ATTR);
}

export function isMotionLite(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute(MOTION_ATTR) === MOTION_LITE;
}

/**
 * Sample frame timing once and set the flag. Safe to call from every seat —
 * the first call wins and the rest are free, which is what lets this start
 * itself from a component rather than needing a change in TablePage.
 */
export function startMotionBudget(): void {
  if (started) return;
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return;
  started = true;

  const deltas: number[] = [];
  let last = performance.now();

  const tick = (now: number) => {
    // A hidden tab is throttled by the browser to roughly one frame a second.
    // Measuring through that would demote every device the moment a player
    // switches tab, so drop the sample and keep waiting.
    if (document.visibilityState !== 'visible') {
      last = now;
      requestAnimationFrame(tick);
      return;
    }

    deltas.push(now - last);
    last = now;

    if (deltas.length < SAMPLE_FRAMES) {
      requestAnimationFrame(tick);
      return;
    }

    // Median, not mean: one 300ms GC pause must not decide this on its own.
    setMotionLite(median(deltas) > LITE_THRESHOLD_MS);
  };

  requestAnimationFrame(tick);
}

/** Test seam — lets a test re-arm the one-shot sampler. */
export function __resetMotionBudget(): void {
  started = false;
  setMotionLite(false);
}

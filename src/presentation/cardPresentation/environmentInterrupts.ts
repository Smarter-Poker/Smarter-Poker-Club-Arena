/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENVIRONMENT INTERRUPTS (spec 39, 40, 66, 76, 77)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PHASE 2 2026-09-05. Three things invalidate a flip that is already running,
 * and none of them were handled:
 *
 *   RESIZE / ORIENTATION  the board's geometry is recomputed underneath the
 *                         card. The felt row is `flex: 0 1 (100% - gaps)/5`,
 *                         so every card changes width; a card halfway through
 *                         a rotateY finishes it against a box that is no
 *                         longer the box it started in.
 *   BACKGROUNDING         a hidden tab throttles rAF and CSS animation
 *                         timelines. On resume the browser may finish the
 *                         animation instantly, or jump it - and by then the
 *                         hand has usually moved on anyway (spec 39).
 *
 * The spec's answer to all three is the same and it is the safe one:
 * CORRECTNESS BEATS VISUAL CONTINUATION. Cancel, and let the board render its
 * authoritative final state. A card that snaps to face-up is a non-event; a
 * card left standing on its edge is a bug report.
 *
 * This never touches poker state and never delays anything - cancelling a
 * presentation only stops a CSS class being reapplied (CLAUDE.md 10.6: the
 * animation is not part of game logic, and the final board is correct with or
 * without it).
 */

import type { CardPresentationEngine } from './CardPresentationEngine';

/** Ignore the storm of resize events a drag produces; act once it settles. */
export const RESIZE_SETTLE_MS = 120;

export interface EnvironmentInterruptDeps {
  /** Defaults to `window`. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Defaults to `document`. */
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener'> & { hidden?: boolean };
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Installs the interrupts. Returns an uninstall function; calling it twice is
 * safe, and installing twice on one target would double-cancel harmlessly
 * (cancel on a key with nothing in flight is a no-op).
 */
export function installEnvironmentInterrupts(
  engine: Pick<CardPresentationEngine, 'cancelAll'>,
  deps: EnvironmentInterruptDeps = {}
): () => void {
  const target = deps.target ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = deps.doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!target) return () => {};

  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;
  let settle: ReturnType<typeof setTimeout> | null = null;

  const onGeometryChange = () => {
    // Cancel IMMEDIATELY - the geometry is already wrong - and again once the
    // drag settles, so a presentation started mid-drag does not survive it.
    engine.cancelAll('geometry-changed');
    if (settle) clearT(settle);
    settle = setT(() => {
      settle = null;
      engine.cancelAll('geometry-settled');
    }, RESIZE_SETTLE_MS);
  };

  const onVisibility = () => {
    if (doc?.hidden) engine.cancelAll('backgrounded');
  };

  target.addEventListener('resize', onGeometryChange);
  target.addEventListener('orientationchange', onGeometryChange);
  doc?.addEventListener('visibilitychange', onVisibility);

  return () => {
    if (settle) clearT(settle);
    settle = null;
    target.removeEventListener('resize', onGeometryChange);
    target.removeEventListener('orientationchange', onGeometryChange);
    doc?.removeEventListener('visibilitychange', onVisibility);
  };
}

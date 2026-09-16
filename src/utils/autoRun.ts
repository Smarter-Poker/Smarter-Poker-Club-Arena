/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AUTO RUN - the one decision a runner makes, and nothing else
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Plinko's Auto Drop and Crash's Auto Play press the same plate a thumb would
 * press, N times, one round after another. This is the whole of what they
 * decide: given a run and the page's own readiness, do nothing yet, press
 * now (after a pause so the last result can be read), stop because the page
 * would refuse, or finish because the run is done. A runner never decides an
 * outcome, never skips a commit, never presses while the page is busy, and
 * stops the moment the page would stop a thumb (10.12: the guard is the
 * page's own blocker, not a watch around it).
 */

/** The runs on offer; 0 is Off. */
export const AUTO_RUN_SIZES = [0, 5, 10, 25, 50] as const;
export type AutoRunSize = (typeof AUTO_RUN_SIZES)[number];

export interface AutoRun {
  total: number;
  done: number;
}

export type AutoRunVerdict =
  | { kind: 'wait' }
  | { kind: 'go'; delayMs: number }
  | { kind: 'finished' }
  | { kind: 'blocked'; why: string };

/** The next size on the plate: Off, 5, 10, 25, 50, Off. */
export function cycleRunSize(current: number): AutoRunSize {
  const i = AUTO_RUN_SIZES.indexOf(current as AutoRunSize);
  return AUTO_RUN_SIZES[(i + 1) % AUTO_RUN_SIZES.length];
}

export function autoRunVerdict(
  run: AutoRun | null,
  page: {
    /** A round is in flight (a ball falling, a curve climbing, a request out). */
    busy: boolean;
    /** What the page would print instead of letting a thumb press: the reason to stop. */
    blocker: string | null;
    /** The page would let a thumb press right now (commit in hand, pause served). */
    ready: boolean;
  },
  pauseMs: number
): AutoRunVerdict {
  if (!run || page.busy) return { kind: 'wait' };
  if (run.done >= run.total) return { kind: 'finished' };
  if (page.blocker) return { kind: 'blocked', why: page.blocker };
  if (!page.ready) return { kind: 'wait' };
  return { kind: 'go', delayMs: run.done === 0 ? 0 : pauseMs };
}

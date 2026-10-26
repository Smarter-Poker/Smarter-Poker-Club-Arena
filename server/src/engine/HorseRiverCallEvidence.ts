/** A high-hand name cannot describe the value of a split or multi-board call. */
export interface RiverCallContext {
  variant: string;
  boardCount: number;
}

export function riverCallCategoryIsUsable(context: RiverCallContext | undefined): boolean {
  return (
    !!context &&
    context.boardCount === 1 &&
    ['nlh', 'flh', 'pineapple', 'plo4', 'plo5', 'plo6', 'short_deck'].includes(context.variant)
  );
}

/** Conservative family baselines; see the measured sample in the changelog.
 * The one-sided Wilson lower bound must exceed the baseline, with at least
 * twelve shown calls. A raw 50% cutoff after five calls confuses ordinary
 * hold'em calls with an opponent-specific tendency. No hypothesis is made
 * about unobserved/mucked holdings or unsupported games. */
export function riverCallConfidenceAboveBaseline(
  calls: number,
  weak: number,
  baseline: number
): boolean {
  if (
    !Number.isFinite(calls) ||
    !Number.isFinite(weak) ||
    calls < 12 ||
    weak < 0 ||
    weak > calls ||
    !Number.isFinite(baseline) ||
    baseline < 0 ||
    baseline >= 1
  )
    return false;
  const z2 = 1.645 ** 2;
  const rate = weak / calls;
  const lower =
    (rate +
      z2 / (2 * calls) -
      Math.sqrt(z2 * ((rate * (1 - rate)) / calls + z2 / (4 * calls * calls)))) /
    (1 + z2 / calls);
  return lower > baseline;
}

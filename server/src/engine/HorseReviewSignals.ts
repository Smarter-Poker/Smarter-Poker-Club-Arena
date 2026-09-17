/** Historical observations are retained for review, not causal policy authority. */
export const HORSE_REVIEW_SIGNAL_KEYS = [
  'leaks',
  'leaksHands',
  'leaksOmaha',
  'leaksHandsOmaha',
  'leaksHoldem',
  'leaksHandsHoldem',
  'leaksTournament',
  'leaksHandsTournament',
] as const;

export function hasHorseReviewSignals(mods: object | undefined): boolean {
  return (
    !!mods &&
    HORSE_REVIEW_SIGNAL_KEYS.some(
      (key) => Object.hasOwn(mods, key) && (mods as Record<string, unknown>)[key] !== undefined
    )
  );
}

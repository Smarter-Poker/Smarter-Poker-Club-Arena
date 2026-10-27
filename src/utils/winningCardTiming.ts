import { HAND_COMPLETION } from '../config/handCompletionSpec';

/** Extend the animation-owned reset by the same read tail as the base hold.
 * max(base + extra, animation + extra) preserves the full extra display;
 * extending only the base lets a longer pot animation absorb part of it.
 * RIT already adds this read to each board result in its reveal timeline.
 */
export function winningCardAwardResetAt(
  awardEndAt: number,
  opts: { wentToShowdown: boolean; ritRuns: number; speed: number }
): number {
  const extra =
    opts.wentToShowdown && opts.ritRuns <= 1
      ? HAND_COMPLETION.WINNING_CARDS_EXTRA_MS * opts.speed
      : 0;
  return awardEndAt + 400 + extra;
}

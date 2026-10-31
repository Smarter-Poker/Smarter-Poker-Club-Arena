/** A hole-card row kept until the hero's roster row arrives. */
export interface EarlyHeroCards {
  hand: number;
  row: Record<string, unknown>;
}

/**
 * The kept row, when the roster now holds the hero for the same hand. An older row is
 * dropped; a future hand waits for HAND_STARTED before it can be applied.
 */
export function earlyHeroCardsReady(input: {
  early: EarlyHeroCards | null;
  handNumber: number;
  heroInRoster: boolean;
}): 'apply' | 'drop' | 'wait' {
  const early = input.early;
  if (!early) return 'wait';
  if (input.handNumber > 0 && early.hand > 0) {
    if (early.hand < input.handNumber) return 'drop';
    if (early.hand > input.handNumber) return 'wait';
  }
  return input.heroInRoster ? 'apply' : 'wait';
}

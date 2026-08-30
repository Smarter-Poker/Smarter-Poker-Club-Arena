/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD DISPLAY HELPERS — pure
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Moved out of TablePage.tsx on 2026-08-19. That file is ~8,700 lines and is
 * edited many times a day; anything living inside it is one rewrite away from
 * quietly changing. These four things are pure, have no React in them, and are
 * the kind of detail nobody notices breaking until a hand looks wrong:
 *
 *   - the engine's suit words -> the single letters the card art uses
 *   - hole-card sort order (Bible V8 §11.1 cards_pre_sort: high to low)
 *   - the human label for a game variant
 *
 * They are exported and tested so a future edit has to break a test, not a
 * player's screen.
 */
import type { Card } from '../components/table/SeatSlot';

export const ENGINE_SUIT_MAP: Record<string, 'h' | 'd' | 'c' | 's'> = {
  hearts: 'h',
  diamonds: 'd',
  clubs: 'c',
  spades: 's',
};

export const RANK_ORDER: Record<string, number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

export function sortCardsByRank(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => (RANK_ORDER[b.rank] ?? 0) - (RANK_ORDER[a.rank] ?? 0));
}

/** A hole card together with the position it was DEALT in. */
export interface DealtCard {
  card: Card | null;
  /** Index into the engine's own hole-card array, before any display sort. */
  dealtIndex: number;
}

/**
 * The same high-to-low display order as `sortCardsByRank`, but every card keeps
 * the index it had in the array it arrived in.
 *
 * WHY THIS EXISTS. A seat draws its cards in DISPLAY order and asks per-card
 * questions - "is this one of the winning five?", "should this one dim?" - in
 * DEALT order, because that is the order the engine numbers them in
 * (`hole_card_indices` on the pot_win event). While those two orders were both
 * called "i" they were silently assumed to be the same, and from 2026-08-25 to
 * 2026-08-27 a sorted villain hand lit the wrong card at showdown: dealt
 * `6h As 9c Ad`, drawn `As Ad 9c 6h`, so index 1 meant the ace of diamonds to
 * the row and the ace of spades to the engine.
 *
 * Returning the pair makes the distinction impossible to lose again: there is
 * no bare index to reach for.
 *
 * SORTING IS SKIPPED WHEN ANY SLOT IS NULL. A null is not a missing card, it is
 * the per-card show picker (2026-08-18) saying "this one stays face down", so
 * its POSITION carries meaning and moving it would separate it from the card it
 * belongs beside. The pairing still happens, so callers get one shape back.
 */
export function displayOrderWithDealtIndex(
  cards: ReadonlyArray<Card | null | undefined> | null | undefined
): DealtCard[] {
  if (!cards || cards.length === 0) return [];
  const paired: DealtCard[] = cards.map((card, dealtIndex) => ({ card: card ?? null, dealtIndex }));
  /**
   * ── NULLS HOLD THEIR SLOT; EVERY VISIBLE CARD STILL SORTS (round 17) ─────
   *
   * Dan, 2026-08-30, with a screenshot of his own PLO6 hand reading
   * J-8-4-7-7-4: "PLO HANDS NEED TO BE ORGANIZED... HIGHEST CARDS TO LOWEST,
   * LEFT TO RIGHT AS WELL."
   *
   * This used to `return paired` — DEALT ORDER, unsorted — the moment ANY slot
   * was null. The reasoning above it is still right: a null is the per-card
   * show picker saying "this one stays face down", so its POSITION carries
   * meaning and must not move. But bailing out entirely made one face-down
   * card scramble the other five, which is the strictly worse reading of the
   * same rule.
   *
   * So the nulls keep their exact slots and the cards are sorted high-to-low
   * INTO the slots that remain. With no nulls this is precisely the old
   * behaviour; with nulls it is the old behaviour for the picker and Dan's
   * rule for everything the player can actually see.
   */
  const visible = paired.filter((p) => p.card != null);
  if (visible.length === paired.length) {
    return [...paired].sort(
      (a, b) => (RANK_ORDER[b.card!.rank] ?? 0) - (RANK_ORDER[a.card!.rank] ?? 0)
    );
  }
  const sortedVisible = [...visible].sort(
    (a, b) => (RANK_ORDER[b.card!.rank] ?? 0) - (RANK_ORDER[a.card!.rank] ?? 0)
  );
  let next = 0;
  return paired.map((slot) => (slot.card == null ? slot : sortedVisible[next++]));
}

export const GAME_VARIANT_LABELS: Record<string, string> = {
  NLH: "NO LIMIT HOLD'EM",
  nlh: "NO LIMIT HOLD'EM",
  PLO4: 'POT LIMIT OMAHA (4)',
  plo4: 'POT LIMIT OMAHA (4)',
  PLO5: 'POT LIMIT OMAHA (5)',
  plo5: 'POT LIMIT OMAHA (5)',
  PLO6: 'POT LIMIT OMAHA (6)',
  plo6: 'POT LIMIT OMAHA (6)',
  PLO8: 'PLO HI-LO (8+)',
  plo8: 'PLO HI-LO (8+)',
  SHORT_DECK: 'SHORT DECK 6+',
  short_deck: 'SHORT DECK 6+',
  FLH: "FIXED LIMIT HOLD'EM",
  flh: "FIXED LIMIT HOLD'EM",
  FLO8: 'FIXED LIMIT OMAHA HI-LO',
  flo8: 'FIXED LIMIT OMAHA HI-LO',

  FLO: 'FIXED LIMIT OMAHA',
  flo: 'FIXED LIMIT OMAHA',
  MIXED: 'MIXED GAME',
  mixed: 'MIXED GAME',
};

export function getGameVariantLabel(gameType: string): string {
  return GAME_VARIANT_LABELS[gameType] || gameType.toUpperCase().replace(/_/g, ' ');
}

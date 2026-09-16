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

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CARD CANNOT BE IN TWO PLACES. THE DECK HAS ONE OF EACH.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-31: the hero was holding J9h while the flop showed Kd 9h Qd —
 * the same nine, in his hand and on the board. "How the fuck is that even
 * possible?!"
 *
 * It is not, and the engine did not deal it. It is the client showing a hand
 * that has expired. The hero's cards are held across engine frames on purpose
 * (`cardHoldSameHand` in TablePage) because a snapshot carrying no hero cards
 * means "no news", never "you have none" — a rule that exists because the hero
 * losing sight of their hand is the worse bug. But that hold is fail-OPEN on an
 * unknown hand number, so a frame that cannot identify its hand carries the
 * PREVIOUS hand's cards into the new one, and the new board then contradicts
 * them.
 *
 * The collision is the proof. Whatever path produced it — a missed
 * HAND_STARTED, a snapshot with hand_number 0, a stale recovery row — a hole
 * card that is also on the board is a hand that no longer exists, and it must
 * never be shown as if it did. This is the last line of defence, deliberately
 * placed where every delivery path passes through rather than in any one of
 * them.
 *
 * Suit representation differs by path — the engine's own words ('hearts')
 * arrive on snapshots, the single letters ('h') on the recovery and realtime
 * paths — so both sides are normalised before comparing. Rank is compared with
 * '10' and 'T' folded together for the same reason.
 */
function cardKey(card: { rank?: unknown; suit?: unknown } | null | undefined): string | null {
  if (!card) return null;
  const rawRank = typeof card.rank === 'string' ? card.rank : String(card.rank ?? '');
  const rawSuit = typeof card.suit === 'string' ? card.suit : String(card.suit ?? '');
  if (!rawRank || !rawSuit) return null;
  const rank = rawRank.toUpperCase() === '10' ? 'T' : rawRank.toUpperCase();
  const suitLower = rawSuit.toLowerCase();
  const suit = ENGINE_SUIT_MAP[suitLower] ?? suitLower.charAt(0);
  if (!rank || !suit) return null;
  return `${rank}${suit}`;
}

/**
 * True when any of `cards` also appears on any of the supplied boards.
 *
 * Boards are passed as a rest parameter so the double- and triple-board
 * variants (bomb pots, run-it-twice) are covered by the same call: the runouts
 * come off ONE deck, so a hole card colliding with the second board is exactly
 * as impossible as one colliding with the first.
 */
export function heroCardsCollideWithBoard(
  cards: ReadonlyArray<{ rank?: unknown; suit?: unknown } | null | undefined> | null | undefined,
  ...boards: ReadonlyArray<
    ReadonlyArray<{ rank?: unknown; suit?: unknown } | null | undefined> | null | undefined
  >
): boolean {
  if (!cards || cards.length === 0) return false;
  const onBoard = new Set<string>();
  for (const board of boards) {
    if (!board) continue;
    for (const card of board) {
      const key = cardKey(card);
      if (key) onBoard.add(key);
    }
  }
  if (onBoard.size === 0) return false;
  for (const card of cards) {
    const key = cardKey(card);
    if (key && onBoard.has(key)) return true;
  }
  return false;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ONE RULE FOR "ARE THESE THE HERO'S CARDS, RIGHT NOW, AT THIS TABLE?"
   ═══════════════════════════════════════════════════════════════════════════

   Dan 2026-09-01, on the J9h screenshot: how was it possible, and what makes
   it impossible.

   There are four doors into the hero's `holeCards`, and on 2026-08-31 only two
   of them were guarded:

     1. the realtime push from `table_hole_cards`   NO CHECKS AT ALL
     2. the bounded recovery poll                    hand-checked + board-checked
     3. the snapshot hold across engine frames       board-checked
     4. the GAME_START full-state merge              NO CHECKS AT ALL

   Door 1 is the one that matters most, because it is the only one that
   OVERWRITES cards the hero can already see, and it fires on '*' - INSERT,
   UPDATE and every re-push. A row for hand N arriving after hand N+1 has
   begun repaints hand N's hand onto hand N+1's felt, and then door 3 keeps it
   there. Guarding door 3 alone could never hold, because door 1 simply paints
   it back on the next frame.

   So the decision moves here, out of the component, where it is one function
   with one test file. Every door asks the same question and gets the same
   answer. A future door that forgets to ask is a test failure, not a hand.

   The order of the checks is the order of certainty: identity first (a row for
   another table is never ours), then emptiness, then the hand, then the board.
   The board check is last because it is the only one that can be true of a
   row that is otherwise perfectly legitimate - and when it is true, something
   upstream is already wrong and the strongest available evidence wins. */
export type HeroCardRejection = 'wrong-table' | 'no-cards' | 'stale-hand' | 'collides-with-board';

export type HeroCardVerdict = { ok: true } | { ok: false; reason: HeroCardRejection };

const ACCEPTED: HeroCardVerdict = { ok: true };

export function heroHoleCardsAreForThisHand(args: {
  /** table_id on the row, when the source carries one. */
  rowTableId?: unknown;
  /** The table this component is rendering. */
  tableId?: unknown;
  /** hand_number on the row, when the source carries one. */
  rowHandNumber?: unknown;
  /** The hand the client believes is live; 0 or undefined means "not known yet". */
  currentHandNumber?: unknown;
  cards: ReadonlyArray<{ rank?: unknown; suit?: unknown } | null | undefined> | null | undefined;
  boards: ReadonlyArray<
    ReadonlyArray<{ rank?: unknown; suit?: unknown } | null | undefined> | null | undefined
  >;
}): HeroCardVerdict {
  const { rowTableId, tableId, rowHandNumber, currentHandNumber, cards, boards } = args;

  /* Identity. The realtime channel is filtered server-side by table_id, so
     this can only fire if that filter is ever lost - a shared channel key, a
     bus that fans out, a hand-rolled fetch. It costs one string compare and it
     is the difference between a bug and a bug nobody can explain. */
  if (
    typeof rowTableId === 'string' &&
    typeof tableId === 'string' &&
    rowTableId !== '' &&
    tableId !== '' &&
    rowTableId !== tableId
  ) {
    return { ok: false, reason: 'wrong-table' };
  }

  if (!Array.isArray(cards) || cards.length === 0) return { ok: false, reason: 'no-cards' };

  /* The hand. Only a row from an OLDER hand is refused. A row from a NEWER one
     is the next deal arriving before this client has processed HAND_STARTED,
     and refusing it would blind the hero at the exact moment they are dealt
     in - which is the worse bug, and the reason the hold fails open. An older
     row can never be right, so it can never win. */
  const rowHand =
    typeof rowHandNumber === 'number' && Number.isFinite(rowHandNumber) ? rowHandNumber : 0;
  const liveHand =
    typeof currentHandNumber === 'number' && Number.isFinite(currentHandNumber)
      ? currentHandNumber
      : 0;
  if (rowHand > 0 && liveHand > 0 && rowHand < liveHand) {
    return { ok: false, reason: 'stale-hand' };
  }

  /* The board. Physical proof: a card cannot be in the hero's hand and on the
     felt at the same time, so whatever produced this holding was reading an
     expired hand.

     UNLESS THE HOLDING IS NEWER THAN THE BOARD (2026-09-09). The hero's cards
     arrive as a private USER_EVENT, which the client dispatches on arrival,
     ahead of the queued SNAPSHOT that carries the new hand's empty board - so
     at the moment this runs, `boards` is very often the PREVIOUS hand's, and
     a fresh holding that happens to share a card with it (about one deal in
     five at hold'em, one in three at PLO) was refused, reported to error reporting and
     sent round the recovery poll. A hand that has not been dealt yet cannot
     collide with a board that is already finished; the hand check above
     already fails open on exactly this comparison, so the two now agree. */
  const boardIsOlder = rowHand > 0 && liveHand > 0 && rowHand > liveHand;
  if (!boardIsOlder && heroCardsCollideWithBoard(cards, ...boards)) {
    return { ok: false, reason: 'collides-with-board' };
  }

  return ACCEPTED;
}

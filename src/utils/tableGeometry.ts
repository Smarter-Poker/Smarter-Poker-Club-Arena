/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE GEOMETRY + CARD NORMALIZATION HELPERS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * seatPctToViewportPx — 2026-08-04 BUGFIX (chips flying off the table):
 * Seat positions are PERCENTAGES OF THE TABLE SCALER element, but every chip
 * animation converted them with `pct/100 * window.innerWidth/innerHeight`,
 * i.e. percentages of the whole viewport. On a phone the scaler nearly fills
 * the viewport so the error was invisible; on desktop the table is a centered
 * portrait column, so a seat at x=8% mapped to the far LEFT EDGE of the
 * monitor — pot-win chips visibly flew off the felt and hovered at the screen
 * edges (worst case: split pots stranded one chip on each side).
 * These helpers convert scaler-relative percentages into true viewport pixels
 * via the scaler's bounding rect, falling back to the old math only when the
 * scaler element is not mounted.
 *
 * normalizeCard(s) — 2026-08-04 BUGFIX (board morphing into A♠A♠A♠A♠A♠):
 * ServerTableEngine keeps `currentHandCommunityCards` as STRINGS
 * ("9spades", "Thearts") for hand_history persistence, and broadcasts those
 * same strings in the `community_cards_dealt` event's `board`/`new_cards`.
 * The client typed them as Card objects; `card.rank` was undefined, and
 * CardImage's safety guard renders unknown cards as the Ace of Spades — so
 * the whole board flashed/stuck as five aces on every street until the next
 * full snapshot repaired it. These parsers accept every wire format:
 *   { rank: 'A', suit: 'spades' }   (snapshot format -> { rank: 'A', suit: 's' })
 *   "Aspades" / "10hearts" / "Th"   (engine string formats)
 *   "As" / "9c" / "10d"             (short codes)
 */

/**
 * ONE CARD, ONE SPELLING (Dan 2026-10-25).
 *
 * Every card that enters the table is written the same way: rank '2'-'9',
 * 'T', 'J', 'Q', 'K', 'A' and suit 'h' | 'd' | 'c' | 's'. The engine speaks
 * words ('clubs'), table_hole_cards and realtime speak letters ('c'), and some
 * paths send '10'. When both spellings lived side by side in the hero's row
 * and the board, every "is this the same card?" check that compared them
 * letter by letter quietly failed - the worst of it was a flush made with a
 * hole card being named as the next best hand under the hero's seat.
 * Converting at the door means nothing downstream ever has to care.
 */
export interface NormalizedCard {
  rank: '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
  suit: 'h' | 'd' | 'c' | 's';
}

const SUIT_NORMALIZE: Record<string, NormalizedCard['suit']> = {
  h: 'h',
  d: 'd',
  c: 'c',
  s: 's',
  hearts: 'h',
  diamonds: 'd',
  clubs: 'c',
  spades: 's',
  heart: 'h',
  diamond: 'd',
  club: 'c',
  spade: 's',
};

const RANK_NORMALIZE: Record<string, NormalizedCard['rank']> = {
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  '10': 'T',
  T: 'T',
  t: 'T',
  J: 'J',
  j: 'J',
  Q: 'Q',
  q: 'Q',
  K: 'K',
  k: 'K',
  A: 'A',
  a: 'A',
};

/**
 * Normalize a single card from any wire format into { rank, suit } that
 * CardImage understands. Returns null when the value cannot be parsed —
 * callers should drop nulls rather than render a fake card.
 */
export function normalizeCard(raw: unknown): NormalizedCard | null {
  if (!raw) return null;

  // Object form: { rank, suit } — normalize the field values too, so
  // { rank: '10', suit: 'S' } and friends all resolve.
  if (typeof raw === 'object') {
    const c = raw as { rank?: unknown; suit?: unknown };
    const rank = RANK_NORMALIZE[String(c.rank ?? '')] ?? RANK_NORMALIZE[String(c.rank ?? '').toUpperCase()];
    const suit = SUIT_NORMALIZE[String(c.suit ?? '').toLowerCase()];
    if (rank && suit) return { rank, suit };
    return null;
  }

  // String form: "Aspades", "10hearts", "As", "9c", "Th", "AS", "10H"...
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.length < 2) return null;
    // Rank is 1 char, or 2 chars when it starts with "10"
    const rankPart = s.startsWith('10') ? '10' : s[0];
    const suitPart = s.slice(rankPart.length).toLowerCase();
    const rank = RANK_NORMALIZE[rankPart] ?? RANK_NORMALIZE[rankPart.toUpperCase()];
    const suit = SUIT_NORMALIZE[suitPart] ?? SUIT_NORMALIZE[suitPart[0] ?? ''];
    if (rank && suit) return { rank, suit };
    return null;
  }

  return null;
}

/**
 * Rewrite every readable card in one spelling and leave everything else
 * EXACTLY where it was. Unlike normalizeCards this never drops an entry: a
 * face-down placeholder or a null slot keeps its index, so a seat's card count
 * and any index-keyed flag on it are unchanged. For state paths that must not
 * lose a slot; normalizeCards stays the choice where dropping junk is right.
 */
export function canonicalCards<T>(raw: readonly T[] | null | undefined): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => (normalizeCard(c) as unknown as T) ?? c);
}

/** Normalize an array of cards, dropping anything unparseable. */
export function normalizeCards(raw: unknown): NormalizedCard[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCard).filter((c): c is NormalizedCard => c !== null);
}

/**
 * Convert a seat/pot position expressed as a PERCENTAGE OF THE TABLE SCALER
 * into absolute viewport pixels (the coordinate space the chip-animation
 * overlay renders in).
 */
export function seatPctToViewportPx(
  scalerEl: HTMLElement | null,
  pct: { x: number; y: number }
): { x: number; y: number } {
  if (scalerEl) {
    const rect = scalerEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return {
        x: rect.left + (pct.x / 100) * rect.width,
        y: rect.top + (pct.y / 100) * rect.height,
      };
    }
  }
  // Fallback: old viewport-relative math (correct enough on narrow phones)
  return {
    x: (pct.x / 100) * window.innerWidth,
    y: (pct.y / 100) * window.innerHeight,
  };
}

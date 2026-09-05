/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND EVALUATOR — the five cards that actually played
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * hand_history stores hole cards and a board, and `winners[].hand.name` gives the
 * category ("Royal Flush"). What it does not store is WHICH five cards made it.
 * A jackpot board that shows a player's two hole cards, when the reference shows
 * the five-card hand, is telling half the story.
 *
 * This is display-only. The engine remains the authority on who won and what the
 * hand was called; nothing here decides a pot. Its job is to pick, out of cards
 * we already know were shown, the five that constitute the made hand, so the
 * winners list and the showdown can draw them.
 *
 * VARIANT RULES ARE NOT COSMETIC HERE:
 *   Hold'em  - best five of (2 hole + 5 board), any mix.
 *   Omaha    - EXACTLY two from hand and EXACTLY three from board. Picking the
 *              best five freely out of an Omaha holding produces hands that are
 *              not legal in Omaha (four hole cards to a flush, say), which is the
 *              single most common way a hand display lies to a player.
 *   Short Deck - a 36-card deck changes what BEATS what. A flush outranks a
 *              full house, and the lowest straight is A-6-7-8-9 rather than
 *              A-2-3-4-5.
 *
 * SHORT DECK USED TO FALL THROUGH TO THE HOLD'EM SEARCH, and the note here said
 * that was fine "because short deck is not BBJ-eligible". True of the jackpot
 * and irrelevant to everything else: this evaluator also names the made hand in
 * the table's own Previous Hand rundown, and production holds 41,153 short-deck
 * hands. On those it would pick a full house over a flush as the "best" five —
 * the losing hand, drawn as the winner — and call the A-6-7-8-9 wheel a high
 * card.
 *
 * The rules below are ported from the engine's own evaluator
 * (server/src/engine/PokerEngine.ts, evaluate5Cards + checkStraight), because
 * the engine decides the pot and this only draws it. Two implementations of one
 * ruleset is already one too many; two that DISAGREE would show a player a hand
 * that lost the money.
 */

import type { Card as DeckCard } from '../components/table/CardImage';

const RANK_VALUE: Record<string, number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

/** Category ranks, high is better. */
export const CATEGORY = {
  HIGH_CARD: 1,
  PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
} as const;

const CATEGORY_NAME: Record<number, string> = {
  1: 'High Card',
  2: 'Pair',
  3: 'Two Pair',
  4: 'Three of a Kind',
  5: 'Straight',
  6: 'Flush',
  7: 'Full House',
  8: 'Four of a Kind',
  9: 'Straight Flush',
};

export interface HandScore {
  /** One of CATEGORY. */
  category: number;
  /** Ordered tiebreakers, most significant first. */
  tiebreak: number[];
}

export interface BestHand extends HandScore {
  /** The exact five cards that make the hand. */
  cards: DeckCard[];
  /** "Royal Flush", "Full House", ... */
  name: string;
}

function value(card: DeckCard): number {
  return RANK_VALUE[String(card.rank).toUpperCase()] ?? 0;
}

/** Compare two scores. Positive when a beats b. */
export function compareScore(a: HandScore, b: HandScore): number {
  if (a.category !== b.category) return a.category - b.category;
  const n = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.tiebreak[i] ?? 0;
    const y = b.tiebreak[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Score exactly five cards.
 *
 * The wheel (A-2-3-4-5) is a five-high straight, not an ace-high one - the ace
 * plays low and nothing else does. Getting that backwards is the classic
 * evaluator bug, and it silently promotes the weakest straight to the strongest.
 */
export function scoreFive(cards: DeckCard[], shortDeck = false): HandScore {
  const vals = cards.map(value).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  const counts = new Map<number, number>();
  vals.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));

  // Rank groups ordered by count then by rank - that ordering IS the tiebreaker
  // for every paired category.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join('');
  const byGroup = groups.map((g) => g[0]);

  const distinct = [...counts.keys()].sort((a, b) => b - a);
  let straightHigh = 0;
  if (distinct.length === 5) {
    if (distinct[0] - distinct[4] === 4) straightHigh = distinct[0];
    // THE WHEEL, and it is a different wheel in short deck. A-6-7-8-9 there,
    // A-2-3-4-5 everywhere else. Both are five-high in the sense that matters:
    // the ace plays LOW and nothing else does, so the straight is the weakest
    // one available. Getting this backwards silently promotes the weakest
    // straight to the strongest.
    else if (shortDeck && distinct[0] === 14 && distinct[1] === 9 && distinct[4] === 6)
      straightHigh = 5;
    else if (!shortDeck && distinct[0] === 14 && distinct[1] === 5 && distinct[4] === 2)
      straightHigh = 5;
  }

  if (isFlush && straightHigh) {
    return { category: CATEGORY.STRAIGHT_FLUSH, tiebreak: [straightHigh] };
  }
  if (shape === '41') return { category: CATEGORY.FOUR_OF_A_KIND, tiebreak: byGroup };

  // SHORT DECK INVERTS THESE TWO. Bible V8 Appendix D, and the engine does the
  // same swap in evaluate5Cards. A flush is harder to make with 36 cards than a
  // full house, so it outranks one.
  const fullHouse = shortDeck ? CATEGORY.FLUSH : CATEGORY.FULL_HOUSE;
  const flush = shortDeck ? CATEGORY.FULL_HOUSE : CATEGORY.FLUSH;

  if (shape === '32') return { category: fullHouse, tiebreak: byGroup };
  if (isFlush) return { category: flush, tiebreak: vals };
  if (straightHigh) return { category: CATEGORY.STRAIGHT, tiebreak: [straightHigh] };
  if (shape === '311') return { category: CATEGORY.THREE_OF_A_KIND, tiebreak: byGroup };
  if (shape === '221') return { category: CATEGORY.TWO_PAIR, tiebreak: byGroup };
  if (shape === '2111') return { category: CATEGORY.PAIR, tiebreak: byGroup };
  return { category: CATEGORY.HIGH_CARD, tiebreak: vals };
}

/** The 36-card game. Its own straight and its own order of battle. */
export function isShortDeckVariant(variant: string | null | undefined): boolean {
  const raw = String(variant || '')
    .toLowerCase()
    .trim();
  return raw === 'short_deck' || raw === 'shortdeck' || raw === 'sixplus' || raw === '6plus';
}

/** Every k-subset of `arr`. */
function combinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = [];
  if (k > arr.length || k < 0) return out;
  const idx: number[] = [];
  const walk = (start: number) => {
    if (idx.length === k) {
      out.push(idx.map((i) => arr[i]));
      return;
    }
    for (let i = start; i < arr.length; i += 1) {
      idx.push(i);
      walk(i + 1);
      idx.pop();
    }
  };
  walk(0);
  return out;
}

/** A variant that plays by Omaha's exactly-two-from-hand rule. */
export function isOmahaVariant(variant: string | null | undefined): boolean {
  const raw = String(variant || '')
    .toLowerCase()
    .trim();
  return raw.startsWith('plo') || raw.startsWith('flo') || raw.includes('omaha');
}

/**
 * A variant where a player is dealt three cards and must throw one away.
 *
 * 2026-09-01: THE LABEL UNDER THE HERO'S SEAT WAS NAMING A HAND THEY CANNOT
 * HAVE. Crazy Pineapple deals three hole cards and the discard comes AFTER the
 * flop, so for the whole discard window the hero is holding three cards with a
 * board down - and `bestFive`'s Hold'em branch takes any five of those eight.
 * Hold 9h 9d 9s on an A-K-2 flop and it printed "Three of a Kind", at the exact
 * moment the player was choosing which card to throw, for a hand that cannot
 * survive the throw. The same window is the one place this label matters.
 *
 * The rule is the server's own, from `pineappleDiscardChoice.ts`: "after the
 * discard the hand plays exactly like holdem" with the two cards you kept. So
 * the honest answer is the best hand over the three ways to keep two, which is
 * what the branch in bestFive below computes.
 *
 * OFC is excluded by name. It shares the word and none of the rules, it has no
 * live tables (measured 2026-09-01: 0 of 111,582), and if it ever comes back it
 * must not silently inherit this.
 */
export function isPineappleVariant(variant: string | null | undefined): boolean {
  const raw = String(variant || '')
    .toLowerCase()
    .trim();
  if (raw.startsWith('ofc')) return false;
  return raw.includes('pineapple');
}

function nameFor(score: HandScore, shortDeck = false): string {
  if (score.category === CATEGORY.STRAIGHT_FLUSH) {
    return score.tiebreak[0] === 14 ? 'Royal Flush' : 'Straight Flush';
  }
  // In short deck the two slots are swapped, so the NAME has to follow the
  // swap or a flush would be announced as a full house.
  if (shortDeck && score.category === CATEGORY.FLUSH) return 'Full House';
  if (shortDeck && score.category === CATEGORY.FULL_HOUSE) return 'Flush';
  return CATEGORY_NAME[score.category] || 'High Card';
}

/**
 * The best legal five cards from a holding plus a board.
 *
 * Returns null when there is not enough information to be sure - fewer than five
 * cards available, or an Omaha holding with fewer than two hole cards or a board
 * with fewer than three. Returning null is deliberate: a partial guess drawn as a
 * definite five-card hand is worse than drawing nothing.
 */
export function bestFive(
  hole: DeckCard[],
  board: DeckCard[],
  variant?: string | null
): BestHand | null {
  const h = Array.isArray(hole) ? hole : [];
  const b = Array.isArray(board) ? board : [];

  let candidates: DeckCard[][];
  if (isOmahaVariant(variant)) {
    if (h.length < 2 || b.length < 3) return null;
    const holePairs = combinations(h, 2);
    const boardTriples = combinations(b, 3);
    candidates = [];
    for (const hp of holePairs) for (const bt of boardTriples) candidates.push([...hp, ...bt]);
  } else if (isPineappleVariant(variant) && h.length > 2) {
    /* Three in the hand and one of them is leaving. Score the best of the
       three hands that can actually survive the discard - keep two, then play
       them exactly as Hold'em, using either, one or neither. This is a NO-OP
       after the discard, where h.length is 2 and the branch below is reached
       unchanged, so it only ever affects the window it exists for. */
    const keepPairs = combinations(h, 2);
    candidates = [];
    for (const kp of keepPairs) {
      for (const five of combinations([...kp, ...b], 5)) candidates.push(five);
    }
    if (candidates.length === 0) return null;
  } else {
    const all = [...h, ...b];
    if (all.length < 5) return null;
    candidates = combinations(all, 5);
  }

  const shortDeck = isShortDeckVariant(variant);
  let best: BestHand | null = null;
  for (const combo of candidates) {
    const score = scoreFive(combo, shortDeck);
    if (!best || compareScore(score, best) > 0) {
      best = { ...score, cards: combo, name: nameFor(score, shortDeck) };
    }
  }
  if (!best) return null;

  // Lay them down the way a poker room does: the cards that define the category
  // first, kickers after, high to low within each group.
  const counts = new Map<number, number>();
  best.cards.forEach((c) => counts.set(value(c), (counts.get(value(c)) || 0) + 1));
  const ordered = [...best.cards].sort((x, y) => {
    const cx = counts.get(value(x)) || 0;
    const cy = counts.get(value(y)) || 0;
    if (cx !== cy) return cy - cx;
    return value(y) - value(x);
  });
  return { ...best, cards: ordered };
}

/**
 * A split-pot variant: the pot is halved between the best high hand and the
 * best qualifying (eight-or-better) low. PLO8 and FLO8 today; anything the
 * engine names with an "8", "hi-lo", "hilo" or "o8" is one.
 *
 * 2026-09-04 (Previous Hand second sweep): the client had NO low evaluator, so
 * on a PLO8 hand the rundown named a low winner by their HIGH hand ("High
 * Card") and could not say why two players had "won". The engine decides the
 * pot; this names the half it awarded.
 */
export function isEightOrBetterVariant(variant: string | null | undefined): boolean {
  const raw = String(variant || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (!raw) return false;
  return (
    raw === 'plo8' ||
    raw === 'flo8' ||
    raw.endsWith('o8') ||
    raw.includes('hilo') ||
    raw.includes('8orbetter') ||
    raw.includes('eightorbetter')
  );
}

export interface LowHand {
  /** The five cards, sorted high to low (the way the low is spoken). */
  cards: DeckCard[];
  /** Rank values with the ace as 1, sorted descending: [8, 6, 4, 3, 2]. */
  ranks: number[];
  /** The engine's own name for it: "Low: 8-6-4-3-2". */
  name: string;
}

/** Ace plays low; everything else is its face value. */
function lowValue(card: DeckCard): number {
  const v = value(card);
  return v === 14 ? 1 : v;
}

/**
 * Lower is better; lexicographic on the descending rank arrays, exactly as the
 * engine's `compareLowHands` (server/src/engine/PokerEngine.ts).
 */
export function compareLow(a: number[], b: number[]): number {
  for (let i = 0; i < 5; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The best qualifying low - five distinct ranks, all eight or lower, ace low,
 * exactly two from the hand and three from the board - or null when the holding
 * does not qualify. Ported from the engine's `evaluateOmahaLowHand` so the
 * rundown names the low the engine paid, not a different one.
 */
export function bestLow(hole: DeckCard[], board: DeckCard[]): LowHand | null {
  const h = Array.isArray(hole) ? hole : [];
  const b = Array.isArray(board) ? board : [];
  if (h.length < 2 || b.length < 3) return null;
  let best: LowHand | null = null;
  for (const hp of combinations(h, 2)) {
    for (const bt of combinations(b, 3)) {
      const five = [...hp, ...bt];
      const ranks = five.map(lowValue);
      if (new Set(ranks).size !== 5) continue;
      if (Math.max(...ranks) > 8) continue;
      const sorted = [...ranks].sort((x, y) => y - x);
      if (!best || compareLow(sorted, best.ranks) < 0) {
        best = {
          cards: [...five].sort((x, y) => lowValue(y) - lowValue(x)),
          ranks: sorted,
          name: `Low: ${sorted.join('-')}`,
        };
      }
    }
  }
  return best;
}

/** Stable key for a card, so a "did this card play" lookup is cheap. */
export function cardKey(card: DeckCard): string {
  return `${String(card.rank).toUpperCase()}${card.suit}`;
}

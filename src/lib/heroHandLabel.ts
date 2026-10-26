/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE LABEL UNDER THE HERO'S SEAT - the best hand they hold right now
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-10-25, from a player's screenshot: "IT MUST 100% OF THE TIME
 * DISPLAY THE BEST CURRENT HAND THAT THE USER HAS."
 *
 * This used to live inline in TablePage, where it could only be read, never
 * run. Pulled out so every rule below is pinned by
 * tests/unit/heroHandLabel.test.ts. The rules, each one a case the inline
 * version got wrong:
 *
 *  1. BEFORE THE FLOP THE BEST HAND IS A PAIR. Every board game plays at most
 *     two cards from the hand preflop that can pair each other: Hold'em has two,
 *     Omaha plays exactly two, Pineapple keeps two. A PLO hand of A-A-A-K was
 *     labelled "Three of a Kind" (and A-A-A-A "Four of a Kind") - a hand the
 *     player cannot have. Measured 2026-10-25: Omaha is ~620k of the ~1.25M
 *     hands dealt per day, PLO6 alone 86k, so it was not rare.
 *
 *  2. HI-LO HAS TWO HALVES. In PLO8 and FLO8 (~96k hands a day) the pot is
 *     split with the best qualifying low, and the label named only the high
 *     hand. It now adds the low when one qualifies: "Flush · 8-6 Low".
 *
 *  3. EVERY BOARD COUNTS. A double- or triple-board bomb pot deals full
 *     independent boards, and the label read board 1 only. It now names the
 *     hand on each board in order: "Flush / Two Pair".
 *
 * Display only. The engine decides every pot with its own evaluator, which
 * tests/unit/seatLabelAgreesWithTheEngine.test.ts holds this one to.
 */
import type { Card } from '../components/table/CardImage';
import { bestFive, bestLow, isEightOrBetterVariant } from '../utils/handEvaluator';
import { normalizeCard } from '../utils/tableGeometry';

const RANK_ORDER: Record<string, number> = {
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

const RANK_WORD: Record<string, string> = {
  '2': 'Two',
  '3': 'Three',
  '4': 'Four',
  '5': 'Five',
  '6': 'Six',
  '7': 'Seven',
  '8': 'Eight',
  '9': 'Nine',
  T: 'Ten',
  J: 'Jack',
  Q: 'Queen',
  K: 'King',
  A: 'Ace',
};

/** Only cards we can actually read; a placeholder never names a hand. */
function readable(cards: ReadonlyArray<unknown> | null | undefined): Card[] {
  if (!Array.isArray(cards)) return [];
  const out: Card[] = [];
  for (const c of cards) {
    const n = normalizeCard(c);
    if (n) out.push(n as Card);
  }
  return out;
}

/** Preflop: a pair if any two hole cards share a rank, otherwise the high card. */
export function startingHandLabel(hole: ReadonlyArray<unknown>): string | null {
  const cards = readable(hole);
  if (cards.length < 2) return null;
  const seen = new Set<string>();
  for (const c of cards) {
    if (seen.has(c.rank)) return 'Pair';
    seen.add(c.rank);
  }
  const high = cards.reduce((a, b) =>
    (RANK_ORDER[b.rank] ?? 0) > (RANK_ORDER[a.rank] ?? 0) ? b : a
  );
  return `${RANK_WORD[high.rank] ?? high.rank} High`;
}

/** "8-6 Low", the way a low is spoken: its top two cards, ace as A. */
function lowWords(ranks: number[]): string {
  const say = (r: number) => (r === 1 ? 'A' : String(r));
  return `${say(ranks[0])}-${say(ranks[1])} Low`;
}

/** The hand on one board, with the low half added in a split-pot game. */
function boardLabel(
  hole: Card[],
  board: Card[],
  variant: string | null | undefined
): string | null {
  const high = bestFive(hole, board, variant);
  if (!high) return null;
  if (isEightOrBetterVariant(variant)) {
    const low = bestLow(hole, board);
    if (low) return `${high.name} · ${lowWords(low.ranks)}`;
  }
  return high.name;
}

/**
 * The best hand the hero holds right now, across every board in play.
 * Null when there is nothing honest to say (fewer than two readable cards, or
 * a board too short to make a hand on).
 */
export function heroHandLabel(
  hole: ReadonlyArray<unknown> | null | undefined,
  boards: ReadonlyArray<ReadonlyArray<unknown> | null | undefined>,
  variant: string | null | undefined
): string | null {
  const cards = readable(hole);
  if (cards.length < 2) return null;
  const live = boards.map(readable).filter((b) => b.length > 0);
  if (live.length === 0) return startingHandLabel(cards);
  const names: string[] = [];
  for (const board of live) {
    let name: string | null = null;
    try {
      name = boardLabel(cards, board, variant);
    } catch {
      name = null;
    }
    if (name) names.push(name);
  }
  return names.length > 0 ? names.join(' / ') : null;
}

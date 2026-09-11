/** Exact-card combinatorics, independent of equity and hand-strength percentiles.
 * Bounded to six hole cards, five board cards and 45 one-card transitions.
 * A nut straight/flush below means best within that category, not overall nuts.
 */
import type { Card } from '../../types.js';
const ranks = '23456789TJQKA';
const suits: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
const value = (c: Card) => ranks.indexOf(c.rank) + 2;
const key = (c: Card) => `${c.rank}:${c.suit}`;
const mask = (cards: Card[]) => cards.reduce((m, c) => m | (1 << (value(c) - 2)), 0);
const straightMasks = Array.from({ length: 10 }, (_, i) => {
  const high = i + 5;
  const values = high === 5 ? [14, 2, 3, 4, 5] : [high - 4, high - 3, high - 2, high - 1, high];
  return { high, mask: values.reduce((m, v) => m | (1 << (v - 2)), 0) };
});
const pairs = <T>(cards: T[]): T[][] =>
  cards.flatMap((a, i) => cards.slice(i + 1).map((b) => [a, b]));
const triples = <T>(cards: T[]): T[][] =>
  cards.flatMap((a, i) =>
    cards.slice(i + 1).flatMap((b, j) => cards.slice(i + j + 2).map((c) => [a, b, c]))
  );
const bits = (n: number) => {
  let count = 0;
  for (; n; n &= n - 1) count++;
  return count;
};
function straightHigh(hole: Card[], board: Card[]): number {
  let best = 0;
  for (const h of pairs(hole))
    for (const b of triples(board)) {
      const m = mask([...h, ...b]);
      if (bits(m) !== 5) continue;
      for (const s of straightMasks) if (s.mask === m) best = Math.max(best, s.high);
    }
  return best;
}
function possibleStraightHigh(available: Card[], board: Card[]): number {
  const availableRanks = mask(available);
  let best = 0;
  for (const b of triples(board)) {
    const m = mask(b);
    if (bits(m) !== 3) continue;
    for (const s of straightMasks) {
      const missing = s.mask & ~m;
      if ((m & s.mask) === m && bits(missing) === 2 && (availableRanks & missing) === missing)
        best = Math.max(best, s.high);
    }
  }
  return best;
}
function lowScore(hole: Card[], board: Card[]): number | null {
  let best = Infinity;
  for (const h of pairs(hole))
    for (const b of triples(board)) {
      const values = [...h, ...b].map((c) => (c.rank === 'A' ? 1 : value(c))).sort((a, b) => b - a);
      if (values[0] > 8 || new Set(values).size !== 5) continue;
      best = Math.min(
        best,
        values.reduce((n, v) => n * 9 + v, 0)
      );
    }
  return Number.isFinite(best) ? best : null;
}
function possibleLow(available: Card[], board: Card[]) {
  // Only rank availability matters for low; one representative card per rank.
  const low = [
    ...new Map(
      available.filter((c) => c.rank === 'A' || value(c) <= 8).map((c) => [c.rank, c])
    ).values(),
  ];
  return lowScore(low, board);
}
function flushFacts(hole: Card[], board: Card[], available: Card[]) {
  return suits.flatMap((suit) => {
    const h = hole
      .filter((c) => c.suit === suit)
      .map(value)
      .sort((a, b) => b - a);
    const b = board
      .filter((c) => c.suit === suit)
      .map(value)
      .sort((a, b) => b - a);
    const a = available
      .filter((c) => c.suit === suit)
      .map(value)
      .sort((a, b) => b - a);
    if (h.length < 2 || b.length < 2) return [];
    const compare = (pair: number[]) =>
      [...pair, ...b.slice(0, 3)].sort((a, b) => b - a).reduce((n, v) => n * 15 + v, 0);
    const beaten = a.length >= 2 && compare(a.slice(0, 2)) > compare(h.slice(0, 2));
    return [
      {
        suit,
        made: b.length >= 3,
        draw: b.length === 2 && board.length < 5,
        higherFlushPossible: beaten,
        highestHoleRanks: h.slice(0, 2),
      },
    ];
  });
}

export function omahaCardFacts(
  hole: Card[],
  board: Card[],
  includeTransitions = true,
  includeLow = true
) {
  if (
    ![4, 5, 6].includes(hole.length) ||
    ![0, 3, 4, 5].includes(board.length) ||
    [...hole, ...board].some(
      (c) => !c || c.rank.length !== 1 || !ranks.includes(c.rank) || !suits.includes(c.suit)
    ) ||
    new Set([...hole, ...board].map(key)).size !== hole.length + board.length
  )
    throw new Error('Invalid Omaha facts cards');
  const known = new Set([...hole, ...board].map(key));
  const available = suits
    .flatMap((suit) => [...ranks].map((rank) => ({ rank: rank as Card['rank'], suit })))
    .filter((c) => !known.has(key(c)));
  const distinct = [...new Set(hole.map(value))].sort((a, b) => a - b);
  const lowAce = distinct.map((v) => (v === 14 ? 1 : v)).sort((a, b) => a - b);
  const gaps = (values: number[]) => values.slice(1).map((v, i) => Math.max(0, v - values[i] - 1));
  const currentStraight = straightHigh(hole, board);
  const currentLow = includeLow ? lowScore(hole, board) : null;
  const boardRanks = [...new Set(board.map((c) => c.rank))];
  const lowHoleRanks = [
    ...new Set(hole.map((c) => (c.rank === 'A' ? 1 : value(c))).filter((v) => v <= 8)),
  ].sort((a, b) => a - b);
  const nextCards =
    includeTransitions && board.length >= 3 && board.length < 5
      ? available.map((card) => {
          const next = [...board, card];
          const rest = available.filter((c) => key(c) !== key(card));
          const straight = straightHigh(hole, next);
          const low = includeLow ? lowScore(hole, next) : null;
          const flushes = flushFacts(hole, next, rest);
          return {
            card,
            straightHigh: straight,
            makesStraight: currentStraight === 0 && straight > 0,
            nutStraight: straight > 0 && straight >= possibleStraightHigh(rest, next),
            makesFlush:
              flushes.some((f) => f.made) &&
              !flushFacts(hole, board, available).some((f) => f.made),
            nutFlush: flushes.some((f) => f.made && !f.higherFlushPossible),
            pairsBoard: board.some((c) => c.rank === card.rank),
            completesPocketSet:
              hole.filter((c) => c.rank === card.rank).length >= 2 &&
              !board.some((c) => c.rank === card.rank),
            repeatsLowHoleRank: lowHoleRanks.includes(card.rank === 'A' ? 1 : value(card)),
            qualifiesLow: includeLow ? low !== null : null,
            nutLow: includeLow ? low !== null && low === possibleLow(rest, next) : null,
          };
        })
      : [];
  const flushes = flushFacts(hole, board, available);
  return {
    version: 'omaha-exact-card-facts-v1' as const,
    lowFactsIncluded: includeLow,
    rankGaps: gaps(distinct),
    aceLowGaps: gaps(lowAce),
    rankSpan: distinct[distinct.length - 1] - distinct[0],
    aceLowSpan: lowAce[lowAce.length - 1] - lowAce[0],
    straightHigh: currentStraight,
    nutStraight: currentStraight > 0 && currentStraight >= possibleStraightHigh(available, board),
    straightOutCards: nextCards.filter((c) => c.makesStraight).map((c) => c.card),
    nutStraightOutCards: nextCards
      .filter((c) => c.makesStraight && c.nutStraight)
      .map((c) => c.card),
    wrapOutCount: nextCards.filter((c) => c.makesStraight).length,
    flushes,
    nutFlushBlockerSuits: suits.filter((s) => {
      const notOnBoard = [...ranks]
        .reverse()
        .find((r) => !board.some((c) => c.rank === r && c.suit === s));
      return hole.some((c) => c.suit === s && c.rank === notOnBoard);
    }),
    setRanks: boardRanks.filter(
      (r) =>
        board.filter((c) => c.rank === r).length === 1 &&
        hole.filter((c) => c.rank === r).length >= 2
    ),
    setBlockers: boardRanks.map((rank) => {
      const onBoard = board.filter((c) => c.rank === rank).length;
      const held = hole.filter((c) => c.rank === rank).length;
      const remaining = 4 - onBoard - held;
      return { rank, held, availableOpponentPairs: (remaining * (remaining - 1)) / 2 };
    }),
    lowHoleRanks,
    hasBackupLowCards: lowHoleRanks.length >= 3,
    nutLow: currentLow !== null && currentLow === possibleLow(available, board),
    counterfeitTransitions: nextCards
      .filter((c) => c.repeatsLowHoleRank)
      .map((c) => ({ card: c.card, nutLowAfter: c.nutLow, qualifiesLowAfter: c.qualifiesLow })),
    nextCards,
    calibratedDominationProbability: null,
  };
}

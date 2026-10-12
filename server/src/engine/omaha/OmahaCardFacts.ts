/** Exact-card combinatorics, independent of equity and hand-strength percentiles.
 * Bounded to six hole cards, five board cards and 45 one-card transitions.
 * A nut straight/flush below means best within that category, not overall nuts.
 */
import type { Card } from '../../types.js';
const ranks = '23456789TJQKA';
const suits: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANK_VALUE: Record<string, number> = Object.fromEntries(
  [...ranks].map((rank, index) => [rank, index + 2])
);
// Called only after the cards are validated, so every rank is in the table.
const value = (c: Card) => RANK_VALUE[c.rank];
const key = (c: Card) => `${c.rank}:${c.suit}`;
const mask = (cards: Card[]) => cards.reduce((m, c) => m | (1 << (value(c) - 2)), 0);
const straightMasks = Array.from({ length: 10 }, (_, i) => {
  const high = i + 5;
  const values = high === 5 ? [14, 2, 3, 4, 5] : [high - 4, high - 3, high - 2, high - 1, high];
  return { high, mask: values.reduce((m, v) => m | (1 << (v - 2)), 0) };
});
const bits = (n: number) => {
  let count = 0;
  for (; n; n &= n - 1) count++;
  return count;
};
const STRAIGHT_HIGH_BY_MASK = new Map(straightMasks.map((s) => [s.mask, s.high]));
const rankBits = (cards: Card[]) => cards.map((c) => 1 << (value(c) - 2));
/** Best straight from exactly two hole and three board cards (0 if none). */
function straightHigh(hole: Card[], board: Card[]): number {
  const h = rankBits(hole);
  const b = rankBits(board);
  let best = 0;
  for (let i = 0; i < h.length; i++)
    for (let j = i + 1; j < h.length; j++) {
      const pair = h[i] | h[j];
      if (h[i] === h[j]) continue; // a paired hand cannot hold five distinct ranks
      for (let x = 0; x < b.length; x++)
        for (let y = x + 1; y < b.length; y++)
          for (let z = y + 1; z < b.length; z++) {
            const m = pair | b[x] | b[y] | b[z];
            if (bits(m) !== 5) continue;
            const high = STRAIGHT_HIGH_BY_MASK.get(m);
            if (high !== undefined && high > best) best = high;
          }
    }
  return best;
}
/** Best straight an opponent could hold with two of `availableRanks` (a rank
 * mask) and three board cards. */
function possibleStraightHighOfRanks(availableRanks: number, board: Card[]): number {
  const b = rankBits(board);
  let best = 0;
  for (let x = 0; x < b.length; x++)
    for (let y = x + 1; y < b.length; y++)
      for (let z = y + 1; z < b.length; z++) {
        const m = b[x] | b[y] | b[z];
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
  // Qualifying lows need five DISTINCT ranks: duplicates and suits cannot
  // improve them. For each legal board triple the two lowest available hole
  // ranks are optimal. Rank masks preserve the exact 8-or-better ordering,
  // avoiding hundreds of transient arrays during every counterfeit transition.
  const lowMask = (cards: Card[]) => {
    let result = 0;
    for (const card of cards) {
      const rank = card.rank === 'A' ? 1 : value(card);
      if (rank <= 8) result |= 1 << (rank - 1);
    }
    return result;
  };
  const holes = lowMask(hole),
    boards = lowMask(board);
  if (bits(holes) < 2 || bits(boards) < 3) return null;
  let best = 256;
  for (let a = boards; a; a &= a - 1) {
    const first = a & -a;
    for (let b = a & (a - 1); b; b &= b - 1) {
      const second = b & -b;
      for (let c = b & (b - 1); c; c &= c - 1) {
        const triple = first | second | (c & -c);
        const available = holes & ~triple;
        const remaining = available & (available - 1);
        if (!remaining) continue;
        best = Math.min(best, triple | (available & -available) | (remaining & -remaining));
      }
    }
  }
  if (best === 256) return null;
  let score = 0;
  for (let rank = 8; rank >= 1; rank--) if (best & (1 << (rank - 1))) score = score * 9 + rank;
  return score;
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
function isNutLow(score: number | null, available: Card[], board: Card[]): boolean {
  if (score === null) return false;
  const opponentBest = possibleLow(available, board);
  // A blocked tie does not demote an unbeatable low. Five/six-card holdings
  // can remove every physical copy of a required opponent rank.
  return opponentBest === null || score <= opponentBest;
}
/** Values of one suit's cards, highest first, per suit in `suits` order. */
const bySuit = (cards: Card[]) =>
  suits.map((suit) =>
    cards
      .filter((c) => c.suit === suit)
      .map(value)
      .sort((a, b) => b - a)
  );
function flushFactsOfSuits(
  holeBySuit: number[][],
  boardBySuit: number[][],
  availableBySuit: number[][],
  boardLength: number
) {
  return suits.flatMap((suit, index) => {
    const h = holeBySuit[index];
    const b = boardBySuit[index];
    const a = availableBySuit[index];
    if (h.length < 2 || b.length < 2) return [];
    const compare = (pair: number[]) =>
      [...pair, ...b.slice(0, 3)].sort((a, b) => b - a).reduce((n, v) => n * 15 + v, 0);
    const beaten = a.length >= 2 && compare(a.slice(0, 2)) > compare(h.slice(0, 2));
    return [
      {
        suit,
        made: b.length >= 3,
        draw: b.length === 2 && boardLength < 5,
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
  const straightFlushHigh = Math.max(
    0,
    ...suits.map((suit) =>
      straightHigh(
        hole.filter((c) => c.suit === suit),
        board.filter((c) => c.suit === suit)
      )
    )
  );
  const opponentStraightFlushHigh = Math.max(
    0,
    ...suits.map((suit) =>
      possibleStraightHighOfRanks(
        mask(available.filter((c) => c.suit === suit)),
        board.filter((c) => c.suit === suit)
      )
    )
  );
  const currentLow = includeLow ? lowScore(hole, board) : null;
  const boardRanks = [...new Set(board.map((c) => c.rank))];
  const lowHoleRanks = [
    ...new Set(hole.map((c) => (c.rank === 'A' ? 1 : value(c))).filter((v) => v <= 8)),
  ].sort((a, b) => a - b);
  const holeBySuit = bySuit(hole);
  const boardBySuit = bySuit(board);
  const availableBySuit = bySuit(available);
  const flushes = flushFactsOfSuits(holeBySuit, boardBySuit, availableBySuit, board.length);
  const flushMade = flushes.some((f) => f.made);
  // How many available cards hold each rank: removing one card removes its
  // rank from the opponents' ranks only if it was the last of that rank.
  const availableRankCount = new Array<number>(15).fill(0);
  for (const c of available) availableRankCount[value(c)]++;
  const availableRanks = mask(available);
  const nextCards =
    includeTransitions && board.length >= 3 && board.length < 5
      ? available.map((card) => {
          const next = [...board, card];
          const v = value(card);
          const restRanks =
            availableRankCount[v] === 1 ? availableRanks & ~(1 << (v - 2)) : availableRanks;
          const straight = straightHigh(hole, next);
          const low = includeLow ? lowScore(hole, next) : null;
          // This card's suit gains it on the board and loses it from the
          // opponents' cards; every other suit is unchanged.
          const suitIndex = suits.indexOf(card.suit);
          const nextBoardBySuit = boardBySuit.map((values, index) =>
            index === suitIndex ? [...values, v].sort((a, b) => b - a) : values
          );
          const restBySuit = availableBySuit.map((values, index) =>
            index === suitIndex ? values.filter((x) => x !== v) : values
          );
          const nextFlushes = flushFactsOfSuits(
            holeBySuit,
            nextBoardBySuit,
            restBySuit,
            next.length
          );
          return {
            card,
            straightHigh: straight,
            makesStraight: currentStraight === 0 && straight > 0,
            nutStraight: straight > 0 && straight >= possibleStraightHighOfRanks(restRanks, next),
            makesFlush: nextFlushes.some((f) => f.made) && !flushMade,
            nutFlush: nextFlushes.some((f) => f.made && !f.higherFlushPossible),
            pairsBoard: board.some((c) => c.rank === card.rank),
            completesPocketSet:
              hole.filter((c) => c.rank === card.rank).length >= 2 &&
              !board.some((c) => c.rank === card.rank),
            repeatsLowHoleRank: lowHoleRanks.includes(card.rank === 'A' ? 1 : value(card)),
            qualifiesLow: includeLow ? low !== null : null,
            nutLow: includeLow
              ? low !== null &&
                isNutLow(
                  low,
                  available.filter((c) => c !== card),
                  next
                )
              : null,
          };
        })
      : [];
  return {
    version: 'omaha-exact-card-facts-v1' as const,
    lowFactsIncluded: includeLow,
    rankGaps: gaps(distinct),
    aceLowGaps: gaps(lowAce),
    rankSpan: distinct[distinct.length - 1] - distinct[0],
    aceLowSpan: lowAce[lowAce.length - 1] - lowAce[0],
    straightHigh: currentStraight,
    straightFlushHigh,
    opponentStraightFlushHigh,
    nutStraightFlush: straightFlushHigh > 0 && straightFlushHigh >= opponentStraightFlushHigh,
    nutStraight:
      currentStraight > 0 && currentStraight >= possibleStraightHighOfRanks(availableRanks, board),
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
    nutLow: isNutLow(currentLow, available, board),
    counterfeitTransitions: nextCards
      .filter((c) => c.repeatsLowHoleRank)
      .map((c) => ({ card: c.card, nutLowAfter: c.nutLow, qualifiesLowAfter: c.qualifiesLow })),
    nextCards,
    calibratedDominationProbability: null,
  };
}

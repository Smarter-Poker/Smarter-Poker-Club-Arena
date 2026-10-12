/**
 * Shared card geometry for the immutable V2 feature contract. The standalone
 * V1 descriptor is not a selectable runtime dataset version and never
 * reinterprets legacy rank-suit-count-v1 cells.
 * Features describe cards, not equilibrium quality or opponent ranges.
 * Only standard-deck, two-hole-card Hold'em is defined by this version.
 */
export const BOARD_RELATIVE_FEATURE_VERSION = 'holdem-board-relative-v1' as const;

type ParsedCard = { rank: number; suit: string };
export type BoardRelativeFeaturesV1 = {
  version: typeof BOARD_RELATIVE_FEATURE_VERSION;
  street: 3 | 4 | 5;
  /** 0 high card, 1 pair, 2 two pair, 3 trips, 4 straight, 5 flush,
   * 6 full house, 7 quads, 8 straight flush. */
  madeCategory: number;
  boardMultiplicity: number[];
  /** Each hole: distinct board ranks above it, board copies of its rank,
   * and ace flag. Sorted independently of hole order. */
  holeRelations: number[][];
  pocketPair: boolean;
  /** Number of distinct ranks that complete a straight next card; physical
   * unseen-card count separately. Not equity or clean winning outs. */
  straightCompletionRanks: number;
  straightCompletionCards: number;
  /** Suit-relative tuples: board count, hole count, higher unseen ranks above
   * each hole card (nut blocker ordinal), sorted descending hole rank.
   * Tuples sorted lexicographically; literal suit names are not retained. */
  suitRelations: number[][];
  flushCompletionCards: number;
};

function parse(raw: string): ParsedCard {
  if (typeof raw !== 'string' || !/^[2-9TJQKA][cdhs]$/.test(raw)) {
    throw new Error('board-relative-v1 requires canonical standard-deck cards');
  }
  return { rank: '23456789TJQKA'.indexOf(raw[0]) + 2, suit: raw[1] };
}

function straightTop(ranks: Set<number>): number {
  for (let top = 14; top >= 5; top--) {
    const run = top === 5 ? [14, 2, 3, 4, 5] : [top - 4, top - 3, top - 2, top - 1, top];
    if (run.every((rank) => ranks.has(rank))) return top;
  }
  return 0;
}

/** Best-five category without tie-break compression; counts all legal cards. */
function category(cards: ParsedCard[]): number {
  const counts = new Map<number, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  for (const suit of 'cdhs') {
    const suited = cards.filter((card) => card.suit === suit);
    if (suited.length >= 5 && straightTop(new Set(suited.map((card) => card.rank)))) return 8;
  }
  const multiplicities = [...counts.values()].sort((a, b) => b - a);
  if (multiplicities[0] === 4) return 7;
  if (multiplicities[0] >= 3 && multiplicities[1] >= 2) return 6;
  if ([...'cdhs'].some((suit) => cards.filter((card) => card.suit === suit).length >= 5)) return 5;
  if (straightTop(new Set(cards.map((card) => card.rank)))) return 4;
  if (multiplicities[0] === 3) return 3;
  if (multiplicities.filter((count) => count >= 2).length >= 2) return 2;
  return multiplicities[0] === 2 ? 1 : 0;
}

const compareTuple = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? -1) - (b[i] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
};

export function boardRelativeFeaturesV1(
  hole: readonly string[],
  board: readonly string[]
): BoardRelativeFeaturesV1 {
  if (
    !Array.isArray(hole) ||
    !Array.isArray(board) ||
    hole.length !== 2 ||
    ![3, 4, 5].includes(board.length)
  ) {
    throw new Error('board-relative-v1 requires two holes and a flop, turn or river');
  }
  const raw = [...hole, ...board];
  const all = raw.map(parse);
  if (new Set(raw).size !== raw.length)
    throw new Error('board-relative-v1 rejects impossible decks');
  const holes = all.slice(0, 2),
    community = all.slice(2);
  const boardRanks = [...new Set(community.map((card) => card.rank))];
  const boardMultiplicity = boardRanks
    .map((rank) => community.filter((card) => card.rank === rank).length)
    .sort((a, b) => b - a);
  const holeRelations = holes
    .map((card) => [
      boardRanks.filter((rank) => rank > card.rank).length,
      community.filter((other) => other.rank === card.rank).length,
      Number(card.rank === 14),
    ])
    .sort(compareTuple);
  const suitRelations = [...'cdhs']
    .map((suit) => {
      const suitedBoard = community.filter((card) => card.suit === suit);
      const suitedHole = holes.filter((card) => card.suit === suit).sort((a, b) => b.rank - a.rank);
      const unseenAbove = suitedHole.map((card) => {
        let count = 0;
        for (let rank = card.rank + 1; rank <= 14; rank++) {
          if (!all.some((other) => other.rank === rank && other.suit === suit)) count++;
        }
        return count;
      });
      return [suitedBoard.length, suitedHole.length, ...unseenAbove];
    })
    .sort(compareTuple);
  const ranks = new Set(all.map((card) => card.rank));
  let straightCompletionRanks = 0,
    straightCompletionCards = 0,
    flushCompletionCards = 0;
  if (board.length < 5) {
    // A made straight is not described as a straight draw. Flush improvements
    // likewise count only four-card suit holdings, not an existing flush.
    if (!straightTop(ranks)) {
      for (let rank = 2; rank <= 14; rank++) {
        if (!ranks.has(rank) && straightTop(new Set([...ranks, rank]))) {
          straightCompletionRanks++;
          straightCompletionCards += 4 - all.filter((card) => card.rank === rank).length;
        }
      }
    }
    for (const suit of 'cdhs') {
      if (all.filter((card) => card.suit === suit).length === 4) flushCompletionCards += 9;
    }
  }
  return {
    version: BOARD_RELATIVE_FEATURE_VERSION,
    street: board.length as 3 | 4 | 5,
    madeCategory: category(all),
    boardMultiplicity,
    holeRelations,
    pocketPair: holes[0].rank === holes[1].rank,
    straightCompletionRanks,
    straightCompletionCards,
    suitRelations,
    flushCompletionCards,
  };
}

export function boardRelativeFeatureKeyV1(
  hole: readonly string[],
  board: readonly string[]
): string {
  return JSON.stringify(boardRelativeFeaturesV1(hole, board));
}

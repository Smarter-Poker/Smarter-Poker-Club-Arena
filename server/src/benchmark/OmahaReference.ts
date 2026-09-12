/** Independent offline reference. Scoring and settlement share only the Card type with production.
 * No engine scorer, shuffle, pot builder or winner helper supplies an answer. */
import type { Card } from '../types.js';
import { omahaCardFacts } from '../engine/omaha/OmahaCardFacts.js';

export const OMAHA_REFERENCE_VERSION = 'omaha-reference-round1-v1';
export const OMAHA_RULES = {
  plo4: { holes: 4, low: false, betting: 'pot_limit' },
  plo5: { holes: 5, low: false, betting: 'pot_limit' },
  plo6: { holes: 6, low: false, betting: 'pot_limit' },
  plo8: { holes: 4, low: true, betting: 'pot_limit' },
  flo8: { holes: 4, low: true, betting: 'fixed_limit' },
} as const;
export type OmahaVariant = keyof typeof OMAHA_RULES;
const RANKS = '23456789TJQKA';
const SUITS: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
export const referenceDeck = (): Card[] =>
  SUITS.flatMap((suit) => [...RANKS].map((rank) => ({ rank: rank as Card['rank'], suit })));
export function cardKey(c: Card): string {
  if (!c || !RANKS.includes(c.rank) || c.rank.length !== 1 || !SUITS.includes(c.suit))
    throw new Error('Invalid standard-deck card');
  return c.rank + ':' + c.suit;
}
export function uniqueCards(cards: Card[]): void {
  if (new Set(cards.map(cardKey)).size !== cards.length) throw new Error('Duplicate physical card');
}
export function referenceVariant(v: string): (typeof OMAHA_RULES)[OmahaVariant] {
  if (!Object.hasOwn(OMAHA_RULES, v)) throw new Error('Unsupported Omaha variant');
  return OMAHA_RULES[v as OmahaVariant];
}

function fiveScore(cards: Card[]): number {
  const values = cards.map((c) => RANKS.indexOf(c.rank) + 2).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const unique = [...counts.keys()].sort((a, b) => b - a);
  const straight =
    unique.length === 5
      ? unique[0] - unique[4] === 4
        ? unique[0]
        : unique.join(',') === '14,5,4,3,2'
          ? 5
          : 0
      : 0;
  const flush = cards.every((c) => c.suit === cards[0].suit);
  let category = 1,
    kickers = values;
  if (flush && straight) {
    category = straight === 14 ? 10 : 9;
    kickers = [straight];
  } else if (groups[0][1] === 4) {
    category = 8;
    kickers = groups.map(([v]) => v);
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    category = 7;
    kickers = groups.map(([v]) => v);
  } else if (flush) category = 6;
  else if (straight) {
    category = 5;
    kickers = [straight];
  } else if (groups[0][1] === 3) {
    category = 4;
    kickers = groups.map(([v]) => v);
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    category = 3;
    kickers = groups.map(([v]) => v);
  } else if (groups[0][1] === 2) {
    category = 2;
    kickers = groups.map(([v]) => v);
  }
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (kickers[i] ?? 0);
  return score;
}

export interface ReferenceHand {
  high: number;
  category: number;
  highHoleIndices: number[];
  highBoardIndices: number[];
  low: number | null;
  lowRanks: number[] | null;
  lowHoleIndices: number[] | null;
  lowBoardIndices: number[] | null;
}
export function referenceOmaha(hole: Card[], board: Card[]): ReferenceHand {
  if (![4, 5, 6].includes(hole.length) || board.length < 3 || board.length > 5)
    throw new Error('Omaha needs four to six hole cards and three to five board cards');
  uniqueCards([...hole, ...board]);
  const result: ReferenceHand = {
    high: -1,
    category: 0,
    highHoleIndices: [],
    highBoardIndices: [],
    low: null,
    lowRanks: null,
    lowHoleIndices: null,
    lowBoardIndices: null,
  };
  for (let a = 0; a < hole.length - 1; a++)
    for (let b = a + 1; b < hole.length; b++)
      for (let c = 0; c < board.length - 2; c++)
        for (let d = c + 1; d < board.length - 1; d++)
          for (let e = d + 1; e < board.length; e++) {
            const five = [hole[a], hole[b], board[c], board[d], board[e]];
            const high = fiveScore(five);
            if (high > result.high) {
              result.high = high;
              result.category = Math.floor(high / 15 ** 5);
              result.highHoleIndices = [a, b];
              result.highBoardIndices = [c, d, e];
            }
            const lows = five.map((x) => (x.rank === 'A' ? 1 : RANKS.indexOf(x.rank) + 2));
            if (lows.every((v) => v <= 8) && new Set(lows).size === 5) {
              const low = lows.reduce((mask, v) => mask | (1 << v), 0);
              if (result.low === null || low < result.low) {
                result.low = low;
                result.lowRanks = lows.sort((x, y) => y - x);
                result.lowHoleIndices = [a, b];
                result.lowBoardIndices = [c, d, e];
              }
            }
          }
  return result;
}

export interface ReferencePlayer {
  id: string;
  seat: number;
  cards: Card[];
  contributed: number;
  folded?: boolean;
}
export interface ReferencePot {
  amount: number;
  eligible: string[];
}
export function contributionLayers(players: ReferencePlayer[], chipUnit: number) {
  if (![0.01, 1].includes(chipUnit)) throw new Error('Unsupported chip unit');
  if (
    players.length < 2 ||
    players.length > 10 ||
    new Set(players.map((p) => p.id)).size !== players.length ||
    new Set(players.map((p) => p.seat)).size !== players.length
  )
    throw new Error('Invalid player identities');
  const units = players.map((p) => {
    const n = p.contributed / chipUnit;
    if (
      !p.id ||
      !Number.isInteger(p.seat) ||
      p.seat < 1 ||
      p.seat > 10 ||
      !Number.isFinite(n) ||
      n < 0 ||
      n > 1e9 ||
      Math.abs(n - Math.round(n)) > 1e-6
    )
      throw new Error('Invalid contribution geometry');
    return Math.round(n);
  });
  const pots: ReferencePot[] = [];
  const refunds: Record<string, number> = Object.create(null);
  let previous = 0;
  let orphaned = 0;
  for (const level of [...new Set(units)].filter((n) => n > 0).sort((a, b) => a - b)) {
    const members = players.filter((_, i) => units[i] >= level);
    const amount = (level - previous) * members.length * chipUnit;
    previous = level;
    if (members.length === 1) {
      if (members[0].folded) {
        orphaned += amount;
        continue;
      }
      refunds[members[0].id] = amount;
      continue;
    }
    const eligible = members.filter((p) => !p.folded).map((p) => p.id);
    if (!eligible.length) {
      orphaned += amount;
      continue;
    }
    // Layers with identical rights are one contest before board/odd-chip allocation.
    const same = pots.find(
      (p) =>
        p.eligible.length === eligible.length && p.eligible.every((id) => eligible.includes(id))
    );
    if (same) same.amount += amount;
    else pots.push({ amount, eligible });
  }
  if (orphaned > 0) {
    if (pots.length) pots[0].amount += orphaned;
    else {
      const eligible = players.filter((p) => !p.folded).map((p) => p.id);
      if (!eligible.length) throw new Error('Pot has no eligible contender');
      pots.push({ amount: orphaned, eligible });
    }
  }
  return { pots, refunds };
}

/** Repeated cards are allowed only in an explicitly shared prefix of all boards. */
export function physicalBoardCards(boards: Card[][], sharedPrefixLength = 0): Card[] {
  if (
    !Array.isArray(boards) ||
    boards.length < 1 ||
    boards.length > 3 ||
    !Number.isInteger(sharedPrefixLength) ||
    sharedPrefixLength < 0 ||
    sharedPrefixLength > 5 ||
    boards.some((b) => b.length < sharedPrefixLength || b.length > 5)
  )
    throw new Error('Invalid board allocation');
  const prefix = boards[0].slice(0, sharedPrefixLength).map(cardKey);
  for (const b of boards)
    if (b.slice(0, sharedPrefixLength).map(cardKey).join('|') !== prefix.join('|'))
      throw new Error('Shared board prefix differs');
  const cards = [...boards[0], ...boards.slice(1).flatMap((b) => b.slice(sharedPrefixLength))];
  uniqueCards(cards);
  return cards;
}
export interface ReferenceAward {
  playerId: string;
  potIndex: number;
  boardIndex: number;
  half: 'high' | 'low';
  amount: number;
}
export function settleOmahaReference(input: {
  variant: OmahaVariant;
  players: ReferencePlayer[];
  boards: Card[][];
  sharedPrefixLength?: number;
  chipUnit: 0.01 | 1;
  dealerSeat: number;
}) {
  const rules = referenceVariant(input.variant);
  const boardCards = physicalBoardCards(input.boards, input.sharedPrefixLength);
  if (
    input.boards.some((b) => b.length !== 5) ||
    !Number.isInteger(input.dealerSeat) ||
    input.dealerSeat < 0 ||
    input.dealerSeat > 10
  )
    throw new Error('Settlement needs complete boards and a valid button');
  if (input.players.some((p) => p.cards.length !== rules.holes))
    throw new Error('Variant hole-card count mismatch');
  uniqueCards([...boardCards, ...input.players.flatMap((p) => p.cards)]);
  const { pots, refunds } = contributionLayers(input.players, input.chipUnit);
  const scores = input.boards.map(
    (board) =>
      new Map(
        input.players.filter((p) => !p.folded).map((p) => [p.id, referenceOmaha(p.cards, board)])
      )
  );
  const awards: ReferenceAward[] = [];
  const totals = Object.fromEntries(input.players.map((p) => [p.id, 0]));
  function award(
    ids: string[],
    units: number,
    potIndex: number,
    boardIndex: number,
    half: 'high' | 'low'
  ) {
    const order = input.players
      .filter((p) => ids.includes(p.id))
      .sort(
        (a, b) =>
          Number(a.seat <= input.dealerSeat) - Number(b.seat <= input.dealerSeat) || a.seat - b.seat
      );
    if (!order.length) throw new Error('Empty winner set');
    order.forEach((p, i) => {
      const amount =
        (Math.floor(units / order.length) + Number(i < units % order.length)) * input.chipUnit;
      if (amount > 0) awards.push({ playerId: p.id, potIndex, boardIndex, half, amount });
      totals[p.id] += amount;
    });
  }
  pots.forEach((pot, potIndex) => {
    const units = Math.round(pot.amount / input.chipUnit);
    input.boards.forEach((_, boardIndex) => {
      const boardUnits =
        Math.floor(units / input.boards.length) + Number(boardIndex < units % input.boards.length);
      const eligible = pot.eligible.map((id) => ({ id, hand: scores[boardIndex].get(id)! }));
      const low = rules.low ? eligible.filter((p) => p.hand.low !== null) : [];
      const lowUnits = low.length ? Math.floor(boardUnits / 2) : 0;
      const bestHigh = Math.max(...eligible.map((p) => p.hand.high));
      award(
        eligible.filter((p) => p.hand.high === bestHigh).map((p) => p.id),
        boardUnits - lowUnits,
        potIndex,
        boardIndex,
        'high'
      );
      if (lowUnits) {
        const bestLow = Math.min(...low.map((p) => p.hand.low!));
        award(
          low.filter((p) => p.hand.low === bestLow).map((p) => p.id),
          lowUnits,
          potIndex,
          boardIndex,
          'low'
        );
      }
    });
  });
  const contributed = input.players.reduce((s, p) => s + p.contributed, 0);
  const distributed = [...Object.values(totals), ...Object.values(refunds)].reduce(
    (s, n) => s + n,
    0
  );
  if (Math.abs(contributed - distributed) > input.chipUnit / 1e4)
    throw new Error('Reference failed chip conservation');
  return {
    version: OMAHA_REFERENCE_VERSION,
    pots,
    refunds,
    awards,
    totals,
    contributed,
    distributed,
  };
}

/** Caller supplies the betting pot including any declared nominal blind adjustment. */
export function referencePotLimitRaiseTo(
  pot: number,
  currentBet: number,
  playerBet: number,
  stack: number
): number {
  if (
    ![pot, currentBet, playerBet, stack].every((n) => Number.isFinite(n) && n >= 0) ||
    playerBet > currentBet
  )
    throw new Error('Invalid pot-limit geometry');
  const call = Math.max(0, currentBet - playerBet);
  return Math.min(playerBet + stack, currentBet + pot + call);
}

export function omahaHandComponents(hole: Card[], board: Card[]) {
  const hand = referenceOmaha(hole, board);
  const lowRanks = [
    ...new Set(
      hole.map((c) => (c.rank === 'A' ? 1 : RANKS.indexOf(c.rank) + 2)).filter((v) => v <= 8)
    ),
  ].sort((a, b) => a - b);
  const counts = Object.fromEntries(SUITS.map((s) => [s, hole.filter((c) => c.suit === s).length]));
  const pairedRanks = [
    ...new Set(
      hole.filter((c, i) => hole.some((d, j) => i !== j && c.rank === d.rank)).map((c) => c.rank)
    ),
  ];
  return {
    hand,
    suitCounts: counts,
    nutSuitedAces: hole.filter((c) => c.rank === 'A' && counts[c.suit] >= 2).map((c) => c.suit),
    pairedRanks,
    lowHoleRanksRepeatedOnBoard: lowRanks.filter((v) =>
      board.some((c) => (c.rank === 'A' ? 1 : RANKS.indexOf(c.rank) + 2) === v)
    ),
    boardPaired: new Set(board.map((c) => c.rank)).size !== board.length,
    ...omahaCardFacts(hole, board),
  };
}

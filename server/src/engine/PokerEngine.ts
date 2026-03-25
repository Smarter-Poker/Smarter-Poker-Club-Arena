/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * POKER ENGINE CORE — Server-Side
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pure poker logic: Deck, hand evaluation, pot calculation, betting validation.
 * ZERO browser dependencies. Runs on Node.js.
 */

import type {
  Card,
  CardRank,
  CardSuit,
  HandStage,
  SeatPlayer,
  ActionType,
  EvaluatedHand,
  Pot,
  BettingState,
  RakeConfig,
  Winner,
} from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

export const SUITS: CardSuit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
export const RANKS: CardRank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

export const RANK_VALUES: Record<CardRank, number> = {
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

export const HAND_RANKINGS = {
  HIGH_CARD: 1,
  PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
  ROYAL_FLUSH: 10,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// DECK — Cryptographically-aware Fisher-Yates Shuffle
// ═══════════════════════════════════════════════════════════════════════════════

export class Deck {
  private cards: Card[] = [];

  constructor() {
    this.reset();
  }

  reset(): void {
    this.cards = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        this.cards.push({ rank, suit });
      }
    }
    this.shuffle();
  }

  shuffle(): void {
    // Fisher-Yates shuffle using crypto.getRandomValues for server-side security
    const array = new Uint32Array(this.cards.length);
    crypto.getRandomValues(array);
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = array[i] % (i + 1);
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  deal(count: number = 1): Card[] {
    if (this.cards.length < count) {
      throw new Error('Not enough cards in deck');
    }
    return this.cards.splice(0, count);
  }

  dealOne(): Card {
    return this.deal(1)[0];
  }

  remaining(): number {
    return this.cards.length;
  }

  removeCardsBelow(minRank: CardRank): void {
    const minValue = RANK_VALUES[minRank];
    this.cards = this.cards.filter((c) => RANK_VALUES[c.rank] >= minValue);
    this.shuffle();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CARD UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

export function cardToString(card: Card): string {
  const suitSymbols: Record<CardSuit, string> = {
    hearts: '\u2665',
    diamonds: '\u2666',
    clubs: '\u2663',
    spades: '\u2660',
  };
  return `${card.rank}${suitSymbols[card.suit]}`;
}

export function cardsToString(cards: Card[]): string {
  return cards.map(cardToString).join(' ');
}

// ═══════════════════════════════════════════════════════════════════════════════
// HAND EVALUATOR
// ═══════════════════════════════════════════════════════════════════════════════

export function evaluateHand(holeCards: Card[], communityCards: Card[]): EvaluatedHand {
  const allCards = [...holeCards, ...communityCards];

  if (allCards.length < 5) {
    return { ranking: 0, name: 'No Hand', cards: allCards, kickers: [] };
  }

  const combinations = getCombinations(allCards, 5);
  let bestHand: EvaluatedHand | null = null;

  for (const combo of combinations) {
    const evaluated = evaluate5Cards(combo);
    if (!bestHand || compareHands(evaluated, bestHand) > 0) {
      bestHand = evaluated;
    }
  }

  if (!bestHand) {
    return { ranking: 0, name: 'No Hand', cards: allCards.slice(0, 5), kickers: [] };
  }

  return bestHand;
}

function evaluate5Cards(cards: Card[]): EvaluatedHand {
  const sorted = [...cards].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
  const isFlush = cards.every((c) => c.suit === cards[0].suit);
  const ranks = sorted.map((c) => RANK_VALUES[c.rank]);
  const isStraight = checkStraight(ranks);
  const isWheel = ranks[0] === 14 && ranks[1] === 5;

  const rankCounts = new Map<number, number>();
  for (const r of ranks) {
    rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
  }
  const counts = [...rankCounts.values()].sort((a, b) => b - a);

  if (isFlush && isStraight) {
    if (ranks[0] === 14 && ranks[1] === 13 && !isWheel) {
      return {
        ranking: HAND_RANKINGS.ROYAL_FLUSH,
        name: 'Royal Flush',
        cards: sorted,
        kickers: ranks,
      };
    }
    return {
      ranking: HAND_RANKINGS.STRAIGHT_FLUSH,
      name: 'Straight Flush',
      cards: sorted,
      kickers: isWheel ? [5, 4, 3, 2, 1] : ranks,
    };
  }
  if (counts[0] === 4)
    return {
      ranking: HAND_RANKINGS.FOUR_OF_A_KIND,
      name: 'Four of a Kind',
      cards: sorted,
      kickers: getKickers(rankCounts),
    };
  if (counts[0] === 3 && counts[1] === 2)
    return {
      ranking: HAND_RANKINGS.FULL_HOUSE,
      name: 'Full House',
      cards: sorted,
      kickers: getKickers(rankCounts),
    };
  if (isFlush)
    return { ranking: HAND_RANKINGS.FLUSH, name: 'Flush', cards: sorted, kickers: ranks };
  if (isStraight)
    return {
      ranking: HAND_RANKINGS.STRAIGHT,
      name: 'Straight',
      cards: sorted,
      kickers: isWheel ? [5, 4, 3, 2, 1] : ranks,
    };
  if (counts[0] === 3)
    return {
      ranking: HAND_RANKINGS.THREE_OF_A_KIND,
      name: 'Three of a Kind',
      cards: sorted,
      kickers: getKickers(rankCounts),
    };
  if (counts[0] === 2 && counts[1] === 2)
    return {
      ranking: HAND_RANKINGS.TWO_PAIR,
      name: 'Two Pair',
      cards: sorted,
      kickers: getKickers(rankCounts),
    };
  if (counts[0] === 2)
    return {
      ranking: HAND_RANKINGS.PAIR,
      name: 'Pair',
      cards: sorted,
      kickers: getKickers(rankCounts),
    };
  return { ranking: HAND_RANKINGS.HIGH_CARD, name: 'High Card', cards: sorted, kickers: ranks };
}

function checkStraight(ranks: number[]): boolean {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.length < 5) return false;
  for (let i = 0; i <= unique.length - 5; i++) {
    if (unique[i] - unique[i + 4] === 4) return true;
  }
  // Wheel (A-2-3-4-5)
  if (
    unique.includes(14) &&
    unique.includes(5) &&
    unique.includes(4) &&
    unique.includes(3) &&
    unique.includes(2)
  ) {
    return true;
  }
  return false;
}

function getKickers(counts: Map<number, number>): number[] {
  const kickers: number[] = [];
  const sorted = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });
  for (const [rank, count] of sorted) {
    for (let i = 0; i < count; i++) {
      kickers.push(rank);
    }
  }
  return kickers.slice(0, 5);
}

function getCombinations<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  function combine(start: number, combo: T[]): void {
    if (combo.length === size) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i <= arr.length - (size - combo.length); i++) {
      combo.push(arr[i]);
      combine(i + 1, combo);
      combo.pop();
    }
  }
  combine(0, []);
  return result;
}

export function compareHands(a: EvaluatedHand, b: EvaluatedHand): number {
  if (a.ranking !== b.ranking) return a.ranking - b.ranking;
  const maxLen = Math.max(a.kickers.length, b.kickers.length);
  for (let i = 0; i < maxLen; i++) {
    const aVal = a.kickers[i] ?? 0;
    const bVal = b.kickers[i] ?? 0;
    if (aVal !== bVal) return aVal - bVal;
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OMAHA HAND EVALUATOR
// ═══════════════════════════════════════════════════════════════════════════════

export function evaluateOmahaHand(holeCards: Card[], communityCards: Card[]): EvaluatedHand {
  if (holeCards.length < 4) {
    if (holeCards.length >= 2 && communityCards.length >= 3) {
      return evaluateHand(holeCards.slice(0, 2), communityCards.slice(0, 5));
    }
    return { ranking: 1, name: 'High Card', cards: [...holeCards, ...communityCards], kickers: [] };
  }

  const holeCombos = getCombinations(holeCards, 2);
  const boardCombos = getCombinations(communityCards, 3);
  let bestHand: EvaluatedHand | null = null;

  for (const hole of holeCombos) {
    for (const board of boardCombos) {
      const fiveCards = [...hole, ...board];
      const evaluated = evaluate5Cards(fiveCards);
      if (!bestHand || compareHands(evaluated, bestHand) > 0) {
        bestHand = evaluated;
      }
    }
  }

  if (!bestHand) {
    return { ranking: 0, name: 'No Hand', cards: [...holeCards, ...communityCards], kickers: [] };
  }
  return bestHand;
}

export function evaluateOmahaLowHand(
  holeCards: Card[],
  communityCards: Card[]
): EvaluatedHand | null {
  if (holeCards.length < 4) return null;

  const holeCombos = getCombinations(holeCards, 2);
  const boardCombos = getCombinations(communityCards, 3);
  let bestLow: EvaluatedHand | null = null;
  let bestLowRanks: number[] = [];

  for (const hole of holeCombos) {
    for (const board of boardCombos) {
      const fiveCards = [...hole, ...board];
      const ranks = fiveCards.map((c) => (c.rank === 'A' ? 1 : RANK_VALUES[c.rank]));
      const uniqueRanks = new Set(ranks);
      if (uniqueRanks.size !== 5) continue;
      if (Math.max(...ranks) > 8) continue;
      const sortedRanks = [...ranks].sort((a, b) => b - a);
      if (!bestLow || compareLowHands(sortedRanks, bestLowRanks) < 0) {
        bestLow = {
          ranking: 0,
          name: `Low: ${sortedRanks.join('-')}`,
          cards: fiveCards,
          kickers: sortedRanks,
        };
        bestLowRanks = sortedRanks;
      }
    }
  }
  return bestLow;
}

function compareLowHands(a: number[], b: number[]): number {
  for (let i = 0; i < 5; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POT CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function calculatePots(players: SeatPlayer[]): Pot[] {
  const activePlayers = players.filter((p) => !p.is_folded);
  if (activePlayers.length === 0) return [];

  const getInvestment = (p: SeatPlayer) => p.totalInvested ?? p.bet ?? 0;
  const allContributors = players.filter((p) => getInvestment(p) > 0);
  if (allContributors.length === 0) return [];

  const sortedInvestments = [...new Set(allContributors.map((p) => getInvestment(p)))].sort(
    (a, b) => a - b
  );
  const pots: Pot[] = [];
  let previousLevel = 0;

  for (const level of sortedInvestments) {
    if (level === 0) continue;
    const contribution = level - previousLevel;
    const totalContributors = allContributors.filter((p) => getInvestment(p) >= level).length;
    const eligiblePlayers = activePlayers.filter((p) => getInvestment(p) >= level);

    if (totalContributors > 0 && eligiblePlayers.length > 0) {
      pots.push({
        amount: contribution * totalContributors,
        eligiblePlayers: eligiblePlayers.map((p) => p.user_id),
      });
    }
    previousLevel = level;
  }

  // Merge pots with identical eligible players
  if (pots.length === 0) return [];
  const merged: Pot[] = [pots[0]];
  for (let i = 1; i < pots.length; i++) {
    const last = merged[merged.length - 1];
    if (JSON.stringify(last.eligiblePlayers) === JSON.stringify(pots[i].eligiblePlayers)) {
      last.amount += pots[i].amount;
    } else {
      merged.push(pots[i]);
    }
  }
  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BETTING LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

export function calculateBettingState(
  pot: number,
  currentBet: number,
  playerBet: number,
  bigBlind: number,
  lastRaise: number = 0,
  isPotLimit: boolean = false
): BettingState {
  const toCall = currentBet - playerBet;
  // Bible V8 §4.14: pot-limit max raise = current pot + call amount
  const maxRaise = isPotLimit ? pot + toCall + toCall : undefined;
  return {
    currentBet,
    minRaise: Math.max(bigBlind, lastRaise || bigBlind),
    pot,
    toCall,
    maxRaise,
  };
}

export function validateAction(
  action: ActionType,
  amount: number | undefined,
  playerStack: number,
  bettingState: BettingState
): { valid: boolean; error?: string } {
  const { currentBet, minRaise, toCall } = bettingState;

  switch (action) {
    case 'fold':
      return { valid: true };
    case 'check':
      if (toCall > 0) return { valid: false, error: 'Cannot check when there is a bet to call' };
      return { valid: true };
    case 'call':
      if (toCall === 0) return { valid: false, error: 'Nothing to call' };
      return { valid: true };
    case 'bet':
      if (currentBet > 0)
        return { valid: false, error: 'Cannot bet when there is already a bet (use raise)' };
      if (!amount || amount < minRaise)
        return { valid: false, error: `Minimum bet is ${minRaise}` };
      if (amount > playerStack) return { valid: false, error: 'Insufficient chips' };
      // Bible V8 §4.14: Pot-limit max bet
      if (bettingState.maxRaise !== undefined && amount > bettingState.maxRaise) {
        return { valid: false, error: `Pot-limit max bet is ${bettingState.maxRaise}` };
      }
      return { valid: true };
    case 'raise': {
      if (currentBet === 0)
        return { valid: false, error: 'Cannot raise when there is no bet (use bet)' };
      if (!amount) return { valid: false, error: 'Raise amount required' };
      const playerBet = currentBet - toCall;
      const maxRaiseTo = playerBet + playerStack;
      const raiseAmount = amount - currentBet;
      if (raiseAmount < minRaise && amount < maxRaiseTo) {
        return { valid: false, error: `Minimum raise is ${minRaise}` };
      }
      if (amount > maxRaiseTo) return { valid: false, error: 'Insufficient chips' };
      // Bible V8 §4.14: Pot-limit max raise = pot + call + call
      if (bettingState.maxRaise !== undefined && raiseAmount > bettingState.maxRaise) {
        return { valid: false, error: `Pot-limit max raise is ${bettingState.maxRaise}` };
      }
      return { valid: true };
    }
    case 'all_in':
      return { valid: true };
    default:
      return { valid: false, error: 'Invalid action' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAKE CALCULATION — Exact penny, NO rounding
// ═══════════════════════════════════════════════════════════════════════════════

export function calculateRake(
  pot: number,
  sawFlop: boolean,
  config: RakeConfig,
  playerCount?: number
): number {
  if (config.noFlopNoDrop && !sawFlop) return 0;
  // Exact cent precision — no floating-point drift
  const rake = Math.trunc(pot * config.percent) / 100;
  // Bible V8 §2.9: Use player-count-based cap if available, otherwise flat cap
  let cap = config.cap;
  if (config.playerCountCaps && config.playerCountCaps.length > 0 && playerCount !== undefined) {
    // Find the cap tier for current player count (highest tier that <= playerCount)
    const sorted = [...config.playerCountCaps].sort((a, b) => b.players - a.players);
    const tier = sorted.find((t) => playerCount >= t.players);
    if (tier) cap = tier.cap;
  }
  return Math.min(rake, cap);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WINNER DETERMINATION
// ═══════════════════════════════════════════════════════════════════════════════

export function determineWinners(
  players: SeatPlayer[],
  communityCards: Card[],
  pots: Pot[],
  gameVariant: string = 'nlh'
): Winner[] {
  const winners: Winner[] = [];
  const activePlayers = players.filter((p) => !p.is_folded);

  if (activePlayers.length === 1) {
    const totalPot = pots.reduce((sum, p) => sum + p.amount, 0);
    return [{ userId: activePlayers[0].user_id, amount: totalPot, potIndex: 0 }];
  }

  const isOmaha = gameVariant.startsWith('plo');
  // Bible V8 §7.6: Both plo8 and plo_hilo use hi-lo split evaluation
  const isHiLo =
    isOmaha &&
    (gameVariant === 'plo8' || gameVariant === 'plo_hilo' || gameVariant.includes('hilo'));
  const evaluator = isOmaha ? evaluateOmahaHand : evaluateHand;

  const playerHands = activePlayers.map((p) => ({
    player: p,
    hand: evaluator(p.cards, communityCards),
    lowHand: isHiLo ? evaluateOmahaLowHand(p.cards, communityCards) : null,
  }));

  for (let potIdx = 0; potIdx < pots.length; potIdx++) {
    const pot = pots[potIdx];
    const eligible = playerHands.filter((ph) => pot.eligiblePlayers.includes(ph.player.user_id));
    if (eligible.length === 0) continue;

    let hiPotAmount = pot.amount;
    let loPotAmount = 0;

    const qualifyingLowPlayers = eligible.filter((ph) => ph.lowHand !== null);
    if (isHiLo && qualifyingLowPlayers.length > 0) {
      const potCents = Math.trunc(pot.amount * 100);
      const loCents = Math.trunc(potCents / 2);
      loPotAmount = loCents / 100;
      hiPotAmount = (potCents - loCents) / 100;
    }

    // High half
    eligible.sort((a, b) => compareHands(b.hand, a.hand));
    const bestHiRanking = eligible[0].hand.ranking;
    const bestHiKickers = eligible[0].hand.kickers;
    const hiWinners = eligible.filter(
      (ph) =>
        ph.hand.ranking === bestHiRanking &&
        JSON.stringify(ph.hand.kickers) === JSON.stringify(bestHiKickers)
    );
    // Bible V8 §2.7: Pass potIndex so Winner objects know which pot they won from
    distributePot(winners, hiWinners, hiPotAmount, 'High', potIdx);

    // Low half
    if (loPotAmount > 0) {
      qualifyingLowPlayers.sort((a, b) => compareLowHands(a.lowHand!.kickers, b.lowHand!.kickers));
      const bestLoKickers = qualifyingLowPlayers[0].lowHand!.kickers;
      const loWinners = qualifyingLowPlayers.filter(
        (ph) => JSON.stringify(ph.lowHand!.kickers) === JSON.stringify(bestLoKickers)
      );
      distributePot(winners, loWinners, loPotAmount, 'Low', potIdx);
    }
  }

  return winners;
}

function distributePot(
  globalWinners: Winner[],
  roundWinners: { player: SeatPlayer; hand: EvaluatedHand; lowHand?: EvaluatedHand | null }[],
  amount: number,
  _type: 'High' | 'Low',
  potIndex: number = 0
): void {
  const totalCents = Math.trunc(amount * 100);
  const shareCents = Math.trunc(totalCents / roundWinners.length);
  const remainderCents = totalCents % roundWinners.length;

  // Sort winners by seat position (lowest seat first = closest to left of dealer)
  const sortedWinners = [...roundWinners].sort((a, b) => a.player.seat - b.player.seat);

  sortedWinners.forEach((pw, i) => {
    const existing = globalWinners.find((w) => w.userId === pw.player.user_id);
    const winAmt = (shareCents + (i < remainderCents ? 1 : 0)) / 100;
    if (existing) {
      existing.amount += winAmt;
    } else {
      globalWinners.push({ userId: pw.player.user_id, amount: winAmt, hand: pw.hand, potIndex });
    }
  });
}

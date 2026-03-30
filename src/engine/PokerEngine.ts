/**
 * ♠ CLUB ARENA — Poker Engine Core
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shared poker logic between Diamond Arena and Club Arena
 * Hand evaluation, dealing, pot management
 */

import type {
  Card,
  CardRank,
  CardSuit,
  SeatPlayer,
  ActionType,
  GameVariant,
} from '../types/database.types';
import { secureShuffle } from './CryptoRandom';
import { reportError } from '../utils/errorReporter';

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
// DECK
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
    // Fisher-Yates shuffle with cryptographically secure random
    secureShuffle(this.cards);
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

  // For Short Deck (6+)
  removeCardsBelow(minRank: CardRank): void {
    const minValue = RANK_VALUES[minRank];
    this.cards = this.cards.filter((c) => RANK_VALUES[c.rank] >= minValue);
    this.shuffle();
  }

  // Used by Run It Twice to peek at remaining cards
  getCards(): Card[] {
    return [...this.cards];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CARD UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

export function cardToString(card: Card): string {
  const suitSymbols: Record<CardSuit, string> = {
    hearts: '♥',
    diamonds: '♦',
    clubs: '♣',
    spades: '♠',
  };
  return `${card.rank}${suitSymbols[card.suit]}`;
}

export function cardsToString(cards: Card[]): string {
  return cards.map(cardToString).join(' ');
}

export function parseCard(str: string): Card {
  const rank = str[0] as CardRank;
  const suitChar = str[1].toLowerCase();
  const suitMap: Record<string, CardSuit> = {
    h: 'hearts',
    '♥': 'hearts',
    d: 'diamonds',
    '♦': 'diamonds',
    c: 'clubs',
    '♣': 'clubs',
    s: 'spades',
    '♠': 'spades',
  };
  return { rank, suit: suitMap[suitChar] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HAND EVALUATOR (Performance Optimized)
// ═══════════════════════════════════════════════════════════════════════════════

export interface EvaluatedHand {
  ranking: number;
  name: string;
  cards: Card[]; // Best 5 cards
  kickers: number[];
}

// ── LRU Evaluation Cache ──
// Caches recent hand evaluations to avoid redundant computation,
// especially beneficial for Monte Carlo equity simulations.

class EvalLRUCache {
  private cache: Map<string, EvaluatedHand> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 4096) {
    this.maxSize = maxSize;
  }

  get(key: string): EvaluatedHand | undefined {
    const val = this.cache.get(key);
    if (val) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, val);
    }
    return val;
  }

  set(key: string, value: EvaluatedHand): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

const evalCache = new EvalLRUCache(4096);

/** Generate a canonical cache key from cards */
function cardKey(cards: Card[]): string {
  return cards
    .map((c) => `${c.rank}${c.suit[0]}`)
    .sort()
    .join(',');
}

/** Clear the evaluation cache (call when testing or resetting) */
export function clearEvalCache(): void {
  evalCache.clear();
}

export function evaluateHand(holeCards: Card[], communityCards: Card[]): EvaluatedHand {
  const allCards = [...holeCards, ...communityCards];

  // Guard: need at least 5 cards to evaluate a hand
  if (allCards.length < 5) {
    return {
      ranking: 0, // High card (worst possible)
      name: 'No Hand',
      cards: allCards,
      kickers: [],
    };
  }

  // ── Cache lookup ──
  const cacheKey = cardKey(allCards);
  const cached = evalCache.get(cacheKey);
  if (cached) return cached;

  // Generate all 5-card combinations
  const combinations = getCombinations(allCards, 5);

  let bestHand: EvaluatedHand | null = null;

  for (const combo of combinations) {
    const evaluated = evaluate5Cards(combo);
    if (!bestHand || compareHands(evaluated, bestHand) > 0) {
      bestHand = evaluated;
    }
  }

  // Safety: should never be null if we have 5+ cards, but handle gracefully
  if (!bestHand) {
    return {
      ranking: 0,
      name: 'No Hand',
      cards: allCards.slice(0, 5),
      kickers: [],
    };
  }

  // ── Cache result ──
  evalCache.set(cacheKey, bestHand);

  return bestHand;
}

function evaluate5Cards(cards: Card[]): EvaluatedHand {
  const sorted = [...cards].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);

  const isFlush = cards.every((c) => c.suit === cards[0].suit);
  const ranks = sorted.map((c) => RANK_VALUES[c.rank]);

  // Check for straight (including A-2-3-4-5 wheel)
  const isStraight = checkStraight(ranks);
  const isWheel = ranks[0] === 14 && ranks[1] === 5; // A-5 low straight

  // Count rank occurrences
  const rankCounts = new Map<number, number>();
  for (const r of ranks) {
    rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
  }
  const counts = [...rankCounts.values()].sort((a, b) => b - a);

  // Determine hand ranking
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

  if (counts[0] === 4) {
    return {
      ranking: HAND_RANKINGS.FOUR_OF_A_KIND,
      name: 'Four of a Kind',
      cards: sorted,
      kickers: getKickers(rankCounts, 4),
    };
  }

  if (counts[0] === 3 && counts[1] === 2) {
    return {
      ranking: HAND_RANKINGS.FULL_HOUSE,
      name: 'Full House',
      cards: sorted,
      kickers: getKickers(rankCounts, 3, 2),
    };
  }

  if (isFlush) {
    return { ranking: HAND_RANKINGS.FLUSH, name: 'Flush', cards: sorted, kickers: ranks };
  }

  if (isStraight) {
    return {
      ranking: HAND_RANKINGS.STRAIGHT,
      name: 'Straight',
      cards: sorted,
      kickers: isWheel ? [5, 4, 3, 2, 1] : ranks,
    };
  }

  if (counts[0] === 3) {
    return {
      ranking: HAND_RANKINGS.THREE_OF_A_KIND,
      name: 'Three of a Kind',
      cards: sorted,
      kickers: getKickers(rankCounts, 3),
    };
  }

  if (counts[0] === 2 && counts[1] === 2) {
    return {
      ranking: HAND_RANKINGS.TWO_PAIR,
      name: 'Two Pair',
      cards: sorted,
      kickers: getKickers(rankCounts, 2, 2),
    };
  }

  if (counts[0] === 2) {
    return {
      ranking: HAND_RANKINGS.PAIR,
      name: 'Pair',
      cards: sorted,
      kickers: getKickers(rankCounts, 2),
    };
  }

  return { ranking: HAND_RANKINGS.HIGH_CARD, name: 'High Card', cards: sorted, kickers: ranks };
}

function checkStraight(ranks: number[]): boolean {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.length < 5) return false;

  // Regular straight
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

function getKickers(counts: Map<number, number>, ..._targetCounts: number[]): number[] {
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
  if (a.ranking !== b.ranking) {
    return a.ranking - b.ranking;
  }

  // Compare kickers — use max length to handle mismatched arrays
  const maxLen = Math.max(a.kickers.length, b.kickers.length);
  for (let i = 0; i < maxLen; i++) {
    const aVal = a.kickers[i] ?? 0;
    const bVal = b.kickers[i] ?? 0;
    if (aVal !== bVal) {
      return aVal - bVal;
    }
  }

  return 0; // Tie
}

// ═══════════════════════════════════════════════════════════════════════════════
// OMAHA HAND EVALUATOR
// ═══════════════════════════════════════════════════════════════════════════════

export function evaluateOmahaHand(holeCards: Card[], communityCards: Card[]): EvaluatedHand {
  if (holeCards.length < 4) {
    // Graceful fallback: if fewer than 4 hole cards (edge case from mid-hand join
    // or card dealing glitch), use standard evaluator with available cards
    reportError(new Error(`[PokerEngine] evaluateOmahaHand called with ${holeCards.length} hole cards — using fallback`), 'PokerEngine.evaluateOmahaHand_called_with_holeCardsl');
    if (holeCards.length >= 2 && communityCards.length >= 3) {
      return evaluateHand(holeCards.slice(0, 2), communityCards.slice(0, 5));
    }
    return {
      ranking: 1,
      name: 'High Card',
      cards: [...holeCards, ...communityCards],
      kickers: [],
    } as EvaluatedHand;
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

  // Guard: if no combos produced a hand (e.g., < 3 community cards), return a fallback
  if (!bestHand) {
    return {
      ranking: 0,
      name: 'No Hand',
      cards: [...holeCards, ...communityCards],
      kickers: [],
    } as EvaluatedHand;
  }
  return bestHand;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OMAHA HI/LO (PLO8) EVALUATOR
// ═══════════════════════════════════════════════════════════════════════════════

export function evaluateOmahaLowHand(
  holeCards: Card[],
  communityCards: Card[]
): EvaluatedHand | null {
  if (holeCards.length < 4) {
    reportError(new Error(`[PokerEngine] evaluateOmahaLowHand called with ${holeCards.length} hole cards — skipping`), 'PokerEngine.evaluateOmahaLowHand_called_with_holeCar');
    return null;
  }

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

export interface Pot {
  amount: number;
  eligiblePlayers: string[]; // user_ids
}

export function calculatePots(players: SeatPlayer[]): Pot[] {
  const activePlayers = players.filter((p) => !p.is_folded);
  if (activePlayers.length === 0) return [];

  // Use totalInvested (cumulative across all streets) — falls back to bet for backwards compat
  const getInvestment = (p: SeatPlayer) => p.totalInvested ?? p.bet ?? 0;

  // All players who contributed chips (including folded ones)
  const allContributors = players.filter((p) => getInvestment(p) > 0);
  if (allContributors.length === 0) return [];

  // Get unique investment levels from ALL players who put chips in (including folded)
  const sortedInvestments = [...new Set(allContributors.map((p) => getInvestment(p)))].sort(
    (a, b) => a - b
  );

  const pots: Pot[] = [];
  let previousLevel = 0;

  for (const level of sortedInvestments) {
    if (level === 0) continue;

    const contribution = level - previousLevel;
    // Count ALL players (including folded) who put in at least this much
    const totalContributors = allContributors.filter((p) => getInvestment(p) >= level).length;
    // Only active (non-folded) players are eligible to win
    const eligiblePlayers = activePlayers.filter((p) => getInvestment(p) >= level);

    if (totalContributors > 0 && eligiblePlayers.length > 0) {
      pots.push({
        amount: contribution * totalContributors,
        eligiblePlayers: eligiblePlayers.map((p) => p.user_id),
      });
    }

    previousLevel = level;
  }

  // Combine pots with identical eligible players
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

export interface BettingState {
  currentBet: number;
  minRaise: number;
  pot: number;
  toCall: number;
}

export function calculateBettingState(
  pot: number,
  currentBet: number,
  playerBet: number,
  bigBlind: number,
  lastRaise: number = 0
): BettingState {
  const toCall = currentBet - playerBet;
  const minRaise = Math.max(bigBlind, lastRaise || bigBlind);

  return {
    currentBet,
    minRaise,
    pot,
    toCall,
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
      if (toCall > 0) {
        return { valid: false, error: 'Cannot check when there is a bet to call' };
      }
      return { valid: true };

    case 'call':
      if (toCall === 0) {
        return { valid: false, error: 'Nothing to call' };
      }
      return { valid: true };

    case 'bet':
      if (currentBet > 0) {
        return { valid: false, error: 'Cannot bet when there is already a bet (use raise)' };
      }
      if (!amount || amount < minRaise) {
        return { valid: false, error: `Minimum bet is ${minRaise}` };
      }
      if (amount > playerStack) {
        return { valid: false, error: 'Insufficient chips' };
      }
      return { valid: true };

    case 'raise': {
      if (currentBet === 0) {
        return { valid: false, error: 'Cannot raise when there is no bet (use bet)' };
      }
      if (!amount) {
        return { valid: false, error: 'Raise amount required' };
      }
      // playerBet = currentBet - toCall (derive from what we have)
      const playerBet = currentBet - toCall;
      // Max the player can raise to = their current bet + entire stack
      const maxRaiseTo = playerBet + playerStack;
      const raiseAmount = amount - currentBet;
      // Enforce min raise UNLESS it's an all-in (player committing entire stack)
      if (raiseAmount < minRaise && amount < maxRaiseTo) {
        return {
          valid: false,
          error: `Minimum raise is ${minRaise} (raise to at least ${currentBet + minRaise})`,
        };
      }
      if (amount > maxRaiseTo) {
        return { valid: false, error: 'Insufficient chips' };
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
// RAKE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface RakeConfig {
  percent: number; // e.g., 5 for 5%
  cap: number; // Maximum rake per hand
  noFlop: boolean; // No rake if no flop
  /** Optional: cap overrides by player count (e.g., heads-up gets lower cap) */
  capByPlayerCount?: Record<number, number>;
}

export function calculateRake(
  pot: number,
  sawFlop: boolean,
  config: RakeConfig,
  playerCount?: number
): number {
  if (pot <= 0 || config.percent <= 0) return 0;
  if (config.noFlop && !sawFlop) {
    return 0;
  }

  // Use player-count-specific cap if available
  let cap = config.cap;
  if (playerCount && config.capByPlayerCount) {
    cap = config.capByPlayerCount[playerCount] ?? config.cap;
  }

  // Exact precision — no floating-point drift
  const rake = Math.trunc(pot * config.percent) / 100;
  return Math.min(rake, cap);
}

// ── Timed Rake (alternative to pot-based rake) ──────────────────────────────

export interface TimedRakeConfig {
  /** Rake amount per time interval */
  amountPerInterval: number;
  /** Interval in minutes */
  intervalMinutes: number;
  /** Grace period in minutes before first rake (default: 0) */
  gracePeriodMinutes: number;
}

/**
 * Calculate timed rake based on elapsed session time.
 * Used as an alternative to pot-based rake — collects a flat fee per time period.
 *
 * @param sessionStartTime - When the player sat down (timestamp ms)
 * @param lastRakeTime - When rake was last collected (timestamp ms)
 * @param config - Timed rake configuration
 * @returns Amount of rake due (0 if not yet time)
 */
export function calculateTimedRake(
  sessionStartTime: number,
  lastRakeTime: number,
  config: TimedRakeConfig
): number {
  const now = Date.now();
  const sessionElapsedMs = now - sessionStartTime;
  const graceMs = config.gracePeriodMinutes * 60 * 1000;

  // Still in grace period
  if (sessionElapsedMs < graceMs) return 0;

  const timeSinceLastRake = now - lastRakeTime;
  const intervalMs = config.intervalMinutes * 60 * 1000;

  // Not yet time for next collection
  if (timeSinceLastRake < intervalMs) return 0;

  // Calculate how many intervals have passed
  const intervals = Math.floor(timeSinceLastRake / intervalMs);
  return intervals * config.amountPerInterval;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WINNER DETERMINATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface Winner {
  userId: string;
  amount: number;
  hand?: EvaluatedHand;
}

export function determineWinners(
  players: SeatPlayer[],
  communityCards: Card[],
  pots: Pot[],
  gameVariant: string = 'nlh'
): Winner[] {
  const winners: Winner[] = [];
  const activePlayers = players.filter((p) => !p.is_folded);

  // If only one player left, they win everything
  if (activePlayers.length === 1) {
    const totalPot = pots.reduce((sum, p) => sum + p.amount, 0);
    return [{ userId: activePlayers[0].user_id, amount: totalPot }];
  }

  // Hi/Lo only applies to Omaha variants (plo8, etc.) — never call evaluateOmahaLowHand for Hold'em
  const isOmaha = gameVariant.startsWith('plo');
  const isHiLo = isOmaha && (gameVariant.includes('8') || gameVariant === 'plo8');

  // Evaluate hands
  const evaluator = isOmaha ? evaluateOmahaHand : evaluateHand;
  const playerHands = activePlayers.map((p) => ({
    player: p,
    hand: evaluator(p.cards, communityCards),
    lowHand: isHiLo ? evaluateOmahaLowHand(p.cards, communityCards) : null,
  }));

  // Process each pot
  for (const pot of pots) {
    const eligible = playerHands.filter((ph) => pot.eligiblePlayers.includes(ph.player.user_id));
    if (eligible.length === 0) continue;

    let hiPotAmount = pot.amount;
    let loPotAmount = 0;

    // If Hi/Lo, check for qualification
    const qualifyingLowPlayers = eligible.filter((ph) => ph.lowHand !== null);

    if (isHiLo && qualifyingLowPlayers.length > 0) {
      const potScaled = Math.trunc(pot.amount * 100);
      const loScaled = Math.trunc(potScaled / 2);
      loPotAmount = loScaled / 100;
      hiPotAmount = (potScaled - loScaled) / 100;
    }

    // ─── HIGH HALF ───
    eligible.sort((a, b) => compareHands(b.hand, a.hand));
    if (eligible.length === 0) continue;
    const bestHiRanking = eligible[0].hand.ranking;
    const bestHiKickers = eligible[0].hand.kickers;

    const hiWinners = eligible.filter(
      (ph) =>
        ph.hand.ranking === bestHiRanking &&
        JSON.stringify(ph.hand.kickers) === JSON.stringify(bestHiKickers)
    );

    distributePot(winners, hiWinners, hiPotAmount, 'High');

    // ─── LOW HALF ───
    if (loPotAmount > 0 && qualifyingLowPlayers.length > 0) {
      qualifyingLowPlayers.sort((a, b) => compareLowHands(a.lowHand!.kickers, b.lowHand!.kickers));
      const bestLoKickers = qualifyingLowPlayers[0].lowHand!.kickers;

      const loWinners = qualifyingLowPlayers.filter(
        (ph) => JSON.stringify(ph.lowHand!.kickers) === JSON.stringify(bestLoKickers)
      );

      distributePot(winners, loWinners, loPotAmount, 'Low');
    } else if (loPotAmount === 0 && isHiLo) {
      // High hand takes entire pot if no low qualifier
    }
  }

  return winners;
}

function distributePot(
  globalWinners: Winner[],
  roundWinners: { player: SeatPlayer; hand: EvaluatedHand; lowHand?: EvaluatedHand | null }[],
  amount: number,
  type: 'High' | 'Low'
) {
  if (roundWinners.length === 0 || amount <= 0) return;
  const totalScaled = Math.trunc(amount * 100);
  const shareScaled = Math.trunc(totalScaled / roundWinners.length);
  const remainderScaled = totalScaled % roundWinners.length;

  // Sort winners by seat position (lowest seat first = closest to left of dealer)
  const sortedWinners = [...roundWinners].sort((a, b) => a.player.seat - b.player.seat);

  sortedWinners.forEach((pw, i) => {
    const existing = globalWinners.find((w) => w.userId === pw.player.user_id);
    const winAmt = (shareScaled + (i < remainderScaled ? 1 : 0)) / 100;

    if (existing) {
      existing.amount += winAmt;
    } else {
      globalWinners.push({
        userId: pw.player.user_id,
        amount: winAmt,
        hand: type === 'Low' ? pw.lowHand! : pw.hand,
      });
    }
  });
}

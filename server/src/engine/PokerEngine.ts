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
  PerPotAward,
} from '../types.js';

import { secureShuffle } from './CryptoRandom.js';
import { RAKE_SPEC } from '../config/rakeSpec.js';
import { isOmahaVariant, isHiLoVariant, isShortDeckVariant } from './VariantRules.js';

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
    // Dan 2026-07-28 (engine audit D23): this used to draw ONE Uint32 per slot up
    // front and then take `array[i] % (i + 1)`. Two defects, one real:
    //
    //   1. `%` on a uniform 32-bit value is only uniform when (i + 1) divides
    //      2^32. For a 52-card deck every i except 1, 3, 7, 15, 31 leaves a
    //      remainder, so the low indices were very slightly over-represented.
    //      The bias is ~1e-8 — not exploitable — but "very slightly biased" is
    //      not a property a card room should have to argue about, and the
    //      correct primitive was already sitting in CryptoRandom.
    //   2. It indexed `array[i]` for i down to 1 but never used array[0], and
    //      reused a single fill for the whole pass, so the randomness consumed
    //      was fixed at deck size rather than per-swap.
    //
    // secureShuffle does the same Fisher-Yates with rejection sampling, which is
    // exactly uniform, and is the same primitive the live deck already uses.
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

  removeCardsBelow(minRank: CardRank): void {
    const minValue = RANK_VALUES[minRank];
    this.cards = this.cards.filter((c) => RANK_VALUES[c.rank] >= minValue);
    this.shuffle();
  }

  /**
   * FIX 97: Get remaining cards without modifying the deck.
   * Used for RIT dual/triple board dealing.
   */
  getRemainingCards(): Card[] {
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

// ═══════════════════════════════════════════════════════════════════════════════
// HAND EVALUATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FIX 119: Added shortDeck parameter for variant-aware evaluation.
 * Short Deck: flush beats full house, A-6-7-8-9 is the lowest straight.
 */
export function evaluateHand(
  holeCards: Card[],
  communityCards: Card[],
  shortDeck: boolean = false
): EvaluatedHand {
  const allCards = [...holeCards, ...communityCards];

  if (allCards.length < 5) {
    return { ranking: 0, name: 'No Hand', cards: allCards, kickers: [] };
  }

  const combinations = getCombinations(allCards, 5);
  let bestHand: EvaluatedHand | null = null;

  for (const combo of combinations) {
    const evaluated = evaluate5Cards(combo, shortDeck);
    if (!bestHand || compareHands(evaluated, bestHand) > 0) {
      bestHand = evaluated;
    }
  }

  if (!bestHand) {
    return { ranking: 0, name: 'No Hand', cards: allCards.slice(0, 5), kickers: [] };
  }

  return bestHand;
}

/**
 * FIX 119: shortDeck param for variant-aware ranking.
 * Bible V8 Appendix D: In Short Deck, flush beats full house.
 */
function evaluate5Cards(cards: Card[], shortDeck: boolean = false): EvaluatedHand {
  const sorted = [...cards].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
  const isFlush = cards.every((c) => c.suit === cards[0].suit);
  const ranks = sorted.map((c) => RANK_VALUES[c.rank]);
  const isStraight = checkStraight(ranks, shortDeck);
  const isWheel = shortDeck
    ? ranks[0] === 14 && ranks[1] === 9 // Short Deck wheel: A-6-7-8-9
    : ranks[0] === 14 && ranks[1] === 5; // Standard wheel: A-2-3-4-5

  const rankCounts = new Map<number, number>();
  for (const r of ranks) {
    rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
  }
  const counts = [...rankCounts.values()].sort((a, b) => b - a);

  // FIX 119: Short Deck hand rankings — flush > full house (Bible V8 Appendix D)
  // In Short Deck, flush beats full house. We swap rankings: flush=7, full house=6.
  const flushRanking = shortDeck ? 7 : HAND_RANKINGS.FLUSH; // 7 in short deck, 6 normally
  const fullHouseRanking = shortDeck ? 6 : HAND_RANKINGS.FULL_HOUSE; // 6 in short deck, 7 normally

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
      kickers: isWheel ? (shortDeck ? [9, 8, 7, 6, 1] : [5, 4, 3, 2, 1]) : ranks,
    };
  }
  if (counts[0] === 4)
    return {
      ranking: HAND_RANKINGS.FOUR_OF_A_KIND,
      name: 'Four of a Kind',
      cards: sorted,
      kickers: getKickers(rankCounts),
    };
  // FIX 119: In Short Deck, full house is ranked BELOW flush
  if (counts[0] === 3 && counts[1] === 2)
    return {
      ranking: fullHouseRanking,
      name: 'Full House',
      cards: sorted,
      kickers: getKickers(rankCounts),
    };
  if (isFlush) return { ranking: flushRanking, name: 'Flush', cards: sorted, kickers: ranks };
  if (isStraight)
    return {
      ranking: HAND_RANKINGS.STRAIGHT,
      name: 'Straight',
      cards: sorted,
      kickers: isWheel ? (shortDeck ? [9, 8, 7, 6, 1] : [5, 4, 3, 2, 1]) : ranks,
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

/**
 * FIX 119: Short Deck support — A-6-7-8-9 is lowest straight (Bible V8 Appendix D).
 */
function checkStraight(ranks: number[], shortDeck: boolean = false): boolean {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.length < 5) return false;
  for (let i = 0; i <= unique.length - 5; i++) {
    if (unique[i] - unique[i + 4] === 4) return true;
  }
  if (shortDeck) {
    // Short Deck wheel: A-6-7-8-9 (ace plays low)
    if (
      unique.includes(14) &&
      unique.includes(9) &&
      unique.includes(8) &&
      unique.includes(7) &&
      unique.includes(6)
    ) {
      return true;
    }
  } else {
    // Standard wheel: A-2-3-4-5
    if (
      unique.includes(14) &&
      unique.includes(5) &&
      unique.includes(4) &&
      unique.includes(3) &&
      unique.includes(2)
    ) {
      return true;
    }
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
// HAND DESCRIPTION — secondary display line for the showdown result
// ═══════════════════════════════════════════════════════════════════════════════

const RANK_WORDS: Record<number, string> = {
  2: 'Two',
  3: 'Three',
  4: 'Four',
  5: 'Five',
  6: 'Six',
  7: 'Seven',
  8: 'Eight',
  9: 'Nine',
  10: 'Ten',
  11: 'Jack',
  12: 'Queen',
  13: 'King',
  14: 'Ace',
};

const RANK_PLURALS: Record<number, string> = {
  2: 'Twos',
  3: 'Threes',
  4: 'Fours',
  5: 'Fives',
  6: 'Sixes',
  7: 'Sevens',
  8: 'Eights',
  9: 'Nines',
  10: 'Tens',
  11: 'Jacks',
  12: 'Queens',
  13: 'Kings',
  14: 'Aces',
};

/**
 * SHOWDOWN SYSTEM 2026-08-25 (Dan spec section 14): a descriptive secondary
 * line for the winning hand, generated from the ACTUAL evaluated hand — never
 * hard-coded by the presentation layer. Examples:
 *   Full House      -> "Kings Full Of Nines"
 *   Flush           -> "Ace High"
 *   Straight        -> "Nine High"  (wheel -> "Five High")
 *   Four of a Kind  -> "Queens"
 *   Two Pair        -> "Aces And Kings"
 *   Pair            -> "Queens"
 *   High Card       -> "Ace High"
 * The kicker layout is exactly what getKickers() produces: grouped by count
 * descending, then rank descending — so kickers[0] is always the defining
 * rank, full house pair sits at index 3, second pair of two pair at index 2.
 * Low hands (ranking 0, name "Low: ...") reuse their existing name.
 */
export function describeHand(hand: EvaluatedHand): string {
  const k = hand.kickers;
  const word = (r: number | undefined) => (r !== undefined && RANK_WORDS[r]) || '';
  const plural = (r: number | undefined) => (r !== undefined && RANK_PLURALS[r]) || '';
  switch (hand.name) {
    case 'Royal Flush':
      return 'Ace High';
    case 'Straight Flush':
    case 'Straight':
    case 'Flush':
    case 'High Card':
      return k.length > 0 ? `${word(k[0])} High` : '';
    case 'Four of a Kind':
      return plural(k[0]);
    case 'Full House':
      return k.length >= 4 ? `${plural(k[0])} Full Of ${plural(k[3])}` : plural(k[0]);
    case 'Three of a Kind':
      return plural(k[0]);
    case 'Two Pair':
      return k.length >= 3 ? `${plural(k[0])} And ${plural(k[2])}` : plural(k[0]);
    case 'Pair':
      return plural(k[0]);
    default:
      // Omaha lows ("Low: 8-6-4-3-2") and any future variant-specific names
      // are already self-describing.
      return hand.name.startsWith('Low:') ? hand.name : '';
  }
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

/**
 * SHOWDOWN POLISH 2026-08-25 (hygiene): exported so HandController's muck
 * rules compare lows with the SAME comparator that awards the low half —
 * the duplicated local copy was a drift risk between "who may muck" and
 * "who gets paid". Lower is better; lexicographic on sorted-desc rank arrays.
 */
export function compareLowHands(a: number[], b: number[]): number {
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

  // Individual antes are matched contributions for pot eligibility, although
  // they are dead for the live betting price and uncalled-bet calculation.
  // Shared BBA and dead small blinds remain pooled table money. In particular,
  // a short individual ante cannot win the unmatched part of a full ante.
  // Snap levels to cents so floating-point drift cannot create phantom pots.
  const getInvestment = (p: SeatPlayer) =>
    Math.max(
      0,
      Math.round(
        ((p.totalInvested ?? p.bet ?? 0) -
          (p.deadInvested ?? 0) +
          (p.individualAnteInvested ?? 0)) *
          100
      ) / 100
    );
  const deadTotal =
    Math.round(
      players.reduce((s, p) => s + (p.deadInvested ?? 0) - (p.individualAnteInvested ?? 0), 0) * 100
    ) / 100;
  const allContributors = players.filter((p) => getInvestment(p) > 0);

  // No live money at all (e.g. everyone folded to dead antes): the dead money
  // forms a single pot contested by the remaining non-folded players.
  if (allContributors.length === 0) {
    if (deadTotal <= 0) return [];
    return [{ amount: deadTotal, eligiblePlayers: activePlayers.map((p) => p.user_id) }];
  }

  const sortedInvestments = [...new Set(allContributors.map((p) => getInvestment(p)))].sort(
    (a, b) => a - b
  );
  const pots: Pot[] = [];
  let previousLevel = 0;
  // 2026-08-20 (chip-conservation property test, D24): money contributed at a
  // level where EVERY contributor has since folded. The old code hit the
  // `eligiblePlayers.length > 0` guard and silently dropped that level, so the
  // returned pots no longer summed to the actual pot.
  //
  //   4-handed, seats 4 and 5 both raise-call to 1281.48 while seats 1 and 2
  //   are all-in for less. Both then fold on the flop. Their top level —
  //   (1281.48 - 811.33) x 2 = 940.30 — had no live claimant, so calculatePots
  //   returned 2988.51 against a pot of 3928.81. Found by ChipConservation
  //   property test seeds 99 and 105 (0.7% of random hands).
  //
  // The chips were not lost: completeHand scales the winners up to state.pot,
  // so the table stayed conserved. But that scaling spreads the orphan across
  // EVERY pot's winner in proportion to their award, which is arbitrary when
  // side pots have different winners. Uncontested dead money belongs to the
  // main pot, exactly like an ante — so it is added there instead, and the
  // partition sums to the pot by construction again.
  //
  // Note the unique-top-contributor case never reaches here: returnUncalledBet
  // refunds that player before completeHand calls this. Only a TIE at the top
  // where all of the tied players fold can orphan a level.
  let orphaned = 0;

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
    } else if (totalContributors > 0) {
      orphaned = Math.round((orphaned + contribution * totalContributors) * 100) / 100;
    }
    previousLevel = level;
  }

  if (orphaned > 0 && pots.length > 0) {
    pots[0].amount = Math.round((pots[0].amount + orphaned) * 100) / 100;
    orphaned = 0;
  }
  // No live-contested pot at all — the orphan joins the dead money below,
  // contested by whoever is still in the hand.
  const deadPool = Math.round((deadTotal + orphaned) * 100) / 100;

  // Dead money gets its OWN pot at the bottom of the stack, contested by every
  // non-folded player who put anything in — live or dead.
  //
  // 2026-08-18 (first attempt) folded deadTotal into pots[0] and then widened
  // pots[0]'s eligibility to include dead-money-only players. That fixed the
  // symptom (an all-in-for-the-ante player winning nothing) and introduced a
  // worse bug: pots[0] is not a dead-money pot, it is `the lowest LIVE level x
  // its contributors, PLUS all the dead money`. Widening it handed that player
  // the live action they never matched.
  //
  //   u1 live 100, u2 live 100, u3 all-in for a 5 ante (live 0)
  //   before: one pot of 205 contested by u1, u2 AND u3  -> u3 can win 205
  //   now:    dead pot 5 contested by all three, live pot 200 by u1/u2 only
  //
  // Dead money still never creates a private side pot for whoever posted it:
  // the Big Blind Ante is one player fronting the whole table, so it is summed
  // across everyone and contested by everyone, exactly as before. That is also
  // why dead money is kept out of the LEVEL construction above.
  //
  // When every non-folded player has live investment at the lowest level, this
  // dead pot has the same eligible set as pots[0] and the merge step below
  // folds the two back together — so the common case is byte-for-byte what it
  // was, and only the dead-money-only case changes.
  if (pots.length > 0 && deadPool > 0) {
    const deadEligible = activePlayers.filter((p) => (p.totalInvested ?? p.bet ?? 0) > 0);
    pots.unshift({
      amount: deadPool,
      eligiblePlayers: deadEligible.map((p) => p.user_id),
    });
  }

  // Merge pots with identical eligible players
  if (pots.length === 0) {
    return deadPool > 0
      ? [{ amount: deadPool, eligiblePlayers: activePlayers.map((p) => p.user_id) }]
      : [];
  }
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
  isPotLimit: boolean = false,
  /**
   * 2026-08-23: fixed-limit bounds, supplied only by fixed-limit tables (flh,
   * flo8). `betSize` is the street's wager — the small bet preflop and on the
   * flop, the big bet on turn and river (BettingStructure.fixedLimitBetSize).
   * `capped` is true once the street has taken a bet and three raises.
   *
   * Both bounds are the legal increment. Normally this is betSize; a short
   * wager below half the street bet can instead be completed by raiseSize.
   */
  fixedLimit?: { betSize: number; capped: boolean; raiseSize?: number }
): BettingState {
  const toCall = currentBet - playerBet;

  if (fixedLimit) {
    return {
      currentBet,
      minRaise: fixedLimit.raiseSize ?? fixedLimit.betSize,
      pot,
      toCall,
      maxRaise: fixedLimit.raiseSize ?? fixedLimit.betSize,
      wagersCapped: fixedLimit.capped,
      structure: 'fixed_limit',
    };
  }

  // FIX 121: Bible V8 §4.14 — pot-limit max raise = pot after calling
  // Pot-limit formula: max raise SIZE = pot + toCall (the pot after you call)
  // Previous code had pot + toCall + toCall which was too permissive.
  const maxRaise = isPotLimit ? pot + toCall : undefined;
  return {
    currentBet,
    minRaise: Math.max(bigBlind, lastRaise || bigBlind),
    pot,
    toCall,
    maxRaise,
    structure: isPotLimit ? 'pot_limit' : 'no_limit',
  };
}

/**
 * Half a cent. Chip amounts are whole cents by rule (Bible V8 §2.6), so a
 * comparison that is off by less than this is float drift, never a real
 * difference. The same constant and the same reasoning already guard
 * HandController.isBettingRoundComplete (AUDIT V2 2026-07-23); validateAction
 * never got it, which is the bug documented below.
 */
const CENT_EPS = 0.005;

export function validateAction(
  action: ActionType,
  amount: number | undefined,
  playerStack: number,
  bettingState: BettingState
): { valid: boolean; error?: string } {
  const { currentBet, minRaise, toCall } = bettingState;

  // Money enters the hand only as finite whole cents. Comparing an arbitrary
  // fraction against cent-tolerant limits and rounding AFTER mutation can
  // round the debit and pot independently. Strings also must not coerce into
  // legal-looking wagers. Allow only IEEE representation noise, not sub-cents.
  if (action === 'bet' || action === 'raise') {
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      !Number.isSafeInteger(Math.round(amount * 100)) ||
      Math.abs(amount - Math.round(amount * 100) / 100) > 1e-9
    ) {
      return { valid: false, error: 'Wager must be a finite whole-cent amount' };
    }
  }
  // 2026-08-23: "Pot-limit max ..." was hardcoded into every ceiling message,
  // which would have read as a lie on a fixed-limit table. Name the structure
  // that actually produced the bound.
  const ceilingLabel = bettingState.structure === 'fixed_limit' ? 'Fixed-limit' : 'Pot-limit';
  const isFixedLimit = bettingState.structure === 'fixed_limit';

  // ══════════════════════════════════════════════════════════════════════════
  // 2026-08-20: THE MIN-RAISE BUTTON WAS REJECTED ~45% OF THE TIME.
  //
  // Found by the chip-conservation property test (ChipConservation.property
  // .test.ts): it generated a raise sized from this module's own bounds and the
  // engine refused it — a contradiction, since the size came from `minRaise`.
  //
  //   calculateBettingState(pot 0.30, currentBet 0.10, playerBet 0, bb 0.02,
  //                         lastRaise 0.05)  ->  minRaise = 0.05
  //   player clicks "min raise" -> raise TO 0.15
  //   raiseAmount = 0.15 - 0.10 = 0.04999999999999999   (IEEE 754)
  //   0.04999999999999999 < 0.05  ->  "Minimum raise is 0.05"
  //
  // Measured across 1,200 (currentBet, minRaise) pairs at real cent
  // granularity: 538 rejected, 44.8%. Every one of those is a player pressing
  // the min-raise button and being told no, on a legal raise the client's own
  // UI computed. The comparisons below are all now cent-tolerant. Because chip
  // values are whole cents, a half-cent slack cannot admit a genuinely short
  // raise or an overbet — the smallest real violation is a full cent, two
  // orders of magnitude above the tolerance.
  // ══════════════════════════════════════════════════════════════════════════

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
      // Fixed limit: a capped street takes no further wager. Reachable only
      // postflop with a bet already in, so `bet` here is a contradiction, but
      // the guard is cheap and keeps every wager path capped by one rule.
      if (bettingState.wagersCapped)
        return { valid: false, error: 'Betting is capped for this round' };
      if (!amount || amount < minRaise - CENT_EPS)
        return { valid: false, error: `Minimum bet is ${minRaise}` };
      if (amount > playerStack + CENT_EPS) return { valid: false, error: 'Insufficient chips' };
      // Bible V8 §4.14: pot-limit max bet — and, since 2026-08-23, the
      // fixed-limit bet size, where maxRaise === minRaise so this pins the bet
      // to exactly one legal amount.
      if (bettingState.maxRaise !== undefined && amount > bettingState.maxRaise + CENT_EPS) {
        return { valid: false, error: `${ceilingLabel} max bet is ${bettingState.maxRaise}` };
      }
      return { valid: true };
    case 'raise': {
      if (currentBet === 0)
        return { valid: false, error: 'Cannot raise when there is no bet (use bet)' };
      if (!amount) return { valid: false, error: 'Raise amount required' };
      // Fixed limit: one bet and three raises per street, then the round is
      // capped and the only actions left are fold and call.
      if (bettingState.wagersCapped)
        return { valid: false, error: 'Betting is capped for this round' };
      const playerBet = currentBet - toCall;
      const maxRaiseTo = playerBet + playerStack;
      const raiseAmount = amount - currentBet;
      // The `amount < maxRaiseTo` escape lets a short stack raise all-in for
      // less than a full increment. That is correct in no-limit and pot-limit;
      // in fixed limit an under-sized wager must arrive as `all_in`, never as
      // a `raise`, or the client could shave the fixed bet.
      if (raiseAmount < minRaise - CENT_EPS && amount < maxRaiseTo - CENT_EPS) {
        return {
          valid: false,
          error: isFixedLimit
            ? `Fixed-limit raise must be exactly ${minRaise}`
            : `Minimum raise is ${minRaise}`,
        };
      }
      if (amount > maxRaiseTo + CENT_EPS) return { valid: false, error: 'Insufficient chips' };
      // FIX 121: Bible V8 §4.14: Pot-limit max raise = pot after calling.
      // Fixed limit reuses the same ceiling with maxRaise === the bet size.
      if (bettingState.maxRaise !== undefined && raiseAmount > bettingState.maxRaise + CENT_EPS) {
        return { valid: false, error: `${ceilingLabel} max raise is ${bettingState.maxRaise}` };
      }
      return { valid: true };
    }

    case 'all_in': {
      // ── Dan 2026-08-21, BINDING: "IN PLO YOU CAN NEVER GO ALL IN IF THE POT
      //    IS LESS THAN THE CHIPS YOU HAVE. THE MOST YOU CAN EVER BET IS POT."
      //
      // This case returned `valid: true` unconditionally, so `all_in` was the
      // one action that walked straight past the pot-limit ceiling every other
      // branch enforces. A deep stack could shove many times the cap in PLO.
      //
      // An all-in is legal when the whole stack fits under the cap, and when
      // it cannot even cover the call. It is illegal only when the stack
      // EXCEEDS what pot-limit allows.
      //
      // 2026-08-23: fixed limit needs the identical treatment for the identical
      // reason. A shove is legal there only when the stack lands at or under
      // the street's fixed bet — a deep stack cannot jam a limit game, and on a
      // capped street it cannot put in more than the call.
      if (bettingState.wagersCapped) {
        const playerBet = currentBet - toCall;
        const allInTo = playerBet + playerStack;
        if (allInTo > currentBet + CENT_EPS) {
          return {
            valid: false,
            error: 'Betting is capped for this round - you may only call',
          };
        }
      }
      if (bettingState.maxRaise !== undefined) {
        const playerBet = currentBet - toCall;
        const allInTo = playerBet + playerStack;
        const raiseSize = allInTo - currentBet;
        if (raiseSize > bettingState.maxRaise + CENT_EPS) {
          return {
            valid: false,
            error: isFixedLimit
              ? `Fixed-limit max is ${currentBet + bettingState.maxRaise} - you cannot go all in for more than the bet`
              : `Pot-limit max is ${currentBet + bettingState.maxRaise} - you cannot go all in for more than the pot`,
          };
        }
      }
      return { valid: true };
    }
    default:
      return { valid: false, error: 'Invalid action' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAKE CALCULATION — Exact penny, NO rounding
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Heads-up is raked at 5%, not the schedule's 10%.
 *
 * ── Dan 2026-08-27, correcting a rake audit ──────────────────────────────────
 * "Rake is 10% with a max cap. Heads up is 5% rake."
 *
 * The engine already knew heads-up is cheaper, but only in the CAP:
 * getPlayerCountCaps() halves it at two players. The PERCENT stayed at the
 * schedule's 10%, so every heads-up pot small enough that the cap never bound
 * was raked at double the intended rate.
 *
 * Measured before this fix, over 12 hours of live cash heads-up hands:
 * 635 raked hands, 398 of them at ~10%, average effective rate 7.77%, and
 * 457.69 chips taken above what 5% would have collected. The cap was doing its
 * job on the big pots, which is why the average sat between the two rates and
 * why this went unnoticed.
 */
// 2026-09-02: the number lives in RAKE_SPEC (config/rakeSpec.ts), the one
// specification the database mirrors as ca_rake_rules.heads_up_percent. This
// export is the same value under its historical name.
export const HEADS_UP_RAKE_PERCENT = RAKE_SPEC.rules.headsUpPercent;

export function calculateRake(
  pot: number,
  sawFlop: boolean,
  config: RakeConfig,
  playerCount?: number
): number {
  if (config.noFlopNoDrop && !sawFlop) return 0;
  // Round 40 RE-RUN: Math.trunc here under-collected rake by 1¢ on every
  // pot whose IEEE 754 representation drifted slightly under (e.g. pot
  // accumulated as 14.549999... instead of 14.55). Verified live: of 577
  // below-cap hands in 24h, 261 (45%) under-collected 1¢ vs Math.round.
  // Math.round is the right operation because float drift can go either
  // direction and we want the nearest cent. Cap is still applied after
  // (Math.min) so over-rounding past the cap is impossible.
  // Aligns with the same Math.round fix applied in HandController.completeHand
  // (commit 9900b874) and distributePot (FIX 179).
  /* Heads-up pays 5%. `Math.min` rather than an assignment, so a club or table
     that has deliberately configured a rate BELOW 5% keeps it -- this is a
     ceiling for two-handed play, never a floor that could raise someone's
     rake. A table configured at 3% stays at 3% heads-up. */
  let percent = config.percent;
  if (playerCount !== undefined && playerCount <= 2) {
    percent = Math.min(percent, HEADS_UP_RAKE_PERCENT);
  }

  const rake = Math.round(pot * percent) / 100;
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

/** Reports a pot whose eligibility snapshot matched none of the contenders. */
export type EligibilityFallback = (info: {
  potIndex: number;
  potAmount: number;
  snapshotEligible: number;
  contenders: number;
}) => void;

export function determineWinners(
  players: SeatPlayer[],
  communityCards: Card[],
  pots: Pot[],
  gameVariant: string = 'nlh',
  dealerSeat: number = 0,
  /**
   * SHOWDOWN POLISH 2026-08-25 (spec 16/19/33): optional collector for the
   * UNMERGED per-pot(-half) award breakdown. The returned Winner[] stays
   * merged per user — that is the settlement contract and every consumer of
   * money depends on it — but the merge erases which pot each share came
   * from, which is exactly what the award-sequence presentation and the
   * HIGH/LOW winner labels need. Callers that pass an array get one entry
   * per (pot, half, winner): potIndex, low flag, the exact share of THAT
   * pot, and the evaluated hand that won it. Presentation-only data; the
   * amounts are pre-rake shares.
   */
  perPotOut?: PerPotAward[],
  /**
   * Told when a pot's eligibility snapshot matched nobody and the contenders
   * still in the hand were used instead. The award still happens; this exists
   * so a bad snapshot is visible rather than silent.
   */
  onEligibilityFallback?: EligibilityFallback,
  /**
   * The indivisible chip unit for this hand: 0.01 for cash, 1 for a tournament.
   * Defaults to a cent so existing callers are unchanged.
   */
  chipUnit: number = 0.01
): Winner[] {
  const winners: Winner[] = [];
  const activePlayers = players.filter((p) => !p.is_folded);

  if (activePlayers.length === 1) {
    const totalPot = pots.reduce((sum, p) => sum + p.amount, 0);
    // Preserve every pot layer even though the public Winner[] deliberately
    // remains aggregated. Daily Missions, knockout attribution, and the visual
    // settlement ledger consume this unmerged collector; collapsing a main pot
    // plus side pots into index 0 made those durable facts incomplete whenever
    // action ended in folds.
    pots.forEach((pot, potIndex) => {
      perPotOut?.push({
        userId: activePlayers[0].user_id,
        potIndex,
        low: false,
        amount: pot.amount,
      });
    });
    return [{ userId: activePlayers[0].user_id, amount: totalPot, potIndex: 0 }];
  }

  // 2026-08-23: all three of these were substring tests on the variant string,
  // and this function AWARDS THE POT. `flo8` matches none of them: it would
  // have been evaluated as Hold'em and paid out with no low split, so the
  // wrong player wins. VariantRules answers all three from one table.
  const isOmaha = isOmahaVariant(gameVariant);
  // Bible V8 §7.6: plo8 and flo8 are the hi-lo variants (FIX 116: plo_hilo removed)
  const isHiLo = isHiLoVariant(gameVariant);
  // FIX 119: Short Deck variant-aware evaluation
  const isShortDeck = isShortDeckVariant(gameVariant);

  const evaluator = isOmaha
    ? evaluateOmahaHand
    : (h: Card[], c: Card[]) => evaluateHand(h, c, isShortDeck);

  const playerHands = activePlayers.map((p) => ({
    player: p,
    hand: evaluator(p.cards, communityCards),
    lowHand: isHiLo ? evaluateOmahaLowHand(p.cards, communityCards) : null,
  }));

  for (let potIdx = 0; potIdx < pots.length; potIdx++) {
    const pot = pots[potIdx];
    let eligible = playerHands.filter((ph) => pot.eligiblePlayers.includes(ph.player.user_id));

    /**
     * A POT IS NEVER SKIPPED (Dan 2026-08-26, binding: "a hand must ALWAYS
     * have a winner ... it is impossible for there to not be a winner").
     *
     * This was `if (eligible.length === 0) continue;`. A `continue` here does
     * not skip a calculation - it DROPS A POT. Those chips are awarded to
     * nobody and leave the hand. When every pot took that branch the function
     * returned an empty array, and HandController then handed the whole pot to
     * `activePlayers[0]`: the first entry of a list, which has nothing to do
     * with who won.
     *
     * `eligiblePlayers` is a snapshot taken when the pot was built, and it can
     * fail to intersect the contenders for reasons that say nothing about the
     * hand - a side pot built from a player who has since folded, a stale
     * rebuild after a reconnect, an id stored in a different shape. In every
     * one of those the money is real and somebody at this table still holds
     * the best hand for it.
     *
     * So an empty intersection is a BAD SNAPSHOT, not an empty pot: fall back
     * to every contender still in the hand - the widest defensible
     * eligibility - and evaluate normally. The pot goes to the best hand among
     * people actually still playing, which is the only answer that is ever
     * correct.
     */
    if (eligible.length === 0) {
      if (playerHands.length === 0) continue; // nobody is in the hand at all
      onEligibilityFallback?.({
        potIndex: potIdx,
        potAmount: pot.amount,
        snapshotEligible: pot.eligiblePlayers.length,
        contenders: playerHands.length,
      });
      eligible = playerHands.slice();
    }

    let hiPotAmount = pot.amount;
    let loPotAmount = 0;

    const qualifyingLowPlayers = eligible.filter((ph) => ph.lowHand !== null);
    if (isHiLo && qualifyingLowPlayers.length > 0) {
      // FIX 179: Use Math.round to avoid IEEE 754 floating-point truncation errors
      // e.g. Math.trunc(0.51 * 100) = 50 (wrong), Math.round(0.51 * 100) = 51 (correct)
      const potCents = Math.round(pot.amount * 100);
      // Split high/low in the same indivisible unit used for tied winners.
      // Splitting into cents first creates half-chip tournament awards even
      // when distributePot correctly preserves whole chips within each half.
      // The odd unit (and any pre-existing sub-unit residue) belongs to high.
      const unitCents = Math.max(1, Math.round(chipUnit * 100));
      const loCents = Math.floor(potCents / (2 * unitCents)) * unitCents;
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
    // FIX 226: Pass dealerSeat so odd chip goes clockwise from dealer (not seat 0)
    distributePot(winners, hiWinners, hiPotAmount, 'High', potIdx, dealerSeat, perPotOut, chipUnit);

    // Low half
    if (loPotAmount > 0) {
      qualifyingLowPlayers.sort((a, b) => compareLowHands(a.lowHand!.kickers, b.lowHand!.kickers));
      const bestLoKickers = qualifyingLowPlayers[0].lowHand!.kickers;
      const loWinners = qualifyingLowPlayers.filter(
        (ph) => JSON.stringify(ph.lowHand!.kickers) === JSON.stringify(bestLoKickers)
      );
      distributePot(
        winners,
        loWinners,
        loPotAmount,
        'Low',
        potIdx,
        dealerSeat,
        perPotOut,
        chipUnit
      );
    }
  }

  return winners;
}

/**
 * FIX 169: Bible V8 §2.7 — Odd chip goes to the first player CLOCKWISE of the
 * dealer button, not the lowest seat number. The dealerSeat param enables this.
 * When dealerSeat is unknown (0), falls back to lowest-seat order.
 */
function distributePot(
  globalWinners: Winner[],
  roundWinners: { player: SeatPlayer; hand: EvaluatedHand; lowHand?: EvaluatedHand | null }[],
  amount: number,
  half: 'High' | 'Low',
  potIndex: number = 0,
  dealerSeat: number = 0,
  perPotOut?: PerPotAward[],
  /**
   * The indivisible unit this pot is paid in, in chips. Cash chips divide to
   * the cent (0.01); TOURNAMENT CHIPS DO NOT DIVIDE AT ALL (1). Defaults to a
   * cent, so every caller that does not pass it keeps its exact behaviour.
   */
  chipUnit: number = 0.01
): void {
  // FIX 179: Math.round prevents IEEE 754 truncation (e.g. 0.51*100 = 50.999... → 51)
  const totalCents = Math.round(amount * 100);
  // A TOURNAMENT CHIP DOES NOT DIVIDE (2026-09-08). This split was always done
  // in cents, so a 959-chip tournament pot chopped two ways paid 479.50 each -
  // a stack a tournament cannot represent. Downstream that fraction was floored
  // away in services/supabase/tables.ts, destroying chips, and the settlement
  // guard refused the hand outright, which stalled the table for good because
  // every retry was identical. Measured 17:35 UTC: 7 tournaments carried a
  // fractional seat and exactly those 7 were stalled.
  //
  // The pot is now divided into INDIVISIBLE UNITS: cents for cash, whole chips
  // for a tournament. unitCents is 1 in the cash case, which makes wholeUnits
  // === totalCents and subUnitCents === 0, so the cash arithmetic below is
  // identical to what it has always been - by construction, not by inspection.
  const unitCents = Math.max(1, Math.round(chipUnit * 100));
  const wholeUnits = Math.floor(totalCents / unitCents);
  // Anything finer than one unit cannot be split, so it rides with the first
  // winner clockwise of the button rather than being created or destroyed. It
  // is zero for cash, and for a tournament only a legacy fractional stack going
  // all-in can produce it. The awards therefore always re-sum to totalCents.
  const subUnitCents = totalCents - wholeUnits * unitCents;
  const shareUnits = Math.trunc(wholeUnits / roundWinners.length);
  const remainderUnits = wholeUnits % roundWinners.length;

  // FIX 169: Sort by clockwise distance from dealer button for odd-chip allocation.
  // The player closest clockwise to the dealer gets the first odd chip.
  //
  // 2026-08-18: the button itself was getting it. `(seat - dealerSeat) % maxSeat`
  // is 0 when the winner IS the dealer, which sorted the button FIRST — but the
  // button is the LAST position clockwise from itself, not the first. TDA and
  // this function's own docblock both say the first player clockwise OF the
  // dealer, i.e. the small blind seat. Heads-up, a chopped pot with an odd cent
  // paid the button instead of the big blind. Mapping distance 0 to maxSeat puts
  // the button at the back of the queue where it belongs. Unknown-dealer (0)
  // behaviour is unchanged: seats are 1-based, so no winner can score 0 there.
  const maxSeat = Math.max(...roundWinners.map((w) => w.player.seat), dealerSeat) + 1;
  const clockwiseDistance = (seat: number) => {
    const d = (seat - dealerSeat + maxSeat * 10) % maxSeat;
    return d === 0 ? maxSeat : d;
  };
  const sortedWinners = [...roundWinners].sort(
    (a, b) => clockwiseDistance(a.player.seat) - clockwiseDistance(b.player.seat)
  );

  sortedWinners.forEach((pw, i) => {
    const existing = globalWinners.find((w) => w.userId === pw.player.user_id);
    const winAmt =
      ((shareUnits + (i < remainderUnits ? 1 : 0)) * unitCents + (i === 0 ? subUnitCents : 0)) /
      100;
    // SHOWDOWN POLISH 2026-08-25: the unmerged per-pot(-half) record. For the
    // low half the winning "hand" is the qualifying low, whose name is its
    // own description ("Low: 8-6-4-3-2").
    perPotOut?.push({
      userId: pw.player.user_id,
      potIndex,
      low: half === 'Low',
      amount: winAmt,
      hand: half === 'Low' ? (pw.lowHand ?? undefined) : pw.hand,
    });
    if (existing) {
      existing.amount += winAmt;
    } else {
      globalWinners.push({ userId: pw.player.user_id, amount: winAmt, hand: pw.hand, potIndex });
    }
  });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Monte Carlo Equity Calculator
 * ═══════════════════════════════════════════════════════════════════════════════
 * Runs N random simulations to estimate hero's equity against one or more
 * opponents. Used by the insurance system to calculate real equity percentages.
 *
 * Performance: 1000 iterations completes in <10ms on modern hardware.
 *
 * Ported from client: src/engine/MonteCarloEquity.ts (127 lines)
 * Server adaptation: Updated imports to use server types and paths. Pure function — no state.
 */

import type { Card, CardSuit, CardRank } from '../types.js';
import { evaluateHand, SUITS, RANKS } from './PokerEngine.js';
import { secureShuffle } from './CryptoRandom.js';

// Full deck as engine Card objects
const FULL_DECK: Card[] = [];
for (const suit of SUITS) {
  for (const rank of RANKS) {
    FULL_DECK.push({ rank, suit });
  }
}

function cardKey(c: Card): string {
  return `${c.rank}:${c.suit}`;
}

/**
 * Compute hero's equity using Monte Carlo simulation.
 *
 * @param heroCards   Hero's hole cards (2 cards, engine Card format)
 * @param boardCards  Community cards dealt so far (3-5 cards, engine Card format)
 * @param numOpponents Number of opponents (default 1)
 * @param iterations  Number of simulations to run (default 1000)
 * @returns Equity as a percentage (0-100)
 */
export function monteCarloEquity(
  heroCards: Card[],
  boardCards: Card[],
  numOpponents: number = 1,
  iterations: number = 1000,
  shortDeck: boolean = false
): number {
  if (heroCards.length < 2) {
    return 50; // Need at least 2 hole cards
  }
  // Note: boardCards can be empty (preflop all-in) — simulation will deal all 5 community cards

  // Build set of known cards (hero + board)
  const knownSet = new Set<string>();
  for (const c of heroCards) knownSet.add(cardKey(c));
  for (const c of boardCards) knownSet.add(cardKey(c));

  // FIX 139: Short Deck removes 2s through 5s (Bible V8 §4.5)
  const SHORT_DECK_REMOVED: Set<string> = new Set(['2', '3', '4', '5']);
  const baseDeck = shortDeck ? FULL_DECK.filter((c) => !SHORT_DECK_REMOVED.has(c.rank)) : FULL_DECK;

  // Remaining deck = all cards NOT in heroCards or boardCards
  const remainingDeck = baseDeck.filter((c) => !knownSet.has(cardKey(c)));

  const cardsNeeded = 5 - boardCards.length + numOpponents * 2;
  if (remainingDeck.length < cardsNeeded) {
    return 50; // Not enough cards for simulation
  }

  let wins = 0;
  let ties = 0;

  for (let i = 0; i < iterations; i++) {
    // Shuffle remaining deck for this iteration
    secureShuffle(remainingDeck);

    let dealIdx = 0;

    // Complete the board to 5 cards
    const fullBoard = [...boardCards];
    while (fullBoard.length < 5) {
      fullBoard.push(remainingDeck[dealIdx++]);
    }

    // Evaluate hero's hand (FIX 139: pass shortDeck for correct Short Deck rankings)
    const heroResult = evaluateHand(heroCards, fullBoard, shortDeck);

    // Deal and evaluate each opponent's hand
    let heroBeat = true;
    let anyTie = false;

    for (let opp = 0; opp < numOpponents; opp++) {
      const oppCards = [remainingDeck[dealIdx++], remainingDeck[dealIdx++]];
      const oppResult = evaluateHand(oppCards, fullBoard, shortDeck);

      // Compare: higher ranking wins, ties broken by kickers
      if (oppResult.ranking > heroResult.ranking) {
        heroBeat = false;
        break;
      } else if (oppResult.ranking === heroResult.ranking) {
        // Compare kickers
        let kickerResult = 0;
        for (let k = 0; k < Math.min(heroResult.kickers.length, oppResult.kickers.length); k++) {
          if (oppResult.kickers[k] > heroResult.kickers[k]) {
            kickerResult = -1;
            break;
          } else if (oppResult.kickers[k] < heroResult.kickers[k]) {
            kickerResult = 1;
            break;
          }
        }
        if (kickerResult < 0) {
          heroBeat = false;
          break;
        } else if (kickerResult === 0) {
          anyTie = true;
        }
      }
    }

    if (heroBeat && !anyTie) {
      wins++;
    } else if (heroBeat && anyTie) {
      ties++;
    }
  }

  // Equity = wins + ties/2 (ties split the pot)
  const equity = ((wins + ties / 2) / iterations) * 100;
  return Math.round(equity * 10) / 10; // Round to 1 decimal
}

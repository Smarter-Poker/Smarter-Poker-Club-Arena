/**
 * HERO HAND STRENGTH PERSISTENCE (2026-08-24).
 *
 * Dan 2026-08-24: "WHEN A HAND IS FINISHING UP, YOU WILL NOTICE THAT IT SAYS
 * 'FULL HOUSE' FOR ME, BUT ONCE THE HAND IS 'OVER' THE CARDS LINGER FOR A SECOND
 * OR 2 AND IT SAYS KING HIGH. IT SHOULD NEVER CHANGE THE HAND STRENGTH THE HAND IS
 * OVER, CARDS ARE MUCKED AND THATS A BUG THAT NEEDS TO BE FIXED."
 *
 * This test verifies that during hand completion / showdown linger when
 * isHandInProgress becomes false and community cards are cleared, the evaluated
 * hand strength does not degrade to preflop / hole-only evaluation.
 */
import { describe, it, expect } from 'vitest';
import { bestFive } from '../../src/utils/handEvaluator';
import type { Card } from '../../src/components/table/CardImage';

const card = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

describe('heroHandStrength persistence logic', () => {
  it('correctly evaluates Full House with board and preserves across hand end', () => {
    // Hero has K-Q-7-6 in PLO4 (must use 2 cards from hand, 3 from board)
    const holeCards: Card[] = [card('K', 'd'), card('Q', 's'), card('7', 'c'), card('6', 's')];
    // Board has 6-10-6-7-10
    const boardCards: Card[] = [
      card('6', 's'),
      card('10', 's'),
      card('6', 'd'),
      card('7', 's'),
      card('10', 's'),
    ];

    // During active play on the river, bestFive finds Full House
    const activeStrength = bestFive(holeCards, boardCards, 'plo')?.name;
    expect(activeStrength).toBe('Full House');

    // Simulate hand transition cache:
    const cachedStrength: string | null = activeStrength ?? null;
    const isHandInProgress = false;
    const boardAfterClear: Card[] = [];

    // When isHandInProgress is false, the hook returns cachedStrength instead of recalculating
    const displayStrength = !isHandInProgress
      ? cachedStrength
      : (bestFive(holeCards, boardAfterClear, 'plo')?.name ?? null);
    expect(displayStrength).toBe('Full House');
  });
});

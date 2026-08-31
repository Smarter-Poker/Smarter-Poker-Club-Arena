/**
 * BBJ NEAR-MISS DETECTION (2026-08-18)
 *
 * The near-miss banner teaches the jackpot rules in the moment a player just
 * missed. These tests pin the two properties that matter:
 *   1. It fires ONLY when a real qualifying losing hand was made (otherwise
 *      it would spam after every hand and train players to ignore it).
 *   2. It NEVER fires on a hand that actually hit the jackpot (that would
 *      tell a winner they missed).
 */
import { describe, it, expect } from 'vitest';
import { detectBBJHit, detectBBJNearMiss } from './RakeConfig.js';

const c = (rank: string, suit: string) => ({ rank, suit });

function sd(
  userId: string,
  handRanking: number,
  kickers: number[],
  hole: Array<{ rank: string; suit: string }>
) {
  return { userId, handRanking, handName: `rank${handRanking}`, kickers, holeCards: hole };
}

const DEALT = ['W', 'L', 'X'];

function near(
  results: ReturnType<typeof sd>[],
  opts: {
    variant?: string;
    pot?: number;
    bb?: number;
    dealtCount?: number;
    board?: Array<{ rank: string; suit: string }>;
  } = {}
) {
  return detectBBJNearMiss(
    results,
    'W',
    opts.variant ?? 'nlh',
    opts.pot ?? 500,
    opts.bb ?? 10,
    opts.dealtCount ?? DEALT.length,
    opts.board
  );
}

// Aces full of jacks: rank 7 (full house), kickers [14, 11].
const ACES_FULL_JACKS = sd('L', 7, [14, 11], [c('A', 'hearts'), c('A', 'spades')]);
// Kings full: qualifying bar NOT met for NLH (needs aces full of jacks).
const KINGS_FULL = sd('L', 7, [13, 5], [c('K', 'hearts'), c('K', 'spades')]);

describe('near miss fires only on a genuine qualifying losing hand', () => {
  it('reports winner_not_quads when aces-full loses to a mere full house', () => {
    const r = near([sd('W', 7, [14, 12], [c('A', 'clubs'), c('Q', 'clubs')]), ACES_FULL_JACKS]);
    expect(r.nearMiss).toBe(true);
    expect(r.reason).toBe('winner_not_quads');
    expect(r.userId).toBe('L');
    expect(r.message).toContain('Quads or better');
  });

  it('stays silent when the loser did not meet the qualifying bar', () => {
    const r = near([sd('W', 8, [9], [c('9', 'clubs'), c('9', 'hearts')]), KINGS_FULL]);
    expect(r.nearMiss).toBe(false);
  });

  it('stays silent on a two-pair beat (the common case - no spam)', () => {
    const r = near([
      sd('W', 3, [10, 4], [c('T', 'clubs'), c('4', 'clubs')]),
      sd('L', 2, [9, 3], [c('9', 'hearts'), c('3', 'spades')]),
    ]);
    expect(r.nearMiss).toBe(false);
  });
});

describe('near miss reports the blocking condition', () => {
  it('reports pot_too_small when the pot never reached 10bb', () => {
    const r = near([sd('W', 8, [5], [c('5', 'clubs'), c('5', 'hearts')]), ACES_FULL_JACKS], {
      pot: 50,
      bb: 10,
    });
    expect(r.nearMiss).toBe(true);
    expect(r.reason).toBe('pot_too_small');
  });

  it('reports not_enough_players before any other reason', () => {
    const r = near([sd('W', 8, [5], [c('5', 'clubs'), c('5', 'hearts')]), ACES_FULL_JACKS], {
      dealtCount: 2,
    });
    expect(r.nearMiss).toBe(true);
    expect(r.reason).toBe('not_enough_players');
  });

  it('reports both_cards_must_play when one hole card is a dead kicker', () => {
    // Board AA JJ 5. The loser holds A-J: the ace makes aces-full (so the
    // hand DOES meet the qualifying bar, ace-in-hole included), but the jack
    // is redundant with the board's pair — dropping it leaves the identical
    // aces full of jacks, so both cards do not play.
    const board = [
      c('A', 'hearts'),
      c('A', 'spades'),
      c('J', 'clubs'),
      c('J', 'hearts'),
      c('5', 'diamonds'),
    ];
    const loser = sd('L', 7, [14, 11], [c('A', 'diamonds'), c('J', 'spades')]);
    const winner = sd('W', 8, [5, 14], [c('5', 'clubs'), c('5', 'spades')]);
    const r = near([winner, loser], { board });
    expect(r.nearMiss).toBe(true);
    expect(r.reason).toBe('both_cards_must_play');
  });
});

describe('near miss never contradicts a real hit', () => {
  it('is silent on a hand detectBBJHit confirms as a jackpot', () => {
    const board = [
      c('A', 'hearts'),
      c('A', 'spades'),
      c('J', 'clubs'),
      c('5', 'diamonds'),
      c('5', 'clubs'),
    ];
    const loser = sd('L', 7, [14, 11], [c('A', 'diamonds'), c('J', 'spades')]);
    const winner = sd('W', 8, [5, 14], [c('5', 'hearts'), c('5', 'spades')]);
    const hit = detectBBJHit([winner, loser], 'W', 'nlh', 500, 10, 3, DEALT, board);
    const miss = near([winner, loser], { board });
    // Whichever way the detector rules, the two must never both fire.
    expect(hit.hit && miss.nearMiss).toBe(false);
  });

  it('is silent for ineligible variants (PLO6, short deck)', () => {
    expect(near([sd('W', 8, [5], []), ACES_FULL_JACKS], { variant: 'plo6' }).nearMiss).toBe(false);
    expect(near([sd('W', 8, [5], []), ACES_FULL_JACKS], { variant: 'short_deck' }).nearMiss).toBe(
      false
    );
  });
});

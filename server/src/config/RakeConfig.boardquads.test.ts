/**
 * BOARD-MADE HANDS MUST NOT PAY THE JACKPOT (2026-08-18)
 *
 * Live finding: 3 payouts totalling $11,392.67 landed on hands where the BOARD
 * itself was quads — the most recent on 2026-08-18 15:14. When the board makes
 * four of a kind, no player can have BOTH hole cards playing (at most one
 * kicker plays), so BBJ_RULES.requireBothHoleCards must reject every one.
 *
 * Reconstructed from the real stored hand (#1668): board 6d 6c 6s 6h 4d, the
 * pot won with Kh Jc. These tests assert the CURRENT detector rejects it, and
 * pin the failure mode that let it through — a missing board silently
 * disabling the rule.
 */
import { describe, it, expect } from 'vitest';
import { detectBBJHit } from './RakeConfig.js';

const c = (rank: string, suit: string) => ({ rank, suit });

// The real board from hand #1668.
const BOARD_QUAD_SIXES = [
  c('6', 'diamonds'),
  c('6', 'clubs'),
  c('6', 'spades'),
  c('6', 'hearts'),
  c('4', 'diamonds'),
];

const DEALT = ['W', 'L', 'X'];

// Pot winner: quad sixes playing the board with a king kicker.
const potWinner = {
  userId: 'W',
  handRanking: 8,
  handName: 'Four of a Kind',
  kickers: [6, 13],
  holeCards: [c('K', 'hearts'), c('J', 'clubs')],
};
// Bad-beat holder: same board quads, weaker kicker.
const badBeat = {
  userId: 'L',
  handRanking: 8,
  handName: 'Four of a Kind',
  kickers: [6, 12],
  holeCards: [c('Q', 'spades'), c('T', 'hearts')],
};

describe('board quads can never trigger the jackpot', () => {
  it('rejects hand #1668 exactly as stored (board 6666-4, pot won with KJ)', () => {
    const r = detectBBJHit([potWinner, badBeat], 'W', 'nlh', 500, 10, 3, DEALT, BOARD_QUAD_SIXES);
    expect(r.hit).toBe(false);
  });

  it('rejects a board-made full house too (both cards must play)', () => {
    const board = [
      c('A', 'hearts'),
      c('A', 'clubs'),
      c('A', 'spades'),
      c('J', 'diamonds'),
      c('J', 'clubs'),
    ];
    const winner = {
      ...potWinner,
      kickers: [14, 11],
      holeCards: [c('K', 'spades'), c('2', 'clubs')],
    };
    const loser = {
      ...badBeat,
      kickers: [14, 11],
      holeCards: [c('Q', 'hearts'), c('3', 'spades')],
    };
    const r = detectBBJHit([winner, loser], 'W', 'nlh', 500, 10, 3, DEALT, board);
    expect(r.hit).toBe(false);
  });

  it('still PAYS a genuine bad beat where both hole cards play', () => {
    // Quad fives (pocket pair) beats aces full held with both cards.
    const board = [
      c('A', 'hearts'),
      c('5', 'clubs'),
      c('5', 'spades'),
      c('J', 'diamonds'),
      c('A', 'clubs'),
    ];
    const winner = {
      userId: 'W',
      handRanking: 8,
      handName: 'Four of a Kind',
      kickers: [5, 14],
      holeCards: [c('5', 'hearts'), c('5', 'diamonds')],
    };
    const loser = {
      userId: 'L',
      handRanking: 7,
      handName: 'Full House',
      kickers: [14, 11],
      holeCards: [c('A', 'spades'), c('J', 'hearts')],
    };
    const r = detectBBJHit([winner, loser], 'W', 'nlh', 500, 10, 3, DEALT, board);
    expect(r.hit).toBe(true);
    expect(r.loserUserId).toBe('L');
  });

  it('FAILS CLOSED when no board is supplied - a missing board must not silently disable the rule', () => {
    const r = detectBBJHit([potWinner, badBeat], 'W', 'nlh', 500, 10, 3, DEALT, undefined);
    expect(r.hit).toBe(false);
  });
});

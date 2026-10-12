/**
 * ACES FULL OF JACKS IS THE FLOOR, AND BOTH CARDS PLAY FOR BOTH JACKPOTS
 * ═══════════════════════════════════════════════════════════════════════════
 * Dan, 2026-10-11:
 *
 *   "BBJ for Holdem is Aces full of Jacks but it's paying out any aces full as
 *    a BBJ (DO NOT TAKE THEM AWAY, OR CHANGE THE PREVIOUS RESULTS, JUST MAKE
 *    SURE THAT ITS HARD CODED THAT ACES FULL OF JACKS WITH BOTH CARDS PLAYING
 *    IS THE STANDARD."
 *   "BOTH cards must play for BBJ or Mini BBJ"
 *
 * THE CAUSE of the first. `doesHandQualify` read a full house's pair as
 * `kickers[1]`, believing the kickers were `[trip, pair]`. The engine's
 * evaluator returns all five ranks grouped by count - AAA66 is
 * `[14, 14, 14, 6, 6]` - so `kickers[1]` was always the second Ace and every
 * aces full cleared the Jacks floor. Every older test passed hand-written
 * `[14, 11]` kickers, which is exactly the shape the live engine never sends,
 * so they could not see it. These tests take their hands from the REAL
 * evaluator, so the encoding the detector reads is the one settlement passes.
 *
 * The live hand that showed it: 2026-10-11 07:34 UTC, NLH, board 9 6 6 A 3,
 * pocket aces (aces full of SIXES) beaten by pocket sixes - paid as the main
 * jackpot. Past payouts are left exactly as they were (Dan: "DO NOT TAKE THEM
 * AWAY"); this changes what qualifies from now on.
 */
import { describe, it, expect } from 'vitest';
import { detectBBJHit, detectMiniBBJHit, fullHousePairRank } from './RakeConfig.js';
import { evaluateHand } from '../engine/PokerEngine.js';

type C = { rank: string; suit: string };
const c = (rank: string, suit: string): C => ({ rank, suit });

/** A showdown row exactly as settlement builds it: from the real evaluator. */
function row(userId: string, hole: C[], board: C[]) {
  const h = evaluateHand(hole as never, board as never, false);
  return { userId, handRanking: h.ranking, handName: h.name, kickers: h.kickers, holeCards: hole };
}

const DEALT = ['L', 'W', 'X'];
const main = (rows: ReturnType<typeof row>[], board: C[], variant = 'nlh') =>
  detectBBJHit(rows, 'W', variant, 1000, 10, 3, DEALT, board);
const mini = (rows: ReturnType<typeof row>[], board: C[], variant = 'nlh') =>
  detectMiniBBJHit(rows, 'W', variant, 1000, 10, 3, DEALT, { board });

describe('the evaluator encoding the detector must read', () => {
  it('a full house carries all five ranks, so the pair is NOT kickers[1]', () => {
    const board = [
      c('9', 'spades'),
      c('6', 'hearts'),
      c('6', 'spades'),
      c('A', 'clubs'),
      c('3', 'clubs'),
    ];
    const h = evaluateHand([c('A', 'diamonds'), c('A', 'spades')] as never, board as never, false);
    expect(h.kickers).toEqual([14, 14, 14, 6, 6]);
    expect(fullHousePairRank(h.kickers)).toBe(6);
    // the short fixture form still reads the same way
    expect(fullHousePairRank([14, 11])).toBe(11);
  });
});

describe("hold'em main jackpot: aces full of JACKS or better, both cards playing", () => {
  it('the live hand: aces full of SIXES is NOT a main jackpot - it falls to the mini', () => {
    const board = [
      c('9', 'spades'),
      c('6', 'hearts'),
      c('6', 'spades'),
      c('A', 'clubs'),
      c('3', 'clubs'),
    ];
    const rows = [
      row('L', [c('A', 'diamonds'), c('A', 'spades')], board),
      row('W', [c('6', 'clubs'), c('6', 'diamonds')], board),
    ];
    expect(main(rows, board).hit).toBe(false);
    // Both players use both hole cards, so it is exactly what the mini is for.
    const m = mini(rows, board);
    expect(m.hit).toBe(true);
    expect(m.loserUserId).toBe('L');
  });

  it('aces full of TENS is below the floor', () => {
    const board = [
      c('A', 'clubs'),
      c('T', 'hearts'),
      c('T', 'diamonds'),
      c('8', 'clubs'),
      c('2', 'spades'),
    ];
    const rows = [
      row('L', [c('A', 'diamonds'), c('A', 'spades')], board),
      row('W', [c('T', 'clubs'), c('T', 'spades')], board),
    ];
    expect(rows[0].handName).toBe('Full House');
    expect(main(rows, board).hit).toBe(false);
  });

  it('aces full of JACKS with both cards playing IS the standard - it pays the main', () => {
    const board = [
      c('A', 'clubs'),
      c('J', 'hearts'),
      c('J', 'diamonds'),
      c('8', 'clubs'),
      c('2', 'spades'),
    ];
    const rows = [
      row('L', [c('A', 'diamonds'), c('A', 'spades')], board),
      row('W', [c('J', 'clubs'), c('J', 'spades')], board),
    ];
    const r = main(rows, board);
    expect(r.hit).toBe(true);
    expect(r.loserUserId).toBe('L');
  });

  it('aces full of KINGS pays the main', () => {
    const board = [
      c('A', 'clubs'),
      c('K', 'hearts'),
      c('K', 'diamonds'),
      c('8', 'clubs'),
      c('2', 'spades'),
    ];
    const rows = [
      row('L', [c('A', 'diamonds'), c('A', 'spades')], board),
      row('W', [c('K', 'clubs'), c('K', 'spades')], board),
    ];
    expect(main(rows, board).hit).toBe(true);
  });

  it('aces full of jacks where one hole card does not play is refused', () => {
    /* Board A A J J 2: A-3 makes aces full of jacks, but the 3 does nothing. */
    const board = [
      c('A', 'clubs'),
      c('A', 'hearts'),
      c('J', 'diamonds'),
      c('J', 'clubs'),
      c('2', 'spades'),
    ];
    const rows = [
      row('L', [c('A', 'diamonds'), c('3', 'spades')], board),
      row('W', [c('J', 'hearts'), c('J', 'spades')], board),
    ];
    expect(rows[0].kickers.slice(0, 5)).toEqual([14, 14, 14, 11, 11]);
    expect(main(rows, board).hit).toBe(false);
    expect(mini(rows, board).hit).toBe(false);
  });
});

describe('the mini: both hole cards must play (Dan 2026-10-11)', () => {
  it('an aces full where only one hole card plays is NOT a mini', () => {
    /* Live 2026-10-11 22:31 UTC, paid as a mini: board A 6 K A A, K-7 (aces
       full of kings) lost to A-8 (quad aces). The 7 plays no part in the aces
       full and the 8 plays no part in the quads, so the mini refuses it now. */
    const board = [
      c('A', 'hearts'),
      c('6', 'hearts'),
      c('K', 'clubs'),
      c('A', 'spades'),
      c('A', 'clubs'),
    ];
    const rows = [
      row('L', [c('K', 'hearts'), c('7', 'hearts')], board),
      row('W', [c('A', 'diamonds'), c('8', 'hearts')], board),
    ];
    expect(rows[0].handName).toBe('Full House');
    expect(rows[1].handName).toBe('Four of a Kind');
    expect(mini(rows, board).hit).toBe(false);
  });

  it('board quads are never a mini: nobody plays both cards', () => {
    const board = [
      c('3', 'clubs'),
      c('5', 'clubs'),
      c('3', 'hearts'),
      c('3', 'spades'),
      c('3', 'diamonds'),
    ];
    const rows = [
      row('L', [c('8', 'diamonds'), c('8', 'spades')], board),
      row('W', [c('K', 'clubs'), c('T', 'clubs')], board),
    ];
    expect(mini(rows, board).hit).toBe(false);
  });

  it('Omaha is game-enforced: exactly two always play, so the board never refuses it', () => {
    const board = [
      c('K', 'clubs'),
      c('K', 'hearts'),
      c('5', 'spades'),
      c('9', 'diamonds'),
      c('2', 'clubs'),
    ];
    const rows = [
      {
        userId: 'L',
        handRanking: 8,
        handName: 'Four of a Kind',
        kickers: [5, 5, 5, 5, 13],
        holeCards: [],
      },
      {
        userId: 'W',
        handRanking: 8,
        handName: 'Four of a Kind',
        kickers: [13, 13, 13, 13, 9],
        holeCards: [],
      },
    ];
    expect(mini(rows, board, 'plo4').hit).toBe(true);
  });
});

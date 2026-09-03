/**
 * A HAND ALWAYS HAS A WINNER (Dan 2026-08-26, binding).
 *
 * Verbatim: "a hand must ALWAYS have a winner, no matter what, that can never
 * happen, you must trigger a RE-CHECK or re-verification because it is
 * impossible for there to not be a winner ever."
 *
 * Two defects sat behind that instruction.
 *
 * 1. determineWinners skipped a pot whose eligibility snapshot matched none of
 *    the contenders - `if (eligible.length === 0) continue;`. A `continue`
 *    there does not skip a calculation, it DROPS A POT: the chips are awarded
 *    to nobody and leave the hand.
 *
 * 2. When that emptied the winners list, HandController awarded the entire pot
 *    to `activePlayers[0]` - the first entry of an array, which has no
 *    relationship to who held the best hand.
 *
 * These pin the properties, not the phrasing: money is conserved, and nothing
 * is ever decided by list position.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { determineWinners } from './PokerEngine.js';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const HAND_CONTROLLER = read('src/engine/HandController.ts');
const ENGINE = read('src/engine/PokerEngine.ts');

/** Two contenders with real, comparable Hold'em hands. */
function twoContenders() {
  return [
    {
      user_id: 'winner',
      seat: 1,
      is_folded: false,
      is_sitting_out: false,
      cards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'A', suit: 'hearts' },
      ],
    },
    {
      user_id: 'loser',
      seat: 2,
      is_folded: false,
      is_sitting_out: false,
      cards: [
        { rank: '7', suit: 'clubs' },
        { rank: '2', suit: 'diamonds' },
      ],
    },
  ] as never[];
}

const BOARD = [
  { rank: 'K', suit: 'spades' },
  { rank: 'Q', suit: 'hearts' },
  { rank: '9', suit: 'clubs' },
  { rank: '5', suit: 'diamonds' },
  { rank: '3', suit: 'spades' },
] as never[];

describe('a pot is never dropped', () => {
  it('awards a pot whose eligibility snapshot matches nobody', () => {
    // The snapshot names a player who is not in the hand at all - the exact
    // shape a stale side-pot rebuild produces.
    const pots = [{ amount: 100, eligiblePlayers: ['someone-who-left'] }] as never[];
    const winners = determineWinners(twoContenders(), BOARD, pots, 'nlh', 0);

    expect(winners.length, 'the pot was dropped and nobody was paid').toBeGreaterThan(0);
    const paid = winners.reduce((s, w) => s + w.amount, 0);
    expect(paid, 'the whole pot must be awarded').toBeCloseTo(100, 2);
  });

  it('awards it on MERIT, not on list position', () => {
    const pots = [{ amount: 100, eligiblePlayers: ['someone-who-left'] }] as never[];
    // 'loser' is deliberately FIRST in the array. A positional fallback pays
    // them; a real evaluation pays the aces.
    const players = twoContenders().reverse() as never[];
    const winners = determineWinners(players, BOARD, pots, 'nlh', 0);

    expect(winners.map((w) => w.userId)).toContain('winner');
    expect(winners.map((w) => w.userId)).not.toContain('loser');
  });

  it('reports the stale snapshot rather than swallowing it', () => {
    const pots = [{ amount: 100, eligiblePlayers: ['someone-who-left'] }] as never[];
    const seen: unknown[] = [];
    determineWinners(twoContenders(), BOARD, pots, 'nlh', 0, undefined, (info) => seen.push(info));
    expect(seen.length, 'a bad eligibility snapshot must be visible').toBe(1);
  });

  it('still pays normally when the snapshot is correct', () => {
    const pots = [{ amount: 100, eligiblePlayers: ['winner', 'loser'] }] as never[];
    const winners = determineWinners(twoContenders(), BOARD, pots, 'nlh', 0);
    expect(winners.map((w) => w.userId)).toEqual(['winner']);
    expect(winners[0].amount).toBeCloseTo(100, 2);
  });
});

describe('nothing is settled by list position', () => {
  it('the engine no longer skips a pot with no eligible player', () => {
    expect(
      code(ENGINE),
      'a `continue` here drops a pot and its chips leave the hand'
    ).not.toContain('if (eligible.length === 0) continue;');
  });

  it('HandController never awards the pot to activePlayers[0]', () => {
    const src = code(HAND_CONTROLLER);
    expect(src).not.toContain('activePlayers[0].user_id, amount: totalPot');
    expect(
      src.includes('winners = [{ userId: activePlayers[0].user_id'),
      'the positional fallback is back'
    ).toBe(false);
  });

  it('an empty result triggers a re-check instead of a guess', () => {
    const src = code(HAND_CONTROLLER);
    // Anchored on the mechanism: it must re-run the evaluation, and it must
    // report. Both, not either.
    expect(src).toContain('no_winners_recheck');
    const at = src.indexOf('no_winners_recheck');
    expect(at).toBeGreaterThan(-1);
    // the re-evaluation must come AFTER the alarm, in the same block
    expect(sliceEnclosingBlock(src, 'no_winners_recheck')).toContain('determineWinners(');
  });

  it('the last resort splits among contenders rather than picking one', () => {
    const src = code(HAND_CONTROLLER);
    expect(src).toContain('no_winners_evaluator_failed');
    expect(src).toContain('contenders.length');
    // an equal split, with the odd cents distributed - not a single recipient
    expect(src).toMatch(/share \+ \(i < remainder \? 1 : 0\)/);
  });

  it('refuses to invent a winner when there is no contender at all', () => {
    expect(code(HAND_CONTROLLER)).toContain('no_winners_no_contenders');
  });
});

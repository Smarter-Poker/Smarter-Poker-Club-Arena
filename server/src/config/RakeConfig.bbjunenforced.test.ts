/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TWO BBJ RULES THAT WERE PUBLISHED AND NEVER ENFORCED (2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `BBJ_RULES.excludeDoubleBoard` and `BBJ_RULES.onlyFirstRunout` appeared in
 * exactly two places before today: the constant itself, and the rules panel
 * that TELLS PLAYERS THEY APPLY (BBJBasicPanel.tsx:266-269,
 * BBJRulesPanel.tsx:151). No code read them.
 *
 * So a double-board bomb pot could pay a jackpot that the published rules say
 * it cannot. On a money surface a rules page that disagrees with the engine is
 * not a documentation bug — one of the two is lying to the player, and it was
 * the page.
 *
 * Also here: the chopped-pot false negative. Settlement passed
 * `currentHandWinnerIds[0]`, so on a split pot exactly one winner was
 * examined. If the OTHER one held the quads, the "winner must have quads or
 * better" gate refused a real bad beat and nothing recorded that it had — the
 * player who took the beat simply was not paid.
 */
import { describe, it, expect } from 'vitest';
import { detectBBJHit, BBJ_RULES } from './RakeConfig.js';

/** Quad kings — the PLO4 qualifying minimum, so this loser always qualifies. */
const QUAD_KINGS = {
  userId: 'loser',
  handRanking: 8,
  handName: 'Four of a Kind',
  kickers: [13, 2],
  holeCards: [
    { rank: 'K', suit: 'hearts' },
    { rank: 'K', suit: 'spades' },
    { rank: '7', suit: 'clubs' },
    { rank: '3', suit: 'diamonds' },
  ],
};

const QUAD_ACES = (userId: string) => ({
  userId,
  handRanking: 8,
  handName: 'Four of a Kind',
  kickers: [14, 13],
  holeCards: [
    { rank: 'A', suit: 'hearts' },
    { rank: 'A', suit: 'spades' },
    { rank: '9', suit: 'clubs' },
    { rank: '4', suit: 'diamonds' },
  ],
});

/** A hand that does NOT satisfy "winner must hold quads or better". */
const A_MERE_FLUSH = (userId: string) => ({
  userId,
  handRanking: 6,
  handName: 'Flush',
  kickers: [12, 10, 8, 6, 3],
  holeCards: [
    { rank: 'Q', suit: 'clubs' },
    { rank: 'T', suit: 'clubs' },
    { rank: '2', suit: 'hearts' },
    { rank: '5', suit: 'spades' },
  ],
});

const BOARD = [
  { rank: 'K', suit: 'clubs' },
  { rank: 'K', suit: 'diamonds' },
  { rank: 'A', suit: 'clubs' },
  { rank: 'A', suit: 'diamonds' },
  { rank: '8', suit: 'clubs' },
];

const call = (
  results: Array<Parameters<typeof detectBBJHit>[0][number]>,
  winner: string | string[],
  context?: { doubleBoard?: boolean }
) => detectBBJHit(results, winner, 'plo4', 1000, 2, 4, ['a', 'b', 'c', 'd'], BOARD, context);

describe('excludeDoubleBoard is now a rule and not just a sentence', () => {
  it('is still declared true - the constant is what the rules panel prints', () => {
    expect(BBJ_RULES.excludeDoubleBoard).toBe(true);
  });

  it('pays a genuine bad beat on a single board', () => {
    const r = call([QUAD_KINGS, QUAD_ACES('winner')], 'winner');
    expect(r.hit).toBe(true);
    expect(r.loserUserId).toBe('loser');
  });

  it('refuses the SAME hand when it was a double-board bomb pot', () => {
    const r = call([QUAD_KINGS, QUAD_ACES('winner')], 'winner', { doubleBoard: true });
    expect(r.hit).toBe(false);
  });

  it('treats an absent flag as a normal single-board hand', () => {
    // Every existing caller omits it. Omission must not start refusing payouts.
    expect(call([QUAD_KINGS, QUAD_ACES('winner')], 'winner', {}).hit).toBe(true);
    expect(call([QUAD_KINGS, QUAD_ACES('winner')], 'winner', { doubleBoard: false }).hit).toBe(
      true
    );
  });
});

describe('a chopped pot no longer hides the qualifying winner', () => {
  it('pays when the SECOND of two winners is the one holding quads', () => {
    // This is the false negative. Pre-fix, settlement passed winnerIds[0] —
    // the flush — the quads gate failed, and a real bad beat went unpaid.
    const r = call([QUAD_KINGS, A_MERE_FLUSH('w1'), QUAD_ACES('w2')], ['w1', 'w2']);
    expect(r.hit).toBe(true);
    expect(r.loserUserId).toBe('loser');
    // The rule is applied to the strongest winner, and the result says so.
    expect(r.winnerUserId).toBe('w2');
  });

  it('still refuses when NO winner holds quads', () => {
    const r = call([QUAD_KINGS, A_MERE_FLUSH('w1'), A_MERE_FLUSH('w2')], ['w1', 'w2']);
    expect(r.hit).toBe(false);
  });

  it('never treats a winner as their own bad-beat loser', () => {
    const r = call([QUAD_KINGS, A_MERE_FLUSH('w1'), QUAD_ACES('w2')], ['w1', 'w2']);
    expect(['w1', 'w2']).not.toContain(r.loserUserId);
  });

  it('accepts a bare string, so every existing caller is unchanged', () => {
    const r = call([QUAD_KINGS, QUAD_ACES('winner')], 'winner');
    expect(r.hit).toBe(true);
    expect(r.winnerUserId).toBe('winner');
  });
});

describe('onlyFirstRunout', () => {
  it('is satisfied by construction, not by a condition', () => {
    /**
     * There is deliberately no flag for this one. SHOWDOWN is emitted exactly
     * once per hand (HandController.ts:1559) and BEFORE the extra runouts are
     * dealt in ServerTableEngineRunout, so `showdownResults` is already board
     * one's evaluation — and settlement passes board one's cards to match.
     *
     * The assertion that matters is therefore about the engine's shape, and it
     * lives in ServerTableEngineRunout's own tests. This records the reasoning
     * so the next person to read the rule does not re-derive it, or "fix" it
     * by adding a second showdown emit.
     */
    expect(BBJ_RULES.onlyFirstRunout).toBe(true);
  });
});

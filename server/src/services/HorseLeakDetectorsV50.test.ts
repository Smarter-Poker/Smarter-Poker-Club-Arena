/**
 * V50 ONE PAIR, DEEP, COMMITTED LATE (2026-09-17) - pins the detector added
 * after the 09-16 daily horse audit found that eight of the ten largest
 * UNTAGGED NLH tournament losses were one pair - an overpair or top pair -
 * committed for 200bb to 800bb on the turn or river. The real hands from that
 * sweep are the fixtures (horse_hand_reviews ids in the test names).
 *
 * The tag is a measurement. It records both outcomes (one_pair_deep_stackoff
 * on a loss, one_pair_deep_stackoff_won on a win) so the audit can rank it by
 * EV, and nothing in HorseLogic reads it.
 */

import { describe, it, expect } from 'vitest';
import { detectLeaks } from './HorseHandReview.js';
import type { Card } from '../types.js';

const c = (spec: string): Card => {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] };
};

type Act = { action: string; stage: string; amount?: number };

/** Opened preflop, bet the flop, shoved the turn - the shape the sweep found. */
const turnShove = (amount: number): Act[] => [
  { action: 'raise', stage: 'preflop', amount: 140 },
  { action: 'bet', stage: 'flop', amount: 459 },
  { action: 'all_in', stage: 'turn', amount },
];

function base(overrides: Partial<Parameters<typeof detectLeaks>[0]> = {}) {
  return {
    netBB: -591,
    invested: 28335,
    bigBlind: 50,
    variant: 'nlh',
    holeCards: [c('Qs'), c('Qh')],
    board: [c('6s'), c('Jh'), c('2h'), c('7s'), c('Tc')],
    heroActions: turnShove(28335),
    wentToShowdown: true,
    ...overrides,
  };
}

describe('V50 one_pair_deep_stackoff', () => {
  it('QQ shoving the turn on 6-J-2-7-T for 567bb (review 511597) is one pair, deep, late', () => {
    expect(detectLeaks(base())).toContain('one_pair_deep_stackoff');
  });

  it('KK three-barrelling into an all-in on A-3-2-7-4 for 329bb (review 509437) is tagged', () => {
    expect(
      detectLeaks(
        base({
          netBB: -383,
          invested: 26326,
          bigBlind: 80,
          holeCards: [c('Ks'), c('Kh')],
          board: [c('Ah'), c('3s'), c('2d'), c('7s'), c('4s')],
          heroActions: [
            { action: 'raise', stage: 'preflop', amount: 1452 },
            { action: 'bet', stage: 'flop', amount: 2813 },
            { action: 'bet', stage: 'turn', amount: 7385 },
            { action: 'all_in', stage: 'turn', amount: 26326 },
          ],
        })
      )
    ).toContain('one_pair_deep_stackoff');
  });

  it('a top pair committed on the river for 150bb+ is tagged too, beside the V24 kicker tag', () => {
    // The shape of review 511550 (A6 check-raise-shoving a river for 464bb
    // with top pair, rag kicker) on an unpaired river. The V24 rag-kicker tag
    // fires on the kicker; this one fires on the depth. Both belong. (The
    // real 511550 river paired the board, which makes that hand two pair by
    // category and is exactly why it is not the fixture here.)
    const tags = detectLeaks(
      base({
        netBB: -600,
        invested: 23186 + 4286 + 1300 + 1107 + 71,
        holeCards: [c('6d'), c('Ah')],
        board: [c('3h'), c('Ad'), c('4h'), c('8d'), c('9c')],
        heroActions: [
          { action: 'call', stage: 'preflop', amount: 71 },
          { action: 'raise', stage: 'flop', amount: 1107 },
          { action: 'bet', stage: 'turn', amount: 1300 },
          { action: 'call', stage: 'turn', amount: 4286 },
          { action: 'all_in', stage: 'river', amount: 23186 },
        ],
      })
    );
    expect(tags).toContain('one_pair_deep_stackoff');
    expect(tags).toContain('top_pair_weak_kicker_stackoff');
  });

  it('the win side is recorded under _won so the tag has a denominator', () => {
    expect(detectLeaks(base({ netBB: 591 }))).toContain('one_pair_deep_stackoff_won');
  });

  it('a set is not one pair (QQ on 9-K-Q-8-5, review 504597, is a cooler, not this tag)', () => {
    expect(
      detectLeaks(
        base({
          holeCards: [c('Qc'), c('Qs')],
          board: [c('9d'), c('Kc'), c('Qh'), c('8d'), c('5c')],
        })
      )
    ).not.toContain('one_pair_deep_stackoff');
  });

  it('two pair is not one pair', () => {
    expect(
      detectLeaks(
        base({
          holeCards: [c('Qs'), c('Jc')],
          board: [c('6s'), c('Jh'), c('2h'), c('Qd'), c('Tc')],
        })
      )
    ).not.toContain('one_pair_deep_stackoff');
  });

  it('a flop commit has two cards to come and is a different decision', () => {
    expect(
      detectLeaks(
        base({
          heroActions: [
            { action: 'raise', stage: 'preflop', amount: 140 },
            { action: 'all_in', stage: 'flop', amount: 28335 },
          ],
        })
      )
    ).not.toContain('one_pair_deep_stackoff');
  });

  it('a preflop commit belongs to preflop_stackoff, not this tag', () => {
    const tags = detectLeaks(
      base({
        heroActions: [
          { action: 'raise', stage: 'preflop', amount: 532 },
          { action: 'all_in', stage: 'preflop', amount: 28335 },
        ],
      })
    );
    expect(tags).not.toContain('one_pair_deep_stackoff');
    expect(tags).toContain('preflop_stackoff');
  });

  it('under 150bb is an ordinary pot, not a deep stack-off', () => {
    expect(
      detectLeaks(base({ invested: 7000, heroActions: turnShove(7000), netBB: -140 }))
    ).not.toContain('one_pair_deep_stackoff');
  });

  it('Omaha is owned by the V38 block and never carries this tag', () => {
    expect(
      detectLeaks(
        base({
          variant: 'plo4',
          holeCards: [c('Qs'), c('Qh'), c('3c'), c('8d')],
        })
      )
    ).not.toContain('one_pair_deep_stackoff');
  });
});

/**
 * 2026-09-28 - the NLH one-pair and board-paired two-pair stack-offs, and the
 * Omaha nut hand on a paired board. Fixtures are the hands the 2026-09-27
 * audit sweep found untagged at the top of the loss list.
 */
import { describe, expect, it } from 'vitest';
import { detectLeaks } from './HorseHandReview.js';
import type { Card } from '../types.js';

const c = (spec: string): Card => {
  const suit: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suit[spec[1]] };
};
const cards = (specs: string): Card[] => specs.split(' ').map(c);

const RIVER_JAM = [
  { action: 'call', stage: 'preflop', amount: 100 },
  { action: 'call', stage: 'flop', amount: 300 },
  { action: 'all_in', stage: 'river', amount: 18000 },
];
const TURN_JAM = [
  { action: 'call', stage: 'preflop', amount: 100 },
  { action: 'all_in', stage: 'turn', amount: 18000 },
];

function hand(hole: string, board: string, over: Record<string, unknown> = {}) {
  return detectLeaks({
    netBB: -500,
    invested: 25000,
    bigBlind: 50,
    variant: 'nlh',
    holeCards: cards(hole),
    board: cards(board),
    heroActions: RIVER_JAM,
    wentToShowdown: true,
    ...over,
  } as Parameters<typeof detectLeaks>[0]);
}

describe('one_pair_river_stackoff', () => {
  it.each([
    ['736266 KJ, jack pair', 'Kd Jd', '7d Jc 3h 2s Ts'],
    ['752381 AJ, jack pair', 'As Js', 'Tc 6c Jh 7s 5d'],
    ['738151 KQ, top pair king', 'Kd Qd', '7s 4s Kc 3h 2h'],
    ['743300 KK overpair', 'Ks Kc', 'Jh 4d Tc 2c 3h'],
    ['753294 KK overpair', 'Kd Kh', '3d 5s 9s 4h Qc'],
  ])('%s is tagged', (_name, hole, board) => {
    expect(hand(hole, board)).toContain('one_pair_river_stackoff');
  });

  it('741432 (a three-spade board) is not this shape', () => {
    expect(hand('Qc Kc', '9c Ks 6s 5d 8s')).not.toContain('one_pair_river_stackoff');
  });

  it('a rag-kicker top pair stays V24 only', () => {
    const t = hand('Ks 7d', 'Kc 9h 4d 2s 3c');
    expect(t).toContain('top_pair_weak_kicker_stackoff');
    expect(t).not.toContain('one_pair_river_stackoff');
  });

  it('a stack that went in on the turn is not a river decision', () => {
    expect(hand('Ks Kc', 'Jh 4d Tc 2c 3h', { heroActions: TURN_JAM })).not.toContain(
      'one_pair_river_stackoff'
    );
  });

  it('records the win side under the _won name', () => {
    expect(hand('Ks Kc', 'Jh 4d Tc 2c 3h', { netBB: 500 })).toContain(
      'one_pair_river_stackoff_won'
    );
  });
});

describe('board_paired_two_pair_stackoff', () => {
  it.each([
    ['740479 AJ on T-5-2-A-T', 'Ac Jd', 'Tc 5d 2h As Ts'],
    ['737195 AQ on 4-A-7-7-9', 'Ac Qh', '4c Ah 7c 7d 9s'],
    ['745046 JT on 6-6-3-J-3', 'Js Td', '6h 6s 3d Jd 3c'],
    ['746040 QJ on J-2-Q-2-4', 'Jc Qc', 'Jh 2d Qs 2h 4s'],
  ])('%s is tagged', (_name, hole, board) => {
    expect(hand(hole, board)).toContain('board_paired_two_pair_stackoff');
  });

  it('748012 (bottom two pair on an unpaired board) is not this shape', () => {
    expect(hand('7d 6d', '7s 6h Qs 4d Kc')).not.toContain('board_paired_two_pair_stackoff');
  });
});

describe('plo_paired_board_nut_stackoff', () => {
  function plo(hole: string, board: string) {
    return detectLeaks({
      netBB: -500,
      invested: 25000,
      bigBlind: 50,
      variant: 'plo4',
      holeCards: cards(hole),
      board: cards(board),
      heroActions: RIVER_JAM,
      wentToShowdown: true,
    } as Parameters<typeof detectLeaks>[0]);
  }

  it('756309, the nut flush on a paired board', () => {
    expect(plo('2h 9d 8h Ad', '4d Qd Th 5d 5c')).toContain('plo_paired_board_nut_stackoff');
  });

  it('755841, broadway on a paired board', () => {
    expect(plo('9s Jh Th 8c', 'Kh As Qc Ad 4s')).toContain('plo_paired_board_nut_stackoff');
  });

  it('the nut flush on an unpaired board is not this shape', () => {
    expect(plo('2h 9d 8h Ad', '4d Qd Th 5d 6c')).not.toContain('plo_paired_board_nut_stackoff');
  });
});

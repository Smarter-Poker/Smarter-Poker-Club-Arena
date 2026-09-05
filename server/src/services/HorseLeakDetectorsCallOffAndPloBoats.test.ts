/**
 * THE 2026-09-04 DAILY AUDIT, PINNED (2026-09-05)
 *
 * Three detector defects the daily analysis measured on the real day, each
 * with the real hand as the fixture:
 *
 *  1. A call-off all-in counted as aggression. HandController writes an
 *     all_in with isFullRaise true/false when it moved the bet and with NO
 *     isFullRaise when it did not (a call for everything the player had).
 *     450 of 952 river_raise_war tags and 941 of 7,569 river_aggr_lost tags
 *     on 2026-09-04 were call-offs.
 *  2. plo_naked_trips_stackoff fired on SETS: 275 of its 419 tags were a
 *     pocket pair on an unpaired board, and V40 reads the tag as a rate.
 *  3. No Omaha tag knew a full house from the nut full house; the three
 *     biggest PLO losses of the day were under-fulls in paired-board wars.
 */

import { describe, it, expect } from 'vitest';
import {
  detectLeaks,
  isAggressiveAction,
  omahaBoatIsNut,
  boardHasPair,
} from './HorseHandReview.js';
import type { Card } from '../types.js';

const suitMap: Record<string, Card['suit']> = {
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
  s: 'spades',
};
const c = (spec: string): Card =>
  ({ rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] }) as Card;
const cards = (s: string): Card[] => s.split(' ').map(c);

describe('a call-off all-in is a call, not aggression', () => {
  it('isAggressiveAction reads the HandController discriminator', () => {
    expect(isAggressiveAction({ action: 'bet' })).toBe(true);
    expect(isAggressiveAction({ action: 'raise' })).toBe(true);
    expect(isAggressiveAction({ action: 'all_in', isFullRaise: true })).toBe(true);
    expect(isAggressiveAction({ action: 'all_in', isFullRaise: false })).toBe(true);
    expect(isAggressiveAction({ action: 'all_in' })).toBe(false);
    expect(isAggressiveAction({ action: 'call' })).toBe(false);
  });

  it('review 233658: AQ bets the river, calls off a shove - paid off, not a war', () => {
    // NLH MTT, bb 30. Hero bet 69bb, villain jammed 295bb, hero called for
    // its last 281bb. The old rule counted the call-off as a second river
    // aggression and tagged river_raise_war.
    const tags = detectLeaks({
      netBB: -425.6,
      invested: 12768,
      bigBlind: 30,
      variant: 'nlh',
      holeCards: cards('Ah Qc'),
      board: cards('Ac 2h 6h 4d 5c'),
      heroActions: [
        { action: 'raise', stage: 'preflop', amount: 60, isFullRaise: true },
        { action: 'bet', stage: 'flop', amount: 156, isFullRaise: true },
        { action: 'call', stage: 'flop', amount: 432 },
        { action: 'raise', stage: 'turn', amount: 3696, isFullRaise: true },
        { action: 'bet', stage: 'river', amount: 2082, isFullRaise: true },
        { action: 'all_in', stage: 'river', amount: 8424 },
      ],
      wentToShowdown: true,
    });
    expect(tags).toContain('river_aggr_lost');
    expect(tags).toContain('river_raise_paidoff');
    expect(tags).not.toContain('river_raise_war');
  });

  it('a river that is only a call-off carries no river aggression tag at all', () => {
    const tags = detectLeaks({
      netBB: -180,
      invested: 360,
      bigBlind: 2,
      variant: 'nlh',
      holeCards: cards('Kd Qd'),
      board: cards('Kc 7s 2h 9d 4c'),
      heroActions: [
        { action: 'call', stage: 'preflop', amount: 6 },
        { action: 'call', stage: 'flop', amount: 20 },
        { action: 'call', stage: 'turn', amount: 60 },
        { action: 'all_in', stage: 'river', amount: 360 },
      ],
      wentToShowdown: true,
    });
    expect(tags).not.toContain('river_aggr_lost');
    expect(tags).not.toContain('river_raise_war');
    expect(tags).not.toContain('river_raise_paidoff');
  });

  it('the win side is counted by the same rule - a called-off win is not river_aggr_won', () => {
    const tags = detectLeaks({
      netBB: 180,
      invested: 360,
      bigBlind: 2,
      variant: 'nlh',
      holeCards: cards('Kd Qd'),
      board: cards('Kc 7s 2h 9d 4c'),
      heroActions: [
        { action: 'call', stage: 'preflop', amount: 6 },
        { action: 'all_in', stage: 'river', amount: 360 },
      ],
      wentToShowdown: true,
    });
    expect(tags).not.toContain('river_aggr_won');
    expect(tags).not.toContain('river_raise_war_won');
  });

  it('a raising all-in on the river still escalates a war', () => {
    const tags = detectLeaks({
      netBB: -500,
      invested: 1000,
      bigBlind: 2,
      variant: 'nlh',
      holeCards: cards('6h 6s'),
      board: cards('3d Jh 6d Qs Th'),
      heroActions: [
        { action: 'call', stage: 'preflop', amount: 2 },
        { action: 'bet', stage: 'river', amount: 224, isFullRaise: true },
        { action: 'all_in', stage: 'river', amount: 917, isFullRaise: true },
      ],
      wentToShowdown: true,
    });
    expect(tags).toContain('river_raise_war');
  });

  it('a preflop call-off is a cold-call, not a raise, for the entry detectors', () => {
    // Called a 4bb open for its whole 45bb stack: never took the initiative.
    const tags = detectLeaks({
      netBB: -45,
      invested: 90,
      bigBlind: 2,
      variant: 'nlh',
      holeCards: cards('Ah Jd'),
      board: cards('Ks 9c 4d 2s 7h'),
      heroActions: [{ action: 'all_in', stage: 'preflop', amount: 90 }],
      wentToShowdown: true,
    });
    expect(tags).toContain('coldcall_stackoff');
    expect(tags).toContain('preflop_stackoff');
  });
});

describe('trips and sets are different leaks', () => {
  it('boardHasPair', () => {
    expect(boardHasPair(cards('7h 4h 2c 7d 6h'))).toBe(true);
    expect(boardHasPair(cards('Qd Jc Ts 6s 2h'))).toBe(false);
  });

  it('review 235357: top set on Q-J-T stacked off into a straight is plo_set_stackoff', () => {
    const tags = detectLeaks({
      netBB: -194.32,
      invested: 194.32,
      bigBlind: 1,
      variant: 'plo5',
      holeCards: cards('Qh Qc Kd 8s 4c'),
      board: cards('Qd Jc Ts 6s 2h'),
      heroActions: [
        { action: 'call', stage: 'preflop', amount: 3 },
        { action: 'raise', stage: 'flop', amount: 33, isFullRaise: true },
        { action: 'call', stage: 'flop', amount: 58 },
        { action: 'all_in', stage: 'turn', amount: 293.5, isFullRaise: true },
      ],
      wentToShowdown: true,
    });
    expect(tags).toContain('plo_set_stackoff');
    expect(tags).not.toContain('plo_naked_trips_stackoff');
  });

  it('the #5428599 shape - trip nines on a paired board - is still plo_naked_trips_stackoff', () => {
    const tags = detectLeaks({
      netBB: -169,
      invested: 400,
      bigBlind: 2,
      variant: 'plo6',
      holeCards: cards('As Ad Jc 9d 8c 4d'),
      board: cards('6s 2h 9h 9s 3c'),
      heroActions: [],
      wentToShowdown: true,
    });
    expect(tags).toContain('plo_naked_trips_stackoff');
    expect(tags).not.toContain('plo_set_stackoff');
  });
});

describe('the PLO under-full', () => {
  it('review 190517: sixes full on 7-4-2-7-6 is not the nut boat (sevens full, quad sevens)', () => {
    expect(omahaBoatIsNut(cards('Ah 5d 6s 4d 6d Kh'), cards('7h 4h 2c 7d 6h'))).toBe(false);
  });

  it('review 182170: fives full of threes on 5-6-8-3-5 is the worst boat on the board', () => {
    expect(omahaBoatIsNut(cards('3c 7d 5d 2h 4s 7h'), cards('5s 6s 8c 3h 5c'))).toBe(false);
  });

  it('review 190109: sixes full of nines on 8-6-9-6 loses to nines full and eights full', () => {
    expect(omahaBoatIsNut(cards('9s Ac Kh Qh 3c 6s'), cards('8h 6d 9h 6c 5s'))).toBe(false);
  });

  it('the nut boat: aces full of kings on A-K-K-7-2 with the case ace and both kings dead', () => {
    // Hero holds AA and one K: the remaining deck has one A and one K, so no
    // two cards make quad aces, quad kings or kings full. Aces full of kings
    // is the nuts here (a straight flush is impossible on this board).
    expect(omahaBoatIsNut(cards('Ah Ad Kh 9c'), cards('As Kd Kc 7h 2d'))).toBe(true);
  });

  it('a boat that is NOT the nuts on a paired board is tagged at a full stack', () => {
    const tags = detectLeaks({
      netBB: -526.63,
      invested: 31600,
      bigBlind: 60,
      variant: 'plo6',
      holeCards: cards('Ah 5d 6s 4d 6d Kh'),
      board: cards('7h 4h 2c 7d 6h'),
      heroActions: [
        { action: 'raise', stage: 'preflop', amount: 210, isFullRaise: true },
        { action: 'bet', stage: 'flop', amount: 342, isFullRaise: true },
        { action: 'bet', stage: 'turn', amount: 444, isFullRaise: true },
        { action: 'call', stage: 'turn', amount: 1848 },
        { action: 'raise', stage: 'river', amount: 23310, isFullRaise: true },
        { action: 'all_in', stage: 'river', amount: 28757 },
      ],
      wentToShowdown: true,
    });
    expect(tags).toContain('plo_underfull_stackoff');
    // and the call-off rule: bet, raise, then called the shove = paid off, one
    // hero raise on the river is not a war by itself
    expect(tags).toContain('river_raise_paidoff');
    expect(tags).not.toContain('river_raise_war');
  });

  it('the nut boat at a full stack carries no under-full tag', () => {
    const tags = detectLeaks({
      netBB: -300,
      invested: 600,
      bigBlind: 2,
      variant: 'plo4',
      holeCards: cards('Ah Ad Kh 9c'),
      board: cards('As Kd Kc 7h 2d'),
      heroActions: [{ action: 'all_in', stage: 'river', amount: 600, isFullRaise: true }],
      wentToShowdown: true,
    });
    expect(tags).not.toContain('plo_underfull_stackoff');
  });

  it('does not fire below the 100bb bar', () => {
    const tags = detectLeaks({
      netBB: -60,
      invested: 120,
      bigBlind: 2,
      variant: 'plo4',
      holeCards: cards('6s 6d Ah Kh'),
      board: cards('7h 4h 2c 7d 6h'),
      heroActions: [{ action: 'call', stage: 'river', amount: 100 }],
      wentToShowdown: true,
    });
    expect(tags).not.toContain('plo_underfull_stackoff');
  });
});

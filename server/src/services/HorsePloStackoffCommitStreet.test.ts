/**
 * THE PLO STACK-OFF TAGS READ THE COMMIT STREET (2026-09-11)
 *
 * The V38 PLO stack-off detectors used to judge every hand on the five-card
 * river board, which labels the decision by how the hand ENDED rather than by
 * what hero held when the money went in. Measured over the seven days to
 * 2026-09-10: 64 of 353 plo_toppair_no_redraw_stackoff tags were preflop
 * AA/KK wars, and review 376230 was tagged plo_naked_trips_stackoff for a
 * flop stack-off with aces and the nut flush draw that merely ran out to
 * trips. The real hands are the fixtures.
 */

import { describe, it, expect } from 'vitest';
import { detectLeaks, commitStreet, boardAsOf } from './HorseHandReview.js';
import type { Card } from '../types.js';

const c = (spec: string): Card => {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  const rank = spec.length === 3 ? spec.slice(0, 2) : spec[0];
  return {
    rank: (rank === '10' ? 'T' : rank) as Card['rank'],
    suit: suitMap[spec[spec.length - 1]],
  };
};

type Act = { action: string; stage: string; amount?: number; isFullRaise?: boolean };

describe('commitStreet: the street hero last put chips in on', () => {
  it('is null with no readable actions, so older rows keep the river board', () => {
    expect(commitStreet([])).toBeNull();
    expect(boardAsOf([c('As'), c('Kd'), c('2c'), c('7h'), c('9s')], null)).toHaveLength(5);
  });

  it('skips a fold and a check on the way back', () => {
    const acts: Act[] = [
      { action: 'call', stage: 'preflop', amount: 3 },
      { action: 'bet', stage: 'flop', amount: 10 },
      { action: 'check', stage: 'turn', amount: 0 },
      { action: 'fold', stage: 'river', amount: 0 },
    ];
    expect(commitStreet(acts)).toBe('flop');
  });

  it('a trailing remainder call is not a decision - review 411733 committed preflop', () => {
    // 5-bet war: raise, raise, call off 104.55 preflop; villain shoved his
    // last 22.28 on the flop and hero called it. Invested 178.7.
    const acts: Act[] = [
      { action: 'raise', stage: 'preflop', amount: 5.78, isFullRaise: true },
      { action: 'raise', stage: 'preflop', amount: 51.9, isFullRaise: true },
      { action: 'call', stage: 'preflop', amount: 104.55 },
      { action: 'call', stage: 'flop', amount: 22.28 },
    ];
    expect(commitStreet(acts, 178.7)).toBe('preflop');
    // Without the investment the rule cannot tell a remainder from a call.
    expect(commitStreet(acts)).toBe('flop');
  });

  it('a call-off all_in with no isFullRaise is a call for the remainder rule too', () => {
    const acts: Act[] = [
      { action: 'raise', stage: 'preflop', amount: 50, isFullRaise: true },
      { action: 'call', stage: 'preflop', amount: 200 },
      { action: 'all_in', stage: 'turn', amount: 10 },
    ];
    expect(commitStreet(acts, 260)).toBe('preflop');
  });

  it('boardAsOf slices the flop and the turn', () => {
    const board = [c('Qd'), c('3d'), c('3h'), c('5s'), c('5c')];
    expect(boardAsOf(board, 'flop')).toHaveLength(3);
    expect(boardAsOf(board, 'turn')).toHaveLength(4);
    expect(boardAsOf(board, 'river')).toHaveLength(5);
  });
});

describe('V38 PLO stack-off tags judge the hand hero held when the stack went in', () => {
  it('review 411733: aces stacked off PREFLOP are preflop_stackoff, not a one-pair postflop leak', () => {
    const tags = detectLeaks({
      netBB: -357.46,
      invested: 1790,
      bigBlind: 5,
      variant: 'plo4',
      holeCards: [c('Ah'), c('Ad'), c('7h'), c('6d')],
      board: [c('7c'), c('9c'), c('Jc'), c('8h'), c('2h')],
      heroActions: [
        { action: 'raise', stage: 'preflop', amount: 28.9, isFullRaise: true },
        { action: 'raise', stage: 'preflop', amount: 259.5, isFullRaise: true },
        { action: 'call', stage: 'preflop', amount: 522.75 },
        { action: 'call', stage: 'flop', amount: 111.4 },
      ],
      wentToShowdown: true,
    });
    expect(tags).not.toContain('plo_toppair_no_redraw_stackoff');
    expect(tags).toContain('preflop_stackoff');
  });

  it('review 376230: aces with the nut flush draw on the FLOP is not naked trips because the river paired', () => {
    const tags = detectLeaks({
      netBB: -198.67,
      invested: 395.35,
      bigBlind: 2,
      variant: 'plo5',
      holeCards: [c('Ad'), c('Ac'), c('5d'), c('Kc'), c('4h')],
      board: [c('Qd'), c('3d'), c('3h'), c('5s'), c('5c')],
      heroActions: [
        { action: 'raise', stage: 'preflop', amount: 91, isFullRaise: true },
        { action: 'bet', stage: 'flop', amount: 98, isFullRaise: true },
        { action: 'call', stage: 'flop', amount: 206.35 },
      ],
      wentToShowdown: true,
    });
    expect(tags).not.toContain('plo_naked_trips_stackoff');
    // One pair on the flop, but a flush draw is a live redraw: not this tag.
    expect(tags).not.toContain('plo_toppair_no_redraw_stackoff');
    expect(tags).not.toContain('preflop_stackoff');
  });

  it('review 406071: board trips with A-J kickers called off on the RIVER is still plo_naked_trips_stackoff', () => {
    const tags = detectLeaks({
      netBB: -149.35,
      invested: 744.74,
      bigBlind: 5,
      variant: 'plo4',
      holeCards: [c('9s'), c('As'), c('Jd'), c('7d')],
      board: [c('Js'), c('3c'), c('3s'), c('3h'), c('7c')],
      heroActions: [
        { action: 'raise', stage: 'preflop', amount: 22, isFullRaise: true },
        { action: 'bet', stage: 'flop', amount: 25, isFullRaise: true },
        { action: 'bet', stage: 'turn', amount: 51, isFullRaise: true },
        { action: 'call', stage: 'turn', amount: 204 },
        { action: 'call', stage: 'river', amount: 442.74 },
      ],
      wentToShowdown: true,
    });
    expect(tags).toContain('plo_naked_trips_stackoff');
  });

  it('review 393394: trip fives jammed on the TURN is judged on the four-card board and is still naked trips', () => {
    const tags = detectLeaks({
      netBB: -148.44,
      invested: 148.44,
      bigBlind: 1,
      variant: 'plo4',
      holeCards: [c('9s'), c('9d'), c('5d'), c('Ts')],
      board: [c('3h'), c('5h'), c('5c'), c('Qh'), c('Jd')],
      heroActions: [
        { action: 'call', stage: 'preflop', amount: 3 },
        { action: 'call', stage: 'preflop', amount: 9 },
        { action: 'call', stage: 'flop', amount: 20 },
        { action: 'all_in', stage: 'turn', amount: 116.44, isFullRaise: true },
      ],
      wentToShowdown: true,
    });
    expect(tags).toContain('plo_naked_trips_stackoff');
  });

  it('a one-pair TURN commit with no draw shape is still plo_toppair_no_redraw_stackoff', () => {
    // Aces, rainbow disconnected turn board, no flush draw and no wrap.
    const tags = detectLeaks({
      netBB: -160,
      invested: 320,
      bigBlind: 2,
      variant: 'plo4',
      holeCards: [c('As'), c('Ad'), c('Jc'), c('4h')],
      board: [c('Kh'), c('8s'), c('2c'), c('Td'), c('6s')],
      heroActions: [
        { action: 'raise', stage: 'preflop', amount: 7, isFullRaise: true },
        { action: 'bet', stage: 'flop', amount: 15, isFullRaise: true },
        { action: 'call', stage: 'turn', amount: 298 },
      ],
      wentToShowdown: true,
    });
    expect(tags).toContain('plo_toppair_no_redraw_stackoff');
  });

  it('no readable actions keeps the river-board judgement every existing fixture was pinned on', () => {
    const tags = detectLeaks({
      netBB: -169,
      invested: 400,
      bigBlind: 2,
      variant: 'plo6',
      holeCards: [c('As'), c('Ad'), c('Jc'), c('9d'), c('8c'), c('4d')],
      board: [c('6s'), c('2h'), c('9h'), c('9s'), c('3c')],
      heroActions: [],
      wentToShowdown: true,
    });
    expect(tags).toContain('plo_naked_trips_stackoff');
  });
});

/**
 * V38 PLO STACKOFF DISCIPLINE (Dan 2026-09-03) — pins the two detectors added
 * after hand #5428599: a horse called off 86% of a 169 stack on a paired turn
 * holding trip nines, against the preflop 3-bettor who had already pot-bet the
 * flop. The 2026-09-02 audit panel had proposed the same shape off hand
 * 103011 and NEITHER hand carried a leak tag.
 *
 * The real hand is the fixture.
 */

import { describe, it, expect } from 'vitest';
import { detectLeaks, omahaBoardThreats } from './HorseHandReview.js';
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

/**
 * Hand #5428599, PLO6 $1/$2 Midway Union, horse jerseygavin: A(s)A(d)J(c)9(d)
 * 8(c)4(d) on 6s 2h 9h 9s, 169 invested at a big blind of 2 = 84.5bb... the
 * horse was at 86% of a 169 stack, so the review row carries the full buy-in.
 * Invested is set to a round 100bb here because the detector's bar is 100bb
 * and the point of the fixture is the SHAPE.
 */
function base(overrides: Partial<Parameters<typeof detectLeaks>[0]> = {}) {
  return {
    netBB: -169,
    invested: 400,
    bigBlind: 2,
    variant: 'plo6',
    holeCards: [c('As'), c('Ad'), c('Jc'), c('9d'), c('8c'), c('4d')],
    board: [c('6s'), c('2h'), c('9h'), c('9s'), c('3c')],
    heroActions: [] as Array<{ action: string; stage: string; amount?: number }>,
    wentToShowdown: true,
    ...overrides,
  };
}

describe('V38 plo_naked_trips_stackoff', () => {
  it('the #5428599 shape - trip nines, full stack in, boat live on a paired board', () => {
    expect(detectLeaks(base())).toContain('plo_naked_trips_stackoff');
  });

  it('does not fire below the 100bb bar - a big pot is not a stack-off', () => {
    expect(detectLeaks(base({ invested: 150 }))).not.toContain('plo_naked_trips_stackoff');
  });

  it('does not fire on a WIN - every leak tag is a loss tag', () => {
    expect(detectLeaks(base({ netBB: 169 }))).not.toContain('plo_naked_trips_stackoff');
  });

  it('does not fire when the horse got there - a boat is not naked trips', () => {
    // Aces full: the board pairs the deuce instead, and hero holds two aces.
    expect(
      detectLeaks(
        base({
          board: [c('As'), c('2h'), c('9h'), c('2s'), c('3c')],
        })
      )
    ).not.toContain('plo_naked_trips_stackoff');
  });

  it('does not fire in holdem - this is the Omaha rung', () => {
    expect(
      detectLeaks(
        base({
          variant: 'nlh',
          holeCards: [c('9d'), c('Ad')],
        })
      )
    ).not.toContain('plo_naked_trips_stackoff');
  });
});

describe('V38 plo_toppair_no_redraw_stackoff', () => {
  it('a full stack in with one pair and nothing that got there', () => {
    // Aces, and nothing else: the board is unpaired, rainbow enough that no
    // two hole cards make a flush, and the one straight window holding three
    // board ranks (T-9-8-7-6) needs an eight this hand does not have.
    const tags = detectLeaks(
      base({
        holeCards: [c('As'), c('Kd'), c('Jc'), c('7d'), c('5c'), c('4h')],
        board: [c('Ah'), c('9s'), c('6c'), c('2d'), c('Td')],
      })
    );
    expect(tags).toContain('plo_toppair_no_redraw_stackoff');
    expect(tags).not.toContain('plo_naked_trips_stackoff');
  });

  it('does not fire once a redraw arrived - two pair or better is a different hand', () => {
    expect(
      detectLeaks(
        base({
          holeCards: [c('As'), c('9d'), c('Jc'), c('7d'), c('5c'), c('4h')],
          board: [c('Ah'), c('9s'), c('6c'), c('2d'), c('Td')],
        })
      )
    ).not.toContain('plo_toppair_no_redraw_stackoff');
  });
});

describe('omahaBoardThreats reads the board, never the villain', () => {
  it('a paired board makes a full house live', () => {
    expect(omahaBoardThreats([c('6s'), c('2h'), c('9h'), c('9s'), c('3c')]).fullHouseLive).toBe(
      true
    );
  });
  it('three of a suit makes a flush live', () => {
    expect(omahaBoardThreats([c('6h'), c('2h'), c('9h'), c('Ks'), c('3c')]).flushLive).toBe(true);
  });
  it('three ranks inside one five-card window make a straight live', () => {
    expect(omahaBoardThreats([c('6s'), c('7h'), c('8d'), c('Ks'), c('2c')]).straightLive).toBe(
      true
    );
  });
  it('a rainbow, unpaired, disconnected board threatens nothing', () => {
    const t = omahaBoardThreats([c('2s'), c('7h'), c('Td'), c('Kc'), c('4s')]);
    expect(t.fullHouseLive).toBe(false);
    expect(t.flushLive).toBe(false);
    expect(t.straightLive).toBe(false);
  });
});

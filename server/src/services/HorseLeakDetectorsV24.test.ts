/**
 * V24 KICKER DISCIPLINE (2026-08-30) — pins the two detectors added after the
 * 08-29 GTO sweep found the top of the loss list untagged: trips with a
 * dominated kicker and top pair with a rag kicker, each committing 40bb+.
 * The three real hands from the sweep are the fixtures.
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

function base(overrides: Partial<Parameters<typeof detectLeaks>[0]> = {}) {
  return {
    netBB: -400,
    invested: 20000,
    bigBlind: 50,
    variant: 'nlh',
    holeCards: [c('Qs'), c('Tc')],
    board: [c('2d'), c('Ts'), c('Td'), c('5d'), c('Jh')],
    heroActions: [] as Array<{ action: string; stage: string; amount?: number }>,
    wentToShowdown: true,
    ...overrides,
  };
}

describe('V24 weak_kicker_trips_stackoff', () => {
  it('QT on 2-T-T-5-J (the 453.9bb hand) reads trip tens, queen kicker', () => {
    expect(detectLeaks(base())).toContain('weak_kicker_trips_stackoff');
  });

  it('QJ on J-6-J-T-K (the 440bb hand) reads trip jacks, queen kicker', () => {
    expect(
      detectLeaks(
        base({ holeCards: [c('Qd'), c('Jh')], board: [c('Js'), c('6d'), c('Jd'), c('Ts'), c('Kh')] })
      )
    ).toContain('weak_kicker_trips_stackoff');
  });

  it('AJ on A-3-T-Q-A (the 437bb hand) reads trip aces, jack kicker', () => {
    expect(
      detectLeaks(
        base({ holeCards: [c('Ad'), c('Jd')], board: [c('Ah'), c('3h'), c('Tc'), c('Qh'), c('As')] })
      )
    ).toContain('weak_kicker_trips_stackoff');
  });

  it('an ace kicker cannot be out-kicked, so trips with the ace carry no tag', () => {
    expect(
      detectLeaks(
        base({ holeCards: [c('Kd'), c('Ah')], board: [c('Ks'), c('6d'), c('Kh'), c('Ts'), c('2h')] })
      )
    ).not.toContain('weak_kicker_trips_stackoff');
  });

  it('a kicker that pairs the board is a full house, not tagged trips', () => {
    expect(
      detectLeaks(
        base({ holeCards: [c('Td'), c('5h')], board: [c('2d'), c('Ts'), c('Th'), c('5d'), c('Jh')] })
      )
    ).not.toContain('weak_kicker_trips_stackoff');
  });

  it('a pocket pair matching the board pair is quads, not tagged', () => {
    expect(
      detectLeaks(
        base({ holeCards: [c('Td'), c('Th')], board: [c('2d'), c('Ts'), c('Tc'), c('5d'), c('Jh')] })
      )
    ).not.toContain('weak_kicker_trips_stackoff');
  });

  it('wins carry no leak tags', () => {
    expect(detectLeaks(base({ netBB: 400 }))).toEqual([]);
  });

  it('below 40bb invested the pattern is not a stack-off', () => {
    expect(detectLeaks(base({ invested: 1500 }))).not.toContain('weak_kicker_trips_stackoff');
  });

  it('Omaha hands are out of scope for the two-card kicker read', () => {
    expect(
      detectLeaks(
        base({
          variant: 'plo4',
          holeCards: [c('Qs'), c('Tc'), c('4h'), c('7d')],
        })
      )
    ).not.toContain('weak_kicker_trips_stackoff');
  });
});

describe('V24 top_pair_weak_kicker_stackoff', () => {
  it('K8 jamming a K-high unpaired board reads top pair, rag kicker', () => {
    expect(
      detectLeaks(
        base({ holeCards: [c('Kc'), c('8h')], board: [c('2d'), c('Kd'), c('6h'), c('3h'), c('Qc')] })
      )
    ).toContain('top_pair_weak_kicker_stackoff');
  });

  it('a ten kicker is above the rag bar and carries no tag', () => {
    expect(
      detectLeaks(
        base({ holeCards: [c('Kc'), c('Th')], board: [c('2d'), c('Kd'), c('6h'), c('3h'), c('Qc')] })
      )
    ).not.toContain('top_pair_weak_kicker_stackoff');
  });

  it('second pair is not top pair and carries no tag', () => {
    expect(
      detectLeaks(
        base({ holeCards: [c('Qd'), c('4s')], board: [c('2d'), c('Kd'), c('6h'), c('3h'), c('Qc')] })
      )
    ).not.toContain('top_pair_weak_kicker_stackoff');
  });

  it('a kicker that pairs the board is two pair, not tagged', () => {
    expect(
      detectLeaks(
        base({ holeCards: [c('Kc'), c('6s')], board: [c('2d'), c('Kd'), c('6h'), c('3h'), c('Qc')] })
      )
    ).not.toContain('top_pair_weak_kicker_stackoff');
  });
});

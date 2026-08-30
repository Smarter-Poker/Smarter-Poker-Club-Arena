/**
 * NO OPEN-LIMP (Dan 2026-08-30, binding).
 *
 * First in, a horse raises or folds. It never calls.
 *
 * This is not a style preference, it is the single worst preflop pattern in
 * tournament poker and it was the fleet's DEFAULT. Measured in production
 * over 596 tournament hands in a 25-minute window, before the fix:
 *
 *     open-limps        852        35% of every unraised first action
 *     open-raises       214        so limping beat raising four to one
 *     open-folds      1,098
 *
 *     limps that later faced a raise   458
 *     of those, folded                 419        91.5%
 *
 * Hand #3761806 is the shape Dan screenshotted: six limps for 150, the big
 * blind raises to 1,125, five of the six fold. The pot they surrendered held
 * a 1,200 big-blind ante, so the dead money was eight times the blind.
 *
 * Two properties are pinned here, and they are different claims:
 *   1. an unopened pot is never entered by calling; and
 *   2. a hand that limps BEHIND is strong enough to call a raise, which is
 *      the property that stops the 91.5%.
 */
import { describe, it, expect } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const SUITS: Record<string, CardSuit> = {
  c: 'clubs',
  d: 'diamonds',
  h: 'hearts',
  s: 'spades',
};
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2) {
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  }
  return out;
}

const BB = 150;

/** Seats 1..8, hero at `heroSeat`, button at seat 8 so seat 1 posts the sb. */
function seats(heroSeat: number, hole: string, stack = 32000) {
  return Array.from({ length: 8 }, (_, i) => ({
    seat: i + 1,
    user_id: i + 1 === heroSeat ? 'hero' : `h${i + 1}`,
    stack,
    bet: 0,
    is_folded: false,
    is_sitting_out: false,
    cards: i + 1 === heroSeat ? cards(hole) : [],
  }));
}

function state(heroSeat: number, hole: string, history: unknown[], currentBet = BB) {
  return {
    players: seats(heroSeat, hole),
    communityCards: [],
    // A BIG BLIND ANTE pot, which is the condition that triggered the bug:
    // 75 + 150 + a 1,200 ante = 1,425 before a card is played, so calling 150
    // looks like 9.5% pot odds and the price-in guard rescued every fold.
    pot: BB * 1.5 + BB * 8,
    currentBet,
    minRaise: BB,
    stage: 'preflop',
    gameVariant: 'nlh',
    bigBlind: BB,
    smallBlind: BB / 2,
    dealerSeat: 8,
    format: 'mtt',
    tournament: { id: 't1' },
    actionHistory: history,
  };
}

const BLINDS = [
  { stage: 'preflop', seat: 1, userId: 'h1', action: 'sb', amount: BB / 2 },
  { stage: 'preflop', seat: 2, userId: 'h2', action: 'bb', amount: BB },
];

function decide(heroSeat: number, hole: string, history: unknown[]) {
  const st = state(heroSeat, hole, history);
  const hero = st.players[heroSeat - 1];
  return HorseLogic.decide(hero as never, st as never, 'balanced', {}, {} as never);
}

describe('no open-limp: first in, it is raise or fold', () => {
  /**
   * Hands below any opening threshold, first to act voluntarily. The old code
   * called these for one big blind through a `strength >= 0.3` branch that
   * asked neither the position nor whether anyone had limped first.
   */
  it('never calls an unopened pot, across every seat and a weak-to-medium range', () => {
    const holes = ['9c4d', 'Jc7d', 'Ks6c', 'Qd8s', '7h5c', 'Td9c', '8s6h', 'Ah3c'];
    let calls = 0;
    let total = 0;
    for (let heroSeat = 3; heroSeat <= 8; heroSeat++) {
      for (const hole of holes) {
        for (let trial = 0; trial < 12; trial++) {
          const d = decide(heroSeat, hole, [...BLINDS]);
          total++;
          if (d.action === 'call') calls++;
        }
      }
    }
    expect(total).toBeGreaterThan(500);
    // ZERO. Not "rare" — an unopened pot has no call in it at all.
    expect(calls).toBe(0);
  });

  it('still opens by RAISING, so the fix is not just folding everything', () => {
    let raises = 0;
    for (let trial = 0; trial < 40; trial++) {
      const d = decide(4, 'AhKs', [...BLINDS]);
      if (d.action === 'raise' || d.action === 'all_in') raises++;
    }
    expect(raises).toBeGreaterThan(30);
  });

  it('a premium first in never limps in to trap', () => {
    let calls = 0;
    for (let trial = 0; trial < 60; trial++) {
      const d = decide(5, 'AhAs', [...BLINDS]);
      if (d.action === 'call') calls++;
    }
    expect(calls).toBe(0);
  });
});

describe('limping behind is allowed, but only with a hand that can call a raise', () => {
  const limped = [
    ...BLINDS,
    { stage: 'preflop', seat: 3, userId: 'h3', action: 'call', amount: BB },
    { stage: 'preflop', seat: 4, userId: 'h4', action: 'call', amount: BB },
  ];

  /**
   * THE PROPERTY THAT KILLS THE 91.5%. Whatever the horse limps behind with,
   * that same hand in that same seat must not be a near-certain fold when the
   * pot is then raised. A limp that cannot continue exists only to be
   * surrendered.
   */
  it('anything it limps behind with, it will also continue with against a raise', () => {
    // Search rather than assume where the limp lives. The surviving band is
    // [LIMP_BEHIND_MIN, openThresh), so it is only non-empty where the opening
    // bar is high — early position. Measured: seat 3 limps AcTd and As5s
    // behind a limper and raises everything stronger.
    const holes = ['AcTd', 'As5s', 'AhJd', 'KdQc', '8s8d', 'Qd8s', 'Td9c', 'Ks6c'];
    let limpsSeen = 0;
    for (let heroSeat = 3; heroSeat <= 8; heroSeat++) {
      const limped = [
        ...BLINDS,
        ...(heroSeat > 3
          ? [{ stage: 'preflop', seat: 3, userId: 'h3', action: 'call', amount: BB }]
          : [{ stage: 'preflop', seat: 7, userId: 'h7', action: 'call', amount: BB }]),
      ];
      for (const hole of holes) {
        for (let trial = 0; trial < 20; trial++) {
          const d = decide(heroSeat, hole, limped);
          if (d.action !== 'call') continue;
          limpsSeen++;
          const raisedHistory = [
            ...limped,
            { stage: 'preflop', seat: 2, userId: 'h2', action: 'raise', amount: BB * 4 },
          ];
          const st = state(heroSeat, hole, raisedHistory, BB * 4);
          const hero = st.players[heroSeat - 1];
          let folds = 0;
          for (let k = 0; k < 20; k++) {
            const r = HorseLogic.decide(hero as never, st as never, 'balanced', {}, {} as never);
            if (r.action === 'fold') folds++;
          }
          // It may fold sometimes. It must not be a near-certain fold — that
          // IS the limp-fold pattern, and it ran at 91.5% before this.
          expect(folds).toBeLessThan(19);
        }
      }
    }
    // the band must not be empty everywhere, or "limp behind" is dead code
    expect(limpsSeen).toBeGreaterThan(0);
  });

  it('late position isolates limpers rather than joining them', () => {
    // The button's opening threshold sits below the limp-behind floor, so the
    // surviving band is empty there by construction: any hand good enough to
    // limp behind is good enough to raise.
    let calls = 0;
    let raises = 0;
    for (const hole of ['AhJd', 'KdQc', 'Ts9s', 'Qh8h']) {
      for (let trial = 0; trial < 25; trial++) {
        const d = decide(8, hole, limped);
        if (d.action === 'call') calls++;
        if (d.action === 'raise' || d.action === 'all_in') raises++;
      }
    }
    expect(raises).toBeGreaterThan(0);
    expect(calls).toBe(0);
  });
});

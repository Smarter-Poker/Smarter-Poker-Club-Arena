/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PLO PREFLOP IS PLAYED ON A PERCENTILE, NOT ON THE RAW SCORE
 * (Dan 2026-08-30, from a live PLO spin)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan played a PLO spin, pot-raised every hand, and reported: "horses folded
 * 95% of the time, never even raised, or called when they were first to act."
 *
 * He was right, and it reproduced exactly. `decidePreflopV7`'s thresholds are
 * PERCENTILE-INTENT — they are calibrated against holdemPreflopScore, which
 * is percentile-style. HorseLogic fed them the RAW omahaPreflopScore, whose
 * distribution is compressed:
 *
 *     min 0.000   p25 0.200   median 0.240   p75 0.317   max 0.723
 *
 * so in PLO essentially every hand read as bottom-quartile trash. Measured
 * through the real decide(), 3-max plo4 spin, 300 deals per column:
 *
 *                        BEFORE (raw)              AFTER (percentile)
 *     facing a pot raise fold 188 / raise 1        fold 72 / raise 102
 *     first to act       fold 208 / raise 30       fold 83 / raise 176
 *
 * A 0.3% 3-bet frequency against a player who pots every hand is not a
 * strategy, it is a stuck valve — and it is exactly what a human sees from
 * the other side of the table.
 *
 * HorseEval already carried this diagnosis for HorseMind's BANDS (see the
 * note above placeOmahaBandCombo: "omahaPreflopScore is NOT [percentile-
 * style] ... matching band VALUES against Omaha SCORES selects almost
 * nothing"). The reservoir fixed the reads. Nobody applied it to the
 * decision. omahaPreflopPercentile does, through the same reservoir CDF.
 *
 * These are behavioural floors, deliberately loose: they exist to catch the
 * valve sticking shut again, not to freeze a particular frequency.
 */
import { describe, it, expect } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { omahaPreflopScore, omahaPreflopPercentile } from './HorseEval.js';
import type { Card, SeatPlayer } from '../types.js';

const RANKS = '23456789TJQKA'.split('');
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const C = (r: string, s: string): Card => ({ rank: r, suit: s }) as Card;

function fullDeck(): Card[] {
  const d: Card[] = [];
  for (const r of RANKS) for (const s of SUITS) d.push(C(r, s));
  return d;
}
/** Deterministic dealer so the frequencies below are reproducible. */
function makeDealer(seed: number) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  return (n: number): Card[] => {
    const d = fullDeck();
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d.slice(0, n);
  };
}

describe('omahaPreflopPercentile — the CDF the thresholds always assumed', () => {
  it('the RAW score is compressed: the median PLO hand is nowhere near 0.5', () => {
    const deal = makeDealer(4242);
    const raw: number[] = [];
    for (let i = 0; i < 400; i++) raw.push(omahaPreflopScore(deal(4), false));
    raw.sort((a, b) => a - b);
    // This is the defect being documented, not a target: it must stay true,
    // because it is WHY the percentile mapping has to exist.
    expect(raw[200]).toBeLessThan(0.35);
  });

  it('the PERCENTILE is uniform: median lands near 0.5 and the top reaches 1', () => {
    const deal = makeDealer(4242);
    const pct: number[] = [];
    for (let i = 0; i < 400; i++) pct.push(omahaPreflopPercentile(deal(4), false));
    pct.sort((a, b) => a - b);
    expect(pct[200]).toBeGreaterThan(0.4);
    expect(pct[200]).toBeLessThan(0.6);
    expect(pct[399]).toBeGreaterThan(0.9);
  });

  it('the best PLO hand there is scores at the very top', () => {
    const aakkds = [C('A', 'hearts'), C('A', 'spades'), C('K', 'hearts'), C('K', 'spades')];
    expect(omahaPreflopPercentile(aakkds, false)).toBeGreaterThan(0.97);
  });

  it('5-card and 6-card PLO and hi-lo all map, and never throw', () => {
    const deal = makeDealer(77);
    for (const n of [4, 5, 6]) {
      for (const hiLo of [false, true]) {
        const p = omahaPreflopPercentile(deal(n), hiLo);
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it('fewer than four cards is left alone rather than ranked against Omaha combos', () => {
    const two = [C('A', 'hearts'), C('K', 'spades')];
    expect(omahaPreflopPercentile(two, false)).toBe(omahaPreflopScore(two, false));
  });
});

describe('a PLO horse actually plays back — the live symptom, pinned', () => {
  const mkGs = (hero: SeatPlayer, over: Record<string, unknown>) => ({
    players: [
      hero,
      { seat: 2, user_id: 'human', stack: 48, bet: 2, is_folded: false, cards: [] },
      { seat: 3, user_id: 'other', stack: 50, bet: 0, is_folded: false, cards: [] },
    ],
    communityCards: [],
    pot: 3,
    currentBet: 2,
    minRaise: 2,
    stage: 'preflop',
    gameVariant: 'plo4',
    bigBlind: 2,
    smallBlind: 1,
    dealerSeat: 1,
    actionHistory: [],
    ...over,
  });

  it('FIRST TO ACT it opens a real range instead of folding its way out of the pot', () => {
    const deal = makeDealer(31337);
    const tally: Record<string, number> = {};
    for (let i = 0; i < 300; i++) {
      const hero = {
        seat: 1,
        user_id: `h${i}`,
        stack: 49,
        bet: 1,
        is_folded: false,
        is_sitting_out: false,
        cards: deal(4),
      } as unknown as SeatPlayer;
      const d = HorseLogic.decide(hero, mkGs(hero, {}) as never, 'balanced');
      tally[d.action] = (tally[d.action] || 0) + 1;
    }
    const raises = tally.raise ?? 0;
    // Measured 30/300 before the fix, 176/300 after. The floor catches the
    // valve sticking, and is far below the observed value on purpose.
    expect(raises).toBeGreaterThan(90);
    expect(tally.fold ?? 0).toBeLessThan(180);
  });

  it('FACING A POT-SIZED RAISE it 3-bets and calls instead of folding 95% of the time', () => {
    const deal = makeDealer(2718);
    const tally: Record<string, number> = {};
    for (let i = 0; i < 300; i++) {
      const hero = {
        seat: 3,
        user_id: `g${i}`,
        stack: 48,
        bet: 2,
        is_folded: false,
        is_sitting_out: false,
        cards: deal(4),
      } as unknown as SeatPlayer;
      const gs = mkGs(hero, {
        players: [
          hero,
          { seat: 1, user_id: 'human', stack: 43, bet: 7, is_folded: false, cards: [] },
          { seat: 2, user_id: 'other', stack: 49, bet: 1, is_folded: true, cards: [] },
        ],
        pot: 10,
        currentBet: 7,
        minRaise: 5,
        actionHistory: [
          {
            stage: 'preflop',
            seat: 1,
            userId: 'human',
            action: 'raise',
            amount: 7,
            isFullRaise: true,
          },
        ],
      });
      const d = HorseLogic.decide(hero, gs as never, 'balanced');
      tally[d.action] = (tally[d.action] || 0) + 1;
    }
    const raises = tally.raise ?? 0;
    const folds = tally.fold ?? 0;
    // Measured: raise 1/300 and fold 188/300 before; raise 102 and fold 72
    // after. Dan's "folded 95% of the time, never even raised" was this.
    expect(raises).toBeGreaterThan(20);
    expect(folds).toBeLessThan(150);
  });

  it('the very best hand always plays back — it never limps its way in', () => {
    const aakkds = [C('A', 'hearts'), C('A', 'spades'), C('K', 'hearts'), C('K', 'spades')];
    let raises = 0;
    for (let i = 0; i < 60; i++) {
      const hero = {
        seat: 1,
        user_id: `m${i}`,
        stack: 49,
        bet: 1,
        is_folded: false,
        is_sitting_out: false,
        cards: aakkds,
      } as unknown as SeatPlayer;
      const d = HorseLogic.decide(hero, mkGs(hero, {}) as never, 'balanced');
      if (d.action === 'raise' || d.action === 'all_in') raises++;
    }
    expect(raises).toBeGreaterThan(45);
  });
});

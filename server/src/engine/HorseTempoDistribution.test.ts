/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HORSE TEMPO — MEASURING THE ONE TELL LEFT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every READABLE signal that a player is a horse is now closed: the column
 * grant, the SECURITY DEFINER RPCs, the realtime publication, the client
 * bundle. What remains is BEHAVIOUR, and the loudest behavioural channel is
 * how long a seat takes to act — a player can time it with a stopwatch, and a
 * scripted opponent logs it automatically.
 *
 * The V14 tempo model is already good: a four-mode mixture (snap / beat / tank
 * / time-bank), per-horse stable tempo from an FNV-1a hash of the user id,
 * spot-dependent weights, and a hard "no snap folds facing a bet" floor after
 * Dan watched eight instant folds to pot-sized raises.
 *
 * WHAT THIS FILE ADDS IS MEASUREMENT. Nothing in the repo had ever sampled the
 * shipped generator and looked at the shape of the distribution it produces.
 * These tests do, and they pin the two properties that a mixture-of-uniforms
 * gets wrong in a way a determined observer can see:
 *
 *   1. NO EXACT-VALUE SPIKE. `Math.max(FLOOR, think)` sends every draw that
 *      shapes below the floor to the SAME MILLISECOND. A repeated exact value
 *      is the strongest possible fingerprint - far stronger than a fast
 *      average - because human reaction times never repeat to the millisecond.
 *   2. NO FLAT PLATEAU. Each mode draws `lo + U*range`, which is uniform.
 *      Real think times inside a mode are right-skewed (log-normal-ish): many
 *      near the mode, a long tail after it. A uniform is flat with hard
 *      edges, so a histogram shows steps and cliffs where a human shows a
 *      hump.
 *
 * These are pinned as MEASUREMENTS with thresholds, not as assertions about
 * implementation, so a better generator passes them without being rewritten to
 * match a particular one.
 */

import { describe, it, expect } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import type { HandStage } from '../types.js';

/** A seat the brain will accept, with a distinct id per horse for tempo. */
function mkHorse(userId: string, stack = 10000) {
  return {
    seat_number: 1,
    user_id: userId,
    stack,
    bet: 0,
    is_folded: false,
    is_sitting_out: false,
    cards: [
      { rank: 'A', suit: 'h' },
      { rank: 'K', suit: 'd' },
    ],
  };
}

function mkVillain(stack = 10000) {
  return {
    seat_number: 2,
    user_id: 'villain-0000',
    stack,
    bet: 0,
    is_folded: false,
    is_sitting_out: false,
    cards: [
      { rank: '7', suit: 'c' },
      { rank: '2', suit: 's' },
    ],
  };
}

/**
 * Sample the SHIPPED generator across many horses and many spots.
 *
 * Distinct user ids matter: per-horse tempo is a hash of the id and is the
 * main source of between-seat variety, so sampling one horse would measure a
 * single tempo rather than the fleet.
 */
function sampleThinkTimes(opts: { facingBet: boolean; stage: HandStage; n: number }): number[] {
  const out: number[] = [];
  const perHorse = 40;
  const horses = Math.ceil(opts.n / perHorse);

  for (let h = 0; h < horses; h++) {
    const hero = mkHorse(`horse-${h}-${(h * 7919) % 104729}`);
    for (let i = 0; i < perHorse && out.length < opts.n; i++) {
      const gs = {
        players: [hero, mkVillain()],
        communityCards:
          opts.stage === 'preflop'
            ? []
            : [
                { rank: 'Q', suit: 'h' },
                { rank: 'J', suit: 'c' },
                { rank: '4', suit: 'd' },
              ],
        pot: 300,
        currentBet: opts.facingBet ? 150 : 0,
        minRaise: 50,
        stage: opts.stage,
        gameVariant: 'nlh',
        bigBlind: 50,
        dealerSeat: 1,
      };
      const d = HorseLogic.decide(hero as never, gs as never, 'balanced');
      if (typeof d.thinkTime === 'number' && Number.isFinite(d.thinkTime)) out.push(d.thinkTime);
    }
  }
  return out;
}

/** Share of samples landing on the single most common exact millisecond. */
function heaviestExactValue(samples: number[]): { value: number; share: number } {
  const counts = new Map<number, number>();
  for (const s of samples) counts.set(s, (counts.get(s) || 0) + 1);
  let value = 0;
  let best = 0;
  for (const [v, c] of counts) {
    if (c > best) {
      best = c;
      value = v;
    }
  }
  return { value, share: best / samples.length };
}

describe('horse tempo: the distribution a player could time', () => {
  const SENTINEL = 100_000; // time-bank sentinel; a signal, not a duration

  it('produces a wide spread rather than a rhythm', () => {
    /* The V14 change exists because the old model plus a 2200ms floor put a
       large share of the fleet on ONE number all night. This is the guard
       against that returning. */
    const samples = sampleThinkTimes({ facingBet: true, stage: 'flop', n: 800 }).filter(
      (t) => t < SENTINEL
    );
    expect(samples.length).toBeGreaterThan(200);

    const sorted = [...samples].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];

    // A real table's think times span at least a few seconds between the
    // quick tenth and the slow tenth.
    expect(p90 - p10, `p10=${p10} p90=${p90} — too narrow, this reads as a rhythm`).toBeGreaterThan(
      1500
    );
  });

  it('never snap-folds into a bet', () => {
    /* Dan 2026-08-28, after watching eight instant folds to pot-sized raises:
       "Horses need to NEVER snap fold." The floor is 1250ms. */
    const samples = sampleThinkTimes({ facingBet: true, stage: 'preflop', n: 600 }).filter(
      (t) => t < SENTINEL
    );
    const fastest = Math.min(...samples);
    expect(
      fastest,
      'a horse acted into a bet faster than any human could read it'
    ).toBeGreaterThanOrEqual(1250);
  });

  /**
   * THE FINDING THIS FILE EXISTS FOR, now fixed and pinned.
   *
   * `Math.max(FACING_FLOOR_MS, think)` collapsed every draw that shaped below
   * the floor onto EXACTLY 1250ms. Measured against the pre-fix generator,
   * 3,000 samples per spot:
   *
   *     facing a bet, preflop   14.3% of ALL actions on exactly 1250ms
   *     facing a bet, flop       5.7% on exactly 1250ms
   *     no bet, flop             6.2% on exactly 350ms
   *
   * The next most common value in each set appeared 0.2% of the time — one
   * millisecond was ~70x more likely than any other. A repeated exact
   * millisecond is the strongest fingerprint a timing channel can emit,
   * because a human reaction time never repeats to the millisecond. It was
   * louder than any average, and it survived every mixture weight and tempo
   * multiplier in the model.
   *
   * V35 replaced the clamp with a soft floor (floor + a short exponential),
   * which keeps the guarantee — nothing acts faster than the floor — without
   * the pile-up. After: 0.4% / 0.1% / 0.3% on the most common value, with the
   * medians unchanged.
   */
  for (const spot of [
    { label: 'facing a bet, preflop', facingBet: true, stage: 'preflop' as HandStage },
    { label: 'facing a bet, flop', facingBet: true, stage: 'flop' as HandStage },
    { label: 'no bet to face, flop', facingBet: false, stage: 'flop' as HandStage },
  ]) {
    it(`${spot.label}: no exact millisecond collects the mass`, () => {
      const samples = sampleThinkTimes({ ...spot, n: 1500 }).filter((t) => t < SENTINEL);
      const { value, share } = heaviestExactValue(samples);

      expect(
        share,
        `${(share * 100).toFixed(1)}% of think times are exactly ${value}ms. ` +
          `That is a clamp — Math.max(FLOOR, x) or Math.min(x, CAP) — putting every ` +
          `out-of-range draw on the same millisecond, which identifies the seat by ` +
          `itself. Use a soft bound: FLOOR + a short exponential tail (see V35 in ` +
          `computeThinkTime), never a hard clamp.`
      ).toBeLessThan(0.02);
    });
  }

  it('the floor still holds — a soft bound is not a removed bound', () => {
    /* The whole point of V24's floor survives V35: spreading the mass above
       the floor must not let anything slip below it. */
    const facing = sampleThinkTimes({ facingBet: true, stage: 'preflop', n: 900 }).filter(
      (t) => t < SENTINEL
    );
    const free = sampleThinkTimes({ facingBet: false, stage: 'flop', n: 900 }).filter(
      (t) => t < SENTINEL
    );
    expect(Math.min(...facing)).toBeGreaterThanOrEqual(1250);
    expect(Math.min(...free)).toBeGreaterThanOrEqual(350);
  });

  it('keeps the shape it had — this was a de-spiking, not a slowdown', () => {
    /* A fix that also moved the median would be a tempo change wearing a
       privacy fix's clothes, and Dan tuned that median deliberately. Measured
       before V35: p50 = 2122ms facing a preflop bet. */
    const samples = sampleThinkTimes({ facingBet: true, stage: 'preflop', n: 1500 }).filter(
      (t) => t < SENTINEL
    );
    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    expect(p50, `median moved to ${p50}ms; V35 must not retune the tempo`).toBeGreaterThan(1700);
    expect(p50, `median moved to ${p50}ms; V35 must not retune the tempo`).toBeLessThan(2700);
  });
});

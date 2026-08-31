/**
 * THE AGGRESSION FACTOR IS A POSTFLOP STATISTIC (Dan 2026-08-31).
 *
 * Dan: "they have zero table awareness... I'm literally able to just bet pot
 * pot pot and take it down." The opponent model was in fact tracking him —
 * 590 players, all past the 10-hand gate, up to 16,306 hands on one. It had
 * simply drawn the wrong conclusion:
 *
 *     Dan, as the horses saw him:  VPIP 69.7%   AF 0.67   fold-to-aggr 19.4%
 *
 * AF 0.67 is below the 0.7 "passive" bar, so `exploit()` returned
 * callDownMod 0.85 — "passives get respect" — and the horses folded MORE to
 * the pot bets of the most aggressive player at the table.
 *
 * The cause: aggr/passive counted EVERY street. The classic Aggression
 * Factor is postflop-only because preflop calling is structurally normal
 * (blinds, position, price). A loose-preflop, hyper-aggressive-postflop
 * player is exactly the profile that ratio inverts.
 *
 * Measured on 58 live players with real samples: average AF 1.87 all-streets
 * vs 1.37 postflop-only, and TEN of the 58 misclassified across a decision
 * threshold — two genuine maniacs read as normal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HorseMind } from './HorseMind.js';
import type { SeatPlayer } from '../types.js';

const PLAYERS = [
  {
    seat: 1,
    user_id: 'hero',
    stack: 10000,
    bet: 0,
    is_folded: false,
    is_sitting_out: false,
    cards: [],
  },
  {
    seat: 2,
    user_id: 'dan',
    stack: 10000,
    bet: 0,
    is_folded: false,
    is_sitting_out: false,
    cards: [],
  },
] as unknown as SeatPlayer[];

/**
 * Dan's real shape: calls a LOT preflop (loose), then hammers postflop.
 * `preCalls` preflop calls per hand, then a postflop bet every hand.
 */
function feedLoosePreflopAggressivePostflop(hands: number, preCalls: number) {
  HorseMind.reset();
  for (let h = 0; h < hands; h++) {
    const ts = 1700000000000 + h * 60000;
    const hist: unknown[] = [
      { stage: 'preflop', seat: 1, userId: 'hero', action: 'sb', amount: 50, timestamp: ts },
      { stage: 'preflop', seat: 2, userId: 'dan', action: 'bb', amount: 100, timestamp: ts + 1 },
      {
        stage: 'preflop',
        seat: 1,
        userId: 'hero',
        action: 'raise',
        amount: 300,
        timestamp: ts + 2,
      },
    ];
    for (let c = 0; c < preCalls; c++) {
      hist.push({
        stage: 'preflop',
        seat: 2,
        userId: 'dan',
        action: 'call',
        amount: 300,
        timestamp: ts + 10 + c,
      });
    }
    // postflop: dan bets, hero folds — the pot-pot-pot pattern
    hist.push({
      stage: 'flop',
      seat: 2,
      userId: 'dan',
      action: 'bet',
      amount: 600,
      timestamp: ts + 30,
    });
    hist.push({
      stage: 'flop',
      seat: 1,
      userId: 'hero',
      action: 'fold',
      amount: 0,
      timestamp: ts + 31,
    });
    HorseMind.observe(hist as never, PLAYERS);
  }
  return HorseMind.getStats('dan');
}

beforeEach(() => HorseMind.reset());
afterEach(() => HorseMind.reset());

describe('the counters separate the streets', () => {
  it('postflop counters exist and exclude preflop calls', () => {
    const s = feedLoosePreflopAggressivePostflop(40, 2)!;
    expect(s.passive).toBeGreaterThan(s.postPassive); // preflop calls excluded
    expect(s.postAggr).toBeGreaterThan(0);
    expect(s.postPassive).toBe(0); // dan never calls postflop, he bets
  });
});

describe("Dan's profile no longer reads as passive", () => {
  /**
   * THE REGRESSION PIN. With two preflop calls per hand and one postflop
   * bet, the all-streets ratio is 1/2 = 0.5 — under the 0.7 passive bar,
   * which sets callDownMod to 0.85 and makes the horses RESPECT his bets.
   * Postflop-only it is a pure aggressor.
   */
  it('a loose-preflop, pot-every-flop player is NOT respected as passive', () => {
    feedLoosePreflopAggressivePostflop(40, 2);
    const e = HorseMind.exploit('dan');
    // 0.85 is the "passive, give his bets more respect" value. It must not
    // be what this profile produces.
    expect(e.callDownMod).toBeGreaterThan(0.85);
  });

  it('a genuinely passive player IS still respected', () => {
    HorseMind.reset();
    for (let h = 0; h < 40; h++) {
      const ts = 1700000000000 + h * 60000;
      HorseMind.observe(
        [
          { stage: 'preflop', seat: 1, userId: 'hero', action: 'sb', amount: 50, timestamp: ts },
          {
            stage: 'preflop',
            seat: 2,
            userId: 'dan',
            action: 'bb',
            amount: 100,
            timestamp: ts + 1,
          },
          {
            stage: 'preflop',
            seat: 1,
            userId: 'hero',
            action: 'raise',
            amount: 300,
            timestamp: ts + 2,
          },
          {
            stage: 'preflop',
            seat: 2,
            userId: 'dan',
            action: 'call',
            amount: 300,
            timestamp: ts + 3,
          },
          { stage: 'flop', seat: 1, userId: 'hero', action: 'bet', amount: 400, timestamp: ts + 4 },
          { stage: 'flop', seat: 2, userId: 'dan', action: 'call', amount: 400, timestamp: ts + 5 },
          { stage: 'turn', seat: 1, userId: 'hero', action: 'bet', amount: 800, timestamp: ts + 6 },
          { stage: 'turn', seat: 2, userId: 'dan', action: 'call', amount: 800, timestamp: ts + 7 },
        ] as never,
        PLAYERS
      );
    }
    const e = HorseMind.exploit('dan');
    expect(e.callDownMod).toBeLessThan(1); // a true station gets respect
  });
});

describe('the fallback keeps a thin sample honest', () => {
  it('under 10 postflop actions it uses the all-streets ratio, not noise', () => {
    HorseMind.reset();
    // 12 hands, ONE postflop bet each = 12 postflop actions... use 4 hands so
    // the postflop sample stays under the gate while `hands` clears 10 via
    // preflop-only hands.
    for (let h = 0; h < 30; h++) {
      const ts = 1700000000000 + h * 60000;
      const hist: unknown[] = [
        { stage: 'preflop', seat: 1, userId: 'hero', action: 'sb', amount: 50, timestamp: ts },
        { stage: 'preflop', seat: 2, userId: 'dan', action: 'bb', amount: 100, timestamp: ts + 1 },
        {
          stage: 'preflop',
          seat: 1,
          userId: 'hero',
          action: 'raise',
          amount: 300,
          timestamp: ts + 2,
        },
        {
          stage: 'preflop',
          seat: 2,
          userId: 'dan',
          action: 'call',
          amount: 300,
          timestamp: ts + 3,
        },
      ];
      HorseMind.observe(hist as never, PLAYERS);
    }
    const s = HorseMind.getStats('dan')!;
    expect(s.postAggr + s.postPassive).toBeLessThan(10);
    // No postflop sample at all -> the profile still resolves without throwing
    // and reads the all-streets ratio (pure caller -> passive).
    const e = HorseMind.exploit('dan');
    expect(e.callDownMod).toBeLessThanOrEqual(1);
  });
});

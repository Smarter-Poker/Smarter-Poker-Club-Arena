/**
 * THE TUNER STOPS FIGHTING THE RAKE, AND STUDIES EVERY HORSE (2026-09-05)
 *
 * Measured on 2026-09-04: the fleet's cash net was -32.0 bb/100 over 2.67M
 * seat-hands and the day's rake plus BBJ drop equalled the horse loss to
 * within one percent. The regression rule read that as 221 broken horses
 * out of 383 and halved their dials. These tests pin the three corrections:
 *
 *   1. the regression rule judges the RAKE-ADJUSTED result and only a horse
 *      in the fleet's worst quarter;
 *   2. the leak gates are rates per reviewed hand, not counts;
 *   3. the settlement path compiles rake_bb and horse_daily_play rows with the
 *      tuner's own accumulator, so every horse is studied from its own rows.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase/client.js', () => ({
  supabase: { rpc: vi.fn(async () => ({ data: 1, error: null })), from: vi.fn() },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

import {
  diagnoseAndNudge,
  fleetQuartile,
  LEAK_RATE_GATES,
  MIN_LEAK_HANDS_FOR_RATE,
  MIN_REAL_HANDS_FOR_BB100,
  REGRESS_BB100,
  type PlayStats,
} from './HorseSelfTuner.js';
import {
  accumulateHorseNets,
  drainHorseNets,
  drainHorsePlay,
  type HorseReviewInput,
} from './HorseHandReview.js';

const clean: PlayStats = {
  hands: 5000,
  vpip: 1200,
  pfr: 800,
  threeBets: 100,
  threeBetOpps: 900,
  openRaises: 700,
  faced3Bets: 100,
  foldTo3Bets: 45,
  sawFlop: 2500,
  wonWhenSawFlop: 1150,
  postAggr: 900,
  postPassive: 600,
  netBB: 0,
};
const dials = { tightness: 1.1, aggression: 1.12, bluffFreq: 0.9 };

describe('the regression rule judges the rake-adjusted result', () => {
  it('a horse at -32 raw that is -3 after rake is NOT regressed', () => {
    const r = diagnoseAndNudge(clean, dials, -32, MIN_REAL_HANDS_FOR_BB100, null, {
      rakeBB100: 29,
    });
    expect(r.mods.tightness).toBe(1.1);
    expect(r.mods.aggression).toBe(1.12);
    expect(r.mods.bluffFreq).toBe(0.9);
    expect(r.reasons.join(' ')).toContain('after 29.0 rake');
    expect(r.reasons.join(' ')).toContain("the game's edge, not a leak");
  });

  it('a horse still under the threshold after rake, and in the worst quarter, regresses', () => {
    const r = diagnoseAndNudge(clean, dials, -60, MIN_REAL_HANDS_FOR_BB100, null, {
      rakeBB100: 29,
      fleetP25: -20,
    });
    expect(r.mods.tightness).toBeCloseTo(1.05, 5);
    expect(r.mods.aggression).toBeCloseTo(1.06, 5);
    expect(r.mods.bluffFreq).toBeCloseTo(0.95, 5);
    expect(r.reasons.join(' ')).toContain('regress dials halfway');
  });

  it('a horse losing after rake but NOT in the worst quarter is left alone', () => {
    // Fleet-wide rake night: everyone is -20 after rake, p25 is -25.
    const r = diagnoseAndNudge(clean, dials, -49, MIN_REAL_HANDS_FOR_BB100, null, {
      rakeBB100: 29,
      fleetP25: -25,
    });
    expect(r.mods.tightness).toBe(1.1);
    expect(r.reasons.join(' ')).toContain('not under fleet p25');
  });

  it('with no rake and no fleet figure, the old raw rule stands unchanged', () => {
    const r = diagnoseAndNudge(clean, dials, -22, MIN_REAL_HANDS_FOR_BB100);
    expect(r.mods.tightness).toBeCloseTo(1.05, 5);
    expect(r.reasons.join(' ')).toContain('regress dials halfway');
  });

  it('the fleet quartile is the first quartile of rake-adjusted bb/100, and null on a thin fleet', () => {
    const nets = new Map<string, { hands: number; netBB: number; rakeBB: number }>();
    for (let i = 0; i < 40; i++) {
      // raw i - 40 bb/100 spread; rake 20 bb/100 on every horse
      nets.set(`h${i}`, { hands: 2000, netBB: ((i - 40) * 2000) / 100, rakeBB: 400 });
    }
    const p25 = fleetQuartile(nets);
    expect(p25).not.toBeNull();
    // adjusted values are i - 20 for i in 0..39 -> p25 at position 9.75 = -10.25
    expect(p25!).toBeCloseTo(-10.25, 5);
    const thin = new Map([...nets].slice(0, 5));
    expect(fleetQuartile(thin)).toBeNull();
    // small samples are ignored
    nets.set('tiny', { hands: 10, netBB: -9000, rakeBB: 0 });
    expect(fleetQuartile(nets)!).toBeCloseTo(-10.25, 5);
  });

  it('the threshold is -15 after rake', () => {
    expect(REGRESS_BB100).toBe(-15);
  });
});

describe('leak gates are rates per reviewed hand', () => {
  it('six stackoffs over 600 reviewed hands (1%) do not trip the 3% gate', () => {
    const r = diagnoseAndNudge(
      clean,
      dials,
      null,
      0,
      { nonnut_flush_stackoff: 6 },
      { leaksHands: 600 }
    );
    expect(r.reasons.join(' ')).not.toContain('stackoffs');
    expect(r.mods.tightness).toBe(1.1);
  });

  it('six stackoffs over 100 reviewed hands (6%) trip it, and the reason is a rate', () => {
    const r = diagnoseAndNudge(
      clean,
      dials,
      null,
      0,
      { nonnut_flush_stackoff: 6 },
      { leaksHands: 100 }
    );
    expect(r.reasons.join(' ')).toContain('6.0/100 reviewed dominated-hand stackoffs');
    expect(r.mods.tightness).toBeCloseTo(1.11, 5);
  });

  it('without a denominator the count gates stand, so older callers are unchanged', () => {
    const r = diagnoseAndNudge(clean, dials, null, 0, { big_bet_fold: 10 });
    expect(r.reasons.join(' ')).toContain('10 big bluffs surrendered');
  });

  it('a denominator under the minimum falls back to counts', () => {
    const r = diagnoseAndNudge(
      clean,
      dials,
      null,
      0,
      { preflop_stackoff: 8 },
      {
        leaksHands: MIN_LEAK_HANDS_FOR_RATE - 1,
      }
    );
    expect(r.reasons.join(' ')).toContain('8 preflop stackoffs');
  });

  it('the gates at the window they replaced are the same bar', () => {
    expect(LEAK_RATE_GATES.stackoff * 200).toBe(6);
    expect(LEAK_RATE_GATES.bigBetFold * 200).toBe(10);
    expect(LEAK_RATE_GATES.preflopStackoff * 200).toBe(8);
  });
});

function input(over: Partial<HorseReviewInput> = {}): HorseReviewInput {
  return {
    handId: 'h-1',
    tableId: 't-1',
    tournamentId: null,
    clubId: null,
    gameVariant: 'nlh',
    bigBlind: 2,
    playedAt: '2026-09-05T12:00:00.000Z',
    potSize: 40,
    board: null,
    holeCardsAll: new Map([
      ['horse-a', { seat: 1, cards: [] }],
      ['horse-b', { seat: 2, cards: [] }],
      ['human-1', { seat: 3, cards: [] }],
    ]),
    contributions: new Map([
      ['horse-a', 10],
      ['horse-b', 6],
      ['human-1', 4],
    ]),
    winners: [{ userId: 'horse-a', amount: 18 }],
    actions: [
      { seat: 1, userId: 'horse-a', action: 'raise', amount: 6, stage: 'preflop' },
      { seat: 2, userId: 'horse-b', action: 'call', amount: 6, stage: 'preflop' },
      { seat: 3, userId: 'human-1', action: 'call', amount: 4, stage: 'preflop' },
      { seat: 1, userId: 'horse-a', action: 'bet', amount: 4, stage: 'flop' },
      { seat: 2, userId: 'horse-b', action: 'fold', stage: 'flop' },
      { seat: 3, userId: 'human-1', action: 'fold', stage: 'flop' },
    ],
    roster: [
      { userId: 'horse-a', isHorse: true },
      { userId: 'horse-b', isHorse: true },
      { userId: 'human-1', isHorse: false },
    ],
    rakeAmount: 2,
    buttonSeat: 3,
    ...over,
  };
}

describe('settlement compiles the rake and the play counts', () => {
  it('rake_bb is the weighted-contributed share, in bb, per horse', () => {
    drainHorseNets(10_000);
    drainHorsePlay(10_000);
    accumulateHorseNets(input());
    const rows = drainHorseNets();
    const a = rows.find((r) => r.horse_user_id === 'horse-a')!;
    const b = rows.find((r) => r.horse_user_id === 'horse-b')!;
    // rake 2 chips over contributions 10/6/4: a pays 1.00, b 0.60 (bb = 2)
    expect(a.rake_bb).toBeCloseTo(0.5, 5);
    expect(b.rake_bb).toBeCloseTo(0.3, 5);
    expect(a.net_bb).toBeCloseTo(4, 5);
    // humans never appear
    expect(rows.find((r) => r.horse_user_id === 'human-1')).toBeUndefined();
  });

  it('a hand with no rake accumulates rake_bb 0 and the old shape', () => {
    drainHorseNets(10_000);
    drainHorsePlay(10_000);
    accumulateHorseNets(input({ rakeAmount: undefined }));
    const rows = drainHorseNets();
    expect(rows.every((r) => r.rake_bb === 0)).toBe(true);
  });

  it('horse_daily_play rows carry the same counts the tuner derives, for horses only', () => {
    drainHorseNets(10_000);
    drainHorsePlay(10_000);
    accumulateHorseNets(input());
    accumulateHorseNets(input({ handId: 'h-2' }));
    const rows = drainHorsePlay();
    expect(rows.map((r) => r.horse_user_id).sort()).toEqual(['horse-a', 'horse-b']);
    const a = rows.find((r) => r.horse_user_id === 'horse-a')!;
    expect(a).toMatchObject({ day: '2026-09-05', format: 'cash', hands: 2, vpip: 2, pfr: 2 });
    expect(a.open_raises).toBe(2);
    expect(a.saw_flop).toBe(2);
    expect(a.won_when_saw_flop).toBe(2);
    expect(a.post_aggr).toBe(2);
    const b = rows.find((r) => r.horse_user_id === 'horse-b')!;
    expect(b).toMatchObject({ hands: 2, vpip: 2, pfr: 0, post_passive: 0 });
  });

  it('a tournament hand lands under format tournament so the cash-only tuner can skip it', () => {
    drainHorseNets(10_000);
    drainHorsePlay(10_000);
    accumulateHorseNets(input({ tournamentId: 'tny-1' }));
    const rows = drainHorsePlay();
    expect(rows.every((r) => r.format === 'tournament')).toBe(true);
  });
});

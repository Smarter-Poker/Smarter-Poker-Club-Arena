/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAW: THE DROP IS THE RAKE AND THE JACKPOT (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The third instance of one defect, and the one that finally closes it: an
 * incomplete drop accounting judged against a band that assumes no drop.
 *
 * The fleet plays itself. A closed system nets to ZERO minus what the house
 * takes out of it, so any residual the tuner cannot explain is house take it
 * is about to read as a leak. Measured on 2026-09-06, the first full day the
 * rake attribution ran, over 11,687 cash hands and 31,186 horse seat-hands:
 *
 *   horse net                     -10,797 bb
 *   attributed rake                 +9,020 bb   (99.1% of the 9,103 taken)
 *   ─────────────────────────────────────────
 *   residual after rake             -1,778 bb
 *   bad-beat-jackpot drop at table  +1,761 bb   <- a 1.0% match
 *   ─────────────────────────────────────────
 *   TRUE SKILL RESULT                    ~0 bb
 *
 * The fleet's real bb/100 is 0.0, not -34.5. HorseHandReview had carried the
 * note "the fleet's -32 bb/100 was the day's rake PLUS BBJ DROP to within one
 * percent" since 2026-09-05 and implemented only the rake half, leaving 5.6
 * bb/100 of house take reaching the regression rule as though it were skill.
 *
 * This law pins:
 *
 *   1. settlement allocates the jackpot fee with the SAME allocator as the
 *      rake, over the same contributions, so bbj_bb agrees with the money
 *      pipeline the way rake_bb already does;
 *   2. the row carries it and the drain/requeue does not lose it;
 *   3. the regression rule judges net + rake + JACKPOT;
 *   4. each half is optional and independent - an older row with no jackpot
 *      behaves exactly as it did before;
 *   5. fleetQuartile is drop-adjusted on both halves, so the fleet-relative
 *      gate and the absolute gate agree about what a result is.
 *
 * fn_audit_fleet_drop_identity is the production twin: it asserts the closed
 * system nightly and reports the attribution share, so an unattributed drop
 * is a finding rather than a slow regression of the whole fleet.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('./supabase/client.js', () => ({
  supabase: { rpc: vi.fn(async () => ({ data: 1, error: null })), from: vi.fn() },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

import {
  accumulateHorseNets,
  drainHorseNets,
  drainHorsePlay,
  type HorseReviewInput,
} from './HorseHandReview.js';
import {
  diagnoseAndNudge,
  fleetQuartile,
  MIN_REAL_HANDS_FOR_BB100,
  type PlayStats,
} from './HorseSelfTuner.js';

const SRC = join(process.cwd(), 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

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

function input(over: Partial<HorseReviewInput> = {}): HorseReviewInput {
  return {
    handId: 'drop-1',
    tableId: 't-1',
    tournamentId: null,
    clubId: null,
    gameVariant: 'nlh',
    bigBlind: 2,
    playedAt: '2026-09-06T12:00:00.000Z',
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
    winners: [{ userId: 'horse-a', amount: 17 }],
    actions: [
      { seat: 1, userId: 'horse-a', action: 'raise', amount: 6, stage: 'preflop' },
      { seat: 2, userId: 'horse-b', action: 'call', amount: 6, stage: 'preflop' },
      { seat: 3, userId: 'human-1', action: 'call', amount: 4, stage: 'preflop' },
    ],
    roster: [
      { userId: 'horse-a', isHorse: true },
      { userId: 'horse-b', isHorse: true },
      { userId: 'human-1', isHorse: false },
    ],
    rakeAmount: 2,
    bbjAmount: 1,
    buttonSeat: 3,
    ...over,
  };
}

describe('LAW: the drop is the rake and the jackpot', () => {
  it('the jackpot fee is allocated by weighted contribution, like the rake', () => {
    drainHorseNets(10_000);
    drainHorsePlay(10_000);
    accumulateHorseNets(input());
    const rows = drainHorseNets(10_000);
    const a = rows.find((r) => r.horse_user_id === 'horse-a')!;
    const b = rows.find((r) => r.horse_user_id === 'horse-b')!;
    // contributions 10 / 6 / 4 of 20; bb = 2.
    // rake 2 chips -> a 1.00, b 0.60 -> 0.50bb and 0.30bb (the existing law)
    expect(a.rake_bb).toBeCloseTo(0.5, 5);
    expect(b.rake_bb).toBeCloseTo(0.3, 5);
    // jackpot 1 chip -> a 0.50, b 0.30 -> 0.25bb and 0.15bb, same weights
    expect(a.bbj_bb).toBeCloseTo(0.25, 5);
    expect(b.bbj_bb).toBeCloseTo(0.15, 5);
    // the non-horse seat is never given a row
    expect(rows.find((r) => r.horse_user_id === 'human-1')).toBeUndefined();
  });

  it('a hand with no jackpot drop records zero, not undefined', () => {
    drainHorseNets(10_000);
    drainHorsePlay(10_000);
    accumulateHorseNets(input({ handId: 'no-bbj', bbjAmount: undefined }));
    const a = drainHorseNets(10_000).find((r) => r.horse_user_id === 'horse-a')!;
    expect(a.bbj_bb).toBe(0);
    expect(a.rake_bb).toBeCloseTo(0.5, 5);
  });

  it('the regression rule judges net + rake + jackpot', () => {
    // -32 raw, 26 rake and 6 jackpot: -0.0 after the whole drop, not broken.
    const r = diagnoseAndNudge(clean, dials, -32, MIN_REAL_HANDS_FOR_BB100, null, {
      rakeBB100: 26,
      bbjBB100: 6,
      fleetP25: -60,
    });
    expect(r.mods.tightness).toBe(1.1);
    expect(r.reasons.join(' ')).toContain('after 32.0 drop');
  });

  it('without the jackpot half the same horse WAS regressed - this is the bug', () => {
    // The identical horse, judged on the rake alone: -6.0 adjusted, under the
    // -15 threshold only once the fleet gate also lets it through. Pin the
    // arithmetic difference so nobody "simplifies" bbjBB100 away.
    const withBoth = diagnoseAndNudge(clean, dials, -50, MIN_REAL_HANDS_FOR_BB100, null, {
      rakeBB100: 26,
      bbjBB100: 12,
      fleetP25: -20,
    });
    const rakeOnly = diagnoseAndNudge(clean, dials, -50, MIN_REAL_HANDS_FOR_BB100, null, {
      rakeBB100: 26,
      fleetP25: -20,
    });
    // -50 + 38 = -12: above the -15 threshold, left alone.
    expect(withBoth.mods.tightness).toBe(1.1);
    // -50 + 26 = -24: under the threshold AND under p25, regressed.
    expect(rakeOnly.mods.tightness).toBeCloseTo(1.05, 5);
  });

  it('either half alone still works, and neither means the old raw rule', () => {
    const bbjOnly = diagnoseAndNudge(clean, dials, -20, MIN_REAL_HANDS_FOR_BB100, null, {
      bbjBB100: 10,
      fleetP25: -60,
    });
    expect(bbjOnly.mods.tightness).toBe(1.1);
    expect(bbjOnly.reasons.join(' ')).toContain('after 10.0 drop');

    const neither = diagnoseAndNudge(clean, dials, -22, MIN_REAL_HANDS_FOR_BB100);
    expect(neither.mods.tightness).toBeCloseTo(1.05, 5);
    expect(neither.reasons.join(' ')).toContain('regress dials halfway');
  });

  it('the fleet quartile is adjusted on both halves', () => {
    const nets = new Map<string, { hands: number; netBB: number; rakeBB: number; bbjBB: number }>();
    for (let i = 0; i < 40; i++) {
      // raw (i - 40) bb/100; 15 bb/100 rake and 5 bb/100 jackpot on every horse
      nets.set(`h${i}`, {
        hands: 2000,
        netBB: ((i - 40) * 2000) / 100,
        rakeBB: 300,
        bbjBB: 100,
      });
    }
    // adjusted values are i - 20 for i in 0..39 -> p25 at position 9.75
    expect(fleetQuartile(nets)!).toBeCloseTo(-10.25, 5);
    // An older caller with no bbjBB is unchanged: adjusted is i - 25, so the
    // quartile sits a full 5 bb/100 lower - which is exactly the house take
    // this law exists to stop counting as skill.
    const legacy = new Map(
      [...nets].map(([k, v]) => [k, { hands: v.hands, netBB: v.netBB, rakeBB: v.rakeBB }])
    );
    expect(fleetQuartile(legacy)!).toBeCloseTo(-15.25, 5);
  });

  it('settlement carries the jackpot fee the whole way, on one allocator', () => {
    const hh = read('services/supabase/handHistory.ts');
    expect(hh.includes('bbjAmount: snap.bbjFee') || hh.includes('bbjAmount?: number;')).toBe(true);
    expect(
      hh.includes('bbjAmount: params.bbjAmount ?? 0,'),
      'logHandHistory must forward the jackpot fee to recordHorseHandReviews'
    ).toBe(true);

    const review = read('services/HorseHandReview.ts');
    // ONE allocator, ONE contributions list - if these ever diverge, rake_bb
    // and bbj_bb stop agreeing with each other and with the money pipeline.
    expect(
      review.includes(
        'const bbjShares = allocateWeightedShareCents(Number(input.bbjAmount ?? 0), contributions);'
      )
    ).toBe(true);
    expect(
      review.includes(
        'const rakeShares = allocateWeightedShareCents(Number(input.rakeAmount ?? 0), contributions);'
      )
    ).toBe(true);
    expect(review.includes('bbj_bb: r2(acc.bbjBB),')).toBe(true);
    // the requeue path must carry it too, or a failed flush silently drops it
    expect(review.includes('acc.bbjBB += row.bbj_bb;')).toBe(true);
  });

  it('the tuner reads bbj_bb and passes it into the rule', () => {
    const tuner = read('services/HorseSelfTuner.ts');
    expect(tuner.includes("'horse_user_id, hands, net_bb, rake_bb, bbj_bb, format'")).toBe(true);
    expect(tuner.includes('acc.bbjBB += Number(row.bbj_bb ?? 0);')).toBe(true);
    const call = tuner.slice(tuner.indexOf('const { mods, reasons } = diagnoseAndNudge('));
    const head = call.slice(0, call.indexOf(');'));
    expect(head.includes('rakeBB100')).toBe(true);
    expect(head.includes('bbjBB100')).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAW: THE TUNER DOES NOT FIGHT THE RAKE (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-04 the fleet's cash net was -32.0 bb/100 over 2.67M seat-hands
 * and the day's rake plus BBJ drop equalled the horse loss to within one
 * percent (the horses play each other). HorseSelfTuner's regression rule
 * read that as 221 of 383 horses with broken dials and halved every dial
 * toward neutral, erasing the leak-tag nudges nightly.
 *
 * This law pins the shape of the fix so it cannot be "simplified" away:
 *
 *   1. the rule judges the RAKE-ADJUSTED result - a horse at -32 raw that
 *      is -3 after rake is never regressed;
 *   2. the rule is FLEET-RELATIVE - a horse losing after rake but not in
 *      the fleet's worst quarter is never regressed;
 *   3. runSelfTune passes both (rake from horse_daily_nets.rake_bb, the
 *      quartile from fleetQuartile) - the pure function being right is not
 *      enough if the caller forgets to tell it;
 *   4. settlement accumulates rake_bb with the money pipeline's allocator,
 *      so the number the rule reads is the number the ledger charges;
 *   5. the leak gates are rates per reviewed hand.
 *
 * The daily audit's fn_audit_tuner_health is the production twin: more than
 * 40% of tuned horses regressing in one night is critical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  diagnoseAndNudge,
  MIN_REAL_HANDS_FOR_BB100,
  REGRESS_BB100,
  LEAK_RATE_GATES,
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

describe('LAW: the tuner does not fight the rake', () => {
  it('a horse that is only losing the rake is never regressed', () => {
    const r = diagnoseAndNudge(clean, dials, -32, MIN_REAL_HANDS_FOR_BB100, null, {
      rakeBB100: 29,
      fleetP25: -60,
    });
    expect(r.mods.tightness).toBe(1.1);
    expect(r.mods.aggression).toBe(1.12);
    expect(r.mods.bluffFreq).toBe(0.9);
  });

  it('a horse losing after rake but not in the worst quarter is never regressed', () => {
    const r = diagnoseAndNudge(clean, dials, -49, MIN_REAL_HANDS_FOR_BB100, null, {
      rakeBB100: 29,
      fleetP25: -25,
    });
    expect(r.mods.tightness).toBe(1.1);
  });

  it('a horse losing after rake AND in the worst quarter is regressed - the rule still exists', () => {
    const r = diagnoseAndNudge(clean, dials, -60, MIN_REAL_HANDS_FOR_BB100, null, {
      rakeBB100: 29,
      fleetP25: -20,
    });
    expect(r.mods.tightness).toBeCloseTo(1.05, 5);
    expect(REGRESS_BB100).toBe(-15);
  });

  it('runSelfTune reads rake_bb and passes the fleet quartile', () => {
    const tuner = read('services/HorseSelfTuner.ts');
    expect(tuner.includes("'horse_user_id, hands, net_bb, rake_bb, format'")).toBe(true);
    expect(tuner.includes('const fleetP25 = fleetQuartile(realNets);')).toBe(true);
    // the diagnose call carries both
    const call = tuner.slice(tuner.indexOf('const { mods, reasons } = diagnoseAndNudge('));
    const head = call.slice(0, call.indexOf(');'));
    expect(head.includes('rakeBB100')).toBe(true);
    expect(head.includes('fleetP25')).toBe(true);
    expect(head.includes('leaksHands')).toBe(true);
  });

  it('settlement accumulates rake_bb with the money pipeline allocator', () => {
    const review = read('services/HorseHandReview.ts');
    expect(
      review.includes("import { allocateWeightedShareCents } from './rakeAllocation.js';")
    ).toBe(true);
    expect(review.includes('acc.rakeBB += (rakeShares.get(p.userId) ?? 0) / bb;')).toBe(true);
    expect(review.includes('rake_bb: r2(acc.rakeBB),')).toBe(true);
    const hh = read('services/supabase/handHistory.ts');
    expect(hh.includes('rakeAmount: params.rakeAmount,')).toBe(true);
  });

  it('the leak gates are rates per reviewed hand', () => {
    expect(LEAK_RATE_GATES.stackoff).toBeGreaterThan(0);
    expect(LEAK_RATE_GATES.stackoff).toBeLessThan(1);
    const r = diagnoseAndNudge(
      clean,
      dials,
      null,
      0,
      { nonnut_flush_stackoff: 6 },
      { leaksHands: 600 }
    );
    expect(r.reasons.join(' ')).not.toContain('stackoffs');
  });
});

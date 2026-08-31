/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HALF OF THE DB-MIRROR GATE THAT CI CANNOT PROVE AGAINST PRODUCTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * scripts/ci/check-db-mirror-parity.mjs compares four production tables, and
 * the live function fn_effective_rake_cap, against the code they mirror. To do
 * that from plain Node with no TypeScript loader it PARSES the config arrays
 * out of the .ts files as text and RESTATES the engine's cap rule in JavaScript
 * (`engineCapFor`).
 *
 * A restated rule is a fifth copy, and this whole pull request is about copies
 * that drift. So the gate and this file split the claim in two:
 *
 *     the gate proves     PRODUCTION  ==  engineCapFor
 *     this file proves    engineCapFor  ==  the real getRakeConfig
 *     therefore           PRODUCTION  ==  the engine
 *
 * Delete either half and the chain is broken while both remaining pieces still
 * look green. Do not.
 *
 * It reads the CLIENT copy of RakeConfig, which imports nothing, rather than
 * the server copy, which pulls in PokerEngine. That is sound because
 * scripts/ci/check-rake-schedule-parity.mjs and check-rakeconfig-parity.mjs are
 * both BLOCKING and hold the two copies identical entry for entry.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RAKE_SCHEDULE,
  STAKES_TIERS,
  UNSCHEDULED_CAP_BB,
  getRakeConfig,
} from '../../src/config/RakeConfig';
import {
  parseRakeSchedule,
  parseStakesTiers,
  parseSpinTiers,
  engineCapFor,
  unscheduledCapBB,
  capProbeStakes,
  diffRakeSchedule,
  diffRakeTier,
  diffBbjTiers,
  diffSpinTiers,
} from '../../scripts/ci/check-db-mirror-parity.mjs';

const SERVER_RAKE = resolve(__dirname, '../../server/src/config/RakeConfig.ts');
const CLIENT_SPIN = resolve(__dirname, '../../src/config/spinSpec.ts');

const schedule = parseRakeSchedule(readFileSync(SERVER_RAKE, 'utf8'));
const tiers = parseStakesTiers(readFileSync(SERVER_RAKE, 'utf8'));
const spins = parseSpinTiers(readFileSync(CLIENT_SPIN, 'utf8'));

describe('the gate parses the same config the engine executes', () => {
  it('reads every RAKE_SCHEDULE row, not the type annotation beside it', () => {
    // `RakeScheduleEntry[] = [` puts an empty bracket pair before the data.
    // Taking the first `[` parses zero rows and reports a clean pass forever.
    expect(schedule.length).toBe(RAKE_SCHEDULE.length);
    expect(schedule.length).toBeGreaterThan(10);
    for (const row of RAKE_SCHEDULE) {
      const parsed = schedule.find((r) => r.sb === row.sb && r.bb === row.bb);
      expect(parsed, `stake ${row.sb}/${row.bb} was not parsed out of the source`).toBeDefined();
      expect(parsed!.rakeCap).toBe(row.rakeCap);
      expect(parsed!.rakePercent).toBe(row.rakePercent);
      expect(parsed!.bbjFeeBB).toBe(row.bbjFeeBB);
    }
  });

  it('reads every stakes tier, including the open top end', () => {
    expect(Object.keys(tiers).sort()).toEqual(Object.keys(STAKES_TIERS).sort());
    for (const [label, tier] of Object.entries(STAKES_TIERS)) {
      expect(tiers[label].maxBB).toBe(tier.maxBB);
      expect(tiers[label].rakeCap).toBe(tier.rakeCap);
      expect(tiers[label].rakeCapBB).toBe(tier.rakeCapBB);
      expect(tiers[label].bbjFeeBB).toBe(tier.bbjFeeBB);
      expect(tiers[label].bbjPayoutTotalPercent).toBe(tier.bbjPayoutTotalPercent);
    }
    expect(tiers.nosebleeds.maxBB).toBe(Infinity);
  });

  it('reads the spin ladder through its underscored numerals', () => {
    // freq is written 4_772_073. A parser that keeps the underscore reads NaN
    // and a parser that stops at it reads 4.
    expect(spins.length).toBe(8);
    expect(spins.reduce((s, t) => s + t.freq, 0)).toBe(10_000_099);
    expect(spins.find((t) => t.multiplier === 100)?.reserveThresholdX).toBe(1.5);
  });
});

describe('the restated cap rule IS the engine cap rule', () => {
  it('derives the same unscheduled BB proportion', () => {
    expect(unscheduledCapBB(schedule)).toBeCloseTo(UNSCHEDULED_CAP_BB, 10);
  });

  it('agrees with getRakeConfig at every stake the gate probes', () => {
    const probes = capProbeStakes(schedule);
    expect(probes.length).toBeGreaterThan(30);
    for (const [sb, bb] of probes) {
      expect(
        engineCapFor(sb, bb, schedule, tiers),
        `cap disagrees at ${sb}/${bb} — the gate would compare production against ` +
          'a rule the engine does not use'
      ).toBeCloseTo(getRakeConfig(bb, 'nlh', sb).rakeCap, 10);
    }
  });

  it('agrees across a dense sweep of big blinds, scheduled or not', () => {
    for (let bb = 0.01; bb <= 120; bb = Math.round((bb + 0.07) * 100) / 100) {
      const sb = Math.round((bb / 2) * 100) / 100;
      expect(engineCapFor(sb, bb, schedule, tiers)).toBeCloseTo(
        getRakeConfig(bb, 'nlh', sb).rakeCap,
        10
      );
    }
  });
});

describe('the diffs actually fail when a mirror drifts', () => {
  // A gate is only worth its runtime if it goes red. Each of these feeds it the
  // drift it exists to catch.
  const dbSchedule = schedule.map((r) => ({
    sb: r.sb,
    bb: r.bb,
    rake_percent: r.rakePercent,
    rake_cap: r.rakeCap,
    bbj_fee_bb: r.bbjFeeBB,
  }));
  const dbTiers = Object.entries(tiers).map(([label, t]) => ({
    label,
    min_bb: 0,
    max_bb: t.maxBB === Infinity ? null : t.maxBB,
    rake_percent: t.rakePercent,
    rake_cap: t.rakeCap,
    bbj_fee_bb: t.bbjFeeBB,
  }));
  const dbBbj = Object.entries(tiers).map(([label, t]) => ({
    id: label,
    min_bb: 0,
    max_bb: t.maxBB === Infinity ? 99999 : t.maxBB,
    rake_percent: t.rakePercent,
    rake_cap_bb: t.rakeCapBB,
    bbj_fee_bb: t.bbjFeeBB,
    payout_total_pct: t.bbjPayoutTotalPercent,
  }));
  const dbSpins = spins.map((t) => ({
    multiplier: t.multiplier,
    freq: t.freq,
    reserve_threshold_x: t.reserveThresholdX,
  }));

  it('passes when the mirrors match', () => {
    expect(diffRakeSchedule(schedule, dbSchedule)).toEqual([]);
    expect(diffRakeTier(tiers, dbTiers)).toEqual([]);
    expect(diffBbjTiers(tiers, dbBbj)).toEqual([]);
    expect(diffSpinTiers(spins, dbSpins)).toEqual([]);
  });

  it('catches a cap the database mirror understates', () => {
    const drifted = dbSchedule.map((r) => (r.bb === 20 ? { ...r, rake_cap: 3 } : r));
    expect(diffRakeSchedule(schedule, drifted).join(' ')).toMatch(/stake 10\/20 rakeCap/);
  });

  it('catches the 5/5 case: a row the database still has and the code does not', () => {
    // This is the exact shape of the drift that shipped on 2026-09-01 — the
    // code half landed, the DELETE did not.
    const stale = [
      ...dbSchedule,
      { sb: 5, bb: 5, rake_percent: 10, rake_cap: 7.5, bbj_fee_bb: 0.12 },
    ];
    expect(diffRakeSchedule(schedule, stale).join(' ')).toMatch(/stake 5\/5 .*not in the code/);
  });

  it('catches a stakes tier whose database cap has drifted', () => {
    const drifted = dbTiers.map((t) => (t.label === 'high' ? { ...t, rake_cap: 99 } : t));
    expect(diffRakeTier(tiers, drifted).join(' ')).toMatch(/tier high rakeCap/);
  });

  it('catches a BBJ payout percent the database has and the code does not', () => {
    const drifted = dbBbj.map((t) => (t.id === 'mid' ? { ...t, payout_total_pct: 99 } : t));
    expect(diffBbjTiers(tiers, drifted).join(' ')).toMatch(/tier mid bbjPayoutTotalPercent/);
  });

  it('catches a spin frequency the fairness guard would then certify as fair', () => {
    const drifted = dbSpins.map((t) => (t.multiplier === 100 ? { ...t, freq: 500 } : t));
    expect(diffSpinTiers(spins, drifted).join(' ')).toMatch(/100x freq/);
  });

  it('does NOT fail on min_bb, which the two encode differently on purpose', () => {
    // ca_rake_tier leaves gaps (0.1, 0.3, 1, 3.5, 9, 41); bbj_stakes_tiers is
    // contiguous (0.01, 0.21, 0.81, 3.01, 8.01, 40.01). Neither selects a tier.
    const other = dbTiers.map((t) => ({ ...t, min_bb: t.min_bb + 1234 }));
    expect(diffRakeTier(tiers, other)).toEqual([]);
  });

  it('does NOT fail on the two spellings of the open top end', () => {
    // NULL in ca_rake_tier, 99999 in bbj_stakes_tiers, Infinity in the code.
    expect(diffRakeTier(tiers, dbTiers)).toEqual([]);
    expect(diffBbjTiers(tiers, dbBbj)).toEqual([]);
  });
});

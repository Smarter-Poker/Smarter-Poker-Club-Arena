/**
 * Condition (b) of the winning contract for a Phase 12 pack: the statistic,
 * interval, gate, sample floor and run completeness are the contract's
 * (docs/horse-brain-winning-contract-2026-10-08.md). No hand is dealt here.
 */
import { describe, expect, it } from 'vitest';
import {
  HUMAN_CALIBRATED_CHECK_SCHEMA,
  HUMAN_CALIBRATED_CHECK_Z,
  addHumanCalibratedHand,
  humanCalibratedArmStatistic,
  humanCalibratedHandsPerSeed,
  summarizeHumanCalibratedCheck,
  type HumanCalibratedCheckRun,
  type HumanCalibratedMoments,
} from './HumanCalibratedCheck.js';
import {
  HUMAN_CALIBRATED_HOLDOUT_SEEDS,
  HUMAN_CALIBRATED_POPULATION_ID,
} from './HumanCalibratedPopulation.js';

const fromCents = (values: number[]): HumanCalibratedMoments => {
  const m = { sum: 0, sumSq: 0 };
  for (const v of values) addHumanCalibratedHand(m, v / 100);
  return m;
};

function run(
  profileId: string,
  seed: number,
  hands: number,
  perHandCents: number,
  over: Partial<HumanCalibratedCheckRun> = {}
): HumanCalibratedCheckRun {
  // Alternate +/-100 cents around the mean so every profile has a variance.
  const values = Array.from({ length: hands }, (_, i) => perHandCents + (i % 2 ? 100 : -100));
  return {
    schema: HUMAN_CALIBRATED_CHECK_SCHEMA,
    phase: 'phase12',
    variant: 'flh',
    packVersion: 'fixed-limit-holdem-round3-v1',
    contractDigest: 'x',
    population: HUMAN_CALIBRATED_POPULATION_ID,
    profileId,
    leagueProfileId: `${profileId}--${HUMAN_CALIBRATED_POPULATION_ID}`,
    evidenceMode: 'contract',
    seed,
    firstHand: 0,
    requestedHands: hands,
    hands,
    complete: true,
    candidate: fromCents(values),
    reference: fromCents(values.map((v) => v - 50)),
    difference: fromCents(values.map(() => 50)),
    changedHands: hands,
    decisions: 0,
    changed: 0,
    illegalCandidates: 0,
    illegalActions: 0,
    conservationErrors: 0,
    cardErrors: 0,
    incompleteHands: 0,
    truncatedHands: 0,
    candidateRake: 0,
    referenceRake: 0,
    sourceSha: 'abc',
    durationMs: 0,
    ...over,
  };
}

const PROFILES = ['p-a', 'p-b'];
const ADEQUATE = { family: 'other' as const, adequate: true, reasons: [] };
const full = (perHand: number) =>
  PROFILES.flatMap((p) => HUMAN_CALIBRATED_HOLDOUT_SEEDS.map((s) => run(p, s, 3888, perHand)));

describe('the winning contract condition (b) check', () => {
  it('plays whole rotation blocks and at least 10,000 hands per profile over the three seeds', () => {
    expect(humanCalibratedHandsPerSeed(1296)).toBe(3888);
    expect(humanCalibratedHandsPerSeed(576)).toBe(3456);
    for (const block of [1296, 576])
      expect(
        humanCalibratedHandsPerSeed(block) * HUMAN_CALIBRATED_HOLDOUT_SEEDS.length
      ).toBeGreaterThanOrEqual(10_000);
  });

  it('is the equal-weight stratified mean with the two-sided 99% Wald interval, in bb/100', () => {
    const a = fromCents([100, 300]); // mean 200 cents = 1 bb, s^2 = 20,000
    const b = fromCents([-100, -100, 500, 500]); // mean 200 cents, s^2 = 120,000
    const s = humanCalibratedArmStatistic([
      { profileId: 'a', hands: 2, m: a },
      { profileId: 'b', hands: 4, m: b },
    ]);
    expect(s.bbPer100).toBeCloseTo(100, 9);
    const half = HUMAN_CALIBRATED_CHECK_Z * Math.sqrt(0.25 * (20_000 / 2) + 0.25 * (120_000 / 4));
    expect(s.lower99).toBeCloseTo(((200 - half) / 200) * 100, 9);
    expect(s.upper99).toBeCloseTo(((200 + half) / 200) * 100, 9);
  });

  it('reads unavailable external input on the committed calibration even when the gate passes', () => {
    const s = summarizeHumanCalibratedCheck({
      variant: 'flh',
      profileIds: PROFILES,
      rotationBlock: 1296,
      runs: full(200),
      rakeModel: 'published',
    });
    expect(s.reasons).toEqual([]);
    expect(s.lowerBoundAboveZero).toBe(true);
    expect(s.adequacy.adequate).toBe(false);
    expect(s.conditionB).toBe('unavailable_external_input');
  });

  it('is met only on an adequate calibration with the lower bound above zero', () => {
    const base = { variant: 'flh', profileIds: PROFILES, rotationBlock: 1296, rakeModel: 'p' };
    expect(
      summarizeHumanCalibratedCheck({ ...base, runs: full(200), adequacy: ADEQUATE }).conditionB
    ).toBe('met');
    const losing = summarizeHumanCalibratedCheck({ ...base, runs: full(-200), adequacy: ADEQUATE });
    expect(losing.conditionB).toBe('not_met');
    expect(losing.difference?.bbPer100).toBeCloseTo(25, 9);
  });

  it('refuses a missing, short, duplicate, development or other-seed run', () => {
    const base = {
      variant: 'flh',
      profileIds: PROFILES,
      rotationBlock: 1296,
      rakeModel: 'p',
      adequacy: ADEQUATE,
    };
    const runs = full(200);
    const missing = summarizeHumanCalibratedCheck({ ...base, runs: runs.slice(1) });
    expect(missing.conditionB).toBe('incomplete');
    expect(missing.reasons).toContain(`p-a@${HUMAN_CALIBRATED_HOLDOUT_SEEDS[0]}:missing`);
    const bad = summarizeHumanCalibratedCheck({
      ...base,
      runs: [
        run('p-a', HUMAN_CALIBRATED_HOLDOUT_SEEDS[0], 3000, 200),
        ...runs.slice(1),
        runs[1],
        run('p-b', 12101101, 3888, 200, { evidenceMode: 'development' }),
      ],
    });
    expect(bad.conditionB).toBe('incomplete');
    expect(bad.reasons).toEqual(
      expect.arrayContaining([
        `p-a@${HUMAN_CALIBRATED_HOLDOUT_SEEDS[0]}:hands_3000_not_3888`,
        `p-a@${HUMAN_CALIBRATED_HOLDOUT_SEEDS[1]}:duplicate`,
        'p-b@12101101:not_contract_mode',
        'p-b@12101101:not_a_human_calibrated_holdout_seed',
      ])
    );
  });

  it('refuses a run with an integrity error', () => {
    const runs = full(200);
    runs[0] = { ...runs[0], conservationErrors: 1 };
    const s = summarizeHumanCalibratedCheck({
      variant: 'flh',
      profileIds: PROFILES,
      rotationBlock: 1296,
      runs,
      rakeModel: 'p',
      adequacy: ADEQUATE,
    });
    expect(s.conditionB).toBe('incomplete');
    expect(s.reasons).toContain('integrity:conservationErrors_1');
  });
});

/**
 * Condition (b) of the winning contract
 * (docs/horse-brain-winning-contract-2026-10-08.md), measured for a Phase 12
 * pack: the candidate arm's after-rake net against the human-calibrated
 * population on every one of the pack's cash contract profiles, transformed by
 * `withHumanCalibratedOpponents`, on the held-out seeds
 * `HUMAN_CALIBRATED_HOLDOUT_SEEDS`.
 *
 * The statistic, interval, gate and sample are the contract's, written there
 * before any run: the hero seat's net chips per hand after rake and BBJ drop in
 * bb/100, the stratified mean with equal weight per profile (hands pooled
 * within a profile across seeds), a two-sided 99% Wald interval
 * `T +/- z * sqrt(sum w_p^2 s_p^2 / n_p)`, gate lower bound > 0, at least
 * 10,000 hands per profile. The same deal is also played by the reference arm
 * (the same horse with the pack off), so each run also reports the reference's
 * net and the paired difference against humans; those two are context, not
 * part of the gate.
 *
 * A pass qualifies nothing unless the population's calibration is adequate on
 * the day of the run (`humanCalibrationAdequacy`); on the committed
 * calibration it is not, so condition (b) reads unavailable external input
 * whatever the interval says.
 */
import {
  HUMAN_CALIBRATED_HOLDOUT_SEEDS,
  HUMAN_CALIBRATED_POPULATION_ID,
  humanCalibratedProfileFor,
  humanCalibrationAdequacy,
  type HumanCalibrationAdequacy,
} from './HumanCalibratedPopulation.js';

export const HUMAN_CALIBRATED_CHECK_SCHEMA = 'horse-human-calibrated-check-v1';
export const HUMAN_CALIBRATED_CHECK_SUMMARY_SCHEMA = 'horse-human-calibrated-check-summary-v1';
/** The contract's sample floor: hands per profile, pooled across the seeds. */
export const HUMAN_CALIBRATED_CHECK_MIN_HANDS_PER_PROFILE = 10_000;
/** Phi^-1(0.995): the two-sided 99% normal quantile. */
export const HUMAN_CALIBRATED_CHECK_Z = 2.5758293035489004;
/** The league table is 1/2 (Plo4PolicyLeague deals every profile at a 2-chip
 * big blind), so a hand's net in cents divided by 200 is its net in big blinds. */
export const HUMAN_CALIBRATED_CHECK_BIG_BLIND_CENTS = 200;

/** Hands per held-out seed: the smallest whole number of rotation blocks that
 * gives every profile at least the contract's floor over the three seeds, so
 * every (hero seat, button) pair is visited equally. */
export function humanCalibratedHandsPerSeed(rotationBlock: number): number {
  if (!Number.isInteger(rotationBlock) || rotationBlock < 1)
    throw new Error('Invalid rotation block');
  const need = Math.ceil(
    HUMAN_CALIBRATED_CHECK_MIN_HANDS_PER_PROFILE / HUMAN_CALIBRATED_HOLDOUT_SEEDS.length
  );
  return Math.ceil(need / rotationBlock) * rotationBlock;
}

/** Exact integer sums of one arm's per-hand net, in cents. */
export interface HumanCalibratedMoments {
  sum: number;
  sumSq: number;
}

export interface HumanCalibratedCheckRun {
  schema: typeof HUMAN_CALIBRATED_CHECK_SCHEMA;
  phase: 'phase12';
  variant: string;
  packVersion: string;
  contractDigest: string;
  population: typeof HUMAN_CALIBRATED_POPULATION_ID;
  /** The contract profile the table was built from. */
  profileId: string;
  /** `<profileId>--human-calibrated-v1-20261008`. */
  leagueProfileId: string;
  evidenceMode: 'contract' | 'development';
  seed: number;
  firstHand: number;
  requestedHands: number;
  hands: number;
  complete: boolean;
  candidate: HumanCalibratedMoments;
  reference: HumanCalibratedMoments;
  difference: HumanCalibratedMoments;
  changedHands: number;
  decisions: number;
  changed: number;
  illegalCandidates: number;
  illegalActions: number;
  conservationErrors: number;
  cardErrors: number;
  incompleteHands: number;
  truncatedHands: number;
  candidateRake: number;
  referenceRake: number;
  sourceSha: string | null;
  durationMs: number;
}

export interface HumanCalibratedArmStatistic {
  bbPer100: number;
  lower99: number;
  upper99: number;
  profiles: { profileId: string; hands: number; bbPer100: number; sdBBPerHand: number }[];
}

export interface HumanCalibratedCheckSummary {
  schema: typeof HUMAN_CALIBRATED_CHECK_SUMMARY_SCHEMA;
  variant: string;
  population: typeof HUMAN_CALIBRATED_POPULATION_ID;
  packVersion: string | null;
  sourceSha: string | null;
  seeds: readonly number[];
  handsPerSeed: number;
  runs: number;
  hands: number;
  rakeModel: string;
  /** Condition (b)'s statistic: the candidate arm against humans, after rake. */
  candidate: HumanCalibratedArmStatistic | null;
  /** Context: the reference arm (the current brain) on the same deals. */
  reference: HumanCalibratedArmStatistic | null;
  /** Context: candidate minus reference on the same deals. */
  difference: HumanCalibratedArmStatistic | null;
  integrity: Record<string, number>;
  adequacy: HumanCalibrationAdequacy;
  lowerBoundAboveZero: boolean;
  /** `met` only when the gate passes on an adequate calibration. */
  conditionB: 'met' | 'not_met' | 'unavailable_external_input' | 'incomplete';
  reasons: string[];
}

function moments(): HumanCalibratedMoments {
  return { sum: 0, sumSq: 0 };
}

/** Adds one hand's net (chips) to an arm's moments, in whole cents. */
export function addHumanCalibratedHand(m: HumanCalibratedMoments, netChips: number): number {
  const cents = Math.round(netChips * 100);
  m.sum += cents;
  m.sumSq += cents * cents;
  return cents;
}

/** The contract's stratified mean and two-sided 99% Wald interval. */
export function humanCalibratedArmStatistic(
  strata: { profileId: string; hands: number; m: HumanCalibratedMoments }[]
): HumanCalibratedArmStatistic {
  if (!strata.length || strata.some((s) => s.hands < 2)) throw new Error('Too few hands');
  const w = 1 / strata.length;
  const bb = HUMAN_CALIBRATED_CHECK_BIG_BLIND_CENTS;
  let t = 0;
  let v = 0;
  const profiles = strata.map(({ profileId, hands, m }) => {
    const mean = m.sum / hands;
    const s2 = Math.max(0, (m.sumSq - (m.sum * m.sum) / hands) / (hands - 1));
    t += w * mean;
    v += (w * w * s2) / hands;
    return {
      profileId,
      hands,
      bbPer100: (mean / bb) * 100,
      sdBBPerHand: Math.sqrt(s2) / bb,
    };
  });
  const half = HUMAN_CALIBRATED_CHECK_Z * Math.sqrt(v);
  return {
    bbPer100: (t / bb) * 100,
    lower99: ((t - half) / bb) * 100,
    upper99: ((t + half) / bb) * 100,
    profiles,
  };
}

const INTEGRITY = [
  'illegalCandidates',
  'illegalActions',
  'conservationErrors',
  'cardErrors',
  'incompleteHands',
  'truncatedHands',
] as const;

/**
 * Condition (b) for one pack from its runs: every contract profile on every
 * held-out seed, exactly once, complete, at the contract's hands per seed, one
 * source and pack version; otherwise `incomplete` with the reasons.
 */
export function summarizeHumanCalibratedCheck(input: {
  variant: string;
  profileIds: readonly string[];
  rotationBlock: number;
  runs: readonly HumanCalibratedCheckRun[];
  rakeModel: string;
  adequacy?: HumanCalibrationAdequacy;
}): HumanCalibratedCheckSummary {
  const seeds = HUMAN_CALIBRATED_HOLDOUT_SEEDS;
  const handsPerSeed = humanCalibratedHandsPerSeed(input.rotationBlock);
  const adequacy =
    input.adequacy ?? humanCalibrationAdequacy(humanCalibratedProfileFor(input.variant));
  const reasons: string[] = [];
  const integrity: Record<string, number> = Object.fromEntries(INTEGRITY.map((k) => [k, 0]));
  const seen = new Map<string, HumanCalibratedCheckRun>();
  for (const r of input.runs) {
    const key = `${r.profileId}@${r.seed}`;
    if (r.schema !== HUMAN_CALIBRATED_CHECK_SCHEMA) reasons.push(`${key}:schema`);
    if (r.variant !== input.variant) reasons.push(`${key}:other_variant`);
    if (r.population !== HUMAN_CALIBRATED_POPULATION_ID) reasons.push(`${key}:population`);
    if (r.evidenceMode !== 'contract') reasons.push(`${key}:not_contract_mode`);
    if (!seeds.includes(r.seed)) reasons.push(`${key}:not_a_human_calibrated_holdout_seed`);
    if (!input.profileIds.includes(r.profileId)) reasons.push(`${key}:unknown_profile`);
    if (seen.has(key)) reasons.push(`${key}:duplicate`);
    if (r.firstHand !== 0 || r.requestedHands !== handsPerSeed || r.hands !== handsPerSeed)
      reasons.push(`${key}:hands_${r.hands}_not_${handsPerSeed}`);
    if (!r.complete) reasons.push(`${key}:incomplete`);
    for (const k of INTEGRITY) integrity[k] += r[k];
    seen.set(key, r);
  }
  for (const p of input.profileIds)
    for (const s of seeds) if (!seen.has(`${p}@${s}`)) reasons.push(`${p}@${s}:missing`);
  for (const k of INTEGRITY) if (integrity[k] > 0) reasons.push(`integrity:${k}_${integrity[k]}`);
  const versions = new Set(input.runs.map((r) => r.packVersion));
  const shas = new Set(input.runs.map((r) => r.sourceSha));
  if (versions.size > 1) reasons.push('mixed_pack_versions');
  if (shas.size > 1 || shas.has(null)) reasons.push('mixed_or_unknown_source');
  const arm = (pick: (r: HumanCalibratedCheckRun) => HumanCalibratedMoments) =>
    humanCalibratedArmStatistic(
      input.profileIds.map((profileId) => {
        const m = moments();
        let hands = 0;
        for (const r of input.runs)
          if (r.profileId === profileId) {
            m.sum += pick(r).sum;
            m.sumSq += pick(r).sumSq;
            hands += r.hands;
          }
        if (hands < HUMAN_CALIBRATED_CHECK_MIN_HANDS_PER_PROFILE)
          reasons.push(`${profileId}:hands_${hands}_below_floor`);
        return { profileId, hands, m };
      })
    );
  const ready = input.runs.length > 0 && !reasons.some((r) => r.endsWith(':missing'));
  const candidate = ready ? arm((r) => r.candidate) : null;
  const reference = ready ? arm((r) => r.reference) : null;
  const difference = ready ? arm((r) => r.difference) : null;
  const lowerBoundAboveZero = candidate !== null && candidate.lower99 > 0;
  const conditionB = reasons.length
    ? 'incomplete'
    : !adequacy.adequate
      ? 'unavailable_external_input'
      : lowerBoundAboveZero
        ? 'met'
        : 'not_met';
  return {
    schema: HUMAN_CALIBRATED_CHECK_SUMMARY_SCHEMA,
    variant: input.variant,
    population: HUMAN_CALIBRATED_POPULATION_ID,
    packVersion: versions.size === 1 ? [...versions][0] : null,
    sourceSha: shas.size === 1 ? [...shas][0] : null,
    seeds,
    handsPerSeed,
    runs: input.runs.length,
    hands: input.runs.reduce((n, r) => n + r.hands, 0),
    rakeModel: input.rakeModel,
    candidate,
    reference,
    difference,
    integrity,
    adequacy,
    lowerBoundAboveZero,
    conditionB,
    reasons,
  };
}

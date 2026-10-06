/**
 * P13.2 contract shard runner for the joint multiway owner (Horse Brain
 * Phase 13), one variant at a time.
 *
 * The same paired whole-hand league as Phases 10, 11 and 12
 * (playPlo4PolicyHand, the real HandController and paired accounting in
 * Plo4PolicyLeague.ts), with a joint profile of the variant: its published
 * 1/2 cash pricing and BBJ row, the bomb configuration of a bomb profile, the
 * real Pineapple discard path, the deal-seed mood clock and the independent
 * multiboard settlement of JointStrengthChecks.ts. The candidate arm plays
 * `phase13Joint: 'candidate'` at the hero seat under `phase13EvidenceMode`
 * (a fixed policy clock, so a proposal never depends on wall time); the
 * reference arm plays `phase13Joint: 'off'`. Every other phase is off in every
 * seat and both arms.
 *
 * Beside `changed` it counts the guard refusals (`illegalCandidates`,
 * `earlierPhaseRefusals`, validity failures under this contract) and the
 * named diagnostic refusals (`workBudgetRefusals`,
 * `responseBranchUnavailable`, `insufficientSamples`).
 */
import { createHash } from 'node:crypto';
import { equityGovernor } from '../engine/EquityLoadGovernor.js';
import { JOINT_LIVE_DOMAIN } from '../engine/multiway/JointSampleAcquisition.js';
import { JOINT_ACTION_PACK } from '../engine/multiway/JointActionModel.js';
import { JOINT_RANGE_PACK } from '../engine/multiway/JointRangeSampler.js';
import { getFullRakeConfig } from '../config/RakeConfig.js';
import {
  plo4LeagueSeating,
  playPlo4PolicyHand,
  type Plo4HandReceipt,
  type Plo4LeagueProfile,
} from './Plo4PolicyLeague.js';
import { isPlo4HoldoutSeed, Plo4PowerAccumulator } from './Plo4StrengthContract.js';
import { isOmahaVariantHoldoutSeed } from './OmahaVariantStrengthContract.js';
import { isRemainingVariantHoldoutSeed } from './RemainingVariantStrengthContract.js';
import {
  JOINT_STRENGTH_BB,
  JOINT_STRENGTH_CONTRACT,
  isJointHoldoutSeed,
  isJointHoldoutSeedOf,
  isJointStrengthVariant,
  jointStrengthContractDigest,
  jointStrengthPack,
  jointStrengthProfile,
  type JointStrengthShardResult,
  type JointStrengthVariant,
} from './JointStrengthContract.js';
import { jointDivergenceStreet } from './JointStrengthChecks.js';

const BB = JOINT_STRENGTH_BB;

function assertFixedBudget() {
  if (
    process.env.EQUITY_GOVERNOR !== 'off' ||
    equityGovernor.snapshot().enabled ||
    equityGovernor.current() !== 1
  )
    throw new Error(
      'Phase 13 evidence requires EQUITY_GOVERNOR=off before module import and scale 1'
    );
}

/** A contract profile as a league profile: the variant's published pricing,
 * production styles, the deal-seed mood clock and, for a bomb profile, the
 * engine's default bomb ante and the requested board count. */
export function jointStrengthLeagueProfile(
  variant: JointStrengthVariant,
  profileId: string
): Plo4LeagueProfile {
  const p = jointStrengthProfile(variant, profileId);
  if (!p) throw new Error('Unknown P13.2 strength profile');
  const full = getFullRakeConfig(1, BB, variant);
  return {
    id: p.id,
    variant,
    jointPolicy: true,
    seats: p.seats,
    tableSeats: p.tableSeats,
    stackBB: p.stackBB,
    rakePercent: full.rakePercent,
    rakeCapBB: full.rakeCap / BB,
    anteBB: 0,
    straddle: false,
    tournament: false,
    opponentStyle: 'balanced',
    publishedRake: true,
    productionStyles: true,
    moodClock: 'deal_seed_time_of_day',
    asset: 'chips',
    ...(p.bombBoards ? { bombBoards: p.bombBoards } : {}),
  };
}

/**
 * One shard of one variant's P13.2 matrix: a fixed range of pair indices of
 * one (profile, seed) cell, candidate arm then reference arm on each deal.
 * Contract mode plays exactly the variant's pairs per shard on one of that
 * variant's held-out seeds; development mode (tests, the design pilot) may
 * play fewer pairs and never touches any held-out seed (Phase 10, 11, 12 or
 * 13). Neither mode can promote: the verdict is summarizeJointStrength over
 * every shard of the variant.
 */
export async function runJointStrengthShard(
  variant: JointStrengthVariant,
  request: {
    profileId: string;
    seed: number;
    shard: number;
    mode: 'contract' | 'development';
    pairs?: number;
  },
  shouldContinue = () => true
): Promise<JointStrengthShardResult> {
  if (!isJointStrengthVariant(variant)) throw new Error('Unknown P13.2 strength variant');
  const c = JOINT_STRENGTH_CONTRACT;
  const pack = jointStrengthPack(variant);
  if (request.mode !== 'contract' && request.mode !== 'development')
    throw new Error('Unknown P13.2 shard mode');
  if (request.mode === 'contract' && !isJointHoldoutSeedOf(variant, request.seed))
    throw new Error("A contract shard runs only one of its own variant's held-out seeds");
  if (
    request.mode === 'development' &&
    (isJointHoldoutSeed(request.seed) ||
      isRemainingVariantHoldoutSeed(request.seed) ||
      isOmahaVariantHoldoutSeed(request.seed) ||
      isPlo4HoldoutSeed(request.seed))
  )
    throw new Error('A development shard never runs a held-out seed');
  if (!Number.isInteger(request.seed) || request.seed < 1 || request.seed > 0xffffffff)
    throw new Error('Invalid P13.2 shard seed');
  const contractProfile = jointStrengthProfile(variant, request.profileId);
  if (
    !contractProfile ||
    !Number.isInteger(request.shard) ||
    request.shard < 0 ||
    request.shard >= contractProfile.shards
  )
    throw new Error('P13.2 shard outside the matrix');
  const perShard = pack.matrix.pairsPerShard;
  const requested = request.pairs ?? perShard;
  if (request.mode === 'contract' && requested !== perShard)
    throw new Error('A contract shard plays exactly the contract pairs per shard');
  if (!Number.isInteger(requested) || requested < 1 || requested > perShard)
    throw new Error('Invalid P13.2 shard pair count');
  const profile = jointStrengthLeagueProfile(variant, request.profileId);
  assertFixedBudget();
  const started = performance.now();
  const firstPair = request.shard * perShard;
  const strata = new Map<string, Plo4PowerAccumulator>();
  const offsetCounts: number[] = Array(profile.seats).fill(0);
  const digest = createHash('sha256');
  const result: JointStrengthShardResult = {
    schema: 'horse-phase13-strength-shard-v1',
    variant,
    contractVersion: c.version,
    contractDigest: jointStrengthContractDigest(),
    packVersion: JOINT_ACTION_PACK.version,
    domainVersion: JOINT_LIVE_DOMAIN.version,
    rangePackVersion: JOINT_RANGE_PACK.version,
    evidenceMode: request.mode,
    profileId: profile.id,
    seed: request.seed,
    shard: request.shard,
    firstPair,
    requestedPairs: requested,
    pairs: 0,
    complete: false,
    positionCoverageComplete: false,
    offsetCounts,
    strata: {},
    pairDigest: '',
    candidateNetCents: 0,
    referenceNetCents: 0,
    changedPairs: 0,
    decisions: 0,
    eligible: 0,
    fired: 0,
    changed: 0,
    illegalCandidates: 0,
    earlierPhaseRefusals: 0,
    workBudgetRefusals: 0,
    responseBranchUnavailable: 0,
    insufficientSamples: 0,
    eligibleByBoards: {},
    discards: 0,
    illegalActions: 0,
    conservationErrors: 0,
    cardErrors: 0,
    truncatedHands: 0,
    settlementMismatches: 0,
    deductionMismatches: 0,
    pairedReplayMismatches: 0,
    showdownsChecked: 0,
    multiBoardShowdownsChecked: 0,
    foldWinsChecked: 0,
    lowHalvesChecked: 0,
    totalRake: 0,
    totalBbj: 0,
    nodeCounts: {},
    reasons: {},
    equityWork: {},
    fixedWork: {
      governor: 'off',
      scale: 1,
      policyClock: 'phase13_evidence_mode_fixed_clock',
      moodClock: 'deal_seed_time_of_day',
    },
    durationMs: 0,
    promotionEligible: false,
  };
  const merge = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
  };
  const absorb = (h: Plo4HandReceipt) => {
    result.decisions += h.decisions;
    result.eligible += h.eligible;
    result.changed += h.changed;
    result.illegalCandidates += h.illegalCandidates ?? 0;
    result.earlierPhaseRefusals += h.earlierPhaseRefusals ?? 0;
    result.workBudgetRefusals += h.reasons.work_budget ?? 0;
    result.responseBranchUnavailable += h.reasons.joint_response_branch_unavailable ?? 0;
    result.insufficientSamples += h.reasons.insufficient_joint_samples ?? 0;
    if (h.joint) {
      result.fired += h.joint.fired;
      merge(result.eligibleByBoards, h.joint.eligibleByBoards ?? {});
    }
    result.illegalActions += h.illegalActions;
    result.conservationErrors += h.conservationErrors;
    result.cardErrors += h.cardErrors;
    result.truncatedHands += h.truncated;
    result.totalRake += h.rake;
    result.totalBbj += h.bbj;
    merge(result.nodeCounts, h.nodeCounts);
    merge(result.reasons, h.reasons);
    merge(result.equityWork, h.equityWork);
    if (h.checks) {
      result.settlementMismatches += h.checks.settlementMismatches;
      result.deductionMismatches += h.checks.deductionMismatches;
      result.showdownsChecked += Number(h.checks.showdownChecked);
      result.multiBoardShowdownsChecked += Number(h.checks.multiBoardChecked === true);
      result.foldWinsChecked += Number(h.checks.foldWinChecked);
      result.lowHalvesChecked += Number(h.checks.lowHalfChecked === true);
      result.discards += h.checks.discards ?? 0;
    }
  };
  for (let k = 0; k < requested; k++) {
    if (!shouldContinue()) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const i = firstPair + k;
    const dealSeed = (request.seed ^ Math.imul(i + 1, 2654435761)) >>> 0 || 1;
    const { heroSeat, button, relativePosition } = plo4LeagueSeating(i, profile.seats);
    const candidate = await playPlo4PolicyHand(
      profile,
      dealSeed,
      button,
      heroSeat,
      'candidate',
      shouldContinue,
      true
    );
    absorb(candidate);
    if (!candidate.complete || !candidate.checks) break;
    const reference = await playPlo4PolicyHand(
      profile,
      dealSeed,
      button,
      heroSeat,
      'off',
      shouldContinue,
      true
    );
    absorb(reference);
    if (!reference.complete || !reference.checks) break;
    const candidateCents = Math.round(candidate.net[heroSeat - 1] * 100);
    const referenceCents = Math.round(reference.net[heroSeat - 1] * 100);
    const difference = candidateCents - referenceCents;
    const street = jointDivergenceStreet(candidate.checks.trace, reference.checks.trace);
    if (street === 'none' && difference !== 0) result.pairedReplayMismatches++;
    const key = `${relativePosition}|${street}`;
    const acc = strata.get(key) ?? new Plo4PowerAccumulator();
    acc.add(difference);
    strata.set(key, acc);
    offsetCounts[relativePosition]++;
    result.candidateNetCents += candidateCents;
    result.referenceNetCents += referenceCents;
    result.changedPairs += Number(street !== 'none');
    digest.update(`${i}:${difference}:${street};`);
    result.pairs++;
  }
  result.strata = Object.fromEntries(
    [...strata.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.toJSON()])
  );
  result.pairDigest = digest.digest('hex');
  result.complete = result.pairs === requested;
  result.positionCoverageComplete =
    result.complete && offsetCounts.every((n) => n > 0 && n === offsetCounts[0]);
  result.totalRake = Math.round(result.totalRake * 100) / 100;
  result.totalBbj = Math.round(result.totalBbj * 100) / 100;
  result.durationMs = Math.round(performance.now() - started);
  return result;
}

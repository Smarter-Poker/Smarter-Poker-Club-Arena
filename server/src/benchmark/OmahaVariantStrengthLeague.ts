/**
 * P11.2 contract shard runner for the Phase 11 packs (PLO5, PLO6, PLO8).
 *
 * The same paired whole-hand league as Phase 10 (playPlo4PolicyHand, the
 * shared controller and paired accounting in Plo4PolicyLeague.ts), with the
 * profile's own variant: its published 1/2 cash pricing and BBJ row, its own
 * independent settlement (PLO8 settles high and low halves) and the mood clock
 * of the P11.2 contract. Every PLO4 path is unchanged: these options are
 * default-off on the shared league profile.
 */
import { createHash } from 'node:crypto';
import { equityGovernor } from '../engine/EquityLoadGovernor.js';
import {
  OMAHA_VARIANT_PACKS,
  type OmahaPolicyVariant,
} from '../engine/omaha/OmahaVariantPolicyPack.js';
import { getFullRakeConfig } from '../config/RakeConfig.js';
import {
  plo4DivergenceStreet,
  plo4LeagueSeating,
  playPlo4PolicyHand,
  type Plo4HandReceipt,
  type Plo4LeagueProfile,
} from './Plo4PolicyLeague.js';
import { isPlo4HoldoutSeed, Plo4PowerAccumulator } from './Plo4StrengthContract.js';
import {
  OMAHA_VARIANT_STRENGTH_BB,
  OMAHA_VARIANT_STRENGTH_CONTRACT,
  isOmahaVariantHoldoutSeed,
  isOmahaVariantHoldoutSeedOf,
  isOmahaVariantStrengthVariant,
  omahaVariantStrengthContractDigest,
  omahaVariantStrengthPack,
  omahaVariantStrengthProfile,
  type OmahaVariantStrengthShardResult,
} from './OmahaVariantStrengthContract.js';

const BB = OMAHA_VARIANT_STRENGTH_BB;

function assertFixedBudget() {
  if (
    process.env.EQUITY_GOVERNOR !== 'off' ||
    equityGovernor.snapshot().enabled ||
    equityGovernor.current() !== 1
  )
    throw new Error(
      'Phase 11 evidence requires EQUITY_GOVERNOR=off before module import and scale 1'
    );
}

/** A contract profile as a league profile: the variant's published pricing,
 * production styles and the deal-seed mood clock. */
export function omahaVariantStrengthLeagueProfile(
  variant: OmahaPolicyVariant,
  profileId: string
): Plo4LeagueProfile {
  const p = omahaVariantStrengthProfile(variant, profileId);
  if (!p) throw new Error('Unknown P11.2 strength profile');
  const full = getFullRakeConfig(1, BB, variant);
  return {
    id: p.id,
    variant,
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
  };
}

/**
 * One shard of one pack's P11.2 matrix: a fixed range of pair indices of one
 * (profile, seed) cell, candidate arm then reference arm on each deal.
 * Contract mode plays exactly the pack's pairs per shard on one of that pack's
 * held-out seeds; development mode (tests, the design pilot) may play fewer
 * pairs and never touches any held-out seed (Phase 10 or Phase 11). Neither
 * mode can promote: the verdict is summarizeOmahaVariantStrength over every
 * shard of the pack.
 */
export async function runOmahaVariantStrengthShard(
  variant: OmahaPolicyVariant,
  request: {
    profileId: string;
    seed: number;
    shard: number;
    mode: 'contract' | 'development';
    pairs?: number;
  },
  shouldContinue = () => true
): Promise<OmahaVariantStrengthShardResult> {
  if (!isOmahaVariantStrengthVariant(variant)) throw new Error('Unknown P11.2 strength variant');
  const c = OMAHA_VARIANT_STRENGTH_CONTRACT;
  const pack = omahaVariantStrengthPack(variant);
  if (request.mode !== 'contract' && request.mode !== 'development')
    throw new Error('Unknown P11.2 shard mode');
  if (request.mode === 'contract' && !isOmahaVariantHoldoutSeedOf(variant, request.seed))
    throw new Error("A contract shard runs only one of its own pack's held-out seeds");
  if (
    request.mode === 'development' &&
    (isOmahaVariantHoldoutSeed(request.seed) || isPlo4HoldoutSeed(request.seed))
  )
    throw new Error('A development shard never runs a held-out seed');
  if (!Number.isInteger(request.seed) || request.seed < 1 || request.seed > 0xffffffff)
    throw new Error('Invalid P11.2 shard seed');
  const contractProfile = omahaVariantStrengthProfile(variant, request.profileId);
  if (
    !contractProfile ||
    !Number.isInteger(request.shard) ||
    request.shard < 0 ||
    request.shard >= contractProfile.shards
  )
    throw new Error('P11.2 shard outside the matrix');
  const requested = request.pairs ?? pack.matrix.pairsPerShard;
  if (request.mode === 'contract' && requested !== pack.matrix.pairsPerShard)
    throw new Error('A contract shard plays exactly the contract pairs per shard');
  if (!Number.isInteger(requested) || requested < 1 || requested > pack.matrix.pairsPerShard)
    throw new Error('Invalid P11.2 shard pair count');
  const profile = omahaVariantStrengthLeagueProfile(variant, request.profileId);
  assertFixedBudget();
  const started = performance.now();
  const firstPair = request.shard * pack.matrix.pairsPerShard;
  const strata = new Map<string, Plo4PowerAccumulator>();
  const offsetCounts: number[] = Array(profile.seats).fill(0);
  const digest = createHash('sha256');
  const result: OmahaVariantStrengthShardResult = {
    schema: 'horse-phase11-strength-shard-v1',
    variant,
    contractVersion: c.version,
    contractDigest: omahaVariantStrengthContractDigest(),
    packVersion: OMAHA_VARIANT_PACKS[variant].version,
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
    changed: 0,
    illegalActions: 0,
    conservationErrors: 0,
    cardErrors: 0,
    truncatedHands: 0,
    settlementMismatches: 0,
    deductionMismatches: 0,
    pairedReplayMismatches: 0,
    showdownsChecked: 0,
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
      policyClock: 'fixed_work_no_wall_clock_branch',
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
      result.foldWinsChecked += Number(h.checks.foldWinChecked);
      result.lowHalvesChecked += Number(h.checks.lowHalfChecked === true);
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
    const street = plo4DivergenceStreet(candidate.checks.trace, reference.checks.trace);
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

import type { HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from '../engine/HorseLogic.js';
import {
  isOmahaPolicyVariant,
  OMAHA_VARIANT_DOMAIN,
} from '../engine/omaha/OmahaVariantPolicyPack.js';
import {
  evaluateOmahaVariantPolicy,
  type OmahaVariantMode,
} from '../engine/omaha/OmahaVariantLivePolicy.js';
import type { OmahaVariantEquityEvidence } from '../engine/omaha/OmahaVariantEquity.js';
import {
  evaluateOmahaEquity,
  type OmahaRange,
  type OmahaEquityResult,
} from './OmahaEquityOracle.js';
import { omahaVariantPublicRanges } from './OmahaVariantPublicRanges.js';

export interface OmahaVariantPolicyInput {
  hero: SeatPlayer;
  state: HorseGameStateV2;
  baseline: HorseDecision;
  mode?: OmahaVariantMode;
  seed: number;
  samples?: number;
  opponentRanges?: Record<string, OmahaRange>;
}
export async function evaluateOmahaVariantProgram(
  input: OmahaVariantPolicyInput,
  shouldContinue = () => true
) {
  const started = performance.now();
  const { hero, baseline } = input;
  const s = { ...input.state, players: input.state.players.map((p) => ({ ...p, cards: [] })) };
  const mode = input.mode ?? 'shadow';
  let core = evaluateOmahaVariantPolicy(hero, s, baseline, null, mode, () => 0, 1, false);
  let equity: OmahaEquityResult | null = null;
  const finish = (reason: string, admitted = false) => ({
    selected:
      admitted &&
      mode === 'candidate' &&
      s.gameMode !== 'tournament' &&
      core.receipt.fired &&
      (s.stage === 'preflop' || equity?.complete)
        ? core.proposal
        : baseline,
    proposal: core.proposal,
    reason,
    livePolicy: core.receipt,
    equity,
    elapsedMs: performance.now() - started,
    rangeBasis: input.opponentRanges ? 'explicit_ranges' : 'variant_public_line_heuristic',
    promotionEligible: false,
  });
  if (!shouldContinue()) return finish('cancelled');
  if (!Number.isInteger(input.seed) || input.seed < 1 || input.seed > 0xffffffff)
    return finish('invalid_seed');
  const samples = input.samples ?? OMAHA_VARIANT_DOMAIN.defaultSamples;
  if (!Number.isInteger(samples) || samples < 1 || samples > OMAHA_VARIANT_DOMAIN.maxSamples)
    return finish('sample_budget_outside_pack');
  if (!isOmahaPolicyVariant(s.gameVariant) || !core.receipt.eligible || mode === 'off')
    return finish(core.receipt.reason);
  if (s.stage === 'preflop')
    return finish(
      s.gameMode === 'tournament' ? 'phase7_utility_required' : core.receipt.reason,
      true
    );
  const seats = s.players.filter((p) => !p.is_sitting_out);
  if (
    input.opponentRanges &&
    (Object.keys(input.opponentRanges).length !== seats.length - 1 ||
      seats.some(
        (p) => p.user_id !== hero.user_id && !Object.hasOwn(input.opponentRanges!, p.user_id)
      ))
  )
    return finish('incomplete_opponent_ranges');
  // Dead pooled antes have a separate settlement contract. The live canonical
  // per-pot sampler handles them; this independent reference refuses to pretend
  // ordinary matched contributions are an equivalent oracle.
  if (seats.some((p) => (p.deadInvested ?? 0) !== (p.individualAnteInvested ?? 0)))
    return finish('pooled_dead_money_reference_boundary');
  const ranges =
    input.opponentRanges ?? omahaVariantPublicRanges(s.gameVariant, hero, s, input.seed);
  const call = Math.min(hero.stack, Math.max(0, s.currentBet - hero.bet));
  const players = seats.map((p) => ({
    id: p.user_id,
    seat: p.seat,
    folded: p.is_folded,
    contributed:
      Math.round((p.totalInvested + (p.user_id === hero.user_id ? call : 0)) * 100) / 100,
    range:
      p.user_id === hero.user_id
        ? { combos: [{ cards: hero.cards, weight: 1 }] }
        : ranges[p.user_id],
  }));
  try {
    const combinations = players.reduce(
      (n, p) => n * ('combos' in p.range ? p.range.combos.length : Infinity),
      1
    );
    equity = await evaluateOmahaEquity(
      {
        variant: s.gameVariant,
        heroId: hero.user_id,
        players,
        boards: [s.communityCards],
        dealerSeat: s.dealerSeat!,
        chipUnit: s.gameMode === 'tournament' ? 1 : 0.01,
        mode:
          input.opponentRanges && s.stage === 'river' && combinations <= 4096
            ? 'exact_river'
            : 'sampled',
        samples,
        seed: input.seed,
      },
      shouldContinue
    );
    if (!equity.complete) return finish(`equity_${equity.reason}`);
    const evidence: OmahaVariantEquityEvidence = {
      analysisMs: 0,
      equity: equity.equity,
      highEquity: equity.highEquity,
      lowEquity: equity.lowEquity,
      samples: equity.samples,
      standardError: equity.standardError ?? 0.5,
      confidence99: equity.confidence99,
      scoopProbability: equity.scoopProbability,
      quarterOrLessProbability: equity.quarterOrLessProbability,
      sixthOrLessProbability: equity.distribution
        .filter((b) => b.share > 0 && b.share <= 1 / 6 + 1e-9)
        .reduce((n, b) => n + b.probability, 0),
      eligiblePot: equity.eligiblePot,
      expectedChips: equity.equity * equity.eligiblePot,
      minimumObservedShare: Math.min(...equity.distribution.map((b) => b.share)),
      maximumObservedShare: Math.max(...equity.distribution.map((b) => b.share)),
      distribution: equity.distribution,
      perPot: equity.perPot,
      provenance: 'independent_offline_oracle',
    };
    core = evaluateOmahaVariantPolicy(hero, s, baseline, evidence, mode, () => 0, 1, false);
    return finish(
      s.gameMode === 'tournament' ? 'phase7_utility_required' : core.receipt.reason,
      true
    );
  } catch {
    return finish('invalid_or_incompatible_equity_request');
  }
}

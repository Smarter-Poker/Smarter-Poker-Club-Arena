/** Separate WTA HU tournament objective. An unsigned finite-prior proposal is
 * conditional arithmetic only; this module grants no qualification/admission. */
import { createHash } from 'node:crypto';
import type { Card, HorseDecision } from '../../types.js';
import type { CorrectiveAction } from './contract.js';
import { evidenceDigest } from './authority.js';
import { horseJournalJson } from '../horseDecisionJournal/record.js';
import { correctiveBaselineRefusal } from './kernelEligibility.js';
import {
  priceClosedHeadsUpTournamentRiver,
  type TournamentRiverReferenceInput,
  type TournamentRiverReferenceResult,
} from './tournamentRiverReference.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
  tournamentKernelDefinitionFor,
  type TournamentKernelObjective,
} from './kernelTournamentDefinition.js';
import { correctiveDecisionDomain } from './domain.js';
import {
  priceClosedHeadsUpTournamentLadderRiver,
  type ClosedHeadsUpTournamentRiverInput,
  type ClosedHeadsUpTournamentRiverResult,
} from './closedHeadsUpTournamentRiverReference.js';
export {
  TOURNAMENT_RIVER_DECISION_MODEL,
  TOURNAMENT_RIVER_CORRECTION_KERNEL,
} from './kernelTournamentDefinition.js';
type Original = TournamentRiverReferenceInput['original'];
type Priced = Extract<
  TournamentRiverReferenceResult | ClosedHeadsUpTournamentRiverResult,
  { status: 'priced' }
>;
const flags = { qualified: false as const, activationAllowed: false as const };
export type TournamentRiverDecisionModelResult = typeof flags &
  (
    | {
        status: 'built';
        modelVersion: string;
        kernelVersion: string;
        samplingSeedDigest: string;
        samplingContractDigest: string;
        input: TournamentRiverReferenceInput | ClosedHeadsUpTournamentRiverInput;
        prices: Priced;
      }
    | { status: 'unavailable'; reason: string }
  );
const key = (card: Card) => card.rank + ':' + card.suit;
/** Exactly32 deterministic public-information combos. Actor IDs, request IDs,
 * clocks, observed opponent holdings, outcomes and process RNG never seed it.
 * The original snapshot/frame remain intact for separate authenticated review. */
export function buildOriginalTournamentRiverDecision(
  source: Original
): TournamentRiverDecisionModelResult {
  const no = (reason: string): TournamentRiverDecisionModelResult => ({
    ...flags,
    status: 'unavailable',
    reason,
  });
  try {
    const original = JSON.parse(horseJournalJson(source)) as Original;
    const snapshot = original.snapshot,
      gs = snapshot.gameState,
      hero = snapshot.player;
    if (
      snapshot.type !== 'DECIDE_FAST' ||
      gs.gameVariant !== 'nlh' ||
      !['spin', 'mtt', 'sng', 'hu_sng'].includes(gs.format ?? '') ||
      gs.gameMode !== 'tournament' ||
      gs.boardCount !== 1 ||
      gs.stage !== 'river'
    )
      return no('unsupported_tournament_model_domain');
    const domain = correctiveDecisionDomain(gs);
    const definition = tournamentKernelDefinitionFor(
      gs.format === 'spin' ? TOURNAMENT_KERNEL_OBJECTIVE : CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
      domain
    );
    if (!definition) return no('unsupported_tournament_model_domain');
    const suits: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
    const deck: Card[] = suits.flatMap((suit) =>
      [...'23456789TJQKA'].map((rank) => ({ rank: rank as Card['rank'], suit }))
    );
    const universe = new Set(deck.map(key)),
      known = [...hero.cards, ...gs.communityCards],
      dead = new Set(known.map(key));
    if (
      hero.cards.length !== 2 ||
      gs.communityCards.length !== 5 ||
      dead.size !== 7 ||
      known.some((card) => !universe.has(key(card)))
    )
      return no('original_tournament_cards_invalid');
    if (
      !Array.isArray(gs.players) ||
      gs.players.length !== 2 ||
      (gs.actionHistory?.length ?? 0) > 256
    )
      return no('original_tournament_history_or_player_bounds');
    const available = deck.filter((card) => !dead.has(key(card)));
    const samplingSeedDigest = evidenceDigest({
      model: definition.model.version,
      objective: definition.kernel.objective,
      utilityUnit: definition.kernel.utilityUnit,
      heroSeat: hero.seat,
      hero: hero.cards.map(key).sort(),
      board: gs.communityCards.map(key).sort(),
      bigBlind: gs.bigBlind,
      toCall: gs.toCall,
      players: gs.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          seat: p.seat,
          stack: p.stack,
          bet: p.bet,
          totalInvested: p.totalInvested,
          deadInvested: p.deadInvested ?? 0,
          individualAnteInvested: p.individualAnteInvested ?? 0,
          allIn: p.is_all_in,
        })),
      actions: (gs.actionHistory ?? []).map((action) => ({
        seat: gs.players.find((p) => p.user_id === action.userId)?.seat ?? null,
        action: action.action,
        amount: action.amount,
        stage: action.stage,
      })),
    });
    const range: TournamentRiverReferenceInput['range'] = [],
      seen = new Set<string>();
    for (let index = 0; index < definition.model.samples; index++) {
      let added = false;
      for (let attempt = 0; attempt < definition.model.maximumAttemptsPerCombination; attempt++) {
        const remaining = available.slice(),
          cards: Card[] = [];
        for (let slot = 0; slot < 2; slot++) {
          const word = createHash('sha256')
            .update(samplingSeedDigest)
            .update(`:${index}:${attempt}:${slot}`)
            .digest()
            .readUInt32BE(0);
          cards.push(remaining.splice(word % remaining.length, 1)[0]!);
        }
        const combination = cards.map(key).sort().join('|');
        if (seen.has(combination)) continue;
        seen.add(combination);
        range.push({ cards, weight: 1 });
        added = true;
        break;
      }
      if (!added) return no('tournament_model_combination_budget');
    }
    const input: TournamentRiverReferenceInput | ClosedHeadsUpTournamentRiverInput = {
      version:
        gs.format === 'spin'
          ? 'horse-wta-spin-river-reference-v1'
          : 'horse-closed-hu-ladder-river-reference-v1',
      original,
      range,
      rangeReadFrameDigest: evidenceDigest(original.readFrame),
    };
    const prices =
      input.version === 'horse-wta-spin-river-reference-v1'
        ? priceClosedHeadsUpTournamentRiver(input)
        : priceClosedHeadsUpTournamentLadderRiver(input);
    if (prices.status !== 'priced') return no(prices.reason);
    const samplingContractDigest = evidenceDigest({
      version:
        gs.format === 'spin'
          ? 'horse-wta-spin-public-finite-prior-contract-v1'
          : 'horse-closed-hu-ladder-public-finite-prior-contract-v1',
      model: definition.model,
      kernel: definition.kernel,
      rangeBasis: 'uniform_distinct_combos_from_original_hero_public_board_only',
      menuScope: 'fold_call_only_other_baseline_actions_unchanged',
      enumerationError: 0,
      modelCalibration: 'unqualified',
    });
    return {
      ...flags,
      status: 'built',
      modelVersion: definition.model.version,
      kernelVersion: definition.kernel.version,
      samplingSeedDigest,
      samplingContractDigest,
      input,
      prices,
    };
  } catch {
    return no('original_tournament_model_unavailable');
  }
}
export type TournamentRiverKernelProposal = typeof flags &
  (
    | { status: 'retained'; reason: string }
    | { status: 'unavailable'; reason: string }
    | {
        status: 'proposed';
        from: CorrectiveAction;
        to: CorrectiveAction;
        objective: TournamentKernelObjective;
        utilityUnit: 'prize_share';
        conditionalProbability: 0.05;
        modelGainLowerPrizeShare: number;
        inputDigest: string;
        readFrameDigest: string;
        tournamentContextDigest: string;
        samplingContractDigest: string;
        modelVersion: string;
        kernelVersion: string;
      }
  );
/** Reuses the full baseline's continuation/earlier-owner protections before
 * model work. No RNG draw, authority receipt, signed envelope or live mutation. */
export function proposeOriginalTournamentRiverCorrection(
  original: Original,
  baseline: HorseDecision
): TournamentRiverKernelProposal {
  const no = (
    status: 'retained' | 'unavailable',
    reason: string
  ): TournamentRiverKernelProposal => ({ ...flags, status, reason });
  try {
    const refusal = correctiveBaselineRefusal(original, baseline);
    if (refusal) return no('retained', refusal);
    const model = buildOriginalTournamentRiverDecision(original);
    if (model.status !== 'built') return no('unavailable', model.reason);
    const domain = correctiveDecisionDomain(model.input.original.snapshot.gameState);
    const definition = tournamentKernelDefinitionFor(model.prices.objective, domain);
    if (
      !definition ||
      definition.model.version !== model.modelVersion ||
      definition.kernel.version !== model.kernelVersion
    )
      return no('unavailable', 'tournament_model_definition_mismatch');
    const call = model.input.original.snapshot.gameState.toCall!;
    if (baseline.action === 'call' && (baseline.amount ?? call) !== call)
      return no('unavailable', 'tournament_baseline_price_mismatch');
    const from: CorrectiveAction =
      baseline.action === 'fold' ? { action: 'fold', amount: 0 } : { action: 'call', amount: call };
    const fold = model.prices.fold.expectedPrizeShare,
      callShare = model.prices.call.expectedPrizeShare;
    const gain = from.action === 'fold' ? callShare - fold : fold - callShare;
    if (!Number.isFinite(gain) || gain <= definition.kernel.minimumModelGainPrizeShare)
      return no('retained', 'tournament_model_gain_below_threshold');
    return {
      ...flags,
      status: 'proposed',
      from,
      to: from.action === 'fold' ? { action: 'call', amount: call } : { action: 'fold', amount: 0 },
      objective: definition.objective,
      utilityUnit: 'prize_share',
      conditionalProbability: definition.kernel.conditionalProbability,
      modelGainLowerPrizeShare: gain,
      inputDigest: model.prices.inputDigest,
      readFrameDigest: model.prices.readFrameDigest,
      tournamentContextDigest: model.prices.tournamentContextDigest,
      samplingContractDigest: model.samplingContractDigest,
      modelVersion: definition.model.version,
      kernelVersion: definition.kernel.version,
    };
  } catch {
    return no('unavailable', 'tournament_kernel_unavailable');
  }
}

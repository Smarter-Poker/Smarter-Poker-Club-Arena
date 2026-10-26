/** Objective dispatch inside the existing source/qualification pipeline.
 * This unsigned adapter never grants admission or changes the cash v1 producer. */
import { buildOriginalRiverDecision } from './riverDecisionModel.js';
import { buildOriginalTournamentRiverDecision } from './tournamentRiverKernel.js';
import type { RiverReferenceInput, RiverDecisionInput } from './riverReference.js';
import { evidenceDigest } from './authority.js';
import {
  TOURNAMENT_KERNEL_UTILITY_UNIT,
  tournamentKernelDefinitionFor,
  type TournamentKernelObjective,
} from './kernelTournamentDefinition.js';
export interface TournamentKernelReferenceInput extends RiverReferenceInput {
  objective: TournamentKernelObjective;
  utilityUnit: typeof TOURNAMENT_KERNEL_UTILITY_UNIT;
}
export function buildFunctionalRiverDecision(original: RiverDecisionInput['original']) {
  const gs = original.snapshot.gameState;
  if (gs.gameMode === 'cash' && gs.format === 'cash') return buildOriginalRiverDecision(original);
  const model = buildOriginalTournamentRiverDecision(original);
  if (model.status !== 'built') return model;
  const snapshot = model.input.original.snapshot,
    state = snapshot.gameState;
  const input: RiverDecisionInput & {
    objective: TournamentKernelObjective;
    utilityUnit: typeof TOURNAMENT_KERNEL_UTILITY_UNIT;
  } = {
    domain: {
      variant: 'nlh',
      format: state.format as 'spin' | 'mtt' | 'sng' | 'hu_sng',
      mode: 'tournament',
    },
    objective: model.prices.objective,
    utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
    stage: 'river',
    boardCount: 1,
    opponents: 1,
    opponentAllIn: true,
    hero: snapshot.player.cards,
    board: state.communityCards,
    range: model.input.range,
    rangeDigest: evidenceDigest(model.input.range),
    rangeReadFrameDigest: model.input.rangeReadFrameDigest,
    contestablePot: state.pot,
    toCall: state.toCall!,
    stack: snapshot.player.stack,
    bigBlind: state.bigBlind,
    finalRake: 0,
    utilityContextDigest: evidenceDigest({
      version: 'horse-tournament-utility-context-v1',
      objective: model.prices.objective,
      utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
      tournament: state.tournament,
    }),
    original: model.input.original,
  };
  return { ...model, input, prices: { ...model.prices, finalRake: 0 as const } };
}
export function isTournamentKernelReferenceInput(
  input: RiverReferenceInput
): input is TournamentKernelReferenceInput {
  const value = input as Partial<TournamentKernelReferenceInput>;
  return (
    value.utilityUnit === TOURNAMENT_KERNEL_UTILITY_UNIT &&
    tournamentKernelDefinitionFor(value.objective, input.domain) !== null
  );
}

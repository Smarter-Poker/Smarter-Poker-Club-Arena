/** Import-free fixed definitions. These identify the narrow WTA HU ICM
 * chip-share model, not a realized-prize or cash-big-blind objective. */
export const TOURNAMENT_KERNEL_OBJECTIVE = 'wta_hu_icm_chip_share_v1' as const;
export const TOURNAMENT_KERNEL_UTILITY_UNIT = 'prize_share' as const;
export const TOURNAMENT_RIVER_DECISION_MODEL = Object.freeze({
  version: 'wta-hu-spin-public-finite-prior-v1',
  samples: 32,
  maximumAttemptsPerCombination: 8,
  calibration: 'unqualified' as const,
});
export const TOURNAMENT_RIVER_CORRECTION_KERNEL = Object.freeze({
  version: 'wta-hu-spin-call-fold-correction-v1',
  modelVersion: TOURNAMENT_RIVER_DECISION_MODEL.version,
  objective: TOURNAMENT_KERNEL_OBJECTIVE,
  utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
  conditionalProbability: 0.05 as const,
  minimumModelGainPrizeShare: 0.0001,
});

export const CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE = 'closed_hu_ladder_icm_prize_share_v1' as const;
export const CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL = Object.freeze({
  version: 'closed-hu-ladder-public-finite-prior-v1',
  samples: 32,
  maximumAttemptsPerCombination: 8,
  calibration: 'unqualified' as const,
});
export const CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL = Object.freeze({
  version: 'closed-hu-ladder-call-fold-correction-v1',
  modelVersion: CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL.version,
  objective: CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
  utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
  conditionalProbability: 0.05 as const,
  minimumModelGainPrizeShare: 0.0001,
});
export type TournamentKernelObjective =
  | typeof TOURNAMENT_KERNEL_OBJECTIVE
  | typeof CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE;
const wtaDefinition = Object.freeze({
  objective: TOURNAMENT_KERNEL_OBJECTIVE,
  utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
  model: TOURNAMENT_RIVER_DECISION_MODEL,
  kernel: TOURNAMENT_RIVER_CORRECTION_KERNEL,
});
const closedDefinition = Object.freeze({
  objective: CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
  utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
  model: CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL,
  kernel: CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL,
});
export const tournamentKernelObjectiveIsKnown = (
  value: unknown
): value is TournamentKernelObjective =>
  value === TOURNAMENT_KERNEL_OBJECTIVE || value === CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE;
/** Code-owned identities only. This does not grant domain eligibility. */
export function tournamentKernelDefinitionForObjective(objective: unknown) {
  return objective === TOURNAMENT_KERNEL_OBJECTIVE
    ? wtaDefinition
    : objective === CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE
      ? closedDefinition
      : null;
}
/** Exact registry: no default tournament family or inferred utility model. */
export function tournamentKernelDefinitionFor(objective: unknown, domain: unknown) {
  try {
    if (
      !domain ||
      typeof domain !== 'object' ||
      Array.isArray(domain) ||
      Object.keys(domain).sort().join(',') !== 'format,mode,variant'
    )
      return null;
    const d = domain as Record<string, unknown>,
      definition = tournamentKernelDefinitionForObjective(objective);
    if (!definition || d.variant !== 'nlh' || d.mode !== 'tournament') return null;
    return objective === TOURNAMENT_KERNEL_OBJECTIVE
      ? d.format === 'spin'
        ? definition
        : null
      : ['mtt', 'sng', 'hu_sng'].includes(d.format as string)
        ? definition
        : null;
  } catch {
    return null;
  }
}

/** Import-free policy constants: safe even when evaluators load the brain. */
export const RIVER_DECISION_MODEL = Object.freeze({
  version: 'river-public-finite-prior-v1',
  samples: 32,
  maximumAttemptsPerCombination: 8,
  calibration: 'unqualified' as const,
});
export const RIVER_CORRECTION_KERNEL = Object.freeze({
  version: 'river-call-fold-correction-v2',
  modelVersion: RIVER_DECISION_MODEL.version,
  conditionalProbability: 0.05 as const,
  minimumModelGainBb: 0.01,
});

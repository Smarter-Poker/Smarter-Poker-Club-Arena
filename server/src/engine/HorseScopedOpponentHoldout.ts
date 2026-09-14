import { createHash } from 'node:crypto';
import {
  buildScopedOpponentModel,
  buildJournaledOpponentModel,
  SCOPED_MODEL_ACTIONS,
  SCOPED_MODEL_POLICY,
  type ScopedOpponentModelInput,
  type JournaledOpponentModelInput,
  type ScopedOpponentModelResult,
} from './HorseScopedOpponentModel.js';

export const SCOPED_HOLDOUT_POLICY = Object.freeze({
  version: 'session-weighted-brier-holdout-v1',
  score: 'multiclass-brier-prior-minus-model',
  interval: 'joint-heldout-frequency-bounds-v1',
  scoreTolerance: 1e-12,
  activationAuthority: false,
} as const);
export type ScopedHoldoutInput = Omit<ScopedOpponentModelInput, 'partition'>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refusal = (reason: string) => Object.freeze({ status: 'unavailable' as const, reason });

/** Predictive validation for one fixed node/model against its stated prior.
 * Held-out actions never fit the candidate. This neither estimates action EV
 * nor establishes causality, independence, prior provenance or model-selection
 * correction. Complete-window acquisition remains the caller's responsibility.
 */
export function validateScopedOpponentHoldout(input: ScopedHoldoutInput) {
  return validateModels(input, (partition) => buildScopedOpponentModel({ ...input, partition }));
}

/** Predictive diagnostics of captured observations only. Selection/capture
 * bias and repeated holdout use remain unresolved; no causal or live authority. */
export function validateJournaledOpponentHoldout(
  input: Omit<JournaledOpponentModelInput, 'partition'>
) {
  return Object.freeze({
    population: 'journaled_qualified_observations' as const,
    sourceCoverage: 'not_established' as const,
    activationAuthorized: false as const,
    validation: validateModels(
      input,
      (partition) => buildJournaledOpponentModel({ ...input, partition }).model
    ),
  });
}

function validateModels(
  input: ScopedHoldoutInput | Omit<JournaledOpponentModelInput, 'partition'>,
  build: (partition: 'training' | 'holdout') => ScopedOpponentModelResult
) {
  const training = build('training');
  if (training.status === 'unavailable') return refusal(training.reason);
  const heldout = build('holdout');
  if (heldout.status === 'unavailable') return refusal(heldout.reason);

  // A relabeled session cannot put one physical hand in both arms. Check the
  // source identities after both builders have validated the scoped evidence.
  const trainingHands = new Set<string>(),
    holdoutHands = new Set<string>();
  for (const o of input.observations) {
    if (
      o.scopeKey !== input.scopeKey ||
      o.actorKey !== input.opponentKey ||
      o.observedAtMs < input.window.fromMs ||
      o.observedAtMs >= input.window.toMs ||
      (input.cohort === 'human'
        ? o.origin !== 'player' && o.origin !== 'pre_action'
        : o.origin !== 'horse_policy')
    )
      continue;
    (o.partition === 'training' ? trainingHands : holdoutHands).add(o.handId);
  }
  for (const id of trainingHands) if (holdoutHands.has(id)) return refusal('partition_overlap');

  let point = 0,
    lower = 0,
    upper = 0;
  for (const action of SCOPED_MODEL_ACTIONS) {
    const p = input.prior.probabilities[action],
      q = training.probabilities[action];
    const constant = p * p - q * q,
      coefficient = 2 * (q - p);
    // The model's held-out point is shrunk. Recover its empirical frequency
    // before scoring; otherwise the baseline would grade its own prior mass.
    const mass = heldout.effectiveSessions;
    const empirical =
      mass > 0
        ? Math.max(
            0,
            Math.min(
              1,
              (heldout.probabilities[action] * (mass + SCOPED_MODEL_POLICY.priorSessionMass) -
                SCOPED_MODEL_POLICY.priorSessionMass * p) /
                mass
            )
          )
        : p;
    const [lo, hi] = heldout.intervals[action];
    point += constant + coefficient * empirical;
    lower += constant + coefficient * (coefficient >= 0 ? lo : hi);
    upper += constant + coefficient * (coefficient >= 0 ? hi : lo);
  }
  // A difference of two multiclass Brier losses is always in [-2, 2].
  // Round the reported bounds outward, so floating-point cancellation cannot
  // shave a mathematically included endpoint off the certificate.
  lower = Math.max(-2, lower - SCOPED_HOLDOUT_POLICY.scoreTolerance);
  upper = Math.min(2, upper + SCOPED_HOLDOUT_POLICY.scoreTolerance);
  const sufficient = training.status === 'estimated' && heldout.status === 'estimated';
  const status = !sufficient
    ? 'insufficient_evidence'
    : lower > SCOPED_HOLDOUT_POLICY.scoreTolerance
      ? 'predictive_improvement'
      : upper < -SCOPED_HOLDOUT_POLICY.scoreTolerance
        ? 'predictive_regression'
        : 'inconclusive';
  return Object.freeze({
    status,
    validationId: hash([SCOPED_HOLDOUT_POLICY, training.modelId, heldout.modelId]),
    policyVersion: SCOPED_HOLDOUT_POLICY.version,
    trainingModelId: training.modelId,
    heldoutModelId: heldout.modelId,
    trainingEvidenceDigest: training.evidenceDigest,
    heldoutEvidenceDigest: heldout.evidenceDigest,
    scopeKey: input.scopeKey,
    opponentKey: input.opponentKey,
    cohort: input.cohort,
    window: training.window,
    priorVersion: input.prior.version,
    trainingSessions: training.sessions,
    heldoutSessions: heldout.sessions,
    heldoutHands: heldout.hands,
    heldoutObservations: heldout.observations,
    heldoutEffectiveSessions: heldout.effectiveSessions,
    brierImprovement: heldout.effectiveSessions > 0 ? point : null,
    interval: Object.freeze([lower, upper] as const),
    familyError: SCOPED_MODEL_POLICY.familyError,
    intervalCondition: 'independent_sessions_fixed_candidate_no_selection_correction' as const,
    causalEvEstablished: false as const,
    activationAuthorized: false as const,
  });
}

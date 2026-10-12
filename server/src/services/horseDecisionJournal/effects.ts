import {
  horsePlanContextMatchesRequest,
  horsePlanBatchBindingMatchesRequest,
  type HorsePlanContext,
} from '../../engine/HorsePlanHandIdentity.js';
import {
  horseDecisionEffectsMatchRequest,
  horseReferenceWagerWasRetained,
} from '../../engine/HorseDecisionEffects.js';
import type {
  FastHorseDecisionRequest,
  DeepHorseDecisionRequest,
} from '../../engine/horseDecision/protocol.js';
import type { HorseDecision } from '../../types.js';
import { HORSE_DECISION_READ_FRAME_MAX_BYTES } from '../../engine/HorseDecisionReadFrame.js';

export interface HorseRetainedEffectsQualification {
  status: 'qualified' | 'unavailable' | 'invalid';
  reason:
    | 'fast_batch_valid'
    | 'deep_effects_not_emitted'
    | 'fast_effects_missing'
    | 'unsupported_capture_version'
    | 'invalid_capture'
    | 'invalid_fast_effects'
    | 'deep_effects_unexpected'
    | 'invalid_plan_binding';
  batchSize: number | null;
  /** A capture is speculative intent. This never proves a later mind write. */
  applicationVerified: false;
  /** Absent on historical captures. An allocated coordinate is only an input
   * join, not a claim of authenticated source, plan application or acceptance. */
  planIdentity?: 'allocated_coordinate' | 'unavailable_coordinate';
}

const result = (
  status: HorseRetainedEffectsQualification['status'],
  reason: HorseRetainedEffectsQualification['reason'],
  batchSize: number | null = null
): HorseRetainedEffectsQualification => ({ status, reason, batchSize, applicationVerified: false });

export type HorseRetainedPlanContext =
  | { kind: 'legacy' }
  | { kind: 'current'; context: HorsePlanContext }
  | { kind: 'invalid' };

/** Preserve v1 under its original rules, never upgrade it from request shape.
 * New-present markers are checked against the original retained request; a
 * allocated v2/v3 frame without those markers cannot enter legacy qualification.
 * A contextless v3 read codec remains a legacy plan capture, not allocated proof.
 * Full frame digest, actor and body validation remains with the replay reader. */
export function horseRetainedPlanContext(
  capture: unknown,
  request: FastHorseDecisionRequest | DeepHorseDecisionRequest
): HorseRetainedPlanContext {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return { kind: 'invalid' };
  const value = capture as Record<string, unknown>;
  const hasContext = Object.hasOwn(value, 'planContext');
  const hasBinding = Object.hasOwn(value, 'planBinding');
  const frame = value.readFrame as { version?: unknown; json?: unknown } | null | undefined;
  let allocatedFrame = frame?.version === 'horse-decision-reads-v2';
  if (frame?.version === 'horse-decision-reads-v3') {
    if (typeof frame.json !== 'string' || frame.json.length > HORSE_DECISION_READ_FRAME_MAX_BYTES)
      return { kind: 'invalid' };
    try {
      const body = JSON.parse(frame.json);
      if (!body || typeof body !== 'object' || body.version !== frame.version)
        return { kind: 'invalid' };
      allocatedFrame = Object.hasOwn(body, 'planContext');
    } catch {
      return { kind: 'invalid' };
    }
  }
  if (!hasContext && !hasBinding) return allocatedFrame ? { kind: 'invalid' } : { kind: 'legacy' };
  if (
    !hasContext ||
    !horsePlanContextMatchesRequest(value.planContext, request) ||
    (request.type === 'DECIDE_FAST'
      ? !hasBinding || !horsePlanBatchBindingMatchesRequest(value.planBinding, request)
      : hasBinding) ||
    (frame != null && !allocatedFrame)
  )
    return { kind: 'invalid' };
  return { kind: 'current', context: value.planContext };
}

/** Retained ordinary decision-body contract inside a separately validated v1
 * journal envelope. Both reviewed producer generations (lifecycle absent and
 * lifecycleVersion=1) emit a FAST batch, including []. Neither emits DEEP effects.
 * Missing FAST evidence is never repaired from sourceRelease or version absence.
 * Other decision, snapshot/digest and receipt predicates remain the caller's job.
 * No policy execution, plan mutation, source authentication or activation occurs. */
export function qualifyHorseRetainedDecisionEffects(
  capture: unknown,
  request: FastHorseDecisionRequest | DeepHorseDecisionRequest
): HorseRetainedEffectsQualification {
  try {
    if (
      !capture ||
      typeof capture !== 'object' ||
      Array.isArray(capture) ||
      !request ||
      !['DECIDE_FAST', 'DECIDE_DEEP'].includes(request.type)
    )
      return result('invalid', 'invalid_capture');
    const value = capture as Record<string, unknown>;
    if (value.lifecycleVersion !== undefined && value.lifecycleVersion !== 1)
      return result('invalid', 'unsupported_capture_version');
    const plan = horseRetainedPlanContext(value, request);
    if (plan.kind === 'invalid') return result('invalid', 'invalid_plan_binding');
    const qualified = (
      reason: HorseRetainedEffectsQualification['reason'],
      batchSize: number | null = null
    ) => ({
      ...result('qualified', reason, batchSize),
      ...(plan.kind === 'current'
        ? {
            planIdentity:
              plan.context.hand === null
                ? ('unavailable_coordinate' as const)
                : ('allocated_coordinate' as const),
          }
        : {}),
    });
    const hasEffects = Object.prototype.hasOwnProperty.call(value, 'effects');
    if (request.type === 'DECIDE_DEEP') {
      return hasEffects
        ? result('invalid', 'deep_effects_unexpected')
        : qualified('deep_effects_not_emitted');
    }
    if (!hasEffects) return result('unavailable', 'fast_effects_missing');
    const decision = value.decision as HorseDecision | undefined;
    if (
      !horseDecisionEffectsMatchRequest(value.effects, {
        userId: request.player.user_id,
        history: request.gameState.actionHistory,
        street: request.gameState.stage,
        brainFallback: decision?.policyFallback === 'brain_exception',
        ...(plan.kind === 'current' ? { planContext: plan.context } : {}),
      }) ||
      (value.effects.length > 0 && (!decision || !horseReferenceWagerWasRetained(decision)))
    )
      return result('invalid', 'invalid_fast_effects');
    return qualified('fast_batch_valid', value.effects.length);
  } catch {
    return result('invalid', 'invalid_capture');
  }
}

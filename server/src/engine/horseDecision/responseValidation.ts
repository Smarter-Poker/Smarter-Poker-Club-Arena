import type { HorseDecision } from '../../types.js';
import { HORSE_POLICY_ORDER, type HorsePolicyAction } from '../HorsePolicyGraph.js';
import { horsePolicyOwnershipMatches } from '../HorsePolicyRegistry.js';
import type { GovernorSnapshot } from '../EquityLoadGovernor.js';

const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise', 'all_in'] as const;
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: RecordValue, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function horseGovernorScaleIsValid(value: unknown): value is number {
  return nonnegative(value) && value > 0 && value <= 1;
}

/** Only finite, complete worker-owned readings may enter readiness or health.
 * A stale but well-formed reading stays explicitly stale; no replacement value
 * is inferred here. The governor itself continues to own load adaptation. */
export function horseGovernorSnapshotIsValid(value: unknown): value is GovernorSnapshot {
  return (
    record(value) &&
    exact(value, [
      'enabled',
      'scale',
      'p50Ms',
      'p99Ms',
      'sampledAt',
      'throttledForS',
      'stale',
      'timerLateMs',
    ]) &&
    typeof value.enabled === 'boolean' &&
    typeof value.stale === 'boolean' &&
    horseGovernorScaleIsValid(value.scale) &&
    ['p50Ms', 'p99Ms', 'sampledAt', 'throttledForS', 'timerLateMs'].every((key) =>
      nonnegative(value[key])
    )
  );
}

export function horseSamplingStateIsValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

export function horseComputeMetadataIsValid(value: {
  computeMs: unknown;
  governorScale: unknown;
}): boolean {
  return nonnegative(value.computeMs) && horseGovernorScaleIsValid(value.governorScale);
}
function action(value: unknown): value is HorsePolicyAction {
  return (
    record(value) &&
    exact(value, ['action', 'amount']) &&
    ACTIONS.includes(value.action as (typeof ACTIONS)[number]) &&
    (value.amount === null || nonnegative(value.amount))
  );
}
function same(a: HorsePolicyAction, b: HorsePolicyAction): boolean {
  return a.action === b.action && a.amount === b.amount;
}

/** Bounded structured-clone validation before witness construction. A graph
 * may be absent on legacy or caught-failure decisions; absence is not proof
 * of graph execution. A supplied graph must be complete, continuous and
 * action-only, and its final action must match the returned decision. */
export function horseDecisionReceiptIsValid(
  value: unknown,
  expectedVariant?: string
): value is HorseDecision {
  if (
    !record(value) ||
    !ACTIONS.includes(value.action as (typeof ACTIONS)[number]) ||
    !nonnegative(value.thinkTime) ||
    (value.amount !== undefined && !nonnegative(value.amount)) ||
    (value.policyFallback !== undefined && value.policyFallback !== 'brain_exception')
  )
    return false;
  if (
    value.policyFallback === 'brain_exception' &&
    (!['check', 'fold'].includes(value.action as string) ||
      value.amount !== undefined ||
      value.policyGraph !== undefined ||
      value.policyOwnership !== undefined)
  )
    return false;
  if (!horsePolicyOwnershipMatches(value as unknown as HorseDecision)) return false;
  if (
    value.policyOwnership !== undefined &&
    expectedVariant !== undefined &&
    (value.policyOwnership as HorseDecision['policyOwnership'])?.variant !== expectedVariant
  )
    return false;
  if (value.policyGraph === undefined) return true;
  const graph = value.policyGraph;
  if (
    !record(graph) ||
    !exact(graph, ['version', 'transitions', 'finalAction']) ||
    graph.version !== 'horse-policy-order-v1' ||
    !Array.isArray(graph.transitions) ||
    graph.transitions.length !== HORSE_POLICY_ORDER.length ||
    !action(graph.finalAction)
  )
    return false;
  let previous: HorsePolicyAction | null = null;
  for (let i = 0; i < HORSE_POLICY_ORDER.length; i++) {
    const transition = graph.transitions[i];
    if (
      !record(transition) ||
      !exact(transition, ['node', 'before', 'after', 'changed', 'elapsedMs']) ||
      transition.node !== HORSE_POLICY_ORDER[i] ||
      !action(transition.after) ||
      !nonnegative(transition.elapsedMs)
    )
      return false;
    if (
      previous === null
        ? transition.before !== null
        : !action(transition.before) || !same(previous, transition.before)
    )
      return false;
    const changed = previous !== null && !same(previous, transition.after);
    if (transition.changed !== changed || (transition.node === 'timing' && changed)) return false;
    previous = transition.after;
  }
  return (
    previous !== null &&
    same(previous, graph.finalAction) &&
    same(graph.finalAction, {
      action: value.action as HorseDecision['action'],
      amount: (value.amount as number | undefined) ?? null,
    })
  );
}

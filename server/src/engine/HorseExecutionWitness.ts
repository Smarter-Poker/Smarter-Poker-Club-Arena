import type { ActionType, ActionRecord, HorseDecision } from '../types.js';
import type { LiveHorseDecisionSnapshot } from './horseDecision/protocol.js';
import type { HorsePolicyGraphReceipt } from './HorsePolicyGraph.js';
import { noteFire } from './BrainTelemetry.js';

export type HorseExecutionRetirement =
  | 'caller_settled'
  | 'turn_abandoned'
  | 'response_fence'
  | 'second_look_replaced'
  | 'second_look_unchanged'
  | 'action_rejected'
  | 'accepted_without_record'
  | 'multiple_accepted_actions';

export interface HorseAcceptedAction {
  readonly record: Readonly<Pick<ActionRecord, 'seat' | 'action' | 'amount' | 'stage'>>;
  readonly intended: boolean;
}

/** Private, bounded receipt for a returned betting decision. This is not a
 * durable ledger or a replay input. Never serialize it into public table state:
 * the canonical digest binds the hero's private input, even though no cards or
 * RNG seeds are copied here. The existing flush publishes only finite counters.
 */
export interface HorseExecutionWitness {
  readonly version: 'horse-execution-witness-v1';
  readonly identity: Readonly<{
    decisionKey: string;
    requestId: number;
    generation: number;
    fence: string;
    decisionTimeMs: number;
    lane: 'fast' | 'deep' | 'worker_fallback';
    variant: string;
    gameMode: string | null;
    stage: string;
    boardCount: number | null;
  }>;
  readonly selected: Readonly<{ action: ActionType; amount: number | null }>;
  readonly policyGraph: HorsePolicyGraphReceipt | null;
  readonly computeMs: number;
  readonly governorScale: number;
  executionStatus: 'pending' | 'intended' | 'coerced' | 'fallback' | 'not_executed' | 'unverified';
  executedAction: ActionType | null;
  executedAmount: number | null;
  retirementReason: HorseExecutionRetirement | null;
  acceptedActions: HorseAcceptedAction[];
}

/** The client calls this only after matching the worker FIFO, type and fence.
 * Bind the canonical request already validated by the worker, not a fresh live
 * table snapshot that may have changed while the decision was computing.
 */
export function createHorseExecutionWitness(
  snapshot: LiveHorseDecisionSnapshot,
  decision: HorseDecision,
  result: {
    requestId: number;
    lane: HorseExecutionWitness['identity']['lane'];
    computeMs: number;
    governorScale: number;
  }
): HorseExecutionWitness {
  return {
    version: 'horse-execution-witness-v1',
    identity: Object.freeze({
      decisionKey: snapshot.decisionKey,
      requestId: result.requestId,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decisionTimeMs: snapshot.decisionTimeMs,
      lane: result.lane,
      variant: snapshot.gameState.gameVariant || 'nlh',
      gameMode: snapshot.gameState.gameMode ?? null,
      stage: snapshot.gameState.stage,
      boardCount: snapshot.gameState.boardCount ?? null,
    }),
    selected: Object.freeze({ action: decision.action, amount: decision.amount ?? null }),
    policyGraph: decision.policyGraph
      ? {
          version: decision.policyGraph.version,
          transitions: decision.policyGraph.transitions.map((transition) => ({
            ...transition,
            before: transition.before ? { ...transition.before } : null,
            after: { ...transition.after },
          })),
          finalAction: { ...decision.policyGraph.finalAction },
        }
      : null,
    computeMs: result.computeMs,
    governorScale: result.governorScale,
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
    retirementReason: null,
    acceptedActions: [],
  };
}

function countFinal(witness: HorseExecutionWitness): void {
  noteFire(`phase15_execution_${witness.executionStatus}`);
  noteFire(`phase15_${witness.identity.lane}_execution_${witness.executionStatus}`);
}

export function retireHorseExecutionWitness(
  witness: HorseExecutionWitness | undefined,
  reason: HorseExecutionRetirement
): void {
  if (!witness || witness.executionStatus !== 'pending') return;
  witness.executionStatus = 'not_executed';
  witness.retirementReason = reason;
  countFinal(witness);
}

/** Call after the actual executor's intended and check/fold fallback attempts.
 * The controller receipt, not the submitted action or the boolean return,
 * identifies what landed. Keep a missing/conflicting receipt explicitly unknown.
 */
export function settleHorseExecutionWitness(
  witness: HorseExecutionWitness | undefined,
  result: {
    applied: boolean;
    acceptedActions: readonly HorseAcceptedAction[];
  }
): void {
  if (!witness || witness.executionStatus !== 'pending') return;
  witness.acceptedActions = result.acceptedActions.map(({ record, intended }) => ({
    record: {
      seat: record.seat,
      action: record.action,
      amount: record.amount,
      stage: record.stage,
    },
    intended,
  }));
  if (
    result.acceptedActions.length > 1 ||
    (result.applied && result.acceptedActions.length === 0)
  ) {
    witness.executionStatus = 'unverified';
    witness.retirementReason =
      result.acceptedActions.length > 1 ? 'multiple_accepted_actions' : 'accepted_without_record';
    countFinal(witness);
    return;
  }
  const accepted = result.acceptedActions[0];
  if (!accepted) {
    retireHorseExecutionWitness(witness, 'action_rejected');
    return;
  }
  const matched =
    accepted.record.action === witness.selected.action &&
    (!['bet', 'raise'].includes(witness.selected.action) ||
      accepted.record.amount === witness.selected.amount);
  witness.executedAction = accepted.record.action;
  witness.executedAmount = ['fold', 'check'].includes(accepted.record.action)
    ? null
    : accepted.record.amount;
  witness.executionStatus =
    !accepted.intended || witness.identity.lane === 'worker_fallback'
      ? 'fallback'
      : matched
        ? 'intended'
        : 'coerced';
  countFinal(witness);
}

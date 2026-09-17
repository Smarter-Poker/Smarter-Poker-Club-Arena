import type { ActionType, ActionRecord, HorseDecision } from '../types.js';
import type { LiveHorseDecisionSnapshot } from './horseDecision/protocol.js';
import type { HorsePolicyGraphReceipt } from './HorsePolicyGraph.js';
import { noteFire } from './BrainTelemetry.js';
import { copyPhase6Attribution } from './HorsePhase6Attribution.js';
import {
  anchorHorseDecisionHand,
  type HorseDecisionHandAnchor,
  type HorseDecisionHandBinding,
} from './HorseDecisionHandBinding.js';

export type HorseExecutionRetirement =
  | 'caller_settled'
  | 'turn_abandoned'
  | 'response_fence'
  | 'second_look_replaced'
  | 'second_look_unchanged'
  | 'brain_exception'
  | 'action_rejected'
  | 'accepted_without_record'
  | 'accepted_context_mismatch'
  | 'accepted_amount_unverifiable'
  | 'multiple_accepted_actions';

export interface HorseAcceptedAction {
  readonly record: Readonly<
    Pick<ActionRecord, 'seat' | 'action' | 'amount' | 'stage'> &
      Partial<Pick<ActionRecord, 'userId' | 'timestamp' | 'isFullRaise'>>
  >;
  readonly intended: boolean;
}

/** Private, bounded receipt for a returned betting decision. This is not a
 * durable ledger or a replay input. Never serialize it into public table state:
 * the canonical digest binds the hero's private input, even though no cards or
 * RNG seeds are copied here. The existing flush publishes only finite counters.
 */
export interface HorseExecutionWitness {
  readonly version: 'horse-execution-witness-v4';
  readonly handAnchor: HorseDecisionHandAnchor;
  committedHand: HorseDecisionHandBinding;
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
    heroSeat: number | null;
    boardCount: number | null;
  }>;
  readonly selected: Readonly<{ action: ActionType; amount: number | null }>;
  /** Canonical controller amount expected from the original request. Calls
   * record added chips; all-ins record the resulting street total. Null is
   * unavailable evidence, never permission to accept any wager amount. */
  readonly expectedExecutionAmount: number | null;
  readonly policyFallback: HorseDecision['policyFallback'] | null;
  readonly policyGraph: HorsePolicyGraphReceipt | null;
  /** Optional for retained v4 compatibility; absence never proves attribution. */
  readonly phase6Attribution?: HorseDecision['tournamentPreflopAttribution'] | null;
  readonly policyOwnership: Readonly<NonNullable<HorseDecision['policyOwnership']>> | null;
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
  const chips = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  let expectedAmount: number | null = null;
  if (decision.action === 'check' || decision.action === 'fold') expectedAmount = 0;
  else if (decision.action === 'all_in') {
    if (chips(snapshot.player?.stack) && chips(snapshot.player?.bet))
      expectedAmount = snapshot.player.stack + snapshot.player.bet;
  } else if (chips(decision.amount)) expectedAmount = decision.amount;
  else if (
    decision.action === 'call' &&
    chips(snapshot.gameState.toCall) &&
    chips(snapshot.player?.stack)
  )
    expectedAmount = Math.min(snapshot.gameState.toCall, snapshot.player.stack);
  // Match the controller's cent normalization, including floating additions.
  if (expectedAmount !== null) {
    expectedAmount = Math.round(expectedAmount * 100) / 100;
    if (!Number.isFinite(expectedAmount)) expectedAmount = null;
  }
  return {
    version: 'horse-execution-witness-v4',
    handAnchor: anchorHorseDecisionHand(snapshot),
    committedHand: Object.freeze({ status: 'pending' }),
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
      heroSeat:
        Number.isInteger(snapshot.player?.seat) && snapshot.player.seat >= 0
          ? snapshot.player.seat
          : null,
      boardCount: snapshot.gameState.boardCount ?? null,
    }),
    selected: Object.freeze({ action: decision.action, amount: decision.amount ?? null }),
    expectedExecutionAmount: expectedAmount,
    policyFallback: decision.policyFallback ?? null,
    phase6Attribution: decision.tournamentPreflopAttribution
      ? copyPhase6Attribution(decision.tournamentPreflopAttribution)
      : null,
    policyOwnership: decision.policyOwnership
      ? Object.freeze({ ...decision.policyOwnership })
      : null,
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
  const callback = finalizers.get(witness);
  finalizers.delete(witness);
  try {
    callback?.(witness);
  } catch {
    noteFire('phase15_journal_capture_unavailable');
  }
}

const finalizers = new WeakMap<HorseExecutionWitness, (witness: HorseExecutionWitness) => void>();
/** Private callback is never serialized with the executor receipt. */
export function onHorseExecutionFinalized(
  witness: HorseExecutionWitness,
  callback: (witness: HorseExecutionWitness) => void
): void {
  if (witness.executionStatus !== 'pending') throw Error('Horse execution already finalized');
  finalizers.set(witness, callback);
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
      ...(record.userId !== undefined ? { userId: record.userId } : {}),
      ...(record.timestamp !== undefined ? { timestamp: record.timestamp } : {}),
      ...(record.isFullRaise !== undefined ? { isFullRaise: record.isFullRaise } : {}),
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
  // A controller record proves an action only for the actor and street that
  // produced this decision. Keep conflicting evidence, without crediting it
  // as this Horse's execution or inventing an executed action.
  if (
    witness.identity.heroSeat === null ||
    accepted.record.seat !== witness.identity.heroSeat ||
    accepted.record.stage !== witness.identity.stage
  ) {
    witness.executionStatus = 'unverified';
    witness.retirementReason = 'accepted_context_mismatch';
    countFinal(witness);
    return;
  }
  if (
    accepted.record.action === witness.selected.action &&
    witness.expectedExecutionAmount === null
  ) {
    witness.executionStatus = 'unverified';
    witness.retirementReason = 'accepted_amount_unverifiable';
    countFinal(witness);
    return;
  }
  const matched =
    accepted.record.action === witness.selected.action &&
    accepted.record.amount === witness.expectedExecutionAmount;
  witness.executedAction = accepted.record.action;
  witness.executedAmount = ['fold', 'check'].includes(accepted.record.action)
    ? null
    : accepted.record.amount;
  witness.executionStatus =
    !accepted.intended ||
    witness.identity.lane === 'worker_fallback' ||
    witness.policyFallback === 'brain_exception'
      ? 'fallback'
      : matched
        ? 'intended'
        : 'coerced';
  countFinal(witness);
}

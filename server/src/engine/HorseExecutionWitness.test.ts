import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionType, HorseDecision } from '../types.js';
import type { LiveHorseDecisionSnapshot } from './horseDecision/protocol.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from './HorsePolicyGraph.js';
import {
  createHorseExecutionWitness,
  retireHorseExecutionWitness,
  settleHorseExecutionWitness,
  type HorseAcceptedAction,
} from './HorseExecutionWitness.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import { horsePolicyOwnership } from './HorsePolicyRegistry.js';

const input = {
  decisionKey: `phase5-v1:${'1'.repeat(64)}`,
  generation: 1,
  requestId: 1,
  fence: 'turn',
  decisionTimeMs: 1000,
  player: { seat: 1 },
  gameState: { gameVariant: 'plo4', gameMode: 'cash', stage: 'flop', boardCount: 2 },
} as unknown as LiveHorseDecisionSnapshot;
const make = (
  decision: HorseDecision = { action: 'bet', amount: 20, thinkTime: 1 },
  lane: 'fast' | 'worker_fallback' = 'fast'
) =>
  createHorseExecutionWitness(input, decision, {
    requestId: 1,
    lane,
    computeMs: 2,
    governorScale: 1,
  });

const accepted = (
  action: ActionType,
  amount: number | null,
  intended = true
): HorseAcceptedAction[] => [
  { record: { seat: 1, action, amount: amount ?? 0, stage: 'flop' as const }, intended },
];

beforeEach(() => {
  enableBrainTelemetry();
  drainFires();
});

describe('private execution witness', () => {
  it.each([10, 20])(
    'reconciles a sized call against its selected amount, not just its name (%s)',
    (amount) => {
      const witness = make({ action: 'call', amount: 10, thinkTime: 1 });
      settleHorseExecutionWitness(witness, {
        applied: true,
        acceptedActions: accepted('call', amount),
      });
      expect(witness.executionStatus).toBe(amount === 10 ? 'intended' : 'coerced');
      expect(witness.executedAmount).toBe(amount);
    }
  );

  it.each([100.3, 100.31])('binds all-in intent to the original street total (%s)', (amount) => {
    const snapshot = { ...input, player: { ...input.player, stack: 100.1, bet: 0.2 } };
    const witness = createHorseExecutionWitness(
      snapshot as never,
      { action: 'all_in', thinkTime: 1 },
      { requestId: 1, lane: 'fast', computeMs: 1, governorScale: 1 }
    );
    snapshot.player.stack = 999;
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('all_in', amount),
    });
    expect(witness.executionStatus).toBe(amount === 100.3 ? 'intended' : 'coerced');
    expect(witness.executedAmount).toBe(amount);
  });

  it.each(['call', 'all_in'] as const)(
    'leaves an unsized %s amount unverified without its original canonical price',
    (action) => {
      const witness = make({ action, thinkTime: 1 });
      settleHorseExecutionWitness(witness, {
        applied: true,
        acceptedActions: accepted(action, 20),
      });
      expect(witness.executionStatus).toBe('unverified');
      expect(witness.retirementReason).toBe('accepted_amount_unverifiable');
      expect(witness.acceptedActions[0].record.amount).toBe(20);
    }
  );
  it.each([
    { seat: 2, stage: 'flop' as const },
    { seat: 1, stage: 'turn' as const },
  ])('does not certify a matching wager from the wrong execution context %j', (over) => {
    const witness = make();
    const records = accepted('bet', 20);
    records[0] = { ...records[0], record: { ...records[0].record, ...over } };
    settleHorseExecutionWitness(witness, { applied: true, acceptedActions: records });
    expect(witness.executionStatus).toBe('unverified');
    expect(witness.retirementReason).toBe('accepted_context_mismatch');
    expect(witness.executedAction).toBeNull();
    expect(witness.acceptedActions[0].record).toMatchObject(over);
    settleHorseExecutionWitness(witness, { applied: true, acceptedActions: accepted('bet', 20) });
    expect(drainFires()).toEqual([
      { feature: 'phase15_execution_unverified', fires: 1 },
      { feature: 'phase15_fast_execution_unverified', fires: 1 },
    ]);
  });
  it('does not certify execution when a malformed fallback snapshot omitted the actor', () => {
    const snapshot = { ...input, player: undefined } as unknown as LiveHorseDecisionSnapshot;
    const witness = createHorseExecutionWitness(
      snapshot,
      { action: 'check', thinkTime: 0 },
      {
        requestId: 1,
        lane: 'worker_fallback',
        computeMs: 0,
        governorScale: 1,
      }
    );
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('check', null),
    });
    expect(witness.identity.heroSeat).toBeNull();
    expect(witness.executionStatus).toBe('unverified');
    expect(witness.retirementReason).toBe('accepted_context_mismatch');
  });
  it('copies immutable policy ownership independently of the returned decision', () => {
    const decision: HorseDecision = { action: 'check', thinkTime: 0 };
    decision.policyOwnership = horsePolicyOwnership('plo4', decision, false);
    const witness = make(decision);
    decision.policyOwnership.outcome = 'computed';
    expect(witness.policyOwnership?.outcome).toBe('disabled');
    expect(Object.isFrozen(witness.policyOwnership)).toBe(true);
  });
  it('does not infer execution from a boolean without the controller record', () => {
    const witness = make();
    settleHorseExecutionWitness(witness, { applied: true, acceptedActions: [] });
    expect(witness).toMatchObject({
      executionStatus: 'unverified',
      retirementReason: 'accepted_without_record',
      executedAction: null,
    });
  });

  it('keeps a record emitted before a later callback error instead of claiming nothing happened', () => {
    const witness = make();
    settleHorseExecutionWitness(witness, { applied: false, acceptedActions: accepted('bet', 20) });
    expect(witness).toMatchObject({
      executionStatus: 'intended',
      executedAction: 'bet',
      executedAmount: 20,
    });
  });

  it('retains conflicting accepted actions without certifying a single result', () => {
    const witness = make();
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: [...accepted('bet', 20), ...accepted('check', null, false)],
    });
    expect(witness).toMatchObject({
      executionStatus: 'unverified',
      retirementReason: 'multiple_accepted_actions',
      executedAction: null,
    });
    expect(witness.acceptedActions).toHaveLength(2);
  });
  it('snapshots the selected action and complete outer graph before later objects can change', () => {
    const graph = new HorsePolicyGraph(() => 0);
    let decision: HorseDecision = { action: 'bet', amount: 20, thinkTime: 1 };
    for (const node of HORSE_POLICY_ORDER) {
      decision = graph.run(node, node === 'reference' ? null : decision, () => ({
        decision,
      })).decision;
    }
    decision = graph.finish(decision);
    const witness = make(decision);
    const recorded = JSON.stringify(witness);
    decision.action = 'fold';
    decision.amount = undefined;
    decision.policyGraph!.transitions[0].after.action = 'fold';
    decision.policyGraph!.finalAction.action = 'fold';
    expect(JSON.stringify(witness)).toBe(recorded);
    expect(witness.policyGraph?.transitions).toHaveLength(8);
    expect(Object.isFrozen(witness.identity)).toBe(true);
    expect(Object.isFrozen(witness.selected)).toBe(true);
  });

  it.each([
    { action: 'bet' as const, amount: 20, intendedApplied: true, status: 'intended' },
    { action: 'bet' as const, amount: 30, intendedApplied: true, status: 'coerced' },
    { action: 'all_in' as const, amount: 100, intendedApplied: true, status: 'coerced' },
    { action: 'check' as const, amount: null, intendedApplied: false, status: 'fallback' },
  ])('records $status once after the actual $action attempt', ({ status, ...result }) => {
    const witness = make();
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted(result.action, result.amount, result.intendedApplied),
    });
    const recorded = JSON.stringify(witness);
    retireHorseExecutionWitness(witness, 'turn_abandoned');
    settleHorseExecutionWitness(witness, {
      applied: false,
      acceptedActions: [],
    });
    expect(JSON.stringify(witness)).toBe(recorded);
    expect(witness.executionStatus).toBe(status);
    expect(witness.executedAction).toBe(result.action);
    expect(witness.executedAmount).toBe(result.amount);
    expect(drainFires()).toEqual([
      { feature: `phase15_execution_${status}`, fires: 1 },
      { feature: `phase15_fast_execution_${status}`, fires: 1 },
    ]);
  });

  it('does not mislabel an unsized call when the executor supplies its canonical price', () => {
    const witness = createHorseExecutionWitness(
      {
        ...input,
        player: { ...input.player, stack: 20 },
        gameState: { ...input.gameState, toCall: 50 },
      } as never,
      { action: 'call', thinkTime: 1 },
      { requestId: 1, lane: 'fast', computeMs: 1, governorScale: 1 }
    );
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('call', 20),
    });
    expect(witness.executionStatus).toBe('intended');
    expect(witness.executedAmount).toBe(20);
  });

  it('records a worker failure liveness action as fallback even when that exact action lands', () => {
    const witness = make({ action: 'check', thinkTime: 0 }, 'worker_fallback');
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('check', null),
    });
    expect(witness.executionStatus).toBe('fallback');
    expect(witness.policyGraph).toBeNull();
  });

  it('counts an accepted brain-exception decision as fallback instead of normal policy intent', () => {
    const witness = make({ action: 'fold', thinkTime: 1500, policyFallback: 'brain_exception' });
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('fold', null),
    });
    expect(witness).toMatchObject({
      executionStatus: 'fallback',
      policyFallback: 'brain_exception',
      executedAction: 'fold',
    });
  });

  it('leaves no executed action when every attempted action was rejected', () => {
    const witness = make();
    settleHorseExecutionWitness(witness, {
      applied: false,
      acceptedActions: [],
    });
    expect(witness).toMatchObject({
      executionStatus: 'not_executed',
      executedAction: null,
      executedAmount: null,
      retirementReason: 'action_rejected',
    });
  });

  it('never resurrects a retired decision or counts its later callback twice', () => {
    const witness = make();
    retireHorseExecutionWitness(witness, 'second_look_replaced');
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('bet', 20),
    });
    retireHorseExecutionWitness(witness, 'turn_abandoned');
    expect(witness).toMatchObject({
      executionStatus: 'not_executed',
      executedAction: null,
      retirementReason: 'second_look_replaced',
    });
    expect(drainFires()).toEqual([
      { feature: 'phase15_execution_not_executed', fires: 1 },
      { feature: 'phase15_fast_execution_not_executed', fires: 1 },
    ]);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionType, HorseDecision } from '../types.js';
import type { LiveHorseDecisionSnapshot } from './horseDecision/protocol.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from './HorsePolicyGraph.js';
import {
  createHorseExecutionWitness,
  retireHorseExecutionWitness,
  settleHorseExecutionWitness,
} from './HorseExecutionWitness.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import { horsePolicyOwnership } from './HorsePolicyRegistry.js';

const input = {
  decisionKey: `phase5-v1:${'1'.repeat(64)}`,
  generation: 1,
  requestId: 1,
  fence: 'turn',
  decisionTimeMs: 1000,
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

const accepted = (action: ActionType, amount: number | null, intended = true) => [
  { record: { seat: 1, action, amount: amount ?? 0, stage: 'flop' as const }, intended },
];

beforeEach(() => {
  enableBrainTelemetry();
  drainFires();
});

describe('private execution witness', () => {
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
    const witness = make({ action: 'call', thinkTime: 1 });
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

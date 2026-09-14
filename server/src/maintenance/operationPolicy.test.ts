import { describe, expect, it } from 'vitest';
import { OperationHoldClock, operationMaintenancePolicy as policy, validateOperationPolicy,
  validateOperationState, type OperationMaintenanceState } from './operationPolicy.js';

const start = Date.parse('2026-09-11T12:34:00Z');
const id = 'c23046d1-35ef-4b7d-bfe8-e9e3d86628ce';
function state(overrides: Partial<OperationMaintenanceState> = {}): OperationMaintenanceState {
  return { policyVersion:2, operationId:id, releaseId:id, intervalId:id, ownershipToken:id,
    generation:1, phase:'last_hand', scope:{type:'platform'}, freezeStartedAt:start,
    targetAt:start+policy.normalTargetMs, forwardDeadlineAt:start+policy.forwardWorkMs,
    deadlineAt:start+policy.plannedHoldMs, observedAt:start, releaseReceipt:null,
    reason:'Engine Maintenance', resumeWaves:[], ...overrides };
}

describe('the continuous operation hold budget', () => {
  it('counts last-hand drain time before the first consequential step', () => {
    let elapsed = 0;
    const clock = new OperationHoldClock(state(), () => elapsed);
    elapsed = policy.lastHandNoticeMs;
    expect(clock.now()).toBe(start + 120000);
    expect(clock.decision(18*60000,600000,1)).toBe('recover');
  });
  it.each([0,1,16,19,20,29,30])('adoption at minute %i never restarts the hold budget', minute => {
    const clock = new OperationHoldClock(state({observedAt:start+minute*60000}), () => 500);
    expect(clock.now()).toBe(start+minute*60000);
    expect(clock.decision(60000,600000,1000)).toBe(minute >= 30 ? 'recovery_required' : minute >= 19 ? 'recover' : 'forward');
  });
  it('protects the measured recovery requirement when it exceeds the default reserve', () => {
    const clock = new OperationHoldClock(state({observedAt:start+10*60000}), () => 0);
    expect(clock.decision(5*60000,16*60000,1000)).toBe('recover');
  });
  it('keeps the normal target informational and refuses malformed estimates', () => {
    const clock = new OperationHoldClock(state({observedAt:start+policy.normalTargetMs}), () => 0);
    expect(clock.decision(60000,600000,1000)).toBe('forward');
    expect(() => clock.decision(NaN,600000,1000)).toThrow();
    expect(() => clock.decision(1000,-1,1000)).toThrow();
  });
  it('refuses a backwards monotonic clock rather than extending the deadline', () => {
    let now = 10;
    const clock = new OperationHoldClock(state(), () => now);
    now = 9;
    expect(() => clock.now()).toThrow('maintenance_monotonic_clock_regressed');
  });
  it('refuses reset deadlines, duplicate scope and release without a receipt', () => {
    expect(() => validateOperationState(state({deadlineAt:start+policy.plannedHoldMs+1}))).toThrow();
    expect(() => validateOperationState(state({scope:{type:'tables',tableIds:[id,id]}}))).toThrow();
    expect(() => validateOperationState(state({phase:'release_authorized'}))).toThrow();
  });
  it('requires a coherent complete policy and all retained-recovery components', () => {
    expect(() => validateOperationPolicy({...policy, plannedHoldMs:31*60000})).toThrow();
    expect(() => validateOperationPolicy({...policy, activationRequires:policy.activationRequires.slice(0,-1)})).toThrow();
    expect(policy.platformHourlyPause).toBe(false);
    expect(policy.qualificationMs).toBe(24*60*60*1000);
  });
});

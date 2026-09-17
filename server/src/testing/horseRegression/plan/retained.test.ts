import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { HorseMind } from '../../../engine/HorseMind.js';
import { horsePlanHandKey, horseMindHandKey } from '../../../engine/HorseDecisionEffects.js';
import {
  horsePlanBatchBindingFromRequest,
  horsePlanContextFromDecision,
} from '../../../engine/HorsePlanHandIdentity.js';
import {
  encodeHorseDecisionReads,
  decodeHorseDecisionReads,
} from '../../../engine/HorseDecisionReadFrame.js';
import {
  qualifyHorseRetainedDecisionEffects,
  horseRetainedPlanContext,
} from '../../../services/horseDecisionJournal/effects.js';
import { requestAt, otherTableId, wager } from './fixture.js';

beforeEach(() => HorseMind.reset());
afterEach(() => HorseMind.reset());
function frameFixture(current = true) {
  const request = requestAt(),
    context = current ? horsePlanContextFromDecision(request) : undefined;
  const key = horsePlanHandKey(request.gameState.actionHistory, context)!;
  HorseMind.notePlan(key, request.player.user_id, true);
  const frame = encodeHorseDecisionReads(
    HorseMind.snapshotDecisionReads(request.gameState.players, key),
    request.gameState.players,
    key,
    context
  );
  const effects = [
    { type: 'plan', handKey: key, userId: request.player.user_id, barrelIntent: true },
  ];
  const capture = {
    snapshot: request,
    decision: wager(),
    readFrame: frame,
    effects,
    lifecycleVersion: 1,
    ...(current
      ? { planContext: context, planBinding: horsePlanBatchBindingFromRequest(request) }
      : {}),
  };
  return { request, context, key, frame, capture };
}
describe('retained plan identity without historical evidence upgrades', () => {
  it.each([false, true])('round-trips actual bounded read maps with current=%s', (current) => {
    const f = frameFixture(current),
      restored = decodeHorseDecisionReads(f.frame, f.request.gameState.players, f.key, f.context);
    expect(f.frame.version).toBe(current ? 'horse-decision-reads-v2' : 'horse-decision-reads-v1');
    expect(restored.plans.get(`${f.key}|${f.request.player.user_id}`)).toBe(true);
    const qualified = qualifyHorseRetainedDecisionEffects(f.capture, f.request);
    expect(qualified).toMatchObject({ status: 'qualified', applicationVerified: false });
    if (current) expect(qualified.planIdentity).toBe('allocated_coordinate');
    else expect(qualified).not.toHaveProperty('planIdentity');
  });
  it.each([
    'context_absent',
    'binding_absent',
    'other_hand',
    'old_frame',
    'v2_without_markers',
    'wrong_original_id',
  ] as const)('refuses a current capture with %s rather than treating it as old proof', (fault) => {
    const f = frameFixture(),
      capture: any = structuredClone(f.capture);
    if (fault === 'context_absent') delete capture.planContext;
    if (fault === 'binding_absent') delete capture.planBinding;
    if (fault === 'other_hand')
      capture.planContext = horsePlanContextFromDecision(requestAt(2, otherTableId));
    if (fault === 'old_frame') capture.readFrame = frameFixture(false).frame;
    if (fault === 'v2_without_markers') {
      delete capture.planContext;
      delete capture.planBinding;
    }
    if (fault === 'wrong_original_id') capture.planBinding.fastRequestId++;
    expect(horseRetainedPlanContext(capture, f.request).kind).toBe('invalid');
    expect(qualifyHorseRetainedDecisionEffects(capture, f.request).status).toBe('invalid');
  });
  it.each([
    'no_expected_context',
    'other_expected_context',
    'legacy_namespace',
    'changed_body_context',
    'missing_body_context',
  ] as const)('rejects a v2 read frame at the independent %s boundary', (fault) => {
    const f = frameFixture();
    let frame = { ...f.frame },
      context = f.context,
      key = f.key;
    if (fault === 'no_expected_context') context = undefined;
    if (fault === 'other_expected_context')
      context = horsePlanContextFromDecision(requestAt(2, otherTableId));
    if (fault === 'legacy_namespace') key = horseMindHandKey(f.request.gameState.actionHistory)!;
    if (fault === 'changed_body_context' || fault === 'missing_body_context') {
      const body = JSON.parse(frame.json);
      if (fault === 'changed_body_context')
        body.planContext = horsePlanContextFromDecision(requestAt(2, otherTableId));
      else delete body.planContext;
      frame.json = JSON.stringify(body);
      frame.bytes = Buffer.byteLength(frame.json);
      frame.sha256 = createHash('sha256').update(frame.json).digest('hex');
    }
    expect(() =>
      decodeHorseDecisionReads(frame, f.request.gameState.players, key, context)
    ).toThrow('read frame');
  });
  it('requires the independently expected actor boundary even with a matching context', () => {
    const f = frameFixture();
    expect(() =>
      decodeHorseDecisionReads(
        f.frame,
        [...f.request.gameState.players].reverse(),
        f.key,
        f.context
      )
    ).toThrow();
  });
  it('retains a historical v1 identity even when its old request contains a high allocated number', () => {
    const f = frameFixture(false);
    expect(horseRetainedPlanContext(f.capture, f.request)).toEqual({ kind: 'legacy' });
    expect(f.key).not.toContain('plan-hand-v1');
    expect(() =>
      decodeHorseDecisionReads(
        f.frame,
        f.request.gameState.players,
        f.key,
        horsePlanContextFromDecision(f.request)
      )
    ).toThrow();
  });
  it.each([
    'fast_missing_effects',
    'deep_omitted',
    'deep_with_effects',
    'deep_with_fast_binding',
  ] as const)('keeps current lane emission rules for %s', (fault) => {
    const f = frameFixture(),
      capture: any = structuredClone(f.capture);
    const request = fault.startsWith('deep')
      ? { ...f.request, type: 'DECIDE_DEEP' as const, requestId: 2, rngBefore: 1, deepEquity: 2 }
      : f.request;
    if (fault !== 'deep_with_effects') delete capture.effects;
    if (request.type === 'DECIDE_DEEP' && fault !== 'deep_with_fast_binding')
      delete capture.planBinding;
    const result = qualifyHorseRetainedDecisionEffects(capture, request);
    expect(result.status).toBe(
      fault === 'deep_omitted'
        ? 'qualified'
        : fault === 'fast_missing_effects'
          ? 'unavailable'
          : 'invalid'
    );
    expect(result.applicationVerified).toBe(false);
  });
  it('reports an unavailable current coordinate without inventing a historical plan key', () => {
    const request = requestAt();
    request.fence = 'legacy:hand:turn';
    const context = horsePlanContextFromDecision(request),
      frame = encodeHorseDecisionReads(
        HorseMind.createSandbox(),
        request.gameState.players,
        null,
        context
      );
    const capture = {
      decision: wager(),
      effects: [],
      planContext: context,
      planBinding: horsePlanBatchBindingFromRequest(request),
      readFrame: frame,
    };
    expect(qualifyHorseRetainedDecisionEffects(capture, request)).toMatchObject({
      status: 'qualified',
      planIdentity: 'unavailable_coordinate',
      applicationVerified: false,
    });
    expect(
      decodeHorseDecisionReads(frame, request.gameState.players, null, context).plans.size
    ).toBe(0);
  });
});

import { HorseMind } from '../HorseMind.js';
import { buildOriginalRiverDecision } from '../../services/horseCorrectiveReview/riverDecisionModel.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  HorseDecisionWorkerRuntime,
  defaultHorseDecisionWorkerDependencies,
  type HorseDecisionWorkerDependencies,
} from './workerRuntime.js';
import type {
  FastHorseDecisionRequest,
  FastHorseDecisionResult,
  HorseDecisionWorkerResponse,
} from './protocol.js';
import { buildHorseDecisionKey } from './protocol.js';
import { HorseLogic } from '../HorseLogic.js';
import { HorseQualifiedAuthorityHolder } from '../HorseQualifiedAuthority.js';
import { jointPolicyFixture } from '../multiway/JointRangeFixture.test-support.js';
import {
  riverReferenceFixture,
  bind,
  cards,
} from '../../services/horseCorrectiveReview/riverReference.test-support.js';
import { kernelAdmissionFixture } from '../../services/horseCorrectiveReview/kernelAdmission.test-support.js';
import { admitCorrectiveKernelAttachment } from '../../services/horseCorrectiveReview/kernelAdmission.js';
import { now } from '../../services/horseCorrectiveReview/kernelApproval.test-support.js';
import { correctiveKernelReceiptIsValid } from '../../services/horseCorrectiveReview/kernelReceipt.js';
import { saveFastRandom, restoreFastRandom, seedFastRandom } from '../HorseEval.js';
import { horseDecisionReceiptIsValid } from './responseValidation.js';
import { request, harness, run } from './phase14Worker.test-support.js';
afterEach(() => vi.restoreAllMocks());
describe('real worker Phase14 capability and original-state execution', () => {
  it('keeps an unselected real-brain baseline and RNG identical and never samples', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const a = harness(false),
      b = harness(false),
      r = request();
    const one = await run(a, r),
      two = await run(b, structuredClone(r));
    expect(one.decision.action).toBe('fold');
    expect(two.decision.action).toBe(one.decision.action);
    expect(two.rngAfter).toBe(one.rngAfter);
    expect(one.decision.correctivePolicy).toBeUndefined();
    expect(a.deps.correctiveDraw).not.toHaveBeenCalled();
  });
  it('runs the admitted calculator inside the actual brain graph and binds the worker authority', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const h = harness(),
      r = await run(h);
    const diagnostic = buildOriginalRiverDecision({
      snapshot: request(),
      readFrame: (h.records[0] as any).readFrame,
    });
    expect(
      r.decision.action,
      JSON.stringify({
        model: diagnostic.status === 'built' ? diagnostic.prices.alternatives : diagnostic,
        admission: (h.records[0] as any).replayState.corrective,
      })
    ).toBe('call');
    expect(r.decision.correctivePolicy).toMatchObject({
      applied: true,
      domain: 'nlh-cash',
      baseline: { action: 'fold', amount: 0 },
      selected: { action: 'call', amount: 50 },
    });
    expect(correctiveKernelReceiptIsValid(r.decision)).toBe(true);
    expect(horseDecisionReceiptIsValid(r.decision)).toBe(true);
    expect(
      r.decision.policyGraph?.transitions.find((t) => t.node === 'corrective_policy')
    ).toMatchObject({
      before: { action: 'fold' },
      after: { action: 'call', amount: 50 },
      changed: true,
    });
    expect(r.effects).toEqual([]);
    expect(r.planIssueDisposition).toBe('no_effects');
    expect(h.deps.correctiveDraw).toHaveBeenCalledTimes(1);
    expect((h.records[0] as any).replayState.corrective).toMatchObject({
      mode: 'candidate',
      domain: 'nlh-cash',
    });
  });
  it('withdraws while queued before evaluating a correction', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const h = harness();
    await h.runtime.start();
    h.holders.get('nlh-cash')!.withdraw('test-withdrawal');
    const r = await run(h);
    expect(r.decision.action).toBe('fold');
    expect(r.decision.correctivePolicy).toBeUndefined();
    expect(h.deps.correctiveDraw).not.toHaveBeenCalled();
  });
  it('reuses the FAST original frame for DEEP and retires authority before second look', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const h = harness(),
      fast = await run(h),
      source = request();
    h.holders.get('nlh-cash')!.withdraw('test-deep-withdrawal');
    h.runtime.receive({
      ...source,
      type: 'DECIDE_DEEP',
      requestId: 2,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    });
    await h.runtime.drain();
    const deep = h.messages.find((m) => m.type === 'DEEP_RESULT');
    expect(deep?.type).toBe('DEEP_RESULT');
    if (deep?.type !== 'DEEP_RESULT') return;
    expect(deep.decision.correctivePolicy).toBeUndefined();
    expect(h.deps.correctiveDraw).toHaveBeenCalledTimes(1);
  });
  it('uses exactly one original observation and the same bound FAST inputs for an admitted DEEP decision', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const observation = vi.spyOn(HorseMind, 'observe');
    const h = harness(),
      source = request(),
      fast = await run(h, source);
    expect(observation).toHaveBeenCalledTimes(1);
    h.runtime.receive({
      ...source,
      type: 'DECIDE_DEEP',
      requestId: 2,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    });
    await h.runtime.drain();
    const deep = h.messages.find((m) => m.type === 'DEEP_RESULT');
    expect(deep?.type).toBe('DEEP_RESULT');
    if (deep?.type !== 'DEEP_RESULT') return;
    expect(deep.decision.correctivePolicy).toMatchObject({
      applied: true,
      inputDigest: fast.decision.correctivePolicy!.inputDigest,
      readFrameDigest: fast.decision.correctivePolicy!.readFrameDigest,
    });
    expect(horseDecisionReceiptIsValid(deep.decision)).toBe(true);
    expect(observation).toHaveBeenCalledTimes(1);
    expect(h.deps.correctiveDraw).toHaveBeenCalledTimes(2);
  });
});

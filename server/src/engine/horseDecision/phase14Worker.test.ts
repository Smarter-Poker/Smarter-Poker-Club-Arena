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
    const baseline = await run(harness(false));
    expect({
      action: r.decision.action,
      amount: r.decision.amount,
      thinkTime: r.decision.thinkTime,
      rngAfter: r.rngAfter,
      effects: r.effects,
    }).toEqual({
      action: baseline.decision.action,
      amount: baseline.decision.amount,
      thinkTime: baseline.decision.thinkTime,
      rngAfter: baseline.rngAfter,
      effects: baseline.effects,
    });
  });
  it('reuses the FAST original frame for DEEP and retires authority before second look', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const h = harness(),
      fast = await run(h),
      source = request();
    h.holders.get('nlh-cash')!.withdraw('test-deep-withdrawal');
    const deepRngStates: number[] = [],
      saveDeepRng = h.deps.saveRng;
    vi.spyOn(h.deps, 'saveRng').mockImplementation(() => {
      const state = saveDeepRng();
      deepRngStates.push(state);
      return state;
    });
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
    const base = harness(false),
      baseFast = await run(base, structuredClone(source));
    const baselineDeepRngStates: number[] = [],
      saveBaselineDeepRng = base.deps.saveRng;
    vi.spyOn(base.deps, 'saveRng').mockImplementation(() => {
      const state = saveBaselineDeepRng();
      baselineDeepRngStates.push(state);
      return state;
    });
    base.runtime.receive({
      ...structuredClone(source),
      type: 'DECIDE_DEEP',
      requestId: 2,
      rngBefore: baseFast.rngBefore,
      deepEquity: 2,
    });
    await base.runtime.drain();
    const baseDeep = base.messages.find((m) => m.type === 'DEEP_RESULT');
    expect(baseDeep?.type).toBe('DEEP_RESULT');
    if (baseDeep?.type !== 'DEEP_RESULT') throw Error('missing baseline DEEP');
    // DEEP restores the caller RNG after evaluation and does not expose rngAfter
    // on IPC. Observe its actual saveRng owner before that restoration.
    expect(deepRngStates.length).toBeGreaterThan(0);
    expect(baselineDeepRngStates.length).toBeGreaterThan(0);
    expect({
      action: deep.decision.action,
      amount: deep.decision.amount,
      thinkTime: deep.decision.thinkTime,
      rngAfter: deepRngStates.at(-1),
    }).toEqual({
      action: baseDeep.decision.action,
      amount: baseDeep.decision.amount,
      thinkTime: baseDeep.decision.thinkTime,
      rngAfter: baselineDeepRngStates.at(-1),
    });
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
  it.each(['preflop', 'flop', 'turn', 'opponent-not-all-in'] as const)(
    'keeps ordinary observation and RNG outside the corrective family: %s',
    async (family) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const source = request();
      if (family === 'opponent-not-all-in') {
        source.gameState.players[1].is_all_in = false;
        source.gameState.players[1].stack = 1;
      } else {
        source.gameState.stage = family;
        source.gameState.communityCards = source.gameState.communityCards.slice(
          0,
          family === 'preflop' ? 0 : family === 'flop' ? 3 : 4
        );
      }
      source.decisionKey = buildHorseDecisionKey(source);
      const h = harness(),
        baseline = harness(false);
      const preparation = vi.fn(h.deps.prepareOriginalReads!);
      h.deps.prepareOriginalReads = preparation;
      const capture = vi.fn(HorseMind.snapshotDecisionReads.bind(HorseMind));
      h.deps.snapshotDecisionReads = capture;
      const observation = vi.spyOn(HorseMind, 'observe');
      const actual = await run(h, structuredClone(source));
      expect(observation).toHaveBeenCalledTimes(1);
      expect(preparation).not.toHaveBeenCalled();
      expect(capture).toHaveBeenCalledTimes(1); // ordinary post-decision journal frame only
      expect(actual.phase14OriginalBinding).toBeUndefined();
      expect(h.deps.correctiveDraw).not.toHaveBeenCalled();
      expect(actual.decision.correctivePolicy).toBeUndefined();
      const unchanged = await run(baseline, structuredClone(source));
      expect({
        action: actual.decision.action,
        amount: actual.decision.amount,
        thinkTime: actual.decision.thinkTime,
        rngAfter: actual.rngAfter,
      }).toEqual({
        action: unchanged.decision.action,
        amount: unchanged.decision.amount,
        thinkTime: unchanged.decision.thinkTime,
        rngAfter: unchanged.rngAfter,
      });
    }
  );
  it('retains the supported family original capture and bounded sampler', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const h = harness();
    const preparation = vi.fn(h.deps.prepareOriginalReads!);
    h.deps.prepareOriginalReads = preparation;
    const fast = await run(h);
    expect(preparation).toHaveBeenCalledTimes(1);
    expect(fast.phase14OriginalBinding).toMatchObject({
      inputDigest: expect.any(String),
      readFrameDigest: expect.any(String),
    });
    expect(fast.decision.correctivePolicy?.applied).toBe(true);
    expect(h.deps.correctiveDraw).toHaveBeenCalledTimes(1);
  });
});

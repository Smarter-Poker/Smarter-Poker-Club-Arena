/**
 * P10 audit F7: the range-provenance capture is work the PLO4 proposal
 * consumes, so it runs inside the policy's timed region and counts against
 * `PLO4_POLICY_PACK.liveBudgetMs`. Before the fix HorseLogic captured it before
 * the policy clock started, so its cost was never counted.
 */
import { describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  armed: false,
  t: 0,
  captureCost: 0,
  inPolicy: false,
  captures: [] as boolean[],
}));
vi.mock('./Plo4LivePolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Plo4LivePolicy.js')>();
  return {
    ...actual,
    capturePlo4RangeProvenance: (...args: Parameters<typeof actual.capturePlo4RangeProvenance>) => {
      probe.captures.push(probe.inPolicy);
      probe.t += probe.captureCost;
      return actual.capturePlo4RangeProvenance(...args);
    },
    evaluatePlo4LivePolicy: (...args: Parameters<typeof actual.evaluatePlo4LivePolicy>) => {
      if (!probe.armed) return actual.evaluatePlo4LivePolicy(...args);
      // The policy reads this test's clock; only the capture advances it.
      args[5] = () => probe.t;
      probe.inPolicy = true;
      try {
        return actual.evaluatePlo4LivePolicy(...args);
      } finally {
        probe.inPolicy = false;
      }
    },
  };
});

import { plo4ReferenceSpot } from '../../benchmark/Plo4PolicyEvidence.js';
import { HorseLogic } from '../HorseLogic.js';
import { seedFastRandom } from '../HorseEval.js';
import { evaluatePlo4LivePolicy } from './Plo4LivePolicy.js';
import { PLO4_POLICY_PACK } from './Plo4PolicyPack.js';

const decide = (captureCost: number) => {
  probe.t = 0;
  probe.captureCost = captureCost;
  probe.captures = [];
  const input = plo4ReferenceSpot('non_nut_flush');
  seedFastRandom(100101);
  probe.armed = true;
  try {
    return HorseLogic.decide(
      input.hero,
      input.state,
      'balanced',
      {},
      { telemetry: false, mind: false, decisionTimeMs: 0, phase10Plo4: 'shadow' }
    );
  } finally {
    probe.armed = false;
  }
};

describe('P10 audit F7: the range capture counts against the PLO4 work budget', () => {
  it('HorseLogic captures the provenance inside the policy clock, once', () => {
    const quick = decide(0);
    expect(probe.captures).toEqual([true]);
    expect(quick.plo4Policy?.street).not.toBe('preflop');
    expect(quick.plo4Policy?.reason).not.toBe('work_budget');
    expect(quick.plo4Policy?.inputs?.range.status).toBe('consumed');
    expect(quick.plo4Policy?.inputs?.range.provenance?.source).toBe('uniform_mind_disabled');
  });

  it('a capture that exhausts the budget makes the work_budget fallback fire by name', () => {
    const slow = decide(PLO4_POLICY_PACK.liveBudgetMs + 1);
    expect(slow.plo4Policy?.reason).toBe('work_budget');
    expect(probe.captures).toEqual([true]);
    expect(slow.plo4Policy).toMatchObject({
      reason: 'work_budget',
      fired: false,
      applied: false,
      proposalAction: slow.plo4Policy?.baselineAction,
    });
    expect(slow.plo4Policy!.latencyMs).toBeGreaterThan(PLO4_POLICY_PACK.liveBudgetMs);
  });

  it('a deferred capture is timed by the policy itself; a throwing one leaves the sample unattributed', () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    const evidence = { equity: 0.5, samples: 500, standardError: 0.02 };
    let clock = 0;
    const slow = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      {
        ...evidence,
        captureRange: () => {
          clock += PLO4_POLICY_PACK.liveBudgetMs + 1;
          throw new Error('capture failed');
        },
      },
      'candidate',
      () => clock
    );
    expect(slow.receipt.reason).toBe('work_budget');
    expect(slow.decision).toBe(input.baseline);
    const quick = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      {
        ...evidence,
        captureRange: () => {
          throw new Error('capture failed');
        },
      },
      'candidate',
      () => 0
    );
    expect(quick.receipt.reason).not.toBe('work_budget');
    expect(quick.receipt.inputs?.range.status).toBe('consumed_unattributed');
  });
});

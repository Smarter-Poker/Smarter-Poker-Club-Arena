/**
 * P10 audit F7: the range-provenance capture is work the PLO4 proposal
 * consumes, so it runs inside the policy's measured region and its cost is in
 * `latencyMs`. Before the fix HorseLogic captured it before the policy clock
 * started, so its cost was never counted.
 *
 * 2026-10-16 (docs/changelog/2026-10-16-packs-do-declared-work.md): the clock
 * is a measurement only. A slow capture is measured and changes nothing else;
 * there is no `liveBudgetMs` fallback to the reference any more.
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
import { withoutMeasurements } from '../HorseDeclaredWork.test-support.js';

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

describe('P10 audit F7: the range capture is measured inside the PLO4 policy, and no clock decides', () => {
  it('HorseLogic captures the provenance inside the policy clock, once', () => {
    const quick = decide(0);
    expect(probe.captures).toEqual([true]);
    expect(quick.plo4Policy?.street).not.toBe('preflop');
    expect(quick.plo4Policy?.reason).not.toBe('work_budget');
    expect(quick.plo4Policy?.inputs?.range.status).toBe('consumed');
    expect(quick.plo4Policy?.inputs?.range.provenance?.source).toBe('uniform_mind_disabled');
  });

  it('a slow capture is measured in latencyMs and the decision is the one a free capture makes', () => {
    const quick = decide(0);
    const slow = decide(1_000);
    expect(probe.captures).toEqual([true]);
    expect(slow.plo4Policy?.reason).not.toBe('work_budget');
    expect(slow.plo4Policy!.latencyMs).toBeGreaterThanOrEqual(1_000);
    expect(withoutMeasurements(slow)).toEqual(withoutMeasurements(quick));
  });

  it('a deferred capture is timed by the policy itself; a throwing one leaves the sample unattributed, slow or not', () => {
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
          clock += 1_000;
          throw new Error('capture failed');
        },
      },
      'candidate',
      () => clock
    );
    expect(slow.receipt.latencyMs).toBeGreaterThanOrEqual(1_000);
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
    expect(withoutMeasurements(slow)).toEqual(withoutMeasurements(quick));
  });
});

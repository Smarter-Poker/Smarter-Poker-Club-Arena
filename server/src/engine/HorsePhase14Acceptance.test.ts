import { describe, it, expect, vi, afterEach } from 'vitest';
import { request, harness, run } from './horseDecision/phase14Worker.test-support.js';
import { now } from '../services/horseCorrectiveReview/kernelApproval.test-support.js';
import { HorsePhase8AuthorityGate } from './HorseQualifiedAuthority.js';
import {
  liveHorsePhase14Authorities,
  horsePhase14ContinuationVersion,
} from './HorsePhase14Authority.js';
import { CORRECTIVE_KERNEL_CATALOG_VERSION } from '../services/horseCorrectiveReview/kernelCatalog.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
} from './HorseExecutionWitness.js';
import {
  recheckHorsePhase14BeforeAcceptance,
  observeHorsePhase14Execution,
} from './HorsePhase14Acceptance.js';
async function issued() {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const h = harness(),
    fast = await run(h);
  const gate = new HorsePhase8AuthorityGate(
    () => h.attachment.admission,
    undefined,
    horsePhase14ContinuationVersion('nlh-cash', CORRECTIVE_KERNEL_CATALOG_VERSION)
  );
  gate.refresh();
  gate.observeWorker(fast.phase14Authority!['nlh-cash']);
  fast.decision.correctivePolicy!.authority = gate.stamp(
    fast.decision.correctivePolicy!.authority!
  );
  const live = liveHorsePhase14Authorities['nlh-cash'];
  vi.spyOn(live, 'check').mockImplementation((...a) => gate.check(...a));
  vi.spyOn(live, 'mainAuthority').mockImplementation(() => gate.mainAuthority());
  const withdrawal = vi
    .spyOn(live, 'withdraw')
    .mockImplementation((reason) => gate.withdraw(reason));
  fast.decision.executionWitness = createHorseExecutionWitness(request(), fast.decision, {
    requestId: 1,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  return { fast, gate, withdrawal };
}
afterEach(() => vi.restoreAllMocks());
describe('shared physical and Lightning Phase14 acceptance boundary', () => {
  it('requires the actual main and worker S4 identities before controller acceptance', async () => {
    const { fast } = await issued(),
      d = recheckHorsePhase14BeforeAcceptance(fast.decision);
    expect(d.action).toBe('call');
    expect(d.executionWitness?.phase14Authority?.verdict).toBe('usable');
    settleHorseExecutionWitness(d.executionWitness, {
      applied: true,
      acceptedActions: [
        {
          intended: true,
          record: {
            seat: 1,
            userId: 'hero',
            action: 'call',
            amount: 50,
            stage: 'river',
            timestamp: now,
          },
        },
      ],
    });
    expect(d.executionWitness?.phase14Authority?.selection).toBe('controller_accepted');
  });
  it('reselects the original baseline and updates the pending witness after withdrawal', async () => {
    const { fast, gate } = await issued();
    gate.withdraw('test-withdrawn');
    const d = recheckHorsePhase14BeforeAcceptance(fast.decision);
    expect(d).toMatchObject({
      action: 'fold',
      amount: 0,
      correctivePolicy: { applied: false, reason: 'withdrawn_before_acceptance' },
    });
    expect(d.executionWitness).toMatchObject({
      selected: { action: 'fold', amount: 0 },
      expectedExecutionAmount: 0,
      phase14Authority: { selection: 'withdrawn_before_acceptance' },
    });
  });
  it.each(['catalogDigest', 'policyDigest', 'baselineSelectionsDigest'] as const)(
    'refuses changed %s even with a genuine usable S4 receipt',
    async (field) => {
      const { fast } = await issued();
      fast.decision.correctivePolicy![field] = '0'.repeat(64);
      const d = recheckHorsePhase14BeforeAcceptance(fast.decision);
      expect(d.action).toBe('fold');
      expect(d.executionWitness?.phase14Authority?.verdict).toBe('mismatched');
    }
  );
  it('withdraws a candidate locally if the actual controller witness is coerced', async () => {
    const { fast, withdrawal } = await issued(),
      d = recheckHorsePhase14BeforeAcceptance(fast.decision);
    settleHorseExecutionWitness(d.executionWitness, {
      applied: true,
      acceptedActions: [
        {
          intended: true,
          record: {
            seat: 1,
            userId: 'hero',
            action: 'fold',
            amount: 0,
            stage: 'river',
            timestamp: now,
          },
        },
      ],
    });
    observeHorsePhase14Execution(d);
    expect(withdrawal).toHaveBeenCalledWith('controller_coerced_candidate');
    expect(d.executionWitness?.phase14Authority?.selection).not.toBe('controller_accepted');
  });
});

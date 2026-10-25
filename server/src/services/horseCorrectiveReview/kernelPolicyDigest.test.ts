import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  correctiveKernelPolicyDigestOf,
  CORRECTIVE_KERNEL_POLICY_SOURCE_FILES,
  correctiveKernelBaselineSelectionsDigest,
} from './kernelPolicyDigest.js';
describe('corrective policy binds actual baseline and final-action composition', () => {
  it('names the original calculator, prior owners, worker, acceptance and effects', () => {
    for (const p of [
      'src/engine/HorseLogic.ts',
      'src/engine/HorsePolicyGraph.ts',
      'src/engine/horseDecision/workerRuntime.ts',
      'src/engine/horseDecision/client.ts',
      'src/engine/ServerTableEngineTurns.ts',
      'src/lightning/LightningHandHost.ts',
      'src/engine/HorseDecisionEffects.ts',
      'src/services/horseCorrectiveReview/riverDecisionModel.ts',
      'src/services/horseCorrectiveReview/riverReference.ts',
      'src/services/horseCorrectiveReview/kernelApproval.ts',
    ])
      expect(CORRECTIVE_KERNEL_POLICY_SOURCE_FILES).toContain(p);
    expect(new Set(CORRECTIVE_KERNEL_POLICY_SOURCE_FILES).size).toBe(
      CORRECTIVE_KERNEL_POLICY_SOURCE_FILES.length
    );
    for (const p of CORRECTIVE_KERNEL_POLICY_SOURCE_FILES)
      expect(existsSync(fileURLToPath(new URL('../../../' + p, import.meta.url))), p).toBe(true);
  });
  it('changes if any bound source changes and refuses a missing source', () => {
    const read = (p: string) => Buffer.from('source:' + p),
      base = correctiveKernelPolicyDigestOf(read);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    for (const changed of CORRECTIVE_KERNEL_POLICY_SOURCE_FILES)
      expect(
        correctiveKernelPolicyDigestOf((p) =>
          Buffer.from('source:' + p + (p === changed ? ':changed' : ''))
        ),
        changed
      ).not.toBe(base);
    expect(
      correctiveKernelPolicyDigestOf(() => {
        throw Error('missing');
      })
    ).toBeNull();
  });
  it('names the protected baseline selection state separately from code', () => {
    const digest = correctiveKernelBaselineSelectionsDigest();
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe('0'.repeat(64));
  });
});

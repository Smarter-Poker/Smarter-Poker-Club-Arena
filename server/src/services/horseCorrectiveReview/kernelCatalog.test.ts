import { describe, it, expect } from 'vitest';
import { sign } from 'node:crypto';
import {
  CORRECTIVE_KERNEL_CATALOG_VERSION,
  correctiveKernelCatalogDigest,
  validateCorrectiveKernelCatalog,
  isValidatedCorrectiveKernelCatalog,
  type CorrectiveKernelCatalog,
} from './kernelCatalog.js';
import {
  kernelApprovalSigningBytes,
  verifyCorrectiveKernelApproval,
  type CorrectiveKernelApproval,
} from './kernelApproval.js';
import { authorize, TRUSTED_KEY_DIGEST } from './fixture.test-support.js';
import { RIVER_CORRECTION_KERNEL } from './riverKernel.js';
import { RIVER_DECISION_MODEL } from './riverDecisionModel.js';
import { evidenceDigest } from './authority.js';
import { now, catalog, running, approved } from './kernelApproval.test-support.js';
describe('versioned original-state kernel catalog attachment', () => {
  it('validates a detached immutable functional catalog without granting live activation', () => {
    const c = catalog(),
      a = approved(c),
      result = validateCorrectiveKernelCatalog(c, a, running(c));
    expect(result.status).toBe('validated');
    if (result.status !== 'validated') return;
    expect(result.activationAllowed).toBe(false);
    expect(Object.isFrozen(result.catalog)).toBe(true);
    expect(isValidatedCorrectiveKernelCatalog(result.catalog)).toBe(true);
    expect(isValidatedCorrectiveKernelCatalog(structuredClone(result.catalog))).toBe(false);
    c.domain.variant = 'plo5';
    expect(result.catalog.domain.variant).toBe('nlh');
  });
  it('binds every policy, source, baseline selection and holdout field into the digest', () => {
    const a = catalog(),
      b = { ...a, baselineSelectionsDigest: evidenceDigest('another-baseline') };
    expect(correctiveKernelCatalogDigest(a)).not.toBe(correctiveKernelCatalogDigest(b));
  });
  it.each([
    'copied-approval',
    'source',
    'domain',
    'policy',
    'baseline',
    'holdout',
    'probability',
    'gain',
    'legacy',
    'expired',
  ])('refuses %s before a catalog can reach S4 admission', (fault) => {
    const c = catalog(),
      a = approved(c),
      context = running(c);
    if (fault === 'source') c.sourceRelease = '2'.repeat(40);
    if (fault === 'domain') c.domain.variant = 'plo5';
    if (fault === 'policy') context.policyDigest = evidenceDigest('changed-code');
    if (fault === 'baseline')
      context.baselineSelectionsDigest = evidenceDigest('changed-selection');
    if (fault === 'holdout') c.holdoutDigest = evidenceDigest('changed-holdout');
    if (fault === 'probability') c.maximumConditionalProbability = 0.06 as never;
    if (fault === 'gain') c.minimumModelGainBb = 0;
    if (fault === 'legacy') c.kind = 'exact_original_information_set' as never;
    if (fault === 'expired') context.nowMs = Date.parse(a.expiresAt);
    expect(
      validateCorrectiveKernelCatalog(
        c,
        fault === 'copied-approval' ? structuredClone(a) : a,
        context
      ).status
    ).toBe('refused');
  });
});

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
export const now = Date.parse('2026-10-25T01:00:00.000Z');
export const catalog = (): CorrectiveKernelCatalog => ({
  version: CORRECTIVE_KERNEL_CATALOG_VERSION,
  kind: 'original_state_function',
  domain: { variant: 'nlh', format: 'cash', mode: 'cash' },
  sourceRelease: '1'.repeat(40),
  kernelVersion: RIVER_CORRECTION_KERNEL.version,
  modelVersion: RIVER_DECISION_MODEL.version,
  policyDigest: evidenceDigest('running-code'),
  baselineSelectionsDigest: evidenceDigest('baseline-selections'),
  holdoutDigest: evidenceDigest('heldout-measurement'),
  maximumConditionalProbability: 0.05,
  minimumModelGainBb: RIVER_CORRECTION_KERNEL.minimumModelGainBb,
});
export const running = (c: CorrectiveKernelCatalog) => ({
  policyDigest: c.policyDigest,
  baselineSelectionsDigest: c.baselineSelectionsDigest,
  nowMs: now,
});
export function signedApproval(
  c: CorrectiveKernelCatalog,
  evidenceClass: CorrectiveKernelApproval['evidenceClass'] = 'synthetic_fixture'
) {
  const test = authorize(null, []);
  const approval: CorrectiveKernelApproval = {
    version: 1,
    role: 'original_state_kernel_holdout',
    evidenceClass,
    qualificationId: 'catalog-test-only',
    domain: { ...c.domain },
    sourceRelease: c.sourceRelease,
    kernelVersion: c.kernelVersion,
    modelVersion: c.modelVersion,
    policyDigest: c.policyDigest,
    catalogDigest: correctiveKernelCatalogDigest(c),
    holdoutDigest: c.holdoutDigest,
    selectionWindowDigest: evidenceDigest('selection'),
    holdoutWindowDigest: evidenceDigest('validation'),
    sourceCustodyDigest: evidenceDigest('custody'),
    numericReviewDigest: evidenceDigest('numerics'),
    rollbackDigest: evidenceDigest('rollback'),
    approvalGeneration: 1,
    issuedAt: '2026-10-25T00:00:00.000Z',
    expiresAt: '2026-10-26T00:00:00.000Z',
    measurement: {
      samples: 10000,
      changed: 10000,
      meanGainBb: 2.4,
      lowerGainBb: 2,
      familyWiseConfidence: 0.95,
      familySize: 45,
      maximumAbsoluteDeltaBb: 5,
    },
  };
  const envelope = {
    approval,
    publicKeyPem: test.envelope.publicKeyPem,
    signature: sign(null, kernelApprovalSigningBytes(approval), test.privateKey).toString('base64'),
  };
  return envelope;
}

export function approved(c: CorrectiveKernelCatalog) {
  return verifyCorrectiveKernelApproval(signedApproval(c), TRUSTED_KEY_DIGEST, now, {
    allowSynthetic: true,
  })!;
}

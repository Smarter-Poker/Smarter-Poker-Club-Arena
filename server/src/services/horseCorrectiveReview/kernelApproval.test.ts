import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  kernelApprovalSigningBytes,
  verifyCorrectiveKernelApproval,
  isVerifiedCorrectiveKernelApproval,
  type CorrectiveKernelApproval,
} from './kernelApproval.js';
import { RIVER_CORRECTION_KERNEL } from './riverKernel.js';
import { RIVER_DECISION_MODEL } from './riverDecisionModel.js';
import { evidenceDigest } from './authority.js';
import { journalHash } from '../horseDecisionJournal/record.js';
// Generated only in this test process, never written or committed as evidence.
const pair = generateKeyPairSync('ed25519');
const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const trusted = journalHash(
  pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
);
const now = Date.parse('2026-10-25T01:00:00.000Z');
const approval = (): CorrectiveKernelApproval => ({
  version: 1,
  role: 'original_state_kernel_holdout',
  evidenceClass: 'synthetic_fixture',
  qualificationId: 'kernel-test-only',
  domain: { variant: 'nlh', format: 'cash', mode: 'cash' },
  sourceRelease: '1'.repeat(40),
  kernelVersion: RIVER_CORRECTION_KERNEL.version,
  modelVersion: RIVER_DECISION_MODEL.version,
  policyDigest: evidenceDigest('policy'),
  catalogDigest: evidenceDigest('catalog'),
  holdoutDigest: evidenceDigest('holdout'),
  selectionWindowDigest: evidenceDigest('selection-window'),
  holdoutWindowDigest: evidenceDigest('holdout-window'),
  sourceCustodyDigest: evidenceDigest('source'),
  numericReviewDigest: evidenceDigest('independent-numerics'),
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
});
const envelope = (a: CorrectiveKernelApproval) => ({
  approval: a,
  publicKeyPem,
  signature: sign(null, kernelApprovalSigningBytes(a), pair.privateKey).toString('base64'),
});
describe('independent kernel approval signature and numerical gates', () => {
  it('requires an independently pinned key and refuses fixtures in production', () => {
    const e = envelope(approval());
    expect(verifyCorrectiveKernelApproval(e, undefined, now, { allowSynthetic: true })).toBeNull();
    expect(
      verifyCorrectiveKernelApproval(e, '0'.repeat(64), now, { allowSynthetic: true })
    ).toBeNull();
    expect(verifyCorrectiveKernelApproval(e, trusted, now)).toBeNull();
    expect(
      verifyCorrectiveKernelApproval(e, trusted, now, { allowSynthetic: true })
    ).not.toBeNull();
  });
  it('detaches, freezes and runtime-brands the exact verified approval', () => {
    const e = envelope(approval()),
      verified = verifyCorrectiveKernelApproval(e, trusted, now, { allowSynthetic: true })!;
    expect(isVerifiedCorrectiveKernelApproval(verified)).toBe(true);
    expect(isVerifiedCorrectiveKernelApproval(structuredClone(verified))).toBe(false);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.measurement)).toBe(true);
    e.approval.domain.variant = 'plo5';
    expect(verified.domain.variant).toBe('nlh');
  });
  it.each([
    'confidence',
    'sample',
    'changed',
    'mean',
    'lower',
    'family',
    'bound',
    'window',
    'generation',
    'expiry',
    'future',
    'kernel',
    'model',
    'source',
    'custody',
    'numeric',
    'rollback',
    'domain',
    'flag',
  ])('refuses a valid signature over invalid %s facts', (fault) => {
    const a = approval(),
      m = a.measurement;
    if (fault === 'confidence') m.familyWiseConfidence = 0.9;
    if (fault === 'sample') m.samples = 1;
    if (fault === 'changed') m.changed = 1;
    if (fault === 'mean') m.meanGainBb = 6;
    if (fault === 'lower') m.lowerGainBb = 2.39;
    if (fault === 'family') m.familySize = 1;
    if (fault === 'bound') m.maximumAbsoluteDeltaBb = 0;
    if (fault === 'window') a.holdoutWindowDigest = a.selectionWindowDigest;
    if (fault === 'generation') a.approvalGeneration = 0;
    if (fault === 'expiry') a.expiresAt = new Date(now).toISOString();
    if (fault === 'future') a.issuedAt = '2026-10-25T02:00:00.000Z';
    if (fault === 'kernel') a.kernelVersion = 'another-kernel';
    if (fault === 'model') a.modelVersion = 'another-model';
    if (fault === 'source') a.sourceRelease = 'bad';
    if (fault === 'custody') a.sourceCustodyDigest = 'bad';
    if (fault === 'numeric') a.numericReviewDigest = 'bad';
    if (fault === 'rollback') a.rollbackDigest = 'bad';
    if (fault === 'domain') a.domain = { variant: 'nlh', format: 'mtt', mode: 'tournament' };
    if (fault === 'flag') (a as unknown as Record<string, unknown>).qualified = true;
    expect(
      verifyCorrectiveKernelApproval(envelope(a), trusted, now, { allowSynthetic: true })
    ).toBeNull();
  });
  it('refuses altered bytes after signing', () => {
    const e = envelope(approval());
    e.approval.approvalGeneration++;
    expect(verifyCorrectiveKernelApproval(e, trusted, now, { allowSynthetic: true })).toBeNull();
  });
});

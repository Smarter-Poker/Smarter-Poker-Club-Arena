import type { CorrectiveReferenceDomain } from './domain.js';
import type { AlternativeActionReference } from './contract.js';
import { createPublicKey, verify } from 'node:crypto';
import { correctiveDomainIsValid, CORRECTIVE_DOMAIN_KEYS } from './domain.js';
import { sha256 } from './authority.js';
import { horseJournalJson, journalHash } from '../horseDecisionJournal/record.js';
import { RIVER_CORRECTION_KERNEL } from './kernelDefinition.js';
import { RIVER_DECISION_MODEL } from './kernelDefinition.js';
export interface CorrectiveKernelApproval {
  version: 1;
  role: 'original_state_kernel_holdout';
  evidenceClass: AlternativeActionReference['evidenceClass'];
  qualificationId: string;
  domain: CorrectiveReferenceDomain;
  sourceRelease: string;
  kernelVersion: string;
  modelVersion: string;
  policyDigest: string;
  catalogDigest: string;
  holdoutDigest: string;
  selectionWindowDigest: string;
  holdoutWindowDigest: string;
  sourceCustodyDigest: string;
  numericReviewDigest: string;
  rollbackDigest: string;
  approvalGeneration: number;
  issuedAt: string;
  expiresAt: string;
  measurement: {
    samples: number;
    changed: number;
    meanGainBb: number;
    lowerGainBb: number;
    familyWiseConfidence: number;
    familySize: number;
    maximumAbsoluteDeltaBb: number;
  };
}
export interface CorrectiveKernelApprovalEnvelope {
  approval: CorrectiveKernelApproval;
  publicKeyPem: string;
  signature: string;
}
export const CORRECTIVE_KERNEL_SIGNED_MESSAGE = 'horse-corrective-kernel-approval-v1';
export const kernelApprovalSigningBytes = (approval: CorrectiveKernelApproval): Buffer =>
  Buffer.from(horseJournalJson([CORRECTIVE_KERNEL_SIGNED_MESSAGE, approval]));
const verified = new WeakSet<object>();
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
const DIGESTS = [
  'policyDigest',
  'catalogDigest',
  'holdoutDigest',
  'selectionWindowDigest',
  'holdoutWindowDigest',
  'sourceCustodyDigest',
  'numericReviewDigest',
  'rollbackDigest',
] as const;
const KEYS = [
  'version',
  'role',
  'evidenceClass',
  'qualificationId',
  'domain',
  'sourceRelease',
  'kernelVersion',
  'modelVersion',
  ...DIGESTS,
  'approvalGeneration',
  'issuedAt',
  'expiresAt',
  'measurement',
];
const MEASUREMENT_KEYS = [
  'samples',
  'changed',
  'meanGainBb',
  'lowerGainBb',
  'familyWiseConfidence',
  'familySize',
  'maximumAbsoluteDeltaBb',
];

/** Validate the signed aggregate protocol. A trusted key is supplied outside
 * the envelope. The signer must independently establish source custody,
 * numerical agreement, the locked holdout and rollback evidence before it
 * signs; cryptography alone does not establish any of those facts. This code
 * generates no production key and accepts no JSON qualified flag.
 * allowSynthetic is exclusively an injected local-test capability; production
 * admission uses the default refusal and its protected independent key pin. */
export function verifyCorrectiveKernelApproval(
  envelope: unknown,
  trustedDigest: string | undefined,
  nowMs: number,
  options: { allowSynthetic?: true } = {}
): CorrectiveKernelApproval | null {
  try {
    const e = envelope as CorrectiveKernelApprovalEnvelope,
      a = e?.approval;
    if (
      !sha256(trustedDigest) ||
      !Number.isFinite(nowMs) ||
      nowMs < 0 ||
      !exact(a, KEYS) ||
      a.version !== 1 ||
      a.role !== 'original_state_kernel_holdout' ||
      !['synthetic_fixture', 'reviewed_reference'].includes(a.evidenceClass) ||
      (a.evidenceClass === 'synthetic_fixture' && options.allowSynthetic !== true) ||
      typeof a.qualificationId !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(a.qualificationId) ||
      !correctiveDomainIsValid(a.domain) ||
      a.domain.format !== 'cash' ||
      a.domain.mode !== 'cash' ||
      typeof a.sourceRelease !== 'string' ||
      !/^[a-f0-9]{40}$/.test(a.sourceRelease) ||
      a.kernelVersion !== RIVER_CORRECTION_KERNEL.version ||
      a.modelVersion !== RIVER_DECISION_MODEL.version ||
      DIGESTS.some((k) => !sha256(a[k])) ||
      a.selectionWindowDigest === a.holdoutWindowDigest ||
      !Number.isSafeInteger(a.approvalGeneration) ||
      a.approvalGeneration <= 0
    )
      return null;
    const instant = (s: string) =>
      typeof s === 'string' &&
      s.length <= 64 &&
      Number.isFinite(Date.parse(s)) &&
      new Date(s).toISOString() === s;
    if (
      !instant(a.issuedAt) ||
      !instant(a.expiresAt) ||
      Date.parse(a.issuedAt) > nowMs ||
      Date.parse(a.expiresAt) <= Date.parse(a.issuedAt) ||
      nowMs >= Date.parse(a.expiresAt)
    )
      return null;
    const m = a.measurement;
    if (
      !exact(m, MEASUREMENT_KEYS) ||
      !Number.isSafeInteger(m.samples) ||
      m.samples < 2 ||
      m.samples > 10000 ||
      !Number.isSafeInteger(m.changed) ||
      m.changed < 1 ||
      m.changed > m.samples ||
      !Number.isFinite(m.familyWiseConfidence) ||
      m.familyWiseConfidence < 0.95 ||
      m.familyWiseConfidence >= 1 ||
      !Number.isSafeInteger(m.familySize) ||
      m.familySize < CORRECTIVE_DOMAIN_KEYS.length ||
      m.familySize > 1e6 ||
      !Number.isFinite(m.maximumAbsoluteDeltaBb) ||
      m.maximumAbsoluteDeltaBb <= 0 ||
      m.maximumAbsoluteDeltaBb > 1e6 ||
      !Number.isFinite(m.meanGainBb) ||
      !Number.isFinite(m.lowerGainBb) ||
      m.lowerGainBb <= 0 ||
      m.lowerGainBb > m.meanGainBb ||
      Math.abs(m.meanGainBb) * m.samples > m.maximumAbsoluteDeltaBb * m.changed + 1e-8
    )
      return null;
    const lower =
      m.meanGainBb -
      m.maximumAbsoluteDeltaBb *
        Math.sqrt((2 * Math.log(m.familySize / (1 - m.familyWiseConfidence))) / m.samples);
    if (m.lowerGainBb > lower + 1e-10) return null;
    if (
      typeof e.publicKeyPem !== 'string' ||
      e.publicKeyPem.length > 2048 ||
      !e.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----') ||
      typeof e.signature !== 'string'
    )
      return null;
    const key = createPublicKey(e.publicKeyPem),
      der = key.export({ type: 'spki', format: 'der' });
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      journalHash(der.toString('base64')) !== trustedDigest
    )
      return null;
    const signature = Buffer.from(e.signature, 'base64');
    if (
      signature.length !== 64 ||
      signature.toString('base64') !== e.signature ||
      !verify(null, kernelApprovalSigningBytes(a), key, signature)
    )
      return null;
    const result = JSON.parse(horseJournalJson(a)) as CorrectiveKernelApproval;
    Object.freeze(result.domain);
    Object.freeze(result.measurement);
    Object.freeze(result);
    verified.add(result);
    return result;
  } catch {
    return null;
  }
}
export function isVerifiedCorrectiveKernelApproval(
  value: unknown
): value is CorrectiveKernelApproval {
  return !!value && typeof value === 'object' && verified.has(value);
}

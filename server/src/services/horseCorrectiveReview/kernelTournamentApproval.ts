import type { CorrectiveReferenceDomain } from './domain.js';
import type { AlternativeActionReference } from './contract.js';
import { createPublicKey, verify } from 'node:crypto';
import { correctiveDomainIsValid, CORRECTIVE_DOMAIN_KEYS } from './domain.js';
import { sha256 } from './authority.js';
import { horseJournalJson, journalHash } from '../horseDecisionJournal/record.js';
import {
  tournamentKernelDefinitionFor,
  type TournamentKernelObjective,
  TOURNAMENT_KERNEL_OBJECTIVE,
  TOURNAMENT_KERNEL_UTILITY_UNIT,
} from './kernelTournamentDefinition.js';
export {
  TOURNAMENT_KERNEL_OBJECTIVE,
  TOURNAMENT_KERNEL_UTILITY_UNIT,
} from './kernelTournamentDefinition.js';
export interface TournamentCorrectiveKernelApproval {
  version: 2;
  objective: TournamentKernelObjective;
  utilityUnit: typeof TOURNAMENT_KERNEL_UTILITY_UNIT;
  baselineSelectionsDigest: string;
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
    meanGain: number;
    lowerGain: number;
    familyWiseConfidence: number;
    familySize: number;
    maximumAbsoluteDelta: number;
  };
}
export interface TournamentCorrectiveKernelApprovalEnvelope {
  approval: TournamentCorrectiveKernelApproval;
  publicKeyPem: string;
  signature: string;
}
export const TOURNAMENT_KERNEL_SIGNED_MESSAGE = 'horse-corrective-kernel-approval-v2';
export const tournamentKernelApprovalSigningBytes = (
  approval: TournamentCorrectiveKernelApproval
): Buffer => Buffer.from(horseJournalJson([TOURNAMENT_KERNEL_SIGNED_MESSAGE, approval]));
const verified = new WeakSet<object>();
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
const DIGESTS = [
  'baselineSelectionsDigest',
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
  'objective',
  'utilityUnit',
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
  'meanGain',
  'lowerGain',
  'familyWiseConfidence',
  'familySize',
  'maximumAbsoluteDelta',
];

/** Validate the versioned WTA HU ICM chip-share aggregate protocol. A trusted key is supplied outside
 * the envelope. The signer must independently establish source custody,
 * numerical agreement, the locked holdout and rollback evidence before it
 * signs; cryptography alone does not establish any of those facts. This code
 * generates no production key and accepts no JSON qualified flag.
 * Utilities are bounded [0,1] shares of a finalized WTA prize pool, NOT
 * asserted realized tournament awards or cash big blinds. A fixed 5% kernel
 * bounds each policy-weighted delta by 0.05 share.
 * allowSynthetic is exclusively an injected local-test capability; production
 * admission uses the default refusal and its protected independent key pin. */
export function verifyTournamentCorrectiveKernelApproval(
  envelope: unknown,
  trustedDigest: string | undefined,
  nowMs: number,
  options: { allowSynthetic?: true } = {}
): TournamentCorrectiveKernelApproval | null {
  try {
    const e = envelope as TournamentCorrectiveKernelApprovalEnvelope,
      a = e?.approval;
    const definition = tournamentKernelDefinitionFor(a?.objective, a?.domain);
    if (
      !exact(envelope, ['approval', 'publicKeyPem', 'signature']) ||
      !sha256(trustedDigest) ||
      !Number.isFinite(nowMs) ||
      nowMs < 0 ||
      !exact(a, KEYS) ||
      a.version !== 2 ||
      !definition ||
      a.utilityUnit !== TOURNAMENT_KERNEL_UTILITY_UNIT ||
      a.role !== 'original_state_kernel_holdout' ||
      !['synthetic_fixture', 'reviewed_reference'].includes(a.evidenceClass) ||
      (a.evidenceClass === 'synthetic_fixture' && options.allowSynthetic !== true) ||
      typeof a.qualificationId !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(a.qualificationId) ||
      !correctiveDomainIsValid(a.domain) ||
      typeof a.sourceRelease !== 'string' ||
      !/^[a-f0-9]{40}$/.test(a.sourceRelease) ||
      a.kernelVersion !== definition.kernel.version ||
      a.modelVersion !== definition.model.version ||
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
      !Number.isFinite(m.maximumAbsoluteDelta) ||
      m.maximumAbsoluteDelta !== definition.kernel.conditionalProbability ||
      !Number.isFinite(m.meanGain) ||
      !Number.isFinite(m.lowerGain) ||
      m.lowerGain <= 0 ||
      m.lowerGain > m.meanGain ||
      Math.abs(m.meanGain) * m.samples > m.maximumAbsoluteDelta * m.changed + 1e-8
    )
      return null;
    const lower =
      m.meanGain -
      m.maximumAbsoluteDelta *
        Math.sqrt((2 * Math.log(m.familySize / (1 - m.familyWiseConfidence))) / m.samples);
    if (m.lowerGain > lower + 1e-10) return null;
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
      !verify(null, tournamentKernelApprovalSigningBytes(a), key, signature)
    )
      return null;
    const result = JSON.parse(horseJournalJson(a)) as TournamentCorrectiveKernelApproval;
    Object.freeze(result.domain);
    Object.freeze(result.measurement);
    Object.freeze(result);
    verified.add(result);
    return result;
  } catch {
    return null;
  }
}
export function isVerifiedTournamentCorrectiveKernelApproval(
  value: unknown
): value is TournamentCorrectiveKernelApproval {
  return !!value && typeof value === 'object' && verified.has(value);
}

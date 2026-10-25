/** Functional Phase 14 attachment admitted through the existing S4 identity.
 * Reading a file and returning its authority/catalog is one operation, so no
 * separately loaded catalog can be substituted after the evidence hash check. */
import { posix } from 'node:path';
import {
  canonical,
  sha256,
  isoMs,
  type HorseAuthorityAdmission,
  type HorseAuthorityEvidenceReader,
  type HorseAuthorityRefusal,
} from '../../engine/HorseQualifiedAuthority.js';
import type { HorsePhase14AuthoritySelection } from '../../engine/HorsePhase14Authority.js';
import { CORRECTIVE_DOMAIN_KEYS, correctiveDomainKey } from './domain.js';
import {
  CORRECTIVE_KERNEL_CATALOG_VERSION,
  validateCorrectiveKernelCatalog,
  type CorrectiveKernelCatalog,
} from './kernelCatalog.js';
import { verifyCorrectiveKernelApproval } from './kernelApproval.js';
import {
  correctiveKernelPolicyDigest,
  correctiveKernelBaselineSelectionsDigest,
} from './kernelPolicyDigest.js';
export const CORRECTIVE_KERNEL_QUALIFICATION_SCHEMA = 'horse-phase14-kernel-qualification-v1';
export interface CorrectiveKernelAuthoritySelection extends HorsePhase14AuthoritySelection {
  readonly trustedSignerKeySha256: string;
}
export interface CorrectiveKernelAttachmentAdmission {
  admission: HorseAuthorityAdmission;
  catalog: Readonly<CorrectiveKernelCatalog> | null;
}
export function admitCorrectiveKernelAttachment(
  domain: string,
  selection: HorsePhase14AuthoritySelection | null,
  reader: HorseAuthorityEvidenceReader,
  nowMs: number,
  running?: { policyDigest: string | null; baselineSelectionsDigest: string }
): CorrectiveKernelAttachmentAdmission {
  const refuse = (
    reason: HorseAuthorityRefusal,
    transient = false
  ): CorrectiveKernelAttachmentAdmission => ({
    admission: { status: 'refused', reason, transient },
    catalog: null,
  });
  if (selection === null) return refuse('unselected');
  const s = selection as CorrectiveKernelAuthoritySelection;
  if (
    !CORRECTIVE_DOMAIN_KEYS.includes(domain) ||
    s.schema !== 'horse-qualified-authority-selection-v1' ||
    s.phase !== 'phase14' ||
    s.domain !== domain ||
    !/^[a-f0-9]{40}$/.test(s.sourceSha) ||
    s.catalogVersion !== CORRECTIVE_KERNEL_CATALOG_VERSION ||
    ![s.catalogDigest, s.holdoutDigest, s.qualificationSha256, s.trustedSignerKeySha256].every(
      (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
    ) ||
    typeof s.qualificationPath !== 'string' ||
    !s.qualificationPath.startsWith('docs/evidence/phase14/') ||
    !s.qualificationPath.endsWith('.json') ||
    posix.normalize(s.qualificationPath) !== s.qualificationPath ||
    s.qualificationPath.split('/').includes('..') ||
    !Number.isSafeInteger(s.approvalGeneration) ||
    s.approvalGeneration <= 0 ||
    isoMs(s.issuedAt) === null ||
    s.expiresAt === null ||
    isoMs(s.expiresAt) === null ||
    (isoMs(s.expiresAt) ?? 0) <= (isoMs(s.issuedAt) ?? Infinity) ||
    !Number.isFinite(nowMs) ||
    nowMs < (isoMs(s.issuedAt) ?? Infinity)
  )
    return refuse('invalid_selection');
  if (s.withdrawn !== null) {
    if (
      isoMs(s.withdrawn?.at) === null ||
      typeof s.withdrawn?.reason !== 'string' ||
      !s.withdrawn.reason.length
    )
      return refuse('invalid_selection');
    return {
      admission: {
        status: 'withdrawn',
        approvalGeneration: s.approvalGeneration,
        reason: 'release_' + s.withdrawn.reason,
      },
      catalog: null,
    };
  }
  if (nowMs >= (isoMs(s.expiresAt) ?? 0)) return refuse('expired');
  let bytes: Buffer;
  try {
    bytes = reader.read(s.qualificationPath);
  } catch (error) {
    return refuse(
      (error as { code?: unknown })?.code === 'ENOENT' ? 'missing_evidence' : 'unreadable_evidence',
      (error as { code?: unknown })?.code !== 'ENOENT'
    );
  }
  if (bytes.length > 512 * 1024) return refuse('evidence_mismatch');
  if (sha256(bytes) !== s.qualificationSha256) return refuse('hash_mismatch');
  let file: { schema: unknown; catalog: unknown; approval: unknown };
  try {
    file = JSON.parse(bytes.toString('utf8'));
    if (
      !file ||
      Array.isArray(file) ||
      Object.keys(file).sort().join(',') !== 'approval,catalog,schema' ||
      file.schema !== CORRECTIVE_KERNEL_QUALIFICATION_SCHEMA
    )
      return refuse('evidence_mismatch');
  } catch {
    return refuse('evidence_mismatch');
  }
  // Synthetic approvals have no production admission capability.
  const approval = verifyCorrectiveKernelApproval(file.approval, s.trustedSignerKeySha256, nowMs);
  if (!approval) return refuse('not_qualified');
  if (approval.sourceRelease !== s.sourceSha) return refuse('source_mismatch');
  if (correctiveDomainKey(approval.domain) !== domain) return refuse('continuation_mismatch');
  if (
    approval.approvalGeneration !== s.approvalGeneration ||
    approval.issuedAt !== s.issuedAt ||
    approval.expiresAt !== s.expiresAt
  )
    return refuse('evidence_mismatch');
  if (approval.catalogDigest !== s.catalogDigest) return refuse('catalog_digest_mismatch');
  if (approval.holdoutDigest !== s.holdoutDigest) return refuse('holdout_digest_mismatch');
  const context = running ?? {
    policyDigest: correctiveKernelPolicyDigest(),
    baselineSelectionsDigest: correctiveKernelBaselineSelectionsDigest(),
  };
  if (!context.policyDigest) return refuse('policy_digest_unavailable');
  const checked = validateCorrectiveKernelCatalog(file.catalog, approval, {
    ...context,
    policyDigest: context.policyDigest,
    nowMs,
  });
  if (checked.status !== 'validated') return refuse('policy_digest_mismatch');
  const identity = {
    schema: 'horse-qualified-authority-v1' as const,
    phase: 'phase14' as const,
    sourceSha: s.sourceSha,
    continuationVersion: `${CORRECTIVE_KERNEL_CATALOG_VERSION}/${domain}`,
    policyDigest: s.catalogDigest,
    packId: CORRECTIVE_KERNEL_CATALOG_VERSION,
    domain,
    evidencePath: s.qualificationPath,
    evidenceSha256: s.qualificationSha256,
    approvalGeneration: s.approvalGeneration,
    issuedAt: s.issuedAt,
    expiresAt: s.expiresAt,
    catalogDigest: s.catalogDigest,
    correctivePolicyDigest: checked.catalog.policyDigest,
    baselineSelectionsDigest: checked.catalog.baselineSelectionsDigest,
    holdoutDigest: s.holdoutDigest,
  };
  return {
    admission: {
      status: 'admitted',
      authority: Object.freeze({
        ...identity,
        authorityKey: sha256(JSON.stringify(canonical(identity))),
      }),
    },
    catalog: checked.catalog,
  };
}

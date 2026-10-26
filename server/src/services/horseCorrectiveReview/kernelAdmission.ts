/** Functional Phase 14 attachment admitted through the existing S4 identity.
 * Reading a file and returning its authority/catalog is one operation, so no
 * separately loaded catalog can be substituted after the evidence hash check. */
import { posix } from 'node:path';
import {
  readPhase14GenerationLedger,
  phase14LedgerSelectionAllowed,
} from './kernelGenerationLedger.js';
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
import { ownerForcedCorrectiveKernelCatalog } from './kernelCatalog.js';
import { ownerForcedTournamentCorrectiveKernelCatalog } from './kernelTournamentCatalog.js';
import {
  HORSE_OWNER_FORCED_ACTIVATION,
  HORSE_OWNER_FORCED_ACTIVATION_ENABLED,
  HORSE_OWNER_FORCED_APPROVAL_GENERATION,
  HORSE_OWNER_FORCED_EVIDENCE_PATH,
  HORSE_OWNER_FORCED_EVIDENCE_SHA256,
  HORSE_OWNER_FORCED_SOURCE_SHA,
} from '../../engine/HorseOwnerForcedActivation.js';
import { CORRECTIVE_DOMAINS } from './domain.js';
import {
  functionalKernelCatalogDigest,
  verifyFunctionalKernelApproval as verifyCorrectiveKernelApproval,
  validateFunctionalKernelCatalog as validateCorrectiveKernelCatalog,
  functionalKernelCatalogVersionIsKnown,
  type CorrectiveFunctionalKernelCatalog as CorrectiveKernelCatalog,
} from './kernelObjective.js';
import { TOURNAMENT_KERNEL_CATALOG_VERSION } from './kernelTournamentCatalog.js';
import {
  correctiveKernelPolicyDigest,
  correctiveKernelBaselineSelectionsDigest,
} from './kernelPolicyDigest.js';
export const CORRECTIVE_KERNEL_QUALIFICATION_SCHEMA = 'horse-phase14-kernel-qualification-v1';
export const TOURNAMENT_KERNEL_QUALIFICATION_SCHEMA = 'horse-phase14-kernel-qualification-v2';
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
    !functionalKernelCatalogVersionIsKnown(s.catalogVersion) ||
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
      file.schema !==
        (s.catalogVersion === TOURNAMENT_KERNEL_CATALOG_VERSION
          ? TOURNAMENT_KERNEL_QUALIFICATION_SCHEMA
          : CORRECTIVE_KERNEL_QUALIFICATION_SCHEMA)
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
  // The signed catalog and protected S4 selection must name the same protocol.
  if (checked.catalog.version !== s.catalogVersion) return refuse('evidence_mismatch');
  if (!phase14LedgerSelectionAllowed(readPhase14GenerationLedger(reader), domain, s))
    return refuse('evidence_mismatch');
  const identity = {
    schema: 'horse-qualified-authority-v1' as const,
    phase: 'phase14' as const,
    sourceSha: s.sourceSha,
    continuationVersion: `${s.catalogVersion}/${domain}`,
    policyDigest: s.catalogDigest,
    packId: s.catalogVersion,
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

/**
 * Dan's 2026-10-26 order ("FORCE ACTIVATE EVERY PHASE NOW WITHOUT QUALIFYING",
 * `engine/HorseOwnerForcedActivation.ts`): one domain's corrective attachment
 * for the running code, the catalog and the S4 authority issued together by
 * the owner in place of a signed qualification. Cash domains get the cash
 * river kernel; tournament domains get a tournament kernel where one is
 * defined (no-limit hold'em). Anything else stays refused `unselected`.
 */
export function admitOwnerForcedCorrectiveKernelAttachment(
  domain: string,
  running?: { policyDigest: string | null; baselineSelectionsDigest: string }
): CorrectiveKernelAttachmentAdmission {
  const refused: CorrectiveKernelAttachmentAdmission = {
    admission: { status: 'refused', reason: 'unselected', transient: false },
    catalog: null,
  };
  if (!HORSE_OWNER_FORCED_ACTIVATION_ENABLED) return refused;
  const d = CORRECTIVE_DOMAINS.find((x) => correctiveDomainKey(x) === domain);
  if (!d) return refused;
  const context = running ?? {
    policyDigest: correctiveKernelPolicyDigest(),
    baselineSelectionsDigest: correctiveKernelBaselineSelectionsDigest(),
  };
  const inputs = {
    sourceRelease: HORSE_OWNER_FORCED_SOURCE_SHA,
    policyDigest: context.policyDigest,
    baselineSelectionsDigest: context.baselineSelectionsDigest,
    holdoutDigest: HORSE_OWNER_FORCED_EVIDENCE_SHA256,
  };
  const catalog =
    d.mode === 'cash'
      ? ownerForcedCorrectiveKernelCatalog(d, inputs)
      : ownerForcedTournamentCorrectiveKernelCatalog(d, inputs);
  if (!catalog) return refused;
  const catalogDigest = functionalKernelCatalogDigest(catalog);
  const identity = {
    schema: 'horse-qualified-authority-v1' as const,
    phase: 'phase14' as const,
    sourceSha: HORSE_OWNER_FORCED_SOURCE_SHA,
    continuationVersion: `${catalog.version}/${domain}`,
    policyDigest: catalogDigest,
    packId: catalog.version,
    domain,
    evidencePath: HORSE_OWNER_FORCED_EVIDENCE_PATH,
    evidenceSha256: HORSE_OWNER_FORCED_EVIDENCE_SHA256,
    approvalGeneration: HORSE_OWNER_FORCED_APPROVAL_GENERATION,
    issuedAt: HORSE_OWNER_FORCED_ACTIVATION.orderedAt,
    expiresAt: null,
    catalogDigest,
    correctivePolicyDigest: catalog.policyDigest,
    baselineSelectionsDigest: catalog.baselineSelectionsDigest,
    holdoutDigest: catalog.holdoutDigest,
  };
  return {
    admission: {
      status: 'admitted',
      authority: Object.freeze({
        ...identity,
        authorityKey: sha256(JSON.stringify(canonical(identity))),
      }),
    },
    catalog,
  };
}

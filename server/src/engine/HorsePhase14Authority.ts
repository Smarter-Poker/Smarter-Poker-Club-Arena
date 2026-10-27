import { PHASE8_GUARD_PROTECTED_RELEASE_SELECTION } from './HorseTournamentCatastropheGuardSelection.js';
import { liveHorsePhase8GuardAuthority } from './HorseTournamentCatastropheGuardAuthority.js';
/** Phase 14 functional admission reuses the generation-bound S4 holder and
 * main gate. Legacy literal catalogs retain their historical inactive schema;
 * a functional attachment additionally requires an independently pinned
 * signature, untouched heldout measurement and exact code/baseline binding.
 * All protected selections remain null until real qualification is supplied.
 * No runtime caller or envelope can select a policy or pin its own signer. */
import {
  PHASE10_PROTECTED_RELEASE_SELECTION,
  liveHorsePhase10Authority,
} from './HorsePhase10Authority.js';
import {
  PHASE11_PROTECTED_RELEASE_SELECTIONS,
  liveHorsePhase11Authorities,
} from './HorsePhase11Authority.js';
import {
  PHASE12_PROTECTED_RELEASE_SELECTIONS,
  liveHorsePhase12Authorities,
} from './HorsePhase12Authority.js';
import {
  PHASE13_PROTECTED_RELEASE_SELECTIONS,
  liveHorsePhase13Authorities,
} from './HorsePhase13Authority.js';
import { posix } from 'node:path';
import {
  admitCorrectiveKernelAttachment,
  admitOwnerForcedCorrectiveKernelAttachment,
  type CorrectiveKernelAttachmentAdmission,
} from '../services/horseCorrectiveReview/kernelAdmission.js';
import { TOURNAMENT_KERNEL_CATALOG_VERSION } from '../services/horseCorrectiveReview/kernelTournamentCatalog.js';
import {
  CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
  TOURNAMENT_KERNEL_OBJECTIVE,
  tournamentKernelDefinitionFor,
} from '../services/horseCorrectiveReview/kernelTournamentDefinition.js';
import { HORSE_OWNER_FORCED_ACTIVATION_ENABLED } from './HorseOwnerForcedActivation.js';
import { CORRECTIVE_KERNEL_CATALOG_VERSION } from '../services/horseCorrectiveReview/kernelCatalog.js';
import {
  functionalKernelCatalogVersionIsKnown,
  isValidatedFunctionalKernelCatalog as isValidatedCorrectiveKernelCatalog,
  type CorrectiveFunctionalKernelCatalog as CorrectiveKernelCatalog,
} from '../services/horseCorrectiveReview/kernelObjective.js';
import {
  canonical,
  PHASE8_PROTECTED_RELEASE_SELECTION,
  liveHorsePhase8Authority,
  HorsePhase8AuthorityGate,
  isoMs,
  repositoryEvidenceReader,
  sha256,
  type HorseAuthorityAdmission,
  type HorseAuthorityEvidenceReader,
  type HorseAuthorityRefusal,
  type HorseAuthorityVerdict,
  type HorseAuthorityReceipt,
  type HorseQualifiedAuthority,
} from './HorseQualifiedAuthority.js';
import { CORRECTIVE_CATALOG_VERSION } from '../services/horseCorrectiveReview/candidateCatalog.js';
import {
  CORRECTIVE_DOMAIN_KEYS,
  CORRECTIVE_DOMAINS,
  correctiveDomainKey,
} from '../services/horseCorrectiveReview/domain.js';

/** Where a Phase 14 qualification would be committed. Nothing is there today. */
export const HORSE_PHASE14_EVIDENCE_DIRECTORY = 'docs/evidence/phase14/';
export const HORSE_PHASE14_QUALIFICATION_SCHEMA = 'horse-phase14-qualification-v1';
/** The catalog version every Phase 14 authority is bound to. */
export const HORSE_PHASE14_CATALOG_VERSION: string = CORRECTIVE_CATALOG_VERSION;
/** The 45 corrective domains, `<variant>-<format>`, in a fixed order. */
export const HORSE_PHASE14_DOMAINS: readonly string[] = CORRECTIVE_DOMAIN_KEYS;
export const isHorsePhase14Domain = (value: unknown): value is string =>
  typeof value === 'string' && HORSE_PHASE14_DOMAINS.includes(value);

/** The running version a Phase 14 holder of `domain` admits. */
export function horsePhase14ContinuationVersion(
  domain: string,
  catalogVersion = HORSE_PHASE14_CATALOG_VERSION
): string {
  return `${catalogVersion}/${domain}`;
}

/** The exact keys of a `horse-phase14-qualification-v1` file. */
export const HORSE_PHASE14_QUALIFICATION_KEYS = Object.freeze([
  'schema',
  'qualified',
  'domain',
  'sourceSha',
  'catalogVersion',
  'catalogDigest',
  'holdoutDigest',
  'reasons',
] as const);

/** Committed at a protected release. Never constructed from runtime input. */
export interface HorsePhase14AuthoritySelection {
  readonly schema: 'horse-qualified-authority-selection-v1';
  readonly phase: 'phase14';
  /** One corrective domain, `<variant>-<format>`. */
  readonly domain: string;
  /** Exact 40-hex source revision the holdout evaluation ran at. */
  readonly sourceSha: string;
  readonly catalogVersion: string;
  /** Functional catalogs pin an independently held signing identity here. */
  readonly trustedSignerKeySha256?: string;
  /** `correctiveCatalogDigest` of the inactive catalog the evaluation measured. */
  readonly catalogDigest: string;
  /** The catalog's holdout digest; the evaluation must name the same one. */
  readonly holdoutDigest: string;
  /** Repository-relative path under docs/evidence/phase14/. */
  readonly qualificationPath: string;
  readonly qualificationSha256: string;
  /** Positive, strictly increasing across renewals and rollbacks. */
  readonly approvalGeneration: number;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly withdrawn: Readonly<{ at: string; reason: string }> | null;
}

import { PHASE14_PROTECTED_RELEASE_SELECTIONS } from './HorsePhase14ReleaseSelections.js';
export { PHASE14_PROTECTED_RELEASE_SELECTIONS } from './HorsePhase14ReleaseSelections.js';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const objectOf = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  objectOf(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function evidencePathIsSafe(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith(HORSE_PHASE14_EVIDENCE_DIRECTORY) &&
    path.endsWith('.json') &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..')
  );
}

function selectionIsWellFormed(s: HorsePhase14AuthoritySelection): boolean {
  return (
    objectOf(s) &&
    s.schema === 'horse-qualified-authority-selection-v1' &&
    s.phase === 'phase14' &&
    isHorsePhase14Domain(s.domain) &&
    typeof s.sourceSha === 'string' &&
    HEX40.test(s.sourceSha) &&
    typeof s.catalogVersion === 'string' &&
    typeof s.catalogDigest === 'string' &&
    HEX64.test(s.catalogDigest) &&
    typeof s.holdoutDigest === 'string' &&
    HEX64.test(s.holdoutDigest) &&
    evidencePathIsSafe(s.qualificationPath) &&
    typeof s.qualificationSha256 === 'string' &&
    HEX64.test(s.qualificationSha256) &&
    Number.isSafeInteger(s.approvalGeneration) &&
    s.approvalGeneration > 0 &&
    isoMs(s.issuedAt) !== null &&
    (s.expiresAt === null || (isoMs(s.expiresAt) ?? -1) > (isoMs(s.issuedAt) ?? Infinity)) &&
    (s.withdrawn === null ||
      (isoMs(s.withdrawn?.at) !== null &&
        typeof s.withdrawn?.reason === 'string' &&
        s.withdrawn.reason.length > 0))
  );
}

/**
 * Admit one domain's committed Phase 14 selection. Pure apart from the
 * injected read. Refusal order, every refusal named: `unselected` (before any
 * file read), `invalid_selection`, (a committed withdrawal is `withdrawn`),
 * `continuation_mismatch` (another domain or catalog version), `expired`,
 * `missing_evidence`, `unreadable_evidence` (transient), `hash_mismatch`,
 * `evidence_mismatch` (not JSON, another schema, not exactly the eight keys),
 * `not_qualified` (`qualified` not true, or any recorded reason),
 * `source_mismatch`, `continuation_mismatch` (the file's domain or catalog
 * version), `catalog_digest_mismatch`, `holdout_digest_mismatch`.
 */
export function admitHorsePhase14QualifiedAuthority(
  domain: string,
  selection: HorsePhase14AuthoritySelection | null,
  reader: HorseAuthorityEvidenceReader,
  nowMs: number
): HorseAuthorityAdmission {
  const refuse = (reason: HorseAuthorityRefusal, transient = false): HorseAuthorityAdmission => ({
    status: 'refused',
    reason,
    transient,
  });
  if (selection === null) return refuse('unselected');
  if (functionalKernelCatalogVersionIsKnown(selection.catalogVersion))
    return admitCorrectiveKernelAttachment(domain, selection, reader, nowMs).admission;
  if (!isHorsePhase14Domain(domain) || !selectionIsWellFormed(selection))
    return refuse('invalid_selection');
  if (selection.withdrawn !== null)
    return {
      status: 'withdrawn',
      approvalGeneration: selection.approvalGeneration,
      reason: `release_${selection.withdrawn.reason}`,
    };
  if (selection.domain !== domain || selection.catalogVersion !== HORSE_PHASE14_CATALOG_VERSION)
    return refuse('continuation_mismatch');
  if (selection.expiresAt !== null && nowMs >= (isoMs(selection.expiresAt) ?? -Infinity))
    return refuse('expired');

  let bytes: Buffer;
  try {
    bytes = reader.read(selection.qualificationPath);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? refuse('missing_evidence')
      : refuse('unreadable_evidence', true);
  }
  if (sha256(bytes) !== selection.qualificationSha256) return refuse('hash_mismatch');
  let file: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!exactKeys(parsed, HORSE_PHASE14_QUALIFICATION_KEYS)) throw Error('keys');
    file = parsed;
  } catch {
    return refuse('evidence_mismatch');
  }
  if (file.schema !== HORSE_PHASE14_QUALIFICATION_SCHEMA || !Array.isArray(file.reasons))
    return refuse('evidence_mismatch');
  if (file.qualified !== true || file.reasons.length !== 0) return refuse('not_qualified');
  if (file.sourceSha !== selection.sourceSha) return refuse('source_mismatch');
  if (file.domain !== domain || file.catalogVersion !== HORSE_PHASE14_CATALOG_VERSION)
    return refuse('continuation_mismatch');
  if (file.catalogDigest !== selection.catalogDigest) return refuse('catalog_digest_mismatch');
  if (file.holdoutDigest !== selection.holdoutDigest) return refuse('holdout_digest_mismatch');

  const identity = {
    schema: 'horse-qualified-authority-v1' as const,
    phase: 'phase14' as const,
    sourceSha: selection.sourceSha,
    continuationVersion: horsePhase14ContinuationVersion(domain),
    // The corrective "policy" is the exact catalog the holdout measured.
    policyDigest: selection.catalogDigest,
    packId: HORSE_PHASE14_CATALOG_VERSION,
    domain,
    evidencePath: selection.qualificationPath,
    evidenceSha256: selection.qualificationSha256,
    approvalGeneration: selection.approvalGeneration,
    issuedAt: selection.issuedAt,
    expiresAt: selection.expiresAt,
    catalogDigest: selection.catalogDigest,
    holdoutDigest: selection.holdoutDigest,
  };
  return {
    status: 'admitted',
    authority: Object.freeze({
      ...identity,
      authorityKey: sha256(JSON.stringify(canonical(identity))),
    }) as HorseQualifiedAuthority,
  };
}

/** Admit one domain's committed release selection from the repository/image files. */
export function admitHorsePhase14ReleaseAuthority(
  domain: string,
  nowMs = Date.now(),
  selection: HorsePhase14AuthoritySelection | null = isHorsePhase14Domain(domain)
    ? (PHASE14_PROTECTED_RELEASE_SELECTIONS[domain] ?? null)
    : null,
  reader: HorseAuthorityEvidenceReader = repositoryEvidenceReader
): HorseAuthorityAdmission {
  try {
    return admitHorsePhase14QualifiedAuthority(domain, selection, reader, nowMs);
  } catch {
    return { status: 'refused', reason: 'unreadable_evidence', transient: true };
  }
}

/** Atomically load the functional attachment and the same S4 admission. */
export function admitHorsePhase14ReleaseAttachment(
  domain: string,
  nowMs = Date.now(),
  selection: HorsePhase14AuthoritySelection | null = isHorsePhase14Domain(domain)
    ? (PHASE14_PROTECTED_RELEASE_SELECTIONS[domain] ?? null)
    : null,
  reader: HorseAuthorityEvidenceReader = repositoryEvidenceReader
): CorrectiveKernelAttachmentAdmission {
  try {
    return admitCorrectiveKernelAttachment(domain, selection, reader, nowMs);
  } catch {
    return {
      admission: { status: 'refused', reason: 'unreadable_evidence', transient: true },
      catalog: null,
    };
  }
}

/**
 * The live Phase 14 attachment: the committed release selection when it admits
 * (or withdraws), otherwise the corrective catalog and authority Dan's
 * 2026-10-26 order issues for the running code ("FORCE ACTIVATE EVERY PHASE
 * NOW WITHOUT QUALIFYING", `HorseOwnerForcedActivation.ts`). The worker and
 * the main-thread gate both use it.
 */
export function admitHorsePhase14LiveAttachment(
  domain: string,
  nowMs = Date.now()
): CorrectiveKernelAttachmentAdmission {
  const release = admitHorsePhase14ReleaseAttachment(domain, nowMs);
  if (release.admission.status !== 'refused' || release.admission.transient) return release;
  try {
    const forced = admitOwnerForcedCorrectiveKernelAttachment(domain);
    return forced.admission.status === 'admitted' ? forced : release;
  } catch {
    return release;
  }
}

/** The live Phase 14 admission alone, for the main-thread gate. */
export function admitHorsePhase14LiveAuthority(
  domain: string,
  nowMs = Date.now()
): HorseAuthorityAdmission {
  return admitHorsePhase14LiveAttachment(domain, nowMs).admission;
}

/** The admitted Phase 14 authority for `domain`, or null. */
export function selectedHorsePhase14Authority(
  domain: string,
  admission: HorseAuthorityAdmission
): HorseQualifiedAuthority | null {
  return admission.status === 'admitted' &&
    admission.authority.phase === 'phase14' &&
    isHorsePhase14Domain(domain) &&
    admission.authority.domain === domain &&
    (admission.authority.packId === HORSE_PHASE14_CATALOG_VERSION ||
      functionalKernelCatalogVersionIsKnown(admission.authority.packId)) &&
    admission.authority.continuationVersion ===
      horsePhase14ContinuationVersion(domain, admission.authority.packId)
    ? admission.authority
    : null;
}

export interface HorsePhase14CorrectiveMode {
  readonly mode: 'off' | 'shadow' | 'candidate';
  /** The deciding domain's holder reported usable authority for that domain. */
  readonly authorityUsable: boolean;
  readonly activationAllowed: boolean;
  readonly reason: string;
}

/**
 * The only mode question a Phase 14 caller may ask. The caller can turn the
 * corrective path off; it can never ask for candidate control. Candidate mode
 * requires both the deciding domain's usable holder and its runtime-branded
 * functional catalog. A legacy inactive catalog cannot activate this path.
 */
export function horsePhase14CorrectiveMode(input: {
  callerMode: unknown;
  domain: unknown;
  packDomain: string | null;
  verdict: HorseAuthorityVerdict;
  catalog?: Readonly<CorrectiveKernelCatalog> | null;
}): HorsePhase14CorrectiveMode {
  const base = { activationAllowed: false as const };
  if (input.callerMode === 'off')
    return { ...base, mode: 'off', authorityUsable: false, reason: 'caller_off' };
  if (!isHorsePhase14Domain(input.domain) || input.packDomain !== input.domain)
    return { ...base, mode: 'shadow', authorityUsable: false, reason: 'domain_mismatch' };
  if (input.verdict !== 'usable')
    return { ...base, mode: 'shadow', authorityUsable: false, reason: input.verdict };
  if (
    isValidatedCorrectiveKernelCatalog(input.catalog) &&
    correctiveDomainKey(input.catalog.domain) === input.domain
  )
    return {
      mode: 'candidate',
      authorityUsable: true,
      activationAllowed: true,
      reason: 'qualified_functional_catalog',
    };
  return {
    ...base,
    mode: 'shadow',
    authorityUsable: true,
    reason: 'functional_catalog_unavailable',
  };
}

/** Running continuation derives solely from the protected domain selection. */
export function horsePhase14RunningCatalogVersion(domain: string): string {
  const selected = PHASE14_PROTECTED_RELEASE_SELECTIONS[domain]?.catalogVersion;
  if (functionalKernelCatalogVersionIsKnown(selected)) return selected;
  // Dan's 2026-10-26 order: an unselected tournament domain runs the
  // owner-issued tournament catalog, whose version is the v2 protocol.
  const d = CORRECTIVE_DOMAINS.find((x) => correctiveDomainKey(x) === domain);
  return HORSE_OWNER_FORCED_ACTIVATION_ENABLED &&
    selected === undefined &&
    d?.mode === 'tournament' &&
    [TOURNAMENT_KERNEL_OBJECTIVE, CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE].some(
      (o) => tournamentKernelDefinitionFor(o, d) !== null
    )
    ? TOURNAMENT_KERNEL_CATALOG_VERSION
    : CORRECTIVE_KERNEL_CATALOG_VERSION;
}

/**
 * Main-thread Phase 14 gates: Phase 8's gate class, one per corrective domain,
 * each with that domain's admission and running continuation, so a withdrawal,
 * refresh failure or restart of one domain never touches another.
 */
export const liveHorsePhase14Authorities: Readonly<Record<string, HorsePhase8AuthorityGate>> =
  Object.freeze(
    Object.fromEntries(
      HORSE_PHASE14_DOMAINS.map((domain) => [
        domain,
        new HorsePhase8AuthorityGate(
          () => admitHorsePhase14LiveAuthority(domain),
          undefined,
          horsePhase14ContinuationVersion(domain, horsePhase14RunningCatalogVersion(domain))
        ),
      ])
    )
  );

/** Exact functional code/catalog composition as well as ordinary S4 freshness. */
export function horsePhase14AuthorityVerdict(receipt: {
  domain: string;
  catalogDigest: string;
  policyDigest: string;
  baselineSelectionsDigest: string;
  authority?: HorseAuthorityReceipt;
  baselineAuthorities?: Partial<
    Record<
      'phase8' | 'phase8_guard' | 'phase10' | 'phase11' | 'phase12' | 'phase13',
      HorseAuthorityReceipt
    >
  >;
}): HorseAuthorityVerdict {
  const gate = liveHorsePhase14Authorities[receipt.domain],
    checked = gate?.check(receipt.authority) ?? 'mismatched',
    authority = gate?.mainAuthority();
  if (checked === 'usable') {
    const correctiveDomain = CORRECTIVE_DOMAINS.find(
      (d) => correctiveDomainKey(d) === receipt.domain
    );
    if (!correctiveDomain) return 'mismatched';
    const variant = correctiveDomain.variant,
      now = Date.now();
    const baselineGateUsable = (
      owner: 'phase8' | 'phase8_guard' | 'phase10' | 'phase11' | 'phase12' | 'phase13',
      selected: unknown,
      gate: HorsePhase8AuthorityGate | undefined
    ) => {
      if (selected == null) return true;
      const a = gate?.mainAuthority();
      return (
        gate?.check(receipt.baselineAuthorities?.[owner]) === 'usable' &&
        !!a &&
        (a.expiresAt === null || now < Date.parse(a.expiresAt))
      );
    };
    if (
      !baselineGateUsable(
        'phase8_guard',
        correctiveDomain.mode === 'tournament' ? PHASE8_GUARD_PROTECTED_RELEASE_SELECTION : null,
        liveHorsePhase8GuardAuthority
      ) ||
      !baselineGateUsable(
        'phase8',
        correctiveDomain.mode === 'tournament' && !PHASE8_GUARD_PROTECTED_RELEASE_SELECTION
          ? PHASE8_PROTECTED_RELEASE_SELECTION
          : null,
        liveHorsePhase8Authority
      ) ||
      !baselineGateUsable(
        'phase10',
        variant === 'plo4' ? PHASE10_PROTECTED_RELEASE_SELECTION : null,
        liveHorsePhase10Authority
      ) ||
      !baselineGateUsable(
        'phase11',
        PHASE11_PROTECTED_RELEASE_SELECTIONS[
          variant as keyof typeof PHASE11_PROTECTED_RELEASE_SELECTIONS
        ],
        liveHorsePhase11Authorities[variant as keyof typeof liveHorsePhase11Authorities]
      ) ||
      !baselineGateUsable(
        'phase12',
        PHASE12_PROTECTED_RELEASE_SELECTIONS[
          variant as keyof typeof PHASE12_PROTECTED_RELEASE_SELECTIONS
        ],
        liveHorsePhase12Authorities[variant as keyof typeof liveHorsePhase12Authorities]
      ) ||
      !baselineGateUsable(
        'phase13',
        PHASE13_PROTECTED_RELEASE_SELECTIONS[
          variant as keyof typeof PHASE13_PROTECTED_RELEASE_SELECTIONS
        ],
        liveHorsePhase13Authorities[variant as keyof typeof liveHorsePhase13Authorities]
      )
    )
      return 'mismatched';
  }
  return checked === 'usable' &&
    (authority?.catalogDigest !== receipt.catalogDigest ||
      authority.correctivePolicyDigest !== receipt.policyDigest ||
      authority.baselineSelectionsDigest !== receipt.baselineSelectionsDigest)
    ? 'mismatched'
    : checked;
}

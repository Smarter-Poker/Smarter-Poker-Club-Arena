/**
 * Phase 14.4 (plan package P14-D, inactive slice; shared package S4): admission
 * of corrective candidates through the SAME generation-bound authority path
 * Phase 8 built and Phases 10 to 13 reused (`HorseQualifiedAuthority`). Nothing
 * here is a second authority system: the holder, the main-scheduler gate, the
 * receipt, the verdicts and the withdrawal laws are Phase 8's, reused once per
 * corrective domain (`<variant>-<format>`, the 45 domains
 * `horseCorrectiveReview/domain.ts` names).
 *
 * ACTIVATION IS UNAVAILABLE. Every entry of
 * `PHASE14_PROTECTED_RELEASE_SELECTIONS` is null, and that is not a default
 * waiting to be flipped: three inputs this repository does not have are
 * required first, and each is an unavailable external input:
 *  1. a qualified reference producer: a solver or exact enumerator that emits
 *     `reviewed_reference` alternative-action references for a covered domain,
 *     with a reproducible sampling contract and producer identity;
 *  2. an independent signer: a key, held and reviewed outside this code, whose
 *     digest the owner configures as `HORSE_CORRECTIVE_REVIEW_TRUSTED_KEY_SHA256`.
 *     No key is generated here or in any test that touches committed evidence;
 *     generating one would be self-qualification;
 *  3. a decision-time corrective applier: the consumer that would read an
 *     admitted catalog entry and move the live action distribution at the
 *     exact original information set, inside the worker FAST/DEEP path, with
 *     the acceptance-time and effect-time rechecks. It does not exist.
 * Until all three exist and a held-out evaluation of a built catalog is
 * committed under `docs/evidence/phase14/` with `qualified: true`, nothing can
 * select, and no decision path reads this module.
 *
 * Deliberately left out: worker holders, `protocol.ts` receipts, the client
 * stamp/forget, the acceptance-time recheck in `ServerTableEngineTurns` and the
 * witness binding that Phases 8 to 13 wire. Each of those gates an applier's
 * output, and there is no applier output to gate: adding them would put
 * always-unselected receipts on every decision and a recheck that can only ever
 * refuse nothing. They belong in the same change as the applier.
 * `horsePhase14CorrectiveMode` exists so the "a caller can never supply
 * candidate control" law is pinned now; it never returns an active mode.
 *
 * Each domain is selected only at a protected code release, by a reviewed change
 * to its own entry of `PHASE14_PROTECTED_RELEASE_SELECTIONS`, naming that
 * domain's committed qualification file and its exact sha256, the catalog
 * digest and the holdout digest the qualification evaluated. Nothing reads a
 * request, an IPC message, an environment variable or a database row.
 */
import { posix } from 'node:path';
import {
  canonical,
  HorsePhase8AuthorityGate,
  isoMs,
  repositoryEvidenceReader,
  sha256,
  type HorseAuthorityAdmission,
  type HorseAuthorityEvidenceReader,
  type HorseAuthorityRefusal,
  type HorseAuthorityVerdict,
  type HorseQualifiedAuthority,
} from './HorseQualifiedAuthority.js';
import { CORRECTIVE_CATALOG_VERSION } from '../services/horseCorrectiveReview/candidateCatalog.js';
import { CORRECTIVE_DOMAIN_KEYS } from '../services/horseCorrectiveReview/domain.js';

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
export function horsePhase14ContinuationVersion(domain: string): string {
  return `${HORSE_PHASE14_CATALOG_VERSION}/${domain}`;
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

/**
 * THE PROTECTED RELEASE SELECTIONS, one per corrective domain. All null: no
 * qualified reference producer, independent signer, held-out evaluation or
 * corrective applier exists, so no corrective candidate can be admitted.
 */
export const PHASE14_PROTECTED_RELEASE_SELECTIONS: Readonly<
  Record<string, HorsePhase14AuthoritySelection | null>
> = Object.freeze(Object.fromEntries(HORSE_PHASE14_DOMAINS.map((domain) => [domain, null])));

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

/** The admitted Phase 14 authority for `domain`, or null. */
export function selectedHorsePhase14Authority(
  domain: string,
  admission: HorseAuthorityAdmission
): HorseQualifiedAuthority | null {
  return admission.status === 'admitted' &&
    admission.authority.phase === 'phase14' &&
    isHorsePhase14Domain(domain) &&
    admission.authority.domain === domain &&
    admission.authority.continuationVersion === horsePhase14ContinuationVersion(domain)
    ? admission.authority
    : null;
}

export interface HorsePhase14CorrectiveMode {
  readonly mode: 'off' | 'shadow';
  /** The deciding domain's holder reported usable authority for that domain. */
  readonly authorityUsable: boolean;
  readonly activationAllowed: false;
  readonly reason: string;
}

/**
 * The only mode question a Phase 14 caller may ask. The caller can turn the
 * corrective path off; it can never ask for candidate control. Authority comes
 * only from the deciding domain's own holder verdict, and even usable
 * authority is reported as `corrective_applier_unavailable` with no active
 * mode, because no applier exists to consume it.
 */
export function horsePhase14CorrectiveMode(input: {
  callerMode: unknown;
  domain: unknown;
  packDomain: string | null;
  verdict: HorseAuthorityVerdict;
}): HorsePhase14CorrectiveMode {
  const base = { activationAllowed: false as const };
  if (input.callerMode === 'off')
    return { ...base, mode: 'off', authorityUsable: false, reason: 'caller_off' };
  if (!isHorsePhase14Domain(input.domain) || input.packDomain !== input.domain)
    return { ...base, mode: 'shadow', authorityUsable: false, reason: 'domain_mismatch' };
  if (input.verdict !== 'usable')
    return { ...base, mode: 'shadow', authorityUsable: false, reason: input.verdict };
  return {
    ...base,
    mode: 'shadow',
    authorityUsable: true,
    reason: 'corrective_applier_unavailable',
  };
}

/**
 * Main-thread Phase 14 gates: Phase 8's gate class, one per corrective domain,
 * each with that domain's admission and running continuation, so a withdrawal,
 * refresh failure or restart of one domain never touches another. No engine
 * path imports them; they exist so the null proof is executable.
 */
export const liveHorsePhase14Authorities: Readonly<Record<string, HorsePhase8AuthorityGate>> =
  Object.freeze(
    Object.fromEntries(
      HORSE_PHASE14_DOMAINS.map((domain) => [
        domain,
        new HorsePhase8AuthorityGate(
          () => admitHorsePhase14ReleaseAuthority(domain),
          undefined,
          horsePhase14ContinuationVersion(domain)
        ),
      ])
    )
  );

/**
 * Phase 10.3 (shared package S4): admission of the PLO4 policy pack through the
 * SAME generation-bound authority path Phase 8 built (`HorseQualifiedAuthority`).
 * Nothing here is a second authority system: the holder, the main-scheduler
 * gate, the receipt, the verdicts and the withdrawal laws are Phase 8's, reused
 * with the running PLO4 pack version. Only the qualification file differs,
 * because P10.2 writes `horse-phase10-qualification-v1` (cash after rake, with
 * the tournament objective refused by name), not Phase 8's
 * `horse-phase8-qualification-v1`.
 *
 * Authority is selected only at a protected code release, by a reviewed change
 * to `PHASE10_PROTECTED_RELEASE_SELECTION`, which names the committed P10.2
 * qualification file and its exact sha256. It is admitted only when that file
 * says `qualified: true` for the exact contract digest and source revision the
 * selection names, and the contract digest equals the running contract's.
 * Every other case is refused by name and the pack stays in shadow, exactly as
 * before this change. Nothing reads a request, an IPC message, an environment
 * variable or a database row, so a caller can never supply candidate control.
 *
 * Domain: the qualification is cash only. A tournament decision never admits
 * candidate mode, so the Phase 7 tournament utility owner keeps every
 * tournament objective decision exactly as it does today.
 *
 * Calibration and solver authority: none. The pack remains an explicit
 * heuristic (`calibratedConfidence: null`); a qualification is a paired
 * after-rake comparison against the deployed reference, not a solver claim.
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
import { PLO4_POLICY_PACK } from './plo4/Plo4PolicyPack.js';
import {
  PLO4_STRENGTH_CONTRACT,
  PLO4_STRENGTH_DOMAIN,
  plo4StrengthContractDigest,
} from '../benchmark/Plo4StrengthContract.js';
import type { Plo4LiveMode } from './plo4/Plo4LivePolicy.js';

/** P10.2 assembler output directory (`EVIDENCE_DIRECTORY` in phase10-strength-assemble.mjs). */
export const HORSE_PHASE10_EVIDENCE_DIRECTORY = 'docs/evidence/phase10/';
/** P10.2 assembler `QUALIFICATION_SCHEMA`. */
export const HORSE_PHASE10_QUALIFICATION_SCHEMA = 'horse-phase10-qualification-v1';
/** P10.2 `PLO4_STRENGTH_DOMAIN`: the only domain a Phase 10 qualification can grant. */
export const HORSE_PHASE10_DOMAIN = PLO4_STRENGTH_DOMAIN;
/** P10.2 `PLO4_STRENGTH_CONTRACT.version`. */
export const HORSE_PHASE10_CONTRACT_VERSION = PLO4_STRENGTH_CONTRACT.version;

/**
 * The running P10.2 contract digest (`plo4StrengthContractDigest()`, #5969).
 * A qualification is admitted only for this exact digest, so evidence made
 * under any other contract can never select the pack in this code.
 */
export const PHASE10_RUNNING_CONTRACT_DIGEST: string = plo4StrengthContractDigest();

/** Committed at a protected release. Never constructed from runtime input. */
export interface HorsePhase10AuthoritySelection {
  readonly schema: 'horse-qualified-authority-selection-v1';
  readonly phase: 'phase10';
  /** Exact 40-hex source revision the P10.2 matrix ran at (`sourceSha`). */
  readonly sourceSha: string;
  readonly packVersion: string;
  readonly contractVersion: string;
  /** The P10.2 contract digest the qualification must carry. */
  readonly contractDigest: string;
  readonly domain: string;
  /** Repository-relative path of the qualification file under docs/evidence/phase10/. */
  readonly qualificationPath: string;
  readonly qualificationSha256: string;
  /** Positive, strictly increasing across renewals; a withdrawn generation never returns. */
  readonly approvalGeneration: number;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly withdrawn: Readonly<{ at: string; reason: string }> | null;
}

/**
 * THE PROTECTED RELEASE SELECTION. Null: no qualified Phase 10 authority
 * exists, so every live PLO4 decision stays in shadow, as before P10.3. P10.2
 * has not run its matrix and no qualification file exists. Selecting requires
 * the assembler's qualification file (and the strength record it names)
 * committed under docs/evidence/phase10/ and shipped in the engine image, its
 * sha256 here, and the protected merge and engine release of that change.
 */
export const PHASE10_PROTECTED_RELEASE_SELECTION: HorsePhase10AuthoritySelection | null = null;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function evidencePathIsSafe(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith(HORSE_PHASE10_EVIDENCE_DIRECTORY) &&
    path.endsWith('.json') &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..')
  );
}

function selectionIsWellFormed(s: HorsePhase10AuthoritySelection): boolean {
  return (
    s.schema === 'horse-qualified-authority-selection-v1' &&
    s.phase === 'phase10' &&
    typeof s.sourceSha === 'string' &&
    HEX40.test(s.sourceSha) &&
    typeof s.packVersion === 'string' &&
    s.packVersion.length > 0 &&
    typeof s.contractVersion === 'string' &&
    typeof s.contractDigest === 'string' &&
    HEX64.test(s.contractDigest) &&
    typeof s.domain === 'string' &&
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

function readJsonObject(
  reader: HorseAuthorityEvidenceReader,
  path: string
): { ok: true; bytes: Buffer } | { ok: false; reason: HorseAuthorityRefusal; transient: boolean } {
  try {
    return { ok: true, bytes: reader.read(path) };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { ok: false, reason: 'missing_evidence', transient: false }
      : { ok: false, reason: 'unreadable_evidence', transient: true };
  }
}

/**
 * Admit a committed Phase 10 selection against the P10.2 qualification file.
 * Pure apart from the injected read. Every refusal is named:
 * `unselected`, `invalid_selection`, `continuation_mismatch` (pack version or
 * domain is not the running cash PLO4 domain), `contract_unavailable` (no
 * running contract digest), `contract_digest_mismatch` (selection or file
 * digest differs from the running contract), `expired`, `missing_evidence`,
 * `unreadable_evidence` (transient), `hash_mismatch`, `evidence_mismatch`
 * (schema, mode, contract version or shape), `not_qualified` (the file or its
 * cash objective is not `qualified: true`), `source_mismatch`.
 */
export function admitHorsePhase10QualifiedAuthority(
  selection: HorsePhase10AuthoritySelection | null,
  reader: HorseAuthorityEvidenceReader,
  nowMs: number,
  runningContractDigest: string | null
): HorseAuthorityAdmission {
  const refuse = (reason: HorseAuthorityRefusal, transient = false): HorseAuthorityAdmission => ({
    status: 'refused',
    reason,
    transient,
  });
  if (selection === null) return refuse('unselected');
  if (!selectionIsWellFormed(selection)) return refuse('invalid_selection');
  if (selection.withdrawn !== null)
    return {
      status: 'withdrawn',
      approvalGeneration: selection.approvalGeneration,
      reason: `release_${selection.withdrawn.reason}`,
    };
  if (
    selection.packVersion !== PLO4_POLICY_PACK.version ||
    selection.domain !== HORSE_PHASE10_DOMAIN
  )
    return refuse('continuation_mismatch');
  if (runningContractDigest === null || !HEX64.test(runningContractDigest))
    return refuse('contract_unavailable');
  if (selection.contractDigest !== runningContractDigest) return refuse('contract_digest_mismatch');
  if (selection.expiresAt !== null && nowMs >= (isoMs(selection.expiresAt) ?? -Infinity))
    return refuse('expired');
  const read = readJsonObject(reader, selection.qualificationPath);
  if (!read.ok) return refuse(read.reason, read.transient);
  if (sha256(read.bytes) !== selection.qualificationSha256) return refuse('hash_mismatch');
  let file: Record<string, unknown>;
  try {
    const parsed = JSON.parse(read.bytes.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('not object');
    file = parsed as Record<string, unknown>;
  } catch {
    return refuse('evidence_mismatch');
  }
  if (file.schema !== HORSE_PHASE10_QUALIFICATION_SCHEMA) return refuse('evidence_mismatch');
  const objectives = file.objectives as Record<string, unknown> | null | undefined;
  const cash =
    objectives && typeof objectives === 'object'
      ? (objectives.cash as Record<string, unknown> | null | undefined)
      : undefined;
  // The assembler writes qualified:false for development mode and for any
  // failed verdict; only a contract-mode, cash-qualified file may select.
  if (
    file.qualified !== true ||
    file.mode !== 'contract' ||
    !cash ||
    typeof cash !== 'object' ||
    cash.qualified !== true
  )
    return refuse('not_qualified');
  if (
    file.contractDigest !== runningContractDigest ||
    file.contractDigest !== selection.contractDigest
  )
    return refuse('contract_digest_mismatch');
  if (file.sourceSha !== selection.sourceSha) return refuse('source_mismatch');
  if (file.packVersion !== PLO4_POLICY_PACK.version || file.domain !== HORSE_PHASE10_DOMAIN)
    return refuse('continuation_mismatch');
  if (
    file.contractVersion !== selection.contractVersion ||
    typeof file.policyDigest !== 'string' ||
    !HEX64.test(file.policyDigest) ||
    !evidencePathIsSafe(file.evidencePath) ||
    typeof file.evidenceSha256 !== 'string' ||
    !HEX64.test(file.evidenceSha256)
  )
    return refuse('evidence_mismatch');
  // The strength record the qualification names must be the exact bytes it hashed.
  const strength = readJsonObject(reader, file.evidencePath);
  if (!strength.ok) return refuse(strength.reason, strength.transient);
  if (sha256(strength.bytes) !== file.evidenceSha256) return refuse('hash_mismatch');
  const identity = {
    schema: 'horse-qualified-authority-v1' as const,
    phase: 'phase10' as const,
    sourceSha: selection.sourceSha,
    continuationVersion: PLO4_POLICY_PACK.version,
    policyDigest: file.policyDigest,
    packId: PLO4_POLICY_PACK.version,
    domain: selection.domain,
    evidencePath: selection.qualificationPath,
    evidenceSha256: selection.qualificationSha256,
    approvalGeneration: selection.approvalGeneration,
    issuedAt: selection.issuedAt,
    expiresAt: selection.expiresAt,
    contractDigest: selection.contractDigest,
  };
  return {
    status: 'admitted',
    authority: Object.freeze({
      ...identity,
      authorityKey: sha256(JSON.stringify(canonical(identity))),
    }) as HorseQualifiedAuthority,
  };
}

/** Admit the committed Phase 10 release selection from the repository/image files. */
export function admitHorsePhase10ReleaseAuthority(
  nowMs = Date.now(),
  selection: HorsePhase10AuthoritySelection | null = PHASE10_PROTECTED_RELEASE_SELECTION,
  reader: HorseAuthorityEvidenceReader = repositoryEvidenceReader,
  runningContractDigest: string | null = PHASE10_RUNNING_CONTRACT_DIGEST
): HorseAuthorityAdmission {
  try {
    return admitHorsePhase10QualifiedAuthority(selection, reader, nowMs, runningContractDigest);
  } catch {
    return { status: 'refused', reason: 'unreadable_evidence', transient: true };
  }
}

/** The admitted Phase 10 authority, or null: the protected selection's effect. */
export function selectedHorsePhase10Authority(
  admission: HorseAuthorityAdmission
): HorseQualifiedAuthority | null {
  return admission.status === 'admitted' && admission.authority.phase === 'phase10'
    ? admission.authority
    : null;
}

/**
 * Worker-owned PLO4 mode. The caller may only turn the pack off; candidate
 * mode comes only from usable worker authority, and only for a cash decision.
 * A tournament decision stays shadow whatever the authority says, so the
 * Phase 7 owner keeps every tournament objective decision.
 */
export function horsePhase10AdmittedMode(input: {
  callerMode: Plo4LiveMode | undefined;
  gameMode: unknown;
  verdict: HorseAuthorityVerdict;
}): Plo4LiveMode {
  if (input.callerMode === 'off') return 'off';
  if (input.gameMode !== 'cash') return 'shadow';
  return input.verdict === 'usable' ? 'candidate' : 'shadow';
}

/** Main-thread Phase 10 gate for this engine process (Phase 8's gate class). */
export const liveHorsePhase10Authority = new HorsePhase8AuthorityGate(
  () => admitHorsePhase10ReleaseAuthority(),
  undefined,
  PLO4_POLICY_PACK.version
);

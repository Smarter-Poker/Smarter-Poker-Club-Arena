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
 * selection names, the contract digest equals the running contract's, and the
 * file's policy digest equals `horsePhase10PolicyDigest()` computed from the
 * running code (Phase 8 binds `horsePhase8PolicyDigest()` the same way).
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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * The Phase 10 policy digest definition (P10 authority audit F1). Version 1 was
 * the P10.2 assembler's `git show` hash of four files at the runs' head, which
 * the engine image cannot recompute; a qualification recorded under it (the
 * 2026-10-03 strength evidence) carries no `policyDigestDefinition` and is
 * refused as `policy_digest_mismatch`. Bump this whenever the file list or the
 * hashing below changes.
 */
export const HORSE_PHASE10_POLICY_DIGEST_DEFINITION = 'horse-phase10-policy-digest-v2';

/**
 * The code that determines PLO4 candidate behaviour, as server-relative source
 * paths: the pack and its live policy; the HorseLogic owner that computes the
 * equity sample and range provenance the policy consumes, invokes it and
 * legalizes its proposal; the registry that routes PLO4 to it; and every
 * module the policy calls at run time (card facts, Omaha nut status, pot and
 * rake arithmetic, the dealt-seat census, observation windows and capture) and
 * the HorseMind reads behind the sampled ranges.
 *
 * Deliberately not hashed: this file (it holds the protected release
 * selection, which must change to select, and the admission law, bound by the
 * definition version above) and the strength contract (bound by its own
 * contract digest). The engine image keeps `src/` beside `dist/` (see
 * server/Dockerfile), so the running code can recompute this digest.
 */
export const HORSE_PHASE10_POLICY_SOURCE_FILES: readonly string[] = Object.freeze([
  'src/engine/plo4/Plo4PolicyPack.ts',
  'src/engine/plo4/Plo4LivePolicy.ts',
  'src/engine/HorseLogic.ts',
  'src/engine/HorsePolicyRegistry.ts',
  'src/engine/HorseEval.ts',
  'src/engine/omaha/OmahaCardFacts.ts',
  'src/engine/PokerEngine.ts',
  'src/engine/multiway/DealtSeatCensus.ts',
  'src/engine/HorseObservationWindow.ts',
  'src/engine/HorseTournamentUtilityEvidence.ts',
  'src/engine/HorseMind.ts',
]);

/** Reads a server-relative source path. Throws on failure. */
export type HorsePhase10PolicySourceReader = (serverRelativePath: string) => Buffer;

/** The server root in source and test runs (src/engine/../../) and in the
 * engine image (dist/engine/../../ is /app, which holds src/). */
export const runningPolicySourceReader: HorsePhase10PolicySourceReader = (path) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)));

/** sha256 over the definition, the pack version and every policy source file
 * (path and exact bytes, in list order). Null when any file is unreadable. */
export function horsePhase10PolicyDigestOf(read: HorsePhase10PolicySourceReader): string | null {
  const hash = createHash('sha256');
  hash.update(`${HORSE_PHASE10_POLICY_DIGEST_DEFINITION}\0${PLO4_POLICY_PACK.version}\0`);
  try {
    for (const file of HORSE_PHASE10_POLICY_SOURCE_FILES) {
      const bytes = read(file);
      hash.update(`${file}\0`);
      hash.update(bytes);
      hash.update('\0');
    }
  } catch {
    return null;
  }
  return hash.digest('hex');
}

let runningPolicyDigest: string | null | undefined;
/**
 * The running code's Phase 10 policy digest. The P10.2 assembler records this
 * same function's value (it imports it), so evidence binds exactly the code
 * that admission later recomputes. Computed on first use and kept for the
 * process: an unselected engine never reads the sources.
 */
export function horsePhase10PolicyDigest(): string | null {
  if (runningPolicyDigest === undefined)
    runningPolicyDigest = horsePhase10PolicyDigestOf(runningPolicySourceReader);
  return runningPolicyDigest;
}

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
 * THE PROTECTED RELEASE SELECTION: the round-3 PLO4 pack
 * (`plo4-policy-round3-v2`), approval generation 1.
 *
 * Qualified on condition (a) of the winning contract as amended by the owner
 * on October 9, 2026 (docs/horse-brain-winning-contract-2026-10-08.md,
 * "Amendment Of October 9, 2026"): the locked P10.2 matrix on `c8bfc617`
 * (#6526), 111 of 111 shards, 2,557,440 pairs, cash after rake against the
 * horse population, +6.94 [+6.25, +7.62] bb/100, assembler verdict
 * `qualified: true`. Condition (b) is post-launch monitoring that can only
 * withdraw. The qualification file and the strength record it names are
 * committed under docs/evidence/phase10/ and shipped in the engine image under
 * server/release-evidence/. Withdrawal is a reviewed change of `withdrawn`
 * here to `{ at, reason }`; a withdrawn generation never returns.
 */
export const PHASE10_PROTECTED_RELEASE_SELECTION: HorsePhase10AuthoritySelection | null =
  Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase10',
    sourceSha: 'c8bfc6171ddfabdfa8d8ca55f4e13fc7e2466400',
    packVersion: 'plo4-policy-round3-v2',
    contractVersion: 'plo4-strength-contract-v1',
    contractDigest: '83ab185b2a2df72876b73d61ece6ea8c2f03f364ce252deecbfcde392ae5f838',
    domain: 'plo4-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase10/phase10-qualification-2026-10-09.json',
    qualificationSha256: '3d88e47fcd8a526295f32bdf7688c72110ebc79b0a495740f2a2b0b6e2f4d3c0',
    approvalGeneration: 1,
    issuedAt: '2026-10-09T15:20:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const);

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
 * digest differs from the running contract), `policy_digest_unavailable` (the
 * running policy digest cannot be computed), `expired`, `missing_evidence`,
 * `unreadable_evidence` (transient), `hash_mismatch`, `evidence_mismatch`
 * (schema, mode, contract version or shape), `not_qualified` (the file or its
 * cash objective is not `qualified: true`), `policy_digest_mismatch` (the
 * file's digest definition or policy digest is not the running code's),
 * `source_mismatch`.
 *
 * `runningPolicyDigest` defaults to `horsePhase10PolicyDigest()`, read only
 * once a well-formed, unwithdrawn selection reaches that check.
 */
export function admitHorsePhase10QualifiedAuthority(
  selection: HorsePhase10AuthoritySelection | null,
  reader: HorseAuthorityEvidenceReader,
  nowMs: number,
  runningContractDigest: string | null,
  runningPolicyDigest?: string | null
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
  const policyDigest =
    runningPolicyDigest === undefined ? horsePhase10PolicyDigest() : runningPolicyDigest;
  if (policyDigest === null || !HEX64.test(policyDigest))
    return refuse('policy_digest_unavailable');
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
  // The evidence must have measured the code that is running now.
  if (
    file.policyDigestDefinition !== HORSE_PHASE10_POLICY_DIGEST_DEFINITION ||
    file.policyDigest !== policyDigest
  )
    return refuse('policy_digest_mismatch');
  if (file.sourceSha !== selection.sourceSha) return refuse('source_mismatch');
  if (file.packVersion !== PLO4_POLICY_PACK.version || file.domain !== HORSE_PHASE10_DOMAIN)
    return refuse('continuation_mismatch');
  if (
    file.contractVersion !== selection.contractVersion ||
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
    policyDigest,
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
  runningContractDigest: string | null = PHASE10_RUNNING_CONTRACT_DIGEST,
  runningPolicyDigest?: string | null
): HorseAuthorityAdmission {
  try {
    return admitHorsePhase10QualifiedAuthority(
      selection,
      reader,
      nowMs,
      runningContractDigest,
      runningPolicyDigest
    );
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

/**
 * Phase 11.3 (shared package S4): admission of the PLO5, PLO6 and PLO8 policy
 * packs through the SAME generation-bound authority path Phase 8 built and
 * Phase 10 reused (`HorseQualifiedAuthority`). Nothing here is a second
 * authority system: the holder, the main-scheduler gate, the receipt, the
 * verdicts and the withdrawal laws are Phase 8's, reused once per pack with
 * that pack's running version. Only the evidence differs: P11.2 writes one
 * `horse-phase11-qualification-v1` file per pack, and the P11.2 contract
 * (`liveConditions.admissionAlsoRequires`) makes admission also depend on a
 * committed natural completion-share record, whose schema
 * (`horse-phase11-completion-v1`) and floor are defined here.
 *
 * Three packs, three selections, three gates. Each pack is selected only at a
 * protected code release, by a reviewed change to its own entry of
 * `PHASE11_PROTECTED_RELEASE_SELECTIONS`, naming that pack's committed
 * qualification file and completion record and their exact sha256. A
 * selection for one pack never admits another: the variant, its pack version,
 * its domain and its policy digest (which hashes the variant) must all be the
 * running pack's. Every refusal is named and the pack stays in shadow, exactly
 * as before this change. Nothing reads a request, an IPC message, an
 * environment variable or a database row, so a caller can never supply
 * candidate control.
 *
 * Domain: the qualification is cash only. A tournament decision never admits
 * candidate mode, so the Phase 7 tournament utility owner keeps every
 * tournament objective decision exactly as it does today.
 *
 * Calibration and solver authority: none. The packs remain explicit
 * heuristics (`calibratedConfidence: null`); a qualification is a paired
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
import {
  isOmahaPolicyVariant,
  OMAHA_VARIANT_PACKS,
  type OmahaPolicyVariant,
} from './omaha/OmahaVariantPolicyPack.js';
import type { OmahaVariantMode } from './omaha/OmahaVariantLivePolicy.js';
import {
  HORSE_PHASE11_POLICY_DIGEST_DEFINITION,
  horsePhase11PolicyDigest,
} from './HorsePhase11PolicyDigest.js';
import {
  OMAHA_VARIANT_STRENGTH_CONTRACT,
  omahaVariantStrengthContractDigest,
  omahaVariantStrengthDomain,
} from '../benchmark/OmahaVariantStrengthContract.js';

/** P11.2 assembler output directory (`EVIDENCE_DIRECTORY` in phase11-strength-assemble.mjs). */
export const HORSE_PHASE11_EVIDENCE_DIRECTORY = 'docs/evidence/phase11/';
/** P11.2 assembler `QUALIFICATION_SCHEMA`. */
export const HORSE_PHASE11_QUALIFICATION_SCHEMA = 'horse-phase11-qualification-v1';
/** P11.2 `OMAHA_VARIANT_STRENGTH_CONTRACT.version`. */
export const HORSE_PHASE11_CONTRACT_VERSION = OMAHA_VARIANT_STRENGTH_CONTRACT.version;
/** The three Phase 11 packs, in a fixed order. */
export const HORSE_PHASE11_VARIANTS: readonly OmahaPolicyVariant[] = Object.freeze([
  'plo5',
  'plo6',
  'plo8',
]);

/**
 * The running P11.2 contract digest (`omahaVariantStrengthContractDigest()`).
 * A qualification is admitted only for this exact digest, so evidence made
 * under any other contract can never select a pack in this code.
 */
export const PHASE11_RUNNING_CONTRACT_DIGEST: string = omahaVariantStrengthContractDigest();

// ---------------------------------------------------------------------------
// Natural completion-share evidence (P11.2 `liveConditions.admissionAlsoRequires`)
// ---------------------------------------------------------------------------

/** Schema of the committed natural completion record, one per pack. */
export const HORSE_PHASE11_COMPLETION_SCHEMA = 'horse-phase11-completion-v1';

/**
 * What a completion record counts. Bump when the counting below changes.
 *
 * Population: natural cash decisions of the pack's variant on one engine
 * release, read from the journaled Phase 11 receipts (`omahaVariantPolicy`).
 * Shadow and candidate receipts run the same policy code, so a shadow release
 * whose policy digest equals the running one measures the share the candidate
 * would see. Tournament decisions are not counted (they never admit candidate
 * mode).
 *
 * Eligible: the receipt is `eligible` (every canonical check passed and the
 * pack evaluated the node). Completed: an eligible decision whose proposal is
 * the policy the P11.2 matrix measured, which ran on a fixed clock with every
 * sample complete. Two live outcomes are not that policy and are counted
 * separately, so `eligible = completed + workBudget + samplerBudgetExhausted`:
 *  - `workBudget`: the policy exceeded `OMAHA_VARIANT_DOMAIN.liveBudgetMs` and
 *    fell back to the reference action (reason `work_budget`);
 *  - `samplerBudgetExhausted`: the proposal finished inside the budget but
 *    consumed a live range sample the sampler cut short at its own 3 ms
 *    budget (`inputs.range.provenance.work.budgetExhausted`), so it priced a
 *    smaller sample than the matrix did.
 */
export const HORSE_PHASE11_COMPLETION_DEFINITION = 'horse-phase11-completion-definition-v1';

/**
 * THE COMPLETION FLOOR, per street: 0.95, judged on the 99% lower confidence
 * bound of the completion share, never on the point share.
 *
 * Why a floor at all: the P11.2 matrix measured the candidate only on
 * decisions that complete. A decision that falls back executes the reference
 * action, so a hand can mix candidate and reference streets in a line neither
 * arm of the matrix played, and a truncated sample prices a different
 * proposal. A pack that falls back on a large share of decisions is not the
 * policy that was measured, whatever its qualification says.
 *
 * Why 0.95: no calibrated cost of such a mixed line exists in source (the same
 * reason the P11.2 contract has no effect-size floor), so the floor bounds the
 * unmeasured share rather than its cost: at least 19 of every 20 eligible
 * decisions on every street must be the measured policy. It is a stated bound,
 * not a fitted number; a stricter one is a reviewed code change.
 *
 * Why per street: sampling and its work run postflop, mostly on the river,
 * where P11.1 measured 3.5 to 5.7 ms for the full sample against the 4 ms
 * live budget. A pooled share would let a completing preflop hide a failing
 * river.
 *
 * Why a lower bound: the share is checked as the Wilson score lower bound at
 * the P11.2 interval's own z (`OMAHA_VARIANT_STRENGTH_CONTRACT.interval.z`,
 * Phi^-1(0.995)), so a street whose true share is below 0.95 passes with
 * probability at most 0.5%, and a small window cannot pass by luck: even a
 * window in which every decision completes needs at least
 * `HORSE_PHASE11_COMPLETION_MIN_ELIGIBLE_PER_STREET` (127) eligible decisions
 * on each street.
 */
export const HORSE_PHASE11_COMPLETION_FLOOR = 0.95;
const COMPLETION_Z = OMAHA_VARIANT_STRENGTH_CONTRACT.interval.z;
/** The smallest all-complete street that can pass: n / (n + z^2) >= floor. */
export const HORSE_PHASE11_COMPLETION_MIN_ELIGIBLE_PER_STREET = Math.ceil(
  (HORSE_PHASE11_COMPLETION_FLOOR * COMPLETION_Z * COMPLETION_Z) /
    (1 - HORSE_PHASE11_COMPLETION_FLOOR)
);

export const HORSE_PHASE11_COMPLETION_STREETS = Object.freeze([
  'preflop',
  'flop',
  'turn',
  'river',
] as const);
export type HorsePhase11CompletionStreet = (typeof HORSE_PHASE11_COMPLETION_STREETS)[number];

export interface HorsePhase11StreetCompletion {
  readonly eligible: number;
  readonly completed: number;
  readonly workBudget: number;
  readonly samplerBudgetExhausted: number;
}

/** A committed `horse-phase11-completion-v1` record (exact keys). */
export interface HorsePhase11CompletionRecord {
  readonly schema: typeof HORSE_PHASE11_COMPLETION_SCHEMA;
  readonly definition: typeof HORSE_PHASE11_COMPLETION_DEFINITION;
  readonly variant: OmahaPolicyVariant;
  readonly packVersion: string;
  /** Exact 40-hex engine release the natural decisions were read from. */
  readonly releaseSha: string;
  readonly policyDigestDefinition: string;
  /** `horsePhase11PolicyDigest(variant)` of that release. */
  readonly policyDigest: string;
  readonly gameMode: 'cash';
  readonly window: Readonly<{
    from: string;
    to: string;
    /** The release served unchanged from `from` to `to`. */
    releaseUnchanged: boolean;
    /** Where the decisions were read (for the record; not interpreted). */
    source: string;
  }>;
  readonly streets: Readonly<Record<HorsePhase11CompletionStreet, HorsePhase11StreetCompletion>>;
}

export type HorsePhase11CompletionOutcome =
  | 'not_counted'
  | 'completed'
  | 'work_budget'
  | 'sampler_budget_exhausted';

const objectOf = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * How one journaled Phase 11 receipt counts toward a pack's completion record
 * (`HORSE_PHASE11_COMPLETION_DEFINITION`). Pure; reads only the receipt.
 */
export function horsePhase11CompletionOutcome(
  variant: OmahaPolicyVariant,
  receipt: unknown
): HorsePhase11CompletionOutcome {
  if (
    !objectOf(receipt) ||
    receipt.variant !== variant ||
    receipt.version !== OMAHA_VARIANT_PACKS[variant].version ||
    receipt.eligible !== true ||
    receipt.utilityOwner !== 'cash' ||
    !(HORSE_PHASE11_COMPLETION_STREETS as readonly unknown[]).includes(receipt.street)
  )
    return 'not_counted';
  if (receipt.reason === 'work_budget') return 'work_budget';
  const inputs = receipt.inputs;
  const range = objectOf(inputs) ? inputs.range : undefined;
  const provenance = objectOf(range) ? range.provenance : undefined;
  const work = objectOf(provenance) ? provenance.work : undefined;
  if (
    objectOf(range) &&
    range.status === 'consumed' &&
    objectOf(work) &&
    work.budgetExhausted === true
  )
    return 'sampler_budget_exhausted';
  return 'completed';
}

/** Per-street counts over journaled receipts, in the record's exact shape. */
export function horsePhase11CompletionCounts(
  variant: OmahaPolicyVariant,
  receipts: Iterable<unknown>
): Record<HorsePhase11CompletionStreet, HorsePhase11StreetCompletion> {
  const counts = Object.fromEntries(
    HORSE_PHASE11_COMPLETION_STREETS.map((street) => [
      street,
      { eligible: 0, completed: 0, workBudget: 0, samplerBudgetExhausted: 0 },
    ])
  ) as Record<
    HorsePhase11CompletionStreet,
    { eligible: number; completed: number; workBudget: number; samplerBudgetExhausted: number }
  >;
  for (const receipt of receipts) {
    const outcome = horsePhase11CompletionOutcome(variant, receipt);
    if (outcome === 'not_counted') continue;
    const street = counts[(receipt as { street: HorsePhase11CompletionStreet }).street];
    street.eligible += 1;
    if (outcome === 'completed') street.completed += 1;
    else if (outcome === 'work_budget') street.workBudget += 1;
    else street.samplerBudgetExhausted += 1;
  }
  return counts;
}

/** The Wilson score lower bound of `completed / eligible` at the contract z. */
export function horsePhase11CompletionLowerBound(completed: number, eligible: number): number {
  if (!(eligible > 0)) return 0;
  const n = eligible;
  const p = completed / n;
  const z2 = COMPLETION_Z * COMPLETION_Z;
  const centre = p + z2 / (2 * n);
  const spread = COMPLETION_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - spread) / (1 + z2 / n));
}

/** Does every street of a record clear the floor? */
export function horsePhase11CompletionMeetsFloor(
  streets: HorsePhase11CompletionRecord['streets']
): boolean {
  return HORSE_PHASE11_COMPLETION_STREETS.every(
    (street) =>
      horsePhase11CompletionLowerBound(streets[street].completed, streets[street].eligible) >=
      HORSE_PHASE11_COMPLETION_FLOOR
  );
}

// ---------------------------------------------------------------------------
// The protected release selections
// ---------------------------------------------------------------------------

/** Committed at a protected release. Never constructed from runtime input. */
export interface HorsePhase11AuthoritySelection {
  readonly schema: 'horse-qualified-authority-selection-v1';
  readonly phase: 'phase11';
  readonly variant: OmahaPolicyVariant;
  /** Exact 40-hex source revision the P11.2 matrix ran at (`sourceSha`). */
  readonly sourceSha: string;
  readonly packVersion: string;
  readonly contractVersion: string;
  /** The P11.2 contract digest the qualification must carry. */
  readonly contractDigest: string;
  readonly domain: string;
  /** Repository-relative path of the qualification file under docs/evidence/phase11/. */
  readonly qualificationPath: string;
  readonly qualificationSha256: string;
  /** Repository-relative path of the `horse-phase11-completion-v1` record
   * under docs/evidence/phase11/; null is refused as completion_evidence_missing. */
  readonly completionPath: string | null;
  readonly completionSha256: string | null;
  /** Positive, strictly increasing across renewals; a withdrawn generation never returns. */
  readonly approvalGeneration: number;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly withdrawn: Readonly<{ at: string; reason: string }> | null;
}

/**
 * THE PROTECTED RELEASE SELECTIONS, one per pack. All null: no qualified
 * Phase 11 authority exists, so every live PLO5, PLO6 and PLO8 decision stays
 * in shadow, as before P11.3. P11.2 has not run any pack's matrix and no
 * qualification or completion record exists. Selecting a pack requires its
 * qualification file, the strength record it names and its natural completion
 * record committed under docs/evidence/phase11/ and shipped in the engine
 * image, their sha256 here, and the protected merge and engine release of that
 * change.
 */
export const PHASE11_PROTECTED_RELEASE_SELECTIONS: Readonly<
  Record<'plo5' | 'plo6' | 'plo8', HorsePhase11AuthoritySelection | null>
> = Object.freeze({ plo5: null, plo6: null, plo8: null });

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function evidencePathIsSafe(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith(HORSE_PHASE11_EVIDENCE_DIRECTORY) &&
    path.endsWith('.json') &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..')
  );
}

function selectionIsWellFormed(s: HorsePhase11AuthoritySelection): boolean {
  return (
    s.schema === 'horse-qualified-authority-selection-v1' &&
    s.phase === 'phase11' &&
    isOmahaPolicyVariant(s.variant) &&
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
    ((s.completionPath === null && s.completionSha256 === null) ||
      (evidencePathIsSafe(s.completionPath) &&
        s.completionPath !== s.qualificationPath &&
        typeof s.completionSha256 === 'string' &&
        HEX64.test(s.completionSha256))) &&
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

type Read = { ok: true; bytes: Buffer } | { ok: false; missing: boolean };
function read(reader: HorseAuthorityEvidenceReader, path: string): Read {
  try {
    return { ok: true, bytes: reader.read(path) };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return { ok: false, missing: code === 'ENOENT' || code === 'ENOTDIR' };
  }
}

function parseObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    return objectOf(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  objectOf(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const COMPLETION_KEYS = [
  'schema',
  'definition',
  'variant',
  'packVersion',
  'releaseSha',
  'policyDigestDefinition',
  'policyDigest',
  'gameMode',
  'window',
  'streets',
] as const;
const STREET_KEYS = ['eligible', 'completed', 'workBudget', 'samplerBudgetExhausted'] as const;

/** Schema, shape and internal consistency of a completion record. */
function completionIsWellFormed(value: unknown): value is HorsePhase11CompletionRecord {
  if (
    !exactKeys(value, COMPLETION_KEYS) ||
    value.schema !== HORSE_PHASE11_COMPLETION_SCHEMA ||
    value.definition !== HORSE_PHASE11_COMPLETION_DEFINITION ||
    typeof value.variant !== 'string' ||
    typeof value.packVersion !== 'string' ||
    typeof value.releaseSha !== 'string' ||
    !HEX40.test(value.releaseSha) ||
    typeof value.policyDigestDefinition !== 'string' ||
    typeof value.policyDigest !== 'string' ||
    !HEX64.test(value.policyDigest) ||
    value.gameMode !== 'cash' ||
    !exactKeys(value.window, ['from', 'to', 'releaseUnchanged', 'source']) ||
    typeof value.window.releaseUnchanged !== 'boolean' ||
    typeof value.window.source !== 'string' ||
    !exactKeys(value.streets, HORSE_PHASE11_COMPLETION_STREETS)
  )
    return false;
  const streets = value.streets;
  return HORSE_PHASE11_COMPLETION_STREETS.every((street) => {
    const s = streets[street];
    return (
      exactKeys(s, STREET_KEYS) &&
      STREET_KEYS.every((key) => count(s[key])) &&
      (s.completed as number) + (s.workBudget as number) + (s.samplerBudgetExhausted as number) ===
        s.eligible
    );
  });
}

/**
 * Admit one pack's committed Phase 11 selection against its P11.2
 * qualification file and its natural completion record. Pure apart from the
 * injected read. Every refusal is named, in this order:
 * `unselected`, `invalid_selection`, (a committed withdrawal is `withdrawn`),
 * `continuation_mismatch` (the selection's variant, pack version or domain is
 * not the running pack's), `contract_unavailable`, `contract_digest_mismatch`,
 * `policy_digest_unavailable`, `expired`, `missing_evidence`,
 * `unreadable_evidence` (transient), `hash_mismatch`, `evidence_mismatch`,
 * `not_qualified`, `contract_digest_mismatch`, `policy_digest_mismatch`,
 * `source_mismatch`, `continuation_mismatch` (the file's variant, pack or
 * domain), `evidence_mismatch` (contract version, evidence path or hash, or
 * an admission requirement other than the contract's), the strength record's
 * `missing_evidence` or `hash_mismatch`; then the completion record:
 * `completion_evidence_missing` (none named, or no such file),
 * `unreadable_evidence` (transient), `completion_hash_mismatch`,
 * `completion_evidence_mismatch` (not JSON, schema, definition, shape or
 * counts that do not add up), `completion_release_mismatch` (another
 * variant, pack version or policy digest than the running pack's: it was not
 * measured on the running policy), `completion_window_invalid` (an empty or
 * reversed window, a release that changed during it, or a window that ends
 * after the selection was issued), `completion_below_floor`.
 *
 * `runningPolicyDigest` defaults to `horsePhase11PolicyDigest(variant)`, read
 * only once a well-formed, unwithdrawn selection reaches that check.
 */
export function admitHorsePhase11QualifiedAuthority(
  variant: OmahaPolicyVariant,
  selection: HorsePhase11AuthoritySelection | null,
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
  if (!isOmahaPolicyVariant(variant) || !selectionIsWellFormed(selection))
    return refuse('invalid_selection');
  if (selection.withdrawn !== null)
    return {
      status: 'withdrawn',
      approvalGeneration: selection.approvalGeneration,
      reason: `release_${selection.withdrawn.reason}`,
    };
  const packVersion = OMAHA_VARIANT_PACKS[variant].version;
  const domain = omahaVariantStrengthDomain(variant);
  if (
    selection.variant !== variant ||
    selection.packVersion !== packVersion ||
    selection.domain !== domain
  )
    return refuse('continuation_mismatch');
  if (runningContractDigest === null || !HEX64.test(runningContractDigest))
    return refuse('contract_unavailable');
  if (selection.contractDigest !== runningContractDigest) return refuse('contract_digest_mismatch');
  const policyDigest =
    runningPolicyDigest === undefined ? horsePhase11PolicyDigest(variant) : runningPolicyDigest;
  if (policyDigest === null || !HEX64.test(policyDigest))
    return refuse('policy_digest_unavailable');
  if (selection.expiresAt !== null && nowMs >= (isoMs(selection.expiresAt) ?? -Infinity))
    return refuse('expired');

  // The P11.2 qualification file.
  const qualification = read(reader, selection.qualificationPath);
  if (!qualification.ok)
    return qualification.missing ? refuse('missing_evidence') : refuse('unreadable_evidence', true);
  if (sha256(qualification.bytes) !== selection.qualificationSha256) return refuse('hash_mismatch');
  const file = parseObject(qualification.bytes);
  if (!file || file.schema !== HORSE_PHASE11_QUALIFICATION_SCHEMA)
    return refuse('evidence_mismatch');
  const objectives = objectOf(file.objectives) ? file.objectives : null;
  const cash = objectives && objectOf(objectives.cash) ? objectives.cash : null;
  // The assembler writes qualified:false for development mode and for any
  // failed verdict; only a contract-mode, cash-qualified file may select.
  if (file.qualified !== true || file.mode !== 'contract' || !cash || cash.qualified !== true)
    return refuse('not_qualified');
  if (
    file.contractDigest !== runningContractDigest ||
    file.contractDigest !== selection.contractDigest
  )
    return refuse('contract_digest_mismatch');
  // The evidence must have measured this pack's code as it is running now.
  if (
    file.policyDigestDefinition !== HORSE_PHASE11_POLICY_DIGEST_DEFINITION ||
    file.policyDigest !== policyDigest
  )
    return refuse('policy_digest_mismatch');
  if (file.sourceSha !== selection.sourceSha) return refuse('source_mismatch');
  if (file.variant !== variant || file.packVersion !== packVersion || file.domain !== domain)
    return refuse('continuation_mismatch');
  if (
    file.contractVersion !== HORSE_PHASE11_CONTRACT_VERSION ||
    file.contractVersion !== selection.contractVersion ||
    JSON.stringify(file.admissionAlsoRequires) !==
      JSON.stringify(OMAHA_VARIANT_STRENGTH_CONTRACT.liveConditions.admissionAlsoRequires) ||
    !evidencePathIsSafe(file.evidencePath) ||
    typeof file.evidenceSha256 !== 'string' ||
    !HEX64.test(file.evidenceSha256)
  )
    return refuse('evidence_mismatch');
  // The strength record the qualification names must be the exact bytes it hashed.
  const strength = read(reader, file.evidencePath);
  if (!strength.ok)
    return strength.missing ? refuse('missing_evidence') : refuse('unreadable_evidence', true);
  if (sha256(strength.bytes) !== file.evidenceSha256) return refuse('hash_mismatch');

  // The natural completion record (P11.2 admissionAlsoRequires).
  if (selection.completionPath === null || selection.completionSha256 === null)
    return refuse('completion_evidence_missing');
  const completion = read(reader, selection.completionPath);
  if (!completion.ok)
    return completion.missing
      ? refuse('completion_evidence_missing')
      : refuse('unreadable_evidence', true);
  if (sha256(completion.bytes) !== selection.completionSha256)
    return refuse('completion_hash_mismatch');
  const record = parseObject(completion.bytes);
  if (!completionIsWellFormed(record)) return refuse('completion_evidence_mismatch');
  if (
    record.variant !== variant ||
    record.packVersion !== packVersion ||
    record.policyDigestDefinition !== HORSE_PHASE11_POLICY_DIGEST_DEFINITION ||
    record.policyDigest !== policyDigest
  )
    return refuse('completion_release_mismatch');
  const from = isoMs(record.window.from);
  const to = isoMs(record.window.to);
  const issued = isoMs(selection.issuedAt) as number;
  if (
    from === null ||
    to === null ||
    from >= to ||
    to > issued ||
    record.window.releaseUnchanged !== true
  )
    return refuse('completion_window_invalid');
  if (!horsePhase11CompletionMeetsFloor(record.streets)) return refuse('completion_below_floor');

  const identity = {
    schema: 'horse-qualified-authority-v1' as const,
    phase: 'phase11' as const,
    variant,
    sourceSha: selection.sourceSha,
    continuationVersion: packVersion,
    policyDigest,
    packId: packVersion,
    domain,
    evidencePath: selection.qualificationPath,
    evidenceSha256: selection.qualificationSha256,
    completionPath: selection.completionPath,
    completionSha256: selection.completionSha256,
    approvalGeneration: selection.approvalGeneration,
    issuedAt: selection.issuedAt,
    expiresAt: selection.expiresAt,
    contractDigest: selection.contractDigest,
  };
  return {
    status: 'admitted',
    authority: Object.freeze({
      ...identity,
      authorityKey: sha256(
        JSON.stringify(
          canonical({
            ...identity,
            completionDefinition: HORSE_PHASE11_COMPLETION_DEFINITION,
            completionFloor: HORSE_PHASE11_COMPLETION_FLOOR,
          })
        )
      ),
    }) as HorseQualifiedAuthority,
  };
}

/** Admit one pack's committed release selection from the repository/image files. */
export function admitHorsePhase11ReleaseAuthority(
  variant: OmahaPolicyVariant,
  nowMs = Date.now(),
  selection: HorsePhase11AuthoritySelection | null = isOmahaPolicyVariant(variant)
    ? PHASE11_PROTECTED_RELEASE_SELECTIONS[variant]
    : null,
  reader: HorseAuthorityEvidenceReader = repositoryEvidenceReader,
  runningContractDigest: string | null = PHASE11_RUNNING_CONTRACT_DIGEST,
  runningPolicyDigest?: string | null
): HorseAuthorityAdmission {
  try {
    return admitHorsePhase11QualifiedAuthority(
      variant,
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

/** The admitted Phase 11 authority for `variant`, or null. */
export function selectedHorsePhase11Authority(
  variant: OmahaPolicyVariant,
  admission: HorseAuthorityAdmission
): HorseQualifiedAuthority | null {
  return admission.status === 'admitted' &&
    admission.authority.phase === 'phase11' &&
    admission.authority.variant === variant &&
    admission.authority.continuationVersion === OMAHA_VARIANT_PACKS[variant]?.version
    ? admission.authority
    : null;
}

/**
 * Worker-owned Phase 11 mode. The caller may only turn the packs off.
 * Candidate mode comes only from usable worker authority for the decision's
 * own pack (`packVariant`, the holder the verdict came from, must be the
 * decision's variant), and only for a cash decision. A tournament decision
 * stays shadow whatever the authority says, so the Phase 7 owner keeps every
 * tournament objective decision.
 */
export function horsePhase11AdmittedMode(input: {
  callerMode: OmahaVariantMode | undefined;
  gameMode: unknown;
  variant: unknown;
  packVariant: OmahaPolicyVariant | null;
  verdict: HorseAuthorityVerdict;
}): OmahaVariantMode {
  if (input.callerMode === 'off') return 'off';
  if (
    input.gameMode !== 'cash' ||
    !isOmahaPolicyVariant(input.variant) ||
    input.packVariant !== input.variant
  )
    return 'shadow';
  return input.verdict === 'usable' ? 'candidate' : 'shadow';
}

/**
 * Main-thread Phase 11 gates for this engine process: Phase 8's gate class,
 * one per pack, each with that pack's admission and running version, so a
 * withdrawal, refresh failure or restart of one pack never touches another.
 */
export const liveHorsePhase11Authorities: Readonly<
  Record<OmahaPolicyVariant, HorsePhase8AuthorityGate>
> = Object.freeze({
  plo5: new HorsePhase8AuthorityGate(
    () => admitHorsePhase11ReleaseAuthority('plo5'),
    undefined,
    OMAHA_VARIANT_PACKS.plo5.version
  ),
  plo6: new HorsePhase8AuthorityGate(
    () => admitHorsePhase11ReleaseAuthority('plo6'),
    undefined,
    OMAHA_VARIANT_PACKS.plo6.version
  ),
  plo8: new HorsePhase8AuthorityGate(
    () => admitHorsePhase11ReleaseAuthority('plo8'),
    undefined,
    OMAHA_VARIANT_PACKS.plo8.version
  ),
});

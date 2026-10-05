/**
 * Phase 12.3 (shared package S4): admission of the Short Deck, Crazy
 * Pineapple, Fixed Limit Hold'em and Fixed Limit Omaha Eight-or-Better policy
 * packs through the SAME generation-bound authority path Phase 8 built and
 * Phases 10 and 11 reused (`HorseQualifiedAuthority`). Nothing here is a
 * second authority system: the holder, the main-scheduler gate, the receipt,
 * the verdicts and the withdrawal laws are Phase 8's, reused once per pack
 * with that pack's running version, exactly as P11.3 reused them for PLO5,
 * PLO6 and PLO8. Only the evidence differs: P12.2 writes one
 * `horse-phase12-qualification-v1` file per pack, and the P12.2 contract
 * (`liveConditions.admissionAlsoRequires`) makes admission also depend on a
 * committed natural completion-share record, whose schema
 * (`horse-phase12-completion-v1`) and floor are defined here.
 *
 * Four packs, four selections, four gates. Each pack is selected only at a
 * protected code release, by a reviewed change to its own entry of
 * `PHASE12_PROTECTED_RELEASE_SELECTIONS`, naming that pack's committed
 * qualification file and completion record and their exact sha256. A
 * selection for one pack never admits another: the variant, its pack version,
 * its domain and its policy digest (which hashes the variant and its pack
 * version) must all be the running pack's. Every refusal is named and the pack
 * stays in shadow, exactly as before this change. Nothing reads a request, an
 * IPC message, an environment variable or a database row, so a caller can
 * never supply candidate control.
 *
 * Domain: the qualification is cash only. A tournament decision never admits
 * candidate mode, so the Phase 7 tournament utility owner keeps every
 * tournament objective decision exactly as it does today (and Crazy Pineapple
 * has no tournament format at all).
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
  isRemainingPolicyVariant,
  REMAINING_VARIANT_DOMAIN,
  REMAINING_VARIANT_PACKS,
  type RemainingPolicyVariant,
} from './remainingVariants/RemainingVariantPolicyPack.js';
import type { RemainingVariantMode } from './remainingVariants/RemainingVariantLivePolicy.js';
import {
  HORSE_PHASE12_POLICY_DIGEST_DEFINITION,
  horsePhase12PolicyDigest,
} from './HorsePhase12PolicyDigest.js';
import {
  REMAINING_VARIANT_STRENGTH_CONTRACT,
  remainingVariantStrengthContractDigest,
  remainingVariantStrengthPack,
} from '../benchmark/RemainingVariantStrengthContract.js';

/** P12.2 assembler output directory (`EVIDENCE_DIRECTORY` in phase12-strength-assemble.mjs). */
export const HORSE_PHASE12_EVIDENCE_DIRECTORY = 'docs/evidence/phase12/';
/** P12.2 assembler `QUALIFICATION_SCHEMA`. */
export const HORSE_PHASE12_QUALIFICATION_SCHEMA = 'horse-phase12-qualification-v1';
/** P12.2 `REMAINING_VARIANT_STRENGTH_CONTRACT.version`. */
export const HORSE_PHASE12_CONTRACT_VERSION = REMAINING_VARIANT_STRENGTH_CONTRACT.version;
/** The four Phase 12 packs, in a fixed order. */
export const HORSE_PHASE12_VARIANTS: readonly RemainingPolicyVariant[] = Object.freeze([
  'short_deck',
  'pineapple',
  'flh',
  'flo8',
]);

/**
 * The running P12.2 contract digest (`remainingVariantStrengthContractDigest()`).
 * A qualification is admitted only for this exact digest, so evidence made
 * under any other contract can never select a pack in this code.
 */
export const PHASE12_RUNNING_CONTRACT_DIGEST: string = remainingVariantStrengthContractDigest();

/** The keys the P12.2 assembler writes into a qualification file, exactly. */
export const HORSE_PHASE12_QUALIFICATION_KEYS = Object.freeze([
  'schema',
  'qualified',
  'mode',
  'variant',
  'sourceSha',
  'packVersion',
  'contractVersion',
  'contractDigest',
  'domain',
  'policyDigest',
  'policyDigestDefinition',
  'objectives',
  'admissionAlsoRequires',
  'evidencePath',
  'evidenceSha256',
  'reasons',
] as const);
const CASH_OBJECTIVE_KEYS = ['qualified', 'status', 'regressionMarginBbPer100'] as const;

// ---------------------------------------------------------------------------
// Natural completion-share evidence (P12.2 `liveConditions.admissionAlsoRequires`)
// ---------------------------------------------------------------------------

/** Schema of the committed natural completion record, one per pack. */
export const HORSE_PHASE12_COMPLETION_SCHEMA = 'horse-phase12-completion-v1';

/**
 * The number of samples the P12.2 matrix priced every postflop proposal on:
 * the sampler's full request with the equity governor off
 * (`remainingVariantRequestedSamples(1)`, `REMAINING_VARIANT_DOMAIN.defaultSamples`).
 */
export const HORSE_PHASE12_FULL_SAMPLES: number = REMAINING_VARIANT_DOMAIN.defaultSamples;

/**
 * What a completion record counts. Bump when the counting below changes.
 *
 * Population: natural cash betting decisions of the pack's variant on one
 * engine release, read from the journaled Phase 12 receipts
 * (`remainingVariantPolicy`). Shadow and candidate receipts run the same
 * policy code, so a shadow release whose policy digest equals the running one
 * measures the share the candidate would see. Not counted: tournament
 * decisions (they never admit candidate mode) and every Crazy Pineapple
 * discard (`pineapple_discard`; not a betting proposal, chosen by the worker's
 * discard path and never a candidate).
 *
 * Eligible: the receipt is `eligible` (every canonical check passed and the
 * pack evaluated the node). Completed: an eligible decision whose proposal is
 * the policy the P12.2 matrix measured, which ran on a fixed clock, with the
 * equity governor off and every sample complete. Four live outcomes are not
 * that policy and are counted separately, so `eligible = completed +
 * workBudget + samplerBudgetExhausted + sampleUnavailable + governorReduced`,
 * each decision under the first that applies:
 *  - `workBudget`: the policy exceeded `REMAINING_VARIANT_DOMAIN.liveBudgetMs`
 *    and fell back to the reference action (reason `work_budget`);
 *  - `samplerBudgetExhausted`: the proposal consumed a live range sample the
 *    sampler cut short at its own deadline
 *    (`inputs.range.provenance.work.budgetExhausted`);
 *  - `sampleUnavailable`: a postflop proposal that consumed no live sample of
 *    the sampler's own (none drawn, refused, or one without its provenance),
 *    so it took branches the matrix never priced;
 *  - `governorReduced`: a postflop proposal whose consumed sample requested
 *    fewer than `HORSE_PHASE12_FULL_SAMPLES` because the equity governor
 *    scaled it down under load: it completed what it asked for, but it priced
 *    a smaller sample than the matrix did. (The Phase 11 audit found its
 *    definition counted such samples as completed; this one does not.)
 */
export const HORSE_PHASE12_COMPLETION_DEFINITION = 'horse-phase12-completion-definition-v1';

/**
 * THE COMPLETION FLOOR, per street: 0.95, judged on the 99% lower confidence
 * bound of the completion share, never on the point share. The P11.3 floor and
 * its reasons, applied to Phase 12:
 *
 * Why a floor at all: the P12.2 matrix measured the candidate only on
 * decisions that complete. A decision that falls back executes the reference
 * action, so a hand can mix candidate and reference streets in a line neither
 * arm of the matrix played, and a truncated or reduced sample prices a
 * different proposal. A pack that does either on a large share of decisions is
 * not the policy that was measured, whatever its qualification says.
 *
 * Why 0.95: no calibrated cost of such a mixed line exists in source (the same
 * reason the P12.2 contract has no effect-size floor), so the floor bounds the
 * unmeasured share rather than its cost: at least 19 of every 20 eligible
 * decisions on every street must be the measured policy. It is a stated bound,
 * not a fitted number; a different one is a reviewed code change, and the
 * floor is bound into every authority key.
 *
 * Why per street: sampling and its work run postflop, where the live sampler
 * stops starting work at `REMAINING_VARIANT_DOMAIN.samplingDeadlineMs`. A
 * pooled share would let a completing preflop hide a failing river.
 *
 * Why a lower bound: the share is checked as the Wilson score lower bound at
 * the P12.2 interval's own z (`REMAINING_VARIANT_STRENGTH_CONTRACT.interval.z`,
 * Phi^-1(0.995)), so a street whose true share is below 0.95 passes with
 * probability at most 0.5%, and a small window cannot pass by luck: even a
 * window in which every decision completes needs at least
 * `HORSE_PHASE12_COMPLETION_MIN_ELIGIBLE_PER_STREET` (127) eligible decisions
 * on each street.
 */
export const HORSE_PHASE12_COMPLETION_FLOOR = 0.95;
const COMPLETION_Z = REMAINING_VARIANT_STRENGTH_CONTRACT.interval.z;
/** The smallest all-complete street that can pass: n / (n + z^2) >= floor. */
export const HORSE_PHASE12_COMPLETION_MIN_ELIGIBLE_PER_STREET = Math.ceil(
  (HORSE_PHASE12_COMPLETION_FLOOR * COMPLETION_Z * COMPLETION_Z) /
    (1 - HORSE_PHASE12_COMPLETION_FLOOR)
);

export const HORSE_PHASE12_COMPLETION_STREETS = Object.freeze([
  'preflop',
  'flop',
  'turn',
  'river',
] as const);
export type HorsePhase12CompletionStreet = (typeof HORSE_PHASE12_COMPLETION_STREETS)[number];

export interface HorsePhase12StreetCompletion {
  readonly eligible: number;
  readonly completed: number;
  readonly workBudget: number;
  readonly samplerBudgetExhausted: number;
  readonly sampleUnavailable: number;
  readonly governorReduced: number;
}

/** A committed `horse-phase12-completion-v1` record (exact keys). */
export interface HorsePhase12CompletionRecord {
  readonly schema: typeof HORSE_PHASE12_COMPLETION_SCHEMA;
  readonly definition: typeof HORSE_PHASE12_COMPLETION_DEFINITION;
  readonly variant: RemainingPolicyVariant;
  readonly packVersion: string;
  /** Exact 40-hex engine release the natural decisions were read from. */
  readonly releaseSha: string;
  readonly policyDigestDefinition: string;
  /** `horsePhase12PolicyDigest(variant)` of that release. */
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
  readonly streets: Readonly<Record<HorsePhase12CompletionStreet, HorsePhase12StreetCompletion>>;
}

export type HorsePhase12CompletionOutcome =
  | 'not_counted'
  | 'completed'
  | 'work_budget'
  | 'sampler_budget_exhausted'
  | 'sample_unavailable'
  | 'governor_reduced';

const objectOf = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * How one journaled Phase 12 receipt counts toward a pack's completion record
 * (`HORSE_PHASE12_COMPLETION_DEFINITION`). Pure; reads only the receipt.
 */
export function horsePhase12CompletionOutcome(
  variant: RemainingPolicyVariant,
  receipt: unknown
): HorsePhase12CompletionOutcome {
  if (
    !isRemainingPolicyVariant(variant) ||
    !objectOf(receipt) ||
    receipt.variant !== variant ||
    receipt.version !== REMAINING_VARIANT_PACKS[variant].version ||
    receipt.eligible !== true ||
    receipt.utilityOwner !== 'cash' ||
    // Every Pineapple discard (stage pineapple_discard) is excluded here: it
    // is not a betting street.
    !(HORSE_PHASE12_COMPLETION_STREETS as readonly unknown[]).includes(receipt.street)
  )
    return 'not_counted';
  if (receipt.reason === 'work_budget') return 'work_budget';
  const inputs = receipt.inputs;
  const range = objectOf(inputs) ? inputs.range : undefined;
  const consumed = objectOf(range) && range.status === 'consumed';
  const provenance = consumed ? (range as Record<string, unknown>).provenance : undefined;
  const work = objectOf(provenance) ? provenance.work : undefined;
  if (consumed && objectOf(work) && work.budgetExhausted === true)
    return 'sampler_budget_exhausted';
  if (receipt.street === 'preflop') return 'completed';
  // Postflop the matrix priced every proposal on a complete, full live sample.
  if (
    !consumed ||
    !objectOf(work) ||
    !Number.isSafeInteger(work.requestedSamples) ||
    work.budgetExhausted !== false
  )
    return 'sample_unavailable';
  if ((work.requestedSamples as number) < HORSE_PHASE12_FULL_SAMPLES) return 'governor_reduced';
  return 'completed';
}

/** Per-street counts over journaled receipts, in the record's exact shape. */
export function horsePhase12CompletionCounts(
  variant: RemainingPolicyVariant,
  receipts: Iterable<unknown>
): Record<HorsePhase12CompletionStreet, HorsePhase12StreetCompletion> {
  type Mutable = { -readonly [K in keyof HorsePhase12StreetCompletion]: number };
  const counts = Object.fromEntries(
    HORSE_PHASE12_COMPLETION_STREETS.map((street) => [
      street,
      {
        eligible: 0,
        completed: 0,
        workBudget: 0,
        samplerBudgetExhausted: 0,
        sampleUnavailable: 0,
        governorReduced: 0,
      },
    ])
  ) as Record<HorsePhase12CompletionStreet, Mutable>;
  const field: Record<Exclude<HorsePhase12CompletionOutcome, 'not_counted'>, keyof Mutable> = {
    completed: 'completed',
    work_budget: 'workBudget',
    sampler_budget_exhausted: 'samplerBudgetExhausted',
    sample_unavailable: 'sampleUnavailable',
    governor_reduced: 'governorReduced',
  };
  for (const receipt of receipts) {
    const outcome = horsePhase12CompletionOutcome(variant, receipt);
    if (outcome === 'not_counted') continue;
    const street = counts[(receipt as { street: HorsePhase12CompletionStreet }).street];
    street.eligible += 1;
    street[field[outcome]] += 1;
  }
  return counts;
}

/** The Wilson score lower bound of `completed / eligible` at the contract z. */
export function horsePhase12CompletionLowerBound(completed: number, eligible: number): number {
  if (!(eligible > 0)) return 0;
  const n = eligible;
  const p = completed / n;
  const z2 = COMPLETION_Z * COMPLETION_Z;
  const centre = p + z2 / (2 * n);
  const spread = COMPLETION_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - spread) / (1 + z2 / n));
}

/** Does every street of a record clear the floor? */
export function horsePhase12CompletionMeetsFloor(
  streets: HorsePhase12CompletionRecord['streets']
): boolean {
  return HORSE_PHASE12_COMPLETION_STREETS.every(
    (street) =>
      horsePhase12CompletionLowerBound(streets[street].completed, streets[street].eligible) >=
      HORSE_PHASE12_COMPLETION_FLOOR
  );
}

// ---------------------------------------------------------------------------
// The protected release selections
// ---------------------------------------------------------------------------

/** Committed at a protected release. Never constructed from runtime input. */
export interface HorsePhase12AuthoritySelection {
  readonly schema: 'horse-qualified-authority-selection-v1';
  readonly phase: 'phase12';
  readonly variant: RemainingPolicyVariant;
  /** Exact 40-hex source revision the P12.2 matrix ran at (`sourceSha`). */
  readonly sourceSha: string;
  readonly packVersion: string;
  readonly contractVersion: string;
  /** The P12.2 contract digest the qualification must carry. */
  readonly contractDigest: string;
  readonly domain: string;
  /** Repository-relative path of the qualification file under docs/evidence/phase12/. */
  readonly qualificationPath: string;
  readonly qualificationSha256: string;
  /** Repository-relative path of the `horse-phase12-completion-v1` record
   * under docs/evidence/phase12/; null is refused as completion_evidence_missing. */
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
 * Phase 12 authority exists, so every live Short Deck, Crazy Pineapple, FLH
 * and FLO8 decision stays in shadow, as before P12.3. P12.2 has not run any
 * pack's held-out matrix and no qualification or completion record exists.
 * Selecting a pack requires its qualification file, the strength record it
 * names and its natural completion record committed under
 * docs/evidence/phase12/ and shipped in the engine image, their sha256 here,
 * and the protected merge and engine release of that change.
 */
export const PHASE12_PROTECTED_RELEASE_SELECTIONS: Readonly<
  Record<RemainingPolicyVariant, HorsePhase12AuthoritySelection | null>
> = Object.freeze({ short_deck: null, pineapple: null, flh: null, flo8: null });

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function evidencePathIsSafe(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith(HORSE_PHASE12_EVIDENCE_DIRECTORY) &&
    path.endsWith('.json') &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..')
  );
}

function selectionIsWellFormed(s: HorsePhase12AuthoritySelection): boolean {
  return (
    s.schema === 'horse-qualified-authority-selection-v1' &&
    s.phase === 'phase12' &&
    isRemainingPolicyVariant(s.variant) &&
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
const STREET_KEYS = [
  'eligible',
  'completed',
  'workBudget',
  'samplerBudgetExhausted',
  'sampleUnavailable',
  'governorReduced',
] as const;

/** Schema, shape and internal consistency of a completion record. */
function completionIsWellFormed(value: unknown): value is HorsePhase12CompletionRecord {
  if (
    !exactKeys(value, COMPLETION_KEYS) ||
    value.schema !== HORSE_PHASE12_COMPLETION_SCHEMA ||
    value.definition !== HORSE_PHASE12_COMPLETION_DEFINITION ||
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
    !exactKeys(value.streets, HORSE_PHASE12_COMPLETION_STREETS)
  )
    return false;
  const streets = value.streets;
  return HORSE_PHASE12_COMPLETION_STREETS.every((street) => {
    const s = streets[street];
    return (
      exactKeys(s, STREET_KEYS) &&
      STREET_KEYS.every((key) => count(s[key])) &&
      (s.completed as number) +
        (s.workBudget as number) +
        (s.samplerBudgetExhausted as number) +
        (s.sampleUnavailable as number) +
        (s.governorReduced as number) ===
        s.eligible
    );
  });
}

/**
 * Admit one pack's committed Phase 12 selection against its P12.2
 * qualification file and its natural completion record. Pure apart from the
 * injected read. Every refusal is named, in this order:
 * `unselected` (before any file or policy-source read), `invalid_selection`,
 * (a committed withdrawal is `withdrawn`), `continuation_mismatch` (the
 * selection's variant, pack version or domain is not the running pack's),
 * `contract_unavailable`, `contract_digest_mismatch`,
 * `policy_digest_unavailable`, `expired`, `missing_evidence`,
 * `unreadable_evidence` (transient), `hash_mismatch`, `evidence_mismatch` (not
 * JSON, another schema, not exactly the assembler's keys, or a malformed
 * objectives section), `not_qualified` (top level, contract mode, the cash
 * objective measured and qualified, no failure reasons),
 * `contract_digest_mismatch`, `policy_digest_mismatch`, `source_mismatch`,
 * `continuation_mismatch` (the file's variant, pack or domain),
 * `evidence_mismatch` (contract version, a cash margin other than the
 * contract's, a tournament objective claimed qualified, evidence path or hash,
 * or an admission requirement other than the contract's), the strength
 * record's `missing_evidence` or `hash_mismatch`; then the completion record:
 * `completion_evidence_missing` (none named, or no such file),
 * `unreadable_evidence` (transient), `completion_hash_mismatch`,
 * `completion_evidence_mismatch` (not JSON, schema, definition, shape or
 * counts that do not add up), `completion_release_mismatch` (another variant,
 * pack version or policy digest than the running pack's: it was not measured
 * on the running policy), `completion_window_invalid` (an empty or reversed
 * window, a release that changed during it, or a window that ends after the
 * selection was issued), `completion_below_floor`.
 *
 * `runningPolicyDigest` defaults to `horsePhase12PolicyDigest(variant)`,
 * recomputed from the running code and read only once a well-formed,
 * unwithdrawn selection of the running pack reaches that check.
 */
export function admitHorsePhase12QualifiedAuthority(
  variant: RemainingPolicyVariant,
  selection: HorsePhase12AuthoritySelection | null,
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
  if (!isRemainingPolicyVariant(variant) || !selectionIsWellFormed(selection))
    return refuse('invalid_selection');
  if (selection.withdrawn !== null)
    return {
      status: 'withdrawn',
      approvalGeneration: selection.approvalGeneration,
      reason: `release_${selection.withdrawn.reason}`,
    };
  const packVersion = REMAINING_VARIANT_PACKS[variant].version;
  const pack = remainingVariantStrengthPack(variant);
  const domain = pack.domain;
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
    runningPolicyDigest === undefined ? horsePhase12PolicyDigest(variant) : runningPolicyDigest;
  if (policyDigest === null || !HEX64.test(policyDigest))
    return refuse('policy_digest_unavailable');
  if (selection.expiresAt !== null && nowMs >= (isoMs(selection.expiresAt) ?? -Infinity))
    return refuse('expired');

  // The P12.2 qualification file.
  const qualification = read(reader, selection.qualificationPath);
  if (!qualification.ok)
    return qualification.missing ? refuse('missing_evidence') : refuse('unreadable_evidence', true);
  if (sha256(qualification.bytes) !== selection.qualificationSha256) return refuse('hash_mismatch');
  const file = parseObject(qualification.bytes);
  if (
    !file ||
    file.schema !== HORSE_PHASE12_QUALIFICATION_SCHEMA ||
    !exactKeys(file, HORSE_PHASE12_QUALIFICATION_KEYS) ||
    !exactKeys(file.objectives, ['cash', 'tournament']) ||
    !exactKeys(file.objectives.cash, CASH_OBJECTIVE_KEYS) ||
    !objectOf(file.objectives.tournament) ||
    !Array.isArray(file.reasons)
  )
    return refuse('evidence_mismatch');
  const cash = file.objectives.cash;
  const tournament = file.objectives.tournament;
  // The assembler writes qualified:false for development mode and for any
  // failed verdict; only a contract-mode, cash-qualified file with no failure
  // reason may select.
  if (
    file.qualified !== true ||
    file.mode !== 'contract' ||
    cash.qualified !== true ||
    cash.status !== 'measured' ||
    file.reasons.length !== 0
  )
    return refuse('not_qualified');
  if (
    file.contractDigest !== runningContractDigest ||
    file.contractDigest !== selection.contractDigest
  )
    return refuse('contract_digest_mismatch');
  // The evidence must have measured this pack's code as it is running now.
  if (
    file.policyDigestDefinition !== HORSE_PHASE12_POLICY_DIGEST_DEFINITION ||
    file.policyDigest !== policyDigest
  )
    return refuse('policy_digest_mismatch');
  if (file.sourceSha !== selection.sourceSha) return refuse('source_mismatch');
  if (file.variant !== variant || file.packVersion !== packVersion || file.domain !== domain)
    return refuse('continuation_mismatch');
  if (
    file.contractVersion !== HORSE_PHASE12_CONTRACT_VERSION ||
    file.contractVersion !== selection.contractVersion ||
    cash.regressionMarginBbPer100 !== pack.regressionMargin.lowerBoundAtLeastBbPer100 ||
    tournament.qualified !== false ||
    JSON.stringify(file.admissionAlsoRequires) !==
      JSON.stringify(REMAINING_VARIANT_STRENGTH_CONTRACT.liveConditions.admissionAlsoRequires) ||
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

  // The natural completion record (P12.2 admissionAlsoRequires).
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
    record.policyDigestDefinition !== HORSE_PHASE12_POLICY_DIGEST_DEFINITION ||
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
  if (!horsePhase12CompletionMeetsFloor(record.streets)) return refuse('completion_below_floor');

  const identity = {
    schema: 'horse-qualified-authority-v1' as const,
    phase: 'phase12' as const,
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
            completionDefinition: HORSE_PHASE12_COMPLETION_DEFINITION,
            completionFloor: HORSE_PHASE12_COMPLETION_FLOOR,
          })
        )
      ),
    }) as HorseQualifiedAuthority,
  };
}

/** Admit one pack's committed release selection from the repository/image files. */
export function admitHorsePhase12ReleaseAuthority(
  variant: RemainingPolicyVariant,
  nowMs = Date.now(),
  selection: HorsePhase12AuthoritySelection | null = isRemainingPolicyVariant(variant)
    ? PHASE12_PROTECTED_RELEASE_SELECTIONS[variant]
    : null,
  reader: HorseAuthorityEvidenceReader = repositoryEvidenceReader,
  runningContractDigest: string | null = PHASE12_RUNNING_CONTRACT_DIGEST,
  runningPolicyDigest?: string | null
): HorseAuthorityAdmission {
  try {
    return admitHorsePhase12QualifiedAuthority(
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

/** The admitted Phase 12 authority for `variant`, or null. */
export function selectedHorsePhase12Authority(
  variant: RemainingPolicyVariant,
  admission: HorseAuthorityAdmission
): HorseQualifiedAuthority | null {
  return admission.status === 'admitted' &&
    admission.authority.phase === 'phase12' &&
    admission.authority.variant === variant &&
    isRemainingPolicyVariant(variant) &&
    admission.authority.continuationVersion === REMAINING_VARIANT_PACKS[variant].version
    ? admission.authority
    : null;
}

/**
 * Worker-owned Phase 12 mode. The caller may only turn the packs off.
 * Candidate mode comes only from usable worker authority for the decision's
 * own pack (`packVariant`, the holder the verdict came from, must be the
 * decision's variant), and only for a cash decision. A tournament decision
 * stays shadow whatever the authority says, so the Phase 7 owner keeps every
 * tournament objective decision.
 */
export function horsePhase12AdmittedMode(input: {
  callerMode: RemainingVariantMode | undefined;
  gameMode: unknown;
  variant: unknown;
  packVariant: RemainingPolicyVariant | null;
  verdict: HorseAuthorityVerdict;
}): RemainingVariantMode {
  if (input.callerMode === 'off') return 'off';
  if (
    input.gameMode !== 'cash' ||
    !isRemainingPolicyVariant(input.variant) ||
    input.packVariant !== input.variant
  )
    return 'shadow';
  return input.verdict === 'usable' ? 'candidate' : 'shadow';
}

/**
 * Main-thread Phase 12 gates for this engine process: Phase 8's gate class,
 * one per pack, each with that pack's admission and running version, so a
 * withdrawal, refresh failure or restart of one pack never touches another.
 */
export const liveHorsePhase12Authorities: Readonly<
  Record<RemainingPolicyVariant, HorsePhase8AuthorityGate>
> = Object.freeze(
  Object.fromEntries(
    HORSE_PHASE12_VARIANTS.map((variant) => [
      variant,
      new HorsePhase8AuthorityGate(
        () => admitHorsePhase12ReleaseAuthority(variant),
        undefined,
        REMAINING_VARIANT_PACKS[variant].version
      ),
    ])
  ) as Record<RemainingPolicyVariant, HorsePhase8AuthorityGate>
);

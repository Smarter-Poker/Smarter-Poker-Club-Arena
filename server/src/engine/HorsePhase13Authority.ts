/**
 * Phase 13.3 (shared package S4): admission of the joint multiway owner
 * (`server/src/engine/multiway/*`) through the SAME generation-bound authority
 * path Phase 8 built and Phases 10, 11 and 12 reused (`HorseQualifiedAuthority`).
 * Nothing here is a second authority system: the holder, the main-scheduler
 * gate, the receipt, the verdicts and the withdrawal laws are Phase 8's, reused
 * once per variant. The joint owner is one policy, but it is qualified one
 * domain per variant (`<variant>-cash-joint-multiway-after-rake-horse-population`),
 * so there are nine selections, nine gates and nine worker holders, each bound
 * to `horsePhase13ContinuationVersion(variant)`: an NLH authority never
 * admits, backs or is accepted for a PLO4 decision.
 *
 * Each variant is selected only at a protected code release, by a reviewed
 * change to its own entry of `PHASE13_PROTECTED_RELEASE_SELECTIONS`, naming
 * that variant's committed P13.2 qualification file and its natural completion
 * record and their exact sha256. Every refusal is named and the joint owner
 * stays in shadow, exactly as before this change. Nothing reads a request, an
 * IPC message, an environment variable or a database row, so a caller can
 * never supply candidate control.
 *
 * Domain: cash only. A tournament decision never admits candidate mode, so the
 * Phase 7 tournament utility owner keeps every tournament objective decision.
 * A Phase 13 candidate is never applied on top of an applied Phase 10/11/12
 * candidate (`earlier_phase_applied`, HorseLogic's joint node).
 *
 * Calibration and solver authority: none. The joint packs remain explicit
 * heuristics (`calibratedConfidence: null`).
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
import type { JointPolicyMode } from './multiway/JointLivePolicy.js';
import { JOINT_LIVE_DOMAIN, jointFullSamples } from './multiway/JointSampleAcquisition.js';
import { isJointVariant, JOINT_VARIANTS, type JointVariant } from './multiway/JointInputBinding.js';
import {
  HORSE_PHASE13_POLICY_DIGEST_DEFINITION,
  horsePhase13PolicyDigest,
} from './HorsePhase13PolicyDigest.js';
import {
  JOINT_STRENGTH_CONTRACT,
  JOINT_STRENGTH_Z99,
  jointStrengthContractDigest,
  jointStrengthDomain,
} from '../benchmark/JointStrengthContract.js';

/** P13.2 assembler output directory. */
export const HORSE_PHASE13_EVIDENCE_DIRECTORY = 'docs/evidence/phase13/';
/** P13.2 assembler qualification schema. */
export const HORSE_PHASE13_QUALIFICATION_SCHEMA = 'horse-phase13-qualification-v1';
/** P13.2 `JOINT_STRENGTH_CONTRACT.version`. */
export const HORSE_PHASE13_CONTRACT_VERSION: string = JOINT_STRENGTH_CONTRACT.version;
/**
 * The qualification's and the completion record's `packVersion`: the joint
 * domain version every Phase 13 receipt carries as `version`
 * (`JOINT_LIVE_DOMAIN.version`). It moved to v4 with the P13.1 receipt shape;
 * the range and response pack versions are bound by the policy digest, which
 * hashes them.
 */
export const HORSE_PHASE13_PACK_VERSION: string = JOINT_LIVE_DOMAIN.version;
/** The nine joint variants (`JOINT_VARIANTS`, the `KNOWN_VARIANTS`), in a fixed order. */
export const HORSE_PHASE13_VARIANTS: readonly JointVariant[] = JOINT_VARIANTS;

/**
 * The running version a Phase 13 authority holder of `variant` admits. One
 * holder per variant, each bound to the joint domain and its own variant, so a
 * usable NLH authority is `mismatched` at the PLO4 gate (and at the PLO4
 * worker holder) even though the joint owner is shared.
 */
export function horsePhase13ContinuationVersion(variant: string): string {
  return `${HORSE_PHASE13_PACK_VERSION}/${variant}`;
}

/**
 * The running P13.2 contract digest. A qualification is admitted only for this
 * exact digest, so evidence made under any other contract can never select.
 */
export const PHASE13_RUNNING_CONTRACT_DIGEST: string = jointStrengthContractDigest();

/** The keys the P13.2 assembler writes into a qualification file, exactly
 * (the Phase 12 qualification's sixteen). */
export const HORSE_PHASE13_QUALIFICATION_KEYS = Object.freeze([
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

const objectOf = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The two contract sections admission reads, by the Phase 12 contract's
 * shape. Null when the contract does not carry them, which fails admission
 * closed (`evidence_mismatch`). `HorsePhase13Authority.test.ts` pins that both
 * resolve for every variant on the running contract.
 */
export function horsePhase13ContractMargin(variant: JointVariant): number | null {
  const packs = (JOINT_STRENGTH_CONTRACT as unknown as Record<string, unknown>).packs;
  const pack = objectOf(packs) ? packs[variant] : undefined;
  const margin = objectOf(pack) ? pack.regressionMargin : undefined;
  const value = objectOf(margin) ? margin.lowerBoundAtLeastBbPer100 : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function horsePhase13ContractAdmissionRequires(): readonly string[] | null {
  const live = (JOINT_STRENGTH_CONTRACT as unknown as Record<string, unknown>).liveConditions;
  const value = objectOf(live) ? live.admissionAlsoRequires : undefined;
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : null;
}

// ---------------------------------------------------------------------------
// Natural completion-share evidence
// ---------------------------------------------------------------------------

/** Schema of the committed natural completion record, one per variant. */
export const HORSE_PHASE13_COMPLETION_SCHEMA = 'horse-phase13-completion-v1';

/**
 * What a completion record counts. Bump when the counting below changes.
 *
 * Population: natural chip cash betting decisions of one variant on one
 * engine release, read from the journaled joint receipts
 * (`decision.jointPolicy`) of the receipt version `HORSE_PHASE13_PACK_VERSION`.
 * Shadow and candidate receipts run the same policy code, so a shadow release
 * whose policy digest equals the running one measures the share the candidate
 * would see. Single board, multi-board and bomb hands are all counted (the
 * joint owner decides all three); a bomb or multi-board hand has no preflop
 * decision (`bomb_hand_has_no_preflop_decision`, never eligible), so its
 * decisions count on the flop, turn and river only. Not counted: tournament
 * decisions (they never admit candidate mode), Pineapple discards (not a
 * betting street), any other variant, any receipt of another version, and a
 * receipt whose `boardCount` is not 1, 2 or 3.
 *
 * Excluded by name (v2): an eligible Diamond decision (the receipt's bound
 * objective asset is `diamonds`; only NLH reaches it). The P13.2 contract
 * excludes Diamond NLH whole-unit cash from the qualified domain and admission
 * never runs a Diamond decision as candidate (`horsePhase13AdmittedMode`), so
 * it is not part of the share the floor bounds. It is counted in the record's
 * `excluded.diamond`, never in a street or board-count cell.
 *
 * Every counted decision is tallied twice, once under its street and once
 * under its board count (`boardCount`: 1 pools ordinary hands and one-board
 * bomb hands, 2 and 3 the multi-board bomb hands), because the P13.2 contract
 * (`liveConditions.admissionAlsoRequires`) asks for the share per street and
 * per board count, the same marginal cells its board-count gating cells use.
 * Both tallies cover the same decisions, so their totals agree field by field.
 *
 * Eligible: the receipt is `eligible` (the acquisition's canonical checks
 * passed and the controller order was read). Completed: an eligible decision
 * whose proposal is the policy the P13.2 matrix measured, which ran on a fixed
 * clock with the equity governor off, every sample complete, and a proposal
 * that fired. Six live outcomes are not that policy and are counted
 * separately, so `eligible = completed + workBudget + samplerBudgetExhausted +
 * responseBranchUnavailable + sampleUnavailable + governorReduced +
 * analysisUnavailable`, each decision under the first that applies:
 *  - `workBudget`: the policy passed `JOINT_LIVE_DOMAIN.liveBudgetMs` and fell
 *    back to the baseline (reason `work_budget`);
 *  - `samplerBudgetExhausted`: the sampler's own deadline
 *    (`samplingDeadlineMs`) cut the population short (`sampleBudgetExhausted`);
 *  - `responseBranchUnavailable`: the response model's named limit refusals
 *    only (`joint_response_branch_unavailable`, a candidate needing more
 *    terminal branches than the pack allows, and
 *    `joint_response_street_unavailable` / `joint_response_street_not_modeled`,
 *    a street the pack does not price);
 *  - `sampleUnavailable`: no complete consumed population (insufficient or
 *    unavailable samples, a refused acquisition, or fewer completed samples
 *    than requested);
 *  - `governorReduced`: a complete population whose request was below the
 *    table's full count (`jointFullSamples(dealtPlayers)`: 16 up to four dealt
 *    players, 8 above) because the equity governor scaled it down under load;
 *  - `analysisUnavailable` (v2): a complete full-count population whose
 *    proposal did not fire (`fired !== true`): an analysis failure
 *    (`joint_action_conservation`, `joint_analysis_unavailable`,
 *    `joint_pots_conservation`, `joint_scores_no_winner`,
 *    `joint_action_no_legal_candidates`, `proposal_outside_legal_menu` and
 *    every other caught `joint_*` failure) or a response-model defect
 *    (`joint_response_branch_mass`, `joint_response_illegal_simulated_action`).
 *    The live wrapper executes the baseline for all of them; v1 counted them
 *    as completed (or, for the model defects, as `responseBranchUnavailable`).
 *
 * v1 to v2 (audit 2026-10-06): Diamond decisions are excluded by name instead
 * of counted in the NLH cells, `analysisUnavailable` is a seventh cell field
 * and `fired` is read, and the record carries `excluded`. A v1 record is
 * refused (`completion_evidence_mismatch`).
 */
export const HORSE_PHASE13_COMPLETION_DEFINITION = 'horse-phase13-completion-definition-v2';

/**
 * THE COMPLETION FLOOR, per street and per board count: 0.95 on the 99% lower confidence bound of
 * the completion share, never the point share. The P11.3/P12.3 floor and its
 * reasons, applied to the joint owner:
 *
 * Why a floor at all: the P13.2 matrix measured the candidate only on
 * decisions that complete. A decision that falls back executes the baseline,
 * so a hand can mix candidate and baseline streets in a line neither arm
 * played, and a truncated, reduced or response-refused proposal is not the
 * proposal that was priced.
 *
 * Why 0.95: no calibrated cost of such a mixed line exists in source, so the
 * floor bounds the unmeasured share rather than its cost: at least 19 of every
 * 20 eligible decisions on every street must be the measured policy. A stated
 * bound, not a fitted number; a different one is a reviewed code change and is
 * bound into every authority key.
 *
 * Why per street: the joint owner samples on every street and the response
 * tree runs only on the turn and river, so a pooled share would let a
 * completing preflop hide a failing river. Why per board count as well: a two
 * or three board hand prices every sample on every board, so its work is a
 * multiple of a one-board hand's, and a pooled share would let the common
 * one-board hands hide failing multi-board ones. Every cell must clear the
 * floor, including the preflop street (ordinary hands only) and the two and
 * three board counts (bomb hands only): a cell with no natural decisions has
 * no evidence and fails closed, because admission would let the candidate act
 * there.
 *
 * Why a lower bound: the Wilson score lower bound at the contract's own z
 * (`JOINT_STRENGTH_Z99`, Phi^-1(0.995)), so a cell whose true share is below
 * 0.95 passes with probability at most 0.5%, and even an all-complete cell
 * needs `HORSE_PHASE13_COMPLETION_MIN_ELIGIBLE_PER_STREET` (127) eligible
 * decisions.
 */
export const HORSE_PHASE13_COMPLETION_FLOOR = 0.95;
const COMPLETION_Z = JOINT_STRENGTH_Z99;
/** The smallest all-complete street that can pass: n / (n + z^2) >= floor. */
export const HORSE_PHASE13_COMPLETION_MIN_ELIGIBLE_PER_STREET = Math.ceil(
  (HORSE_PHASE13_COMPLETION_FLOOR * COMPLETION_Z * COMPLETION_Z) /
    (1 - HORSE_PHASE13_COMPLETION_FLOOR)
);

export const HORSE_PHASE13_COMPLETION_STREETS = Object.freeze([
  'preflop',
  'flop',
  'turn',
  'river',
] as const);
export type HorsePhase13CompletionStreet = (typeof HORSE_PHASE13_COMPLETION_STREETS)[number];
/** The board-count cells, as the record's JSON keys. */
export const HORSE_PHASE13_COMPLETION_BOARD_COUNTS = Object.freeze(['1', '2', '3'] as const);
export type HorsePhase13CompletionBoardCount =
  (typeof HORSE_PHASE13_COMPLETION_BOARD_COUNTS)[number];

export interface HorsePhase13StreetCompletion {
  readonly eligible: number;
  readonly completed: number;
  readonly workBudget: number;
  readonly samplerBudgetExhausted: number;
  readonly sampleUnavailable: number;
  readonly governorReduced: number;
  readonly responseBranchUnavailable: number;
  readonly analysisUnavailable: number;
}

/** Eligible decisions left out of every cell, by name (v2). */
export interface HorsePhase13CompletionExcluded {
  /** Diamond decisions: outside the P13.2 qualified domain. */
  readonly diamond: number;
}

/** A committed `horse-phase13-completion-v1` record (exact keys). */
export interface HorsePhase13CompletionRecord {
  readonly schema: typeof HORSE_PHASE13_COMPLETION_SCHEMA;
  readonly definition: typeof HORSE_PHASE13_COMPLETION_DEFINITION;
  readonly variant: JointVariant;
  readonly packVersion: string;
  /** Exact 40-hex engine release the natural decisions were read from. */
  readonly releaseSha: string;
  readonly policyDigestDefinition: string;
  /** `horsePhase13PolicyDigest(variant)` of that release. */
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
  readonly streets: Readonly<Record<HorsePhase13CompletionStreet, HorsePhase13StreetCompletion>>;
  /** The same decisions by board count; totals equal `streets` field by field. */
  readonly boardCounts: Readonly<
    Record<HorsePhase13CompletionBoardCount, HorsePhase13StreetCompletion>
  >;
  /** Eligible decisions excluded from both tallies, by name. */
  readonly excluded: HorsePhase13CompletionExcluded;
}

export type HorsePhase13CompletionOutcome =
  | 'not_counted'
  | 'excluded_diamond'
  | 'completed'
  | 'work_budget'
  | 'sampler_budget_exhausted'
  | 'response_branch_unavailable'
  | 'sample_unavailable'
  | 'governor_reduced'
  | 'analysis_unavailable';

const SAMPLE_REFUSALS = new Set(['insufficient_joint_samples', 'joint_samples_unavailable']);
/** The response model's named limit refusals: the pack's own work limits,
 * not a defect. Every other non-firing reason is `analysis_unavailable`. */
const RESPONSE_LIMIT_REFUSALS = new Set([
  'joint_response_branch_unavailable',
  'joint_response_street_unavailable',
  'joint_response_street_not_modeled',
]);

/** The objective asset an eligible receipt's input binding recorded, if any. */
function boundAsset(receipt: Record<string, unknown>): unknown {
  const inputs = receipt.inputs;
  const objective = objectOf(inputs) ? inputs.objective : undefined;
  return objectOf(objective) ? objective.asset : undefined;
}

/**
 * How one journaled joint receipt counts toward a variant's completion record
 * (`HORSE_PHASE13_COMPLETION_DEFINITION`). Pure; reads only the receipt.
 */
export function horsePhase13CompletionOutcome(
  variant: JointVariant,
  receipt: unknown
): HorsePhase13CompletionOutcome {
  if (
    !isJointVariant(variant) ||
    !objectOf(receipt) ||
    receipt.variant !== variant ||
    receipt.version !== HORSE_PHASE13_PACK_VERSION ||
    receipt.eligible !== true ||
    receipt.utilityOwner !== 'cash' ||
    !(HORSE_PHASE13_COMPLETION_STREETS as readonly unknown[]).includes(receipt.street) ||
    !Number.isSafeInteger(receipt.boardCount) ||
    !(HORSE_PHASE13_COMPLETION_BOARD_COUNTS as readonly string[]).includes(
      String(receipt.boardCount)
    )
  )
    return 'not_counted';
  // Outside the qualified domain whatever happened to it.
  if (boundAsset(receipt) === 'diamonds') return 'excluded_diamond';
  if (receipt.reason === 'work_budget') return 'work_budget';
  if (receipt.sampleBudgetExhausted === true) return 'sampler_budget_exhausted';
  if (RESPONSE_LIMIT_REFUSALS.has(receipt.reason as string)) return 'response_branch_unavailable';
  const inputs = receipt.inputs;
  const ranges = objectOf(inputs) ? inputs.ranges : undefined;
  if (
    SAMPLE_REFUSALS.has(receipt.reason as string) ||
    !objectOf(ranges) ||
    ranges.status !== 'consumed' ||
    receipt.sampleBudgetExhausted !== false ||
    !Number.isSafeInteger(receipt.dealtPlayers) ||
    !Number.isSafeInteger(receipt.requestedSamples) ||
    receipt.completedSamples !== receipt.requestedSamples
  )
    return 'sample_unavailable';
  if ((receipt.requestedSamples as number) < jointFullSamples(receipt.dealtPlayers as number))
    return 'governor_reduced';
  // A complete population whose proposal did not fire executed the baseline:
  // an analysis failure or a response-model defect, never the measured policy.
  if (receipt.fired !== true) return 'analysis_unavailable';
  return 'completed';
}

type StreetField = Exclude<keyof HorsePhase13StreetCompletion, 'eligible'>;
const OUTCOME_FIELD: Record<
  Exclude<HorsePhase13CompletionOutcome, 'not_counted' | 'excluded_diamond'>,
  StreetField
> = {
  completed: 'completed',
  work_budget: 'workBudget',
  sampler_budget_exhausted: 'samplerBudgetExhausted',
  response_branch_unavailable: 'responseBranchUnavailable',
  sample_unavailable: 'sampleUnavailable',
  governor_reduced: 'governorReduced',
  analysis_unavailable: 'analysisUnavailable',
};

function tally<K extends string>(
  variant: JointVariant,
  receipts: Iterable<unknown>,
  cells: readonly K[],
  cellOf: (receipt: Record<string, unknown>) => K
): Record<K, HorsePhase13StreetCompletion> {
  type Mutable = { -readonly [F in keyof HorsePhase13StreetCompletion]: number };
  const counts = Object.fromEntries(
    cells.map((cell) => [
      cell,
      {
        eligible: 0,
        completed: 0,
        workBudget: 0,
        samplerBudgetExhausted: 0,
        sampleUnavailable: 0,
        governorReduced: 0,
        responseBranchUnavailable: 0,
        analysisUnavailable: 0,
      },
    ])
  ) as Record<K, Mutable>;
  for (const receipt of receipts) {
    const outcome = horsePhase13CompletionOutcome(variant, receipt);
    if (outcome === 'not_counted' || outcome === 'excluded_diamond') continue;
    const cell = counts[cellOf(receipt as Record<string, unknown>)];
    cell.eligible += 1;
    cell[OUTCOME_FIELD[outcome]] += 1;
  }
  return counts;
}

/** Per-street counts over journaled receipts, in the record's exact shape. */
export function horsePhase13CompletionCounts(
  variant: JointVariant,
  receipts: Iterable<unknown>
): Record<HorsePhase13CompletionStreet, HorsePhase13StreetCompletion> {
  return tally(
    variant,
    receipts,
    HORSE_PHASE13_COMPLETION_STREETS,
    (r) => r.street as HorsePhase13CompletionStreet
  );
}

/** Per-board-count counts over the same receipts, in the record's exact shape. */
export function horsePhase13CompletionBoardCounts(
  variant: JointVariant,
  receipts: Iterable<unknown>
): Record<HorsePhase13CompletionBoardCount, HorsePhase13StreetCompletion> {
  return tally(
    variant,
    receipts,
    HORSE_PHASE13_COMPLETION_BOARD_COUNTS,
    (r) => String(r.boardCount) as HorsePhase13CompletionBoardCount
  );
}

/** The eligible decisions over the same receipts that no cell counts, by name. */
export function horsePhase13CompletionExclusions(
  variant: JointVariant,
  receipts: Iterable<unknown>
): HorsePhase13CompletionExcluded {
  let diamond = 0;
  for (const receipt of receipts)
    if (horsePhase13CompletionOutcome(variant, receipt) === 'excluded_diamond') diamond += 1;
  return { diamond };
}

/** The Wilson score lower bound of `completed / eligible` at the contract z
 * (only `completed` is the measured policy; every other field is not). */
export function horsePhase13CompletionLowerBound(completed: number, eligible: number): number {
  if (!(eligible > 0)) return 0;
  const n = eligible;
  const p = completed / n;
  const z2 = COMPLETION_Z * COMPLETION_Z;
  const centre = p + z2 / (2 * n);
  const spread = COMPLETION_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - spread) / (1 + z2 / n));
}

/** Does every cell given (a record's `streets`, or its `boardCounts`) clear the floor? */
export function horsePhase13CompletionMeetsFloor(
  cells: Readonly<Record<string, HorsePhase13StreetCompletion>>
): boolean {
  const values = Object.values(cells);
  return (
    values.length > 0 &&
    values.every(
      (cell) =>
        horsePhase13CompletionLowerBound(cell.completed, cell.eligible) >=
        HORSE_PHASE13_COMPLETION_FLOOR
    )
  );
}

/** Do both of a record's tallies clear the floor in every cell? */
export function horsePhase13CompletionRecordMeetsFloor(
  record: Pick<HorsePhase13CompletionRecord, 'streets' | 'boardCounts'>
): boolean {
  return (
    horsePhase13CompletionMeetsFloor(record.streets) &&
    horsePhase13CompletionMeetsFloor(record.boardCounts)
  );
}

// ---------------------------------------------------------------------------
// The protected release selections
// ---------------------------------------------------------------------------

/** Committed at a protected release. Never constructed from runtime input. */
export interface HorsePhase13AuthoritySelection {
  readonly schema: 'horse-qualified-authority-selection-v1';
  readonly phase: 'phase13';
  readonly variant: JointVariant;
  /** Exact 40-hex source revision the P13.2 matrix ran at (`sourceSha`). */
  readonly sourceSha: string;
  readonly packVersion: string;
  readonly contractVersion: string;
  /** The P13.2 contract digest the qualification must carry. */
  readonly contractDigest: string;
  readonly domain: string;
  /** Repository-relative path of the qualification file under docs/evidence/phase13/. */
  readonly qualificationPath: string;
  readonly qualificationSha256: string;
  /** Repository-relative path of the `horse-phase13-completion-v1` record
   * under docs/evidence/phase13/; null is refused as completion_evidence_missing. */
  readonly completionPath: string | null;
  readonly completionSha256: string | null;
  /** Positive, strictly increasing across renewals; a withdrawn generation never returns. */
  readonly approvalGeneration: number;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly withdrawn: Readonly<{ at: string; reason: string }> | null;
}

/**
 * THE PROTECTED RELEASE SELECTIONS, one per joint variant. All null: no
 * qualified Phase 13 authority exists, so every live joint decision stays in
 * shadow, as before P13.3. P13.2 has not run any variant's held-out matrix and
 * no qualification or completion record exists. Selecting a variant requires
 * its qualification file, the strength record it names and its natural
 * completion record committed under docs/evidence/phase13/ and shipped in the
 * engine image, their sha256 here, and the protected merge and engine release
 * of that change.
 */
export const PHASE13_PROTECTED_RELEASE_SELECTIONS: Readonly<
  Record<JointVariant, HorsePhase13AuthoritySelection | null>
> = Object.freeze({
  nlh: null,
  plo4: null,
  plo5: null,
  plo6: null,
  plo8: null,
  flo8: null,
  flh: null,
  pineapple: null,
  short_deck: null,
});

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function evidencePathIsSafe(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith(HORSE_PHASE13_EVIDENCE_DIRECTORY) &&
    path.endsWith('.json') &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..')
  );
}

function selectionIsWellFormed(s: HorsePhase13AuthoritySelection): boolean {
  return (
    s.schema === 'horse-qualified-authority-selection-v1' &&
    s.phase === 'phase13' &&
    isJointVariant(s.variant) &&
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
  'boardCounts',
  'excluded',
] as const;
export const HORSE_PHASE13_COMPLETION_STREET_KEYS = Object.freeze([
  'eligible',
  'completed',
  'workBudget',
  'samplerBudgetExhausted',
  'sampleUnavailable',
  'governorReduced',
  'responseBranchUnavailable',
  'analysisUnavailable',
] as const);
/** The named exclusions a record carries (v2). */
export const HORSE_PHASE13_COMPLETION_EXCLUDED_KEYS = Object.freeze(['diamond'] as const);

/** Schema, shape and internal consistency of a completion record. */
function completionIsWellFormed(value: unknown): value is HorsePhase13CompletionRecord {
  if (
    !exactKeys(value, COMPLETION_KEYS) ||
    value.schema !== HORSE_PHASE13_COMPLETION_SCHEMA ||
    value.definition !== HORSE_PHASE13_COMPLETION_DEFINITION ||
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
    !exactKeys(value.streets, HORSE_PHASE13_COMPLETION_STREETS) ||
    !exactKeys(value.boardCounts, HORSE_PHASE13_COMPLETION_BOARD_COUNTS) ||
    !exactKeys(value.excluded, HORSE_PHASE13_COMPLETION_EXCLUDED_KEYS) ||
    !HORSE_PHASE13_COMPLETION_EXCLUDED_KEYS.every((key) =>
      count((value.excluded as Record<string, unknown>)[key])
    )
  )
    return false;
  const cellIsWellFormed = (s: unknown): s is Record<string, number> =>
    exactKeys(s, HORSE_PHASE13_COMPLETION_STREET_KEYS) &&
    HORSE_PHASE13_COMPLETION_STREET_KEYS.every((key) => count(s[key])) &&
    (s.completed as number) +
      (s.workBudget as number) +
      (s.samplerBudgetExhausted as number) +
      (s.sampleUnavailable as number) +
      (s.governorReduced as number) +
      (s.responseBranchUnavailable as number) +
      (s.analysisUnavailable as number) ===
      s.eligible;
  const byStreet = value.streets;
  const byBoards = value.boardCounts;
  const streets: unknown[] = HORSE_PHASE13_COMPLETION_STREETS.map((k) => byStreet[k]);
  const boards: unknown[] = HORSE_PHASE13_COMPLETION_BOARD_COUNTS.map((k) => byBoards[k]);
  if (!streets.every(cellIsWellFormed) || !boards.every(cellIsWellFormed)) return false;
  // The two tallies count the same decisions, field by field.
  const total = (cells: unknown[], key: string) =>
    (cells as Record<string, number>[]).reduce((sum, cell) => sum + cell[key], 0);
  return HORSE_PHASE13_COMPLETION_STREET_KEYS.every(
    (key) => total(streets, key) === total(boards, key)
  );
}

/**
 * Admit one variant's committed Phase 13 selection against its P13.2
 * qualification file and its natural completion record. Pure apart from the
 * injected read. The Phase 12 refusal order, every refusal named:
 * `unselected` (before any file or policy-source read), `invalid_selection`,
 * (a committed withdrawal is `withdrawn`), `continuation_mismatch` (the
 * selection's variant, pack version or domain is not the running variant's),
 * `contract_unavailable`, `contract_digest_mismatch`,
 * `policy_digest_unavailable`, `expired`, `missing_evidence`,
 * `unreadable_evidence` (transient), `hash_mismatch`, `evidence_mismatch` (not
 * JSON, another schema, not exactly the sixteen keys, or a malformed
 * objectives section), `not_qualified`, `contract_digest_mismatch`,
 * `policy_digest_mismatch`, `source_mismatch`, `continuation_mismatch` (the
 * file's variant, pack or domain), `evidence_mismatch` (contract version, a
 * cash margin other than the contract's, a tournament objective claimed
 * qualified, an admission requirement other than the contract's, evidence path
 * or hash), the strength record's `missing_evidence` or `hash_mismatch`; then
 * the completion record: `completion_evidence_missing`, `unreadable_evidence`
 * (transient), `completion_hash_mismatch`, `completion_evidence_mismatch`,
 * `completion_release_mismatch`, `completion_window_invalid`,
 * `completion_below_floor` (any street or any board count below the floor).
 *
 * `runningPolicyDigest` defaults to `horsePhase13PolicyDigest(variant)`,
 * recomputed from the running code and read only once a well-formed,
 * unwithdrawn selection of the running variant reaches that check.
 */
export function admitHorsePhase13QualifiedAuthority(
  variant: JointVariant,
  selection: HorsePhase13AuthoritySelection | null,
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
  if (!isJointVariant(variant) || !selectionIsWellFormed(selection))
    return refuse('invalid_selection');
  if (selection.withdrawn !== null)
    return {
      status: 'withdrawn',
      approvalGeneration: selection.approvalGeneration,
      reason: `release_${selection.withdrawn.reason}`,
    };
  const packVersion = HORSE_PHASE13_PACK_VERSION;
  const domain = jointStrengthDomain(variant);
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
    runningPolicyDigest === undefined ? horsePhase13PolicyDigest(variant) : runningPolicyDigest;
  if (policyDigest === null || !HEX64.test(policyDigest))
    return refuse('policy_digest_unavailable');
  if (selection.expiresAt !== null && nowMs >= (isoMs(selection.expiresAt) ?? -Infinity))
    return refuse('expired');

  // The P13.2 qualification file.
  const qualification = read(reader, selection.qualificationPath);
  if (!qualification.ok)
    return qualification.missing ? refuse('missing_evidence') : refuse('unreadable_evidence', true);
  if (sha256(qualification.bytes) !== selection.qualificationSha256) return refuse('hash_mismatch');
  const file = parseObject(qualification.bytes);
  if (
    !file ||
    file.schema !== HORSE_PHASE13_QUALIFICATION_SCHEMA ||
    !exactKeys(file, HORSE_PHASE13_QUALIFICATION_KEYS) ||
    !exactKeys(file.objectives, ['cash', 'tournament']) ||
    !exactKeys(file.objectives.cash, CASH_OBJECTIVE_KEYS) ||
    !objectOf(file.objectives.tournament) ||
    !Array.isArray(file.reasons)
  )
    return refuse('evidence_mismatch');
  const cash = file.objectives.cash;
  const tournament = file.objectives.tournament;
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
  // The evidence must have measured the joint owner as it is running now.
  if (
    file.policyDigestDefinition !== HORSE_PHASE13_POLICY_DIGEST_DEFINITION ||
    file.policyDigest !== policyDigest
  )
    return refuse('policy_digest_mismatch');
  if (file.sourceSha !== selection.sourceSha) return refuse('source_mismatch');
  if (file.variant !== variant || file.packVersion !== packVersion || file.domain !== domain)
    return refuse('continuation_mismatch');
  const margin = horsePhase13ContractMargin(variant);
  const requires = horsePhase13ContractAdmissionRequires();
  if (
    file.contractVersion !== HORSE_PHASE13_CONTRACT_VERSION ||
    file.contractVersion !== selection.contractVersion ||
    margin === null ||
    cash.regressionMarginBbPer100 !== margin ||
    tournament.qualified !== false ||
    requires === null ||
    JSON.stringify(file.admissionAlsoRequires) !== JSON.stringify(requires) ||
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

  // The natural completion record.
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
    record.policyDigestDefinition !== HORSE_PHASE13_POLICY_DIGEST_DEFINITION ||
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
  if (!horsePhase13CompletionRecordMeetsFloor(record)) return refuse('completion_below_floor');

  const continuationVersion = horsePhase13ContinuationVersion(variant);
  const identity = {
    schema: 'horse-qualified-authority-v1' as const,
    phase: 'phase13' as const,
    variant,
    sourceSha: selection.sourceSha,
    continuationVersion,
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
            completionDefinition: HORSE_PHASE13_COMPLETION_DEFINITION,
            completionFloor: HORSE_PHASE13_COMPLETION_FLOOR,
          })
        )
      ),
    }) as HorseQualifiedAuthority,
  };
}

/** Admit one variant's committed release selection from the repository/image files. */
export function admitHorsePhase13ReleaseAuthority(
  variant: JointVariant,
  nowMs = Date.now(),
  selection: HorsePhase13AuthoritySelection | null = isJointVariant(variant)
    ? PHASE13_PROTECTED_RELEASE_SELECTIONS[variant]
    : null,
  reader: HorseAuthorityEvidenceReader = repositoryEvidenceReader,
  runningContractDigest: string | null = PHASE13_RUNNING_CONTRACT_DIGEST,
  runningPolicyDigest?: string | null
): HorseAuthorityAdmission {
  try {
    return admitHorsePhase13QualifiedAuthority(
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

/** The admitted Phase 13 authority for `variant`, or null. */
export function selectedHorsePhase13Authority(
  variant: JointVariant,
  admission: HorseAuthorityAdmission
): HorseQualifiedAuthority | null {
  return admission.status === 'admitted' &&
    admission.authority.phase === 'phase13' &&
    admission.authority.variant === variant &&
    isJointVariant(variant) &&
    admission.authority.continuationVersion === horsePhase13ContinuationVersion(variant)
    ? admission.authority
    : null;
}

/**
 * Worker-owned Phase 13 mode. The caller may only turn the joint owner off.
 * Candidate mode comes only from usable worker authority for the decision's
 * own variant (`packVariant`, the holder the verdict came from, must be the
 * decision's variant), and only for a cash decision. Unselected, refused,
 * withdrawn or any other verdict is shadow; a tournament decision stays shadow
 * whatever the authority says, so the Phase 7 owner keeps every tournament
 * objective decision.
 *
 * Chip cash only (audit 2026-10-06): the P13.2 contract excludes Diamond NLH
 * whole-unit cash from every qualified domain, so a decision whose asset is
 * anything but chips (absent means chips, as the input binding reads it) stays
 * shadow under any authority, and the completion record never counts it.
 */
export function horsePhase13AdmittedMode(input: {
  callerMode: JointPolicyMode | undefined;
  gameMode: unknown;
  variant: unknown;
  /** The decision's `gameState.asset`; undefined or null is chips. */
  asset: unknown;
  packVariant: JointVariant | null;
  verdict: HorseAuthorityVerdict;
}): JointPolicyMode {
  if (input.callerMode === 'off') return 'off';
  if (
    input.gameMode !== 'cash' ||
    (input.asset ?? 'chips') !== 'chips' ||
    !isJointVariant(input.variant) ||
    input.packVariant !== input.variant
  )
    return 'shadow';
  return input.verdict === 'usable' ? 'candidate' : 'shadow';
}

/**
 * Main-thread Phase 13 gates for this engine process: Phase 8's gate class,
 * one per variant, each with that variant's admission and running
 * continuation, so a withdrawal, refresh failure or restart of one variant
 * never touches another.
 */
export const liveHorsePhase13Authorities: Readonly<Record<JointVariant, HorsePhase8AuthorityGate>> =
  Object.freeze(
    Object.fromEntries(
      HORSE_PHASE13_VARIANTS.map((variant) => [
        variant,
        new HorsePhase8AuthorityGate(
          () => admitHorsePhase13ReleaseAuthority(variant),
          undefined,
          horsePhase13ContinuationVersion(variant)
        ),
      ])
    ) as Record<JointVariant, HorsePhase8AuthorityGate>
  );

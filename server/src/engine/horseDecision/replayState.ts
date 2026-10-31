/**
 * P15-A step 4: the worker-owned state a FAST decision reads that is in
 * neither its request nor its read frame.
 *
 * The request carries the canonical state, the decision clock
 * (`decisionTimeMs`) and the decision key the RNG seed is derived from; the
 * read frame carries the opponent reads and the prior plan state of the hand;
 * the journal body carries the governor scale and the solver store identity.
 * What remained was owned by the worker and read as a current global:
 *
 *   - the optional policy owners the worker admitted for this decision
 *     (Phase 8 postflop, Phase 10 PLO4, Phase 11 Omaha, Phase 12 remaining
 *     variants, Phase 13 joint), which depend on the worker's authority
 *     state and its wall clock at admission;
 *   - the worker's Phase 8 safety sentinel, which HorseLogic reads directly
 *     and which changes over the worker's lifetime;
 *   - the JavaScript runtime that computed it (Node and V8 version, CPU
 *     architecture): Math library results may differ in the last bit between
 *     V8 versions and between architectures, and the decision receipt carries
 *     floating-point values (v2; a v1 state does not name its runtime).
 *
 * Capturing them grows the journal record only. Nothing here is read by the
 * live decision; a replay that cannot establish the same state refuses by
 * name instead of substituting its own.
 */
import { correctiveKernelEvaluatorIdentity } from '../../services/horseCorrectiveReview/liveKernel.js';
import {
  correctiveDecisionDomain,
  correctiveDomainKey,
  CORRECTIVE_DOMAIN_KEYS,
} from '../../services/horseCorrectiveReview/domain.js';
export const HORSE_DECISION_REPLAY_STATE_VERSION = 'horse-decision-replay-state-v3';
export const HORSE_DECISION_REPLAY_STATE_V2 = 'horse-decision-replay-state-v2';
export interface HorseCorrectiveReplayState {
  mode: 'off' | 'shadow' | 'candidate';
  domain: string | null;
  catalogDigest: string | null;
}
export function horseCorrectiveReplayState(
  gameState: Parameters<typeof correctiveDecisionDomain>[0],
  callerMode: unknown,
  evaluator: unknown
): HorseCorrectiveReplayState {
  const domain = correctiveDecisionDomain(gameState),
    identity = correctiveKernelEvaluatorIdentity(evaluator);
  return {
    mode: callerMode === 'off' ? 'off' : identity ? 'candidate' : 'shadow',
    domain: domain ? correctiveDomainKey(domain) : null,
    catalogDigest: identity?.catalogDigest ?? null,
  };
}
function validCorrective(value: unknown): value is HorseCorrectiveReplayState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).sort().join(',') === 'catalogDigest,domain,mode' &&
    ['off', 'shadow', 'candidate'].includes(String(v.mode)) &&
    (v.domain === null ||
      (typeof v.domain === 'string' && CORRECTIVE_DOMAIN_KEYS.includes(v.domain))) &&
    (v.mode === 'candidate'
      ? typeof v.domain === 'string' &&
        typeof v.catalogDigest === 'string' &&
        /^[a-f0-9]{64}$/.test(v.catalogDigest)
      : v.catalogDigest === null)
  );
}
/** Journaled by release 71ab03df through 30ef59ad: no runtime identity. */
export const HORSE_DECISION_REPLAY_STATE_V1 = 'horse-decision-replay-state-v1';

export type HorseOptionalOwnerMode = 'off' | 'shadow' | 'candidate';

/** The decide options that name an optional policy owner, in a fixed order. */
export const HORSE_OPTIONAL_OWNER_OPTIONS = [
  'phase8Postflop',
  'phase10Plo4',
  'phase11Omaha',
  'phase12Remaining',
  'phase13Joint',
] as const;
export type HorseOptionalOwnerOption = (typeof HORSE_OPTIONAL_OWNER_OPTIONS)[number];
export type HorseDecisionReplayAdmission = Record<
  HorseOptionalOwnerOption,
  HorseOptionalOwnerMode
> & { phase8CatastropheGuard?: HorseOptionalOwnerMode };

/** The JavaScript runtime a decision ran on. */
export interface HorseDecisionRuntimeIdentity {
  node: string;
  v8: string;
  arch: string;
}

export interface HorseDecisionReplayState {
  version: typeof HORSE_DECISION_REPLAY_STATE_VERSION | typeof HORSE_DECISION_REPLAY_STATE_V2;
  /** Absent only on retained v2 records. */
  corrective?: HorseCorrectiveReplayState;
  admission: HorseDecisionReplayAdmission;
  phase8SafetyDisabledReason: string | null;
  runtime: HorseDecisionRuntimeIdentity;
}

/** This process's runtime identity. */
export function currentHorseDecisionRuntime(): HorseDecisionRuntimeIdentity {
  return { node: process.version, v8: process.versions.v8, arch: process.arch };
}

export function sameHorseDecisionRuntime(
  a: HorseDecisionRuntimeIdentity,
  b: HorseDecisionRuntimeIdentity
): boolean {
  return a.node === b.node && a.v8 === b.v8 && a.arch === b.arch;
}

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
function isRuntime(value: unknown): value is HorseDecisionRuntimeIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 3 && text(v.node) && text(v.v8) && text(v.arch);
}

const MODES = new Set<unknown>(['off', 'shadow', 'candidate']);

/** The admitted modes, read from the options the worker passed to decide. */
export function horseDecisionReplayAdmission(
  opts:
    | Partial<Record<HorseOptionalOwnerOption | 'phase8CatastropheGuard', unknown>>
    | null
    | undefined
): HorseDecisionReplayAdmission | null {
  const out = {} as HorseDecisionReplayAdmission;
  for (const key of HORSE_OPTIONAL_OWNER_OPTIONS) {
    const mode = opts?.[key];
    if (!MODES.has(mode)) return null;
    out[key] = mode as HorseOptionalOwnerMode;
  }
  if (opts && Object.hasOwn(opts, 'phase8CatastropheGuard')) {
    if (!MODES.has(opts.phase8CatastropheGuard)) return null;
    out.phase8CatastropheGuard = opts.phase8CatastropheGuard as HorseOptionalOwnerMode;
  }
  return out;
}

export function horseDecisionReplayState(
  admission: HorseDecisionReplayAdmission,
  phase8SafetyDisabledReason: string | null,
  runtime: HorseDecisionRuntimeIdentity = currentHorseDecisionRuntime(),
  corrective: HorseCorrectiveReplayState = { mode: 'shadow', domain: null, catalogDigest: null }
): HorseDecisionReplayState {
  return {
    version: HORSE_DECISION_REPLAY_STATE_VERSION,
    admission: { ...admission },
    corrective: { ...corrective },
    phase8SafetyDisabledReason,
    runtime: { node: runtime.node, v8: runtime.v8, arch: runtime.arch },
  };
}

/** A complete v1 state: every worker-owned input except the runtime identity. */
export function isHorseDecisionReplayStateV1(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 3 &&
    v.version === HORSE_DECISION_REPLAY_STATE_V1 &&
    validStateFields(v)
  );
}

export function isHorseDecisionReplayState(value: unknown): value is HorseDecisionReplayState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    ((Object.keys(v).length === 4 && v.version === HORSE_DECISION_REPLAY_STATE_V2) ||
      (Object.keys(v).length === 5 &&
        v.version === HORSE_DECISION_REPLAY_STATE_VERSION &&
        validCorrective(v.corrective))) &&
    isRuntime(v.runtime) &&
    validStateFields(v)
  );
}

function validStateFields(v: Record<string, unknown>): boolean {
  if (!(v.phase8SafetyDisabledReason === null || typeof v.phase8SafetyDisabledReason === 'string'))
    return false;
  const admission = v.admission as Record<string, unknown> | null;
  return (
    !!admission &&
    typeof admission === 'object' &&
    !Array.isArray(admission) &&
    Object.keys(admission).every(
      (key) =>
        (HORSE_OPTIONAL_OWNER_OPTIONS as readonly string[]).includes(key) ||
        key === 'phase8CatastropheGuard'
    ) &&
    Object.keys(admission).length ===
      HORSE_OPTIONAL_OWNER_OPTIONS.length +
        Number(Object.hasOwn(admission, 'phase8CatastropheGuard')) &&
    horseDecisionReplayAdmission(admission) !== null
  );
}

/** Exact modes and own-key presence; legacy absence is not a guard-off claim. */
export function horseDecisionReplayAdmissionMismatch(
  actual: HorseDecisionReplayAdmission | null,
  expected: HorseDecisionReplayAdmission
): HorseOptionalOwnerOption | 'phase8CatastropheGuard' | null {
  for (const key of HORSE_OPTIONAL_OWNER_OPTIONS) if (actual?.[key] !== expected[key]) return key;
  if (
    !actual ||
    Object.hasOwn(actual, 'phase8CatastropheGuard') !==
      Object.hasOwn(expected, 'phase8CatastropheGuard') ||
    actual.phase8CatastropheGuard !== expected.phase8CatastropheGuard
  )
    return 'phase8CatastropheGuard';
  return null;
}

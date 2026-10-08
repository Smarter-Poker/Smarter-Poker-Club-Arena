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
export const HORSE_DECISION_REPLAY_STATE_VERSION = 'horse-decision-replay-state-v2';
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
export type HorseDecisionReplayAdmission = Record<HorseOptionalOwnerOption, HorseOptionalOwnerMode>;

/** The JavaScript runtime a decision ran on. */
export interface HorseDecisionRuntimeIdentity {
  node: string;
  v8: string;
  arch: string;
}

export interface HorseDecisionReplayState {
  version: typeof HORSE_DECISION_REPLAY_STATE_VERSION;
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
  opts: Partial<Record<HorseOptionalOwnerOption, unknown>> | null | undefined
): HorseDecisionReplayAdmission | null {
  const out = {} as HorseDecisionReplayAdmission;
  for (const key of HORSE_OPTIONAL_OWNER_OPTIONS) {
    const mode = opts?.[key];
    if (!MODES.has(mode)) return null;
    out[key] = mode as HorseOptionalOwnerMode;
  }
  return out;
}

export function horseDecisionReplayState(
  admission: HorseDecisionReplayAdmission,
  phase8SafetyDisabledReason: string | null,
  runtime: HorseDecisionRuntimeIdentity = currentHorseDecisionRuntime()
): HorseDecisionReplayState {
  return {
    version: HORSE_DECISION_REPLAY_STATE_VERSION,
    admission: { ...admission },
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
    Object.keys(v).length === 4 &&
    v.version === HORSE_DECISION_REPLAY_STATE_VERSION &&
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
    Object.keys(admission).length === HORSE_OPTIONAL_OWNER_OPTIONS.length &&
    horseDecisionReplayAdmission(admission) !== null
  );
}

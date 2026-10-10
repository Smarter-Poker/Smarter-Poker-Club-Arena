/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LIGHTNING WORKER CONFIGURATION (Lightning 2.0, shadow-mode worker, 2026-09-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The matcher lives in SQL ("the SQL is the brain", as for the Cluster
 * controller). This process is the clock and the presence feed. Every value
 * the worker runs on comes from `fn_lightning_config(p_cluster_id)` and is
 * parsed HERE, into one typed object with safe defaults and hard bounds, so
 * no other file in `src/lightning/` carries a number of its own.
 *
 * FAIL CLOSED. A config that cannot be read, is missing a key, or names a
 * worker mode this code does not know is treated as `off`: a worker that is
 * not sure it may run does not run. A number outside its bounds is clamped,
 * never trusted - a pass interval of 0 from a typo must not become a hot loop
 * of RPCs against a database with a CPU budget.
 */
import {
  LIGHTNING_SHADOW_DEFAULT_VERSION,
  lightningMatcherParams,
  type LightningMatcherParams,
} from './LightningMatcherModel.js';

/** What a Cluster's worker is allowed to do. */
export type LightningWorkerMode = 'off' | 'shadow' | 'form';

export const LIGHTNING_WORKER_MODES: readonly LightningWorkerMode[] = ['off', 'shadow', 'form'];

export interface LightningConfig {
  /**
   * The matcher version the SQL should run. NULL when the config did not
   * name one: the worker then passes NULL and the SQL chooses (see the
   * contract note on `fn_lightning_match` in LightningRpc.ts).
   */
  matcherVersion: string | null;
  workerMode: LightningWorkerMode;
  /** Time between the END of one worker pass and the start of the next. */
  passIntervalMs: number;
  /**
   * The longest a running worker may go without saying so. In shadow mode
   * it bounds the gap between diagnosis summary log lines: a quiet worker
   * still proves it is alive at least this often.
   */
  keepaliveIntervalMs: number;
  /** p_max_hands for one forming pass (`admission_batch_hands`). */
  maxHandsPerPass: number;
  /** The deal window a host asks begin_dealing for (`deal_window_ms`). */
  dealWindowMs: number;
  /**
   * LIGHTNING PHASE 10: the auto-rebuy keys, parsed beside the worker's own.
   * The database validates and moves every chip (fn_lightning_auto_rebuy);
   * the engine reads only enough to know WHO to ask at a hand boundary.
   */
  autoRebuy: LightningAutoRebuyConfig;
  /**
   * LIGHTNING PHASE 11: the shadow matcher and the integrity telemetry.
   * Absent (an older caller, a test) is off: nothing is computed or sent.
   */
  shadow?: LightningShadowConfig;
  /**
   * LIGHTNING PHASE 12: the action-latency ledger (fn_lightning_latency_report).
   * Absent (an older caller, a test) is off: nothing is aggregated or sent.
   */
  latency?: LightningLatencyConfig;
  /**
   * LIGHTNING PHASE 13: the operator's rollout controls (joins, drain bound,
   * matcher versions, the fold flags). Absent (an older caller, a test, a
   * database without the keys) is today's behaviour: joins open, both folds
   * offered, no version disabled.
   */
  rollout?: LightningRolloutConfig;
}

/**
 * LIGHTNING PHASE 13 (spec OPERATOR CONTROLS, FEATURE FLAGS, VERSIONING). The
 * keys fn_lightning_config's third object reports, read so that a missing key
 * is exactly today's behaviour. Only a JSON boolean false closes a door that
 * is open today; an unreadable value is the default, never a refusal.
 */
export interface LightningRolloutConfig {
  /** `lightning_joins_enabled`: newcomers may enter the pool (seated players always play on). */
  joinsEnabled: boolean;
  /** `drain_timeout_ms`: how long an operator drain waits before abandoning never-dealt instances. */
  drainTimeoutMs: number;
  /** `matcher_version_previous`: where a rollback goes. */
  matcherVersionPrevious: string;
  /** `matcher_versions_disabled`: versions neither the live pass nor the shadow may run. */
  matcherVersionsDisabled: string[];
  /** `lightning_fast_fold`: LIGHTNING FOLD is offered and accepted. */
  fastFold: boolean;
  /** `lightning_fold_watch`: FOLD & WATCH is offered and accepted. */
  foldWatch: boolean;
  /**
   * The Cluster is paused by its operator (`paused` / `cluster_paused` in the
   * config, or the `paused` cluster_mode the supervisor reads itself): no
   * new hand forms, every hand in the air plays on and settles.
   */
  paused: boolean;
}

/** The live matcher every version falls back to (the one the SQL always implements). */
export const LIGHTNING_MATCHER_FALLBACK_VERSION = 'm1';
export const LIGHTNING_DRAIN_TIMEOUT_DEFAULT_MS = 120_000;
export const LIGHTNING_DRAIN_TIMEOUT_MIN_MS = 10_000;
export const LIGHTNING_DRAIN_TIMEOUT_MAX_MS = 3_600_000;

/** Today's behaviour: what a Cluster gets when none of the Phase 13 keys is present. */
export const LIGHTNING_ROLLOUT_DEFAULTS: Readonly<LightningRolloutConfig> = Object.freeze({
  joinsEnabled: true,
  drainTimeoutMs: LIGHTNING_DRAIN_TIMEOUT_DEFAULT_MS,
  matcherVersionPrevious: LIGHTNING_MATCHER_FALLBACK_VERSION,
  matcherVersionsDisabled: [] as string[],
  fastFold: true,
  foldWatch: true,
  paused: false,
});

function versionList(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' && raw.trim().startsWith('{')
      ? // a Postgres text[] literal, should one ever arrive unconverted
        raw.trim().slice(1, -1).split(',')
      : [];
  const out = new Set<string>();
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const s = v.trim().replace(/^"|"$/g, '');
    if (s !== '' && s.length <= 64) out.add(s);
  }
  return [...out].sort();
}

/**
 * A feature flag, read from the config's top level or its `flags` object
 * (fn_lightning_operator_cluster_row reports them there). Only false closes.
 */
function flagOpen(row: Record<string, unknown>, key: string): boolean {
  const flags =
    row.flags && typeof row.flags === 'object' && !Array.isArray(row.flags)
      ? (row.flags as Record<string, unknown>)
      : {};
  const v = key in row ? row[key] : flags[key];
  return v !== false && v !== 'false' && v !== 'off';
}

/** Parse the Phase 13 keys. Never throws; anything unreadable is today's behaviour. */
export function parseLightningRolloutConfig(raw: unknown): LightningRolloutConfig {
  const row =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const previous =
    typeof row.matcher_version_previous === 'string' && row.matcher_version_previous.trim() !== ''
      ? row.matcher_version_previous.trim()
      : LIGHTNING_MATCHER_FALLBACK_VERSION;
  const paused = row.paused === true || row.cluster_paused === true;
  return {
    joinsEnabled: flagOpen(row, 'lightning_joins_enabled'),
    drainTimeoutMs: readInteger(
      row.drain_timeout_ms,
      LIGHTNING_DRAIN_TIMEOUT_DEFAULT_MS,
      LIGHTNING_DRAIN_TIMEOUT_MIN_MS,
      LIGHTNING_DRAIN_TIMEOUT_MAX_MS
    ),
    matcherVersionPrevious: previous,
    matcherVersionsDisabled: versionList(row.matcher_versions_disabled),
    fastFold: flagOpen(row, 'lightning_fast_fold'),
    foldWatch: flagOpen(row, 'lightning_fold_watch'),
    paused,
  };
}

export function sameLightningRolloutConfig(
  a: LightningRolloutConfig | undefined,
  b: LightningRolloutConfig | undefined
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The live version the engine asks the SQL for, as fn_lightning_config clamps
 * it: a version the operator disabled falls back to 'm1' (the SQL's own), and
 * no version named stays null (the SQL chooses). The engine never invents a
 * version the database did not report.
 */
export function effectiveLightningMatcherVersion(
  version: string | null,
  rollout: LightningRolloutConfig | undefined
): string | null {
  if (version === null) return null;
  const disabled = rollout?.matcherVersionsDisabled ?? [];
  if (!disabled.includes(version)) return version;
  return disabled.includes(LIGHTNING_MATCHER_FALLBACK_VERSION)
    ? null
    : LIGHTNING_MATCHER_FALLBACK_VERSION;
}

/**
 * LIGHTNING PHASE 12 (spec ACTION LATENCY TELEMETRY). `latency_telemetry`
 * defaults ON, and is inert without Lightning traffic: a window with no
 * sample sends nothing. The ledger only measures; nothing reads it back.
 */
export interface LightningLatencyConfig {
  /** `latency_telemetry`: aggregate each leg per window and report it. */
  enabled: boolean;
  /** `latency_window_ms`: one report per Cluster per window (the DB's clamp, 10000..600000). */
  windowMs: number;
}

export const LIGHTNING_LATENCY_WINDOW_DEFAULT_MS = 60_000;
export const LIGHTNING_LATENCY_WINDOW_MIN_MS = 10_000;
export const LIGHTNING_LATENCY_WINDOW_MAX_MS = 600_000;

/**
 * Parse the Phase 12 latency keys exactly as fn_lightning_config does: only a
 * JSON boolean false turns the ledger off (anything else non-boolean is the
 * default, on), and the window is an integer clamped to 10000..600000.
 * Never throws.
 */
export function parseLightningLatencyConfig(raw: unknown): LightningLatencyConfig {
  const row =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    enabled: row.latency_telemetry !== false,
    windowMs: readInteger(
      row.latency_window_ms,
      LIGHTNING_LATENCY_WINDOW_DEFAULT_MS,
      LIGHTNING_LATENCY_WINDOW_MIN_MS,
      LIGHTNING_LATENCY_WINDOW_MAX_MS
    ),
  };
}

export function sameLightningLatencyConfig(
  a: LightningLatencyConfig | undefined,
  b: LightningLatencyConfig | undefined
): boolean {
  return (
    (a?.enabled ?? false) === (b?.enabled ?? false) && (a?.windowMs ?? 0) === (b?.windowMs ?? 0)
  );
}

/**
 * LIGHTNING PHASE 11. Both features are OFF unless the config turns them on,
 * and neither can change what the live matcher deals (LightningShadowRunner).
 */
export interface LightningShadowConfig {
  /** `lightning_shadow_matcher`: run the shadow matcher beside every live pass. */
  enabled: boolean;
  /** `shadow_matcher_version`: the candidate the shadow side runs (LightningMatcherModel). */
  version: string;
  /** `shadow_window_ms`: one comparison record per Cluster per window. */
  windowMs: number;
  /** `shadow_max_players`: a pass whose snapshot is larger is skipped (CPU bound). */
  maxPlayers: number;
  /** `shadow_pass_budget_ms`: a shadow pass that overruns this skips the next ones. */
  passBudgetMs: number;
  /** `integrity_telemetry`: decision timing and pair correlation, reported per window. */
  integrityEnabled: boolean;
  /** The plan keys of the same config row (instance sizes, P3, P5). */
  params: LightningMatcherParams;
}

export const LIGHTNING_SHADOW_WINDOW_DEFAULT_MS = 5 * 60_000;
export const LIGHTNING_SHADOW_WINDOW_MIN_MS = 60_000;
export const LIGHTNING_SHADOW_WINDOW_MAX_MS = 60 * 60_000;
export const LIGHTNING_SHADOW_MAX_PLAYERS_DEFAULT = 500;
export const LIGHTNING_SHADOW_PASS_BUDGET_DEFAULT_MS = 50;

/** Parse the Phase 11 keys. Never throws; anything unreadable is off. */
export function parseLightningShadowConfig(raw: unknown): LightningShadowConfig {
  const row =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const flag = (v: unknown): boolean => v === true || v === 'true' || v === 'on';
  const version =
    typeof row.shadow_matcher_version === 'string' && row.shadow_matcher_version.trim() !== ''
      ? row.shadow_matcher_version.trim()
      : LIGHTNING_SHADOW_DEFAULT_VERSION;
  return {
    enabled: flag(row.lightning_shadow_matcher) || flag(row.shadow_matcher_enabled),
    version,
    windowMs: readInteger(
      row.shadow_window_ms,
      LIGHTNING_SHADOW_WINDOW_DEFAULT_MS,
      LIGHTNING_SHADOW_WINDOW_MIN_MS,
      LIGHTNING_SHADOW_WINDOW_MAX_MS
    ),
    maxPlayers: readInteger(row.shadow_max_players, LIGHTNING_SHADOW_MAX_PLAYERS_DEFAULT, 2, 5_000),
    passBudgetMs: readInteger(
      row.shadow_pass_budget_ms,
      LIGHTNING_SHADOW_PASS_BUDGET_DEFAULT_MS,
      5,
      1_000
    ),
    integrityEnabled: flag(row.integrity_telemetry) || flag(row.integrity_telemetry_enabled),
    params: lightningMatcherParams(row),
  };
}

export function sameLightningShadowConfig(
  a: LightningShadowConfig | undefined,
  b: LightningShadowConfig | undefined
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** How the auto-rebuy trigger is expressed. Anything else fails closed. */
export type LightningAutoRebuyTrigger = 'zero' | 'below_bb' | 'below_pct';

/** `auto_rebuy_target`: the stack a rebuy refills to (migration 20261008111425). */
export type LightningAutoRebuyTarget = 'initial' | 'max';

export interface LightningAutoRebuyConfig {
  /** `auto_rebuy_enabled`. Off (the default) asks the database nothing. */
  enabled: boolean;
  /**
   * `auto_rebuy_trigger`: 'zero' (the stack is gone), 'below_bb' (under
   * threshold_bb big blinds) or 'below_pct' (under threshold_pct percent of
   * the target buy-in). Anything unreadable is 'zero', the narrowest.
   */
  trigger: LightningAutoRebuyTrigger;
  /** `auto_rebuy_threshold_bb`: the below_bb trigger, in big blinds. */
  thresholdBb: number | null;
  /** `auto_rebuy_threshold_pct`: the below_pct trigger, percent of the target. */
  thresholdPct: number | null;
  /** `auto_rebuy_target`: refill to the initial buy-in, or to the table maximum. */
  target: LightningAutoRebuyTarget;
  /** `auto_rebuy_max_count`: the database's per-session rebuy count cap. */
  maxCount: number | null;
  /** `auto_rebuy_session_cap`: the database's per-session chip cap (0 = uncapped). */
  sessionCap: number | null;
}

/**
 * Bounds and defaults. The pass is one STABLE RPC per Cluster; two seconds
 * is fast enough for a shadow comparison against human-scale waits and slow
 * enough that even a dozen Lightning Clusters cost the database less than a
 * roster read per table does today. The floor (500 ms) exists so a config
 * typo cannot turn into a hot loop; the ceiling (60 s) so a typo in the
 * other direction cannot make a worker look dead.
 */
export const LIGHTNING_PASS_INTERVAL_DEFAULT_MS = 2_000;
export const LIGHTNING_PASS_INTERVAL_MIN_MS = 500;
export const LIGHTNING_PASS_INTERVAL_MAX_MS = 60_000;

export const LIGHTNING_KEEPALIVE_DEFAULT_MS = 30_000;
export const LIGHTNING_KEEPALIVE_MIN_MS = 1_000;
export const LIGHTNING_KEEPALIVE_MAX_MS = 600_000;

export const LIGHTNING_MAX_HANDS_DEFAULT = 32;
export const LIGHTNING_MAX_HANDS_MIN = 1;
export const LIGHTNING_MAX_HANDS_MAX = 64;

export const LIGHTNING_DEAL_WINDOW_DEFAULT_MS = 600_000;
export const LIGHTNING_DEAL_WINDOW_MIN_MS = 30_000;
export const LIGHTNING_DEAL_WINDOW_MAX_MS = 3_600_000;

/**
 * How often the leader's supervisor looks for Clusters that should have a
 * worker. One cheap select per interval (plus one config read per candidate,
 * and today there are none). Fifteen seconds is three ClusterController
 * passes: a Cluster that has just been converted gets its shadow worker well
 * inside the time any human looks at it.
 */
export const LIGHTNING_DISCOVERY_INTERVAL_MS = 15_000;

/** How often a worker re-reads its own config between discovery passes. */
export const LIGHTNING_CONFIG_REFRESH_MS = LIGHTNING_DISCOVERY_INTERVAL_MS;

/** Repeated failures (RPC unavailable, invalid shape) are logged at most this often per Cluster. */
export const LIGHTNING_FAILURE_LOG_INTERVAL_MS = 60_000;

/** Longest a stop() waits for an in-flight pass before giving up on it. */
export const LIGHTNING_STOP_DRAIN_MS = 15_000;

/** Auto-rebuy bounds (the migration's own clamps, mirrored). */
export const LIGHTNING_AUTO_REBUY_THRESHOLD_BB_MAX = 100;
export const LIGHTNING_AUTO_REBUY_SESSION_CAP_MAX = 1_000_000;

/** Auto-rebuy when nothing (or nonsense) is configured: off, asking nothing. */
export const LIGHTNING_AUTO_REBUY_DEFAULTS: Readonly<LightningAutoRebuyConfig> = Object.freeze({
  enabled: false,
  trigger: 'zero',
  thresholdBb: null,
  thresholdPct: null,
  target: 'initial',
  maxCount: null,
  sessionCap: null,
});

/** The configuration a Cluster gets when nothing can be read: it does nothing. */
export const LIGHTNING_CONFIG_DEFAULTS: Readonly<LightningConfig> = Object.freeze({
  matcherVersion: null,
  workerMode: 'off',
  passIntervalMs: LIGHTNING_PASS_INTERVAL_DEFAULT_MS,
  keepaliveIntervalMs: LIGHTNING_KEEPALIVE_DEFAULT_MS,
  maxHandsPerPass: LIGHTNING_MAX_HANDS_DEFAULT,
  dealWindowMs: LIGHTNING_DEAL_WINDOW_DEFAULT_MS,
  autoRebuy: LIGHTNING_AUTO_REBUY_DEFAULTS,
});

function readInteger(raw: unknown, fallback: number, min: number, max: number): number {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
  else return fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** A positive bounded number, or null (never a guess): the auto-rebuy keys. */
function readPositive(raw: unknown, max: number): number | null {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
  else return null;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, n);
}

/**
 * Parse the auto-rebuy keys out of `fn_lightning_config`'s jsonb. Never
 * throws; anything unreadable is the default, and the default asks nothing.
 */
export function parseLightningAutoRebuyConfig(raw: unknown): LightningAutoRebuyConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ...LIGHTNING_AUTO_REBUY_DEFAULTS };
  const row = raw as Record<string, unknown>;
  const trigger =
    typeof row.auto_rebuy_trigger === 'string' &&
    ['zero', 'below_bb', 'below_pct'].includes(row.auto_rebuy_trigger.trim().toLowerCase())
      ? (row.auto_rebuy_trigger.trim().toLowerCase() as LightningAutoRebuyTrigger)
      : 'zero';
  const target =
    typeof row.auto_rebuy_target === 'string' &&
    row.auto_rebuy_target.trim().toLowerCase() === 'max'
      ? ('max' as const)
      : ('initial' as const);
  return {
    enabled: row.auto_rebuy_enabled === true,
    trigger,
    thresholdBb: readPositive(row.auto_rebuy_threshold_bb, LIGHTNING_AUTO_REBUY_THRESHOLD_BB_MAX),
    thresholdPct: readPositive(row.auto_rebuy_threshold_pct, 99),
    target,
    maxCount: readPositive(row.auto_rebuy_max_count, 100),
    sessionCap: readPositive(row.auto_rebuy_session_cap, LIGHTNING_AUTO_REBUY_SESSION_CAP_MAX),
  };
}

export function sameLightningAutoRebuyConfig(
  a: LightningAutoRebuyConfig,
  b: LightningAutoRebuyConfig
): boolean {
  return (
    a.enabled === b.enabled &&
    a.trigger === b.trigger &&
    a.thresholdBb === b.thresholdBb &&
    a.thresholdPct === b.thresholdPct &&
    a.target === b.target &&
    a.maxCount === b.maxCount &&
    a.sessionCap === b.sessionCap
  );
}

function readMode(raw: unknown): LightningWorkerMode {
  if (typeof raw !== 'string') return 'off';
  const mode = raw.trim().toLowerCase();
  return (LIGHTNING_WORKER_MODES as readonly string[]).includes(mode)
    ? (mode as LightningWorkerMode)
    : 'off';
}

/**
 * Parse `fn_lightning_config`'s jsonb. Never throws; anything unreadable
 * yields the defaults, and the defaults do nothing.
 */
export function parseLightningConfig(raw: unknown): LightningConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ...LIGHTNING_CONFIG_DEFAULTS };
  const row = raw as Record<string, unknown>;
  const rollout = parseLightningRolloutConfig(raw);
  const named =
    typeof row.matcher_version === 'string' && row.matcher_version.trim() !== ''
      ? row.matcher_version.trim()
      : null;
  // LIGHTNING PHASE 13: a disabled live version falls back exactly as the DB
  // clamps it, and a disabled shadow version records nothing at all.
  const version = effectiveLightningMatcherVersion(named, rollout);
  const shadow = parseLightningShadowConfig(raw);
  // fn_lightning_config also reports it outright (shadow_matcher_disabled).
  if (
    rollout.matcherVersionsDisabled.includes(shadow.version) ||
    row.shadow_matcher_disabled === true
  )
    shadow.enabled = false;
  return {
    matcherVersion: version,
    workerMode: readMode(row.worker_mode),
    passIntervalMs: readInteger(
      row.pass_interval_ms,
      LIGHTNING_PASS_INTERVAL_DEFAULT_MS,
      LIGHTNING_PASS_INTERVAL_MIN_MS,
      LIGHTNING_PASS_INTERVAL_MAX_MS
    ),
    keepaliveIntervalMs: readInteger(
      row.keepalive_interval_ms,
      LIGHTNING_KEEPALIVE_DEFAULT_MS,
      LIGHTNING_KEEPALIVE_MIN_MS,
      LIGHTNING_KEEPALIVE_MAX_MS
    ),
    maxHandsPerPass: readInteger(
      row.admission_batch_hands,
      LIGHTNING_MAX_HANDS_DEFAULT,
      LIGHTNING_MAX_HANDS_MIN,
      LIGHTNING_MAX_HANDS_MAX
    ),
    dealWindowMs: readInteger(
      row.deal_window_ms,
      LIGHTNING_DEAL_WINDOW_DEFAULT_MS,
      LIGHTNING_DEAL_WINDOW_MIN_MS,
      LIGHTNING_DEAL_WINDOW_MAX_MS
    ),
    autoRebuy: parseLightningAutoRebuyConfig(raw),
    shadow,
    latency: parseLightningLatencyConfig(raw),
    rollout,
  };
}

/** True when two configs would make a worker behave identically. */
export function sameLightningConfig(a: LightningConfig, b: LightningConfig): boolean {
  return (
    a.matcherVersion === b.matcherVersion &&
    a.workerMode === b.workerMode &&
    a.passIntervalMs === b.passIntervalMs &&
    a.keepaliveIntervalMs === b.keepaliveIntervalMs &&
    a.maxHandsPerPass === b.maxHandsPerPass &&
    a.dealWindowMs === b.dealWindowMs &&
    sameLightningAutoRebuyConfig(a.autoRebuy, b.autoRebuy) &&
    sameLightningShadowConfig(a.shadow, b.shadow) &&
    sameLightningLatencyConfig(a.latency, b.latency) &&
    sameLightningRolloutConfig(a.rollout, b.rollout)
  );
}

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

/** The configuration a Cluster gets when nothing can be read: it does nothing. */
export const LIGHTNING_CONFIG_DEFAULTS: Readonly<LightningConfig> = Object.freeze({
  matcherVersion: null,
  workerMode: 'off',
  passIntervalMs: LIGHTNING_PASS_INTERVAL_DEFAULT_MS,
  keepaliveIntervalMs: LIGHTNING_KEEPALIVE_DEFAULT_MS,
});

function readInteger(raw: unknown, fallback: number, min: number, max: number): number {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
  else return fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
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
  const version =
    typeof row.matcher_version === 'string' && row.matcher_version.trim() !== ''
      ? row.matcher_version.trim()
      : null;
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
  };
}

/** True when two configs would make a worker behave identically. */
export function sameLightningConfig(a: LightningConfig, b: LightningConfig): boolean {
  return (
    a.matcherVersion === b.matcherVersion &&
    a.workerMode === b.workerMode &&
    a.passIntervalMs === b.passIntervalMs &&
    a.keepaliveIntervalMs === b.keepaliveIntervalMs
  );
}

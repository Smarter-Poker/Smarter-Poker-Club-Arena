/**
 * LIGHTNING PHASE 12: THE OPERATOR'S READS, PARSED FROM THE DATABASE.
 *
 * Five SECURITY DEFINER doors, granted to `authenticated` and `service_role`
 * and gated in the database (service_role, a platform admin, or
 * fn_ca_can_review_integrity for the Cluster's club). The client gate in the
 * operations registry is cosmetic; these answers are authoritative.
 *
 *   fn_lightning_operator_overview(p_club_id)                  every Cluster
 *   fn_lightning_operator_cluster(p_cluster_id, p_from, p_to)  one Cluster
 *   fn_lightning_operator_hand_replay(p_cluster_id, p_hand_id) replay check
 *   fn_lightning_operator_session_trail(p_cluster_id, p_pool_session_id)
 *   fn_lightning_operator_signal_review(p_signal_id, p_status, p_note)
 *
 * Every answer is parsed defensively: a field that is missing or not a number
 * is "not known" (null), never a guess and never a zero that would print as a
 * real reading. A refusal (`{ok:false, code}`) is an answer, not a fault; a
 * missing function (the migration has not landed) is "not available yet",
 * never a crash and never a retry storm.
 *
 * LAWS THIS FILE KEEPS
 *   - No card is ever read here. The doors redact, and no parser below even
 *     names a card field, so a door that leaked one would still print nothing.
 *   - Horses are players (Law 10.5). Nothing here reads, filters or labels
 *     which players are horses.
 *   - Integrity, shadow and latency readings are for people. Nothing here
 *     feeds matchmaking; this module is imported by the operator page only.
 */
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { isAuthzError } from '../utils/clubDashboard';
import { enumToTitleCase, titleCase } from '../utils/titleCase';
import { isLightningRpcMissing } from './lightningSessionApi';

// ─── Small, honest readers ─────────────────────────────────────────────────

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function objectOf(raw: unknown): Record<string, unknown> | null {
  const row = Array.isArray(raw) ? raw[0] : raw;
  return row && typeof row === 'object' && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : null;
}

function listOf(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw)
    ? raw.filter(
        (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)
      )
    : [];
}

/** An id the door handed over, kept exactly as it came (uuid or bigint). */
function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

// ─── The answer every door gives ───────────────────────────────────────────

export type OperatorAnswer<T> =
  | { status: 'ok'; data: T }
  /** `{ok:false, code:'NOT_AUTHORIZED'}`, or a 42501 from PostgREST. */
  | { status: 'denied' }
  /** The function is not in the database yet: a deploy window, never a fault. */
  | { status: 'unavailable' }
  /** Any other `{ok:false, code}` the door gave, e.g. CLUSTER_NOT_FOUND. */
  | { status: 'refused'; code: string }
  | { status: 'error'; message: string };

export const NOT_AUTHORIZED = 'NOT_AUTHORIZED';

/** The door's refusal code. The contract names it `code`; older Lightning
 *  doors call it `reason`, so both are read. */
export function refusalCode(row: Record<string, unknown>): string {
  return text(row.code) ?? text(row.reason) ?? 'REFUSED';
}

export function interpretAnswer<T>(
  raw: unknown,
  parse: (row: Record<string, unknown>) => T | null
): OperatorAnswer<T> {
  const row = objectOf(raw);
  if (!row) return { status: 'error', message: 'Lightning Answered With Nothing' };
  if (row.ok === false) {
    const code = refusalCode(row);
    return code === NOT_AUTHORIZED ? { status: 'denied' } : { status: 'refused', code };
  }
  const data = parse(row);
  return data === null
    ? { status: 'error', message: 'Lightning Answered In A Shape This Page Cannot Read' }
    : { status: 'ok', data };
}

type RpcClient = Pick<typeof supabase, 'rpc'>;

type RpcResult = { data: unknown; error: unknown };

/**
 * One door call: a missing function, a refusal and a fault each answer their
 * own way, and every error is bound and reported. Each caller passes its own
 * literal `client.rpc('fn_lightning_operator_...')`, so the repository's
 * phantom-RPC gate sees every door this page reads.
 */
async function callDoor<T>(
  fn: string,
  call: () => PromiseLike<RpcResult>,
  interpret: (raw: unknown) => OperatorAnswer<T>
): Promise<OperatorAnswer<T>> {
  try {
    const { data, error } = await call();
    if (error) {
      if (isLightningRpcMissing(error)) return { status: 'unavailable' };
      if (isAuthzError(error)) return { status: 'denied' };
      reportError(error, `LightningOperator.${fn}`);
      return { status: 'error', message: 'Could Not Read Lightning' };
    }
    return interpret(data);
  } catch (e) {
    if (isLightningRpcMissing(e)) return { status: 'unavailable' };
    reportError(e, `LightningOperator.${fn}`);
    return { status: 'error', message: 'Could Not Read Lightning' };
  }
}

// ─── Labels (operator vocabulary: Lightning, Must Move, never a rival name) ─

export type LightningModeTone = 'must_move' | 'lightning' | 'pending' | 'frozen' | 'other';

export interface LightningModeBadge {
  label: string;
  tone: LightningModeTone;
  /** Which way a pending Cluster is heading, when it is pending. */
  detail: string | null;
}

/** 'cluster_unfrozen' -> 'Cluster Unfrozen'. Data reaches the screen cased,
 *  through the repo's one casing transform (acronyms such as BB survive). */
export function enumLabel(value: string | null | undefined): string {
  if (!value) return '';
  return enumToTitleCase(String(value).toLowerCase().replace(/-/g, '_'));
}

export function modeBadge(mode: string | null): LightningModeBadge {
  switch (mode) {
    case 'must_move':
      return { label: 'Must Move', tone: 'must_move', detail: null };
    case 'lightning':
      return { label: 'Lightning', tone: 'lightning', detail: null };
    case 'pending_on':
      return { label: 'Pending', tone: 'pending', detail: 'Converting To Lightning' };
    case 'pending_off':
      return { label: 'Pending', tone: 'pending', detail: 'Reverting To Must Move' };
    case 'frozen':
      return { label: 'Frozen', tone: 'frozen', detail: null };
    default:
      return { label: mode ? enumLabel(mode) : 'Unknown', tone: 'other', detail: null };
  }
}

export const LATENCY_LEGS = [
  'fold_ack',
  'ack_to_idle',
  'idle_to_match',
  'match_to_hand',
  'hand_to_first_render',
  'fast_fold_to_next_hand',
  'normal_fold_to_next_hand',
  'fold_watch_to_next_hand',
] as const;

export type LatencyLeg = (typeof LATENCY_LEGS)[number];

export const LATENCY_LEG_LABELS: Record<LatencyLeg, string> = {
  fold_ack: 'Fold To Server Ack',
  ack_to_idle: 'Ack To Idle Pool',
  idle_to_match: 'Idle Pool To Match',
  match_to_hand: 'Match To Hand',
  hand_to_first_render: 'Hand To First Render',
  fast_fold_to_next_hand: 'Lightning Fold To Next Hand',
  normal_fold_to_next_hand: 'Normal Fold To Next Hand',
  fold_watch_to_next_hand: 'Fold & Watch To Next Hand',
};

export const SHADOW_VERDICT_LABELS: Record<string, string> = {
  insufficient_evidence: 'Insufficient Evidence',
  shadow_leads: 'Candidate Leads',
  live_leads: 'Live Leads',
  no_clear_winner: 'No Clear Winner',
  // An A/A pair (live m1 against its own port m1-port), 20261009181945.
  calibrated: 'Calibrated',
  calibration_bias: 'Calibration Bias',
};

export function verdictLabel(verdict: string | null): string {
  if (!verdict) return 'No Comparisons';
  return SHADOW_VERDICT_LABELS[verdict] ?? enumLabel(verdict);
}

/** lightning_hand_player.fold_type ('none', 'normal', 'fast', 'fold_watch')
 *  in the operator's words. 'none' (played on) has no label. */
export function foldLabel(foldType: string | null): string | null {
  switch (foldType) {
    case 'fast':
      return 'Lightning Fold';
    case 'normal':
      return 'Normal Fold';
    case 'fold_watch':
      return 'Fold & Watch';
    case 'none':
    case null:
      return null;
    default:
      return enumLabel(foldType);
  }
}

export const SIGNAL_REVIEW_STATUSES = ['reviewed', 'cleared', 'actioned'] as const;
export type SignalReviewStatus = (typeof SIGNAL_REVIEW_STATUSES)[number];

// ─── fn_lightning_operator_overview ────────────────────────────────────────

export interface LatencyLegReading {
  n: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export type LatencyLegs = Partial<Record<LatencyLeg, LatencyLegReading>>;

export function parseLatencyLegs(raw: unknown): LatencyLegs {
  const row = objectOf(raw);
  const out: LatencyLegs = {};
  if (!row) return out;
  for (const leg of LATENCY_LEGS) {
    const r = objectOf(row[leg]);
    if (!r) continue;
    out[leg] = { n: num(r.n), p50: num(r.p50), p95: num(r.p95), p99: num(r.p99) };
  }
  return out;
}

export interface LightningOverviewCluster {
  clusterId: string;
  name: string | null;
  variant: string | null;
  sb: number | null;
  bb: number | null;
  handedness: number | null;
  lightningEnabled: boolean;
  mode: string | null;
  epoch: number | null;
  modeSince: string | null;
  onThreshold: number | null;
  offThreshold: number | null;
  liveEligible: number | null;
  workerMode: string | null;
  flags: {
    shadowMatcher: boolean | null;
    integrityTelemetry: boolean | null;
    autoRebuy: boolean | null;
    latencyTelemetry: boolean | null;
  };
  pool: {
    joining: number | null;
    eligibilityCheck: number | null;
    active: number | null;
    sitOut: number | null;
    disconnected: number | null;
    leaving: number | null;
  };
  reservations: { pending: number | null; committed: number | null };
  instances: {
    forming: number | null;
    reserved: number | null;
    dealing: number | null;
    settling: number | null;
  };
  orphanReservations: number | null;
  blindObligationsOpen: number | null;
  /** Set when a pending conversion has outlived the stuck-conversion
   *  threshold: the database answers the conversion itself, or null. */
  stuckConversion: {
    fromMode: string | null;
    toMode: string | null;
    openedAt: string | null;
    ageMs: number | null;
    thresholdMs: number | null;
  } | null;
  frozen: { at: string | null; reason: string | null; invariant: string | null } | null;
  openAlerts: number | null;
  integrityOpenSignals: number | null;
  shadow: {
    verdict: string | null;
    comparisons: number | null;
    deltaMean: number | null;
    liveVersion: string | null;
    candidateVersion: string | null;
  } | null;
  latency: { windowFrom: string | null; windowTo: string | null; legs: LatencyLegs } | null;
}

function parseStuck(raw: unknown): LightningOverviewCluster['stuckConversion'] {
  if (raw === true) {
    return { fromMode: null, toMode: null, openedAt: null, ageMs: null, thresholdMs: null };
  }
  const r = objectOf(raw);
  if (!r) return null;
  return {
    fromMode: text(r.from_mode),
    toMode: text(r.to_mode),
    openedAt: text(r.opened_at),
    ageMs: num(r.age_ms),
    thresholdMs: num(r.threshold_ms),
  };
}

export function parseOverviewCluster(raw: unknown): LightningOverviewCluster | null {
  const r = objectOf(raw);
  const clusterId = r ? idOf(r.cluster_id) : null;
  if (!r || !clusterId) return null;
  const flags = objectOf(r.flags) ?? {};
  const pool = objectOf(r.pool) ?? {};
  const reservations = objectOf(r.reservations) ?? {};
  const instances = objectOf(r.instances) ?? {};
  const frozen = objectOf(r.frozen);
  const shadow = objectOf(r.shadow);
  const latency = objectOf(r.latency);
  return {
    clusterId,
    name: text(r.name),
    variant: text(r.variant),
    sb: num(r.sb),
    bb: num(r.bb),
    handedness: num(r.handedness),
    lightningEnabled: r.lightning_enabled === true,
    mode: text(r.cluster_mode),
    epoch: num(r.cluster_epoch),
    modeSince: text(r.mode_since),
    onThreshold: num(r.on_threshold),
    offThreshold: num(r.off_threshold),
    liveEligible: num(r.live_eligible),
    workerMode: text(r.worker_mode),
    flags: {
      shadowMatcher: bool(flags.shadow_matcher),
      integrityTelemetry: bool(flags.integrity_telemetry),
      autoRebuy: bool(flags.auto_rebuy),
      latencyTelemetry: bool(flags.latency_telemetry),
    },
    pool: {
      joining: num(pool.joining),
      eligibilityCheck: num(pool.eligibility_check),
      active: num(pool.active),
      sitOut: num(pool.sit_out),
      disconnected: num(pool.disconnected),
      leaving: num(pool.leaving),
    },
    reservations: { pending: num(reservations.pending), committed: num(reservations.committed) },
    instances: {
      forming: num(instances.forming),
      reserved: num(instances.reserved),
      dealing: num(instances.dealing),
      settling: num(instances.settling),
    },
    orphanReservations: num(r.orphan_reservations),
    blindObligationsOpen: num(r.blind_obligations_open),
    stuckConversion: parseStuck(r.stuck_conversion),
    frozen: frozen
      ? { at: text(frozen.at), reason: text(frozen.reason), invariant: text(frozen.invariant) }
      : null,
    openAlerts: num(r.open_alerts),
    integrityOpenSignals: num(r.integrity_open_signals),
    shadow: shadow
      ? {
          verdict: text(shadow.verdict),
          comparisons: num(shadow.comparisons),
          deltaMean: num(shadow.delta_mean),
          liveVersion: text(shadow.live_matcher_version),
          candidateVersion: text(shadow.shadow_matcher_version),
        }
      : null,
    latency: latency
      ? {
          windowFrom: text(latency.window_from),
          windowTo: text(latency.window_to),
          legs: parseLatencyLegs(latency.legs),
        }
      : null,
  };
}

export interface LightningOverview {
  clubId: string | null;
  asOf: string | null;
  /** The door answers at most 200 Clusters and says when it stopped there. */
  truncated: boolean;
  clusters: LightningOverviewCluster[];
}

export function parseOverview(row: Record<string, unknown>): LightningOverview | null {
  if (!Array.isArray(row.clusters)) return null;
  return {
    clubId: idOf(row.club_id),
    asOf: text(row.as_of),
    truncated: row.truncated === true,
    clusters: row.clusters
      .map(parseOverviewCluster)
      .filter((c): c is LightningOverviewCluster => c !== null),
  };
}

export function fetchLightningOverview(
  clubId: string,
  client: RpcClient = supabase
): Promise<OperatorAnswer<LightningOverview>> {
  return callDoor(
    'fn_lightning_operator_overview',
    () => client.rpc('fn_lightning_operator_overview', { p_club_id: clubId }),
    (raw) => interpretAnswer(raw, parseOverview)
  );
}

// ─── fn_lightning_operator_cluster ─────────────────────────────────────────

/**
 * One mode transition, as fn_lightning_operator_cluster and the session
 * trail answer it: an epoch (`kind:'epoch'`, the regime the Cluster ran
 * under), a conversion (`kind:'conversion'`, pending_on or pending_off and
 * its outcome) or the freeze (`kind:'freeze'`).
 */
export interface LightningTransition {
  kind: 'epoch' | 'conversion' | 'freeze' | 'other';
  epoch: number | null;
  mode: string | null;
  fromMode: string | null;
  status: string | null;
  reason: string | null;
  at: string | null;
  endedAt: string | null;
}

export function parseTransition(raw: unknown): LightningTransition | null {
  const r = objectOf(raw);
  if (!r) return null;
  const kindText = text(r.kind);
  const kind: LightningTransition['kind'] =
    kindText === 'epoch' || kindText === 'conversion' || kindText === 'freeze' ? kindText : 'other';
  return {
    kind,
    epoch: num(r.epoch ?? r.epoch_after ?? r.cluster_epoch),
    mode: text(r.mode) ?? text(r.to_mode) ?? (kind === 'freeze' ? 'frozen' : null),
    fromMode: text(r.from_mode),
    status: text(r.status),
    reason: text(r.started_by) ?? text(r.abort_reason) ?? text(r.reason),
    at: text(r.at) ?? text(r.started_at) ?? text(r.opened_at),
    endedAt: text(r.ended_at) ?? text(r.closed_at),
  };
}

export interface LightningReservationRow {
  id: string | null;
  playerId: string | null;
  state: string | null;
  seatNumber: number | null;
  instanceId: string | null;
  instanceState: string | null;
  /** The door's own verdict: expired, instance gone or slot closed. */
  orphan: boolean;
  createdAt: string | null;
  expiresAt: string | null;
}

export function parseReservation(raw: unknown): LightningReservationRow | null {
  const r = objectOf(raw);
  if (!r) return null;
  return {
    id: idOf(r.id ?? r.reservation_id),
    playerId: idOf(r.player_id),
    state: text(r.state),
    seatNumber: num(r.seat_number),
    instanceId: idOf(r.instance_id ?? r.lightning_instance_id),
    instanceState: text(r.instance_state),
    orphan: r.orphan === true,
    createdAt: text(r.created_at),
    expiresAt: text(r.expires_at),
  };
}

export interface LightningBlindObligation {
  playerId: string | null;
  missedBbDebt: number | null;
  missedSbDebt: number | null;
  bbOwed: number | null;
  sbOwed: number | null;
  debtSince: string | null;
}

export function parseBlindObligation(raw: unknown): LightningBlindObligation | null {
  const r = objectOf(raw);
  if (!r) return null;
  return {
    playerId: idOf(r.player_id),
    missedBbDebt: num(r.missed_bb_debt),
    missedSbDebt: num(r.missed_sb_debt),
    bbOwed: num(r.bb_owed),
    sbOwed: num(r.sb_owed),
    debtSince: text(r.debt_since),
  };
}

export interface LightningReconcileRow {
  poolSessionId: string | null;
  playerId: string | null;
  state: string | null;
  anchorSeatId: string | null;
  anchorStack: number | null;
  exposure: number | null;
  poolStack: number | null;
  ok: boolean;
}

export function parseReconcile(raw: unknown): LightningReconcileRow | null {
  const r = objectOf(raw);
  if (!r) return null;
  return {
    poolSessionId: idOf(r.pool_session_id),
    playerId: idOf(r.player_id),
    state: text(r.state),
    anchorSeatId: idOf(r.anchor_seat_id),
    anchorStack: num(r.anchor_stack),
    exposure: num(r.exposure),
    poolStack: num(r.pool_stack),
    // Only an explicit true is reconciled. A missing flag is not a pass.
    ok: r.ok === true,
  };
}

/** How far the pool stack is from anchor minus exposure, when all three are known. */
export function reconcileGap(row: LightningReconcileRow): number | null {
  if (row.anchorStack === null || row.exposure === null || row.poolStack === null) return null;
  return row.anchorStack - row.exposure - row.poolStack;
}

export interface LightningShadowPair {
  liveVersion: string | null;
  candidateVersion: string | null;
  /** Scored windows only (both scores present); the verdict needs 30. */
  comparisons: number | null;
  /** Every recorded window, scored or not (20261009181945). */
  windows: number | null;
  /** Live against its own port (shadow = live + '-port'): calibration, never a candidate. */
  aaCalibration: boolean;
  liveQualityMean: number | null;
  candidateQualityMean: number | null;
  deltaMean: number | null;
  deltaMin: number | null;
  deltaMax: number | null;
  candidateBetterShare: number | null;
  verdict: string | null;
  components: Array<{
    key: string;
    live: number | null;
    candidate: number | null;
    delta: number | null;
  }>;
}

/** fn_lightning_shadow_report's answer (20261008161509): `version_pairs`. */
export function parseShadowReport(raw: unknown): LightningShadowPair[] {
  const r = objectOf(raw);
  if (!r) return [];
  return listOf(r.version_pairs).map((p) => {
    const metrics = objectOf(p.metrics) ?? {};
    return {
      liveVersion: text(p.live_matcher_version),
      candidateVersion: text(p.shadow_matcher_version),
      comparisons: num(p.comparisons),
      windows: num(p.windows),
      aaCalibration: p.aa_calibration === true,
      liveQualityMean: num(p.live_quality_mean),
      candidateQualityMean: num(p.shadow_quality_mean),
      deltaMean: num(p.quality_delta_mean),
      deltaMin: num(p.quality_delta_min),
      deltaMax: num(p.quality_delta_max),
      candidateBetterShare: num(p.shadow_better_share),
      verdict: text(p.verdict),
      components: Object.keys(metrics)
        .sort()
        .map((key) => {
          const m = objectOf(metrics[key]) ?? {};
          return { key, live: num(m.live), candidate: num(m.shadow), delta: num(m.delta) };
        }),
    };
  });
}

/** 'component.bb_fairness' -> 'BB Fairness'; 'wait_ms.p95' -> 'Wait P95'. */
export function shadowMetricLabel(key: string): string {
  const cleaned = key
    .replace(/^component\./, '')
    .replace(/_ms\b/g, '')
    .replace(/\./g, ' ');
  return enumLabel(cleaned).replace(/\bBtn\b/g, 'BTN');
}

export interface LightningIntegritySignal {
  id: string | null;
  pattern: string | null;
  source: string | null;
  severity: string | null;
  score: number | null;
  status: string | null;
  playerA: string | null;
  playerB: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  detectedAt: string | null;
  reviewedAt: string | null;
  notes: string | null;
}

/** A lightning_integrity_signal row (20261008161509). Evidence is not read:
 *  it is counts and ratios for a reviewer, and this list shows the finding. */
export function parseIntegritySignal(raw: unknown): LightningIntegritySignal | null {
  const r = objectOf(raw);
  if (!r) return null;
  return {
    id: idOf(r.id ?? r.signal_id),
    pattern: text(r.pattern_type),
    source: text(r.source),
    severity: text(r.severity),
    score: num(r.suspicion_score),
    status: text(r.status),
    playerA: idOf(r.player_a),
    playerB: idOf(r.player_b),
    windowStart: text(r.window_start),
    windowEnd: text(r.window_end),
    detectedAt: text(r.detected_at),
    reviewedAt: text(r.reviewed_at),
    notes: text(r.notes),
  };
}

export interface LightningAlertRow {
  id: string | null;
  severity: string | null;
  source: string | null;
  /** The sweep's check (frozen, stuck_conversion, drive_error, ...). */
  check: string | null;
  message: string | null;
  createdAt: string | null;
}

/** An open financial_alerts row as fn_lightning_operator_cluster answers it:
 *  id, severity, source, check, message, created_at, dedupe_key. */
export function parseAlert(raw: unknown): LightningAlertRow | null {
  const r = objectOf(raw);
  if (!r) return null;
  return {
    id: idOf(r.id),
    severity: text(r.severity),
    source: text(r.source),
    check: text(r.check),
    message: text(r.message),
    createdAt: text(r.created_at),
  };
}

const ALERT_CHECK_TITLES: Record<string, string> = {
  frozen: 'Cluster Frozen',
  stuck_conversion: 'Conversion Stuck',
  drive_error: 'Drive Errors',
  reaper_failure: 'Reaper Failures',
  integrity_spike: 'Integrity Spike',
  latency_regression: 'Latency Regression',
};

/**
 * What an alert is, in two or three words. The message itself is an
 * engineer's paragraph (function names, ids, arrows), so the title comes from
 * the sweep's check, or from the code the message starts with
 * ('LIGHTNING_CLUSTER_FROZEN: ...'), or from the source. Never the raw prose.
 */
export function alertTitle(alert: LightningAlertRow): string {
  if (alert.check && ALERT_CHECK_TITLES[alert.check]) return ALERT_CHECK_TITLES[alert.check];
  const code = alert.message?.match(/^([A-Z][A-Z0-9_]{2,}):/)?.[1] ?? null;
  if (code) return enumLabel(code.replace(/^LIGHTNING_/, ''));
  if (alert.check) return enumLabel(alert.check);
  return alert.source ? enumLabel(alert.source) : 'Alert';
}

export interface LightningLatencyWindow {
  windowFrom: string | null;
  windowTo: string | null;
  legs: LatencyLegs;
}

export function parseLatencyWindow(raw: unknown): LightningLatencyWindow | null {
  const r = objectOf(raw);
  if (!r) return null;
  return {
    windowFrom: text(r.window_from),
    windowTo: text(r.window_to),
    legs: parseLatencyLegs(r.legs),
  };
}

export interface LightningQuality {
  score: number | null;
  at: string | null;
}

export function parseQuality(raw: unknown): LightningQuality | null {
  if (raw === null || raw === undefined) return null;
  const direct = num(raw);
  if (direct !== null) return { score: direct, at: null };
  const r = objectOf(raw);
  if (!r) return null;
  const score = num(r.live_quality_score ?? r.quality_score ?? r.score);
  if (score === null) return null;
  return { score, at: text(r.window_to) ?? text(r.at) ?? text(r.created_at) };
}

export interface LightningClusterDetail {
  cluster: LightningOverviewCluster | null;
  transitions: LightningTransition[];
  reservations: LightningReservationRow[];
  blindLedger: LightningBlindObligation[];
  reconcile: LightningReconcileRow[];
  shadow: LightningShadowPair[];
  signals: LightningIntegritySignal[];
  alerts: LightningAlertRow[];
  latencyWindows: LightningLatencyWindow[];
  quality: LightningQuality | null;
}

function parsedList<T>(raw: unknown, parse: (r: unknown) => T | null): T[] {
  return listOf(raw)
    .map(parse)
    .filter((x): x is T => x !== null);
}

export function parseClusterDetail(row: Record<string, unknown>): LightningClusterDetail | null {
  const cluster = parseOverviewCluster(row.cluster);
  if (!cluster && !Array.isArray(row.transitions)) return null;
  return {
    cluster,
    transitions: parsedList(row.transitions, parseTransition),
    reservations: parsedList(row.reservations, parseReservation),
    blindLedger: parsedList(row.blind_ledger, parseBlindObligation),
    reconcile: parsedList(row.reconcile, parseReconcile),
    shadow: parseShadowReport(row.shadow_report),
    signals: parsedList(row.integrity_signals, parseIntegritySignal),
    alerts: parsedList(row.alerts, parseAlert),
    latencyWindows: parsedList(row.latency_windows, parseLatencyWindow),
    quality: parseQuality(row.quality),
  };
}

export function fetchLightningCluster(
  clusterId: string,
  from: Date,
  to: Date,
  client: RpcClient = supabase
): Promise<OperatorAnswer<LightningClusterDetail>> {
  return callDoor(
    'fn_lightning_operator_cluster',
    () =>
      client.rpc('fn_lightning_operator_cluster', {
        p_cluster_id: clusterId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      }),
    (raw) => interpretAnswer(raw, parseClusterDetail)
  );
}

// ─── fn_lightning_operator_hand_replay ─────────────────────────────────────

export interface LightningHandReplayPlayer {
  playerId: string | null;
  seat: number | null;
  stackBefore: number | null;
  stackAfter: number | null;
  net: number | null;
  foldType: string | null;
}

export interface LightningHandReplay {
  handId: string | null;
  consistent: boolean;
  settled: boolean | null;
  epoch: number | null;
  defects: Array<{ code: string; detail: string | null }>;
  handNumber: number | null;
  players: LightningHandReplayPlayer[];
}

/** The detail of one defect, printed without any card field (none exists). */
function defectDetail(d: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const key of ['kind', 'field', 'instance_state']) {
    const v = text(d[key]);
    if (v) parts.push(enumLabel(v));
  }
  for (const key of ['locked', 'found', 'net_sum', 'rake', 'bbj']) {
    const v = num(d[key]);
    if (v !== null) parts.push(`${enumLabel(key)} ${v}`);
  }
  return parts.length ? parts.join(', ') : null;
}

export function parseHandReplay(row: Record<string, unknown>): LightningHandReplay | null {
  // The door answers {ok, cluster_id, hand_id, replay, hand, players, events}:
  // `replay` is fn_lightning_hand_replay_check's own answer, whose `ok` is the
  // verdict (false WITH defects is a finding, never a refusal).
  const inner = objectOf(row.replay);
  if (!inner) return null;
  if (!Array.isArray(inner.defects)) return null;
  const defects = listOf(inner.defects).map((d) => ({
    code: text(d.code) ?? 'defect',
    detail: defectDetail(d),
  }));
  return {
    handId: idOf(inner.hand_id ?? row.hand_id),
    consistent: defects.length === 0 && inner.ok !== false,
    settled: bool(inner.settled),
    epoch: num(inner.cluster_epoch),
    defects,
    handNumber: num(objectOf(row.hand)?.hand_number),
    players: listOf(row.players).map((p) => ({
      playerId: idOf(p.player_id),
      seat: num(p.seat),
      stackBefore: num(p.stack_before),
      stackAfter: num(p.stack_after),
      net: num(p.net_result),
      foldType: text(p.fold_type),
    })),
  };
}

/** A refused read (NOT_AUTHORIZED, NOT_FOUND) is the door's own `ok:false`;
 *  a hand with defects is `ok:true` with `replay.ok:false`. */
export function interpretHandReplay(raw: unknown): OperatorAnswer<LightningHandReplay> {
  return interpretAnswer(raw, parseHandReplay);
}

export function fetchLightningHandReplay(
  clusterId: string,
  handId: string,
  client: RpcClient = supabase
): Promise<OperatorAnswer<LightningHandReplay>> {
  return callDoor(
    'fn_lightning_operator_hand_replay',
    () =>
      client.rpc('fn_lightning_operator_hand_replay', {
        p_cluster_id: clusterId,
        p_hand_id: handId,
      }),
    interpretHandReplay
  );
}

// ─── fn_lightning_operator_session_trail ───────────────────────────────────

export interface LightningTrailStep {
  at: string | null;
  label: string;
  detail: string | null;
}

/** One step of a pool session's trail: a ledger event, a slot, a
 *  reservation or a hand, each with `at`, `source` and `kind`. */
export function parseTrailStep(raw: unknown): LightningTrailStep | null {
  const r = objectOf(raw);
  if (!r) return null;
  const label = text(r.kind) ?? text(r.state) ?? text(r.event);
  if (!label) return null;
  const parts: string[] = [];
  const handNumber = num(r.hand_number);
  if (handNumber !== null) parts.push(`Hand ${handNumber}`);
  const fold = foldLabel(text(r.fold_type));
  if (fold) parts.push(fold);
  const why = text(r.exit_reason) ?? text(r.close_reason) ?? text(r.reason);
  if (why) parts.push(enumLabel(why));
  const seat = num(r.seat_number ?? r.seat);
  if (seat !== null) parts.push(`Seat ${seat}`);
  return {
    at: text(r.at),
    label: enumLabel(label),
    detail: parts.length ? parts.join(', ') : null,
  };
}

export interface LightningSessionTrail {
  poolSessionId: string | null;
  state: string | null;
  enteredAt: string | null;
  exitedAt: string | null;
  exitReason: string | null;
  steps: LightningTrailStep[];
  transitions: LightningTransition[];
}

export function parseSessionTrail(row: Record<string, unknown>): LightningSessionTrail | null {
  const session = objectOf(row.pool_session) ?? row;
  const stepsRaw = row.trail;
  if (!Array.isArray(stepsRaw)) return null;
  return {
    poolSessionId: idOf(session.pool_session_id),
    state: text(session.state),
    enteredAt: text(session.entered_at),
    exitedAt: text(session.exited_at),
    exitReason: text(session.exit_reason),
    steps: parsedList(stepsRaw, parseTrailStep),
    transitions: parsedList(row.transitions, parseTransition),
  };
}

export function fetchLightningSessionTrail(
  clusterId: string,
  poolSessionId: string,
  client: RpcClient = supabase
): Promise<OperatorAnswer<LightningSessionTrail>> {
  return callDoor(
    'fn_lightning_operator_session_trail',
    () =>
      client.rpc('fn_lightning_operator_session_trail', {
        p_cluster_id: clusterId,
        p_pool_session_id: poolSessionId,
      }),
    (raw) => interpretAnswer(raw, parseSessionTrail)
  );
}

// ─── fn_lightning_operator_signal_review (the only writing operator door) ──

export interface LightningSignalReviewResult {
  signalId: string | null;
  status: string | null;
  reviewedAt: string | null;
}

export function parseSignalReview(row: Record<string, unknown>): LightningSignalReviewResult {
  const signal = objectOf(row.signal) ?? row;
  return {
    signalId: idOf(signal.signal_id ?? signal.id),
    status: text(signal.status),
    reviewedAt: text(signal.reviewed_at),
  };
}

export function reviewLightningSignal(
  signalId: string,
  status: SignalReviewStatus,
  note: string,
  client: RpcClient = supabase
): Promise<OperatorAnswer<LightningSignalReviewResult>> {
  const trimmed = note.trim();
  return callDoor(
    'fn_lightning_operator_signal_review',
    () =>
      client.rpc('fn_lightning_operator_signal_review', {
        p_signal_id: signalId,
        p_status: status,
        p_note: trimmed === '' ? null : trimmed,
      }),
    (raw) => interpretAnswer(raw, parseSignalReview)
  );
}

// ─── Time and ids ──────────────────────────────────────────────────────────

/** Title Cased "how long ago", the operations page's own wording. */
export function agoLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'Unknown';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'Unknown';
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 10) return 'Just Now';
  if (secs < 60) return `${secs}s Ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m Ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h Ago`;
  return `${Math.floor(hours / 24)}d Ago`;
}

/** "Oct 9, 14:32" in the viewer's local time. Never a raw ISO string. */
export function stampLabel(iso: string | null): string {
  if (!iso) return 'Unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** The first eight characters of an id: enough to tell two rows apart. */
export function shortId(id: string | null): string {
  if (!id) return 'Unknown';
  return id.length > 8 ? id.slice(0, 8).toUpperCase() : id.toUpperCase();
}

export const DETAIL_WINDOWS = [
  { key: '1h', label: '1 Hour', ms: 60 * 60 * 1000 },
  { key: '6h', label: '6 Hours', ms: 6 * 60 * 60 * 1000 },
  { key: '24h', label: '24 Hours', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7 Days', ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

export type DetailWindowKey = (typeof DETAIL_WINDOWS)[number]['key'];

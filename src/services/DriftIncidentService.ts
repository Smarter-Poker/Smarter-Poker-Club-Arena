/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DRIFT INCIDENT SERVICE - Financial Drift Incident Dashboard + Actions
 * ═══════════════════════════════════════════════════════════════════════════════
 * Client wrapper around the SECURITY DEFINER incident RPCs:
 *   - fn_ca_incident_dashboard(p_status, p_limit)  -> SETOF jsonb incidents
 *   - fn_ca_incident_action(p_incident_id, p_action, p_note, p_assignee,
 *                           p_root_cause, p_correction_ref) -> {ok, reason?}
 *
 * Incidents track ledger/settlement drift against a 20-minute resolution
 * target. All reads and writes go through the RPCs (clients have no direct
 * table access), mirroring the fn_raise_financial_alert pattern in
 * FinancialAlertService.
 *
 * Usage:
 *   import { DriftIncidentService } from './DriftIncidentService';
 *   const incidents = await DriftIncidentService.getDashboard('open', 200);
 *   await DriftIncidentService.acknowledge(incidentId);
 */

import { supabase } from '../lib/supabase';
import { retryAsync } from '../utils/retryAsync';
import { reportError } from '../utils/errorReporter';

export type IncidentSeverity = 'critical' | 'warning' | 'info';
export type IncidentStatus = 'open' | 'acknowledged' | 'reconciling' | 'resolved';
export type IncidentAction =
  | 'acknowledge'
  | 'assign'
  | 'comment'
  | 'reconciling'
  | 'resolve'
  | 'reopen';
export type AutoRepairStatus =
  | 'pending'
  | 'running'
  | 'repaired'
  | 'manual_needed'
  | 'not_applicable';

export interface GatePanelData {
  gate: {
    run_at: string;
    pass: boolean;
    window_hours: number;
    failing: string[] | null;
    result: Record<string, unknown>;
  } | null;
  supply_series: {
    taken_at: string;
    unexplained: number | null;
    total: number;
    cert_wallets: number | null;
    leaderboard_liability: number | null;
  }[];
  diamond_series: { taken_at: string; unexplained: number | null; total: number }[];
  open_counts: Record<string, number> | null;
  generated_at: string;
}

export type BalanceEntityType = 'club' | 'union' | 'player' | 'agent';

export type BalanceAsOfReadout =
  | {
      found: false;
      accountType: BalanceEntityType;
      asOf: string;
    }
  | {
      found: true;
      accountType: BalanceEntityType;
      asOf: string;
      balance: number;
      recordedAt: string;
      direction: 'Incoming' | 'Outgoing';
    };

/** One entry in an incident's event timeline. */
export interface IncidentEvent {
  at: string;
  kind: string; // created | notified | escalated | repair_action | comment | resolved | ...
  actor: string | null;
  /** Server sends jsonb; normalized to a display string (never an object). */
  detail: string | null;
}

/** Headline numbers from fn_ca_drift_metrics (management-gated, may be {}). */
export interface DriftMetrics {
  open_total?: number;
  open_critical?: number;
  past_target?: number;
  auto_repairing?: number;
  resolved_today?: number;
  median_resolve_min?: number | null;
  worst_open_drift?: number;
  suspense_today?: number;
  ledger_write_failures_24h?: number;
  supply_unexplained_last?: number | null;
  ledger_rows_today?: number;
}

/** Full incident row as returned by fn_ca_incident_dashboard. */
export interface DriftIncident {
  id: string;
  /** True only when the unchanged per-incident action door admits this caller. */
  can_act: boolean;
  detected_at: string;
  deadline_at: string | null;
  classification: string; // 21-value enum (ledger_imbalance, settlement_error, duplicate_payment, ..., unknown)
  severity: IncidentSeverity;
  layer: string | null;
  status: IncidentStatus;
  source: string | null;
  club_id: string | null;
  union_id: string | null;
  table_id: string | null;
  tournament_id: string | null;
  hand_id: string | null;
  settlement_id: string | null;
  currency: string | null;
  expected_amount: number | null;
  actual_amount: number | null;
  discrepancy_amount: number | null;
  ledger_balanced: boolean | null;
  suspected_cause: string | null;
  auto_repair_status: AutoRepairStatus | null;
  escalation_level: number | null;
  past_target: boolean;
  occurrences: number;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  assigned_to: string | null;
  root_cause: string | null;
  correction_ref: string | null;
  resolution: string | null;
  resolved_at: string | null;
  metadata: Record<string, unknown> | null;
  club_name: string | null;
  union_name: string | null;
  age_minutes: number;
  events: IncidentEvent[];
}

export interface IncidentActionResult {
  ok: boolean;
  reason?: string;
}

export interface IncidentActionParams {
  note?: string | null;
  assignee?: string | null;
  rootCause?: string | null;
  correctionRef?: string | null;
}

type JsonRecord = Record<string, unknown>;

const INCIDENT_SEVERITIES = new Set<IncidentSeverity>(['critical', 'warning', 'info']);
const INCIDENT_STATUSES = new Set<IncidentStatus>([
  'open',
  'acknowledged',
  'reconciling',
  'resolved',
]);
const AUTO_REPAIR_STATUSES = new Set<AutoRepairStatus>([
  'pending',
  'running',
  'repaired',
  'manual_needed',
  'not_applicable',
]);
const BALANCE_ENTITY_TYPES = new Set<BalanceEntityType>(['club', 'union', 'player', 'agent']);
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const NO_BALANCE_NOTE = 'no ledger row with a recorded balance at or before this time';
const MAX_GATE_CLOCK_SKEW_MS = 5 * 60 * 1000;

function objectValue(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} could not be verified`);
  }
  return value as JsonRecord;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} could not be verified`);
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : textValue(value, label);
}

function timestampValue(value: unknown, label: string): string {
  const timestamp = textValue(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} could not be verified`);
  }
  return timestamp;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestampValue(value, label);
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} could not be verified`);
  }
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : numberValue(value, label);
}

function countValue(value: unknown, label: string, minimum = 0): number {
  const count = numberValue(value, label);
  if (!Number.isSafeInteger(count) || count < minimum) {
    throw new Error(`${label} could not be verified`);
  }
  return count;
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') throw new Error(`${label} could not be verified`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} could not be verified`);
  return value;
}

function nonnegativeNumber(value: unknown, label: string): number {
  const number = numberValue(value, label);
  if (number < 0) throw new Error(`${label} could not be verified`);
  return number;
}

function nullableNonnegativeNumber(value: unknown, label: string): number | null {
  return value === null ? null : nonnegativeNumber(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} could not be verified`);
  return value.map((entry, index) => textValue(entry, `${label} ${index + 1}`));
}

function uuidValue(value: unknown, label: string): string {
  const id = textValue(value, label);
  if (!UUID_PATTERN.test(id)) throw new Error(`${label} could not be verified`);
  return id;
}

function requireStrictlyAscending(times: string[], label: string): void {
  let prior = Number.NEGATIVE_INFINITY;
  for (const time of times) {
    const next = Date.parse(time);
    if (next <= prior) throw new Error(`${label} could not be verified`);
    prior = next;
  }
}

function normalizeBalanceAsOf(
  value: unknown,
  expectedType: BalanceEntityType,
  expectedEntityId: string,
  expectedAsOf: string
): BalanceAsOfReadout {
  const row = objectValue(value, 'Balance reconstruction');
  const found = booleanValue(row.found, 'Balance reconstruction state');
  const accountType = textValue(
    row.account_type,
    'Balance reconstruction account type'
  ) as BalanceEntityType;
  const entityId = uuidValue(row.entity_id, 'Balance reconstruction entity');
  const asOf = timestampValue(row.as_of, 'Balance reconstruction time');

  if (
    !BALANCE_ENTITY_TYPES.has(accountType) ||
    accountType !== expectedType ||
    entityId.toLowerCase() !== expectedEntityId.toLowerCase() ||
    Date.parse(asOf) !== Date.parse(expectedAsOf)
  ) {
    throw new Error('Balance reconstruction scope could not be verified');
  }

  if (!found) {
    if (textValue(row.note, 'Balance reconstruction note') !== NO_BALANCE_NOTE) {
      throw new Error('Balance reconstruction empty state could not be verified');
    }
    return { found: false, accountType, asOf };
  }

  const recordedAt = timestampValue(row.recorded_at, 'Balance reconstruction record time');
  if (Date.parse(recordedAt) > Date.parse(asOf)) {
    throw new Error('Balance reconstruction timeline could not be verified');
  }
  // Validate the durable source identity even though internal IDs never reach
  // the operator readout.
  uuidValue(row.ledger_row, 'Balance reconstruction ledger row');
  const side = textValue(row.side, 'Balance reconstruction ledger side');
  if (side !== 'from' && side !== 'to') {
    throw new Error('Balance reconstruction ledger side could not be verified');
  }

  return {
    found: true,
    accountType,
    asOf,
    balance: numberValue(row.balance, 'Balance reconstruction balance'),
    recordedAt,
    direction: side === 'to' ? 'Incoming' : 'Outgoing',
  };
}

function normalizeGatePanel(value: unknown): GatePanelData {
  const row = objectValue(value, 'Burn-in gate panel');
  const generatedAt = timestampValue(row.generated_at, 'Burn-in gate generation time');
  const generatedAtMs = Date.parse(generatedAt);
  if (generatedAtMs > Date.now() + MAX_GATE_CLOCK_SKEW_MS) {
    throw new Error('Burn-in gate generation time could not be verified');
  }

  let gate: GatePanelData['gate'] = null;
  if (row.gate !== null) {
    const gateRow = objectValue(row.gate, 'Burn-in gate');
    const pass = booleanValue(gateRow.pass, 'Burn-in gate state');
    const runAt = timestampValue(gateRow.run_at, 'Burn-in gate run time');
    if (Date.parse(runAt) > generatedAtMs) {
      throw new Error('Burn-in gate timeline could not be verified');
    }
    const failing =
      gateRow.failing === null ? null : stringArray(gateRow.failing, 'Burn-in failing check');
    if (pass && failing && failing.length > 0) {
      throw new Error('Burn-in gate result could not be verified');
    }
    gate = {
      run_at: runAt,
      pass,
      window_hours: countValue(gateRow.window_hours, 'Burn-in gate window', 1),
      failing,
      result: objectValue(gateRow.result, 'Burn-in gate result'),
    };
  }

  if (!Array.isArray(row.supply_series) || row.supply_series.length > 48) {
    throw new Error('Burn-in chip supply series could not be verified');
  }
  const supplySeries = row.supply_series.map((value, index) => {
    const point = objectValue(value, `Burn-in chip supply point ${index + 1}`);
    return {
      taken_at: timestampValue(point.taken_at, `Burn-in chip supply point ${index + 1} time`),
      // Unexplained deltas are signed by design; every absolute quantity is not.
      unexplained: nullableNumber(
        point.unexplained,
        `Burn-in chip supply point ${index + 1} unexplained`
      ),
      total: nonnegativeNumber(point.total, `Burn-in chip supply point ${index + 1} total`),
      cert_wallets: nullableNonnegativeNumber(
        point.cert_wallets,
        `Burn-in chip supply point ${index + 1} certified wallets`
      ),
      leaderboard_liability: nullableNonnegativeNumber(
        point.leaderboard_liability,
        `Burn-in chip supply point ${index + 1} leaderboard liability`
      ),
    };
  });

  if (!Array.isArray(row.diamond_series) || row.diamond_series.length > 48) {
    throw new Error('Burn-in diamond supply series could not be verified');
  }
  const diamondSeries = row.diamond_series.map((value, index) => {
    const point = objectValue(value, `Burn-in diamond supply point ${index + 1}`);
    return {
      taken_at: timestampValue(point.taken_at, `Burn-in diamond supply point ${index + 1} time`),
      unexplained: nullableNumber(
        point.unexplained,
        `Burn-in diamond supply point ${index + 1} unexplained`
      ),
      total: nonnegativeNumber(point.total, `Burn-in diamond supply point ${index + 1} total`),
    };
  });

  requireStrictlyAscending(
    supplySeries.map((point) => point.taken_at),
    'Burn-in chip supply timeline'
  );
  requireStrictlyAscending(
    diamondSeries.map((point) => point.taken_at),
    'Burn-in diamond supply timeline'
  );
  if (
    supplySeries.some((point) => Date.parse(point.taken_at) > generatedAtMs) ||
    diamondSeries.some((point) => Date.parse(point.taken_at) > generatedAtMs)
  ) {
    throw new Error('Burn-in supply timeline could not be verified');
  }

  let openCounts: Record<string, number> | null = null;
  if (row.open_counts !== null) {
    const counts = objectValue(row.open_counts, 'Burn-in open incident counts');
    const allowed = new Set<IncidentSeverity>(['critical', 'warning', 'info']);
    openCounts = {};
    for (const [severity, count] of Object.entries(counts)) {
      if (!allowed.has(severity as IncidentSeverity)) {
        throw new Error('Burn-in open incident severity could not be verified');
      }
      openCounts[severity] = countValue(count, `Burn-in open ${severity} incident count`);
    }
  }
  if (gate?.pass && (openCounts?.critical ?? 0) > 0) {
    throw new Error('Burn-in green gate with critical incidents could not be verified');
  }

  return {
    gate,
    supply_series: supplySeries,
    diamond_series: diamondSeries,
    open_counts: openCounts,
    generated_at: generatedAt,
  };
}

function eventDetail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const detail = value as JsonRecord;
    const note = typeof detail.note === 'string' ? detail.note : null;
    const headline = typeof detail.headline === 'string' ? detail.headline : null;
    const action = typeof detail.action === 'string' ? detail.action : null;
    const parts = [headline, note, action].filter(Boolean) as string[];
    if (parts.length > 0) return parts.join(' | ');
  }
  return null;
}

function normalizeIncident(value: unknown): DriftIncident {
  const row = objectValue(value, 'Drift incident');
  const id = uuidValue(row.id, 'Drift incident identity');
  const label = `Drift incident ${id}`;
  const severity = textValue(row.severity, `${label} severity`) as IncidentSeverity;
  const status = textValue(row.status, `${label} status`) as IncidentStatus;
  const repair = nullableText(
    row.auto_repair_status,
    `${label} repair status`
  ) as AutoRepairStatus | null;
  if (
    !INCIDENT_SEVERITIES.has(severity) ||
    !INCIDENT_STATUSES.has(status) ||
    (repair !== null && !AUTO_REPAIR_STATUSES.has(repair))
  ) {
    throw new Error(`${label} state could not be verified`);
  }
  if (!Array.isArray(row.events)) throw new Error(`${label} events could not be verified`);
  const detectedAt = timestampValue(row.detected_at, `${label} detection time`);
  const deadlineAt = nullableTimestamp(row.deadline_at, `${label} deadline`);
  const resolvedAt = nullableTimestamp(row.resolved_at, `${label} resolution time`);
  if (
    (deadlineAt !== null && Date.parse(deadlineAt) < Date.parse(detectedAt)) ||
    (resolvedAt !== null && Date.parse(resolvedAt) < Date.parse(detectedAt))
  ) {
    throw new Error(`${label} timeline could not be verified`);
  }
  // Reopen deliberately preserves prior acknowledgement fields, so only the
  // resolution timestamp is status-defining in the server contract.
  if ((status === 'resolved') !== (resolvedAt !== null)) {
    throw new Error(`${label} resolution state could not be verified`);
  }
  const metadata =
    row.metadata === null ? null : objectValue(row.metadata, 'Drift incident metadata');
  const events = row.events.map((value): IncidentEvent => {
    const event = objectValue(value, 'Drift incident event');
    return {
      at: timestampValue(event.at, 'Drift incident event time'),
      kind: textValue(event.kind, 'Drift incident event kind'),
      actor: nullableText(event.actor, 'Drift incident event actor'),
      detail: eventDetail(event.detail),
    };
  });

  return {
    id,
    can_act: booleanValue(row.can_act, 'Drift incident action authority'),
    detected_at: detectedAt,
    deadline_at: deadlineAt,
    classification: textValue(row.classification, 'Drift incident classification'),
    severity,
    layer: nullableText(row.layer, 'Drift incident layer'),
    status,
    source: nullableText(row.source, 'Drift incident source'),
    club_id: nullableText(row.club_id, 'Drift incident club'),
    union_id: nullableText(row.union_id, 'Drift incident union'),
    table_id: nullableText(row.table_id, 'Drift incident table'),
    tournament_id: nullableText(row.tournament_id, 'Drift incident tournament'),
    hand_id: nullableText(row.hand_id, 'Drift incident hand'),
    settlement_id: nullableText(row.settlement_id, 'Drift incident settlement'),
    currency: nullableText(row.currency, 'Drift incident currency'),
    expected_amount: nullableNumber(row.expected_amount, 'Drift incident expected amount'),
    actual_amount: nullableNumber(row.actual_amount, 'Drift incident actual amount'),
    discrepancy_amount: numberValue(row.discrepancy_amount, 'Drift incident discrepancy'),
    ledger_balanced: nullableBoolean(row.ledger_balanced, 'Drift incident ledger state'),
    suspected_cause: nullableText(row.suspected_cause, 'Drift incident suspected cause'),
    auto_repair_status: repair,
    escalation_level:
      row.escalation_level === null
        ? null
        : countValue(row.escalation_level, 'Drift incident escalation level'),
    past_target:
      typeof row.past_target === 'boolean'
        ? row.past_target
        : (() => {
            throw new Error('Drift incident target state could not be verified');
          })(),
    occurrences: countValue(row.occurrences, 'Drift incident occurrences', 1),
    acknowledged_by: nullableText(row.acknowledged_by, 'Drift incident acknowledger'),
    acknowledged_at: nullableTimestamp(row.acknowledged_at, 'Drift incident acknowledgement time'),
    assigned_to: nullableText(row.assigned_to, 'Drift incident assignee'),
    root_cause: nullableText(row.root_cause, 'Drift incident root cause'),
    correction_ref: nullableText(row.correction_ref, 'Drift incident correction reference'),
    resolution: nullableText(row.resolution, 'Drift incident resolution'),
    resolved_at: resolvedAt,
    metadata,
    club_name: nullableText(row.club_name, 'Drift incident club name'),
    union_name: nullableText(row.union_name, 'Drift incident union name'),
    age_minutes: countValue(row.age_minutes, 'Drift incident age'),
    events,
  };
}

function normalizeMetrics(value: unknown): DriftMetrics {
  const row = objectValue(value, 'Drift metrics');
  const result: DriftMetrics = {};
  const counts: Array<keyof DriftMetrics> = [
    'open_total',
    'open_critical',
    'past_target',
    'auto_repairing',
    'resolved_today',
  ];
  for (const key of counts) {
    result[key] = countValue(row[key], `Drift metric ${key}`);
  }
  result.median_resolve_min =
    row.median_resolve_min === null
      ? null
      : nonnegativeNumber(row.median_resolve_min, 'Drift resolution median');
  result.worst_open_drift = nonnegativeNumber(row.worst_open_drift, 'Worst open drift');
  // Global ledger/supply facts are deliberately absent for a scoped
  // club/union incident recipient. When any one is present, require the whole
  // server-owned bundle so a partial privileged response cannot look valid.
  const globalKeys = [
    'suspense_today',
    'ledger_write_failures_24h',
    'supply_unexplained_last',
    'ledger_rows_today',
  ] as const;
  const globalKeyCount = globalKeys.filter((key) => row[key] !== undefined).length;
  if (globalKeyCount !== 0 && globalKeyCount !== globalKeys.length) {
    throw new Error('Global drift metrics could not be verified');
  }
  if (globalKeyCount === globalKeys.length) {
    result.suspense_today = numberValue(row.suspense_today, 'Unclassified flow');
    result.ledger_write_failures_24h = countValue(
      row.ledger_write_failures_24h,
      'Ledger write failures'
    );
    result.supply_unexplained_last = nullableNumber(
      row.supply_unexplained_last,
      'Latest unexplained supply'
    );
    result.ledger_rows_today = countValue(row.ledger_rows_today, 'Ledger rows today');
  }
  return result;
}

export const DriftIncidentService = {
  /**
   * Load the incident dashboard. Pass status = null for ALL statuses
   * (the page filters client-side so stat cards see the full picture).
   */
  async getDashboard(status: IncidentStatus | null = null, limit = 200): Promise<DriftIncident[]> {
    if (status !== null && !INCIDENT_STATUSES.has(status)) {
      throw new Error('Drift incident status filter is invalid');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Drift incident page limit is invalid');
    }
    const { data, error } = await retryAsync(() =>
      supabase.rpc('fn_ca_incident_dashboard', {
        p_status: status,
        p_limit: limit,
      })
    );

    if (error) {
      reportError(error, 'DriftIncidentService.getDashboard', { status, limit });
      throw error;
    }

    if (!Array.isArray(data) || data.length > limit) {
      throw new Error('Drift incident dashboard could not be verified');
    }
    const incidents = data.map(normalizeIncident);
    const ids = incidents.map((incident) => incident.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error('Drift incident dashboard contains duplicate incidents');
    }
    return incidents;
  },

  /** Headline drift metrics for the stat row (suspense flow, repairs, etc). */
  async getMetrics(): Promise<DriftMetrics> {
    const { data, error } = await retryAsync(() => supabase.rpc('fn_ca_drift_metrics'));
    if (error) {
      reportError(error, 'DriftIncidentService.getMetrics');
      throw error;
    }
    return normalizeMetrics(data);
  },

  /**
   * Burn-in gate status + 24h supply/diamond trend series for the gate
   * panel. Returns null for non-management callers (the RPC checks).
   */
  async getGatePanel(): Promise<GatePanelData | null> {
    const { data, error } = await retryAsync(() => supabase.rpc('fn_ca_gate_panel'));
    if (error) {
      reportError(error, 'DriftIncidentService.getGatePanel');
      throw error;
    }
    return data === null ? null : normalizeGatePanel(data);
  },

  /**
   * Point-in-time balance reconstruction from the ledger. Management only
   * (the RPC checks the caller and returns null otherwise).
   */
  async getBalanceAsOf(
    entityType: string,
    entityId: string,
    asOfIso: string
  ): Promise<BalanceAsOfReadout | null> {
    if (!BALANCE_ENTITY_TYPES.has(entityType as BalanceEntityType)) {
      throw new Error('Balance reconstruction entity type is invalid');
    }
    const verifiedEntityId = uuidValue(entityId, 'Balance reconstruction entity');
    const verifiedAsOf = timestampValue(asOfIso, 'Balance reconstruction time');
    const { data, error } = await retryAsync(() =>
      supabase.rpc('fn_ca_balance_asof_admin', {
        p_entity_type: entityType,
        p_entity_id: verifiedEntityId,
        p_asof: verifiedAsOf,
      })
    );
    if (error) {
      reportError(error, 'DriftIncidentService.getBalanceAsOf', { entityType, entityId });
      throw error;
    }
    return data === null
      ? null
      : normalizeBalanceAsOf(data, entityType as BalanceEntityType, verifiedEntityId, verifiedAsOf);
  },

  /**
   * Perform a workflow action on an incident. Never throws on a server-side
   * refusal - the RPC's {ok:false, reason} comes back for the UI to show.
   */
  async act(
    incidentId: string,
    action: IncidentAction,
    params: IncidentActionParams = {}
  ): Promise<IncidentActionResult> {
    const { data, error } = await retryAsync(() =>
      supabase.rpc('fn_ca_incident_action', {
        p_incident_id: incidentId,
        p_action: action,
        p_note: params.note ?? null,
        p_assignee: params.assignee ?? null,
        p_root_cause: params.rootCause ?? null,
        p_correction_ref: params.correctionRef ?? null,
      })
    );

    if (error) {
      reportError(error, 'DriftIncidentService.act', { incidentId, action });
      throw error;
    }

    const result = objectValue(data, 'Incident action result');
    if (
      typeof result.ok !== 'boolean' ||
      (result.reason !== undefined && typeof result.reason !== 'string')
    ) {
      throw new Error('Incident action result could not be verified');
    }
    return { ok: result.ok, reason: result.reason as string | undefined };
  },

  /** Acknowledge an open incident (it stays on the dashboard until resolved). */
  async acknowledge(incidentId: string, note?: string | null): Promise<IncidentActionResult> {
    return this.act(incidentId, 'acknowledge', { note });
  },

  /** Mark an incident as actively being reconciled. */
  async markReconciling(incidentId: string, note?: string | null): Promise<IncidentActionResult> {
    return this.act(incidentId, 'reconciling', { note });
  },

  /** Append a comment to the incident's event timeline. */
  async comment(incidentId: string, note: string): Promise<IncidentActionResult> {
    return this.act(incidentId, 'comment', { note });
  },

  /** Assign the incident to an operator. */
  async assign(
    incidentId: string,
    assignee: string,
    note?: string | null
  ): Promise<IncidentActionResult> {
    return this.act(incidentId, 'assign', { assignee, note });
  },

  /**
   * Resolve an incident. The server requires a root cause for incidents
   * classified 'unknown'; pass rootCause/correctionRef when known.
   */
  async resolve(
    incidentId: string,
    params: IncidentActionParams = {}
  ): Promise<IncidentActionResult> {
    return this.act(incidentId, 'resolve', params);
  },

  /** Reopen a resolved incident. */
  async reopen(incidentId: string, note?: string | null): Promise<IncidentActionResult> {
    return this.act(incidentId, 'reopen', { note });
  },
};

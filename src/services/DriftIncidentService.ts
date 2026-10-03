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
  return JSON.stringify(value);
}

function normalizeIncident(value: unknown): DriftIncident {
  const row = objectValue(value, 'Drift incident');
  const severity = textValue(row.severity, 'Drift incident severity') as IncidentSeverity;
  const status = textValue(row.status, 'Drift incident status') as IncidentStatus;
  const repair = nullableText(
    row.auto_repair_status,
    'Drift incident repair status'
  ) as AutoRepairStatus | null;
  if (
    !INCIDENT_SEVERITIES.has(severity) ||
    !INCIDENT_STATUSES.has(status) ||
    (repair !== null && !AUTO_REPAIR_STATUSES.has(repair))
  ) {
    throw new Error('Drift incident state could not be verified');
  }
  if (!Array.isArray(row.events)) throw new Error('Drift incident events could not be verified');
  const detectedAt = timestampValue(row.detected_at, 'Drift incident detection time');
  const deadlineAt = nullableTimestamp(row.deadline_at, 'Drift incident deadline');
  const resolvedAt = nullableTimestamp(row.resolved_at, 'Drift incident resolution time');
  if (
    (deadlineAt !== null && Date.parse(deadlineAt) < Date.parse(detectedAt)) ||
    (resolvedAt !== null && Date.parse(resolvedAt) < Date.parse(detectedAt))
  ) {
    throw new Error('Drift incident timeline could not be verified');
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
    id: textValue(row.id, 'Drift incident identity'),
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
    'ledger_write_failures_24h',
    'ledger_rows_today',
  ];
  for (const key of counts) {
    if (row[key] !== undefined) result[key] = countValue(row[key], `Drift metric ${key}`);
  }
  if (row.median_resolve_min !== undefined) {
    result.median_resolve_min =
      row.median_resolve_min === null
        ? null
        : Math.max(numberValue(row.median_resolve_min, 'Drift resolution median'), 0);
  }
  if (row.worst_open_drift !== undefined) {
    result.worst_open_drift = Math.max(numberValue(row.worst_open_drift, 'Worst open drift'), 0);
  }
  if (row.suspense_today !== undefined) {
    result.suspense_today = numberValue(row.suspense_today, 'Unclassified flow');
  }
  if (row.supply_unexplained_last !== undefined) {
    result.supply_unexplained_last = nullableNumber(
      row.supply_unexplained_last,
      'Latest unexplained supply'
    );
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
      return null;
    }
    return (data as GatePanelData) ?? null;
  },

  /**
   * Point-in-time balance reconstruction from the ledger. Management only
   * (the RPC checks the caller and returns null otherwise).
   */
  async getBalanceAsOf(
    entityType: string,
    entityId: string,
    asOfIso: string
  ): Promise<Record<string, unknown> | null> {
    const { data, error } = await retryAsync(() =>
      supabase.rpc('fn_ca_balance_asof_admin', {
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_asof: asOfIso,
      })
    );
    if (error) {
      reportError(error, 'DriftIncidentService.getBalanceAsOf', { entityType, entityId });
      throw error;
    }
    return data === null ? null : objectValue(data, 'Balance reconstruction');
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

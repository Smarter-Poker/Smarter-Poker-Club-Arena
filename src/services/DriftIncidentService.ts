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

function normalizeIncident(row: any): DriftIncident {
  return {
    id: row.id,
    detected_at: row.detected_at,
    deadline_at: row.deadline_at ?? null,
    classification: row.classification || 'unknown',
    severity: row.severity || 'info',
    layer: row.layer ?? null,
    status: row.status || 'open',
    source: row.source ?? null,
    club_id: row.club_id ?? null,
    union_id: row.union_id ?? null,
    table_id: row.table_id ?? null,
    tournament_id: row.tournament_id ?? null,
    hand_id: row.hand_id ?? null,
    settlement_id: row.settlement_id ?? null,
    currency: row.currency ?? null,
    expected_amount: row.expected_amount ?? null,
    actual_amount: row.actual_amount ?? null,
    discrepancy_amount: row.discrepancy_amount ?? null,
    ledger_balanced: row.ledger_balanced ?? null,
    suspected_cause: row.suspected_cause ?? null,
    auto_repair_status: row.auto_repair_status ?? null,
    escalation_level: row.escalation_level ?? null,
    past_target: Boolean(row.past_target),
    occurrences: Number(row.occurrences ?? 1),
    acknowledged_by: row.acknowledged_by ?? null,
    acknowledged_at: row.acknowledged_at ?? null,
    assigned_to: row.assigned_to ?? null,
    root_cause: row.root_cause ?? null,
    correction_ref: row.correction_ref ?? null,
    resolution: row.resolution ?? null,
    resolved_at: row.resolved_at ?? null,
    metadata: row.metadata ?? null,
    club_name: row.club_name ?? null,
    union_name: row.union_name ?? null,
    age_minutes: Number(row.age_minutes ?? 0),
    events: Array.isArray(row.events)
      ? row.events.map((e: any) => ({
          at: e.at,
          kind: e.kind || 'comment',
          actor: e.actor ?? null,
          // jsonb detail arrives as an object; rendering an object as a React
          // child crashes, so normalize to a compact string here.
          detail:
            e.detail === null || e.detail === undefined
              ? null
              : typeof e.detail === 'string'
                ? e.detail
                : (() => {
                    try {
                      const obj = e.detail as Record<string, unknown>;
                      const note = obj && typeof obj.note === 'string' ? obj.note : null;
                      const headline =
                        obj && typeof obj.headline === 'string' ? obj.headline : null;
                      const action = obj && typeof obj.action === 'string' ? obj.action : null;
                      const parts = [headline, note, action].filter(Boolean) as string[];
                      return parts.length > 0 ? parts.join(' | ') : JSON.stringify(obj);
                    } catch {
                      return String(e.detail);
                    }
                  })(),
        }))
      : [],
  };
}

export const DriftIncidentService = {
  /**
   * Load the incident dashboard. Pass status = null for ALL statuses
   * (the page filters client-side so stat cards see the full picture).
   */
  async getDashboard(status: IncidentStatus | null = null, limit = 200): Promise<DriftIncident[]> {
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

    return ((data as any[]) || []).map(normalizeIncident);
  },

  /** Headline drift metrics for the stat row (suspense flow, repairs, etc). */
  async getMetrics(): Promise<DriftMetrics> {
    const { data, error } = await retryAsync(() => supabase.rpc('fn_ca_drift_metrics'));
    if (error) {
      reportError(error, 'DriftIncidentService.getMetrics');
      return {};
    }
    return (data as DriftMetrics) || {};
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
    return (data as Record<string, unknown>) ?? null;
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

    const result = (data as any) || {};
    return { ok: Boolean(result.ok), reason: result.reason };
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

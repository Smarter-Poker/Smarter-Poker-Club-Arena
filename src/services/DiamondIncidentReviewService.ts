/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND INCIDENT REVIEW - the platform staff doors onto ca_diamond_incidents
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 4, item 3 of the build list in
 * docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md. Staff read Diamond incidents by
 * status, rule and severity, a page at a time, with every open row counted per
 * rule family; they acknowledge, comment on, resolve and reopen one row with a
 * written reason; and they close a whole rule family in one act with one
 * reason. Every act names its reviewer on the row and in an append-only trail.
 *
 * Every door lives in SQL and checks staff itself (fn_is_platform_admin), in
 * migration 20260929211500_a_person_can_review_a_diamond_incident.sql:
 *   fn_ca_diamond_incident_board(p_status, p_rule, p_severity, p_before_id, p_limit)
 *   fn_ca_diamond_incident_trail(p_incident_id)
 *   fn_ca_diamond_incident_review(p_incident_id, p_action, p_note)
 *   fn_ca_diamond_incident_resolve_family(p_family, p_severity, p_filed_before, p_reason)
 * The route guard (PlatformStaffGuard) is a courtesy; the doors are the lock.
 *
 * NOTHING IS DECIDED HERE. A refusal comes back as { success: false, error }
 * and is printed through INCIDENT_REFUSAL_COPY. A transport failure (the RPC
 * itself erred) throws DiamondIncidentTransportError after it is reported.
 *
 * THE CONTRACT IS PINNED. tests/unit/diamondIncidentReviewService.test.ts reads
 * the migration and proves that every RPC and `p_` key sent below matches the
 * door's signature and grant, and that every refusal code the doors can return
 * has Title Case copy here.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export type IncidentSeverity = 'info' | 'warning' | 'critical';

/** A row's own status: open (not yet acknowledged), acknowledged, resolved. */
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

/** The board's status filter: unresolved is open or acknowledged. */
export type IncidentStatusFilter = 'all' | 'unresolved' | IncidentStatus;

/**
 * Who closed a resolved row: a person through these doors; a watch, which
 * wrote what it read ("auto: ..."); or unrecorded, closed with no note (the
 * seven-day info sweep writes none, and neither did the bulk closures of
 * 2026-09-03 to 2026-09-08).
 */
export type IncidentClosedBy = 'person' | 'watch' | 'unrecorded';

export type ReviewAction = 'acknowledge' | 'comment' | 'resolve' | 'reopen';

export type IncidentEventKind = 'acknowledged' | 'comment' | 'resolved' | 'reopened';

/** One ca_diamond_incidents row, as fn_ca_diamond_incident_json writes it. */
export interface DiamondIncident {
  id: number;
  occurred_at: string;
  rule: string;
  /** The part of the rule before its colon: DR7 for DR7:user_over_daily_cap. */
  family: string;
  severity: IncidentSeverity;
  user_id: string | null;
  amount: number | null;
  writer: string | null;
  db_role: string;
  app_name: string;
  detail: Record<string, unknown>;
  status: IncidentStatus;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledged_by_label: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_label: string | null;
  resolution: string | null;
  closed_by: IncidentClosedBy | null;
  reopened_at: string | null;
  reopened_by: string | null;
  reopened_by_label: string | null;
  /** A person reopened it: no watch will close it, it waits for a person. */
  held: boolean;
}

/** Open rows of one rule. */
export interface IncidentRuleCount {
  rule: string;
  open: number;
  critical: number;
  warning: number;
  info: number;
  acknowledged: number;
  held: number;
  older_than_7_days: number;
  oldest: string;
  newest: string;
}

/** Open rows of one rule family, and of each rule in it. */
export interface IncidentFamilyCount extends Omit<IncidentRuleCount, 'rule'> {
  family: string;
  rules: IncidentRuleCount[];
}

export interface IncidentBoard {
  incidents: DiamondIncident[];
  /** Pass back as beforeId for the next page; null on the last page. */
  next_before_id: number | null;
  /** Every open row counted per family, whatever the filter. */
  families: IncidentFamilyCount[];
  as_of: string;
}

export interface IncidentEvent {
  id: number;
  incident_id: number;
  at: string;
  kind: IncidentEventKind;
  actor: string;
  actor_label: string | null;
  /** note, rule, severity; a reopened event adds previous; a family act adds act. */
  detail: Record<string, unknown>;
}

export interface IncidentTrail {
  /** Null when the prune has deleted the row: its trail still stands. */
  incident: DiamondIncident | null;
  events: IncidentEvent[];
}

export interface ReviewResult {
  action: ReviewAction;
  event_id: number;
  incident: DiamondIncident;
}

export interface FamilyResolution {
  act_id: string;
  family: string;
  severity: IncidentSeverity | null;
  filed_before: string;
  resolved: number;
  /** Rows a person reopened are left for a person, one at a time. */
  skipped_reopened: number;
  by_rule: Record<string, number>;
}

export interface BoardFilter {
  status: IncidentStatusFilter | null;
  /** One family (DR7) or one rule (DR7:user_over_daily_cap); null for all. */
  rule: string | null;
  severity: IncidentSeverity | null;
  /** The next_before_id of the page before; null for the first page. */
  beforeId: number | null;
  /** 1 to 200; the door clamps it. */
  limit?: number;
}

/* ── Door answers ─────────────────────────────────────────────────────────── */

export interface Refusal {
  success: false;
  error: string;
  [key: string]: unknown;
}

export type ReviewAnswer<T> = (T & { success: true }) | Refusal;

export function isRefusal(res: unknown): res is Refusal {
  return !!res && typeof res === 'object' && (res as { success?: unknown }).success === false;
}

export class DiamondIncidentTransportError extends Error {
  constructor(where: string) {
    super(`The Server Could Not Be Reached To ${where}. Check Your Connection And Try Again.`);
    this.name = 'DiamondIncidentTransportError';
  }
}

async function call<T>(fn: string, args: Record<string, unknown>, where: string): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    reportError(error, `DiamondIncidentReviewService.${fn}`);
    throw new DiamondIncidentTransportError(where);
  }
  if (data === null || data === undefined) {
    reportError(new Error(`${fn} returned no data`), `DiamondIncidentReviewService.${fn}`);
    throw new DiamondIncidentTransportError(where);
  }
  return data as T;
}

function review(
  incidentId: number,
  action: ReviewAction,
  note: string | null,
  where: string
): Promise<ReviewAnswer<ReviewResult>> {
  return call(
    'fn_ca_diamond_incident_review',
    { p_incident_id: incidentId, p_action: action, p_note: note },
    where
  );
}

/**
 * The doors, one method each (the review door by action). Every argument key
 * is the migration's own `p_` name, and every key is always sent (never
 * undefined): PostgREST picks a function by the names it receives, so a
 * dropped key is a different call.
 */
const DiamondIncidentReviewService = {
  board(filter: BoardFilter): Promise<ReviewAnswer<IncidentBoard>> {
    return call(
      'fn_ca_diamond_incident_board',
      {
        p_status: filter.status,
        p_rule: filter.rule,
        p_severity: filter.severity,
        p_before_id: filter.beforeId,
        p_limit: filter.limit ?? 50,
      },
      'Read Diamond Incidents'
    );
  },

  trail(incidentId: number): Promise<ReviewAnswer<IncidentTrail>> {
    return call(
      'fn_ca_diamond_incident_trail',
      { p_incident_id: incidentId },
      'Read The Incident Trail'
    );
  },

  acknowledge(incidentId: number, note: string | null): Promise<ReviewAnswer<ReviewResult>> {
    return review(incidentId, 'acknowledge', note, 'Acknowledge The Incident');
  },

  comment(incidentId: number, note: string): Promise<ReviewAnswer<ReviewResult>> {
    return review(incidentId, 'comment', note, 'Comment On The Incident');
  },

  resolve(incidentId: number, reason: string): Promise<ReviewAnswer<ReviewResult>> {
    return review(incidentId, 'resolve', reason, 'Resolve The Incident');
  },

  reopen(incidentId: number, reason: string): Promise<ReviewAnswer<ReviewResult>> {
    return review(incidentId, 'reopen', reason, 'Reopen The Incident');
  },

  /**
   * Resolve every open row of one family (or one rule), at one severity or
   * all, filed at or before filedBefore (null is now), with one reason.
   */
  resolveFamily(
    family: string,
    severity: IncidentSeverity | null,
    filedBefore: string | null,
    reason: string
  ): Promise<ReviewAnswer<FamilyResolution>> {
    return call(
      'fn_ca_diamond_incident_resolve_family',
      { p_family: family, p_severity: severity, p_filed_before: filedBefore, p_reason: reason },
      'Resolve The Rule Family'
    );
  },
};

export default DiamondIncidentReviewService;

/**
 * Every code the review doors can return, in the words staff read. Title Case,
 * no em dashes. Pinned against the migration by
 * tests/unit/diamondIncidentReviewService.test.ts: a code added in SQL without
 * a line here fails that test.
 */
export const INCIDENT_REFUSAL_COPY: Readonly<Record<string, string>> = {
  // Every door
  staff_required: 'Only Platform Staff Can Review Diamond Incidents',
  // The review door and the family door
  authentication_required: 'Sign In Again To Review Diamond Incidents',
  note_too_long: 'The Note Is Too Long. Keep It Under 2,000 Characters',
  reason_required: 'Write A Reason Of At Least 10 Characters',
  // fn_ca_diamond_incident_board
  invalid_status: 'Choose All, Unresolved, Open, Acknowledged Or Resolved',
  invalid_severity: 'Choose Info, Warning Or Critical',
  // fn_ca_diamond_incident_trail and fn_ca_diamond_incident_review
  incident_not_found: 'That Incident No Longer Exists. Refresh The Board',
  // fn_ca_diamond_incident_review
  unknown_action: 'Choose Acknowledge, Comment, Resolve Or Reopen',
  note_required: 'Write The Comment First',
  already_acknowledged:
    'Another Staff Member Already Acknowledged This Incident. Refresh The Board',
  already_resolved: 'This Incident Is Already Resolved. Reopen It First To Change The Answer',
  not_resolved: 'Only A Resolved Incident Can Be Reopened',
  // fn_ca_diamond_incident_resolve_family
  family_required: 'Name The Rule Family Or The Rule To Resolve',
  nothing_to_resolve: 'Nothing Open In That Family Was Filed Before That Time. Refresh The Board',
};

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The staff sentence for a refusal code, never the raw code. */
export function incidentRefusalCopy(
  code: string | null | undefined,
  fallback = 'The Server Refused That Review'
): string {
  if (code && hasOwn(INCIDENT_REFUSAL_COPY, code)) return INCIDENT_REFUSAL_COPY[code];
  return fallback;
}

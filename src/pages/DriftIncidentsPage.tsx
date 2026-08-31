/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DRIFT INCIDENTS PAGE — Ops Dashboard for Financial Drift Incidents
 * ═══════════════════════════════════════════════════════════════════════════════
 * Lists drift incidents from fn_ca_incident_dashboard with the 20-minute
 * resolution-target countdown, expected vs actual amounts, auto-repair status,
 * event timeline and the full acknowledge/reconcile/resolve/reopen workflow.
 *
 * NOTE: acknowledging an incident does NOT hide it. Acted-on incidents are
 * pinned into the current filter view so the card visibly changes state in
 * place instead of vanishing.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  DriftIncidentService,
  DriftIncident,
  DriftMetrics,
  IncidentAction,
  IncidentStatus,
} from '../services/DriftIncidentService';
import PageSkeleton from '../components/common/PageSkeleton';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { reportError } from '../utils/errorReporter';
import './DriftIncidentsPage.css';

const TWENTY_MINUTES_MS = 20 * 60 * 1000;
const AUTO_REFRESH_MS = 30 * 1000;

const STATUS_TABS: { key: IncidentStatus; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'acknowledged', label: 'Acknowledged' },
  { key: 'reconciling', label: 'Reconciling' },
  { key: 'resolved', label: 'Resolved' },
];

const EVENT_GLYPHS: Record<string, string> = {
  created: '●',
  notified: '◌',
  escalated: '▲',
  repair_action: '↻',
  comment: '✎',
  resolved: '✓',
};

/** HIGH_HAND -> "High Hand" (KNOWN BUG PATTERN: format raw DB enums before display). */
function formatEnum(value: string): string {
  return value
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatAmount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '--';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

export default function DriftIncidentsPage() {
  const toast = useToast();
  useVisibilityRefresh(() => loadIncidents());

  const [incidents, setIncidents] = useState<DriftIncident[]>([]);
  const [metrics, setMetrics] = useState<DriftMetrics>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<IncidentStatus>('open');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Incidents acted on stay visible in the current tab even after their
  // status changes (e.g. an acknowledged incident must NOT disappear from
  // the Open tab the operator is looking at).
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const loadingRef = useRef(false);

  const loadIncidents = useCallback(async (getIsMounted?: () => boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      // Always load ALL statuses: the stat cards need the full picture and
      // tab filtering happens client-side.
      const [data, m] = await Promise.all([
        DriftIncidentService.getDashboard(null, 500),
        DriftIncidentService.getMetrics(),
      ]);
      if (getIsMounted && !getIsMounted()) return;
      setIncidents(data);
      setMetrics(m);
    } catch (err) {
      if (getIsMounted && !getIsMounted()) return;
      reportError(err, 'DriftIncidentsPage.Failed_to_load_incidents');
      toast.error('Failed to load drift incidents');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    loadIncidents(() => isMounted);
    return () => {
      isMounted = false;
    };
  }, [loadIncidents]);

  // ── Auto-refresh every 30s ──
  useEffect(() => {
    let isMounted = true;
    const timer = setInterval(() => {
      if (isMounted) loadIncidents(() => isMounted);
    }, AUTO_REFRESH_MS);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [loadIncidents]);

  // ── 1s ticker for the deadline countdowns ──
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const changeFilter = (next: IncidentStatus) => {
    setFilter(next);
    setPinned(new Set()); // pins only survive within the tab they happened in
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAction = async (incident: DriftIncident, action: IncidentAction) => {
    let note: string | null = null;
    let rootCause: string | null = null;

    if (action === 'comment') {
      const input = window.prompt('Add A Comment To This Incident');
      if (input === null) return;
      note = input.trim();
      if (!note) return;
    }

    if (action === 'resolve') {
      if (incident.classification === 'unknown') {
        const rc = window.prompt(
          'Root Cause Is Required To Resolve An Incident Classified As Unknown'
        );
        if (rc === null) return;
        rootCause = rc.trim();
        if (!rootCause) {
          toast.error('A root cause note is required to resolve an unknown incident');
          return;
        }
      }
      const input = window.prompt('Resolution Note (Leave Empty To Skip)');
      if (input === null) return;
      note = input.trim() || null;
    }

    if (action === 'reopen') {
      const input = window.prompt('Reason For Reopening (Leave Empty To Skip)');
      if (input === null) return;
      note = input.trim() || null;
    }

    setActing(`${incident.id}:${action}`);
    try {
      const result = await DriftIncidentService.act(incident.id, action, {
        note,
        rootCause,
      });
      if (!result.ok) {
        toast.error(result.reason || 'Incident action was refused');
      } else {
        // Keep the card visible in the current tab so the state change is
        // seen in place, never as a disappearance.
        setPinned((prev) => new Set(prev).add(incident.id));
        if (action === 'acknowledge') {
          toast.success('Incident acknowledged. It stays listed until resolved');
        } else if (action === 'reconciling') {
          toast.success('Incident marked reconciling');
        } else if (action === 'comment') {
          toast.success('Comment added');
        } else if (action === 'resolve') {
          toast.success('Incident resolved');
        } else if (action === 'reopen') {
          toast.success('Incident reopened');
        }
        await loadIncidents();
      }
    } catch (err) {
      reportError(err, 'DriftIncidentsPage.Incident_action_failed', {
        incidentId: incident.id,
        action,
      });
      toast.error('Incident action failed');
    }
    setActing(null);
  };

  const actionsFor = (
    i: DriftIncident
  ): { action: IncidentAction; label: string; className: string }[] => {
    if (i.status === 'resolved') {
      return [
        { action: 'reopen', label: 'Reopen', className: 'di-btn di-btn-reopen' },
        { action: 'comment', label: 'Comment', className: 'di-btn di-btn-comment' },
      ];
    }
    const list: { action: IncidentAction; label: string; className: string }[] = [];
    if (i.status === 'open') {
      list.push({ action: 'acknowledge', label: 'Acknowledge', className: 'di-btn di-btn-ack' });
    }
    if (i.status !== 'reconciling') {
      list.push({
        action: 'reconciling',
        label: 'Mark Reconciling',
        className: 'di-btn di-btn-reconcile',
      });
    }
    list.push({ action: 'comment', label: 'Comment', className: 'di-btn di-btn-comment' });
    list.push({ action: 'resolve', label: 'Resolve', className: 'di-btn di-btn-resolve' });
    return list;
  };

  const renderDeadline = (i: DriftIncident) => {
    if (i.status === 'resolved') {
      const mins = i.resolved_at
        ? Math.max(
            0,
            (new Date(i.resolved_at).getTime() - new Date(i.detected_at).getTime()) / 60000
          )
        : null;
      return (
        <span className="di-deadline resolved">
          {mins === null ? 'Resolved' : `Resolved In ${formatMinutes(mins)}`}
        </span>
      );
    }
    const deadline = i.deadline_at
      ? new Date(i.deadline_at).getTime()
      : new Date(i.detected_at).getTime() + TWENTY_MINUTES_MS;
    const remainMs = deadline - nowMs;
    const past = i.past_target || remainMs <= 0;
    const absMs = Math.abs(remainMs);
    const mm = Math.floor(absMs / 60000);
    const ss = Math.floor((absMs % 60000) / 1000);
    const ssStr = (ss < 10 ? '0' : '') + ss;
    return (
      <span className={`di-deadline ${past ? 'past' : ''}`}>
        {past ? `Past Target By ${mm}m ${ssStr}s` : `${mm}m ${ssStr}s Left`}
      </span>
    );
  };

  // ── Stats (computed over ALL loaded incidents, not just the visible tab) ──
  const openCount = incidents.filter((i) => i.status === 'open').length;
  const pastTargetCount = incidents.filter((i) => i.status !== 'resolved' && i.past_target).length;
  const unresolvedWithDrift = incidents.filter(
    (i) => i.status !== 'resolved' && i.discrepancy_amount !== null
  );
  const worst =
    unresolvedWithDrift.length > 0
      ? unresolvedWithDrift.reduce((w, i) =>
          Math.abs(i.discrepancy_amount || 0) > Math.abs(w.discrepancy_amount || 0) ? i : w
        )
      : null;
  const resolvedWithTimes = incidents.filter((i) => i.status === 'resolved' && i.resolved_at);
  const avgResolutionMins =
    resolvedWithTimes.length > 0
      ? resolvedWithTimes.reduce(
          (sum, i) =>
            sum +
            (new Date(i.resolved_at as string).getTime() - new Date(i.detected_at).getTime()) /
              60000,
          0
        ) / resolvedWithTimes.length
      : null;

  const countFor = (status: IncidentStatus) => incidents.filter((i) => i.status === status).length;

  const filteredIncidents = incidents.filter((i) => i.status === filter || pinned.has(i.id));

  const statCards = [
    {
      label: 'Open Incidents',
      value: String(openCount),
      alert: openCount > 0,
    },
    {
      label: 'Past 20m Target',
      value: String(pastTargetCount),
      alert: pastTargetCount > 0,
    },
    {
      label: 'Worst Discrepancy',
      value: worst
        ? `${formatAmount(Math.abs(worst.discrepancy_amount || 0))}${
            worst.currency ? ` ${worst.currency}` : ''
          }`
        : '--',
      alert: worst !== null,
    },
    {
      label: 'Avg Resolution Age',
      value: avgResolutionMins === null ? '--' : formatMinutes(avgResolutionMins),
      alert: false,
    },
    {
      label: 'Auto-Repairing',
      value: String(metrics.auto_repairing ?? 0),
      alert: false,
    },
    {
      label: 'Unclassified Flow Today',
      value: metrics.suspense_today === undefined ? '--' : formatAmount(metrics.suspense_today),
      alert: (metrics.suspense_today ?? 0) > 0,
    },
  ];

  if (loading && incidents.length === 0) {
    return (
      <div className="drift-incidents-page">
        <div className="di-header">
          <h2>Drift Incidents</h2>
        </div>
        <div className="di-loading-state">
          <PageSkeleton variant="financial" />
          <p>Loading Incidents...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="drift-incidents-page">
      {/* Header */}
      <div className="di-header">
        <h2>Drift Incidents</h2>
        <div className="di-header-right">
          {loading && incidents.length > 0 && <span className="di-syncing">Syncing...</span>}
          <button
            className="di-refresh-btn"
            onClick={() => loadIncidents()}
            title="Refresh"
            disabled={loading}
          >
            ↻
          </button>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="di-stats-grid">
        {statCards.map((card) => (
          <div key={card.label} className={`di-stat-card ${card.alert ? 'alert' : ''}`}>
            <span className="di-stat-label">{card.label}</span>
            <span className="di-stat-value">{card.value}</span>
          </div>
        ))}
      </div>

      {/* Filter Tabs */}
      <div className="di-filter-tabs">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            className={`di-filter-tab status-${tab.key} ${filter === tab.key ? 'active' : ''}`}
            onClick={() => changeFilter(tab.key)}
          >
            {tab.label} ({countFor(tab.key)})
          </button>
        ))}
      </div>

      {/* Incident List */}
      {filteredIncidents.length === 0 ? (
        <div className="di-empty-state">
          <span className="di-empty-icon">◉</span>
          <p>No {formatEnum(filter)} incidents</p>
        </div>
      ) : (
        <div className="di-list">
          {filteredIncidents.map((incident) => {
            const isExpanded = expanded.has(incident.id);
            const refChips: { label: string; value: string }[] = [];
            if (incident.table_id) refChips.push({ label: 'Table', value: incident.table_id });
            if (incident.tournament_id)
              refChips.push({ label: 'Tournament', value: incident.tournament_id });
            if (incident.hand_id) refChips.push({ label: 'Hand', value: incident.hand_id });
            if (incident.settlement_id)
              refChips.push({ label: 'Settlement', value: incident.settlement_id });

            return (
              <div
                key={incident.id}
                className={`di-card severity-${incident.severity} ${
                  incident.past_target && incident.status !== 'resolved' ? 'past-target' : ''
                }`}
              >
                {/* Card head (click to expand) */}
                <button
                  type="button"
                  className="di-card-head"
                  onClick={() => toggleExpanded(incident.id)}
                  aria-expanded={isExpanded}
                >
                  <div className="di-card-badges">
                    <span className={`di-severity-badge ${incident.severity}`}>
                      {incident.severity === 'critical' ? '●' : '◐'}{' '}
                      {incident.severity.toUpperCase()}
                    </span>
                    <span className="di-class-badge">{formatEnum(incident.classification)}</span>
                    <span className={`di-status-badge ${incident.status}`}>
                      {formatEnum(incident.status)}
                    </span>
                    {incident.occurrences > 1 && (
                      <span className="di-occurrences" title="Times this drift has recurred">
                        Seen {incident.occurrences.toLocaleString()} Times
                      </span>
                    )}
                  </div>
                  <div className="di-card-head-right">
                    {renderDeadline(incident)}
                    <span className="di-expand-caret">{isExpanded ? '▾' : '▸'}</span>
                  </div>
                </button>

                {/* Amounts row (always visible) */}
                <div className="di-amounts">
                  <div className="di-amount-block discrepancy">
                    <span className="di-amount-label">Discrepancy</span>
                    <span className="di-amount-value">
                      {formatAmount(incident.discrepancy_amount)}
                      {incident.currency ? ` ${incident.currency}` : ''}
                    </span>
                  </div>
                  <div className="di-amount-block">
                    <span className="di-amount-label">Expected</span>
                    <span className="di-amount-value">
                      {formatAmount(incident.expected_amount)}
                    </span>
                  </div>
                  <div className="di-amount-block">
                    <span className="di-amount-label">Actual</span>
                    <span className="di-amount-value">{formatAmount(incident.actual_amount)}</span>
                  </div>
                  {incident.ledger_balanced !== null && (
                    <span
                      className={`di-ledger-chip ${
                        incident.ledger_balanced ? 'balanced' : 'imbalanced'
                      }`}
                    >
                      {incident.ledger_balanced ? 'Ledger Balanced' : 'Ledger Imbalanced'}
                    </span>
                  )}
                </div>

                {/* Context line */}
                <div className="di-context-line">
                  {incident.club_name && <span className="di-org">{incident.club_name}</span>}
                  {incident.union_name && (
                    <span className="di-org union">{incident.union_name}</span>
                  )}
                  {incident.source && <span className="di-source">{incident.source}</span>}
                  {incident.layer && <span className="di-layer">{formatEnum(incident.layer)}</span>}
                  <span className="di-detected">
                    Detected {new Date(incident.detected_at).toLocaleString()}
                  </span>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="di-detail">
                    {refChips.length > 0 && (
                      <div className="di-chips">
                        {refChips.map((chip) => (
                          <span
                            key={`${chip.label}-${chip.value}`}
                            className="di-chip"
                            title={chip.value}
                          >
                            {chip.label} {shortId(chip.value)}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="di-meta-grid">
                      {incident.suspected_cause && (
                        <div className="di-meta-row">
                          <span className="di-meta-label">Suspected Cause</span>
                          <span className="di-meta-value">{incident.suspected_cause}</span>
                        </div>
                      )}
                      {incident.auto_repair_status && (
                        <div className="di-meta-row">
                          <span className="di-meta-label">Auto Repair</span>
                          <span className={`di-repair-badge ${incident.auto_repair_status}`}>
                            {formatEnum(incident.auto_repair_status)}
                          </span>
                        </div>
                      )}
                      {incident.escalation_level !== null && incident.escalation_level > 0 && (
                        <div className="di-meta-row">
                          <span className="di-meta-label">Escalation</span>
                          <span className="di-meta-value escalation">
                            Level {incident.escalation_level}
                          </span>
                        </div>
                      )}
                      {incident.assigned_to && (
                        <div className="di-meta-row">
                          <span className="di-meta-label">Assigned To</span>
                          <span className="di-meta-value">{incident.assigned_to}</span>
                        </div>
                      )}
                      {incident.acknowledged_at && (
                        <div className="di-meta-row">
                          <span className="di-meta-label">Acknowledged</span>
                          <span className="di-meta-value">
                            {new Date(incident.acknowledged_at).toLocaleString()}
                            {incident.acknowledged_by ? ` By ${incident.acknowledged_by}` : ''}
                          </span>
                        </div>
                      )}
                      {incident.root_cause && (
                        <div className="di-meta-row">
                          <span className="di-meta-label">Root Cause</span>
                          <span className="di-meta-value">{incident.root_cause}</span>
                        </div>
                      )}
                      {incident.correction_ref && (
                        <div className="di-meta-row">
                          <span className="di-meta-label">Correction Ref</span>
                          <span className="di-meta-value mono">{incident.correction_ref}</span>
                        </div>
                      )}
                      {incident.resolution && (
                        <div className="di-meta-row">
                          <span className="di-meta-label">Resolution</span>
                          <span className="di-meta-value">{incident.resolution}</span>
                        </div>
                      )}
                    </div>

                    {/* Event Timeline */}
                    {incident.events.length > 0 && (
                      <div className="di-timeline">
                        <span className="di-timeline-title">Event Timeline</span>
                        {incident.events
                          .slice()
                          .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
                          .map((ev, idx) => (
                            <div key={`${ev.at}-${idx}`} className={`di-event kind-${ev.kind}`}>
                              <span className="di-event-glyph">{EVENT_GLYPHS[ev.kind] || '·'}</span>
                              <span className="di-event-kind">{formatEnum(ev.kind)}</span>
                              <span className="di-event-time">
                                {new Date(ev.at).toLocaleString()}
                              </span>
                              {ev.actor && <span className="di-event-actor">{ev.actor}</span>}
                              {ev.detail && <span className="di-event-detail">{ev.detail}</span>}
                            </div>
                          ))}
                      </div>
                    )}

                    {incident.metadata && Object.keys(incident.metadata).length > 0 && (
                      <details className="di-metadata">
                        <summary>Metadata</summary>
                        <pre>{JSON.stringify(incident.metadata, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div className="di-actions">
                  {actionsFor(incident).map((btn) => (
                    <button
                      key={btn.action}
                      className={btn.className}
                      disabled={acting !== null}
                      onClick={() => handleAction(incident, btn.action)}
                    >
                      {acting === `${incident.id}:${btn.action}` ? 'Working...' : btn.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

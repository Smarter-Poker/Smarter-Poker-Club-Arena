/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DRIFT INCIDENTS PAGE - Ops Dashboard for Financial Drift Incidents
 * ═══════════════════════════════════════════════════════════════════════════════
 * Lists drift incidents from fn_ca_incident_dashboard with the 20-minute
 * resolution-target countdown, expected vs actual amounts, auto-repair status,
 * event timeline and the full acknowledge/reconcile/resolve/reopen workflow.
 *
 * NOTE: acknowledging an incident does NOT hide it. Acted-on incidents are
 * pinned into the current filter view so the card visibly changes state in
 * place instead of vanishing.
 *
 * ── #ClubArenaConsole (2026-09-09) ────────────────────────────────────────
 * The page used to be a grid of six drawn stat tiles above a stack of
 * rounded, left-bordered incident cards, each carrying six drawn capsule
 * badges and four filled buttons. It is now printed on Dan's approved spade
 * master: two consoles - the ops readout, then the incident queue - with
 * every figure as a row on the black glass, label in the master's lit blue on
 * the left and value in engraved silver on the right, separated by the
 * engraved rule the master cuts between its own rows. Nothing is drawn.
 *
 * WHAT DID NOT CHANGE, AND MUST NOT: every RPC call, the 30s auto-refresh,
 * the 1s countdown ticker, the in-flight `loadingRef` guard, the `acting`
 * double-tap guard, the pin-on-action behaviour above, the notification deep
 * link (`id="di-<incident id>"` plus the `deep-linked` flash), and every
 * prompt string the resolve/reopen/comment flow puts in front of an operator.
 * This surface acts on real money; the actions it offers are byte-identical.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DriftIncidentService,
  DriftIncident,
  DriftMetrics,
  IncidentAction,
  IncidentStatus,
} from '../services/DriftIncidentService';
import DriftGatePanel from './DriftGatePanel';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useAuthUser } from '../hooks/useAuthUser';
import { useCashoutScope, useCashoutScopeKey } from '../hooks/useCashoutScope';
import { reportError } from '../utils/errorReporter';
import { compactChips } from '../utils/format';
import { enumToTitleCase, stripEmDashes, titleCase } from '../utils/titleCase';
import { isAuthzError } from '../utils/clubDashboard';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { SpadeConsole, type ConsoleInk } from '../components/console/SpadeConsole';
import './DriftIncidentsPage.css';

const TWENTY_MINUTES_MS = 20 * 60 * 1000;
const AUTO_REFRESH_MS = 30 * 1000;
const INCIDENT_DASHBOARD_LIMIT = 500;

const STATUS_TABS: { key: IncidentStatus; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'acknowledged', label: 'Acknowledged' },
  { key: 'reconciling', label: 'Reconciling' },
  { key: 'resolved', label: 'Resolved' },
];

/* The timeline used to lead each event with a dingbat stuck on the left.
   "ALL ICONS SHOULD FEEL ORGANIC, AND BUILT INTO THE FRAMES" - an emblem is
   painted in the master or it is not there. The event already prints its own
   name, so the kind now carries its meaning in the master's ink instead. */
const EVENT_INK: Record<string, ConsoleInk> = {
  escalated: 'red',
  resolved: 'green',
  repair_action: 'gold',
};

const SEVERITY_INK: Record<string, ConsoleInk> = {
  critical: 'red',
  warning: 'gold',
  info: 'blue',
};

const UUID_TOKEN = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi;
const LONG_MACHINE_TOKEN = /\b[0-9a-f]{24,}\b/gi;

function cleanOperatorText(value: string, maxLength = 240): string {
  const withoutControls = Array.from(stripEmDashes(value), (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
  }).join('');
  return withoutControls.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function redactMachineIdentifiers(value: string): string {
  return value
    .replace(UUID_TOKEN, 'Withheld Reference')
    .replace(LONG_MACHINE_TOKEN, 'Withheld Reference');
}

/** HIGH_HAND -> "High Hand" (KNOWN BUG PATTERN: format raw DB enums before display). */
function formatEnum(value: string): string {
  const clean = redactMachineIdentifiers(cleanOperatorText(value)).replace(/[_.:/\\]+/g, ' ');
  return clean ? enumToTitleCase(clean) : 'Unavailable';
}

function formatOperatorText(value: string): string {
  const clean = redactMachineIdentifiers(cleanOperatorText(value)).replace(/_/g, ' ');
  return clean ? titleCase(clean) : 'Unavailable';
}

function formatAmount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '--';
  return compactChips(Number(n));
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

export default function DriftIncidentsPage() {
  const { user } = useAuthUser();
  const scopeKey = useCashoutScopeKey(user?.id, 'drift-incidents');
  return <DriftIncidentsContent key={scopeKey} actorId={user?.id} />;
}

function DriftIncidentsContent({ actorId }: { actorId?: string }) {
  const isCurrent = useCashoutScope(actorId, 'drift-incidents');
  const navigate = useNavigate();
  const toast = useToast();
  useVisibilityRefresh(() => loadIncidents());

  const [incidents, setIncidents] = useState<DriftIncident[]>([]);
  const [metrics, setMetrics] = useState<DriftMetrics>({});
  const [incidentsVerified, setIncidentsVerified] = useState(false);
  const [incidentsError, setIncidentsError] = useState<string | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<IncidentStatus>('open');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /* Push notifications link here as /financial-incidents?id=<incident id>.
     Capture the id once; when the incident arrives in a load, jump to it.
     An id that never arrives (old bookmark, purged incident) is ignored. */
  const [deepLinkId, setDeepLinkId] = useState<string | null>(() => {
    try {
      return new URLSearchParams(window.location.search).get('id');
    } catch {
      return null;
    }
  });
  // Incidents acted on stay visible in the current tab even after their
  // status changes (e.g. an acknowledged incident must NOT disappear from
  // the Open tab the operator is looking at).
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const loadingRef = useRef(false);
  const accessRevokedRef = useRef(false);

  const revokeAccess = useCallback(() => {
    // A same-user authority change does not remount FinancialAdminGate. Clear
    // every protected byte immediately on either a read or mutation refusal,
    // then leave the route. Transport failures may retain last-verified data;
    // an explicit database authorization refusal may not.
    accessRevokedRef.current = true;
    setIncidents([]);
    setMetrics({});
    setIncidentsVerified(false);
    setIncidentsError(null);
    setMetricsError(null);
    setExpanded(new Set());
    setPinned(new Set());
    setActing(null);
    setDeepLinkId(null);
    navigate('/financial-admin', { replace: true });
  }, [navigate]);

  const loadIncidents = useCallback(
    async (getIsMounted?: () => boolean) => {
      if (loadingRef.current || accessRevokedRef.current) return;
      if (!isCurrent()) {
        setIncidents([]);
        setMetrics({});
        setIncidentsVerified(false);
        setIncidentsError(null);
        setMetricsError(null);
        setLoading(false);
        return;
      }
      loadingRef.current = true;
      setLoading(true);
      try {
        // Dashboard and metrics are independent reads. A metrics outage must
        // not hide a verified incident queue, and a rejected dashboard must
        // never be converted into an empty/all-clear result.
        const [dashboardResult, metricsResult] = await Promise.allSettled([
          DriftIncidentService.getDashboard(null, INCIDENT_DASHBOARD_LIMIT),
          DriftIncidentService.getMetrics(),
        ]);
        if (!isCurrent() || (getIsMounted && !getIsMounted())) return;
        const accessRevoked =
          (dashboardResult.status === 'rejected' && isAuthzError(dashboardResult.reason)) ||
          (metricsResult.status === 'rejected' && isAuthzError(metricsResult.reason));
        if (accessRevoked) {
          revokeAccess();
          return;
        }
        if (dashboardResult.status === 'fulfilled') {
          setIncidents(dashboardResult.value);
          setIncidentsVerified(true);
          setIncidentsError(null);
        } else {
          setIncidentsError('Incident Timeline Unavailable. No Clear State Can Be Verified.');
          reportError(dashboardResult.reason, 'DriftIncidentsPage.Failed_to_load_incidents');
          toast.error('Failed to verify drift incidents');
        }
        if (metricsResult.status === 'fulfilled') {
          setMetrics(metricsResult.value);
          setMetricsError(null);
        } else {
          setMetrics({});
          setMetricsError('Live Incident Metrics Are Unavailable.');
          reportError(metricsResult.reason, 'DriftIncidentsPage.Failed_to_load_metrics');
        }
      } finally {
        loadingRef.current = false;
        if (isCurrent() && (!getIsMounted || getIsMounted())) setLoading(false);
      }
    },
    [isCurrent, revokeAccess, toast]
  );

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

  // ── Notification deep link: land on the incident the push was about ──
  useEffect(() => {
    if (!deepLinkId || incidents.length === 0) return;
    const target = incidents.find((i) => i.id === deepLinkId);
    if (!target) return;
    // The card only renders on its status tab - switch to it first.
    setFilter(target.status);
    setExpanded((prev) => new Set(prev).add(target.id));
    setDeepLinkId(null);
    // Scroll after the tab switch has rendered the card.
    window.setTimeout(() => {
      const el = document.getElementById(`di-${target.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('deep-linked');
        window.setTimeout(() => el.classList.remove('deep-linked'), 4000);
      }
    }, 120);
  }, [deepLinkId, incidents]);

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
    if (!isCurrent()) return;
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
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
      reportError(err, 'DriftIncidentsPage.Incident_action_failed', {
        incidentId: incident.id,
        action,
      });
      if (isAuthzError(err)) {
        revokeAccess();
        return;
      }
      toast.error('Incident action failed');
    }
    if (isCurrent()) setActing(null);
  };

  /* SAME ACTIONS, SAME ORDER, SAME LABELS. Only the dress changed: each one
     is a lit word cut into the glass rather than a filled capsule, so the ink
     replaces the old per-button class. The foot's two painted plates are not
     used for these - a row carries up to four actions and the plates are a
     pair. */
  const actionsFor = (
    i: DriftIncident
  ): { action: IncidentAction; label: string; ink: ConsoleInk }[] => {
    if (!i.can_act) return [];
    if (i.status === 'resolved') {
      return [
        { action: 'reopen', label: 'Reopen', ink: 'gold' },
        { action: 'comment', label: 'Comment', ink: 'blue' },
      ];
    }
    const list: { action: IncidentAction; label: string; ink: ConsoleInk }[] = [];
    if (i.status === 'open') {
      list.push({ action: 'acknowledge', label: 'Acknowledge', ink: 'blue' });
    }
    if (i.status !== 'reconciling') {
      list.push({
        action: 'reconciling',
        label: 'Mark Reconciling',
        ink: 'gold',
      });
    }
    list.push({ action: 'comment', label: 'Comment', ink: 'blue' });
    list.push({ action: 'resolve', label: 'Resolve', ink: 'green' });
    return list;
  };

  /* The 20-minute target reads as a countdown in the master's gold, red once
     it is inside the last ten seconds or already past, green when the
     incident closed. Same arithmetic as before, to the millisecond. */
  const renderDeadline = (i: DriftIncident) => {
    if (i.status === 'resolved') {
      const mins = i.resolved_at
        ? Math.max(
            0,
            (new Date(i.resolved_at).getTime() - new Date(i.detected_at).getTime()) / 60000
          )
        : null;
      return (
        <span className="di-deadline sc-ink--green">
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
      <span
        className={`di-deadline ${past || remainMs <= 10_000 ? 'sc-ink--red' : 'sc-ink--gold'}`}
      >
        {past ? `Past Target By ${mm}m ${ssStr}s` : `${mm}m ${ssStr}s Left`}
      </span>
    );
  };

  // ── Stats (computed over ALL loaded incidents, not just the visible tab) ──
  const unresolvedCount = incidents.filter((i) => i.status !== 'resolved').length;
  const dashboardMayBeTruncated =
    incidentsVerified && incidents.length === INCIDENT_DASHBOARD_LIMIT;
  const metricOpenTotal = metrics.open_total;
  // Metrics owns the full unresolved count. The dashboard is a bounded detail
  // window, so hitting its ceiling can never be presented as an exact zero or
  // an all-clear when metrics are unavailable. Separate reads can race; if an
  // older loaded queue exceeds the live metric, keep that contradiction red.
  const metricBehindLoadedQueue =
    metricOpenTotal !== undefined && metricOpenTotal < unresolvedCount;
  const openCountDisplay = !incidentsVerified
    ? '--'
    : metricBehindLoadedQueue
      ? `${unresolvedCount}+ Loaded`
      : metricOpenTotal !== undefined
        ? String(metricOpenTotal)
        : dashboardMayBeTruncated
          ? `${unresolvedCount}+`
          : String(unresolvedCount);
  const openCountBounded =
    incidentsVerified && (metricBehindLoadedQueue || metricOpenTotal === undefined);
  const openNeedsAttention = unresolvedCount > 0 || (metricOpenTotal ?? 0) > 0 || openCountBounded;
  const pastTargetCount = incidents.filter((i) => i.status !== 'resolved' && i.past_target).length;
  const pastTargetDisplay = !incidentsVerified
    ? '--'
    : metrics.past_target !== undefined
      ? String(metrics.past_target)
      : `${pastTargetCount}${dashboardMayBeTruncated ? '+' : ''}`;
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
  const countLabelFor = (status: IncidentStatus) => {
    if (!incidentsVerified) return '--';
    const count = countFor(status);
    return `${count}${dashboardMayBeTruncated ? '+' : ''}`;
  };

  const filteredIncidents = incidents.filter((i) => i.status === filter || pinned.has(i.id));

  /* The same six readouts, unchanged in value and in order. They used to be a
     grid of drawn tiles, each a rounded panel with its own fill and a red
     variant; they are now rows on the glass, and "alert" is the value's ink
     rather than a repainted box. */
  const metricRows: { label: string; value: string; ink: ConsoleInk }[] = [
    {
      label: 'Open Incidents',
      value: openCountDisplay,
      ink: !incidentsVerified || openNeedsAttention ? 'red' : 'silver',
    },
    {
      label: 'Past 20m Target',
      value: pastTargetDisplay,
      ink:
        !incidentsVerified || pastTargetCount > 0 || (metrics.past_target ?? 0) > 0
          ? 'red'
          : 'silver',
    },
    {
      label: 'Worst Discrepancy',
      value: worst
        ? `${formatAmount(Math.abs(worst.discrepancy_amount || 0))}${
            worst.currency ? ` ${formatEnum(worst.currency)}` : ''
          }`
        : '--',
      ink: worst !== null ? 'red' : 'silver',
    },
    {
      label: dashboardMayBeTruncated ? 'Avg Loaded Resolution Age' : 'Avg Resolution Age',
      value:
        avgResolutionMins === null
          ? '--'
          : `${formatMinutes(avgResolutionMins)}${dashboardMayBeTruncated ? ' Loaded Window' : ''}`,
      ink: 'silver',
    },
    {
      label: 'Auto-Repairing',
      value: metrics.auto_repairing === undefined ? '--' : String(metrics.auto_repairing),
      ink: 'silver',
    },
    {
      label: 'Unclassified Flow Today',
      value: metrics.suspense_today === undefined ? '--' : formatAmount(metrics.suspense_today),
      ink: (metrics.suspense_today ?? 0) > 0 ? 'red' : 'silver',
    },
  ];

  if (loading && incidents.length === 0) {
    return (
      <StandardContentLayout className="drift-incidents-page">
        <SpadeConsole
          className="di-console"
          family="spade"
          crest="spade"
          aria-busy
          eyebrow="Club Arena Ops"
          title="Drift Incidents"
          pill="Loading"
          pillInk="muted"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center" role="status">
            Loading Incidents...
          </p>
        </SpadeConsole>
      </StandardContentLayout>
    );
  }

  return (
    <StandardContentLayout className="drift-incidents-page">
      {/* ── The ops readout: six figures as rows on the glass ─────────── */}
      <SpadeConsole
        className="di-console"
        family="spade"
        crest="spade"
        aria-busy={loading || undefined}
        eyebrow="Club Arena Ops"
        title="Drift Incidents"
        pill={
          loading
            ? 'Syncing'
            : incidentsError
              ? incidentsVerified
                ? 'Last Verified'
                : 'Unavailable'
              : openCountBounded && unresolvedCount === 0
                ? dashboardMayBeTruncated
                  ? 'Open Count Bounded'
                  : 'Open Count Unavailable'
                : openNeedsAttention
                  ? `${openCountDisplay} Open`
                  : 'Clear'
        }
        pillInk={loading ? 'muted' : incidentsError || openNeedsAttention ? 'red' : 'green'}
        foot="foot"
      >
        <dl className="di-facts">
          {metricRows.map((row) => (
            <div key={row.label} className="di-fact">
              <dt className="di-fact__label sc-label sc-ink--blue">{row.label}</dt>
              <dd className={`di-fact__value sc-ink--${row.ink}`}>{row.value}</dd>
            </div>
          ))}
        </dl>
        {incidentsError && (
          <p className="sc-copy sc-ink--red" role="alert">
            {incidentsError}
            {incidentsVerified ? ' Showing The Last Verified Queue.' : ''}
          </p>
        )}
        {metricsError && (
          <p className="sc-copy sc-ink--gold" role="status">
            {metricsError}
          </p>
        )}
        {/* ONE ACTION, SO NO PLATES. The foot paints both plates or neither,
            and a single lit refresh would leave the other painted and empty. */}
        <button
          type="button"
          className="di-word sc-ink--blue"
          onClick={() => loadIncidents()}
          title="Refresh"
          disabled={loading}
        >
          Refresh
        </button>
      </SpadeConsole>

      {/* Burn-In Gate + Supply Trends + Balance As-Of (management only).
          It owns one approved spade-crest console and never draws a second
          frame inside this page's painted chassis. */}
      <DriftGatePanel />

      {/* ── The queue ─────────────────────────────────────────────────── */}
      <SpadeConsole
        className="di-console"
        family="spade"
        eyebrow={`${formatEnum(filter)} Queue`}
        title="Incidents"
        pill={
          incidentsVerified
            ? `${filteredIncidents.length}${dashboardMayBeTruncated ? '+' : ''}`
            : '--'
        }
        pillInk={!incidentsVerified || filteredIncidents.length === 0 ? 'muted' : 'blue'}
        foot="foot"
      >
        {/* The four views are lit words cut into the glass. The master paints
            no tab, so nothing here draws one. */}
        <div className="di-rail" role="tablist" aria-label="Incident Status">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={filter === tab.key}
              className={`di-rail__word ${filter === tab.key ? 'sc-ink--silver' : 'sc-ink--muted'}`}
              onClick={() => changeFilter(tab.key)}
            >
              {tab.label} ({countLabelFor(tab.key)})
            </button>
          ))}
        </div>

        {!incidentsVerified ? (
          <div className="di-empty">
            <span className="sc-label sc-ink--red">Queue Unavailable</span>
            <p className="sc-copy sc-copy--center">
              Incident Status Could Not Be Verified. Retry Before Making An Operational Decision.
            </p>
            <button
              type="button"
              className="di-word sc-ink--blue"
              onClick={() => loadIncidents()}
              disabled={loading}
            >
              Retry
            </button>
          </div>
        ) : filteredIncidents.length === 0 ? (
          <div className="di-empty">
            <span className="sc-label sc-ink--muted">
              {formatEnum(filter)} Queue {dashboardMayBeTruncated ? 'Bounded' : 'Empty'}
            </span>
            <p className="sc-copy sc-copy--center">
              {dashboardMayBeTruncated
                ? `No ${formatEnum(filter)} Incidents Were Loaded In The Latest ${INCIDENT_DASHBOARD_LIMIT}-Row Window.`
                : `No ${formatEnum(filter)} Incidents.`}
            </p>
          </div>
        ) : (
          <ol className="di-list">
            {filteredIncidents.map((incident) => {
              const isExpanded = expanded.has(incident.id);
              const linkedRecords: string[] = [];
              if (incident.table_id) linkedRecords.push('Table');
              if (incident.tournament_id) linkedRecords.push('Tournament');
              if (incident.hand_id) linkedRecords.push('Hand');
              if (incident.settlement_id) linkedRecords.push('Settlement');

              return (
                <li key={incident.id} id={`di-${incident.id}`} className="di-row">
                  {/* Row head (click to expand) */}
                  <button
                    type="button"
                    className="di-row__head"
                    onClick={() => toggleExpanded(incident.id)}
                    aria-expanded={isExpanded}
                  >
                    <span className="di-row__name sc-ink--silver">
                      {formatEnum(incident.classification)}
                    </span>
                    <span className="di-row__flags">
                      <span
                        className={`sc-label sc-ink--${SEVERITY_INK[incident.severity] ?? 'blue'}`}
                      >
                        {formatEnum(incident.severity)}
                      </span>
                      <span className="sc-label sc-ink--muted">{formatEnum(incident.status)}</span>
                      {incident.occurrences > 1 && (
                        <span
                          className="sc-label sc-ink--muted"
                          title="Times This Drift Has Recurred"
                        >
                          Seen {incident.occurrences.toLocaleString()} Times
                        </span>
                      )}
                    </span>
                    <span className="di-row__tail">
                      {renderDeadline(incident)}
                      <span className="sc-label sc-ink--blue">
                        {isExpanded ? 'Hide' : 'Details'}
                      </span>
                    </span>
                  </button>

                  {/* The three figures, always visible */}
                  <dl className="di-facts">
                    <div className="di-fact">
                      <dt className="di-fact__label sc-label sc-ink--blue">Discrepancy</dt>
                      <dd className="di-fact__value sc-ink--red">
                        {formatAmount(incident.discrepancy_amount)}
                        {incident.currency ? ` ${formatEnum(incident.currency)}` : ''}
                      </dd>
                    </div>
                    <div className="di-fact">
                      <dt className="di-fact__label sc-label sc-ink--blue">Expected</dt>
                      <dd className="di-fact__value sc-ink--silver">
                        {formatAmount(incident.expected_amount)}
                      </dd>
                    </div>
                    <div className="di-fact">
                      <dt className="di-fact__label sc-label sc-ink--blue">Actual</dt>
                      <dd className="di-fact__value sc-ink--silver">
                        {formatAmount(incident.actual_amount)}
                      </dd>
                    </div>
                    {incident.ledger_balanced !== null && (
                      <div className="di-fact">
                        <dt className="di-fact__label sc-label sc-ink--blue">Ledger</dt>
                        <dd
                          className={`di-fact__value ${
                            incident.ledger_balanced ? 'sc-ink--green' : 'sc-ink--red'
                          }`}
                        >
                          {incident.ledger_balanced ? 'Balanced' : 'Imbalanced'}
                        </dd>
                      </div>
                    )}
                    {incident.club_name && (
                      <div className="di-fact">
                        <dt className="di-fact__label sc-label sc-ink--blue">Club</dt>
                        <dd className="di-fact__value sc-ink--silver">
                          {formatOperatorText(incident.club_name)}
                        </dd>
                      </div>
                    )}
                    {incident.union_name && (
                      <div className="di-fact">
                        <dt className="di-fact__label sc-label sc-ink--blue">Union</dt>
                        <dd className="di-fact__value sc-ink--silver">
                          {formatOperatorText(incident.union_name)}
                        </dd>
                      </div>
                    )}
                    {incident.source && (
                      <div className="di-fact">
                        <dt className="di-fact__label sc-label sc-ink--blue">Source</dt>
                        <dd className="di-fact__value sc-ink--silver">
                          {formatEnum(incident.source)}
                        </dd>
                      </div>
                    )}
                    {incident.layer && (
                      <div className="di-fact">
                        <dt className="di-fact__label sc-label sc-ink--blue">Layer</dt>
                        <dd className="di-fact__value sc-ink--silver">
                          {formatEnum(incident.layer)}
                        </dd>
                      </div>
                    )}
                    <div className="di-fact">
                      <dt className="di-fact__label sc-label sc-ink--blue">Detected</dt>
                      <dd className="di-fact__value sc-ink--silver">
                        {new Date(incident.detected_at).toLocaleString()}
                      </dd>
                    </div>
                  </dl>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="di-detail">
                      <dl className="di-facts">
                        {linkedRecords.map((label) => (
                          <div key={label} className="di-fact">
                            <dt className="di-fact__label sc-label sc-ink--blue">{label}</dt>
                            <dd className="di-fact__value sc-ink--silver">Linked Record</dd>
                          </div>
                        ))}
                        {incident.suspected_cause && (
                          <div className="di-fact">
                            <dt className="di-fact__label sc-label sc-ink--blue">
                              Suspected Cause
                            </dt>
                            <dd className="di-fact__value sc-ink--silver">
                              {formatOperatorText(incident.suspected_cause)}
                            </dd>
                          </div>
                        )}
                        {incident.auto_repair_status && (
                          <div className="di-fact">
                            <dt className="di-fact__label sc-label sc-ink--blue">Auto Repair</dt>
                            <dd
                              className={`di-fact__value ${
                                incident.auto_repair_status === 'repaired'
                                  ? 'sc-ink--green'
                                  : incident.auto_repair_status === 'manual_needed'
                                    ? 'sc-ink--red'
                                    : 'sc-ink--gold'
                              }`}
                            >
                              {formatEnum(incident.auto_repair_status)}
                            </dd>
                          </div>
                        )}
                        {incident.escalation_level !== null && incident.escalation_level > 0 && (
                          <div className="di-fact">
                            <dt className="di-fact__label sc-label sc-ink--blue">Escalation</dt>
                            <dd className="di-fact__value sc-ink--red">
                              Level {incident.escalation_level}
                            </dd>
                          </div>
                        )}
                        {incident.assigned_to && (
                          <div className="di-fact">
                            <dt className="di-fact__label sc-label sc-ink--blue">Assigned To</dt>
                            <dd className="di-fact__value sc-ink--silver">Assigned Operator</dd>
                          </div>
                        )}
                        {incident.acknowledged_at && (
                          <div className="di-fact">
                            <dt className="di-fact__label sc-label sc-ink--blue">Acknowledged</dt>
                            <dd className="di-fact__value sc-ink--silver">
                              {new Date(incident.acknowledged_at).toLocaleString()}
                              {incident.acknowledged_by ? ' By Authorized Operator' : ''}
                            </dd>
                          </div>
                        )}
                        {incident.root_cause && (
                          <div className="di-fact">
                            <dt className="di-fact__label sc-label sc-ink--blue">Root Cause</dt>
                            <dd className="di-fact__value sc-ink--silver">
                              {formatOperatorText(incident.root_cause)}
                            </dd>
                          </div>
                        )}
                        {incident.correction_ref && (
                          <div className="di-fact">
                            <dt className="di-fact__label sc-label sc-ink--blue">Correction Ref</dt>
                            <dd className="di-fact__value sc-ink--silver">Recorded</dd>
                          </div>
                        )}
                        {incident.resolution && (
                          <div className="di-fact">
                            <dt className="di-fact__label sc-label sc-ink--blue">Resolution</dt>
                            <dd className="di-fact__value sc-ink--silver">
                              {formatOperatorText(incident.resolution)}
                            </dd>
                          </div>
                        )}
                      </dl>

                      {/* Event Timeline */}
                      {incident.events.length > 0 && (
                        <div className="di-timeline">
                          <span className="sc-label sc-ink--blue">Event Timeline</span>
                          {incident.events
                            .slice()
                            .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
                            .map((ev, idx) => (
                              <div key={`${ev.at}-${idx}`} className="di-event">
                                <span
                                  className={`di-event__kind sc-label sc-ink--${
                                    EVENT_INK[ev.kind] ?? 'silver'
                                  }`}
                                >
                                  {formatEnum(ev.kind)}
                                </span>
                                <span className="di-event__time sc-ink--muted">
                                  {new Date(ev.at).toLocaleString()}
                                </span>
                                {ev.actor && (
                                  <span className="di-event__actor sc-ink--muted">
                                    Authorized Operator
                                  </span>
                                )}
                                {ev.detail && (
                                  <span className="di-event__detail sc-ink--muted">
                                    {formatOperatorText(ev.detail)}
                                  </span>
                                )}
                              </div>
                            ))}
                        </div>
                      )}

                      {incident.metadata && Object.keys(incident.metadata).length > 0 && (
                        <details className="di-metadata">
                          <summary className="sc-label sc-ink--blue">Metadata</summary>
                          <p className="sc-copy sc-ink--muted">
                            Additional Metadata Is Retained In The Durable Incident Record And
                            Withheld From This Operator View.
                          </p>
                        </details>
                      )}
                    </div>
                  )}

                  {/* A platform reader is not automatically a registered
                      incident actor. Never paint a control the server will
                      refuse; the receipt explicitly supplies can_act. */}
                  {incident.can_act ? (
                    <div className="di-row__actions">
                      {actionsFor(incident).map((btn) => (
                        <button
                          key={btn.action}
                          type="button"
                          className={`di-word sc-ink--${btn.ink}`}
                          disabled={acting !== null}
                          onClick={() => handleAction(incident, btn.action)}
                        >
                          {acting === `${incident.id}:${btn.action}` ? 'Working...' : btn.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="sc-copy sc-ink--muted">Read Only For This Operator</p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </SpadeConsole>
    </StandardContentLayout>
  );
}

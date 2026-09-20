/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL ALERTS PAGE - Admin Ops Dashboard for Critical Financial Errors
 *  (#ClubArenaConsole)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows unresolved financial alerts with severity inks, one-click resolve,
 * and auto-refresh via Supabase real-time subscription on `financial_alerts`.
 *
 * One flow, one console: the severity filters as lit words, every alert a
 * row on the black glass between engraved rules with its "Mark Resolved" as
 * a lit word, and the two painted plates carrying Export CSV and Resolve All.
 * Every loader guard, realtime channel, bus listener and handler of the
 * generic page is kept; only the paint changed.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { masterBus } from '../core/MasterBus';
import { FinancialAlertService, FinancialAlert } from '../services/FinancialAlertService';
import { FinancialExportService, type ExportColumn } from '../services/FinancialExportService';
import { useCashoutScope, useCashoutScopeKey } from '../hooks/useCashoutScope';
import { useAuthUser } from '../hooks/useAuthUser';
import { SpadeConsole } from '../components/console/SpadeConsole';
import './FinancialAlertsPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useToast } from '../components/common/Toast';
import { reportError } from '../utils/errorReporter';
import { titleCase, enumToTitleCase } from '../utils/titleCase';

type Filter = 'all' | 'critical' | 'warning' | 'info';
const FILTERS: Filter[] = ['all', 'critical', 'warning', 'info'];

const SEVERITY_INK: Record<FinancialAlert['severity'], string> = {
  critical: 'sc-ink--red',
  warning: 'sc-ink--gold',
  info: 'sc-ink--blue',
};

export default function FinancialAlertsPage() {
  const { user } = useAuthUser();
  const scopeKey = useCashoutScopeKey(user?.id, 'financial-alerts');
  return <FinancialAlertsContent key={scopeKey} actorId={user?.id} />;
}

function FinancialAlertsContent({ actorId }: { actorId?: string }) {
  const isCurrent = useCashoutScope(actorId, 'financial-alerts');
  useVisibilityRefresh(() => loadAlerts());
  const toast = useToast();
  const [alerts, setAlerts] = useState<FinancialAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [bulkResolving, setBulkResolving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  /**
   * Counts reported by separate permission-scoped reads. They are distinct
   * from this capped list, and do not establish a complete or atomic snapshot.
   */
  const [counts, setCounts] = useState<{
    total: number;
    critical: number;
    warning: number;
    info: number;
  } | null>(null);

  const loadingRef = useRef(false);
  const loadedCurrent = useRef<(() => boolean) | null>(null);
  const [readUnavailable, setReadUnavailable] = useState(false);

  const loadAlerts = useCallback(
    async (getIsMounted?: () => boolean) => {
      if (loadingRef.current) return;
      if (!isCurrent()) {
        setAlerts([]);
        setCounts(null);
        setReadUnavailable(true);
        setLoading(false);
        return;
      }
      loadingRef.current = true;
      setLoading(true);
      loadedCurrent.current = null;
      try {
        const [data, totals] = await Promise.all([
          FinancialAlertService.getUnresolved(100),
          FinancialAlertService.getUnresolvedCounts(),
        ]);
        if (!isCurrent() || (getIsMounted && !getIsMounted())) return;
        loadedCurrent.current = isCurrent;
        setReadUnavailable(false);
        setAlerts(data);
        setCounts(totals);
      } catch (err) {
        if (!isCurrent() || (getIsMounted && !getIsMounted())) return;
        setAlerts([]);
        setCounts(null);
        setReadUnavailable(true);
        reportError(err, 'FinancialAlertsPage.Failed_to_load_alerts');
        toast.error('Failed to load financial alerts');
      } finally {
        loadingRef.current = false;
        if (isCurrent() && (!getIsMounted || getIsMounted())) setLoading(false);
      }
    },
    [isCurrent]
  );

  useEffect(() => {
    let isMounted = true;
    loadAlerts(() => isMounted);
    return () => {
      isMounted = false;
    };
  }, [loadAlerts]);

  // ── Supabase Real-time: auto-refresh when new alerts are inserted ──
  useEffect(() => {
    let isMounted = true;
    const channelKey = 'financial-alerts-realtime';
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'financial_alerts' }, () => {
        if (isMounted) loadAlerts(() => isMounted);
      })
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'FinancialAlertsPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[FinancialAlertsPage] Realtime channel timed out');
        }
      });
    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [loadAlerts]);

  // ── Bus Listeners: react to all financial/security events ──
  useEffect(() => {
    let isMounted = true;
    const unsub1 = masterBus.subscribeDebounced(
      'FINANCIAL_ALERT',
      () => {
        if (isMounted) loadAlerts(() => isMounted);
      },
      1000
    );
    // COLLUSION_DETECTED and VALIDATION_MISMATCH listeners removed
    // 2026-08-28: nothing emits either on the client bus (both are
    // server-side detections), so these "live" anti-cheat feeds never fired
    // once. Revive via a server->client bridge if wanted.
    const unsub4 = masterBus.subscribeDebounced(
      'CHIPS_ADDED',
      () => {
        if (isMounted) loadAlerts(() => isMounted);
      },
      2000
    );
    return () => {
      isMounted = false;
      unsub1();
      unsub4();
    };
  }, [loadAlerts]);

  const handleResolve = async (alertId: string) => {
    if (!isCurrent()) return;
    setResolving(alertId);
    try {
      await FinancialAlertService.resolve(alertId);
      if (!isCurrent()) return;
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } catch (err) {
      if (!isCurrent()) return;
      reportError(err, 'FinancialAlertsPage.Failed_to_resolve_alert');
      toast.error('Failed to resolve alert');
    }
    setResolving(null);
  };

  const handleBulkResolve = async () => {
    if (!isCurrent()) return;
    const toResolve = filteredAlerts.filter((a) => a.id);
    if (toResolve.length === 0) return;
    setBulkResolving(true);
    try {
      await Promise.all(toResolve.map((a) => FinancialAlertService.resolve(a.id!)));
      if (!isCurrent()) return;
      setAlerts((prev) => prev.filter((a) => !toResolve.find((r) => r.id === a.id)));
      toast.success(`Resolved ${toResolve.length} alert(s)`);
    } catch (err) {
      if (!isCurrent()) return;
      reportError(err, 'FinancialAlertsPage.Bulk_resolve_failed');
      toast.error('Bulk resolve failed');
    }
    setBulkResolving(false);
  };

  const handleExport = async () => {
    const current = loadedCurrent.current;
    if (!current || !current() || !isCurrent()) return;
    setExporting(true);
    try {
      const columns: ExportColumn[] = [
        { key: 'id', label: 'Alert ID', kind: 'uuid' },
        { key: 'severity', label: 'Severity', kind: 'text' },
        { key: 'source', label: 'Source', kind: 'text' },
        { key: 'message', label: 'Message', kind: 'text' },
        { key: 'created_at', label: 'Created At', kind: 'timestamp' },
        { key: 'resolved', label: 'Resolved', kind: 'boolean' },
        { key: 'record_scope', label: 'Record Scope', kind: 'text' },
        { key: 'loaded_rows', label: 'Loaded Rows', kind: 'integer' },
      ];
      // Preserve the existing all-loaded export, regardless of severity tab.
      // Neither the loaded set nor its counts prove full alert history.
      const rows = alerts.map((a) => ({
        id: a.id,
        severity: a.severity,
        source: a.source,
        message: a.message,
        created_at: a.createdAt,
        resolved: a.resolved,
        record_scope: 'All currently loaded alerts; bounded service read; not complete history',
        loaded_rows: alerts.length,
      }));
      const csv = FinancialExportService.generateCSV(columns, rows);
      await FinancialExportService.downloadCSV(
        csv,
        `financial_alerts_loaded_${new Date().toISOString().split('T')[0]}.csv`,
        () => current() && isCurrent()
      );
      if (current() && isCurrent()) toast.success(`Exported ${rows.length} loaded alert(s)`);
    } catch (error) {
      if (!isCurrent()) return;
      reportError(error, 'FinancialAlertsPage.export');
      toast.error('Export unavailable');
    } finally {
      if (isCurrent()) setExporting(false);
    }
  };

  const filteredAlerts = filter === 'all' ? alerts : alerts.filter((a) => a.severity === filter);

  // Every severity is bounded. Prefer the separate reported counts once the
  // read completes; neither those counts nor the loaded list prove completeness.
  const totalCount = counts?.total ?? alerts.length;
  const criticalCount = counts?.critical ?? alerts.filter((a) => a.severity === 'critical').length;
  const warningCount = counts?.warning ?? alerts.filter((a) => a.severity === 'warning').length;
  const infoCount = counts?.info ?? alerts.filter((a) => a.severity === 'info').length;
  const notShown = Math.max(totalCount - alerts.length, 0);
  const filterCount: Record<Filter, number> = {
    all: totalCount,
    critical: criticalCount,
    warning: warningCount,
    info: infoCount,
  };

  if (readUnavailable) {
    return (
      <div className="financial-alerts-page">
        <SpadeConsole
          className="fap__console"
          eyebrow="Financial Admin"
          title="Financial Alerts"
          titleId="financial-alerts-title"
          pill="Unavailable"
          pillInk="red"
          foot="foot"
        >
          <p role="alert" className="sc-copy sc-copy--center sc-ink--red fap__state">
            Financial Alerts Unavailable
          </p>
          <div className="fap__sync">
            <button
              type="button"
              className="fap-word sc-ink--white"
              onClick={() => loadAlerts()}
              title="Refresh"
            >
              Refresh
            </button>
          </div>
        </SpadeConsole>
      </div>
    );
  }

  if (loading && alerts.length === 0) {
    return (
      <div className="financial-alerts-page">
        <SpadeConsole
          className="fap__console"
          eyebrow="Financial Admin"
          title="Financial Alerts"
          titleId="financial-alerts-title"
          pill="Loading"
          pillInk="muted"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center fap__state" aria-busy="true">
            Loading Alerts...
          </p>
        </SpadeConsole>
      </div>
    );
  }

  const pill =
    criticalCount > 0
      ? `${criticalCount} Critical`
      : warningCount > 0
        ? `${warningCount} Warning`
        : alerts.length === 0
          ? 'All Clear'
          : `${infoCount} Info`;
  const pillInk =
    criticalCount > 0 ? 'red' : warningCount > 0 ? 'gold' : alerts.length === 0 ? 'green' : 'blue';

  return (
    <div className="financial-alerts-page">
      <SpadeConsole
        className="fap__console"
        eyebrow="Financial Admin"
        title="Financial Alerts"
        titleId="financial-alerts-title"
        pill={pill}
        pillInk={pillInk}
        plates={{
          secondary: {
            label: exporting ? 'Exporting...' : 'Export CSV',
            onClick: handleExport,
            disabled: exporting || loading || readUnavailable || alerts.length === 0,
            title: 'Export Loaded Alerts CSV',
          },
          primary: {
            label: bulkResolving
              ? 'Resolving...'
              : titleCase(`Resolve All ${filteredAlerts.length} ${filter !== 'all' ? filter : ''}`),
            ink: 'white',
            onClick: handleBulkResolve,
            disabled: bulkResolving || filteredAlerts.length < 2,
          },
        }}
      >
        <div className="fap__toolbar">
          <div className="fap__filters" role="group" aria-label="Filter Alerts By Severity">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={`fap-word fap__filter ${filter === f ? 'sc-ink--white' : 'sc-ink--muted'}`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {titleCase(f)}
                <span className="fap__filter-count sc-ink--blue">{filterCount[f]}</span>
              </button>
            ))}
          </div>
          <div className="fap__sync">
            {loading && alerts.length > 0 && (
              <span className="fap__syncing sc-ink--green">Syncing...</span>
            )}
            <button
              type="button"
              className="fap-word sc-ink--white"
              onClick={() => loadAlerts()}
              title="Refresh"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Critical rows are prioritized but remain bounded by query/provider caps. */}
        {notShown > 0 && (
          <p className="sc-copy fap__note sc-ink--muted">
            Loaded {alerts.length} Alerts; Separate Reads Report {totalCount} Unresolved. This
            List May Be Incomplete.
          </p>
        )}

        {/* Alert List */}
        {filteredAlerts.length === 0 ? (
          <p className="sc-copy sc-copy--center fap__state">
            {filter === 'all'
              ? 'No Loaded Alerts In This View'
              : titleCase(`No Loaded ${filter} Alerts In This View`)}
          </p>
        ) : (
          <ul className="fap__list">
            {filteredAlerts.map((alert) => (
              <li key={alert.id} className="fap__alert">
                <div className="fap__alert-head">
                  <span className={`fap__severity ${SEVERITY_INK[alert.severity]}`}>
                    {alert.severity.toUpperCase()}
                  </span>
                  <span className="fap__source sc-ink--blue">{enumToTitleCase(alert.source)}</span>
                  <span className="fap__time sc-ink--muted">
                    {new Date(alert.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="sc-copy fap__message">{titleCase(alert.message)}</p>
                {alert.context && Object.keys(alert.context).length > 0 && (
                  <details className="fap__context">
                    <summary className="fap__context-summary sc-ink--muted">
                      Context Details
                    </summary>
                    <pre className="fap__context-body">
                      {JSON.stringify(alert.context, null, 2)}
                    </pre>
                  </details>
                )}
                <div className="fap__alert-actions">
                  <button
                    type="button"
                    className="fap-word sc-ink--green"
                    onClick={() => alert.id && handleResolve(alert.id)}
                    disabled={resolving === alert.id}
                  >
                    {resolving === alert.id ? 'Resolving...' : 'Mark Resolved'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SpadeConsole>
    </div>
  );
}

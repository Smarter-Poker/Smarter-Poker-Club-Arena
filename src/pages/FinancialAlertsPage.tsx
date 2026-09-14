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
import { FinancialExportService } from '../services/FinancialExportService';
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
  useVisibilityRefresh(() => loadAlerts());
  const toast = useToast();
  const [alerts, setAlerts] = useState<FinancialAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [bulkResolving, setBulkResolving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  /**
   * The TRUE unresolved counts, not the counts of what happened to load.
   * The tabs used to count the rows in `alerts`, which is a capped page, so
   * this screen reported "All (100)" while 472 were open. See
   * FinancialAlertService.getUnresolved for the incident.
   */
  const [counts, setCounts] = useState<{
    total: number;
    critical: number;
    warning: number;
    info: number;
  } | null>(null);

  const loadingRef = useRef(false);

  const loadAlerts = useCallback(async (getIsMounted?: () => boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const [data, totals] = await Promise.all([
        FinancialAlertService.getUnresolved(100),
        FinancialAlertService.getUnresolvedCounts(),
      ]);
      if (getIsMounted && !getIsMounted()) return;
      setAlerts(data);
      setCounts(totals);
    } catch (err) {
      if (getIsMounted && !getIsMounted()) return;
      reportError(err, 'FinancialAlertsPage.Failed_to_load_alerts');
      toast.error('Failed to load financial alerts');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  }, []);

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
    setResolving(alertId);
    try {
      await FinancialAlertService.resolve(alertId);
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } catch (err) {
      reportError(err, 'FinancialAlertsPage.Failed_to_resolve_alert');
      toast.error('Failed to resolve alert');
    }
    setResolving(null);
  };

  const handleBulkResolve = async () => {
    const toResolve = filteredAlerts.filter((a) => a.id);
    if (toResolve.length === 0) return;
    setBulkResolving(true);
    try {
      await Promise.all(toResolve.map((a) => FinancialAlertService.resolve(a.id!)));
      setAlerts((prev) => prev.filter((a) => !toResolve.find((r) => r.id === a.id)));
      toast.success(`Resolved ${toResolve.length} alert(s)`);
    } catch (err) {
      reportError(err, 'FinancialAlertsPage.Bulk_resolve_failed');
      toast.error('Bulk resolve failed');
    }
    setBulkResolving(false);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const headers = ['Severity', 'Source', 'Message', 'Created At', 'Resolved'];
      const rows = alerts.map((a) => ({
        severity: a.severity,
        source: a.source,
        message: a.message,
        created_at: a.createdAt,
        resolved: String(a.resolved),
      }));
      const csv = FinancialExportService.generateCSV(headers, rows);
      FinancialExportService.downloadCSV(
        csv,
        `financial_alerts_${new Date().toISOString().split('T')[0]}.csv`
      );
      toast.success(`Exported ${rows.length} alert(s)`);
    } catch (e) {
      reportError(e, 'FinancialAlertsPage.map');
      toast.error('Export failed');
    }
    setExporting(false);
  };

  const filteredAlerts = filter === 'all' ? alerts : alerts.filter((a) => a.severity === filter);

  // Every critical is loaded, so its count is exact either way; warning and
  // info are the ones the page budget can cut, which is why they read from the
  // database totals whenever those have arrived.
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
            disabled: exporting || alerts.length === 0,
            title: 'Export CSV',
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

        {/*
          Say plainly when the page is not showing everything. Every CRITICAL is
          always loaded (see FinancialAlertService.getUnresolved); it is warnings
          and info that get cut, and an operator who is not told that will read
          an empty-looking list as "nothing left to do".
        */}
        {notShown > 0 && (
          <p className="sc-copy fap__note sc-ink--muted">
            Showing {alerts.length} Of {totalCount} Unresolved. Every Critical Is Shown.
          </p>
        )}

        {/* Alert List */}
        {filteredAlerts.length === 0 ? (
          <p className="sc-copy sc-copy--center fap__state">
            {filter === 'all' ? 'No Unresolved Alerts' : titleCase(`No ${filter} Alerts`)}
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

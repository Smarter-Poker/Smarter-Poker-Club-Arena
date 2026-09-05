/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL ALERTS PAGE — Admin Ops Dashboard for Critical Financial Errors
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows unresolved financial alerts with severity badges, one-click resolve,
 * and auto-refresh via Supabase real-time subscription on `financial_alerts`.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { FinancialAlertService, FinancialAlert } from '../services/FinancialAlertService';
import { FinancialExportService } from '../services/FinancialExportService';
import { useAuthUser } from '../hooks/useAuthUser';
import './FinancialAlertsPage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useToast } from '../components/common/Toast';
import { reportError } from '../utils/errorReporter';

export default function FinancialAlertsPage() {
  const { user } = useAuthUser();
  useVisibilityRefresh(() => loadAlerts());
  const toast = useToast();
  const [alerts, setAlerts] = useState<FinancialAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [bulkResolving, setBulkResolving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [filter, setFilter] = useState<'all' | 'critical' | 'warning' | 'info'>('all');
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

  if (loading && alerts.length === 0) {
    return (
      <div className="financial-alerts-page">
        <div className="alerts-header">
          <h2>Financial Alerts</h2>
        </div>
        <div className="loading-state">
          <PageSkeleton variant="financial" />
          <p>Loading Alerts...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="financial-alerts-page">
      <div className="alerts-header">
        <h2>Financial Alerts</h2>
        <div className="alert-stats">
          {criticalCount > 0 && <span className="stat critical"> {criticalCount} Critical</span>}
          {warningCount > 0 && <span className="stat warning"> {warningCount} Warning</span>}
          {infoCount > 0 && (
            <span
              className="stat"
              style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}
            >
              ℹ {infoCount} Info
            </span>
          )}
          {alerts.length === 0 && <span className="stat clear">All Clear</span>}
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {loading && alerts.length > 0 && (
            <span
              style={{
                fontSize: '0.7rem',
                color: '#10b981',
                animation: 'animationsPulse 1.5s infinite',
              }}
            >
              Syncing...
            </span>
          )}
          <button className="refresh-btn" onClick={() => loadAlerts()} title="Refresh">
            ↻
          </button>
          <button
            className="refresh-btn"
            onClick={handleExport}
            disabled={exporting || alerts.length === 0}
            title="Export CSV"
            style={{ fontSize: '0.9rem' }}
          >
            {exporting ? '...' : '↓'}
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="filter-tabs">
        <button
          className={`financial-alerts-page__filter-tab ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All ({totalCount})
        </button>
        <button
          className={`financial-alerts-page__filter-tab critical ${filter === 'critical' ? 'active' : ''}`}
          onClick={() => setFilter('critical')}
        >
          Critical ({criticalCount})
        </button>
        <button
          className={`financial-alerts-page__filter-tab warning ${filter === 'warning' ? 'active' : ''}`}
          onClick={() => setFilter('warning')}
        >
          Warning ({warningCount})
        </button>
        <button
          className={`financial-alerts-page__filter-tab ${filter === 'info' ? 'active' : ''}`}
          onClick={() => setFilter('info')}
          style={
            filter === 'info'
              ? {
                  background: 'rgba(99,102,241,0.12)',
                  color: '#818cf8',
                  borderColor: 'rgba(99,102,241,0.25)',
                }
              : {}
          }
        >
          Info ({infoCount})
        </button>
      </div>

      {/* Bulk Actions */}
      {filteredAlerts.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
          <button
            className="resolve-btn"
            onClick={handleBulkResolve}
            disabled={bulkResolving}
            style={{ fontSize: '0.78rem' }}
          >
            {bulkResolving
              ? 'Resolving...'
              : `✓ Resolve All ${filteredAlerts.length} ${filter !== 'all' ? filter : ''} Alerts`}
          </button>
        </div>
      )}

      {/*
        Say plainly when the page is not showing everything. Every CRITICAL is
        always loaded (see FinancialAlertService.getUnresolved); it is warnings
        and info that get cut, and an operator who is not told that will read
        an empty-looking list as "nothing left to do".
      */}
      {notShown > 0 && (
        <div className="alerts-truncated-note" style={{ fontSize: '0.78rem', opacity: 0.75 }}>
          Showing {alerts.length} Of {totalCount} Unresolved. Every Critical Is Shown.
        </div>
      )}

      {/* Alert List */}
      {filteredAlerts.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">◉</span>
          <p>{filter === 'all' ? 'No Unresolved Alerts' : `No ${filter} Alerts`}</p>
        </div>
      ) : (
        <div className="alert-list">
          {filteredAlerts.map((alert) => (
            <div key={alert.id} className={`alert-card severity-${alert.severity}`}>
              <div className="alert-header">
                <span className={`financial-alerts-page__severity-badge ${alert.severity}`}>
                  {alert.severity === 'critical' ? '●' : '◐'} {alert.severity.toUpperCase()}
                </span>
                <span className="alert-source">{alert.source}</span>
                <span className="alert-time">{new Date(alert.createdAt).toLocaleString()}</span>
              </div>
              <p className="alert-message">{alert.message}</p>
              {alert.context && Object.keys(alert.context).length > 0 && (
                <details className="alert-context">
                  <summary>Context Details</summary>
                  <pre>{JSON.stringify(alert.context, null, 2)}</pre>
                </details>
              )}
              <div className="alert-actions">
                <button
                  className="resolve-btn"
                  onClick={() => alert.id && handleResolve(alert.id)}
                  disabled={resolving === alert.id}
                >
                  {resolving === alert.id ? 'Resolving...' : '✓ Mark Resolved'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL HEALTH PAGE — Admin Financial System Monitoring
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shows:
 * - Ledger reconciliation status
 * - Credit suspension check results
 * - Financial cron job health
 * - Quick links to Financial Alerts + Disputes
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDateTime } from '../lib/date';
import { FinancialCronService } from '../services/FinancialCronService';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useToast } from '../components/common/Toast';
import './FinancialHealthPage.css';
import { reportError } from '../utils/errorReporter';

interface CronStatus {
  isRunning: boolean;
  lastReconciliation: {
    isBalanced: boolean;
    difference: number;
    checkedAt: string;
  } | null;
  lastSuspensionCheck: {
    agentsChecked: number;
    agentsSuspended: number;
    agentsWarned: number;
    unavailable?: boolean;
    checkedAt?: string;
    disabled?: boolean;
  } | null;
  config: {
    reconciliationIntervalMs: number;
    suspensionCheckIntervalMs: number;
    autoSuspendEnabled: boolean;
  };
}

export default function FinancialHealthPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const [status, setStatus] = useState<CronStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [manualReconciling, setManualReconciling] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);

  const loadStatus = () => {
    const s = FinancialCronService.getStatus();
    setStatus(s as CronStatus);
    setInitialLoad(false);
  };

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  // Refresh on tab re-focus
  useVisibilityRefresh(() => loadStatus());

  // Bus listeners: refresh when financial events fire
  useEffect(() => {
    const unsubAlert = masterBus.subscribeDebounced('FINANCIAL_ALERT', () => loadStatus(), 500);
    const unsubSettlement = masterBus.subscribeDebounced(
      'SETTLEMENT_COMPLETED',
      () => loadStatus(),
      1000
    );
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadStatus(), 1000);
    return () => {
      unsubAlert();
      unsubSettlement();
      unsubBalance();
    };
  }, []);

  const handleManualReconciliation = async () => {
    setManualReconciling(true);
    try {
      await FinancialCronService.runReconciliation();
      loadStatus();
    } catch (err) {
      reportError(err, 'FinancialHealthPage.Manual_reconciliation_failed');
      toast.error('Reconciliation failed');
    }
    setManualReconciling(false);
  };

  const handleManualSuspensionCheck = async () => {
    setRefreshing(true);
    try {
      await FinancialCronService.runSuspensionCheck();
      loadStatus();
    } catch (err) {
      reportError(err, 'FinancialHealthPage.Suspension_check_failed');
      toast.error('Suspension check failed');
    }
    setRefreshing(false);
  };

  const formatInterval = (ms: number): string => {
    const hours = ms / (60 * 60 * 1000);
    return hours >= 24 ? `${hours / 24}d` : `${hours}h`;
  };

  if (initialLoad && !status) {
    return (
      <div className="financial-health-page" style={{ padding: '16px' }}>
        <div className="fh-header">
          <h2>Financial Health Dashboard</h2>
        </div>
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'rgba(255,255,255,0.3)' }}>
          Loading Health Status...
        </div>
      </div>
    );
  }

  return (
    <div className="financial-health-page">
      <div className="fh-header">
        <h2>Financial Health Dashboard</h2>
        <button className="fh-refresh-btn" onClick={loadStatus} title="Refresh">
          ↻
        </button>
      </div>

      {/* System Status */}
      <section className="fh-section">
        <h3>System Status</h3>
        <div className="fh-status-grid">
          <div className={`fh-status-card ${status?.isRunning ? 'healthy' : 'error'}`}>
            <span className="fh-status-indicator">{status?.isRunning ? '✓' : '✕'}</span>
            <div>
              <div className="fh-status-label">Financial Cron</div>
              <div className="fh-status-value">{status?.isRunning ? 'Running' : 'Stopped'}</div>
            </div>
          </div>
          <div className="fh-status-card info">
            <span className="fh-status-indicator">◷</span>
            <div>
              <div className="fh-status-label">Reconciliation Interval</div>
              <div className="fh-status-value">
                {status ? formatInterval(status.config.reconciliationIntervalMs) : '-'}
              </div>
            </div>
          </div>
          <div className="fh-status-card info">
            <span className="fh-status-indicator">◆</span>
            <div>
              <div className="fh-status-label">Suspension Check</div>
              <div className="fh-status-value">
                Every {status ? formatInterval(status.config.suspensionCheckIntervalMs) : '-'}
              </div>
            </div>
          </div>
          <div
            className={`fh-status-card ${status?.config.autoSuspendEnabled ? 'warning' : 'info'}`}
          >
            <span className="fh-status-indicator">
              {status?.config.autoSuspendEnabled ? '▲' : '◉'}
            </span>
            <div>
              <div className="fh-status-label">Auto-Suspend</div>
              <div className="fh-status-value">
                {status?.config.autoSuspendEnabled ? 'Enabled' : 'Log-Only'}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Ledger Reconciliation */}
      <section className="fh-section">
        <div className="fh-section-header">
          <h3>Ledger Reconciliation</h3>
          <button
            className="fh-action-btn"
            onClick={handleManualReconciliation}
            disabled={manualReconciling}
          >
            {manualReconciling ? 'Running...' : 'Run Now'}
          </button>
        </div>
        {status?.lastReconciliation ? (
          <div
            className={`fh-result-card ${status.lastReconciliation.isBalanced ? 'balanced' : 'drift'}`}
          >
            <div className="fh-result-icon">{status.lastReconciliation.isBalanced ? '✓' : '⚠'}</div>
            <div className="fh-result-body">
              <div className="fh-result-title">
                {status.lastReconciliation.isBalanced ? 'Ledger Balanced' : 'Ledger Drift Detected'}
              </div>
              <div className="fh-result-detail">
                Difference: {status.lastReconciliation.difference.toLocaleString()} Chips
              </div>
              <div className="fh-result-time">
                Last Checked:{' '}
                {formatDateTime(status.lastReconciliation.checkedAt, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="fh-empty">No Reconciliation Runs Yet</div>
        )}
      </section>

      {/* Credit Suspension */}
      <section className="fh-section">
        <div className="fh-section-header">
          <h3>Credit Suspension Check</h3>
          <button
            className="fh-action-btn"
            onClick={handleManualSuspensionCheck}
            disabled={refreshing}
          >
            {refreshing ? 'Checking...' : 'Run Now'}
          </button>
        </div>
        {status?.lastSuspensionCheck ? (
          <div className="fh-suspension-stats">
            {status.lastSuspensionCheck.checkedAt && (
              <div>Last Attempt: {formatDateTime(status.lastSuspensionCheck.checkedAt)}</div>
            )}
            {status.lastSuspensionCheck.unavailable && (
              <div role="alert">
                Suspension Check Unavailable Or Incomplete. Counts Below Are Partial.{' '}
                {status.lastSuspensionCheck.disabled
                  ? 'Automatic Checks Are Paused After Repeated Failures. Reload The App To Retry.'
                  : 'Run Again To Retry.'}
              </div>
            )}
            <div className="fh-stat">
              <span className="fh-stat-value">{status.lastSuspensionCheck.agentsChecked}</span>
              <span className="fh-stat-label">Agents Checked</span>
            </div>
            <div className="fh-stat warning">
              <span className="fh-stat-value">{status.lastSuspensionCheck.agentsWarned}</span>
              <span className="fh-stat-label">Warned</span>
            </div>
            <div className="fh-stat danger">
              <span className="fh-stat-value">{status.lastSuspensionCheck.agentsSuspended}</span>
              <span className="fh-stat-label">Suspended</span>
            </div>
          </div>
        ) : (
          <div className="fh-empty">No Suspension Checks Run Yet</div>
        )}
      </section>

      {/* Quick Actions */}
      <section className="fh-section">
        <h3>Quick Actions</h3>
        <div className="fh-quick-actions">
          <button className="fh-nav-btn" onClick={() => navigate('/financial-alerts')}>
            Financial Alerts
          </button>
          <button className="fh-nav-btn" onClick={() => navigate('/disputes')}>
            ⚖ Dispute Management
          </button>
        </div>
      </section>
    </div>
  );
}

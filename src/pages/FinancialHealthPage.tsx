/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL HEALTH PAGE - Admin Financial System Monitoring (#ClubArenaConsole)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * One flow, one console. The cron's status, the last ledger reconciliation and
 * the last credit suspension check print as rows on the black glass between
 * engraved rules, each section with its own lit "Run Now"; the two quick
 * actions (Financial Alerts, Disputes) ride the painted plates. Every timer,
 * bus listener, visibility refresh and handler of the generic page is kept;
 * only the paint changed.
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
import { SpadeConsole } from '../components/console/SpadeConsole';
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
      <div className="financial-health-page">
        <SpadeConsole
          className="fhp__console"
          eyebrow="Financial Admin"
          title="Financial Health"
          titleId="financial-health-title"
          pill="Loading"
          pillInk="muted"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center fhp__state">Loading Health Status...</p>
        </SpadeConsole>
      </div>
    );
  }

  const running = Boolean(status?.isRunning);

  return (
    <div className="financial-health-page">
      <SpadeConsole
        className="fhp__console"
        eyebrow="Financial Admin"
        title="Financial Health"
        titleId="financial-health-title"
        pill={running ? 'Running' : 'Stopped'}
        pillInk={running ? 'green' : 'red'}
        plates={{
          secondary: { label: 'Alerts', onClick: () => navigate('/financial-alerts') },
          primary: { label: 'Disputes', ink: 'white', onClick: () => navigate('/disputes') },
        }}
      >
        {/* System Status */}
        <section className="fhp__section" aria-labelledby="fhp-system-status">
          <div className="fhp__section-head">
            <h3 id="fhp-system-status" className="fhp__section-title sc-label sc-ink--silver">
              System Status
            </h3>
            <button
              type="button"
              className="fhp-word sc-ink--white"
              onClick={loadStatus}
              title="Refresh"
            >
              Refresh
            </button>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Financial Cron</span>
            <span className={`fhp__row-value ${running ? 'sc-ink--green' : 'sc-ink--red'}`}>
              {running ? 'Running' : 'Stopped'}
            </span>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Reconciliation Interval</span>
            <span className="fhp__row-value sc-ink--silver">
              {status ? formatInterval(status.config.reconciliationIntervalMs) : '-'}
            </span>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Suspension Check</span>
            <span className="fhp__row-value sc-ink--silver">
              Every {status ? formatInterval(status.config.suspensionCheckIntervalMs) : '-'}
            </span>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Auto-Suspend</span>
            <span
              className={`fhp__row-value ${status?.config.autoSuspendEnabled ? 'sc-ink--gold' : 'sc-ink--silver'}`}
            >
              {status?.config.autoSuspendEnabled ? 'Enabled' : 'Log-Only'}
            </span>
          </div>
        </section>

        {/* Ledger Reconciliation */}
        <section className="fhp__section" aria-labelledby="fhp-ledger">
          <div className="fhp__section-head">
            <h3 id="fhp-ledger" className="fhp__section-title sc-label sc-ink--silver">
              Ledger Reconciliation
            </h3>
            <button
              type="button"
              className="fhp-word sc-ink--white"
              onClick={handleManualReconciliation}
              disabled={manualReconciling}
            >
              {manualReconciling ? 'Running...' : 'Run Now'}
            </button>
          </div>
          {status?.lastReconciliation ? (
            <>
              <div className="fhp__row">
                <span className="fhp__row-label sc-ink--blue">Result</span>
                <span
                  className={`fhp__row-value ${status.lastReconciliation.isBalanced ? 'sc-ink--green' : 'sc-ink--red'}`}
                >
                  {status.lastReconciliation.isBalanced
                    ? 'Ledger Balanced'
                    : 'Ledger Drift Detected'}
                </span>
              </div>
              <div className="fhp__row">
                <span className="fhp__row-label sc-ink--blue">Difference</span>
                {/* A drift figure is a number the admin acts on to the chip, so it
                    prints exactly rather than compacted. */}
                <span className="fhp__row-value sc-ink--silver">
                  {status.lastReconciliation.difference.toLocaleString()} Chips
                </span>
              </div>
              <div className="fhp__row">
                <span className="fhp__row-label sc-ink--blue">Last Checked</span>
                <span className="fhp__row-value sc-ink--muted">
                  {formatDateTime(status.lastReconciliation.checkedAt, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            </>
          ) : (
            <p className="sc-copy fhp__state">No Reconciliation Runs Yet</p>
          )}
        </section>

        {/* Credit Suspension */}
        <section className="fhp__section" aria-labelledby="fhp-suspension">
          <div className="fhp__section-head">
            <h3 id="fhp-suspension" className="fhp__section-title sc-label sc-ink--silver">
              Credit Suspension Check
            </h3>
            <button
              type="button"
              className="fhp-word sc-ink--white"
              onClick={handleManualSuspensionCheck}
              disabled={refreshing}
            >
              {refreshing ? 'Checking...' : 'Run Now'}
            </button>
          </div>
          {status?.lastSuspensionCheck ? (
            <>
              {status.lastSuspensionCheck.checkedAt && (
                <div className="fhp__row">
                  <span className="fhp__row-label sc-ink--blue">Last Attempt</span>
                  <span className="fhp__row-value sc-ink--muted">
                    {formatDateTime(status.lastSuspensionCheck.checkedAt)}
                  </span>
                </div>
              )}
              {status.lastSuspensionCheck.unavailable && (
                <p className="sc-copy fhp__alert sc-ink--gold" role="alert">
                  Suspension Check Unavailable Or Incomplete. Counts Below Are Partial.{' '}
                  {status.lastSuspensionCheck.disabled
                    ? 'Automatic Checks Are Paused After Repeated Failures. Reload The App To Retry.'
                    : 'Run Again To Retry.'}
                </p>
              )}
              {/* Value before label in the DOM: the suspension test reads the
                  figure as the label's previous sibling. The row reverses them
                  visually so the label still leads. */}
              <div className="fhp__row fhp__row--stat">
                <span className="fhp__row-value sc-ink--silver">
                  {status.lastSuspensionCheck.agentsChecked}
                </span>
                <span className="fhp__row-label sc-ink--blue">Agents Checked</span>
              </div>
              <div className="fhp__row fhp__row--stat">
                <span className="fhp__row-value sc-ink--gold">
                  {status.lastSuspensionCheck.agentsWarned}
                </span>
                <span className="fhp__row-label sc-ink--blue">Warned</span>
              </div>
              <div className="fhp__row fhp__row--stat">
                <span className="fhp__row-value sc-ink--red">
                  {status.lastSuspensionCheck.agentsSuspended}
                </span>
                <span className="fhp__row-label sc-ink--blue">Suspended</span>
              </div>
            </>
          ) : (
            <p className="sc-copy fhp__state">No Suspension Checks Run Yet</p>
          )}
        </section>
      </SpadeConsole>
    </div>
  );
}

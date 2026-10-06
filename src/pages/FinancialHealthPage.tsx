/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL HEALTH PAGE - Admin Financial System Monitoring (#ClubArenaConsole)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * One flow, one console. How the checks run, the last ledger reconciliation and
 * the last credit suspension check print as rows on the black glass between
 * engraved rules, each section with its own lit "Run Now"; the two quick
 * actions (Financial Alerts, Disputes) ride the painted plates. Every timer,
 * bus listener, visibility refresh and handler of the generic page is kept;
 * only the paint changed.
 *
 * Shows:
 * - Ledger reconciliation status
 * - Credit suspension check results
 * - How each check runs (nothing here is scheduled in the browser)
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
import { compactChips } from '../utils/format';

interface CronStatus {
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
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadStatus(), 1000);
    return () => {
      unsubAlert();
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

  if (initialLoad && !status) {
    return (
      <div className="financial-health-page">
        <SpadeConsole
          className="fhp__console"
          family="shark"
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

  return (
    <div className="financial-health-page">
      <SpadeConsole
        className="fhp__console"
        family="riveted"
        eyebrow="Financial Admin"
        title="Financial Health"
        titleId="financial-health-title"
        pill="On Demand"
        pillInk="silver"
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
          {/* Nothing here runs on a timer (2026-10-05). A browser schedule ran
              under whoever had a tab open, signed out included; reconciliation
              is server-side and the suspension check runs when an admin asks. */}
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Reconciliation</span>
            <span className="fhp__row-value sc-ink--silver">Server Side</span>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Suspension Check</span>
            <span className="fhp__row-value sc-ink--silver">On Demand</span>
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
                <span className="fhp__row-value sc-ink--silver">
                  {compactChips(status.lastReconciliation.difference)} Chips
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
                    ? 'Checks Are Paused After Repeated Failures. Reload The App To Retry.'
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

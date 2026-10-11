import { useEffect, useRef, useState } from 'react';
import {
  readCashierConservation,
  conservationChips,
  type CashierConservation,
} from '../../services/CashierConservation';
import { resolveClubUUIDStrict } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import './CashierConservationReport.css';

/** One operator-requested snapshot, never a repair, timer, or money action. */
export default function CashierConservationReport({
  userId,
  clubId,
  role,
  ready,
  online = true,
  getAuthorityEpoch,
  onRefresh,
  actionClassName,
}: {
  userId?: string;
  clubId: string | null;
  role: string;
  ready: boolean;
  online?: boolean;
  getAuthorityEpoch: () => number;
  onRefresh?: () => Promise<boolean>;
  actionClassName?: string;
}) {
  const eligible = ['owner', 'co_owner', 'admin'].includes(role);
  const [connected, setConnected] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    token: object;
    epoch: number;
    report: CashierConservation;
  } | null>(null);
  const [failure, setFailure] = useState<{ token: object; epoch: number; message: string } | null>(
    null
  );
  const scope = useRef({ userId, clubId, role, ready });
  if (
    scope.current.userId !== userId ||
    scope.current.clubId !== clubId ||
    scope.current.role !== role ||
    scope.current.ready !== ready
  )
    scope.current = { userId, clubId, role, ready };
  const mounted = useRef(true),
    inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const change = () => setConnected(navigator.onLine);
    window.addEventListener('online', change);
    window.addEventListener('offline', change);
    return () => {
      mounted.current = false;
      window.removeEventListener('online', change);
      window.removeEventListener('offline', change);
    };
  }, []);
  async function check() {
    if (!userId || !clubId || !ready || !eligible || !online || !connected || inFlight.current)
      return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    setResult(null);
    const token = scope.current,
      epoch = getAuthorityEpoch();
    const current = () =>
      mounted.current && scope.current === token && getAuthorityEpoch() === epoch;
    try {
      const uuid = await resolveClubUUIDStrict(clubId);
      if (!current()) return;
      if (onRefresh && !(await onRefresh())) throw new Error('Cashier Refresh Failed');
      if (!current()) return;
      const report = await readCashierConservation(uuid);
      if (current()) setResult({ token, epoch, report });
    } catch (error) {
      reportError(error, 'CashierConservationReport');
      if (current())
        setFailure({
          token,
          epoch,
          message: 'Accounting Report Is Unavailable. No Balances Were Changed.',
        });
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!eligible) return null;
  const report =
    result?.token === scope.current && result.epoch === getAuthorityEpoch() ? result.report : null;
  const verdict =
    report &&
    (report.bank.status === 'attention' || report.players.status === 'attention'
      ? 'Discrepancies Found'
      : report.bank.status === 'incomplete' || report.players.status === 'incomplete'
        ? 'Coverage Incomplete'
        : 'Covered Balances Match');
  return (
    <div className="cashier-conservation">
      <button
        type="button"
        className={actionClassName}
        onClick={() => void check()}
        disabled={!ready || !userId || !clubId || !online || !connected || busy}
      >
        {busy ? 'Checking Accounting...' : 'Reconcile Now'}
      </button>
      {busy && (
        <p className="sc-copy" role="status">
          Checking A Read-Only Accounting Snapshot...
        </p>
      )}
      {failure?.token === scope.current && failure.epoch === getAuthorityEpoch() && (
        <p className="sc-copy sc-ink--red" role="alert">
          {failure.message}
        </p>
      )}
      {report && (
        <section aria-label="Accounting Report" className="cashier-conservation__report">
          <p className="sc-copy" role="status">
            <strong>{verdict}</strong>
          </p>
          <p className="sc-copy">
            Bank And Player Baselines Only. Snapshot At {new Date(report.as_of).toLocaleString()}.
          </p>
          <dl className="cashier-conservation__rows">
            <div>
              <dt>Club Bank</dt>
              <dd>
                {report.bank.status === 'incomplete'
                  ? 'Missing Baseline Or Balance'
                  : report.bank.status === 'attention'
                    ? 'Discrepancy Found'
                    : 'Matches Baseline And Ledger'}
              </dd>
            </div>
            <div>
              <dt>Bank Actual / Expected</dt>
              <dd>
                {conservationChips(report.bank.actual)} / {conservationChips(report.bank.expected)}
              </dd>
            </div>
            <div>
              <dt>Bank Difference</dt>
              <dd>{conservationChips(report.bank.drift)}</dd>
            </div>
            <div>
              <dt>Player Coverage</dt>
              <dd>
                {report.players.checked.toLocaleString()} Of{' '}
                {report.players.positions.toLocaleString()} Checked
              </dd>
            </div>
            <div>
              <dt>Unverified Player Positions</dt>
              <dd>{report.players.missing.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Player Discrepancies</dt>
              <dd>{report.players.mismatches.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Total Absolute Player Difference</dt>
              <dd>{conservationChips(report.players.absolute_drift)}</dd>
            </div>
            <div>
              <dt>Net Player Difference</dt>
              <dd>{conservationChips(report.players.net_drift)}</dd>
            </div>
            <div>
              <dt>Agent Wallet Inventory</dt>
              <dd>{conservationChips(report.inventory.agent_wallets)}</dd>
            </div>
            <div>
              <dt>Promo Wallet Inventory</dt>
              <dd>{conservationChips(report.inventory.promo_wallets)}</dd>
            </div>
            <div>
              <dt>Held Chip Inventory</dt>
              <dd>{conservationChips(report.inventory.held_chips)}</dd>
            </div>
            <div>
              <dt>Cash Table Stack Inventory</dt>
              <dd>{conservationChips(report.inventory.cash_stacks)}</dd>
            </div>
          </dl>
          <p className="sc-copy sc-ink--gold">
            Inventory Is Unverified. In-Flight Pots, Escrow, Reservations, And Tournament Units Are
            Not A Complete Supply Check. This Report Does Not Move Chips Or Repair Balances.
          </p>
        </section>
      )}
    </div>
  );
}

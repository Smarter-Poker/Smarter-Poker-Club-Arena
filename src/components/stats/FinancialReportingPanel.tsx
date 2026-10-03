import { useCallback, useEffect, useState } from 'react';
import {
  StatsFinancialReportService,
  type StatsFinancialReport,
} from '../../services/StatsFinancialReportService';
import './FinancialReportingPanel.css';
import { titleCase } from '../../utils/titleCase';
import { reportError } from '../../utils/errorReporter';

interface Props {
  userId: string;
  clubId: string | null;
  clubLabel: string;
  days: number | null;
  timezone: string;
  asset: string;
  resetKey?: string;
}
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (v: unknown, asset: string) =>
  `${n(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${asset === 'diamonds' ? 'Diamonds' : 'Chips'}`;
const rows = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const label = (v: unknown) =>
  titleCase(
    String(v ?? '')
      .split('_')
      .join(' ')
  );

export default function FinancialReportingPanel(p: Props) {
  const [report, setReport] = useState<StatsFinancialReport | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const load = useCallback(async () => {
    setState('loading');
    try {
      const next = await StatsFinancialReportService.get(
        p.userId,
        p.clubId,
        p.days,
        p.timezone,
        p.asset
      );
      if (!next) throw new Error('Financial report missing');
      setReport(next);
      setState('ready');
    } catch (error) {
      reportError(error, 'FinancialReportingPanel.load');
      setReport(null);
      setState('error');
    }
  }, [p.userId, p.clubId, p.days, p.timezone, p.asset]);
  useEffect(() => {
    void load();
  }, [load, reload, p.resetKey]);
  if (state === 'loading')
    return (
      <section className="financial-console is-loading" aria-busy="true">
        <span className="financial-kicker">Verified Financial Ledger</span>
        <h2>Opening Receipt Vault...</h2>
      </section>
    );
  if (state === 'error')
    return (
      <section className="financial-console is-error" role="alert">
        <span className="financial-kicker">Financial Readout Interrupted</span>
        <h2>Receipts Could Not Be Verified</h2>
        <p>No Stale Or Mismatched Financial Payload Is Displayed.</p>
        <button onClick={() => setReload((x) => x + 1)}>Retry Verified Read</button>
      </section>
    );
  const wallet: any = report?.tournament_wallet ?? {};
  const rake: any = report?.rakeback ?? {};
  const availability: any = report?.availability ?? {};
  const tx = rows(wallet.entries);
  const periods = rows(rake.periods);
  const payouts = rows(rake.payout_receipts);
  return (
    <section className="financial-console" aria-labelledby="financial-console-title">
      <img
        src={`${import.meta.env.BASE_URL}images/stats/player-intelligence-console-v1.webp`}
        alt=""
        aria-hidden="true"
      />
      <header>
        <div>
          <span className="financial-kicker">
            Verified Financial Ledger // {label(p.clubLabel)}
          </span>
          <h2 id="financial-console-title">Financial Reporting Vault</h2>
          <p>Posted Receipts Only. Every Amount Remains In Its Original Unit.</p>
        </div>
        <span className={`financial-unit unit-${p.asset}`}>
          {p.asset === 'diamonds' ? 'Diamond Ledger' : 'Chip Ledger'}
        </span>
      </header>
      {p.asset === 'diamonds' && !availability.tournament_wallet && (
        <div className="financial-unavailable" role="status">
          <strong>Diamond Tournament Receipts Unavailable</strong>
          <span>The Chip Wallet Journal Is Never Re-Labeled Or Added To A Diamond Report.</span>
        </div>
      )}
      <div className="financial-readouts" aria-label="Financial Totals">
        <article>
          <span>Wallet Debits</span>
          <strong>{money((wallet.totals as any)?.debits, p.asset)}</strong>
        </article>
        <article>
          <span>Wallet Credits</span>
          <strong>{money((wallet.totals as any)?.credits, p.asset)}</strong>
        </article>
        <article>
          <span>Net Posted</span>
          <strong>{money((wallet.totals as any)?.net, p.asset)}</strong>
        </article>
        <article>
          <span>Rakeback Pending</span>
          <strong>{money(rake.pending_amount, p.asset)}</strong>
        </article>
        <article>
          <span>Rakeback Paid</span>
          <strong>{money(rake.paid_amount, p.asset)}</strong>
        </article>
      </div>
      {wallet.capped && (
        <p className="financial-coverage" role="status">
          Showing The 250 Most Recent Tournament Receipts. Totals Include The Complete Selected
          Range.
        </p>
      )}
      <div className="financial-ledger-grid">
        <section>
          <h3>Tournament Wallet Receipts</h3>
          {tx.length === 0 ? (
            <p className="financial-empty">No Posted Tournament Wallet Receipts In This Scope.</p>
          ) : (
            <div className="financial-receipts">
              {tx.map((r) => (
                <details key={r.id}>
                  <summary>
                    <span>{label(r.category)}</span>
                    <strong>
                      {r.type === 'debit' ? '-' : '+'}
                      {money(r.amount, p.asset)}
                    </strong>
                    <time>{new Date(r.created_at).toLocaleDateString()}</time>
                  </summary>
                  <dl>
                    <div>
                      <dt>Receipt</dt>
                      <dd>{r.id}</dd>
                    </div>
                    <div>
                      <dt>Tournament</dt>
                      <dd>{r.tournament_id}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>Posted {label(r.type)}</dd>
                    </div>
                  </dl>
                </details>
              ))}
            </div>
          )}
        </section>
        <section>
          <h3>Rakeback Periods & Payouts</h3>
          {periods.length === 0 && payouts.length === 0 ? (
            <p className="financial-empty">No Rakeback Period Or Payout Receipt In This Scope.</p>
          ) : (
            <div className="financial-receipts">
              {periods.map((r) => (
                <details key={`period-${r.id}`}>
                  <summary>
                    <span>Period {label(r.status)}</span>
                    <strong>{money(r.amount, p.asset)}</strong>
                    <time>{new Date(r.period_end).toLocaleDateString()}</time>
                  </summary>
                  <dl>
                    <div>
                      <dt>Period Receipt</dt>
                      <dd>{r.id}</dd>
                    </div>
                    {r.deferred_reason && (
                      <div>
                        <dt>Deferred</dt>
                        <dd>{label(r.deferred_reason)}</dd>
                      </div>
                    )}
                  </dl>
                </details>
              ))}
              {payouts.map((r) => (
                <details key={`payout-${r.id}`} className={`status-${r.status}`}>
                  <summary>
                    <span>Payout {label(r.status)}</span>
                    <strong>{money(r.payout_amount, p.asset)}</strong>
                    <time>{new Date(r.paid_at ?? r.created_at).toLocaleDateString()}</time>
                  </summary>
                  <dl>
                    <div>
                      <dt>Payout Receipt</dt>
                      <dd>{r.id}</dd>
                    </div>
                    <div>
                      <dt>Wallet Receipt</dt>
                      <dd>{r.wallet_transaction_id ?? 'Not Issued'}</dd>
                    </div>
                    {r.failure_reason && (
                      <div>
                        <dt>Failure</dt>
                        <dd>{label(r.failure_reason)}</dd>
                      </div>
                    )}
                  </dl>
                </details>
              ))}
            </div>
          )}
        </section>
      </div>
      <div className="financial-limitations">
        <article>
          <strong>Bankroll Series Not Yet Available</strong>
          <span>{label(availability.bankroll_reason ?? 'No Club-Scoped Balance Ledger')}</span>
        </article>
      </div>
    </section>
  );
}

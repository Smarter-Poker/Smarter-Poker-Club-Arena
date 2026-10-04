import { useEffect, useState } from 'react';
import {
  StatsFinancialReportService,
  type StatsFinancialReport,
} from '../../services/StatsFinancialReportService';
import './FinancialReportingPanel.css';
import { titleCase } from '../../utils/titleCase';
import { reportError } from '../../utils/errorReporter';
import { SpadeConsole } from '../console/SpadeConsole';
import { compactChips } from '../../utils/format';

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
  `${compactChips(n(v))} ${asset === 'diamonds' ? 'Diamonds' : 'Chips'}`;
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
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setReport(null);
    void StatsFinancialReportService.get(p.userId, p.clubId, p.days, p.timezone, p.asset)
      .then((next) => {
        if (cancelled) return;
        if (!next) throw new Error('Financial report missing');
        setReport(next);
        setState('ready');
      })
      .catch((error) => {
        if (cancelled) return;
        reportError(error, 'FinancialReportingPanel.load');
        setReport(null);
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [p.userId, p.clubId, p.days, p.timezone, p.asset, reload, p.resetKey]);
  if (state === 'loading')
    return (
      <SpadeConsole
        family="riveted"
        crest={p.asset === 'diamonds' ? 'diamond' : 'spade'}
        eyebrow="Verified Financial Ledger"
        title="Opening Receipt Vault..."
        pill="Verifying"
        className="financial-vault-shell is-loading"
        aria-busy="true"
      />
    );
  if (state === 'error')
    return (
      <SpadeConsole
        family="riveted"
        crest={p.asset === 'diamonds' ? 'diamond' : 'spade'}
        eyebrow="Financial Readout Interrupted"
        title="Receipts Could Not Be Verified"
        pill="Interrupted"
        pillInk="red"
        className="financial-vault-shell is-error"
        role="alert"
      >
        <div className="financial-console">
          <p>No Stale Or Mismatched Financial Payload Is Displayed.</p>
          <button
            type="button"
            className="financial-word-action"
            onClick={() => setReload((x) => x + 1)}
          >
            Retry Verified Read
          </button>
        </div>
      </SpadeConsole>
    );
  const wallet: any = report?.tournament_wallet ?? {};
  const rake: any = report?.rakeback ?? {};
  const availability: any = report?.availability ?? {};
  const tx = rows(wallet.entries);
  const periods = rows(rake.periods);
  const payouts = rows(rake.payout_receipts);
  return (
    <SpadeConsole
      family="riveted"
      crest={p.asset === 'diamonds' ? 'diamond' : 'spade'}
      eyebrow={`Verified Financial Ledger // ${label(p.clubLabel)}`}
      title="Financial Reporting Vault"
      titleId="financial-console-title"
      pill={p.asset === 'diamonds' ? 'Diamond Ledger' : 'Chip Ledger'}
      pillInk={p.asset === 'diamonds' ? 'blue' : 'gold'}
      className="financial-vault-shell"
      aria-labelledby="financial-console-title"
    >
      <section className="financial-console">
        <p className="financial-intro">
          Posted Receipts Only. Every Amount Remains In Its Original Unit.
        </p>
        {p.asset === 'diamonds' && !availability.tournament_wallet && (
          <div className="financial-unavailable" role="status">
            <strong>Diamond Tournament Receipts Unavailable</strong>
            <span>The Chip Wallet Journal Is Never Re-Labeled Or Added To A Diamond Report.</span>
          </div>
        )}
        {p.asset === 'diamonds' && !availability.rakeback && (
          <div className="financial-unavailable" role="status">
            <strong>Diamond Rakeback Receipts Unavailable</strong>
            <span>The Chip Rakeback Ledger Is Never Re-Labeled Or Added To A Diamond Report.</span>
          </div>
        )}
        <div className="financial-readouts" aria-label="Financial Totals">
          <article>
            <span>Wallet Debits</span>
            <strong>
              {availability.tournament_wallet
                ? money((wallet.totals as any)?.debits, p.asset)
                : 'Unavailable'}
            </strong>
          </article>
          <article>
            <span>Wallet Credits</span>
            <strong>
              {availability.tournament_wallet
                ? money((wallet.totals as any)?.credits, p.asset)
                : 'Unavailable'}
            </strong>
          </article>
          <article>
            <span>Net Posted</span>
            <strong>
              {availability.tournament_wallet
                ? money((wallet.totals as any)?.net, p.asset)
                : 'Unavailable'}
            </strong>
          </article>
          <article>
            <span>Rakeback Pending</span>
            <strong>
              {availability.rakeback ? money(rake.pending_amount, p.asset) : 'Unavailable'}
            </strong>
          </article>
          <article>
            <span>Rakeback Paid</span>
            <strong>
              {availability.rakeback ? money(rake.paid_amount, p.asset) : 'Unavailable'}
            </strong>
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
            {!availability.tournament_wallet ? (
              <p className="financial-empty">
                Tournament Wallet Receipts Unavailable In This Asset.
              </p>
            ) : tx.length === 0 ? (
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
            {!availability.rakeback ? (
              <p className="financial-empty">Rakeback Receipts Unavailable In This Asset.</p>
            ) : periods.length === 0 && payouts.length === 0 ? (
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
    </SpadeConsole>
  );
}

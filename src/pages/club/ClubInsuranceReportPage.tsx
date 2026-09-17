/**
 * CLUB INSURANCE REPORT (2026-08-28)
 * ============================================================================
 * The club staff's view of the all-in insurance product: the decision FUNNEL
 * (offers -> accepted / declined / timeouts / cashouts) next to the MONEY
 * (bank in / out / net), per day. The dashboard's revenue card shows the
 * headline net; this page answers the question that number raises — are
 * players actually buying at the offered rates, and what is each day worth?
 *
 * Data: ca_club_insurance_report RPC — SECURITY DEFINER, gated server-side on
 * ca_can_view_club_finances (owner / admin / super_agent / platform admin),
 * ERRCODE 42501 like its siblings. The client gate is cosmetic.
 *
 * Funnel rows come from insurance_offer_events (engine-written, fire-and-
 * forget); money rows from insurance_transactions (the settled ledger). The
 * two are reconciled nightly (insurance_bank + insurance_offer_unresolved in
 * reconcile_ledger_nightly), so this page can present them side by side
 * without re-deriving anything.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { isAuthzError } from '../../utils/clubDashboard';
import { reportError } from '../../utils/errorReporter';
import { downloadCsv, csvEscape } from '../../utils/downloadCsv';
import styles from './ClubInsuranceReportPage.module.css';
import { ErrorState } from '../../components/common/EmptyState';

interface ReportDay {
  day: string;
  offers: number;
  accepted: number;
  declined: number;
  timeouts: number;
  cashouts: number;
  contracts: number;
  bank_in: number;
  bank_out: number;
  bank_net: number;
}

interface Report {
  window_days: number;
  /** The UTC days the whole report covers, headline and rows alike. */
  window_start: string;
  window_end: string;
  bank: 'union' | 'club' | null;
  totals: {
    offers: number;
    accepted: number;
    declined: number;
    timeouts: number;
    cashouts: number;
    /** Server-computed: (accepted + cashed out) / offers. */
    take_rate_pct: number | null;
    avg_offer_equity: number | null;
    avg_offer_pot: number | null;
  };
  money: {
    contracts: number;
    insurance_contracts: number;
    cashout_contracts: number;
    bank_in: number;
    bank_out: number;
    bank_net: number;
  };
  days: ReportDay[];
}

const WINDOWS = [7, 30, 90] as const;

const chips = (n: number) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function ClubInsuranceReportPage() {
  const { clubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!clubId) return;
    setLoading(true);
    setError(null);
    // The route carries the club's SLUG (clubs/deep-stack-society-11192/...)
    // and this handed it to a uuid argument, so on every slug URL the RPC
    // answered 22P02 and the page said "Could Not Load". Resolve first, and
    // name a club that does not exist as one.
    let resolved: string;
    try {
      const { resolveClubUUIDStrict } = await import('../../utils/strictClubIdResolver');
      resolved = await resolveClubUUIDStrict(clubId);
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'ClubNotFoundError') {
        setNotFound(true);
      } else {
        reportError(e, 'ClubInsuranceReportPage.Resolve_failed');
        setError('The Club Could Not Be Resolved');
      }
      setLoading(false);
      return;
    }
    const { data, error: rpcError } = await supabase.rpc('ca_club_insurance_report', {
      p_club_id: resolved,
      p_days: days,
    });
    if (rpcError) {
      if (isAuthzError(rpcError)) {
        setDenied(true);
      } else {
        reportError(rpcError, 'ClubInsuranceReportPage.Load_failed');
        setError('Could Not Load The Insurance Report');
      }
      setReport(null);
    } else {
      setReport(data as Report);
    }
    setLoading(false);
  }, [clubId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = useCallback(() => {
    if (!report) return;
    const header =
      'day,offers,accepted,declined,timeouts,cashouts,contracts,bank_in,bank_out,bank_net';
    const rows = report.days.map((d) =>
      [
        d.day,
        d.offers,
        d.accepted,
        d.declined,
        d.timeouts,
        d.cashouts,
        d.contracts,
        d.bank_in,
        d.bank_out,
        d.bank_net,
      ]
        .map((v) => csvEscape(String(v)))
        .join(',')
    );
    downloadCsv(
      `insurance-report-${clubId}-${report.window_days}d.csv`,
      [header, ...rows].join('\n')
    );
  }, [report, clubId]);

  if (notFound) {
    return (
      <div className={styles.page}>
        <div className={styles.deniedCard}>
          <h1>Club Not Found</h1>
          <p>No Club Answers To That Address.</p>
          <button className={styles.backBtn} onClick={() => navigate('/clubs')}>
            Back To Clubs
          </button>
        </div>
      </div>
    );
  }

  if (denied) {
    return (
      <div className={styles.page}>
        <div className={styles.deniedCard}>
          <h1>Insurance Report</h1>
          <p>This Report Is Only Available To Club Staff.</p>
          <button className={styles.backBtn} onClick={() => navigate(`/clubs/${clubId}`)}>
            Back To Club
          </button>
        </div>
      </div>
    );
  }

  const t = report?.totals;
  const m = report?.money;
  // PHASE 6 (2026-09-04): the take rate is the server's now, computed over
  // OFFERS. This divided event counts by event counts - an offer accepted and
  // then cashed out counted twice in the numerator and once in the
  // denominator, so the rate could pass 100% - and the funnel and the money
  // used different windows (a rolling timestamp against UTC day buckets), so
  // the day rows below could never sum to the headline above them.
  const acceptRate = t?.take_rate_pct ?? null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(`/clubs/${clubId}`)}>
          Back
        </button>
        <h1>Insurance Report</h1>
        <div className={styles.windows}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              className={days === w ? styles.windowActive : styles.window}
              onClick={() => setDays(w)}
            >
              {w}d
            </button>
          ))}
        </div>
      </header>

      {loading && !report ? (
        <p className={styles.empty}>Loading Report...</p>
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !report ? (
        <p className={styles.empty}>No Report Data</p>
      ) : (
        <>
          <section className={styles.cards}>
            <div className={styles.card}>
              <div className={styles.cardValue}>{t?.offers ?? 0}</div>
              <div className={styles.cardLabel}>Offers Shown</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>
                {t?.accepted ?? 0} / {t?.cashouts ?? 0}
              </div>
              <div className={styles.cardLabel}>Insured / Cashed Out</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>
                {t?.declined ?? 0} / {t?.timeouts ?? 0}
              </div>
              <div className={styles.cardLabel}>Declined / Timed Out</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>{acceptRate === null ? '-' : `${acceptRate}%`}</div>
              <div className={styles.cardLabel}>Take Rate</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>
                {t?.avg_offer_equity == null ? '-' : `${t.avg_offer_equity}%`}
              </div>
              <div className={styles.cardLabel}>Avg Offer Equity</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>
                {t?.avg_offer_pot == null ? '-' : chips(t.avg_offer_pot)}
              </div>
              <div className={styles.cardLabel}>Avg Insurable Pot</div>
            </div>
          </section>

          <section className={styles.cards}>
            <div className={styles.card}>
              <div className={styles.cardValue}>{m?.contracts ?? 0}</div>
              <div className={styles.cardLabel}>
                Settled Contracts ({m?.insurance_contracts ?? 0} Ins / {m?.cashout_contracts ?? 0}{' '}
                Cash)
              </div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>{chips(m?.bank_in ?? 0)}</div>
              <div className={styles.cardLabel}>Bank In (Fees + Redirects)</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>{chips(m?.bank_out ?? 0)}</div>
              <div className={styles.cardLabel}>Bank Out (Payouts)</div>
            </div>
            <div className={styles.card}>
              <div
                className={styles.cardValue}
                style={{ color: (m?.bank_net ?? 0) >= 0 ? 'var(--success, #4dc660)' : '#f87171' }}
              >
                {chips(m?.bank_net ?? 0)}
              </div>
              <div className={styles.cardLabel}>
                Net {report.bank === 'union' ? '(To Union Bank)' : '(Club Bank)'}
              </div>
            </div>
          </section>

          <section className={styles.tableSection}>
            <div className={styles.tableHeader}>
              <h2>
                Per Day
                {report.window_start ? ` - ${report.window_start} To ${report.window_end}` : ''}
              </h2>
              <button className={styles.exportBtn} onClick={exportCsv}>
                Export CSV
              </button>
            </div>
            {report.days.length === 0 ? (
              <p className={styles.empty}>No Insurance Activity In This Window</p>
            ) : (
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Offers</th>
                      <th>Ins</th>
                      <th>Cash</th>
                      <th>Decl</th>
                      <th>T/O</th>
                      <th>Contracts</th>
                      <th>In</th>
                      <th>Out</th>
                      <th>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.days.map((d) => (
                      <tr key={d.day}>
                        <td>{d.day}</td>
                        <td>{d.offers}</td>
                        <td>{d.accepted}</td>
                        <td>{d.cashouts}</td>
                        <td>{d.declined}</td>
                        <td>{d.timeouts}</td>
                        <td>{d.contracts}</td>
                        <td>{chips(d.bank_in)}</td>
                        <td>{chips(d.bank_out)}</td>
                        <td
                          style={{ color: d.bank_net >= 0 ? 'var(--success, #4dc660)' : '#f87171' }}
                        >
                          {chips(d.bank_net)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

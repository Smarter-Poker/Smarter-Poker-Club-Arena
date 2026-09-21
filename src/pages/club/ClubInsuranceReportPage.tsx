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
 *
 * #ClubArenaConsole: one console. The window as lit words, the funnel and
 * the money as rows on the black glass, the per-day records as rows between
 * engraved rules (never HTML-table chrome), Back and Export CSV on the two
 * painted plates. Every read, guard and pinned literal of the generic page
 * is kept.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { isAuthzError } from '../../utils/clubDashboard';
import { reportError } from '../../utils/errorReporter';
import { downloadCsv, csvEscape } from '../../utils/downloadCsv';
import styles from './ClubInsuranceReportPage.module.css';
import { SpadeConsole } from '../../components/console/SpadeConsole';
import { compactChips } from '../../utils/format';

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

/* Report money is forward-facing and reads compact (Dan: no decimals, 1.2K
   past a thousand). The CSV below still carries the exact figures. */
const chips = (n: number) => compactChips(Number(n ?? 0));

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
        <SpadeConsole
          className={styles.console}
          eyebrow="Insurance"
          title="Club Not Found"
          titleId="insurance-report-title"
          pill="Missing"
          pillInk="muted"
          foot="foot"
        >
          <p className={`sc-copy sc-copy--center ${styles.state}`}>
            No Club Answers To That Address.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.word} sc-ink--white`}
              onClick={() => navigate('/clubs')}
            >
              Back To Clubs
            </button>
          </div>
        </SpadeConsole>
      </div>
    );
  }

  if (denied) {
    return (
      <div className={styles.page}>
        <SpadeConsole
          className={styles.console}
          eyebrow="Insurance"
          title="Insurance Report"
          titleId="insurance-report-title"
          pill="Staff"
          pillInk="red"
          foot="foot"
        >
          <p className={`sc-copy sc-copy--center ${styles.state}`}>
            This Report Is Only Available To Club Staff.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.word} sc-ink--white`}
              onClick={() => navigate(`/clubs/${clubId}`)}
            >
              Back To Club
            </button>
          </div>
        </SpadeConsole>
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

  const netInk = (n: number) => (n >= 0 ? 'sc-ink--green' : 'sc-ink--red');

  return (
    <div className={styles.page}>
      <SpadeConsole
        className={styles.console}
        eyebrow="Insurance"
        title="Insurance Report"
        titleId="insurance-report-title"
        pill={`${days} Days`}
        pillInk="blue"
        plates={{
          secondary: { label: 'Back', onClick: () => navigate(`/clubs/${clubId}`) },
          primary: { label: 'Export CSV', ink: 'white', onClick: exportCsv, disabled: !report },
        }}
      >
        <div className={styles.windows} role="group" aria-label="Report Window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={`${styles.word} ${days === w ? 'sc-ink--white' : 'sc-ink--muted'}`}
              aria-pressed={days === w}
              onClick={() => setDays(w)}
            >
              {w} Days
            </button>
          ))}
        </div>

        {loading && !report ? (
          <p className={`sc-copy sc-copy--center ${styles.state}`} aria-busy="true">
            Loading Report...
          </p>
        ) : error ? (
          <div className={styles.errorState} role="alert">
            <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--red`}>{error}</p>
            <button
              type="button"
              className={`${styles.word} sc-ink--white`}
              onClick={() => void load()}
            >
              Retry
            </button>
          </div>
        ) : !report ? (
          <p className={`sc-copy sc-copy--center ${styles.state}`}>No Report Data</p>
        ) : (
          <>
            <section className={styles.section} aria-label="Decision Funnel">
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Offers Shown</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>
                  {(t?.offers ?? 0).toLocaleString()}
                </span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Insured / Cashed Out</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>
                  {t?.accepted ?? 0} / {t?.cashouts ?? 0}
                </span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Declined / Timed Out</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>
                  {t?.declined ?? 0} / {t?.timeouts ?? 0}
                </span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Take Rate</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>
                  {acceptRate === null ? '-' : `${acceptRate}%`}
                </span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Avg Offer Equity</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>
                  {t?.avg_offer_equity == null ? '-' : `${t.avg_offer_equity}%`}
                </span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Avg Insurable Pot</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>
                  {t?.avg_offer_pot == null ? '-' : chips(t.avg_offer_pot)}
                </span>
              </div>
            </section>

            <section className={styles.section} aria-label="Money">
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>
                  Settled Contracts ({m?.insurance_contracts ?? 0} Ins / {m?.cashout_contracts ?? 0}{' '}
                  Cash)
                </span>
                <span className={`${styles.rowValue} sc-ink--silver`}>{m?.contracts ?? 0}</span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>
                  Bank In (Fees + Redirects)
                </span>
                <span className={`${styles.rowValue} sc-ink--silver`}>
                  {chips(m?.bank_in ?? 0)}
                </span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Bank Out (Payouts)</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>
                  {chips(m?.bank_out ?? 0)}
                </span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>
                  Net {report.bank === 'union' ? '(To Union Bank)' : '(Club Bank)'}
                </span>
                <span className={`${styles.rowValue} ${netInk(m?.bank_net ?? 0)}`}>
                  {chips(m?.bank_net ?? 0)}
                </span>
              </div>
            </section>

            <section className={styles.section} aria-labelledby="insurance-per-day">
              <h2
                id="insurance-per-day"
                className={`${styles.sectionTitle} sc-label sc-ink--silver`}
              >
                Per Day
                {report.window_start ? ` - ${report.window_start} To ${report.window_end}` : ''}
              </h2>
              {report.days.length === 0 ? (
                <p className={`sc-copy sc-copy--center ${styles.state}`}>
                  No Insurance Activity In This Window
                </p>
              ) : (
                <ul className={styles.records}>
                  {report.days.map((d) => (
                    <li key={d.day} className={styles.record}>
                      <div className={styles.recordHead}>
                        <span className={`${styles.recordName} sc-ink--silver`}>{d.day}</span>
                        <span className={`${styles.recordNet} ${netInk(d.bank_net)}`}>
                          {chips(d.bank_net)} Net
                        </span>
                      </div>
                      <dl className={styles.figures}>
                        <div className={styles.figure}>
                          <dt className={`${styles.figureLabel} sc-ink--muted`}>Offers</dt>
                          <dd className={`${styles.figureValue} sc-ink--silver`}>{d.offers}</dd>
                        </div>
                        <div className={styles.figure}>
                          <dt className={`${styles.figureLabel} sc-ink--muted`}>Ins</dt>
                          <dd className={`${styles.figureValue} sc-ink--silver`}>{d.accepted}</dd>
                        </div>
                        <div className={styles.figure}>
                          <dt className={`${styles.figureLabel} sc-ink--muted`}>Cash</dt>
                          <dd className={`${styles.figureValue} sc-ink--silver`}>{d.cashouts}</dd>
                        </div>
                        <div className={styles.figure}>
                          <dt className={`${styles.figureLabel} sc-ink--muted`}>Decl</dt>
                          <dd className={`${styles.figureValue} sc-ink--silver`}>{d.declined}</dd>
                        </div>
                        <div className={styles.figure}>
                          <dt className={`${styles.figureLabel} sc-ink--muted`}>T/O</dt>
                          <dd className={`${styles.figureValue} sc-ink--silver`}>{d.timeouts}</dd>
                        </div>
                        <div className={styles.figure}>
                          <dt className={`${styles.figureLabel} sc-ink--muted`}>Contracts</dt>
                          <dd className={`${styles.figureValue} sc-ink--silver`}>{d.contracts}</dd>
                        </div>
                        <div className={styles.figure}>
                          <dt className={`${styles.figureLabel} sc-ink--muted`}>In</dt>
                          <dd className={`${styles.figureValue} sc-ink--silver`}>
                            {chips(d.bank_in)}
                          </dd>
                        </div>
                        <div className={styles.figure}>
                          <dt className={`${styles.figureLabel} sc-ink--muted`}>Out</dt>
                          <dd className={`${styles.figureValue} sc-ink--silver`}>
                            {chips(d.bank_out)}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </SpadeConsole>
    </div>
  );
}

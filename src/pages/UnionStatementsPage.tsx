/**
 * UNION STATEMENTS
 * ============================================================================
 * The union lead's side of the weekly square-up.
 *
 * Until this page existed the statements could only be read from the club that
 * received one. That is a structural blind spot, not merely a missing screen:
 * a per-club view can never show you the club you FORGOT to bill. So this
 * board is built around the club list, not the invoice list. Every club in the
 * union appears for the period, and a club with no statement appears as
 * "no statement" rather than quietly not appearing at all.
 *
 * Data: ca_union_statement_board, gated server-side on ca_can_oversee_union
 * (union owner, union admin, or platform admin). The client gate below is
 * cosmetic; the RPC raises 42501 on its own.
 *
 * Issuing goes through /api/club-arena/union-invoice, the same route the
 * Monday Open Claw job calls. Everything downstream is idempotent - one
 * statement per club per period, and message_sent stops a delivery happening
 * twice - so the button here is a safety net for a Monday that did not fire,
 * not a second billing path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { isAuthzError } from '../utils/clubDashboard';
import { reportError } from '../utils/errorReporter';
import { downloadCsv, csvEscape } from '../utils/downloadCsv';
import { useToast } from '../components/common/Toast';
import styles from './UnionStatementsPage.module.css';

interface BoardClub {
  club_id: string;
  club_name: string;
  club_code: string | null;
  club_slug: string | null;
  invoice_id: string | null;
  status: string;
  issued_at: string | null;
  due_at: string | null;
  amount: number;
  direction: string | null;
  message_sent: boolean;
  overdue: boolean;
  paid_total: number;
  outstanding: number;
  rake_generated: number;
  rakeback_due: number;
  union_fee_kept: number;
  players_won: number;
  eco_amount: number;
  presettled: number;
}

interface BoardPeriod {
  period_start: string | null;
  period_end: string;
  clubs: number;
  total_amount: number;
  rake_generated: number;
  eco_amount: number;
  paid: number;
  delivered: number;
}

interface BoardTotals {
  clubs: number;
  issued: number;
  missing: number;
  delivered: number;
  paid: number;
  clubs_owe: number;
  union_owes: number;
  net: number;
  collected: number;
  outstanding: number;
  rake_generated: number;
  eco_amount: number;
}

interface Board {
  union_id: string;
  union_name: string | null;
  period_end: string | null;
  period_start: string | null;
  totals: BoardTotals;
  clubs: BoardClub[];
  history: BoardPeriod[];
  generated_at: string;
}

function money(n: number | null | undefined): string {
  return Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function compactInt(n: number | null | undefined): string {
  return Number(n || 0).toLocaleString('en-US');
}

function boardToCsv(rows: BoardClub[]): string {
  const esc = csvEscape;
  const head = [
    'club_name', 'club_code', 'status', 'amount', 'direction', 'delivered',
    'due_at', 'paid_total', 'outstanding', 'rake_generated', 'rakeback_due',
    'union_fee_kept', 'players_won', 'eco_amount', 'presettled',
  ];
  const lines = rows.map((r) => [
    r.club_name, r.club_code, r.status, r.amount, r.direction, r.message_sent,
    r.due_at, r.paid_total, r.outstanding, r.rake_generated, r.rakeback_due,
    r.union_fee_kept, r.players_won, r.eco_amount, r.presettled,
  ].map(esc).join(','));
  return [head.join(','), ...lines].join('\n');
}

export default function UnionStatementsPage() {
  const navigate = useNavigate();
  const { unionId } = useParams<{ unionId: string }>();
  const { user, isHydrating } = useAuthUser();
  const toast = useToast();

  const [board, setBoard] = useState<Board | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [confirmIssue, setConfirmIssue] = useState(false);
  // Switching period, and issuing, can both leave two reads in flight. Without
  // a version the older one may land last and show the wrong week's money.
  const loadVersion = useRef(0);
  const [settlingId, setSettlingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!unionId) {
      setError('No union selected.');
      setLoading(false);
      return;
    }
    const myVersion = ++loadVersion.current;
    const stale = () => loadVersion.current !== myVersion;
    // Raised on every load, not just the first: tapping a period chip used to
    // leave the previous period's totals and rows on screen with no spinner,
    // which reads as the new period's money.
    setLoading(true);
    try {
      const { data, error: rpcError } = await supabase.rpc('ca_union_statement_board', {
        p_union_id: unionId,
        p_period_end: period,
        p_history: 12,
      });
      if (stale()) return;
      if (rpcError) {
        if (isAuthzError(rpcError)) {
          setError('You need to be a union owner or admin to see statements.');
        } else {
          reportError(rpcError, 'UnionStatementsPage.board_rpc');
          setError('Could not load statements.');
        }
        setBoard(null);
      } else if (!data || !Array.isArray((data as Board).clubs)) {
        // A null payload was being stored as success. loading was already
        // false, the skeleton wants !board && !error, the empty state wants a
        // board - so the page rendered a header over nothing, permanently.
        reportError(new Error('statement board payload was empty'),
          'UnionStatementsPage.board_shape');
        setError('Could not load statements.');
        setBoard(null);
      } else {
        setError(null);
        setBoard(data as Board);
        setExpanded(null);
      }
    } finally {
      if (!stale()) setLoading(false);
    }
  }, [unionId, period]);

  useEffect(() => { void load(); }, [load]);

  const issue = useCallback(async () => {
    if (!unionId || issuing) return;
    setIssuing(true);
    setConfirmIssue(false);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token;
      if (!token) {
        toast.error('Your session expired, please sign in again');
        return;
      }
      const res = await fetch('/api/club-arena/union-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'issue', unionId }),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        toast.error(json?.error || 'Could not issue statements');
        return;
      }
      // A period that was already issued comes back with nothing new. That is
      // the idempotency working, not a failure, so the two are said apart.
      const n = Number(json?.issued ?? json?.invoices ?? 0);
      toast.success(
        n > 0
          ? `Issued and delivered ${n} statements`
          : 'Every club for this period already has a statement'
      );
      // setPeriod(null) already re-runs the effect below with a NEW load
      // closure. Calling load() here as well fired a second read bound to the
      // period the user had been browsing, and whichever landed last won.
      setPeriod(null);
    } catch (e) {
      reportError(e, 'UnionStatementsPage.issue');
      toast.error('Could not issue statements');
    } finally {
      setIssuing(false);
    }
  }, [unionId, issuing, toast, load]);

  // Recording that a statement was settled. This moves NO chips: the weekly
  // square-up is the bookkeeping record of what was owed for a period, paid
  // between people out of band, and the RPC deliberately leaves the chip
  // transfer columns alone so the two can never be confused.
  const setPaid = useCallback(async (invoiceId: string, paid: boolean) => {
    if (!invoiceId || settlingId) return;
    setSettlingId(invoiceId);
    try {
      const { data, error: rpcError } = await supabase.rpc('ca_union_set_statement_paid', {
        p_invoice_id: invoiceId,
        p_paid: paid,
        p_amount: null,
        p_note: null,
      });
      if (rpcError) {
        toast.error(
          isAuthzError(rpcError)
            ? 'Only a union owner or admin can settle a statement'
            : 'Could not update the statement'
        );
        if (!isAuthzError(rpcError)) reportError(rpcError, 'UnionStatementsPage.set_paid');
        return;
      }
      const res = data as { already_settled?: boolean } | null;
      toast.success(
        !paid ? 'Statement reopened'
          : res?.already_settled ? 'This statement was already settled'
            : 'Statement marked paid'
      );
      await load();
    } catch (e) {
      reportError(e, 'UnionStatementsPage.set_paid');
      toast.error('Could not update the statement');
    } finally {
      setSettlingId(null);
    }
  }, [settlingId, toast, load]);

  const exportCsv = useCallback(() => {
    if (!board?.clubs?.length) return;
    downloadCsv(`union_statements_${board.period_end || 'latest'}.csv`, boardToCsv(board.clubs));
  }, [board]);

  const totals = board?.totals;

  const periodLabel = useMemo(() => {
    if (!board) return '';
    if (board.period_start && board.period_end) {
      return `${board.period_start} to ${board.period_end}`;
    }
    return board.period_end || 'No statements issued yet';
  }, [board]);

  if (isHydrating) {
    return <div className={styles.page}><div className={styles.state}>Loading...</div></div>;
  }
  if (!user) {
    return <div className={styles.page}><div className={styles.state}>Sign in to view statements.</div></div>;
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.headerBtn} onClick={() => navigate(-1)} aria-label="Go back">
          &laquo;
        </button>
        <h1 className={styles.title}>Union Statements</h1>
        <button
          type="button"
          className={styles.headerBtn}
          onClick={exportCsv}
          disabled={!board?.clubs?.length}
          title="Export as CSV"
          aria-label="Export as CSV"
        >
          CSV
        </button>
      </header>

      <div className={styles.periodBar}>
        <div className={styles.periodLabel}>{periodLabel}</div>
        {board?.union_name && <div className={styles.unionName}>{board.union_name}</div>}
      </div>

      {board && (board.history?.length ?? 0) > 1 && (
        <div className={styles.periodChips} role="tablist" aria-label="Statement period">
          {(board.history || []).map((h) => (
            <button
              key={h.period_end}
              type="button"
              role="tab"
              aria-selected={board.period_end === h.period_end}
              className={`${styles.chip} ${board.period_end === h.period_end ? styles.active : ''}`}
              onClick={() => setPeriod(h.period_end)}
            >
              {h.period_end}
            </button>
          ))}
        </div>
      )}

      {totals && (
        <div className={styles.summary}>
          <div className={styles.tile}>
            <div className={styles.tileValue}>{money(totals.clubs_owe)}</div>
            <div className={styles.tileLabel}>Clubs owe</div>
          </div>
          <div className={styles.tile}>
            <div className={styles.tileValue}>{money(totals.union_owes)}</div>
            <div className={styles.tileLabel}>Union owes</div>
          </div>
          <div className={styles.tile}>
            <div className={styles.tileValue}>{money(totals.outstanding)}</div>
            <div className={styles.tileLabel}>Still outstanding</div>
          </div>
          <div className={styles.tile}>
            <div className={`${styles.tileValue} ${totals.eco_amount < 0 ? styles.neg : styles.pos}`}>
              {money(totals.eco_amount)}
            </div>
            <div className={styles.tileLabel}>ECO</div>
          </div>
        </div>
      )}

      {totals && (
        <div className={styles.statusStrip}>
          <span>{compactInt(totals.issued)} of {compactInt(totals.clubs)} issued</span>
          <span>{compactInt(totals.delivered)} delivered</span>
          <span>{compactInt(totals.paid)} paid</span>
          <span>{money(totals.collected)} collected</span>
          <span>{money(totals.rake_generated)} rake</span>
          {totals.missing > 0 && (
            <span className={styles.warn}>{compactInt(totals.missing)} with no statement</span>
          )}
        </div>
      )}

      <div className={styles.actions}>
        {confirmIssue ? (
          <>
            <button
              type="button"
              className={styles.dangerBtn}
              onClick={() => { void issue(); }}
              disabled={issuing}
            >
              {issuing ? 'Issuing...' : 'Yes, issue and deliver'}
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => setConfirmIssue(false)}
              disabled={issuing}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => setConfirmIssue(true)}
            disabled={issuing}
          >
            Issue statements for the closed week
          </button>
        )}
      </div>
      <div className={styles.actionNote}>
        The Monday job already does this. Issuing again only fills in clubs that
        have no statement for the period; nothing is billed or delivered twice.
      </div>

      <div className={styles.list}>
        {loading && !board && !error && (
          <>
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
          </>
        )}

        {error && <div className={`${styles.state} ${styles.error}`}>{error}</div>}

        {!loading && !error && board && (board.clubs?.length ?? 0) === 0 && (
          <div className={styles.state}>No clubs in this union.</div>
        )}

        {!error && (board?.clubs || []).map((c) => {
          const open = expanded === c.club_id;
          const pillClass =
            c.status === 'missing' ? styles.pillMissing
              : c.status === 'paid' ? styles.pillPaid
                : c.overdue ? styles.pillOverdue
                  : styles.pillOpen;
          return (
            <div className={styles.clubRow} key={c.club_id}>
              <button
                type="button"
                className={styles.clubMain}
                onClick={() => setExpanded(open ? null : c.club_id)}
                aria-expanded={open}
              >
                <div className={styles.clubText}>
                  <div className={styles.clubName}>{c.club_name}</div>
                  <div className={styles.clubMeta}>
                    <span className={`${styles.pill} ${pillClass}`}>
                      {c.status === 'missing' ? 'no statement' : c.overdue ? 'overdue' : c.status}
                    </span>
                    {c.status !== 'missing' && (
                      <span className={c.message_sent ? styles.deliveredYes : styles.deliveredNo}>
                        {c.message_sent ? 'delivered' : 'not delivered'}
                      </span>
                    )}
                    {c.due_at && <span>due {String(c.due_at).slice(0, 10)}</span>}
                  </div>
                </div>
                <div className={styles.clubAmount}>
                  <div className={`${styles.amountValue} ${c.amount < 0 ? styles.neg : styles.pos}`}>
                    {c.status === 'missing' ? '--' : money(c.amount)}
                  </div>
                  <div className={styles.amountLabel}>
                    {c.status === 'missing'
                      ? 'not billed'
                      : c.direction === 'union owes club'
                        ? 'union owes'
                        : 'club owes'}
                  </div>
                </div>
              </button>

              {open && (
                <div className={styles.breakdown}>
                  {c.status === 'missing' ? (
                    <div className={styles.state}>
                      This club has no statement for the period. Issuing will create one.
                    </div>
                  ) : (
                    [
                      ['Rake generated', c.rake_generated],
                      ['Club rakeback (90%)', c.rakeback_due],
                      ['Union fee kept (10%)', c.union_fee_kept],
                      ['Player win/loss', c.players_won],
                      ['ECO adjustment', c.eco_amount],
                      ['Payments received', c.presettled],
                    ].map(([label, value]) => (
                      <div className={styles.breakdownLine} key={String(label)}>
                        <span>{String(label)}</span>
                        <span>{money(Number(value || 0))}</span>
                      </div>
                    ))
                  )}
                  {c.paid_total > 0 && c.status !== 'paid' && (
                    <div className={styles.breakdownLine}>
                      <span>Part paid</span>
                      <span>{money(c.paid_total)} of {money(Math.abs(c.amount))}</span>
                    </div>
                  )}

                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.linkBtn}
                      onClick={() => navigate(`/clubs/${c.club_id}/data`)}
                    >
                      Open club data
                    </button>
                    {c.invoice_id && c.status !== 'cancelled' && (
                      <button
                        type="button"
                        className={c.status === 'paid' ? styles.linkBtnMuted : styles.linkBtn}
                        onClick={() => { void setPaid(c.invoice_id as string, c.status !== 'paid'); }}
                        disabled={settlingId === c.invoice_id}
                      >
                        {settlingId === c.invoice_id
                          ? 'Saving...'
                          : c.status === 'paid' ? 'Reopen' : 'Mark paid'}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {board && (
        <div className={styles.footNote}>
          Marking a statement paid records that it was settled. It moves no
          chips.
          {board.generated_at && !Number.isNaN(Date.parse(board.generated_at))
            ? ` Read ${new Date(board.generated_at).toLocaleTimeString()}.`
            : ''}
          {totals && totals.missing > 0
            ? ' A club shown as "no statement" was never billed for this period.'
            : ''}
        </div>
      )}
    </div>
  );
}

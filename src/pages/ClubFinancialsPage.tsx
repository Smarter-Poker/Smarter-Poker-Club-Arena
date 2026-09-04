/**
 * CLUB FINANCIALS — what the club earned, and what it paid out
 * ============================================================================
 * PHASE 6 OF THE CLUB OPERATIONS UPGRADE (2026-09-04).
 *
 * Every figure on this page used to be summed in the browser from the OLDEST
 * 5,000 rake_records rows: `.order('created_at', {ascending:true}).limit(5000)`.
 * Measured on Deep Stack Society over its three complete days, that was 5,000
 * of 124,549 cash rake rows - Rake Collected 4.6% of the truth, Total Pot
 * Volume 4.8%, Hands Played a flat 5,000, and Net Revenue inheriting all of
 * it, with no truncation warning anywhere. The rakeback line read
 * chip_transactions directly, whose RLS returns the CALLER's own rows, so an
 * owner saw the rakeback paid to themselves and nobody else. The union-fee
 * line read invoice_type 'union_to_club', which the weekly square-up has never
 * written. The whole page was gated in this component alone.
 *
 * It now makes one call: ca_club_financials, SECURITY DEFINER, gated
 * server-side on ca_can_view_club_finances (owner / co-owner / admin /
 * super agent / platform admin) with ERRCODE 42501, reading the per-day rake
 * rollup the engine maintains from rake_records. The client gate below is
 * cosmetic; the server one is the gate.
 *
 * The figures, from the club's side of the ledger:
 *   Gross Rake        rake_records, attributed the way club_table_daily
 *                     attributes it (a union player's rake goes to their home
 *                     club; anything unattributable stays with the table's)
 *   Bad Beat Drop     the share of that rake that leaves for the jackpot pool
 *   Net Rake          gross - drop, the part the club keeps
 *   Tournament Fees   entry and rebuy fees, per the entrant's club
 *   Rakeback          chip_transactions of type 'rakeback', every player's
 *   Agent Fees        agent_commissions, accrued in the window
 *   Union Fee         union_fee_kept on the weekly square-up statements
 *   Net Revenue       net rake + tournament fees - the three outflows
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { isClubStaff, type ClubRole } from '../types/clubRoles';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { ClubFinancialDashboard } from '../components/dashboard/ClubFinancialDashboard';
import FinancialChart from '../components/charts/FinancialChart';
import RakeReports from '../components/admin/RakeReports';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState, PermissionState } from '../components/common/EmptyState';
import TransactionLedgerView from '../components/common/TransactionLedgerView';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import DynamicWallet from '../components/wallet/DynamicWallet';
import WalletCashierModal from '../components/wallet/WalletCashierModal';
import { DEFAULT_CASHIER_WALLET } from '../components/wallet/cashierModes';
import PlayerWalletModal from '../components/wallet/PlayerWalletModal';
import './ClubFinancialsPage.css';
import { isUUID } from '../utils/clubIdResolver';
import { isAuthzError } from '../utils/clubDashboard';
import { useIsMounted } from '../hooks/useIsMounted';
import { formatDateShort as formatDate } from '../utils/format';
import { downloadCsv, toCsv } from '../utils/downloadCsv';
import { reportError } from '../utils/errorReporter';
import { formatPopupText } from '../utils/popupStyle';

interface FinancialTotals {
  raked_hands: number;
  gross_rake: number;
  bbj_drop: number;
  net_rake: number;
  pot_volume: number;
  tournament_fees: number;
  rakeback_paid: number;
  rakeback_rows: number;
  agent_commissions: number;
  union_fee: number;
  union_statements: number;
  union_squareup: number;
  net_revenue: number;
}

interface FinancialDay {
  d: string;
  raked_hands: number;
  gross_rake: number;
  bbj_drop: number;
  pot_volume: number;
  tournament_fees: number;
  rakeback_paid: number;
  agent_commissions: number;
  union_fee: number;
}

interface FinancialTable {
  table_id: string;
  name: string;
  status: string;
  stakes: string | null;
  variant: string | null;
  raked_hands: number;
  rake: number;
  players: number;
  table_net: number;
}

interface RecentRake {
  id: string;
  hand_id: string | null;
  global_hand_id: number | null;
  table_name: string;
  kind: string;
  rake_amount: number;
  bbj_contribution: number;
  pot_size: number;
  num_players: number | null;
  created_at: string;
}

interface FinancialsPayload {
  range: {
    start: string;
    end: string;
    days: number;
    first_day: string;
    series_from: string;
  };
  union_id: string | null;
  totals: FinancialTotals;
  daily: FinancialDay[];
  by_table: FinancialTable[];
  recent: RecentRake[];
  data_updated_at: string | null;
  club_table_daily_updated_at: string | null;
  generated_at: string;
}

type Period = 'week' | 'month' | 'all';

/** The window the operator asked for, as UTC dates the server understands. */
function windowFor(period: Period): { start: string | null; end: string | null } {
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  if (period === 'all') return { start: '2020-01-01', end };
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - (period === 'week' ? 6 : 29));
  return { start: from.toISOString().slice(0, 10), end };
}

const chips = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (n: number | null | undefined) => Number(n ?? 0).toLocaleString();

/** "Sep 3", from a UTC date string, without letting the local zone shift it. */
function dayLabel(iso: string): string {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function ClubFinancialsPage() {
  const navigate = useNavigate();
  const { clubId } = useParams();
  const { user } = useAuthUser();

  const [data, setData] = useState<FinancialsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [period, setPeriod] = useState<Period>('week');
  const [userRole, setUserRole] = useState<ClubRole | null>(null);
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(
    isUUID(clubId || '') ? (clubId as string) : null
  );
  // Dan 2026-08-23: tapping Club Bank opens the Club Bank Cashier.
  const [activeCashier, setActiveCashier] = useState<
    'club_bank' | 'promo_wallet' | 'agent_wallet' | null
  >(null);
  // Dan 2026-08-24: "PLAYER WALLET NEEDS TO BE FULLY CLICKABLE AND OPEN TO SEE
  // ALL TRANSACTIONS AND OTHER AVAILABLE DATA WHEN CLICKED." The row opens the
  // member's own statement - a read-only view, so it is not an activeCashier.
  const [showPlayerWallet, setShowPlayerWallet] = useState(false);
  const [visibleTransactions, setVisibleTransactions] = useState<Set<string>>(new Set());
  const toast = useToast();

  const isMounted = useIsMounted();
  const loadingRef = useRef(false);
  const loadRef = useRef<() => void>(() => {});

  // ── Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setUserRole(null);
    setData(null);
    setDenied(false);
    setNotFound(false);
    setLoadError(null);
    setVisibleTransactions(new Set());
    loadingRef.current = false;
    setResolvedClubId(isUUID(clubId || '') ? (clubId as string) : null);
  }, [clubId]);

  // Hydrate userRole so DynamicWallet and the cashier show the right variant.
  // The owner_id outranks the membership row: a club owner with no
  // club_members row is still the owner, and fn_club_bank_role treats them
  // as one.
  useEffect(() => {
    if (!clubId || !user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { resolveClubUUIDStrict } = await import('../utils/strictClubIdResolver');
        const resolved = await resolveClubUUIDStrict(clubId);
        if (cancelled || !isMounted.current) return;
        setResolvedClubId(resolved);
        const [membership, club] = await Promise.all([
          supabase
            .from('club_members')
            .select('role')
            .eq('club_id', resolved)
            .eq('user_id', user.id)
            .maybeSingle(),
          supabase.from('clubs').select('owner_id').eq('id', resolved).maybeSingle(),
        ]);
        if (cancelled || !isMounted.current) return;
        if (club.data?.owner_id === user.id) {
          setUserRole('owner');
        } else if (membership.data?.role) {
          setUserRole(membership.data.role as ClubRole);
        } else {
          setUserRole('player');
        }
      } catch (e) {
        if (cancelled || !isMounted.current) return;
        const name = (e as { name?: string } | null)?.name;
        if (name === 'ClubNotFoundError') {
          setNotFound(true);
          setLoading(false);
          return;
        }
        reportError(e, 'ClubFinancialsPage.role');
        // The role only styles the wallet rows; the page's own gate is the
        // server's. Leave it null rather than claiming a role we did not read.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clubId, user?.id, isMounted]);

  const load = useCallback(async () => {
    if (!clubId) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const { resolveClubUUIDStrict } = await import('../utils/strictClubIdResolver');
      const resolved = await resolveClubUUIDStrict(clubId);
      if (!isMounted.current) return;
      setResolvedClubId(resolved);
      const { start, end } = windowFor(period);
      const { data: payload, error } = await supabase.rpc('ca_club_financials', {
        p_club_id: resolved,
        p_start: start,
        p_end: end,
      });
      if (!isMounted.current) return;
      if (error) {
        if (isAuthzError(error)) {
          setDenied(true);
          setData(null);
          return;
        }
        throw error;
      }
      setDenied(false);
      setData(payload as FinancialsPayload);
    } catch (error) {
      if (!isMounted.current) return;
      if ((error as { name?: string } | null)?.name === 'ClubNotFoundError') {
        setNotFound(true);
        return;
      }
      reportError(error, 'ClubFinancialsPage.load');
      setLoadError('The Club Financials Could Not Be Loaded. No Figures Have Been Estimated.');
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  }, [clubId, period, isMounted]);

  useEffect(() => {
    void load();
  }, [load]);

  useVisibilityRefresh(() => void load());

  // Stagger animation for the recent rows.
  const recent = useMemo(() => data?.recent || [], [data]);
  useEffect(() => {
    if (recent.length === 0) return;
    setVisibleTransactions(new Set());
    const timers = recent.map((tx, index) =>
      setTimeout(() => setVisibleTransactions((prev) => new Set(prev).add(tx.id)), index * 60)
    );
    return () => timers.forEach(clearTimeout);
  }, [recent]);

  // ── Bus listeners: cross-page financial event reactivity ──
  useEffect(() => {
    loadRef.current = () => void load();
  });

  useEffect(() => {
    const refresh = () => loadRef.current();
    const unsubs = [
      masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 500),
      masterBus.subscribeDebounced('WALLET_REFRESHED', refresh, 500),
      masterBus.subscribeDebounced('COMMISSION_PAID', refresh, 500),
      masterBus.subscribeDebounced('SETTLEMENT_COMPLETED', refresh, 500),
      masterBus.subscribeDebounced('CHIPS_ADDED', refresh, 500),
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', refresh, 1000),
      masterBus.subscribeDebounced('CLUB_UPDATED', refresh, 1000),
      masterBus.subscribeDebounced('TRANSACTION_LOGGED', refresh, 2000),
    ];
    return () => unsubs.forEach((off) => off());
  }, [clubId]);

  const chartData = useMemo(
    () =>
      (data?.daily || []).map((d) => ({
        name: dayLabel(d.d),
        rake: Number(d.gross_rake) || 0,
        rakeback: Number(d.rakeback_paid) || 0,
        commissions: Number(d.agent_commissions) || 0,
      })),
    [data]
  );

  const exportCsv = useCallback(() => {
    if (!data) return;
    const rows = data.daily.map((d) => [
      d.d,
      d.raked_hands,
      d.gross_rake,
      d.bbj_drop,
      Number(d.gross_rake) - Number(d.bbj_drop),
      d.pot_volume,
      d.tournament_fees,
      d.rakeback_paid,
      d.agent_commissions,
      d.union_fee,
      Number(d.gross_rake) -
        Number(d.bbj_drop) +
        Number(d.tournament_fees) -
        Number(d.rakeback_paid) -
        Number(d.agent_commissions) -
        Number(d.union_fee),
    ]);
    const ok = downloadCsv(
      `club-financials-${data.range.start}-to-${data.range.end}.csv`,
      toCsv(
        [
          'Day',
          'Raked Hands',
          'Gross Rake',
          'Bad Beat Drop',
          'Net Rake',
          'Pot Volume',
          'Tournament Fees',
          'Rakeback Paid',
          'Agent Fees',
          'Union Fee',
          'Net Revenue',
        ],
        rows
      )
    );
    if (!ok) toast.error('This Browser Could Not Start The Download');
  }, [data, toast]);

  if (notFound) {
    return (
      <div className="financials-page">
        <ErrorState
          message="That Club Could Not Be Found."
          onRetry={() => navigate('/clubs', { replace: true })}
        />
      </div>
    );
  }

  if (denied) {
    return (
      <div className="financials-page">
        <PermissionState
          title="Financials Are Restricted"
          description="Club Financials Are Available To Club Owners, Admins And Super Agents."
          onBack={() => navigate(`/clubs/${clubId}`)}
        />
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="financials-page">
        <PageSkeleton variant="financial" />
      </div>
    );
  }

  if (loadError && !data) {
    return (
      <div className="financials-page">
        <ErrorState message={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  const totals = data?.totals;
  const rangeNote = data
    ? `${dayLabel(data.range.start)} To ${dayLabel(data.range.end)}${
        period === 'all' && data.range.start > '2020-01-01'
          ? ' - Every Day This Club Has Traded'
          : ''
      }`
    : '';

  return (
    <div className="financials-page">
      {/* Real-Time Wallet Overview */}
      {clubId && user?.id && (
        <DynamicWallet
          userId={user.id}
          clubId={clubId}
          variant="club"
          // Dan 2026-08-23: role decides the rows. Club Bank, and the cashier
          // behind it, are owner / co-owner / admin / super agent only.
          role={userRole || 'player'}
          onBuyDiamonds={() => navigate('/vip')}
          onOpenPlayerWallet={() => setShowPlayerWallet(true)}
          onOpenPromoWallet={() => setActiveCashier('promo_wallet')}
          onOpenAgentWallet={() => setActiveCashier('agent_wallet')}
          onOpenClubBank={() => setActiveCashier('club_bank')}
          onOpenBBJ={() => navigate(`/clubs/${clubId}/jackpot`)}
        />
      )}
      {clubId && (
        <>
          <WalletCashierModal
            isOpen={!!activeCashier}
            onClose={() => setActiveCashier(null)}
            clubId={clubId}
            role={userRole || 'player'}
            walletType={activeCashier || DEFAULT_CASHIER_WALLET}
          />
          <PlayerWalletModal
            isOpen={showPlayerWallet}
            onClose={() => setShowPlayerWallet(false)}
            clubId={clubId}
          />
        </>
      )}

      {/* Period Selector */}
      <div className="period-selector">
        {(['week', 'month', 'all'] as const).map((p) => (
          <button
            key={p}
            className={period === p ? 'active' : ''}
            aria-pressed={period === p}
            onClick={() => setPeriod(p)}
          >
            {p === 'week' ? 'This Week' : p === 'month' ? 'This Month' : 'All Time'}
          </button>
        ))}
        <button className="export-btn" onClick={exportCsv} disabled={!data}>
          Export CSV
        </button>
      </div>

      {rangeNote && (
        <p className="range-note" aria-live="polite">
          {rangeNote}
          {loading ? ' - Refreshing' : ''}
        </p>
      )}

      {loadError && data && (
        <p className="range-note" role="alert">
          {loadError}
        </p>
      )}

      {/* Revenue Chart */}
      <section className="chart-section">
        <h3>Revenue Trend</h3>
        <FinancialChart data={chartData} height={180} showRakeback={true} showCommissions={true} />
      </section>

      {/* Summary Cards */}
      {totals && (
        <div className="summary-cards">
          <div className="summary-row">
            <div className="summary-card">
              <span className="card-value">{count(totals.raked_hands)}</span>
              <span className="card-label">Raked Hands</span>
            </div>
            <div className="summary-card">
              <span className="card-value">{chips(totals.pot_volume)}</span>
              <span className="card-label">Pot Volume</span>
            </div>
          </div>
          <div className="summary-card revenue">
            <span className="card-value">{chips(totals.net_rake)}</span>
            <span className="card-label">Net Rake</span>
            {/* Gross and drop, because the club keeps one and not the other. */}
            <span className="card-sub">
              {chips(totals.gross_rake)} Raked, {chips(totals.bbj_drop)} To The Jackpot
            </span>
          </div>
          <div className="summary-row">
            <div className="summary-card">
              <span className="card-value">{chips(totals.tournament_fees)}</span>
              <span className="card-label">Tournament Fees</span>
            </div>
            <div className="summary-card">
              <span className="card-value expense">-{chips(totals.rakeback_paid)}</span>
              <span className="card-label">Rakeback</span>
            </div>
          </div>
          <div className="summary-row">
            <div className="summary-card">
              <span className="card-value expense">-{chips(totals.agent_commissions)}</span>
              <span className="card-label">Agent Fees</span>
            </div>
            {/* The union line is only a line for a club that is in a union.
                It read invoice_type 'union_to_club' - a type the weekly
                square-up never writes - so it contributed a silent zero to
                Net Revenue for every club on the platform. */}
            <div className="summary-card">
              <span className="card-value expense">
                {data?.union_id ? `-${chips(totals.union_fee)}` : '-'}
              </span>
              <span className="card-label">
                {data?.union_id ? 'Union Fee' : 'Union Fee (No Union)'}
              </span>
            </div>
          </div>
          <div className="summary-card net">
            <span className={`card-value ${totals.net_revenue >= 0 ? 'positive' : 'negative'}`}>
              {totals.net_revenue >= 0 ? '+' : ''}
              {chips(totals.net_revenue)}
            </span>
            <span className="card-label">Net Revenue</span>
            <span className="card-sub">
              Net Rake Plus Tournament Fees, Less Rakeback, Agent Fees And Union Fees
            </span>
          </div>
          {data?.union_id && totals.union_statements > 0 && (
            <p className="range-note">
              {count(totals.union_statements)} Weekly Square-Up
              {totals.union_statements === 1 ? '' : 's'} Issued In This Window,{' '}
              {totals.union_squareup >= 0
                ? `${chips(totals.union_squareup)} Owed To The Union`
                : `${chips(Math.abs(totals.union_squareup))} Owed To This Club`}
              .
            </p>
          )}
        </div>
      )}

      {/* Where the rake came from */}
      {data && data.by_table.length > 0 && (
        <section className="transactions-section">
          <h3>Top Tables By Rake</h3>
          <div className="table-list">
            {data.by_table.map((t) => (
              <div key={t.table_id} className="table-row">
                <div className="tx-info">
                  <span className="tx-desc">{t.name}</span>
                  <span className="tx-date">
                    {[t.variant, t.stakes].filter(Boolean).join(' ')} - {count(t.raked_hands)} Raked
                    Hands
                  </span>
                </div>
                <span className="tx-amount positive">{chips(t.rake)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Club Financial Dashboard - Chip Minting & Commission (club staff).
          This was owner-only, which left a co-owner - "everything an owner can
          do except appoint another co owner" - without the one screen that
          mints chips. fn_actor_can_manage_club_treasury admits all three. */}
      {clubId && isClubStaff(userRole) && (
        <section className="financial-dashboard-section">
          <ClubFinancialDashboard clubId={clubId} />
        </section>
      )}

      {/* Rake Analytics Reports */}
      {clubId && (
        <section className="rake-reports-section">
          <RakeReports clubId={clubId} />
        </section>
      )}

      {/* Recent raked hands */}
      <section className="transactions-section">
        <h3>Recent Rake</h3>
        {recent.length === 0 ? (
          <div className="empty-state">
            <p>No Rake In This Period</p>
          </div>
        ) : (
          <div className="transactions-list">
            {recent.map((tx) => (
              <div
                key={tx.id}
                className={`transaction-row ${visibleTransactions.has(tx.id) ? 'fadeInUp' : 'hidden'}`}
                style={
                  visibleTransactions.has(tx.id)
                    ? undefined
                    : { opacity: 0, transform: 'translateY(8px)' }
                }
              >
                <span className="tx-icon">{tx.kind === 'cash_rake' ? '%' : 'T'}</span>
                <div className="tx-info">
                  <span className="tx-desc">
                    {formatPopupText(
                      tx.kind === 'cash_rake'
                        ? `${chips(tx.rake_amount)} Raked From A ${chips(tx.pot_size)} Pot At ${tx.table_name}`
                        : `${chips(tx.rake_amount)} Tournament Fee`
                    )}
                  </span>
                  <span className="tx-date">
                    {formatDate(tx.created_at)}
                    {tx.bbj_contribution > 0
                      ? ` - ${chips(tx.bbj_contribution)} To The Jackpot`
                      : ''}
                  </span>
                </div>
                <span className="tx-amount positive">+{chips(tx.rake_amount)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Chip Ledger — Club Transaction Audit Trail.
          Through the club-scoped RPC: chip_ledger's own RLS returns the
          CALLER's rows, so this panel showed a club owner their personal
          movements under the heading "Club Chip Audit Trail". */}
      {resolvedClubId && (
        <section className="ledger-section">
          <div className="ledger-card">
            <h3>Club Chip Audit Trail</h3>
            <TransactionLedgerView clubId={resolvedClubId} clubScoped limit={25} />
          </div>
        </section>
      )}

      {data?.data_updated_at && (
        <p className="range-note">
          Rake Updated {formatDate(data.data_updated_at)} - Figures Are From The Club Ledger
        </p>
      )}
    </div>
  );
}

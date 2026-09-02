/**
 *  CLUB FINANCIALS PAGE — Club Financial Overview
 */

import { useState, useEffect, useRef } from 'react';
import { isClubStaff, type ClubRole } from '../types/clubRoles';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { ClubFinancialDashboard } from '../components/dashboard/ClubFinancialDashboard';
import FinancialChart from '../components/charts/FinancialChart';
import RakeReports from '../components/admin/RakeReports';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import TransactionLedgerView from '../components/common/TransactionLedgerView';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { FinancialExportService } from '../services/FinancialExportService';
import DynamicWallet from '../components/wallet/DynamicWallet';
import WalletCashierModal from '../components/wallet/WalletCashierModal';
import { DEFAULT_CASHIER_WALLET } from '../components/wallet/cashierModes';
import PlayerWalletModal from '../components/wallet/PlayerWalletModal';
import './ClubFinancialsPage.css';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';
import { formatDateShort as formatDate } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import { formatPopupText } from '../utils/popupStyle';

interface FinancialSummary {
  period: string;
  rake_collected: number;
  rakeback_paid: number;
  agent_commissions: number;
  union_fees: number;
  net_revenue: number;
  total_hands: number;
  total_pots: number;
}

interface RecentTransaction {
  id: string;
  type: 'rake' | 'payout' | 'settlement' | 'deposit' | 'withdrawal';
  amount: number;
  description: string;
  created_at: string;
}

export default function ClubFinancialsPage() {
  const navigate = useNavigate();
  const { clubId } = useParams();
  const { user } = useAuthUser();

  const [summary, setSummary] = useState<FinancialSummary | null>(null);
  const [transactions, setTransactions] = useState<RecentTransaction[]>([]);
  const [chartData, setChartData] = useState<{ name: string; rake: number; rakeback: number }[]>(
    []
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [period, setPeriod] = useState<'week' | 'month' | 'all'>('week');
  const [userRole, setUserRole] = useState<ClubRole>('player');
  // Dan 2026-08-23: tapping Club Bank opens the Club Bank Cashier.
  const [activeCashier, setActiveCashier] = useState<
    'club_bank' | 'promo_wallet' | 'agent_wallet' | null
  >(null);
  // Dan 2026-08-24: "PLAYER WALLET NEEDS TO BE FULLY CLICKABLE AND OPEN TO SEE
  // ALL TRANSACTIONS AND OTHER AVAILABLE DATA WHEN CLICKED." The row opens the
  // member's own statement - a read-only view, so it is not an activeCashier.
  const [showPlayerWallet, setShowPlayerWallet] = useState(false);
  const toast = useToast();
  useVisibilityRefresh(() => loadFinancials());
  const [visibleTransactions, setVisibleTransactions] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const isMounted = useIsMounted();
  const loadingRef = useRef(false);
  const loadFinancialsRef = useRef<() => void>(() => {});
  const resolvedClubIdRef = useRef<string | null>(null);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setUserRole('player');
    setExporting(false);
    setVisibleTransactions(new Set());
    loadingRef.current = false;
    resolvedClubIdRef.current = null; // Reset cache for new club
  }, [clubId]);

  useEffect(() => {
    if (clubId) loadFinancials();
  }, [clubId, period]);

  // Hydrate userRole from club_members so DynamicWallet/BottomNav show correct variant
  useEffect(() => {
    if (!clubId || !user?.id) return;
    (async () => {
      try {
        const resolvedId = await resolveClubUUID(clubId);
        const { data } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', resolvedId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (data?.role && isMounted.current) {
          setUserRole(data.role as ClubRole);
        }
      } catch (e) {
        reportError(e, 'ClubFinancialsPage.async');
        // Non-blocking — default to 'member'
      }
    })();
  }, [clubId, user?.id]);

  // Stagger animation for transactions
  useEffect(() => {
    if (transactions.length === 0) return;
    setVisibleTransactions(new Set());

    const timers = transactions.map((tx, index) => {
      return setTimeout(() => {
        setVisibleTransactions((prev) => new Set(prev).add(tx.id));
      }, index * 60);
    });

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [transactions]);

  // ── Realtime subscription removed (Phase 2 cost cut) ──
  // wallet_transactions and rake_history are being dropped from
  // supabase_realtime to save egress. This is a financials dashboard — the
  // bus listeners below (BALANCE_UPDATED, WALLET_REFRESHED, COMMISSION_PAID,
  // SETTLEMENT_COMPLETED, CHIPS_ADDED/WITHDRAWN/DISTRIBUTED) and the
  // period-scoped loadFinancials already cover every refresh path. Accepted
  // trade-off: per-transaction ticker refresh is no longer real-time on this
  // specific page, but totals still update on each domain-level bus event.

  // ── Bus Listeners: cross-page financial event reactivity ──
  // Keep ref in sync with latest loadFinancials (captures current clubId + period)
  useEffect(() => {
    loadFinancialsRef.current = loadFinancials;
  });

  useEffect(() => {
    const refresh = () => loadFinancialsRef.current();
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 500);
    const unsubWallet = masterBus.subscribeDebounced('WALLET_REFRESHED', refresh, 500);
    const unsubCommission = masterBus.subscribeDebounced('COMMISSION_PAID', refresh, 500);
    const unsubSettlement = masterBus.subscribeDebounced('SETTLEMENT_COMPLETED', refresh, 500);
    const unsubChipsAdded = masterBus.subscribeDebounced('CHIPS_ADDED', refresh, 500);
    const unsubChipsWithdrawn = masterBus.subscribeDebounced('CHIPS_WITHDRAWN', refresh, 500);
    const unsubChipsDistributed = masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', refresh, 1000);
    const unsubClubUpdated = masterBus.subscribeDebounced('CLUB_UPDATED', refresh, 1000);
    const unsubTxLogged = masterBus.subscribeDebounced('TRANSACTION_LOGGED', refresh, 2000);
    return () => {
      unsubBalance();
      unsubWallet();
      unsubCommission();
      unsubSettlement();
      unsubChipsAdded();
      unsubChipsWithdrawn();
      unsubChipsDistributed();
      unsubTxLogged();
      unsubClubUpdated();
    };
  }, [clubId]);

  const loadFinancials = async () => {
    if (!clubId) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      // Use cached resolved ID when available to avoid redundant async lookups
      const resolvedId = resolvedClubIdRef.current || (await resolveClubUUID(clubId));
      if (!resolvedClubIdRef.current) resolvedClubIdRef.current = resolvedId;
      const swrKey = `fin_cache_${resolvedId}_${period}`;

      // SWR: show cached data instantly
      try {
        const cached = sessionStorage.getItem(swrKey);
        if (cached) {
          const c = JSON.parse(cached);
          if (c.summary) setSummary(c.summary);
          if (c.chartData) setChartData(c.chartData);
          if (c.transactions) setTransactions(c.transactions);
          setLoading(false);
        }
      } catch (e) {
        reportError(e, 'ClubFinancialsPage.loadFinancials');
        /* corrupt cache */
      }

      // Calculate date range based on period
      const now = new Date();
      let startDate: Date;

      if (period === 'week') {
        startDate = new Date(now);
        startDate.setDate(now.getDate() - 7);
      } else if (period === 'month') {
        startDate = new Date(now);
        startDate.setMonth(now.getMonth() - 1);
      } else {
        startDate = new Date(0); // All time - epoch
      }

      // ── 2026-08-19: this page was reading DEAD DATA and inventing the rest ──
      // It selected from `rake_history`, whose last write was 2026-05-01 — so
      // for three and a half months a club owner's financials page showed
      // zeros. It then fabricated the remaining lines: rakeback as rake * 0.1
      // and agent commissions as rake * 0.05, labelled as if they were real.
      // Now every figure comes from the live ledger it actually belongs to,
      // and a line with no activity reads 0 because it IS 0.
      const [rakeRes, rakebackRes, commissionRes, unionFeeRes] = await Promise.all([
        retryFetch(
          () =>
            supabase
              .from('rake_records')
              .select('rake_amount, pot_size, created_at')
              .eq('club_id', resolvedId)
              .gte('created_at', startDate.toISOString())
              .order('created_at', { ascending: true })
              .limit(5000),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
        supabase
          .from('chip_transactions')
          .select('amount, created_at')
          .eq('club_id', resolvedId)
          .eq('transaction_type', 'rakeback')
          .gte('created_at', startDate.toISOString())
          .limit(5000),
        // PHASE 7: off commission_history, which held zero rows for the whole
        // life of this page, onto the agent_commissions ledger the engine writes
        // as hands settle. "Agent Commissions" here was 0 for every club and
        // every period while SHARK CLUB alone had accrued 399,609.57.
        //
        // Through an RPC rather than a select, because RLS on agent_commissions
        // gives a caller their OWN rows - a club owner reading it directly would
        // see only what they had personally earned, which is a smaller lie in
        // place of a bigger one. The function checks the caller is staff of this
        // club and returns the aggregate.
        supabase.rpc('fn_club_commission_accrued', {
          p_club_id: resolvedId,
          p_since: startDate.toISOString(),
        }),
        supabase
          .from('settlement_invoices')
          .select('net_amount, created_at')
          .eq('club_id', resolvedId)
          .eq('invoice_type', 'union_to_club')
          .gte('created_at', startDate.toISOString())
          .limit(500),
      ]);

      const rakeData = (rakeRes as any)?.data as any[] | null;

      // Aggregate totals from actual rake_history rows
      const totalRake = (rakeData || []).reduce(
        (sum: number, r: any) => sum + (r.rake_amount || 0),
        0
      );
      const totalPots = (rakeData || []).reduce(
        (sum: number, r: any) => sum + (r.pot_size || 0),
        0
      );
      const totalHands = (rakeData || []).length;

      // Real figures, each from the ledger that actually records it.
      const rakebackPaid = ((rakebackRes as any)?.data || []).reduce(
        (sum: number, r: any) => sum + (Number(r.amount) || 0),
        0
      );
      // The RPC answers one number. An error binds rather than being discarded:
      // a denied read and a club that has accrued nothing are not the same
      // thing, and this figure is subtracted from the club's net revenue.
      if ((commissionRes as any)?.error) {
        reportError((commissionRes as any).error, 'ClubFinancialsPage.commission_accrued');
      }
      const agentCommissions = Number((commissionRes as any)?.data ?? 0) || 0;
      const unionFees = ((unionFeeRes as any)?.data || []).reduce(
        (sum: number, r: any) => sum + (Number(r.net_amount) || 0),
        0
      );
      const netRevenue = totalRake - rakebackPaid - agentCommissions - unionFees;

      if (!isMounted.current) return;

      const summaryData = {
        period,
        rake_collected: totalRake,
        rakeback_paid: rakebackPaid,
        agent_commissions: agentCommissions,
        union_fees: unionFees,
        net_revenue: netRevenue,
        total_hands: totalHands,
        total_pots: totalPots,
      };
      setSummary(summaryData);

      // Build daily chart data from rake_history
      const dailyMap = new Map<string, { rake: number; rakeback: number }>();
      const dayLabel = (iso: string) =>
        new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      for (const row of rakeData || []) {
        const dayKey = dayLabel(row.created_at);
        const existing = dailyMap.get(dayKey) || { rake: 0, rakeback: 0 };
        existing.rake += row.rake_amount || 0;
        dailyMap.set(dayKey, existing);
      }
      // Rakeback plotted from the rows that actually paid it, not as a
      // fixed fraction of the rake bar next to it.
      for (const row of (rakebackRes as any)?.data || []) {
        const dayKey = dayLabel(row.created_at);
        const existing = dailyMap.get(dayKey) || { rake: 0, rakeback: 0 };
        existing.rakeback += Number(row.amount) || 0;
        dailyMap.set(dayKey, existing);
      }
      const chartDataLocal = Array.from(dailyMap.entries()).map(([name, vals]) => ({
        name,
        rake: vals.rake,
        rakeback: vals.rakeback,
      }));
      setChartData(chartDataLocal);

      // Recent rake rows — same dead-table fix as above: rake_records is the
      // live ledger. (rake_records has no hand_number; it links a hand by id.)
      const { data: recentRake } = await retryFetch(
        () =>
          supabase
            .from('rake_records')
            .select('id, rake_amount, pot_size, created_at')
            .eq('club_id', resolvedId)
            .gte('created_at', startDate.toISOString())
            .order('created_at', { ascending: false })
            .limit(20),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (recentRake) {
        const mappedTx = recentRake.map((r: any) => ({
          id: r.id,
          type: 'rake' as const,
          amount: r.rake_amount || 0,
          description: `${(r.rake_amount || 0).toLocaleString()} Chips Raked From A ${(r.pot_size || 0).toLocaleString()} Pot`,
          created_at: r.created_at,
        }));
        setTransactions(mappedTx);

        // SWR: cache successful fetch (local vars, not stale state)
        try {
          sessionStorage.setItem(
            swrKey,
            JSON.stringify({
              summary: summaryData,
              chartData: chartDataLocal,
              transactions: mappedTx.slice(0, 20),
            })
          );
        } catch (e) {
          reportError(e, 'ClubFinancialsPage.map');
          /* storage full */
        }
      }
    } catch (error) {
      if (!isMounted.current) return;
      reportError(error, 'ClubFinancialsPage.Failed_to_load_financials');
      setLoadError('Live financial data could not be loaded. No figures have been estimated.');
      toast.error('Failed to load financial data');
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  };

  const getTypeIcon = (type: string): string => {
    switch (type) {
      case 'rake':
        return '%';
      case 'payout':
        return '↓';
      case 'settlement':
        return '☐';
      case 'deposit':
        return '↑';
      case 'withdrawal':
        return '↓';
      default:
        return '●';
    }
  };

  if (loading) {
    return (
      <div className="financials-page">
        <PageSkeleton variant="financial" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="financials-page">
        <ErrorState message={loadError} onRetry={loadFinancials} />
      </div>
    );
  }

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
          role={userRole}
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
            role={userRole}
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
          <button key={p} className={period === p ? 'active' : ''} onClick={() => setPeriod(p)}>
            {p === 'week' ? 'This Week' : p === 'month' ? 'This Month' : 'All Time'}
          </button>
        ))}
        <button
          className="export-btn"
          disabled={exporting}
          onClick={async () => {
            if (!clubId) return;
            setExporting(true);
            try {
              await FinancialExportService.exportCSV({
                type: 'rake_records',
                clubId,
                periodStart:
                  period === 'week'
                    ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
                    : period === 'month'
                      ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
                      : undefined,
              });
            } catch (e) {
              reportError(e, 'ClubFinancialsPage.async');
              reportError(new Error('CSV export failed'), 'ClubFinancialsPage.CSV_export_failed');
            }
            setExporting(false);
          }}
          style={{
            marginLeft: 'auto',
            padding: '6px 14px',
            background: 'rgba(24, 119, 242, 0.1)',
            border: '1px solid rgba(24, 119, 242, 0.3)',
            borderRadius: '8px',
            color: '#1877f2',
            fontWeight: 700,
            fontSize: '0.75rem',
            cursor: exporting ? 'wait' : 'pointer',
            opacity: exporting ? 0.5 : 1,
          }}
        >
          {exporting ? 'Exporting...' : 'Export CSV'}
        </button>
      </div>

      {/* Revenue Chart */}
      <section
        className="chart-section"
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.3)',
          borderRadius: '12px',
          padding: '16px',
          marginBottom: '16px',
        }}
      >
        <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#888' }}>Revenue Trend</h3>
        <FinancialChart data={chartData} height={180} showRakeback={true} />
      </section>

      {/* Summary Cards */}
      {summary && (
        <div className="summary-cards">
          {/* Hands & Pots Overview */}
          <div className="summary-row">
            <div className="summary-card">
              <span className="card-value">{summary.total_hands.toLocaleString()}</span>
              <span className="card-label">Hands Played</span>
            </div>
            <div className="summary-card">
              <span className="card-value">{summary.total_pots.toLocaleString()}</span>
              <span className="card-label">Total Pot Volume</span>
            </div>
          </div>
          <div className="summary-card revenue">
            <span className="card-value">{summary.rake_collected.toLocaleString()}</span>
            <span className="card-label">Rake Collected</span>
          </div>
          <div className="summary-row">
            <div className="summary-card">
              <span className="card-value expense">-{summary.rakeback_paid.toLocaleString()}</span>
              <span className="card-label">Rakeback</span>
            </div>
            <div className="summary-card">
              <span className="card-value expense">
                -{summary.agent_commissions.toLocaleString()}
              </span>
              <span className="card-label">Agent Fees</span>
            </div>
          </div>
          <div className="summary-card net">
            <span className={`card-value ${summary.net_revenue >= 0 ? 'positive' : 'negative'}`}>
              {summary.net_revenue >= 0 ? '+' : ''}
              {summary.net_revenue.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            <span className="card-label">Net Revenue</span>
          </div>
        </div>
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

      {/* Recent Transactions */}
      <section className="transactions-section">
        <h3>Recent Transactions</h3>
        {transactions.length === 0 ? (
          <div className="empty-state">
            <p>No Transactions Yet</p>
          </div>
        ) : (
          <div className="transactions-list">
            {transactions.map((tx) => (
              <div
                key={tx.id}
                className={`transaction-row ${visibleTransactions.has(tx.id) ? 'fadeInUp' : 'hidden'}`}
                style={
                  visibleTransactions.has(tx.id)
                    ? undefined
                    : { opacity: 0, transform: 'translateY(8px)' }
                }
              >
                <span className="tx-icon">{getTypeIcon(tx.type)}</span>
                <div className="tx-info">
                  <span className="tx-desc">{formatPopupText(tx.description)}</span>
                  <span className="tx-date">{formatDate(tx.created_at)}</span>
                </div>
                <span className={`tx-amount ${tx.amount >= 0 ? 'positive' : 'negative'}`}>
                  {tx.amount >= 0 ? '+' : ''}
                  {Math.abs(tx.amount).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Chip Ledger — Club Transaction Audit Trail */}
      {clubId && (
        <section style={{ padding: '0 16px 16px' }}>
          <div
            style={{
              background: 'rgba(255,255,255,0.02)',
              borderRadius: '12px',
              padding: '16px',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 700, color: '#e0e0e0' }}>
              Club Chip Audit Trail
            </h3>
            <TransactionLedgerView clubId={clubId} limit={25} />
          </div>
        </section>
      )}
    </div>
  );
}

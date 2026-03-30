/**
 *  CLUB FINANCIALS PAGE — Club Financial Overview
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import ClubBottomNav from '../components/club/ClubBottomNav';
import { useToast } from '../components/common/Toast';
import { ClubFinancialDashboard } from '../components/dashboard/ClubFinancialDashboard';
import FinancialChart from '../components/charts/FinancialChart';
import RakeReports from '../components/admin/RakeReports';
import PageSkeleton from '../components/common/PageSkeleton';
import TransactionLedgerView from '../components/common/TransactionLedgerView';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { FinancialExportService } from '../services/FinancialExportService';
import DynamicWallet from '../components/wallet/DynamicWallet';
import './ClubFinancialsPage.css';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';
import { formatDateShort as formatDate } from '../utils/format';
import { reportError } from '../utils/errorReporter';

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
  const [period, setPeriod] = useState<'week' | 'month' | 'all'>('week');
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');
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
    setUserRole('member');
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
          setUserRole(data.role as 'owner' | 'admin' | 'agent' | 'member');
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

  // ── Realtime subscription: live financial data updates ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;

    const channelKey = `club-financials-${clubId}`;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'wallet_transactions',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => {
            loadFinancialsRef.current();
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'rake_history',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => {
            loadFinancialsRef.current();
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            reportError(err?.message || err, 'ClubFinancialsPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[ClubFinancialsPage] ⏱️ Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[ClubFinancialsPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId]);

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
    const unsubTxLogged = masterBus.subscribeDebounced('TRANSACTION_LOGGED' as any, refresh, 2000);
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

      // Load rake data from rake_history (the REAL table populated by the server)
      const { data: rakeData } = await retryFetch(
        () =>
          supabase
            .from('rake_history')
            .select('rake_amount, pot_amount, collected_at')
            .eq('club_id', resolvedId)
            .gte('collected_at', startDate.toISOString())
            .order('collected_at', { ascending: true })
            .limit(5000),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      // Aggregate totals from actual rake_history rows
      const totalRake = (rakeData || []).reduce(
        (sum: number, r: any) => sum + (r.rake_amount || 0),
        0
      );
      const totalPots = (rakeData || []).reduce(
        (sum: number, r: any) => sum + (r.pot_amount || 0),
        0
      );
      const totalHands = (rakeData || []).length;

      // Estimate rakeback (~10% of rake) and agent commissions (~5% of rake)
      // These are estimates until actual rakeback/commission tracking is built
      const estimatedRakeback = totalRake * 0.1;
      const estimatedCommissions = totalRake * 0.05;
      const netRevenue = totalRake - estimatedRakeback - estimatedCommissions;

      if (!isMounted.current) return;

      const summaryData = {
        period,
        rake_collected: totalRake,
        rakeback_paid: estimatedRakeback,
        agent_commissions: estimatedCommissions,
        union_fees: 0,
        net_revenue: netRevenue,
        total_hands: totalHands,
        total_pots: totalPots,
      };
      setSummary(summaryData);

      // Build daily chart data from rake_history
      const dailyMap = new Map<string, { rake: number; rakeback: number }>();
      for (const row of rakeData || []) {
        const dayKey = new Date(row.collected_at).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        });
        const existing = dailyMap.get(dayKey) || { rake: 0, rakeback: 0 };
        existing.rake += row.rake_amount || 0;
        existing.rakeback += (row.rake_amount || 0) * 0.1;
        dailyMap.set(dayKey, existing);
      }
      const chartDataLocal = Array.from(dailyMap.entries()).map(([name, vals]) => ({
        name,
        rake: vals.rake,
        rakeback: vals.rakeback,
      }));
      setChartData(chartDataLocal);

      // Load recent rake history as transactions (no club_transactions table needed)
      const { data: recentRake } = await retryFetch(
        () =>
          supabase
            .from('rake_history')
            .select('id, rake_amount, pot_amount, hand_number, collected_at')
            .eq('club_id', resolvedId)
            .gte('collected_at', startDate.toISOString())
            .order('collected_at', { ascending: false })
            .limit(20),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (recentRake) {
        const mappedTx = recentRake.map((r: any) => ({
          id: r.id,
          type: 'rake' as const,
          amount: r.rake_amount || 0,
          description: `Hand #${r.hand_number} — ${(r.rake_amount || 0).toLocaleString()} chips from ${(r.pot_amount || 0).toLocaleString()} pot`,
          created_at: r.collected_at,
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

  return (
    <div className="financials-page">
      {/* Real-Time Wallet Overview */}
      {clubId && user?.id && (
        <DynamicWallet
          userId={user.id}
          clubId={clubId}
          variant={userRole === 'owner' ? 'owner' : 'player'}
          onBuyDiamonds={() => navigate('/vip')}
          onOpenBBJ={() => navigate(`/clubs/${clubId}/jackpot`)}
        />
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
          {exporting ? 'Exporting...' : '📥 Export CSV'}
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

      {/* Club Financial Dashboard - Chip Minting & Commission */}
      {clubId && (
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
            <p>No transactions yet</p>
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
                  <span className="tx-desc">{tx.description}</span>
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

      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}
    </div>
  );
}

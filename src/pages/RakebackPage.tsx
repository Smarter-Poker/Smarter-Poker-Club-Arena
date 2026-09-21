/**
 *  RAKEBACK PAGE — Player Rakeback Dashboard with Charts
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import { useToast } from '../components/common/Toast';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import './RakebackPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import { formatDateShort as formatDate } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import { ErrorState } from '../components/common/EmptyState';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import {
  getRakebackReadiness,
  nextRakebackBoundary,
  rakebackAccountingDay,
} from '../utils/rakebackReadiness';

interface RakebackPeriod {
  id: string;
  club_id: string;
  period_start: string;
  period_end: string;
  rake_generated: number;
  rakeback_rate: number | null;
  rakeback_earned: number;
  status: 'pending' | 'paid';
}

const PERIOD_COLUMNS =
  'id, user_id, club_id, period_start, period_end, rake_generated, rakeback_rate, rakeback_earned, status';

function rateLabel(rate: number | null | undefined) {
  return typeof rate === 'number' && Number.isFinite(rate)
    ? `${(rate * 100).toFixed(1)}%`
    : 'Unavailable';
}

export default function RakebackPage() {
  const navigate = useNavigate();
  useVisibilityRefresh(() => loadRakebackData());
  const { user } = useAuthUser();
  const toast = useToast();

  const [loadedPeriods, setPeriods] = useState<RakebackPeriod[]>([]);
  const [readyPeriod, setReadyPeriod] = useState<RakebackPeriod | null>(null);
  const [dataEpoch, setDataEpoch] = useState<number | null>(null);
  const [readinessAt, setReadinessAt] = useState(Date.now);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [visiblePeriodRows, setVisiblePeriodRows] = useState(new Set<number>());
  const mountedRef = useRef(true);
  const scopeRef = useRef({ userId: user?.id, epoch: 0 });
  // Invalidate old continuations immediately when the rendered account changes.
  if (scopeRef.current.userId !== user?.id) {
    scopeRef.current = { userId: user?.id, epoch: scopeRef.current.epoch + 1 };
  }
  const loadRakebackDataRef = useRef<() => void>(() => {});
  const loadingRef = useRef(false);
  const reloadQueuedRef = useRef(false);
  const ownsData = dataEpoch === scopeRef.current.epoch && !!user?.id;
  const periods = useMemo(() => (ownsData ? loadedPeriods : []), [ownsData, loadedPeriods]);
  const discoveredPeriods = useMemo(
    () => (ownsData && readyPeriod ? [readyPeriod] : []),
    [ownsData, readyPeriod]
  );
  const totalEarned = periods.reduce((sum, p) => sum + (Number(p.rakeback_earned) || 0), 0);
  const currentRate = periods[0]?.rakeback_rate;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scopeRef.current.epoch += 1;
      reloadQueuedRef.current = false;
    };
  }, []);

  const loadRakebackData = async () => {
    const { userId, epoch } = scopeRef.current;
    if (!userId || !mountedRef.current) return;
    if (loadingRef.current) {
      reloadQueuedRef.current = true;
      return;
    }
    const ownsRequest = () => mountedRef.current && scopeRef.current.epoch === epoch;
    loadingRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      // The book is a Pacific calendar; a UTC date opens the window early.
      const accountingToday = rakebackAccountingDay(Date.now());
      const [history, eligible] = await Promise.all([
        supabase
          .from('rakeback_periods')
          .select(PERIOD_COLUMNS)
          .eq('user_id', userId)
          .order('period_start', { ascending: false })
          .limit(12),
        supabase
          .from('rakeback_periods')
          .select(PERIOD_COLUMNS)
          .eq('user_id', userId)
          .eq('status', 'pending')
          .gt('rakeback_earned', 0)
          .lt('period_end', accountingToday)
          .not('club_id', 'is', null)
          .order('period_start', { ascending: false })
          .limit(1),
      ]);
      if (!ownsRequest()) return;
      if (history.error) throw history.error;
      if (eligible.error) throw eligible.error;
      setPeriods(history.data || []);
      setReadyPeriod(eligible.data?.[0] || null);
      setDataEpoch(epoch);
      setReadinessAt(Date.now());
    } catch (error) {
      if (ownsRequest() && !reloadQueuedRef.current) {
        reportError(error, 'RakebackPage.Failed_to_load_rakeback');
        setLoadError('Rakeback Data Could Not Be Refreshed. Please Try Again.');
        toast.error('Failed To Load Rakeback Data.');
      }
    } finally {
      loadingRef.current = false;
      if (reloadQueuedRef.current && mountedRef.current && scopeRef.current.userId) {
        reloadQueuedRef.current = false;
        loadRakebackDataRef.current();
      } else if (ownsRequest()) {
        setLoading(false);
      }
    }
  };
  loadRakebackDataRef.current = loadRakebackData;

  useEffect(() => {
    setPeriods([]);
    setReadyPeriod(null);
    setDataEpoch(null);
    setLoadError(null);
    setReadinessAt(Date.now());
    if (user?.id) loadRakebackDataRef.current();
    else {
      reloadQueuedRef.current = false;
      setLoading(false);
    }
  }, [user?.id]);

  // Real-time updates when rakeback periods change
  const handleRakebackUpdate = useCallback(() => {
    loadRakebackDataRef.current();
  }, []);

  useMasterBusChannel({
    channelName: user?.id ? `rakeback-updates-${user.id}` : null,
    table: 'rakeback_periods',
    filter: user?.id ? `user_id=eq.${user.id}` : null,
    event: '*',
    onPayload: handleRakebackUpdate,
    enabled: !!user?.id,
  });

  // Real-time wallet updates: NOT subscribed here any more (2026-08-24).
  //
  // A `wallet-updates-<uid>` channel on `wallets` filtered by user_id used to
  // sit here with a handleWalletUpdate callback. PostgresSyncHooks'
  // `global_db_sync:<userId>` channel already carries that exact listener -
  // same table, same filter - created once at sign-in and never torn down by
  // navigation, and it emits BALANCE_UPDATED. The bus subscriber below already
  // reloads on BALANCE_UPDATED, so the refresh path is unchanged and one
  // subscription per visit to this page disappears.
  //
  // The rakeback_periods channel above STAYS: it is genuinely specific to this
  // page and has no equivalent in the global channel.

  // Bus listeners: reload when balance changes or settlements complete
  useEffect(() => {
    if (!user?.id) return;
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadRakebackDataRef.current();
      },
      500
    );
    return () => {
      unsubBalance();
    };
  }, [user?.id]);

  // Stagger period rows
  useEffect(() => {
    setVisiblePeriodRows(new Set());
    const timers = periods.map((_, i) =>
      setTimeout(() => setVisiblePeriodRows((prev) => new Set([...prev, i])), i * 40)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [periods.length]);

  // Chart data (reversed for chronological order)
  const chartData = useMemo(() => {
    return [...periods]
      .reverse()
      .slice(-6)
      .map((p) => ({
        period: formatDate(p.period_start),
        earned: p.rakeback_earned,
        rake: p.rake_generated,
      }));
  }, [periods]);

  const recentReadiness = useMemo(
    () => getRakebackReadiness(periods, readinessAt),
    [periods, readinessAt]
  );
  // The discovered club is read for its AMOUNT only. Nothing on this surface
  // targets a club for a write any more.
  const { readyAmount } = useMemo(
    () => getRakebackReadiness(discoveredPeriods, readinessAt),
    [discoveredPeriods, readinessAt]
  );
  const pendingAmount = recentReadiness.readyAmount + recentReadiness.pendingAmount;
  const readyPeriodIds = recentReadiness.readyPeriodIds;

  // Always rediscover at the Pacific accounting midnight, including eligible
  // clubs outside the recent history. UTC midnight is 7 hours early (8 in PST)
  // and would show a week as closed before its book closed.
  useEffect(() => {
    if (!user?.id) return;
    const boundary = nextRakebackBoundary(Date.now());
    if (boundary === null) return;
    const timer = setTimeout(
      () => {
        setReadinessAt(Date.now());
        loadRakebackDataRef.current();
      },
      Math.max(0, boundary - Date.now())
    );
    return () => clearTimeout(timer);
  }, [readinessAt, user?.id]);

  // NO CLAIM ACTION LIVES HERE (2026-09-20).
  //
  // fn_claim_rakeback was retired by the weekly accounting cutover: it derives
  // no payout any more and unconditionally answers
  // {success:false, code:'automatic_weekly_settlement'}. The page kept calling
  // it, so every eligible player who pressed the green button was told their
  // rakeback had failed - the database was right and the interface was not.
  // fn_process_weekly_accounting is the single authority and it runs every
  // Monday at 04:00 America/Chicago. This surface therefore REPORTS: what has
  // closed, what is still open, and when the run will settle it. Restoring a
  // claim button here needs a paying server authority first, not a retry.
  return (
    <div className="rakeback-page">
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Rakeback"
        title="Rakeback Engine"
        description="See The Value Returning From Completed Play And Inspect Every Earning Period. Rakeback Is Settled Automatically Every Monday At 4:00 AM Central Time."
        art="diamonds"
        status="RAKEBACK ENGINE // LIVE"
        crest="flat"
        metrics={[
          { label: 'Recent Earnings', value: totalEarned.toLocaleString(), tone: 'live' },
          { label: 'Latest Period Rate', value: rateLabel(currentRate) },
          { label: 'Next Ready Period', value: readyAmount.toLocaleString(), tone: 'attention' },
        ]}
      />
      <div className="rakeback-summary">
        <div className="summary-card main">
          <span className="card-icon"></span>
          <div className="card-content">
            <span className="card-value">{totalEarned.toLocaleString()}</span>
            <span className="card-label">Recent Earnings</span>
          </div>
        </div>
        <div className="summary-row">
          <div className="summary-card">
            <span className="card-value">{rateLabel(currentRate)}</span>
            <span className="card-label">Latest Period Rate</span>
          </div>
          <div className="summary-card pending">
            <span className="card-value">{readyAmount.toLocaleString()}</span>
            <span className="card-label">Next Ready Period</span>
            <p className="card-label">Recent Pending Earnings: {pendingAmount.toLocaleString()}</p>
            <p className="card-label">
              Estimate For One Period. The Automatic Run May Settle More Periods.
            </p>
            <p className="card-label settlement-schedule">
              Settled Automatically Every Monday At 4:00 AM Central Time.
            </p>
          </div>
        </div>
      </div>

      {/* Rakeback Chart */}
      {chartData.length > 0 && (
        <div className="rakeback-chart">
          <h3> Earnings History</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
              <XAxis dataKey="period" stroke="var(--text-secondary)" fontSize={12} />
              <YAxis stroke="var(--text-secondary)" fontSize={12} tickFormatter={(v) => `${v}`} />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-secondary)',
                  border: 'none',
                  borderRadius: '8px',
                }}
                formatter={(value) => [`${Number(value || 0).toLocaleString()}`, 'Rakeback']}
              />
              <Bar dataKey="earned" fill="var(--accent-success)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="rakeback-info">
        <h3>How Rakeback Works</h3>
        <p>
          You Earn Back A Percentage Of The Rake You Generate At The Tables. Your Rate Increases As
          You Play More And Move Up VIP Levels. Earning Periods Close At Midnight Pacific Time After
          Their End Date. Rakeback Is Settled Automatically Every Monday At 4:00 AM Central Time,
          And Every Transfer Is Recorded In Your Invoices.
        </p>
      </div>

      <div className="rakeback-history">
        <h3>Recent History</h3>
        {loading ? (
          <div className="loading-state">
            <PageSkeleton variant="financial" />
          </div>
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => void loadRakebackData()} />
        ) : periods.length === 0 ? (
          <div className="empty-state">
            <p>No Rakeback History Yet. Play Some Hands To Earn Rakeback!</p>
          </div>
        ) : (
          <div className="periods-list">
            {periods.map((period, index) => (
              <div
                key={period.id}
                className="period-row"
                style={{
                  opacity: visiblePeriodRows.has(index) ? 1 : 0,
                  transform: visiblePeriodRows.has(index) ? 'translateY(0)' : 'translateY(6px)',
                  transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <div className="period-dates">
                  <span>
                    {formatDate(period.period_start)} - {formatDate(period.period_end)}
                  </span>
                </div>
                <div className="period-details">
                  <span className="rake-generated">
                    Rake: {(period.rake_generated || 0).toLocaleString()}
                  </span>
                  <span className="rakeback-rate">{rateLabel(period.rakeback_rate)}</span>
                </div>
                <div className="period-earned">
                  <span className={`amount ${period.status}`}>
                    {(period.rakeback_earned || 0).toLocaleString()}
                  </span>
                  <span className={`status ${period.status}`}>
                    {period.status === 'paid'
                      ? ' Paid'
                      : readyPeriodIds.has(period.id)
                        ? ' Ready To Settle'
                        : ' Pending'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

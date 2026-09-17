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
import { retryFetch } from '../utils/retryFetch';
import { formatDateShort as formatDate } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import { ErrorState } from '../components/common/EmptyState';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import { getRakebackReadiness } from '../utils/rakebackReadiness';
import { readRakebackClaimResult } from '../utils/rakebackClaimResult';

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

type ClaimStatus = 'idle' | 'claiming' | 'success' | 'error';

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
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>('idle');
  const [claimMessage, setClaimMessage] = useState('');
  const [visiblePeriodRows, setVisiblePeriodRows] = useState(new Set<number>());
  const claimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const claimAttemptRef = useRef<{ current: boolean } | null>(null);
  const mountedRef = useRef(true);
  const scopeRef = useRef({ userId: user?.id, epoch: 0 });
  // Invalidate old continuations immediately when the rendered account changes.
  if (scopeRef.current.userId !== user?.id) {
    scopeRef.current = { userId: user?.id, epoch: scopeRef.current.epoch + 1 };
    if (claimAttemptRef.current) claimAttemptRef.current.current = false;
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
      if (claimAttemptRef.current) claimAttemptRef.current.current = false;
      if (claimTimerRef.current) clearTimeout(claimTimerRef.current);
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
      const todayUtc = new Date().toISOString().slice(0, 10);
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
          .lt('period_end', todayUtc)
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
    setClaimStatus('idle');
    setClaimMessage('');
    if (claimTimerRef.current) clearTimeout(claimTimerRef.current);
    claimTimerRef.current = null;
    claimAttemptRef.current = null;
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
  const { readyAmount, targetClubId } = useMemo(
    () => getRakebackReadiness(discoveredPeriods, readinessAt),
    [discoveredPeriods, readinessAt]
  );
  const pendingAmount = recentReadiness.readyAmount + recentReadiness.pendingAmount;
  const readyPeriodIds = recentReadiness.readyPeriodIds;

  // Always rediscover at UTC midnight, including eligible clubs outside the recent history.
  useEffect(() => {
    if (!user?.id) return;
    const now = new Date();
    const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const timer = setTimeout(
      () => {
        setReadinessAt(Date.now());
        loadRakebackDataRef.current();
      },
      Math.max(0, nextMidnight - Date.now())
    );
    return () => clearTimeout(timer);
  }, [readinessAt, user?.id]);

  // ── Claim rakeback handler ──
  const handleClaimRakeback = async () => {
    if (!ownsData || loading || loadError || claimAttemptRef.current?.current) return;
    const epoch = scopeRef.current.epoch;
    const initiatingUserId = user?.id;
    const attempt = { current: true };
    claimAttemptRef.current = attempt;
    const ownsAttempt = () =>
      mountedRef.current &&
      attempt.current &&
      scopeRef.current.epoch === epoch &&
      scopeRef.current.userId === initiatingUserId;
    if (claimTimerRef.current) {
      clearTimeout(claimTimerRef.current);
      claimTimerRef.current = null;
    }
    setClaimStatus('claiming');
    setClaimMessage('');
    let unconfirmedTransport = false;
    try {
      if (!user?.id) {
        setClaimStatus('error');
        setClaimMessage('Authentication error. Please refresh.');
        return;
      }

      // Single atomic, server-authoritative claim. fn_claim_rakeback derives the player
      // from auth.uid(), recomputes the payout server-side from rake_records, marks each
      // pending period paid, and credits the PLAYER wallet through the whitelisted,
      // ledger-logging path — all in ONE transaction, idempotent and horse-safe. Replaces
      // the old client-side "mark paid, then credit with a client-supplied amount" flow,
      // which could not write the wallet under RLS (leaving periods flipped to paid with
      // no chips delivered) and trusted a client-supplied amount.
      // Recheck the current clock at the click boundary and always scope the legacy RPC.
      const targetClubId = getRakebackReadiness(discoveredPeriods, Date.now()).targetClubId;
      if (!targetClubId) {
        setClaimStatus('error');
        setClaimMessage('No Closed Earning Periods Are Ready To Claim.');
        setReadinessAt(Date.now());
        return;
      }

      const { data: claimRes, error: claimErr } = await retryFetch(
        async () => {
          if (!ownsAttempt()) throw new DOMException('Claim Attempt Ended', 'AbortError');
          try {
            const result = await supabase.rpc('fn_claim_rakeback', { p_club_id: targetClubId });
            if (result.error && !result.error.code) unconfirmedTransport = true;
            return result;
          } catch (error) {
            unconfirmedTransport = true;
            throw error;
          }
        },
        { maxRetries: 2, isMountedRef: attempt }
      );
      if (!ownsAttempt()) return;
      if (claimErr) throw new Error(claimErr.message);

      const claimed = readRakebackClaimResult(claimRes);
      if (claimed.kind === 'refused') throw new Error(claimed.message);
      if (claimed.kind === 'unconfirmed') {
        // A malformed reply does not establish whether money moved. Refresh authoritative reads.
        void loadRakebackData();
        masterBus.emit('WALLET_REFRESHED', { walletType: 'PLAYER', available: 0, total: 0 });
        throw new Error(
          'Claim Result Could Not Be Confirmed. Please Check Your Refreshed Balances.'
        );
      }
      if (claimed.kind === 'unpaid') {
        setClaimStatus('error');
        setClaimMessage('No Additional Payout Was Confirmed. Pending Periods May Be Deferred.');
        void loadRakebackData();
        masterBus.emit('WALLET_REFRESHED', { walletType: 'PLAYER', available: 0, total: 0 });
        return;
      }

      const claimedTotal = claimed.amount;
      setClaimStatus('success');
      setClaimMessage(`Claimed ${claimedTotal.toLocaleString()} chips!`);
      // Reload data to reflect changed status
      loadRakebackData();
      // Current WALLET_REFRESHED subscribers refetch; this RPC does not return wallet balances.
      masterBus.emit('WALLET_REFRESHED', { walletType: 'PLAYER', available: 0, total: 0 });
      masterBus.emit('RAKEBACK_CLAIMED', {
        clubId: targetClubId ?? '',
        amount: claimedTotal,
        userId: initiatingUserId!,
      });
      if (claimTimerRef.current) clearTimeout(claimTimerRef.current);
      claimTimerRef.current = setTimeout(() => {
        if (!mountedRef.current || scopeRef.current.epoch !== epoch) return;
        setClaimStatus('idle');
        setClaimMessage('');
        claimTimerRef.current = null;
      }, 3000);
    } catch (err: any) {
      if (!ownsAttempt() || err.name === 'AbortError') return;
      setClaimStatus('error');
      if (unconfirmedTransport) {
        void loadRakebackData();
        masterBus.emit('WALLET_REFRESHED', { walletType: 'PLAYER', available: 0, total: 0 });
      }
      const msg = unconfirmedTransport
        ? 'Claim Result Could Not Be Confirmed. Please Check Your Refreshed Balances.'
        : err.message || 'Claim Failed. Please Try Again.';
      setClaimMessage(msg);
      toast.error(msg);
    } finally {
      attempt.current = false;
    }
  };

  return (
    <div className="rakeback-page">
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Rakeback"
        title="Rakeback Engine"
        description="See The Value Returning From Completed Play, Inspect Every Earning Period, And Claim Eligible Funds Through The Existing Settlement Workflow."
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
              Estimate For One Period. A Club Claim May Include More Periods.
            </p>
            {targetClubId && (
              <button
                className="claim-btn"
                onClick={() => handleClaimRakeback()}
                disabled={!ownsData || loading || !!loadError || claimStatus === 'claiming'}
                style={{
                  marginTop: '8px',
                  padding: '6px 16px',
                  minHeight: '44px',
                  touchAction: 'manipulation',
                  background:
                    claimStatus === 'success' ? '#34c759' : 'var(--accent-success, #34c759)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  fontWeight: 700,
                  fontSize: '0.8rem',
                  cursor: claimStatus === 'claiming' ? 'wait' : 'pointer',
                  opacity: claimStatus === 'claiming' ? 0.6 : 1,
                  transition: 'all 0.2s',
                }}
              >
                {claimStatus === 'claiming'
                  ? 'Claiming...'
                  : claimStatus === 'success'
                    ? '✓ Claimed!'
                    : 'Claim Rakeback'}
              </button>
            )}
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

      {ownsData && claimMessage && (
        <div
          style={{
            padding: '10px 16px',
            borderRadius: '8px',
            fontSize: '0.85rem',
            fontWeight: 600,
            background:
              claimStatus === 'success'
                ? 'rgba(52, 199, 89, 0.15)'
                : claimStatus === 'error'
                  ? 'rgba(255, 59, 48, 0.15)'
                  : 'transparent',
            color: claimStatus === 'success' ? '#34c759' : '#ff3b30',
            border: `1px solid ${claimStatus === 'success' ? 'rgba(52, 199, 89, 0.3)' : 'rgba(255, 59, 48, 0.3)'}`,
          }}
        >
          {claimMessage}
        </div>
      )}

      <div className="rakeback-info">
        <h3>How Rakeback Works</h3>
        <p>
          You Earn Back A Percentage Of The Rake You Generate At The Tables. Your Rate Increases As
          You Play More And Move Up VIP Levels. Earning Periods Close At 00:00 UTC After Their End
          Date. Claims Are Processed One Club At A Time, And The Server Confirms The Payout.
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
                        ? ' Ready To Claim'
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

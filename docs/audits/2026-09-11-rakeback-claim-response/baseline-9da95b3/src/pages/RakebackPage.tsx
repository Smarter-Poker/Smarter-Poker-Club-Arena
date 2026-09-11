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
import { retryAsync } from '../utils/retryAsync';
import { formatDateShort as formatDate } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import { ErrorState } from '../components/common/EmptyState';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import { getRakebackReadiness } from '../utils/rakebackReadiness';

interface RakebackPeriod {
  id: string;
  club_id: string;
  period_start: string;
  period_end: string;
  rake_generated: number;
  rakeback_rate: number;
  rakeback_earned: number;
  status: 'pending' | 'paid';
}

type ClaimStatus = 'idle' | 'claiming' | 'success' | 'error';

export default function RakebackPage() {
  const navigate = useNavigate();
  useVisibilityRefresh(() => loadRakebackData());
  const { user } = useAuthUser();
  const toast = useToast();

  const [periods, setPeriods] = useState<RakebackPeriod[]>([]);
  const [readinessAt, setReadinessAt] = useState(Date.now);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [totalEarned, setTotalEarned] = useState(0);
  const [currentRate, setCurrentRate] = useState(0);
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>('idle');
  const [claimMessage, setClaimMessage] = useState('');
  const [visiblePeriodRows, setVisiblePeriodRows] = useState(new Set<number>());
  const claimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (claimTimerRef.current) clearTimeout(claimTimerRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  // Refs to avoid stale closures
  const loadRakebackDataRef = useRef<() => void>(() => {});

  const loadingRef = useRef(false);

  const loadRakebackData = async (getIsMounted?: () => boolean) => {
    if (!user?.id) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!getIsMounted || getIsMounted()) setLoading(true);
    if (!getIsMounted || getIsMounted()) setLoadError(null);
    try {
      const { data, error } = await supabase
        .from('rakeback_periods')
        .select(
          'id, user_id, club_id, period_start, period_end, rake_generated, rakeback_rate, rakeback_earned, status'
        )
        .eq('user_id', user?.id)
        .order('period_start', { ascending: false })
        .limit(12);

      if (getIsMounted && !getIsMounted()) return;
      if (error) throw error;
      setPeriods(data || []);
      setReadinessAt(Date.now());
      setTotalEarned((data || []).reduce((sum, p) => sum + (p.rakeback_earned || 0), 0));
      if (data && data.length > 0) {
        setCurrentRate(data[0].rakeback_rate || 0);
      }
    } catch (error) {
      reportError(error, 'RakebackPage.Failed_to_load_rakeback');
      if (!getIsMounted || getIsMounted()) {
        setLoadError('Rakeback history could not be loaded. Your balance has not been changed.');
      }
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load rakeback data.');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  // Store ref for callback use
  useEffect(() => {
    loadRakebackDataRef.current = loadRakebackData;
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
    const unsubSettlement = masterBus.subscribeDebounced(
      'SETTLEMENT_COMPLETED',
      () => {
        loadRakebackDataRef.current();
      },
      1000
    );
    return () => {
      unsubBalance();
      unsubSettlement();
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

  // Initial load
  useEffect(() => {
    let isMounted = true;
    if (user?.id) {
      loadRakebackData(() => isMounted);
    }
    return () => {
      isMounted = false;
    };
  }, [user?.id]);

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

  const { readyAmount, pendingAmount, targetClubId, nextChangeAt, readyPeriodIds } = useMemo(
    () => getRakebackReadiness(periods, readinessAt),
    [periods, readinessAt]
  );

  // Keep an open page accurate when a displayed earning period closes, without polling.
  useEffect(() => {
    if (nextChangeAt === null) return;
    const delay = Math.max(0, Math.min(nextChangeAt - Date.now(), 2_147_483_647));
    const timer = setTimeout(() => setReadinessAt(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [nextChangeAt, readinessAt]);

  // ── Claim rakeback handler ──
  const handleClaimRakeback = async () => {
    if (loading || loadError || claimStatus === 'claiming') return;
    setClaimStatus('claiming');
    setClaimMessage('');
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
      const targetClubId = getRakebackReadiness(periods, Date.now()).targetClubId;
      if (!targetClubId) {
        setClaimStatus('error');
        setClaimMessage('No Closed Earning Periods Are Ready To Claim.');
        setReadinessAt(Date.now());
        return;
      }

      const { data: claimRes, error: claimErr } = await retryAsync(
        () => supabase.rpc('fn_claim_rakeback', { p_club_id: targetClubId }),
        2
      );
      if (claimErr) throw new Error(claimErr.message);

      const claimed = (claimRes ?? {}) as { total_payout?: number; periods_claimed?: number };
      const claimedTotal = Number(claimed.total_payout ?? 0);
      const claimedCount = Number(claimed.periods_claimed ?? 0);

      if (claimedTotal <= 0 && claimedCount === 0) {
        setClaimStatus('error');
        setClaimMessage('No rakeback to claim.');
        loadRakebackData();
        return;
      }

      setClaimStatus('success');
      setClaimMessage(`Claimed ${claimedTotal.toLocaleString()} chips!`);
      // Reload data to reflect changed status
      loadRakebackData();
      // Notify other pages that wallet balance changed
      masterBus.emit('WALLET_REFRESHED', { walletType: 'PLAYER', available: 0, total: 0 });
      masterBus.emit('RAKEBACK_CLAIMED', {
        clubId: targetClubId ?? '',
        amount: claimedTotal,
        userId: user.id,
      });
      if (claimTimerRef.current) clearTimeout(claimTimerRef.current);
      claimTimerRef.current = setTimeout(() => {
        setClaimStatus('idle');
        setClaimMessage('');
        claimTimerRef.current = null;
      }, 3000);
    } catch (err: any) {
      if (err.name === 'AbortError') return; // Ignore voluntary aborts
      setClaimStatus('error');
      const msg = err.message || 'Claim failed. Please try again.';
      setClaimMessage(msg);
      toast.error(msg);
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
          { label: 'Total Earned', value: totalEarned.toLocaleString(), tone: 'live' },
          { label: 'Current Rate', value: `${(currentRate * 100).toFixed(1)}%` },
          { label: 'Ready To Claim', value: readyAmount.toLocaleString(), tone: 'attention' },
        ]}
      />
      {/* Promotional Banner — WPT-style */}
      {currentRate > 0 && (
        <div className="rakeback-promo-banner">
          <h3>You're Earning {(currentRate * 100).toFixed(0)}% Rakeback</h3>
          <p>Every Hand You Play Earns You Cash Back. Keep Playing To Increase Your Rate!</p>
        </div>
      )}

      <div className="rakeback-summary">
        <div className="summary-card main">
          <span className="card-icon"></span>
          <div className="card-content">
            <span className="card-value">{totalEarned.toLocaleString()}</span>
            <span className="card-label">Total Earned</span>
          </div>
        </div>
        <div className="summary-row">
          <div className="summary-card">
            <span className="card-value">{(currentRate * 100).toFixed(1)}%</span>
            <span className="card-label">Your Rate</span>
          </div>
          <div className="summary-card pending">
            <span className="card-value">{readyAmount.toLocaleString()}</span>
            <span className="card-label">Ready To Claim</span>
            <p className="card-label">Pending Earnings: {pendingAmount.toLocaleString()}</p>
            {targetClubId && (
              <button
                className="claim-btn"
                onClick={() => handleClaimRakeback()}
                disabled={loading || !!loadError || claimStatus === 'claiming'}
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

      {claimMessage && (
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
        <h3>History</h3>
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
                  <span className="rakeback-rate">
                    {((period.rakeback_rate || 0) * 100).toFixed(1)}%
                  </span>
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

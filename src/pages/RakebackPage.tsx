/**
 *  RAKEBACK PAGE — Player Rakeback Dashboard with Charts
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import './RakebackPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import { retryAsync } from '../utils/retryAsync';

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
  const [loading, setLoading] = useState(true);
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

  const loadRakebackData = async (getIsMounted?: () => boolean) => {
    if (!user?.id) return;
    if (!getIsMounted || getIsMounted()) setLoading(true);
    try {
      const { data, error } = await supabase
        .from('rakeback_periods')
        .select('*')
        .eq('user_id', user?.id)
        .order('period_start', { ascending: false })
        .limit(12);

      if (getIsMounted && !getIsMounted()) return;
      if (!error && data) {
        setPeriods(data);
        setTotalEarned(data.reduce((sum, p) => sum + (p.rakeback_earned || 0), 0));
        if (data.length > 0) {
          setCurrentRate(data[0].rakeback_rate || 0);
        }
      }
    } catch (error) {
      console.error('Failed to load rakeback:', error);
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load rakeback data.');
    }
    if (!getIsMounted || getIsMounted()) setLoading(false);
  };

  // Store ref for callback use
  useEffect(() => {
    loadRakebackDataRef.current = loadRakebackData;
  }, [user?.id]);

  // Setup subscriptions to rakeback and wallet changes
  useEffect(() => {
    if (!user?.id) return;

    // Real-time updates when rakeback periods change
    const rakebackChannelKey = 'rakeback-updates';

    const rakebackChannel = masterBus.getOrCreateChannel(rakebackChannelKey);
    rakebackChannel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rakeback_periods',
          filter: `user_id=eq.${user.id}`,
        },
        () => loadRakebackDataRef.current()
      )
      .subscribe();

    // Real-time updates when wallet changes (balance/earnings)
    const walletChannelKey = 'wallet-updates';

    const walletChannel = masterBus.getOrCreateChannel(walletChannelKey);
    walletChannel
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'wallets',
          filter: `user_id=eq.${user.id}`,
        },
        () => loadRakebackDataRef.current()
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(rakebackChannelKey);
      masterBus.removeRegisteredChannel(walletChannelKey);
    };
  }, [user?.id]);

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

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  };

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

  const pendingAmount = periods
    .filter((p) => p.status === 'pending')
    .reduce((sum, p) => sum + p.rakeback_earned, 0);

  const pendingPeriodIds = periods.filter((p) => p.status === 'pending').map((p) => p.id);

  // ── Claim rakeback handler ──
  const handleClaimRakeback = async () => {
    setClaimStatus('claiming');
    setClaimMessage('');
    try {
      if (!user?.id) {
        setClaimStatus('error');
        setClaimMessage('Authentication error. Please refresh.');
        return;
      }

      // Find all pending periods for this club
      const targetClubId = periods.find((p) => p.status === 'pending')?.club_id;
      if (!targetClubId) {
        setClaimStatus('error');
        setClaimMessage('No pending rakeback found.');
        return;
      }

      const pendingPeriods = periods.filter((p) => p.status === 'pending');
      const totalToClaim = pendingPeriods.reduce((sum, p) => sum + p.rakeback_earned, 0);

      if (totalToClaim <= 0) {
        setClaimStatus('error');
        setClaimMessage('No rakeback to claim.');
        return;
      }

      // ═══ ATOMIC CLAIM PATTERN ═══
      // Step 1: Re-fetch pending periods from DB to prevent double-claim race condition
      const { data: freshPeriods, error: fetchError } = await supabase
        .from('rakeback_periods')
        .select('id, rakeback_earned')
        .eq('user_id', user.id)
        .eq('status', 'pending')
        .in(
          'id',
          pendingPeriods.map((p) => p.id)
        );

      if (fetchError) throw new Error(fetchError.message);
      if (!freshPeriods || freshPeriods.length === 0) {
        setClaimStatus('error');
        setClaimMessage('These periods have already been claimed.');
        loadRakebackData();
        return;
      }

      // Recalculate from fresh DB data (prevents stale UI amount)
      const verifiedAmount = freshPeriods.reduce((sum, p) => sum + (p.rakeback_earned || 0), 0);
      const verifiedIds = freshPeriods.map((p) => p.id);

      if (verifiedAmount <= 0) {
        setClaimStatus('error');
        setClaimMessage('No rakeback to claim.');
        return;
      }

      // Step 2: Mark periods as 'paid' FIRST (idempotency — prevents double-claim)
      // IMPORTANT: .select('id') returns the actually-updated rows — if 0 rows returned,
      // another tab/session already claimed these periods (concurrent claim defense).
      const { data: updatedRows, error: updateError } = await supabase
        .from('rakeback_periods')
        .update({ status: 'paid' })
        .in('id', verifiedIds)
        .eq('status', 'pending') // Extra guard: only update if still pending
        .select('id');

      if (updateError) throw new Error('Failed to lock periods: ' + updateError.message);

      // If no rows were actually updated, another session already claimed them
      if (!updatedRows || updatedRows.length === 0) {
        setClaimStatus('error');
        setClaimMessage('These periods have already been claimed.');
        loadRakebackData();
        return;
      }

      // Step 3: Credit chips with retry (if this fails, rollback periods to pending)
      const { error: rpcError } = await retryAsync(
        () =>
          supabase.rpc('credit_player_rakeback', {
            p_user_id: user.id,
            p_amount: verifiedAmount,
          }),
        2
      );

      if (rpcError) {
        // Rollback: restore periods to 'pending' since credit failed
        console.error('[Rakeback] Credit failed, rolling back period status:', rpcError);
        const { error: rollbackErr } = await supabase
          .from('rakeback_periods')
          .update({ status: 'pending' })
          .in('id', verifiedIds);
        if (rollbackErr) {
          console.error(
            '[Rakeback] CRITICAL: Rollback ALSO failed — periods stuck as paid without credit:',
            rollbackErr
          );
          throw new Error('Claim failed and rollback failed. Please contact support immediately.');
        }
        throw new Error(rpcError.message);
      }

      setClaimStatus('success');
      setClaimMessage(`Claimed ${verifiedAmount.toLocaleString()} chips!`);
      // Reload data to reflect changed status
      loadRakebackData();
      // Notify other pages that wallet balance changed
      masterBus.emit('WALLET_REFRESHED', { walletType: 'PLAYER', available: 0, total: 0 });
      masterBus.emit('RAKEBACK_CLAIMED', {
        clubId: targetClubId,
        amount: verifiedAmount,
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
      {/* Promotional Banner — WPT-style */}
      {currentRate > 0 && (
        <div className="rakeback-promo-banner">
          <h3>You're Earning {(currentRate * 100).toFixed(0)}% Rakeback</h3>
          <p>Every hand you play earns you cash back. Keep playing to increase your rate!</p>
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
            <span className="card-value">{pendingAmount.toLocaleString()}</span>
            <span className="card-label">Pending</span>
            {pendingAmount > 0 && (
              <button
                className="claim-btn"
                onClick={() => handleClaimRakeback()}
                disabled={claimStatus === 'claiming'}
                style={{
                  marginTop: '8px',
                  padding: '6px 16px',
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
                    : 'Claim All'}
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
          You earn back a percentage of the rake you generate at the tables. Your rate increases as
          you play more and move up VIP levels.
        </p>
      </div>

      <div className="rakeback-history">
        <h3>History</h3>
        {loading ? (
          <div className="loading-state">
            <PageSkeleton variant="financial" />
          </div>
        ) : periods.length === 0 ? (
          <div className="empty-state">
            <p>No rakeback history yet. Play some hands to earn rakeback!</p>
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
                    Rake: {period.rake_generated.toLocaleString()}
                  </span>
                  <span className="rakeback-rate">{(period.rakeback_rate * 100).toFixed(1)}%</span>
                </div>
                <div className="period-earned">
                  <span className={`amount ${period.status}`}>
                    {period.rakeback_earned.toLocaleString()}
                  </span>
                  <span className={`status ${period.status}`}>
                    {period.status === 'paid' ? ' Paid' : ' Pending'}
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

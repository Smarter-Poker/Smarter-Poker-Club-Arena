/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RAKEBACK DASHBOARD — Player-Facing Rakeback Tier & Earnings View
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Shows the player their current rakeback tier, pending rakeback, and history.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useToast } from '../components/common/Toast';
import PageSkeleton from '../components/common/PageSkeleton';
import { AreaChart, Area, XAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';

interface RakebackStats {
  totalRakeContributed: number;
  totalRakebackEarned: number;
  pendingRakeback: number;
  currentTier: string;
  nextTier: string | null;
  tierProgress: number; // 0-100
  handsPlayed: number;
}

/**
 * WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): this ladder now MIRRORS the
 * authoritative server ladder (fn_close_settlement_period / RakebackSettler:
 * 5/10/15/20/30% at 0/100/500/2000/10000 of WEEKLY weighted rake). The old
 * page carried its own 10-30% ladder and derived "rake contributed" from
 * wallet_transactions category 'rake' debits — a category cash players never
 * receive, so it displayed a tier the settler would never pay. Display only:
 * the rate that pays is always the one stored on the rakeback period row.
 */
const TIERS = [
  { name: 'Bronze', minRake: 0, percent: 5, color: '#cd7f32', icon: '☆' },
  { name: 'Silver', minRake: 100, percent: 10, color: '#c0c0c0', icon: '☆' },
  { name: 'Gold', minRake: 500, percent: 15, color: '#ffd700', icon: '★' },
  { name: 'Platinum', minRake: 2000, percent: 20, color: '#e5e4e2', icon: '◆' },
  { name: 'Diamond', minRake: 10000, percent: 30, color: '#b9f2ff', icon: '♛' },
];

export default function RakebackDashboard() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();

  const [stats, setStats] = useState<RakebackStats>({
    totalRakeContributed: 0,
    totalRakebackEarned: 0,
    pendingRakeback: 0,
    currentTier: 'Bronze',
    nextTier: 'Silver',
    tierProgress: 0,
    handsPlayed: 0,
  });
  const [recentPayouts, setRecentPayouts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleSections, setVisibleSections] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();

  useVisibilityRefresh(() => loadData());

  useEffect(() => {
    loadData();
    const timers = [0, 1, 2, 3, 4].map((i) =>
      setTimeout(() => {
        if (isMounted.current) setVisibleSections((prev) => new Set(prev).add(i));
      }, i * 80)
    );
    return () => timers.forEach(clearTimeout);
  }, [user?.id]);

  useEffect(() => {
    const unsub = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadData(), 1000);
    const unsub2 = masterBus.subscribeDebounced('HAND_COMPLETED', () => loadData(), 2000);
    const unsub3 = masterBus.subscribeDebounced('RAKEBACK_CLAIMED', () => loadData(), 500);
    const unsub4 = masterBus.subscribeDebounced('SETTLEMENT_COMPLETED', () => loadData(), 1000);
    return () => {
      unsub();
      unsub2();
      unsub3();
      unsub4();
    };
  }, []);

  // Realtime subscription on wallet_transactions removed (Phase 2 cost cut).
  // Rakeback is an analytics view — the three existing refresh paths cover it:
  //   • useVisibilityRefresh (line 57) refetches on tab focus
  //   • masterBus 'BALANCE_UPDATED' refetches when any wallet changes
  //   • masterBus 'HAND_COMPLETED' refetches when engine finishes a hand
  // Rakeback accrual lags real wallet changes by ≤1 s anyway, so removing the
  // direct INSERT subscription has no user-visible impact.

  const loadingRef = useRef(false);

  const loadData = async () => {
    if (!user?.id) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      // WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): every number on this page
      // now comes from the AUTHORITATIVE pipeline —
      //   rake generated  -> rakeback_periods.rake_generated (written by the
      //                      settler / fn_rakeback_recompute_periods from the
      //                      canonical weighted allocation of rake_records)
      //   pending         -> pending periods' rakeback_amount (what the close
      //                      will actually pay, at the rate it will pay)
      //   earned          -> real rakeback wallet credits (actual payouts)
      // The old page summed wallet_transactions category 'rake' debits, which
      // cash players never receive (rake leaves the POT), so it permanently
      // showed zero rake and an unearned Bronze tier.
      const { data: periods } = await supabase
        .from('rakeback_periods')
        .select('rake_generated, rakeback_amount, rakeback_rate, status, period_start')
        .eq('user_id', user.id)
        .order('period_start', { ascending: false })
        .limit(200);

      const periodRows = periods || [];
      const totalRakeContributed =
        Math.round(periodRows.reduce((s, p) => s + (Number(p.rake_generated) || 0), 0) * 100) / 100;
      const pendingRakeback =
        Math.round(
          periodRows
            .filter((p) => p.status === 'pending')
            .reduce((s, p) => s + (Number(p.rakeback_amount) || 0), 0) * 100
        ) / 100;

      // Real payouts (actual wallet credits) — unchanged source, it was right.
      const { data: rakebackData } = await supabase
        .from('wallet_transactions')
        .select('amount, created_at')
        .eq('user_id', user.id)
        .eq('category', 'rakeback')
        .eq('type', 'credit')
        .order('created_at', { ascending: false })
        .limit(20);

      const totalRakebackEarned = (rakebackData || []).reduce((s, r) => s + (r.amount || 0), 0);
      if (!isMounted.current) return;
      setRecentPayouts(rakebackData || []);

      // Tier: the rate is decided PER WEEK by the server ladder against that
      // week's weighted rake. Show the current (most recent) week's position.
      const currentWeekRake = Number(periodRows[0]?.rake_generated) || 0;
      let currentTierIdx = 0;
      for (let i = TIERS.length - 1; i >= 0; i--) {
        if (currentWeekRake >= TIERS[i].minRake) {
          currentTierIdx = i;
          break;
        }
      }
      const currentTier = TIERS[currentTierIdx];
      const nextTier = currentTierIdx < TIERS.length - 1 ? TIERS[currentTierIdx + 1] : null;

      let tierProgress = 100;
      if (nextTier) {
        const range = nextTier.minRake - currentTier.minRake;
        const progress = currentWeekRake - currentTier.minRake;
        tierProgress = Math.min(100, Math.max(0, (progress / range) * 100));
      }

      // Raked hands played, from the settler-maintained per-club stats.
      const { data: statRows } = await supabase
        .from('player_stats')
        .select('hands_played')
        .eq('user_id', user.id);
      const handsPlayed = (statRows || []).reduce((s, r) => s + (Number(r.hands_played) || 0), 0);

      if (!isMounted.current) return;
      setStats({
        totalRakeContributed,
        totalRakebackEarned,
        pendingRakeback: Math.max(0, pendingRakeback),
        currentTier: currentTier.name,
        nextTier: nextTier?.name || null,
        tierProgress,
        handsPlayed,
      });
    } catch (err) {
      if (!isMounted.current) return;
      reportError(err, 'RakebackDashboard.Load_failed');
      toast.error('Failed to load rakeback data');
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  };

  const currentTierData = TIERS.find((t) => t.name === stats.currentTier) || TIERS[0];

  const sectionStyle = (idx: number): React.CSSProperties => ({
    opacity: visibleSections.has(idx) ? 1 : 0,
    transform: visibleSections.has(idx) ? 'translateY(0)' : 'translateY(10px)',
    transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
  });

  return (
    <div
      style={{
        padding: '16px',
        width: '100%',
        maxWidth: '600px',
        margin: '0 auto',
        paddingBottom: '100px',
        boxSizing: 'border-box',
        overflowX: 'hidden',
      }}
    >
      {/* Header */}
      {loading ? (
        <PageSkeleton variant="stats" />
      ) : (
        <>
          <div style={{ marginBottom: '24px', ...sectionStyle(0) }}>
            <button
              onClick={() => navigate(-1)}
              style={{
                background: 'none',
                border: 'none',
                color: '#3b82f6',
                cursor: 'pointer',
                fontSize: '0.85rem',
                padding: '10px 10px 10px 0',
                minHeight: '44px',
                touchAction: 'manipulation',
                marginBottom: '6px',
              }}
            >
              ← Back
            </button>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>Rakeback Dashboard</h1>
            <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
              Earn Cashback On Every Hand You Play
            </p>
          </div>

          {/* Current Tier */}
          <div
            style={{
              padding: '24px 20px',
              background: `linear-gradient(135deg, rgba(255,255,255,0.02), ${currentTierData.color}15)`,
              borderRadius: '16px',
              border: `1px solid ${currentTierData.color}40`,
              marginBottom: '16px',
              display: 'flex',
              alignItems: 'center',
              gap: '24px',
              ...sectionStyle(1),
            }}
          >
            {/* SVG Ring */}
            <div style={{ position: 'relative', width: '100px', height: '100px', flexShrink: 0 }}>
              <svg width="100" height="100" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="42"
                  fill="none"
                  stroke="rgba(255,255,255,0.06)"
                  strokeWidth="8"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="42"
                  fill="none"
                  stroke={currentTierData.color}
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 42}`}
                  strokeDashoffset={`${2 * Math.PI * 42 * (1 - stats.tierProgress / 100)}`}
                  style={{
                    transform: 'rotate(-90deg)',
                    transformOrigin: '50% 50%',
                    transition: 'stroke-dashoffset 1.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                />
              </svg>
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '2rem',
                }}
              >
                {currentTierData.icon}
              </div>
            </div>

            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: currentTierData.color }}>
                {stats.currentTier} Tier
              </div>
              <div
                style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px' }}
              >
                {currentTierData.percent}% Rakeback Rate
              </div>
              {stats.nextTier && (
                <div
                  style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', marginTop: '8px' }}
                >
                  <strong style={{ color: '#fff' }}>{stats.tierProgress.toFixed(1)}%</strong> To{' '}
                  {stats.nextTier}
                </div>
              )}
            </div>
          </div>

          {/* Stats Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '10px',
              marginBottom: '16px',
              ...sectionStyle(2),
            }}
          >
            {[
              {
                label: 'Total Rake',
                value: stats.totalRakeContributed.toLocaleString(),
                icon: '♠',
                color: '#f59e0b',
              },
              {
                label: 'Rakeback Earned',
                value: stats.totalRakebackEarned.toLocaleString(),
                icon: '◆',
                color: '#10b981',
              },
              {
                label: 'Pending',
                value: stats.pendingRakeback.toLocaleString(),
                icon: '◷',
                color: '#8b5cf6',
              },
              {
                label: 'Hands Played',
                value: stats.handsPlayed.toLocaleString(),
                icon: '◎',
                color: '#3b82f6',
              },
            ].map((s) => (
              <div
                key={s.label}
                style={{
                  padding: '12px',
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: 'rgba(255,255,255,0.4)',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    letterSpacing: '0.5px',
                  }}
                >
                  {s.icon} {s.label}
                </div>
                <div
                  style={{
                    fontSize: '1.2rem',
                    fontWeight: 800,
                    color: s.color,
                    fontFamily: 'monospace',
                    marginTop: '4px',
                  }}
                >
                  {s.value}
                </div>
              </div>
            ))}
          </div>

          {/* Tier Breakdown */}
          <div
            style={{
              padding: '16px',
              background: 'rgba(255,255,255,0.03)',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.06)',
              marginBottom: '16px',
              ...sectionStyle(3),
            }}
          >
            <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '10px' }}>
              All Tiers
            </div>
            {TIERS.map((tier) => (
              <div
                key={tier.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '6px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                }}
              >
                <span style={{ fontSize: '1rem' }}>{tier.icon}</span>
                <span
                  style={{
                    flex: 1,
                    fontSize: '0.8rem',
                    fontWeight: stats.currentTier === tier.name ? 700 : 400,
                    color: stats.currentTier === tier.name ? tier.color : 'rgba(255,255,255,0.5)',
                  }}
                >
                  {tier.name}
                </span>
                <span
                  style={{
                    fontSize: '0.7rem',
                    color: 'rgba(255,255,255,0.4)',
                    fontFamily: 'monospace',
                  }}
                >
                  {tier.minRake.toLocaleString()} Rake
                </span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: tier.color }}>
                  {tier.percent}%
                </span>
              </div>
            ))}
          </div>

          {/* Recent Payouts Graph */}
          <div
            style={{
              padding: '20px 16px',
              background: 'rgba(255,255,255,0.02)',
              borderRadius: '16px',
              border: '1px solid rgba(255,255,255,0.06)',
              ...sectionStyle(4),
            }}
          >
            <div
              style={{
                fontSize: '0.9rem',
                fontWeight: 700,
                marginBottom: '20px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>Payout History</span>
              <span
                style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', fontWeight: 500 }}
              >
                Last 20 Payouts
              </span>
            </div>

            {recentPayouts.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '40px 20px',
                  color: 'rgba(255,255,255,0.3)',
                  fontSize: '0.85rem',
                }}
              >
                No Payout History Found
              </div>
            ) : (
              <div style={{ width: '100%', height: '180px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={[...recentPayouts].reverse().map((p) => ({
                      date: new Date(p.created_at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      }),
                      amount: p.amount,
                    }))}
                  >
                    <defs>
                      <linearGradient id="colorAmount" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="date"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                      minTickGap={20}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'rgba(15,23,42,0.9)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        fontSize: '0.8rem',
                      }}
                      itemStyle={{ color: '#10b981', fontWeight: 700 }}
                      labelStyle={{ color: 'rgba(255,255,255,0.6)', marginBottom: '4px' }}
                      formatter={(val) => [`${Number(val || 0).toLocaleString()} chips`, 'Payout']}
                    />
                    <Area
                      type="monotone"
                      dataKey="amount"
                      stroke="#10b981"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#colorAmount)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

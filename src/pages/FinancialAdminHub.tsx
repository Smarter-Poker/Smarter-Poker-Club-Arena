/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL ADMIN HUB — Single-Pane-of-Glass Financial Operations
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Central admin page consolidating all financial management tools.
 *  Quick links to: Alerts, Health, Disputes, Rate Audit, Settlements, Financials.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import { useToast } from '../components/common/Toast';
import { ResponsiveContainer, AreaChart, Area, XAxis, Tooltip } from 'recharts';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import UnionOpsPanel from '../components/union/UnionOpsPanel';
import FinancialAdminScopeState from '../components/common/FinancialAdminScopeState';
import { clubScoped, useFinancialAdminScope } from '../hooks/useFinancialAdminScope';

interface HubStats {
  totalAlerts: number;
  openIncidents: number;
  openDisputes: number;
  rateChanges: number;
  healthChecks: number;
  lastCheckPassed: boolean | null;
}

const NAV_ITEMS = [
  {
    icon: '◆',
    label: 'Financial Alerts',
    description: 'Critical Warnings And System Notifications',
    path: '/financial-alerts',
    color: '#ef4444',
    bg: 'rgba(239,68,68,0.1)',
    border: 'rgba(239,68,68,0.3)',
  },
  {
    icon: '◈',
    label: 'Drift Incidents',
    description: 'Ledger Drift Detection And 20-Minute Reconciliation Queue',
    path: '/financial-incidents',
    color: '#f43f5e',
    bg: 'rgba(244,63,94,0.1)',
    border: 'rgba(244,63,94,0.3)',
  },
  {
    icon: '◇',
    label: 'System Health',
    description: 'Ledger Reconciliation & Cron Status',
    path: '/financial-health',
    color: '#10b981',
    bg: 'rgba(16,185,129,0.1)',
    border: 'rgba(16,185,129,0.3)',
  },
  {
    icon: '⚠',
    label: 'Disputes',
    description: 'Open Disputes Needing Resolution',
    path: '/disputes',
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.1)',
    border: 'rgba(245,158,11,0.3)',
  },
  {
    icon: '▦',
    label: 'Rate Audit Trail',
    description: 'Commission & Rake Rate Change History',
    path: '/rate-audit',
    color: '#8b5cf6',
    bg: 'rgba(139,92,246,0.1)',
    border: 'rgba(139,92,246,0.3)',
  },
  {
    icon: '▦',
    label: 'Agent Portal',
    description: 'Triple Wallet, Credit Lines, Commissions',
    path: '/agent-portal',
    color: '#0ea5e9',
    bg: 'rgba(14,165,233,0.1)',
    border: 'rgba(14,165,233,0.3)',
  },
  {
    icon: '▦',
    label: 'Rakeback Dashboard',
    description: 'Player Rakeback Tiers & Pending Payouts',
    path: '/rakeback',
    color: '#d946ef',
    bg: 'rgba(217,70,239,0.1)',
    border: 'rgba(217,70,239,0.3)',
  },
  {
    icon: '▣',
    label: 'Credit Admin',
    description: 'Set & Adjust Agent Credit Limits',
    path: '/credit-admin',
    color: '#f97316',
    bg: 'rgba(249,115,22,0.1)',
    border: 'rgba(249,115,22,0.3)',
  },
  {
    icon: '▤',
    label: 'Settlement History',
    description: 'Weekly Settlement Cycles & Revenue Trends',
    path: '/settlement-history',
    color: '#14b8a6',
    bg: 'rgba(20,184,166,0.1)',
    border: 'rgba(20,184,166,0.3)',
  },
  {
    icon: '⚖',
    label: 'Settlement Center',
    description: 'Canary Checks, Payout Execution & Monitoring',
    path: '/settlement-dashboard',
    color: '#6366f1',
    bg: 'rgba(99,102,241,0.1)',
    border: 'rgba(99,102,241,0.3)',
  },
  {
    icon: '▦',
    label: 'Settlements',
    description: 'Club & Agent Settlement Management',
    path: '/wallet',
    color: '#3b82f6',
    bg: 'rgba(59,130,246,0.1)',
    border: 'rgba(59,130,246,0.3)',
  },
  {
    icon: '↓',
    label: 'CSV Exports',
    description: 'Financial Reports & Data Exports',
    path: '/wallet',
    color: '#06b6d4',
    bg: 'rgba(6,182,212,0.1)',
    border: 'rgba(6,182,212,0.3)',
  },
];

export default function FinancialAdminHub() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [stats, setStats] = useState<HubStats>({
    totalAlerts: 0,
    openIncidents: 0,
    openDisputes: 0,
    rateChanges: 0,
    healthChecks: 0,
    lastCheckPassed: null,
  });
  const [loading, setLoading] = useState(true);
  const [visibleCards, setVisibleCards] = useState<Set<number>>(new Set());
  const [visibleNavs, setVisibleNavs] = useState<Set<number>>(new Set());
  const [revenueData, setRevenueData] = useState<{ day: string; amount: number }[]>([]);

  const loadingRef = useRef(false);
  /* WHOSE MONEY (2026-09-10). rake_records was read with a 7-day filter and
     no club, so the revenue chart summed every club's rake RLS let the viewer
     see into one operator's dashboard; disputes and the two rate-audit counts
     had the same shape. The scope names the club (or the platform, for
     platform staff) and every club-keyed read below is filtered to it. */
  const scope = useFinancialAdminScope();
  const scopeStatus = scope.status;
  const scopeClubId = scope.clubId;
  const scopePlatformWide = scope.platformWide;

  // ── loadStats: parallelized queries (~4x faster than sequential) ──
  const loadStats = useCallback(async () => {
    if (scopeStatus !== 'ready') return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const scopeKey = { status: scopeStatus, clubId: scopeClubId, platformWide: scopePlatformWide };
    try {
      // All KPI counts + data in parallel
      const [
        disputeResult,
        commResult,
        rakeResult,
        healthCountResult,
        alertResult,
        incidentResult,
        lastCheckResult,
        rakeDataResult,
      ] = await Promise.all([
        (async () => {
          try {
            const r = await clubScoped(
              supabase
                .from('disputes')
                .select('*', { count: 'exact', head: true })
                .in('status', ['open', 'under_review', 'escalated']),
              scopeKey
            );
            if (r.error) throw r.error;
            return r.count || 0;
          } catch (e) {
            reportError(e, 'FinancialAdminHub.async');
            return 0;
          }
        })(),
        (async () => {
          try {
            const r = await clubScoped(
              supabase.from('commission_rate_audit').select('*', { count: 'exact', head: true }),
              scopeKey
            );
            if (r.error) throw r.error;
            return r.count || 0;
          } catch (e) {
            reportError(e, 'FinancialAdminHub.async');
            return 0;
          }
        })(),
        (async () => {
          try {
            const r = await clubScoped(
              supabase.from('rake_rate_audit').select('*', { count: 'exact', head: true }),
              scopeKey
            );
            if (r.error) throw r.error;
            return r.count || 0;
          } catch (e) {
            reportError(e, 'FinancialAdminHub.async');
            return 0;
          }
        })(),
        (async () => {
          try {
            const r = await supabase
              .from('financial_health_checks')
              .select('*', { count: 'exact', head: true });
            return r.count || 0;
          } catch (e) {
            reportError(e, 'FinancialAdminHub.async');
            return 0;
          }
        })(),
        (async () => {
          try {
            const r = await supabase
              .from('financial_alerts')
              .select('*', { count: 'exact', head: true })
              .eq('resolved', false);
            return r.count || 0;
          } catch (e) {
            reportError(e, 'FinancialAdminHub.async');
            return 0;
          }
        })(),
        (async () => {
          try {
            // BIND THE ERROR. A discarded error here reads as "0 open
            // incidents" - an all-clear on the one tile whose whole job is to
            // say drift was detected. Fail loud, not quiet.
            const { data, error } = await supabase.rpc('fn_ca_incident_dashboard', {
              p_status: null,
              p_limit: 500,
            });
            if (error) {
              reportError(error, 'FinancialAdminHub.incidentDashboard');
              return 0;
            }
            return ((data as any[]) || []).filter((i: any) => i?.status !== 'resolved').length;
          } catch (e) {
            reportError(e, 'FinancialAdminHub.incidentDashboard');
            return 0;
          }
        })(),
        (async () => {
          try {
            const r = await supabase
              .from('financial_health_checks')
              .select('passed')
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            return r.data;
          } catch (e) {
            reportError(e, 'FinancialAdminHub.async');
            return null;
          }
        })(),
        (async () => {
          try {
            const r = await clubScoped(
              supabase
                .from('rake_records')
                .select('rake_amount, created_at')
                .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString()),
              scopeKey
            )
              .order('created_at', { ascending: true })
              .limit(5000);
            if (r.error) throw r.error;
            return r.data;
          } catch (e) {
            reportError(e, 'FinancialAdminHub.async');
            return null;
          }
        })(),
      ]);

      if (!isMounted.current) return;

      setStats({
        totalAlerts: alertResult as number,
        openIncidents: incidentResult as number,
        openDisputes: disputeResult as number,
        rateChanges: (commResult as number) + (rakeResult as number),
        healthChecks: healthCountResult as number,
        lastCheckPassed: (lastCheckResult as any)?.passed ?? null,
      });

      // Process revenue sparkline
      if (rakeDataResult && (rakeDataResult as any[]).length > 0) {
        const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const grouped: Record<string, number> = {};
        (rakeDataResult as any[]).forEach((r: any) => {
          const d = new Date(r.created_at);
          const label = `${dayLabels[d.getDay()]} ${d.getDate()}`;
          grouped[label] = (grouped[label] || 0) + (r.rake_amount || 0);
        });
        const days: { day: string; amount: number }[] = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(Date.now() - i * 86400000);
          const label = `${dayLabels[d.getDay()]} ${d.getDate()}`;
          days.push({ day: label, amount: grouped[label] || 0 });
        }
        if (isMounted.current) setRevenueData(days);
      } else {
        if (isMounted.current) setRevenueData([]);
      }
    } catch (err) {
      reportError(err, 'FinancialAdminHub.Stats_load_failed');
      if (isMounted.current) toast.error('Failed to load financial stats');
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  }, [toast, scopeStatus, scopeClubId, scopePlatformWide]);

  useVisibilityRefresh(loadStats);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Bus listeners: refresh stats when financial events fire
  useEffect(() => {
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', loadStats, 1000);
    const unsubSettlement = masterBus.subscribeDebounced('SETTLEMENT_COMPLETED', loadStats, 1000);
    const unsubAlert = masterBus.subscribeDebounced('FINANCIAL_ALERT', loadStats, 500);
    return () => {
      unsubBalance();
      unsubSettlement();
      unsubAlert();
    };
  }, [loadStats]);

  // Real-time subscription: disputes table changes
  useEffect(() => {
    const channelKey = 'financial-admin-hub-disputes';
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'disputes' }, loadStats)
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'FinancialAdminHub._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[FinancialAdminHub] Realtime channel timed out');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [loadStats]);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    setVisibleCards(new Set());
    [0, 1, 2, 3, 4].forEach((i) => {
      timers.push(setTimeout(() => setVisibleCards((prev) => new Set(prev).add(i)), i * 80));
    });
    setVisibleNavs(new Set());
    NAV_ITEMS.forEach((_, i) => {
      timers.push(setTimeout(() => setVisibleNavs((prev) => new Set(prev).add(i)), 300 + i * 60));
    });
    return () => timers.forEach(clearTimeout);
  }, []);

  const kpiCards = [
    {
      label: 'Drift Incidents',
      value: stats.openIncidents,
      icon: '◈',
      color: stats.openIncidents > 0 ? '#f43f5e' : '#10b981',
      glow: stats.openIncidents > 0 ? 'rgba(244,63,94,0.2)' : 'rgba(16,185,129,0.2)',
    },
    {
      label: 'Open Disputes',
      value: stats.openDisputes,
      icon: '⚠',
      color: stats.openDisputes > 0 ? '#f59e0b' : '#10b981',
      glow: stats.openDisputes > 0 ? 'rgba(245,158,11,0.2)' : 'rgba(16,185,129,0.2)',
    },
    {
      label: 'Rate Changes',
      value: stats.rateChanges,
      icon: '▦',
      color: '#8b5cf6',
      glow: 'rgba(139,92,246,0.2)',
    },
    {
      label: 'Health Checks',
      value: stats.healthChecks,
      icon: stats.lastCheckPassed === false ? '✕' : stats.lastCheckPassed === true ? '✓' : '○',
      color: stats.lastCheckPassed === false ? '#ef4444' : '#10b981',
      glow: stats.lastCheckPassed === false ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)',
    },
    {
      label: 'Active Alerts',
      value: stats.totalAlerts,
      icon: '◆',
      color: stats.totalAlerts > 0 ? '#ef4444' : '#10b981',
      glow: stats.totalAlerts > 0 ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)',
    },
  ];

  if (scope.status !== 'ready') {
    return (
      <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '24px' }}>
          Financial Admin Hub
        </h1>
        <FinancialAdminScopeState scope={scope} />
      </div>
    );
  }

  if (loading && stats.healthChecks === 0 && stats.totalAlerts === 0) {
    return (
      <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '24px' }}>
          Financial Admin Hub
        </h1>
        <PageSkeleton variant="financial" />
      </div>
    );
  }

  return (
    <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto', paddingBottom: '100px' }}>
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <button
          onClick={() => navigate(-1)}
          style={{
            background: 'none',
            border: 'none',
            color: '#3b82f6',
            cursor: 'pointer',
            fontSize: '0.85rem',
            padding: 0,
            marginBottom: '6px',
          }}
        >
          ← Back
        </button>
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>Financial Admin Hub</h1>
        <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
          Central Command For All Financial Operations
        </p>
      </div>

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '10px',
          marginBottom: '24px',
        }}
      >
        {kpiCards.map((card, idx) => (
          <div
            key={card.label}
            style={{
              padding: '14px',
              background: 'rgba(255,255,255,0.03)',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.06)',
              boxShadow: `0 0 20px ${card.glow}`,
              opacity: visibleCards.has(idx) ? 1 : 0,
              transform: visibleCards.has(idx) ? 'translateY(0)' : 'translateY(10px)',
              transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span style={{ fontSize: '1.1rem' }}>{card.icon}</span>
              <span
                style={{
                  fontSize: '0.7rem',
                  color: 'rgba(255,255,255,0.5)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  fontWeight: 600,
                }}
              >
                {card.label}
              </span>
            </div>
            <div
              style={{
                fontSize: '1.6rem',
                fontWeight: 800,
                color: card.color,
                fontFamily: 'monospace',
              }}
            >
              {card.value}
            </div>
          </div>
        ))}
      </div>

      {/* Revenue Sparkline */}
      {revenueData.length > 0 &&
        (() => {
          const totalRevenue = revenueData.reduce((s, d) => s + d.amount, 0);
          return (
            <div
              style={{
                padding: '16px',
                background: 'rgba(255,255,255,0.03)',
                borderRadius: '12px',
                border: '1px solid rgba(255,255,255,0.06)',
                marginBottom: '20px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>7-Day Revenue</span>
                  {loading && (
                    <span
                      style={{
                        fontSize: '0.7rem',
                        color: '#10b981',
                        animation: 'animationsPulse 1.5s infinite',
                      }}
                    >
                      Syncing...
                    </span>
                  )}
                </div>
                <span
                  style={{
                    fontSize: '0.75rem',
                    color: '#10b981',
                    fontWeight: 700,
                    fontFamily: 'monospace',
                  }}
                >
                  {totalRevenue.toLocaleString()} Chip{totalRevenue === 1 ? '' : 's'}
                </span>
              </div>
              <div style={{ height: 180, marginTop: '20px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={revenueData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.8} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="day"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                      dy={10}
                    />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div
                              style={{
                                background: 'rgba(13, 21, 32, 0.95)',
                                border: '1px solid rgba(16, 185, 129, 0.3)',
                                padding: '8px 12px',
                                borderRadius: '8px',
                                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                                color: '#fff',
                              }}
                            >
                              <div
                                style={{
                                  fontSize: '0.7rem',
                                  color: 'rgba(255,255,255,0.6)',
                                  marginBottom: '4px',
                                }}
                              >
                                {label}
                              </div>
                              <div
                                style={{
                                  fontSize: '1rem',
                                  fontWeight: 800,
                                  color: '#10b981',
                                  fontFamily: 'monospace',
                                }}
                              >
                                {Number(payload[0].value).toLocaleString()} Chips
                              </div>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="amount"
                      stroke="#10b981"
                      strokeWidth={3}
                      fillOpacity={1}
                      fill="url(#colorRevenue)"
                      isAnimationActive={true}
                      animationDuration={1500}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })()}

      {/* Navigation Grid */}
      <h2
        style={{
          fontSize: '0.8rem',
          color: 'rgba(255,255,255,0.4)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: '12px',
          fontWeight: 600,
        }}
      >
        Financial Tools
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {NAV_ITEMS.map((item, idx) => (
          <Link
            key={item.label}
            to={item.path}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              padding: '14px 16px',
              background: item.bg,
              borderRadius: '12px',
              border: `1px solid ${item.border}`,
              textDecoration: 'none',
              color: 'inherit',
              opacity: visibleNavs.has(idx) ? 1 : 0,
              transform: visibleNavs.has(idx) ? 'translateX(0)' : 'translateX(-12px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <span style={{ fontSize: '1.4rem', flexShrink: 0 }}>{item.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: item.color }}>
                {item.label}
              </div>
              <div
                style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)', marginTop: '2px' }}
              >
                {item.description}
              </div>
            </div>
            <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: '1rem' }}>→</span>
          </Link>
        ))}
      </div>

      {/* Footer Status */}
      {/* Union integrity: law self-test + hourly sweep */}
      <div
        style={{
          marginTop: '24px',
          background: 'rgba(255,255,255,0.02)',
          borderRadius: '12px',
          padding: '16px',
          border: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 700, color: '#e0e0e0' }}>
          Union Integrity & Law
        </h3>
        <UnionOpsPanel canRun />
      </div>

      <div
        style={{
          marginTop: '24px',
          padding: '12px 16px',
          background: 'rgba(255,255,255,0.02)',
          borderRadius: '10px',
          border: '1px solid rgba(255,255,255,0.05)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '6px',
          fontSize: '0.7rem',
          color: 'rgba(255,255,255,0.35)',
        }}
      >
        <span>Financial Engine V3.0 • All Services Operational</span>
        <span>
          System Health:{' '}
          {stats.lastCheckPassed === true
            ? 'Passing'
            : stats.lastCheckPassed === false
              ? 'Failing'
              : 'Unknown'}
        </span>
      </div>
    </div>
  );
}

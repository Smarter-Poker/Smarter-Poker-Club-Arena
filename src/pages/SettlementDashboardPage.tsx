/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTLEMENT DASHBOARD PAGE — Admin Settlement Cycle Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Central command for monitoring and managing settlement cycles:
 *  - Current period status with countdown to next snapshot/payout
 *  - Agent payout status table with per-agent breakdown
 *  - Canary check + manual settlement trigger for admins
 *  - Period history with expandable details
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { SettlementService } from '../services/SettlementService';
import { SettlementCronService, type CanaryResult } from '../services/SettlementCronService';
import PageSkeleton from '../components/common/PageSkeleton';

import { useIsMounted } from '../hooks/useIsMounted';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface PeriodInfo {
  id: string;
  start: string;
  end: string;
  status: string;
}

interface AgentPayout {
  id: string;
  agentId: string;
  agentName: string;
  netSettlement: number;
  commissionEarned: number;
  status: string;
  updatedAt: string;
}

interface PeriodHistoryItem {
  id: string;
  start: string;
  end: string;
  status: string;
  totalDisbursed: number;
  agentsPaid: number;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOOKS & COMPONENTS FOR SVG RING
// ═══════════════════════════════════════════════════════════════════════════════

function useCountdown(targetDate: string | null) {
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0, total: 0 });

  useEffect(() => {
    if (!targetDate) return;
    const interval = setInterval(() => {
      const difference = new Date(targetDate).getTime() - new Date().getTime();
      if (difference <= 0) {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0, total: 0 });
        clearInterval(interval);
      } else {
        setTimeLeft({
          days: Math.floor(difference / (1000 * 60 * 60 * 24)),
          hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
          minutes: Math.floor((difference / 1000 / 60) % 60),
          seconds: Math.floor((difference / 1000) % 60),
          total: difference,
        });
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [targetDate]);

  return timeLeft;
}

function CountdownRing({ start, end }: { start: string; end: string }) {
  const timeLeft = useCountdown(end);
  const totalDuration = new Date(end).getTime() - new Date(start).getTime();
  const progress = totalDuration > 0 ? timeLeft.total / totalDuration : 0;

  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - progress * circumference;

  return (
    <div
      style={{
        position: 'relative',
        width: 72,
        height: 72,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width="72" height="72" viewBox="0 0 72 72" style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx="36"
          cy="36"
          r={radius}
          fill="transparent"
          stroke="rgba(255,255,255,0.05)"
          strokeWidth="6"
        />
        <circle
          cx="36"
          cy="36"
          r={radius}
          fill="transparent"
          stroke="url(#countdownGradient)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{ transition: 'stroke-dashoffset 1s linear' }}
        />
        <defs>
          <linearGradient id="countdownGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#00d4ff" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>
      </svg>
      <div
        style={{
          position: 'absolute',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <span
          style={{ fontSize: '0.8rem', fontWeight: 800, color: '#fff', fontFamily: 'monospace' }}
        >
          {timeLeft.days > 0
            ? `${timeLeft.days}d`
            : `${String(timeLeft.hours).padStart(2, '0')}:${String(timeLeft.minutes).padStart(2, '0')}`}
        </span>
      </div>
    </div>
  );
}

interface PeriodInfo {
  id: string;
  start: string;
  end: string;
  status: string;
}

interface AgentPayout {
  id: string;
  agentId: string;
  agentName: string;
  netSettlement: number;
  commissionEarned: number;
  status: string;
  updatedAt: string;
}

interface PeriodHistoryItem {
  id: string;
  start: string;
  end: string;
  status: string;
  totalDisbursed: number;
  agentsPaid: number;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function SettlementDashboardPage() {
  const navigate = useNavigate();
  useAuthUser(); // Ensures user is authenticated (admin page)
  const toast = useToast();
  const isMounted = useIsMounted();

  const [currentPeriod, setCurrentPeriod] = useState<PeriodInfo | null>(null);
  const [agentPayouts, setAgentPayouts] = useState<AgentPayout[]>([]);
  const [periodHistory, setPeriodHistory] = useState<PeriodHistoryItem[]>([]);
  const [canaryResult, setCanaryResult] = useState<CanaryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningCanary, setRunningCanary] = useState(false);
  const [runningSettlement, setRunningSettlement] = useState(false);
  const [expandedPeriodId, setExpandedPeriodId] = useState<string | null>(null);
  const [visibleCards, setVisibleCards] = useState<Set<number>>(new Set());
  const [visibleRows, setVisibleRows] = useState<Set<number>>(new Set());

  const loadingRef = useRef(false);

  const loadData = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    let loadedPeriodId: string | null = null;
    try {
      // Load current period
      try {
        const period = await SettlementService.getCurrentPeriod();
        if (isMounted.current && period) {
          loadedPeriodId = period.id;
          setCurrentPeriod({
            id: period.id,
            start: period.startAt,
            end: period.endAt,
            status: period.status,
          });
        }
      } catch {
        /* period may not exist */
      }

      // Load agent settlements — scoped to current period via local variable
      // (cannot use state here; setCurrentPeriod is async and hasn't applied yet)
      try {
        let query = supabase
          .from('agent_settlements')
          .select('id, agent_id, period_id, net_settlement, commission_earned, status, updated_at')
          .order('net_settlement', { ascending: false })
          .limit(100);

        if (loadedPeriodId) {
          query = query.eq('period_id', loadedPeriodId);
        }

        const { data: settlements } = await query;

        if (isMounted.current && settlements) {
          setAgentPayouts(
            settlements.map((s: any) => ({
              id: s.id,
              agentId: s.agent_id,
              agentName: `Agent ${s.agent_id?.slice(0, 8)}...`,
              netSettlement: s.net_settlement || 0,
              commissionEarned: s.commission_earned || 0,
              status: s.status || 'pending',
              updatedAt: s.updated_at || '',
            }))
          );
        }
      } catch {
        /* table may not exist */
      }

      // Load period history
      try {
        const history = await SettlementService.getPeriodHistory(8);
        if (isMounted.current) {
          setPeriodHistory(
            (history || []).map((p: any) => ({
              id: p.id,
              start: p.startAt || (p as any).period_start || (p as any).start_at,
              end: p.endAt || (p as any).period_end || (p as any).end_at,
              status: p.status,
              totalDisbursed: (p as any).totalDisbursed || (p as any).total_disbursed || 0,
              agentsPaid: (p as any).agentsPaid || (p as any).agents_paid || 0,
              createdAt: (p as any).createdAt || (p as any).created_at || '',
            }))
          );
        }
      } catch {
        /* service method may not return expected shape */
      }
    } catch (err) {
      console.error('[Settlement] Load failed:', err);
      if (isMounted.current) toast.error('Failed to load settlement data');
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useVisibilityRefresh(() => loadData());

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Bus listeners: settlement events
  useEffect(() => {
    const unsub1 = masterBus.subscribeDebounced('SETTLEMENT_COMPLETED', () => loadData(), 500);
    const unsub2 = masterBus.subscribeDebounced('SETTLEMENT_CYCLE_STARTED', () => loadData(), 500);
    const unsub3 = masterBus.subscribeDebounced(
      'SETTLEMENT_CYCLE_COMPLETED',
      () => loadData(),
      500
    );
    const unsub4 = masterBus.subscribeDebounced('SETTLEMENT_PAYOUT_FAILED', () => loadData(), 500);
    const unsub5 = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadData(), 2000);
    return () => {
      unsub1();
      unsub2();
      unsub3();
      unsub4();
      unsub5();
    };
  }, [loadData]);

  // Real-time subscription on agent_settlements
  useEffect(() => {
    const channelKey = 'settlement-dashboard-rt';
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_settlements' }, () =>
        loadData()
      )
      .subscribe();
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [loadData]);

  // Stagger animations
  useEffect(() => {
    setVisibleCards(new Set());
    const timers = [0, 1, 2, 3].map((i) =>
      setTimeout(() => setVisibleCards((prev) => new Set(prev).add(i)), i * 80)
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    setVisibleRows(new Set());
    const timers = agentPayouts.map((_, i) =>
      setTimeout(() => setVisibleRows((prev) => new Set(prev).add(i)), i * 40)
    );
    return () => timers.forEach(clearTimeout);
  }, [agentPayouts.length]);

  // ─── Actions ────────────────────────────────────────────────────────────────

  const handleRunCanary = async () => {
    setRunningCanary(true);
    try {
      const result = await SettlementCronService.runCanaryCheck();
      if (!isMounted.current) return;
      setCanaryResult(result);
      if (result.passed) {
        toast.success(
          `Canary check passed! Difference: ${result.difference.toLocaleString()} chips`
        );
      } else {
        toast.error(
          `Canary check FAILED — Difference: ${result.difference.toLocaleString()} chips`
        );
      }
    } catch (err) {
      if (!isMounted.current) return;
      toast.error('Canary check failed to execute');
      console.error('[Settlement] Canary check error:', err);
    }
    if (isMounted.current) setRunningCanary(false);
  };

  const handleTriggerSettlement = async () => {
    if (!currentPeriod?.id) {
      toast.error('No active settlement period');
      return;
    }
    setRunningSettlement(true);
    try {
      const result = await SettlementService.executeMondayPayouts(currentPeriod.id);
      if (!isMounted.current) return;
      toast.success(
        `Settlement processed: ${result.agentsPaid} agents paid, ${result.totalDisbursed.toLocaleString()} chips disbursed`
      );
      loadData();
    } catch (err) {
      if (!isMounted.current) return;
      toast.error('Settlement execution failed');
      console.error('[Settlement] Execution error:', err);
    }
    if (isMounted.current) setRunningSettlement(false);
  };

  // ─── Helpers ────────────────────────────────────────────────────────────────

  const formatDate = (iso: string): string => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatDateTime = (iso: string): string => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusColor = (status: string) => {
    const map: Record<string, { bg: string; text: string; border: string; shadow: string }> = {
      open: {
        bg: 'rgba(16,185,129,0.1)',
        text: '#10b981',
        border: 'rgba(16,185,129,0.4)',
        shadow: '0 0 10px rgba(16,185,129,0.2)',
      },
      closed: {
        bg: 'rgba(245,158,11,0.1)',
        text: '#f59e0b',
        border: 'rgba(245,158,11,0.4)',
        shadow: '0 0 10px rgba(245,158,11,0.2)',
      },
      processing: {
        bg: 'rgba(59,130,246,0.1)',
        text: '#3b82f6',
        border: 'rgba(59,130,246,0.4)',
        shadow: '0 0 10px rgba(59,130,246,0.2)',
      },
      completed: {
        bg: 'rgba(139,92,246,0.1)',
        text: '#00d4ff',
        border: 'rgba(0,212,255,0.4)',
        shadow: '0 0 10px rgba(0,212,255,0.2)',
      },
      settled: {
        bg: 'rgba(139,92,246,0.1)',
        text: '#8b5cf6',
        border: 'rgba(139,92,246,0.4)',
        shadow: '0 0 10px rgba(139,92,246,0.2)',
      },
      approved: {
        bg: 'rgba(16,185,129,0.1)',
        text: '#10b981',
        border: 'rgba(16,185,129,0.4)',
        shadow: '0 0 10px rgba(16,185,129,0.2)',
      },
      paid: {
        bg: 'rgba(139,92,246,0.1)',
        text: '#8b5cf6',
        border: 'rgba(139,92,246,0.4)',
        shadow: '0 0 10px rgba(139,92,246,0.2)',
      },
      failed: {
        bg: 'rgba(239,68,68,0.1)',
        text: '#ef4444',
        border: 'rgba(239,68,68,0.4)',
        shadow: '0 0 10px rgba(239,68,68,0.2)',
      },
      pending: {
        bg: 'rgba(107,114,128,0.1)',
        text: '#9ca3af',
        border: 'rgba(107,114,128,0.4)',
        shadow: 'none',
      },
      partial: {
        bg: 'rgba(245,158,11,0.1)',
        text: '#f59e0b',
        border: 'rgba(245,158,11,0.4)',
        shadow: '0 0 10px rgba(245,158,11,0.2)',
      },
    };
    return map[status] || map.pending;
  };

  const totalDisbursed = agentPayouts
    .filter((a) => a.status === 'paid')
    .reduce((sum, a) => sum + a.netSettlement, 0);
  const agentsPaid = agentPayouts.filter((a) => a.status === 'paid').length;
  const failedCount = agentPayouts.filter(
    (a) => a.status === 'failed' || a.status === 'processing'
  ).length;

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading && !currentPeriod) {
    return (
      <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>⚖️ Settlement Center</h1>
        <PageSkeleton variant="financial" />
      </div>
    );
  }

  return (
    <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto', paddingBottom: '100px' }}>
      {/* Header */}
      <div style={{ marginBottom: '20px' }}>
        <button
          onClick={() => navigate(-1)}
          style={{
            background: 'none',
            border: 'none',
            color: '#3b82f6',
            cursor: 'pointer',
            fontSize: '0.85rem',
            padding: 0,
            marginBottom: '4px',
          }}
        >
          ← Back
        </button>
        <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>⚖️ Settlement Center</h1>
        <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
          Weekly settlement cycle monitoring and execution
        </p>
      </div>

      {/* Current Period Card */}
      {currentPeriod && (
        <div
          style={{
            padding: '16px 20px',
            background:
              'linear-gradient(145deg, rgba(20, 30, 48, 0.7) 0%, rgba(36, 59, 85, 0.4) 100%)',
            borderRadius: '16px',
            border: '1px solid rgba(0, 212, 255, 0.15)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
            marginBottom: '20px',
            position: 'relative',
            overflow: 'hidden',
            opacity: visibleCards.has(0) ? 1 : 0,
            transform: visibleCards.has(0) ? 'translateY(0)' : 'translateY(10px)',
            transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          {/* Decorative glow */}
          <div
            style={{
              position: 'absolute',
              top: '-50%',
              right: '-10%',
              width: 200,
              height: 200,
              background: 'radial-gradient(circle, rgba(0,212,255,0.1) 0%, transparent 70%)',
              borderRadius: '50%',
              pointerEvents: 'none',
            }}
          />

          <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
          >
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  marginBottom: '12px',
                }}
              >
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: '#00d4ff',
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    fontWeight: 700,
                  }}
                >
                  Current Period
                </div>
                <span
                  style={{
                    padding: '4px 12px',
                    borderRadius: '20px',
                    fontSize: '0.7rem',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    ...(() => {
                      const s = getStatusColor(currentPeriod.status);
                      return {
                        background: s.bg,
                        color: s.text,
                        border: `1px solid ${s.border}`,
                        boxShadow: s.shadow,
                      };
                    })(),
                  }}
                >
                  {currentPeriod.status}
                </span>
              </div>
              <div
                style={{
                  fontSize: '1.2rem',
                  fontWeight: 800,
                  marginBottom: '4px',
                  letterSpacing: '0.5px',
                }}
              >
                {formatDate(currentPeriod.start)}{' '}
                <span style={{ color: 'rgba(255,255,255,0.3)', margin: '0 6px' }}>→</span>{' '}
                {formatDate(currentPeriod.end)}
              </div>
              <div style={{ fontSize: '0.75rem', color: '#5a6a7a', fontFamily: 'monospace' }}>
                PID: {currentPeriod.id.split('-')[0]}...
              </div>
            </div>

            {/* SVG Countdown Ring */}
            {currentPeriod.status !== 'completed' && currentPeriod.status !== 'closed' && (
              <CountdownRing start={currentPeriod.start} end={currentPeriod.end} />
            )}
          </div>
        </div>
      )}

      {/* KPI Row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '10px',
          marginBottom: '20px',
        }}
      >
        {[
          {
            label: 'Total Disbursed',
            value: totalDisbursed.toLocaleString(),
            icon: '💰',
            color: '#10b981',
            glow: 'rgba(16,185,129,0.2)',
          },
          {
            label: 'Agents Paid',
            value: String(agentsPaid),
            icon: '👥',
            color: '#3b82f6',
            glow: 'rgba(59,130,246,0.2)',
          },
          {
            label: 'Failed/Stuck',
            value: String(failedCount),
            icon: failedCount > 0 ? '🔴' : '🟢',
            color: failedCount > 0 ? '#ef4444' : '#10b981',
            glow: failedCount > 0 ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)',
          },
          {
            label: 'Canary',
            value: canaryResult ? (canaryResult.passed ? 'PASS' : 'FAIL') : '—',
            icon: canaryResult?.passed === false ? '🔴' : canaryResult?.passed ? '🟢' : '⚪',
            color:
              canaryResult?.passed === false
                ? '#ef4444'
                : canaryResult?.passed
                  ? '#10b981'
                  : '#6b7280',
            glow: canaryResult?.passed === false ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)',
          },
        ].map((kpi, idx) => (
          <div
            key={kpi.label}
            style={{
              padding: '14px',
              background: 'rgba(255,255,255,0.03)',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.06)',
              boxShadow: `0 0 20px ${kpi.glow}`,
              opacity: visibleCards.has(idx) ? 1 : 0,
              transform: visibleCards.has(idx) ? 'translateY(0)' : 'translateY(10px)',
              transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <span style={{ fontSize: '1rem' }}>{kpi.icon}</span>
              <span
                style={{
                  fontSize: '0.65rem',
                  color: 'rgba(255,255,255,0.5)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  fontWeight: 600,
                }}
              >
                {kpi.label}
              </span>
            </div>
            <div
              style={{
                fontSize: '1.4rem',
                fontWeight: 800,
                color: kpi.color,
                fontFamily: 'monospace',
              }}
            >
              {kpi.value}
            </div>
          </div>
        ))}
      </div>

      {/* Admin Actions */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '24px',
          flexWrap: 'wrap',
        }}
      >
        <button
          onClick={handleRunCanary}
          disabled={runningCanary}
          style={{
            padding: '10px 18px',
            borderRadius: '10px',
            border: '1px solid rgba(16,185,129,0.3)',
            background: 'rgba(16,185,129,0.1)',
            color: '#10b981',
            fontWeight: 700,
            fontSize: '0.8rem',
            cursor: runningCanary ? 'wait' : 'pointer',
            opacity: runningCanary ? 0.5 : 1,
            transition: 'all 0.2s',
          }}
        >
          {runningCanary ? '⏳ Running...' : '🐤 Run Canary Check'}
        </button>
        <button
          onClick={handleTriggerSettlement}
          disabled={runningSettlement || !currentPeriod}
          style={{
            padding: '10px 18px',
            borderRadius: '10px',
            border: '1px solid rgba(139,92,246,0.3)',
            background: 'rgba(139,92,246,0.1)',
            color: '#8b5cf6',
            fontWeight: 700,
            fontSize: '0.8rem',
            cursor: runningSettlement ? 'wait' : 'pointer',
            opacity: runningSettlement || !currentPeriod ? 0.5 : 1,
            transition: 'all 0.2s',
          }}
        >
          {runningSettlement ? '⏳ Executing...' : '⚡ Execute Settlement'}
        </button>
        <button
          onClick={() => loadData()}
          style={{
            padding: '10px 18px',
            borderRadius: '10px',
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.03)',
            color: 'rgba(255,255,255,0.6)',
            fontWeight: 700,
            fontSize: '0.8rem',
            cursor: 'pointer',
          }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Canary Result Detail */}
      {canaryResult && (
        <div
          style={{
            padding: '12px 16px',
            marginBottom: '20px',
            borderRadius: '10px',
            background: canaryResult.passed ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
            border: `1px solid ${canaryResult.passed ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}`,
          }}
        >
          <div
            style={{
              fontSize: '0.8rem',
              fontWeight: 700,
              marginBottom: '6px',
              color: canaryResult.passed ? '#10b981' : '#ef4444',
            }}
          >
            {canaryResult.passed ? '✅ Ledger Balanced' : '❌ Ledger Drift Detected'}
          </div>
          <div
            style={{
              fontSize: '0.75rem',
              color: 'rgba(255,255,255,0.5)',
              display: 'flex',
              gap: '16px',
              flexWrap: 'wrap',
            }}
          >
            <span>
              Credits:{' '}
              <strong style={{ color: '#10b981' }}>
                {canaryResult.totalCredits.toLocaleString()}
              </strong>
            </span>
            <span>
              Debits:{' '}
              <strong style={{ color: '#ef4444' }}>
                {canaryResult.totalDebits.toLocaleString()}
              </strong>
            </span>
            <span>
              Diff:{' '}
              <strong style={{ color: canaryResult.difference === 0 ? '#10b981' : '#f59e0b' }}>
                {canaryResult.difference.toLocaleString()}
              </strong>
            </span>
          </div>
        </div>
      )}

      {/* Agent Payout Table */}
      <h2
        style={{
          fontSize: '0.8rem',
          color: 'rgba(255,255,255,0.4)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: '10px',
          fontWeight: 600,
        }}
      >
        Agent Payouts ({agentPayouts.length})
      </h2>
      {agentPayouts.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '40px 20px',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: '12px',
            border: '1px solid rgba(255,255,255,0.06)',
            marginBottom: '24px',
          }}
        >
          <div style={{ fontSize: '1.8rem', marginBottom: '8px' }}>📋</div>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem', margin: 0 }}>
            No agent settlements yet
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '24px' }}>
          {agentPayouts.map((agent, idx) => {
            const statusStyle = getStatusColor(agent.status);
            return (
              <div
                key={agent.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px 14px',
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.06)',
                  opacity: visibleRows.has(idx) ? 1 : 0,
                  transform: visibleRows.has(idx) ? 'translateY(0)' : 'translateY(6px)',
                  transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <span
                  style={{
                    padding: '4px 10px',
                    borderRadius: '20px',
                    fontSize: '0.65rem',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    background: statusStyle.bg,
                    color: statusStyle.text,
                    border: `1px solid ${statusStyle.border}`,
                    boxShadow: statusStyle.shadow,
                    flexShrink: 0,
                  }}
                >
                  {agent.status}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff' }}>
                    {agent.agentName}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>
                    Commission: {agent.commissionEarned.toLocaleString()}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: '0.9rem',
                    fontWeight: 700,
                    color: '#10b981',
                    fontFamily: 'monospace',
                    flexShrink: 0,
                  }}
                >
                  {agent.netSettlement.toLocaleString()}
                </div>
                <span
                  style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}
                >
                  {formatDateTime(agent.updatedAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Period History */}
      <h2
        style={{
          fontSize: '0.8rem',
          color: 'rgba(255,255,255,0.4)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: '10px',
          fontWeight: 600,
        }}
      >
        Period History ({periodHistory.length})
      </h2>
      {periodHistory.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '40px 20px',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: '12px',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div style={{ fontSize: '1.8rem', marginBottom: '8px' }}>📅</div>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem', margin: 0 }}>
            No completed settlement periods
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {periodHistory.map((period) => {
            const statusStyle = getStatusColor(period.status);
            return (
              <div
                key={period.id}
                onClick={() =>
                  setExpandedPeriodId(expandedPeriodId === period.id ? null : period.id)
                }
                style={{
                  padding: '12px 14px',
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.06)',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span
                    style={{
                      padding: '4px 10px',
                      borderRadius: '20px',
                      fontSize: '0.65rem',
                      fontWeight: 800,
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      background: statusStyle.bg,
                      color: statusStyle.text,
                      border: `1px solid ${statusStyle.border}`,
                      boxShadow: statusStyle.shadow,
                      flexShrink: 0,
                    }}
                  >
                    {period.status}
                  </span>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff' }}>
                      {formatDate(period.start)} — {formatDate(period.end)}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      color: '#8b5cf6',
                      fontFamily: 'monospace',
                    }}
                  >
                    {period.totalDisbursed.toLocaleString()}
                  </span>
                  <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: '0.8rem' }}>
                    {expandedPeriodId === period.id ? '▾' : '▸'}
                  </span>
                </div>
                {expandedPeriodId === period.id && (
                  <div
                    style={{
                      marginTop: '10px',
                      paddingTop: '10px',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                      display: 'flex',
                      gap: '16px',
                      fontSize: '0.75rem',
                      color: 'rgba(255,255,255,0.5)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span>
                      Agents Paid: <strong style={{ color: '#3b82f6' }}>{period.agentsPaid}</strong>
                    </span>
                    <span>
                      Total Disbursed:{' '}
                      <strong style={{ color: '#10b981' }}>
                        {period.totalDisbursed.toLocaleString()}
                      </strong>
                    </span>
                    <span>
                      Created: <strong>{formatDateTime(period.createdAt)}</strong>
                    </span>
                    <span>ID: {period.id.slice(0, 12)}...</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          marginTop: '24px',
          padding: '12px 16px',
          background: 'rgba(255,255,255,0.02)',
          borderRadius: '10px',
          border: '1px solid rgba(255,255,255,0.05)',
          textAlign: 'center',
          fontSize: '0.7rem',
          color: 'rgba(255,255,255,0.3)',
        }}
      >
        Settlement Engine v3.0 • Sunday 11:59 PM snapshot • Monday 4:00 AM execution
      </div>
    </div>
  );
}

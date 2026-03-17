/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Settlement Page with Live Updates
 * ═══════════════════════════════════════════════════════════════════════════════
 * Weekly settlement management for clubs and unions
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { SettlementService } from '../services/SettlementService';
import { exportToCSV } from '../lib/export';
import styles from './SettlementPage.module.css';
import '../components/common/ButtonSpinner.css';
import { useToast } from '../components/common/Toast';
import ClubBottomNav from '../components/club/ClubBottomNav';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { formatDateShort as formatDate } from '../utils/format';
import SecurityBadge from '../components/common/SecurityBadge';
import SettlementReceipt from '../components/settlement/SettlementReceipt';
import SettlementTimeline from '../components/settlement/SettlementTimeline';
import PageSkeleton from '../components/common/PageSkeleton';
import { useIsMounted } from '../hooks/useIsMounted';

// ═══════════════════════════════════════════════════════════════════════════════
// MONDAY 4AM COUNTDOWN — Live payout timer widget
// ═══════════════════════════════════════════════════════════════════════════════

function MondayPayoutCountdown() {
  const [countdown, setCountdown] = useState({
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0,
    progress: 0,
  });

  useEffect(() => {
    const getNextMondayPayout = () => {
      const now = new Date();
      // Monday 4AM PST = Monday 12:00 UTC
      const target = new Date(now);
      const dayOfWeek = target.getUTCDay(); // 0=Sun, 1=Mon
      const daysUntilMonday =
        dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? (target.getUTCHours() < 12 ? 0 : 7) : 8 - dayOfWeek;
      target.setUTCDate(target.getUTCDate() + daysUntilMonday);
      target.setUTCHours(12, 0, 0, 0);
      if (target <= now) target.setUTCDate(target.getUTCDate() + 7);
      return target;
    };

    const tick = () => {
      const now = new Date();
      const target = getNextMondayPayout();
      const diff = target.getTime() - now.getTime();
      const totalWeekMs = 7 * 24 * 60 * 60 * 1000;
      const elapsed = totalWeekMs - diff;
      const progress = Math.max(0, Math.min(100, (elapsed / totalWeekMs) * 100));

      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      setCountdown({ days, hours, minutes, seconds, progress });
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      style={{
        margin: '0 0 16px',
        padding: '16px 20px',
        background: 'linear-gradient(135deg, rgba(0,100,200,0.12) 0%, rgba(0,200,83,0.08) 100%)',
        border: '1px solid rgba(0,150,255,0.2)',
        borderRadius: '14px',
        position: 'relative',
        overflow: 'hidden',
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
        <span
          style={{
            fontSize: '0.8rem',
            color: 'rgba(255,255,255,0.7)',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}
        >
          ⏱ Next Payout (Monday 4AM PST)
        </span>
        {countdown.progress >= 99.9 ? (
          <span
            style={{
              fontSize: '1rem',
              fontWeight: 800,
              fontFamily: 'monospace',
              color: '#00C853',
              textShadow: '0 0 16px rgba(0,200,83,0.6)',
              animation: 'payoutPulse 1.5s ease-in-out infinite',
            }}
          >
            🎉 PAYOUT IN PROGRESS!
          </span>
        ) : (
          <span
            style={{
              fontSize: '1.1rem',
              fontWeight: 800,
              fontFamily: 'monospace',
              color: '#fff',
              textShadow:
                countdown.days === 0 && countdown.hours < 4
                  ? '0 0 12px rgba(0,200,83,0.5)'
                  : 'none',
            }}
          >
            {countdown.days}d {String(countdown.hours).padStart(2, '0')}h{' '}
            {String(countdown.minutes).padStart(2, '0')}m{' '}
            {String(countdown.seconds).padStart(2, '0')}s
          </span>
        )}
      </div>
      <div
        style={{
          height: '6px',
          background: 'rgba(255,255,255,0.06)',
          borderRadius: '3px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${countdown.progress}%`,
            background:
              countdown.progress >= 99.9
                ? 'linear-gradient(90deg, #00C853, #4CAF50)'
                : 'linear-gradient(90deg, #0088ff, #00C853)',
            borderRadius: '3px',
            transition: 'width 1s linear',
            boxShadow:
              countdown.progress >= 99.9
                ? '0 0 14px rgba(0, 200, 83, 0.6)'
                : '0 0 8px rgba(0, 200, 83, 0.3)',
          }}
        />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface SettlementPeriod {
  id: string;
  periodNumber: number;
  year: number;
  startAt: string;
  endAt: string;
  status: 'open' | 'processing' | 'settled';
  totalRake: number;
  totalBBJ: number;
  totalHands: number;
  totalPlayers: number;
}

interface ClubWire {
  id: string;
  clubId: string;
  clubName: string;
  netPlayerPL: number;
  grossRake: number;
  unionTax: number;
  agentCommissions: number;
  finalWire: number;
  direction: 'PAY_TO_UNION' | 'COLLECT_FROM_UNION';
  status: 'pending' | 'processed';
}

interface AgentPayout {
  id: string;
  agentId: string;
  agentName: string;
  rakeGenerated: number;
  commissionRate: number;
  grossCommission: number;
  playerRakeback: number;
  netPayout: number;
  status: 'pending' | 'approved' | 'paid';
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

type TabType = 'overview' | 'club-wires' | 'agent-payouts' | 'history';

export default function SettlementPage() {
  const { unionId, clubId } = useParams<{ unionId?: string; clubId?: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  useVisibilityRefresh(() => loadSettlementData());
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [isLoading, setIsLoading] = useState(true);

  // Real data from SettlementService
  const [periods, setPeriods] = useState<SettlementPeriod[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<SettlementPeriod | null>(null);
  const [clubWires, setClubWires] = useState<ClubWire[]>([]);
  const [agentPayouts, setAgentPayouts] = useState<AgentPayout[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [autoSettlement, setAutoSettlement] = useState(false);
  const [togglingAutoSettle, setTogglingAutoSettle] = useState(false);
  const [visibleWires, setVisibleWires] = useState<Set<string>>(new Set());
  const [visiblePayouts, setVisiblePayouts] = useState<Set<string>>(new Set());
  const isMounted = useIsMounted();
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-entity state when navigating between clubs/unions ──
  useEffect(() => {
    setActiveTab('overview');
    setSelectedPeriod(null);
    setIsProcessing(false);
    setAutoSettlement(false);
    setTogglingAutoSettle(false);
    setVisibleWires(new Set());
    setVisiblePayouts(new Set());
    loadingRef.current = false;
  }, [unionId, clubId]);

  // Load data from SettlementService
  const loadSettlementData = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setIsLoading(true);
    try {
      // Get current period
      const currentPeriod = await SettlementService.getCurrentPeriod();

      // Get period history
      const periodHistory = await SettlementService.getPeriodHistory(12);

      // Map to our internal format
      const mappedPeriods: SettlementPeriod[] = [
        {
          id: currentPeriod.id,
          periodNumber: currentPeriod.periodNumber,
          year: currentPeriod.year,
          startAt: currentPeriod.startAt,
          endAt: currentPeriod.endAt,
          status: currentPeriod.status as 'open' | 'processing' | 'settled',
          totalRake: currentPeriod.totalRakeCollected,
          totalBBJ: currentPeriod.totalBBJContributions,
          totalHands: currentPeriod.totalHandsDealt,
          totalPlayers: 0, // Not in service type
        },
        ...periodHistory.map((p) => ({
          id: p.id,
          periodNumber: p.periodNumber,
          year: p.year,
          startAt: p.startAt,
          endAt: p.endAt,
          status: p.status as 'open' | 'processing' | 'settled',
          totalRake: p.totalRakeCollected,
          totalBBJ: p.totalBBJContributions,
          totalHands: p.totalHandsDealt,
          totalPlayers: 0,
        })),
      ];

      if (isMounted.current) {
        setPeriods(mappedPeriods);
        setSelectedPeriod(mappedPeriods[0]);
      }

      // Load auto-settlement setting from DB
      try {
        if (unionId) {
          const { data: unionData } = await supabase
            .from('unions')
            .select('auto_settlement')
            .eq('id', unionId)
            .maybeSingle();
          if (isMounted.current && unionData) {
            setAutoSettlement(!!unionData.auto_settlement);
          }
        } else if (clubId) {
          const { data: clubData } = await supabase
            .from('clubs')
            .select('auto_settlement')
            .eq('id', clubId)
            .maybeSingle();
          if (isMounted.current && clubData) {
            setAutoSettlement(!!clubData.auto_settlement);
          }
        }
      } catch {
        // Non-critical: default to false if query fails
      }

      // Generate settlements for current period (skip if no real period)
      if (currentPeriod.id && currentPeriod.id !== 'default') {
        try {
          const settlements = await SettlementService.generateSettlements(currentPeriod.id);

          // Map club settlements to wires
          const wires: ClubWire[] = settlements.clubSettlements.map((c) => ({
            id: c.clubId,
            clubId: c.clubId,
            clubName: c.clubName,
            netPlayerPL: -c.totalRakeCollected,
            grossRake: c.totalRakeCollected,
            unionTax: c.platformFee,
            agentCommissions: c.agentCommissions,
            finalWire: c.netRevenue,
            direction: c.netRevenue >= 0 ? 'COLLECT_FROM_UNION' : 'PAY_TO_UNION',
            status: c.status === 'finalized' ? 'processed' : 'pending',
          }));

          // Map agent settlements to payouts
          const payouts: AgentPayout[] = settlements.agentSettlements.map((a) => ({
            id: a.agentId,
            agentId: a.agentId,
            agentName: a.agentName,
            rakeGenerated: a.totalRakeGenerated,
            commissionRate: a.commissionRate,
            grossCommission: a.commissionEarned,
            playerRakeback: a.totalRakeGenerated * 0.1,
            netPayout: a.netSettlement,
            status: a.status as 'pending' | 'approved' | 'paid',
          }));
          if (isMounted.current) {
            setClubWires(wires);
            setAgentPayouts(payouts);
          }
        } catch (settleErr) {
          console.warn('[SettlementPage] No settlements to generate for current period');
        }
      }
    } catch (error) {
      console.error('[SettlementPage] Failed to load data:', error);
      if (isMounted.current) toast.error('Failed to load settlement data');
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setIsLoading(false);
    }
  }, [unionId, clubId]);

  useEffect(() => {
    loadSettlementData();
  }, [loadSettlementData]);

  // Stagger animations for wires and payouts
  useEffect(() => {
    if (clubWires.length === 0) return;
    setVisibleWires(new Set());
    const timers = clubWires.map((wire, index) =>
      setTimeout(() => {
        setVisibleWires((prev) => new Set(prev).add(wire.id));
      }, index * 60)
    );
    return () => timers.forEach(clearTimeout);
  }, [clubWires]);

  useEffect(() => {
    if (agentPayouts.length === 0) return;
    setVisiblePayouts(new Set());
    const timers = agentPayouts.map((payout, index) =>
      setTimeout(() => {
        setVisiblePayouts((prev) => new Set(prev).add(payout.id));
      }, index * 60)
    );
    return () => timers.forEach(clearTimeout);
  }, [agentPayouts]);

  // Real-time settlement period updates
  useEffect(() => {
    const channelKey = `settlement-live-${unionId || 'global'}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'settlement_periods',
        },
        () => {
          // Reload — inline since loadSettlementData is scoped to another useEffect
          SettlementService.getCurrentPeriod()
            .then((cp) => {
              const mapped: SettlementPeriod = {
                id: cp.id,
                periodNumber: cp.periodNumber,
                year: cp.year,
                startAt: cp.startAt,
                endAt: cp.endAt,
                status: cp.status as 'open' | 'processing' | 'settled',
                totalRake: cp.totalRakeCollected,
                totalBBJ: cp.totalBBJContributions,
                totalHands: cp.totalHandsDealt,
                totalPlayers: 0,
              };
              if (isMounted.current) setSelectedPeriod(mapped);
            })
            .catch((e) =>
              console.warn('[SettlementPage] Failed to get current settlement period:', e)
            );
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'club_settlements',
        },
        (payload) => {
          // Update club wires state directly for faster UI updates
          if (payload.eventType === 'UPDATE' && payload.new && isMounted.current) {
            setClubWires((prev) =>
              prev.map((wire) =>
                wire.clubId === (payload.new as any).club_id
                  ? {
                      ...wire,
                      status: (payload.new as any).status === 'finalized' ? 'processed' : 'pending',
                      finalWire: (payload.new as any).final_amount || wire.finalWire,
                    }
                  : wire
              )
            );
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_settlements',
        },
        (payload) => {
          // Update agent payouts state directly for faster UI updates
          if (payload.eventType === 'UPDATE' && payload.new && isMounted.current) {
            setAgentPayouts((prev) =>
              prev.map((payout) =>
                payout.agentId === (payload.new as any).agent_id
                  ? {
                      ...payout,
                      status: (payload.new as any).status as 'pending' | 'approved' | 'paid',
                      netPayout: (payload.new as any).net_settlement || payout.netPayout,
                    }
                  : payout
              )
            );
          }
        }
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [unionId]);

  // Bus listeners: refresh settlement data when wallet balance changes or settlement cycles complete
  useEffect(() => {
    const unsubWallet = masterBus.subscribeDebounced(
      'WALLET_REFRESHED',
      () => {
        loadSettlementData();
      },
      500
    );
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadSettlementData();
      },
      500
    );
    const unsubCycleComplete = masterBus.subscribeDebounced(
      'SETTLEMENT_CYCLE_COMPLETED',
      () => {
        loadSettlementData();
      },
      1000
    );
    const unsubSettlement = masterBus.subscribeDebounced(
      'SETTLEMENT_COMPLETED',
      () => {
        loadSettlementData();
      },
      1000
    );
    return () => {
      unsubWallet();
      unsubBalance();
      unsubCycleComplete();
      unsubSettlement();
    };
  }, [loadSettlementData]);

  // Calculate totals
  const totalToCollect = clubWires
    .filter((w) => w.direction === 'PAY_TO_UNION')
    .reduce((sum, w) => sum + Math.abs(w.finalWire), 0);
  const totalToDistribute = clubWires
    .filter((w) => w.direction === 'COLLECT_FROM_UNION')
    .reduce((sum, w) => sum + w.finalWire, 0);
  const netPosition = totalToDistribute - totalToCollect;
  const totalAgentPayouts = agentPayouts.reduce((sum, a) => sum + a.netPayout, 0);

  const formatMoney = (amount: number) => {
    const prefix = amount < 0 ? '-' : '';
    return prefix + Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2 });
  };

  const handleExecutePayouts = async () => {
    if (!selectedPeriod) return;

    setIsProcessing(true);
    // Capture period ref to avoid stale closure race
    const period = selectedPeriod;
    try {
      // ═══ IDEMPOTENCY: Re-check period status from DB before executing ═══
      const { data: freshPeriod, error: checkErr } = await supabase
        .from('settlement_periods')
        .select('id, status')
        .eq('id', period.id)
        .maybeSingle();

      if (checkErr) throw new Error('Failed to verify period status: ' + checkErr.message);
      if (freshPeriod?.status === 'settled') {
        toast.error('This period has already been settled.');
        setIsProcessing(false);
        return;
      }
      if (freshPeriod?.status === 'processing') {
        toast.error('This period is currently being processed by another admin.');
        setIsProcessing(false);
        return;
      }

      // Execute real payouts via SettlementService
      const result = await SettlementService.executeMondayPayouts(period.id);

      // Only update state if payouts succeeded
      if (result.agentsPaid > 0 || result.playersWithRakeback > 0) {
        setAgentPayouts((prev) => prev.map((a) => ({ ...a, status: 'paid' as const })));
        setClubWires((prev) => prev.map((w) => ({ ...w, status: 'processed' as const })));
        toast.success(
          `Payouts complete: ${result.agentsPaid} agents, ${result.playersWithRakeback} players, ${result.totalDisbursed.toLocaleString()} disbursed`
        );
        // Notify other pages (ClubFinancialsPage) that settlement completed
        masterBus.emit('SETTLEMENT_COMPLETED', {
          clubId: clubId || '',
          periodId: period.id,
          agentsPaid: result.agentsPaid,
          playersWithRakeback: result.playersWithRakeback,
          totalDisbursed: result.totalDisbursed,
          successRate: 100,
          status: 'settled',
        });
      }
    } catch (error) {
      console.error('[SettlementPage] Payout failed:', error);
      toast.error('Payout execution failed: ' + (error as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  // ─── Toggle auto-settlement ───
  const handleToggleAutoSettlement = async () => {
    setTogglingAutoSettle(true);
    try {
      const targetId = clubId || unionId;
      if (!targetId) {
        toast.error('No club or union ID');
        return;
      }

      const newValue = !autoSettlement;

      // Direct Supabase update — no World Hub API dependency
      // Detect if targetId refers to a union or club and update accordingly
      if (unionId) {
        const { error } = await supabase
          .from('unions')
          .update({ auto_settlement: newValue })
          .eq('id', unionId);
        if (error) throw error;
      } else if (clubId) {
        const { error } = await supabase
          .from('clubs')
          .update({ auto_settlement: newValue })
          .eq('id', clubId);
        if (error) throw error;
      }

      setAutoSettlement(newValue);
      toast.success(`Auto-settlement ${newValue ? 'enabled' : 'disabled'}`);
      // Notify other pages about the settings change
      masterBus.emit('CLUB_SETTINGS_UPDATED', {
        clubId: targetId,
        setting: 'auto_settlement',
        value: newValue,
      });
    } catch (err: any) {
      toast.error(err.message || 'Failed to toggle auto-settlement');
    } finally {
      setTogglingAutoSettle(false);
    }
  };

  // ─── CSV Export ───
  const handleExportSettlement = () => {
    if (clubWires.length > 0) {
      exportToCSV(
        clubWires.map((w) => ({
          Club: w.clubName,
          'Net Player P/L': w.netPlayerPL,
          'Gross Rake': w.grossRake,
          'Union Tax': w.unionTax,
          'Agent Commissions': w.agentCommissions,
          'Final Wire': w.finalWire,
          Direction: w.direction,
          Status: w.status,
        })),
        `settlement_${selectedPeriod?.periodNumber || 'period'}.csv`,
        [
          { key: 'Club', label: 'Club' },
          { key: 'Net Player P/L', label: 'Net Player P/L' },
          { key: 'Gross Rake', label: 'Gross Rake' },
          { key: 'Union Tax', label: 'Union Tax' },
          { key: 'Agent Commissions', label: 'Agent Comm.' },
          { key: 'Final Wire', label: 'Final Wire' },
          { key: 'Direction', label: 'Direction' },
          { key: 'Status', label: 'Status' },
        ]
      );
    }
  };

  if (isLoading) {
    return (
      <div className={styles.page}>
        <PageSkeleton variant="dashboard" />
      </div>
    );
  }

  if (!selectedPeriod) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>No settlement periods found</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <header className={styles.header}>
        <button className={styles.backButton} onClick={() => navigate(-1)}>
          ← Back
        </button>
        <div className={styles.headerContent}>
          <h1>Settlement Center</h1>
          <p className={styles.subtitle}>
            Period {selectedPeriod.periodNumber}/{selectedPeriod.year} •{' '}
            {formatDate(selectedPeriod.startAt)} - {formatDate(selectedPeriod.endAt)}
          </p>
        </div>
        <div className={`${styles.statusBadge} ${styles[selectedPeriod.status]}`}>
          {selectedPeriod.status === 'open' && ' Open'}
          {selectedPeriod.status === 'processing' && '🟡 Processing'}
          {selectedPeriod.status === 'settled' && ' Settled'}
        </div>
        <SecurityBadge variant="secured" label="Bank-Grade" />
        <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
          <button
            onClick={handleExportSettlement}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(255,255,255,0.05)',
              color: '#fff',
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            📥 Export CSV
          </button>
          <button
            onClick={handleToggleAutoSettlement}
            disabled={togglingAutoSettle}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: `1px solid ${autoSettlement ? 'rgba(52,199,89,0.4)' : 'rgba(255,255,255,0.2)'}`,
              background: autoSettlement ? 'rgba(52,199,89,0.15)' : 'rgba(255,255,255,0.05)',
              color: autoSettlement ? '#34c759' : '#fff',
              fontSize: '0.75rem',
              cursor: togglingAutoSettle ? 'wait' : 'pointer',
              opacity: togglingAutoSettle ? 0.6 : 1,
            }}
          >
            {autoSettlement ? '⏱ Auto: ON' : '⏱ Auto: OFF'}
          </button>
        </div>
      </header>

      {/* Monday 4AM Payout Countdown */}
      {selectedPeriod.status === 'open' && <MondayPayoutCountdown />}

      {/* Key Metrics */}
      <div className={styles.metricsGrid}>
        <div className={styles.metricCard}>
          <span className={styles.metricIcon}></span>
          <div>
            <span className={styles.metricValue}>{formatMoney(selectedPeriod.totalRake)}</span>
            <span className={styles.metricLabel}>Total Rake</span>
          </div>
        </div>
        <div className={styles.metricCard}>
          <span className={styles.metricIcon}></span>
          <div>
            <span className={styles.metricValue}>{formatMoney(selectedPeriod.totalBBJ)}</span>
            <span className={styles.metricLabel}>BBJ Collected</span>
          </div>
        </div>
        <div className={styles.metricCard}>
          <span className={styles.metricIcon}></span>
          <div>
            <span className={styles.metricValue}>{selectedPeriod.totalHands.toLocaleString()}</span>
            <span className={styles.metricLabel}>Hands Dealt</span>
          </div>
        </div>
        <div className={styles.metricCard}>
          <span className={styles.metricIcon}></span>
          <div>
            <span className={styles.metricValue}>
              {selectedPeriod.totalPlayers.toLocaleString()}
            </span>
            <span className={styles.metricLabel}>Active Players</span>
          </div>
        </div>
      </div>

      {/* Settlement Summary */}
      <div className={styles.settlementSummary}>
        <div className={styles.summaryBox}>
          <span className={styles.summaryLabel}>Clubs Owe Union</span>
          <span className={`${styles.summaryValue} ${styles.negative}`}>
            {formatMoney(totalToCollect)}
          </span>
        </div>
        <div className={styles.summaryDivider}>⟷</div>
        <div className={styles.summaryBox}>
          <span className={styles.summaryLabel}>Union Owes Clubs</span>
          <span className={`${styles.summaryValue} ${styles.positive}`}>
            {formatMoney(totalToDistribute)}
          </span>
        </div>
        <div className={styles.summaryDivider}>=</div>
        <div className={styles.summaryBox}>
          <span className={styles.summaryLabel}>Net Position</span>
          <span
            className={`${styles.summaryValue} ${netPosition >= 0 ? styles.positive : styles.negative}`}
          >
            {formatMoney(netPosition)}
          </span>
        </div>
      </div>

      {/* Tab Navigation */}
      <nav className={styles.tabNav}>
        {(['overview', 'club-wires', 'agent-payouts', 'history'] as TabType[]).map((tab) => (
          <button
            key={tab}
            className={`${styles.tabButton} ${activeTab === tab ? styles.active : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'overview' && ' Overview'}
            {tab === 'club-wires' && ' Club Wires'}
            {tab === 'agent-payouts' && ' Agent Payouts'}
            {tab === 'history' && ' History'}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <div className={styles.content}>
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* OVERVIEW TAB */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'overview' && (
          <div className={styles.overviewSection}>
            <div className={styles.formulaCard}>
              <h3> Settlement Formula</h3>
              <div className={styles.formula}>
                <code>FINAL WIRE = (Net Player P/L) + (Gross Rake) - (Union Tax 10%)</code>
              </div>
              <p className={styles.formulaNote}>
                Positive wire → Union pays Club
                <br />
                Negative wire → Club pays Union
              </p>
            </div>

            <div className={styles.timelineCard}>
              <h3> Settlement Timeline</h3>
              <div className={styles.timeline}>
                <div className={`${styles.timelineItem} ${styles.completed}`}>
                  <span className={styles.timelineDot}></span>
                  <div>
                    <strong>Week Start</strong>
                    <p>Monday 12:00 AM UTC</p>
                  </div>
                </div>
                <div className={`${styles.timelineItem} ${styles.active}`}>
                  <span className={styles.timelineDot}>●</span>
                  <div>
                    <strong>Active Settlement</strong>
                    <p>Rake & P/L tracking in progress</p>
                  </div>
                </div>
                <div className={styles.timelineItem}>
                  <span className={styles.timelineDot}>○</span>
                  <div>
                    <strong>Sunday Snapshot</strong>
                    <p>11:59:59 PM PST — Invoice generation</p>
                  </div>
                </div>
                <div className={styles.timelineItem}>
                  <span className={styles.timelineDot}>○</span>
                  <div>
                    <strong>Monday Payouts</strong>
                    <p>4:00 AM PST — Commission injection</p>
                  </div>
                </div>
              </div>
            </div>

            {selectedPeriod.status === 'open' && (
              <div className={styles.actionBar}>
                <button
                  className={styles.executeButton}
                  onClick={handleExecutePayouts}
                  disabled={isProcessing}
                >
                  {isProcessing ? (
                    <>
                      <span className="btn-spinner" /> Processing...
                    </>
                  ) : (
                    '⚡ Execute Settlement'
                  )}
                </button>
                <p className={styles.actionNote}>
                  This will finalize all wires and process agent payouts
                </p>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* CLUB WIRES TAB */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'club-wires' && (
          <div className={styles.wiresSection}>
            <table className={styles.wireTable}>
              <thead>
                <tr>
                  <th>Club</th>
                  <th>Net Player P/L</th>
                  <th>Gross Rake</th>
                  <th>Union Tax (10%)</th>
                  <th>Agent Comm.</th>
                  <th>Final Wire</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {clubWires.map((wire) => (
                  <tr
                    key={wire.clubId}
                    className={`${visibleWires.has(wire.id) ? 'fadeInUp' : 'hidden'}`}
                    style={
                      visibleWires.has(wire.id)
                        ? undefined
                        : { opacity: 0, transform: 'translateY(8px)' }
                    }
                  >
                    <td className={styles.clubCell}>{wire.clubName}</td>
                    <td className={wire.netPlayerPL >= 0 ? styles.positive : styles.negative}>
                      {formatMoney(wire.netPlayerPL)}
                    </td>
                    <td>{formatMoney(wire.grossRake)}</td>
                    <td className={styles.muted}>-{formatMoney(wire.unionTax)}</td>
                    <td className={styles.muted}>-{formatMoney(wire.agentCommissions)}</td>
                    <td
                      className={`${styles.wireAmount} ${wire.finalWire >= 0 ? styles.positive : styles.negative}`}
                    >
                      {formatMoney(wire.finalWire)}
                      <span className={styles.wireDirection}>
                        {wire.direction === 'COLLECT_FROM_UNION' ? '← Union Pays' : '→ Club Pays'}
                      </span>
                    </td>
                    <td>
                      <span className={`${styles.badge} ${styles[wire.status]}`}>
                        {wire.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* AGENT PAYOUTS TAB */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'agent-payouts' && (
          <div className={styles.payoutsSection}>
            <div className={styles.payoutSummary}>
              <span>Total Agent Payouts This Period:</span>
              <strong className={styles.positive}>{formatMoney(totalAgentPayouts)}</strong>
            </div>

            <table className={styles.payoutTable}>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Rake Generated</th>
                  <th>Commission Rate</th>
                  <th>Gross Commission</th>
                  <th>Player Rakeback</th>
                  <th>Net Payout</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {agentPayouts.map((payout) => (
                  <tr
                    key={payout.agentId}
                    className={`${visiblePayouts.has(payout.id) ? 'fadeInUp' : 'hidden'}`}
                    style={
                      visiblePayouts.has(payout.id)
                        ? undefined
                        : { opacity: 0, transform: 'translateY(8px)' }
                    }
                  >
                    <td className={styles.agentCell}>{payout.agentName}</td>
                    <td>{formatMoney(payout.rakeGenerated)}</td>
                    <td>{(payout.commissionRate * 100).toFixed(0)}%</td>
                    <td>{formatMoney(payout.grossCommission)}</td>
                    <td className={styles.muted}>-{formatMoney(payout.playerRakeback)}</td>
                    <td className={`${styles.netAmount} ${styles.positive}`}>
                      {formatMoney(payout.netPayout)}
                    </td>
                    <td>
                      <span className={`${styles.badge} ${styles[payout.status]}`}>
                        {payout.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className={styles.payoutNote}>
              <p>
                <strong>Net Payout</strong> = Gross Commission - Player Rakeback (the spread agent
                keeps)
              </p>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* HISTORY TAB */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'history' && (
          <div className={styles.historySection}>
            <div className={styles.periodList}>
              {periods.map((period) => (
                <div
                  key={period.id}
                  className={`${styles.periodCard} ${selectedPeriod?.id === period.id ? styles.selected : ''}`}
                  onClick={() => setSelectedPeriod(period)}
                >
                  <div className={styles.periodHeader}>
                    <span className={styles.periodNumber}>Week {period.periodNumber}</span>
                    <span className={`${styles.badge} ${styles[period.status]}`}>
                      {period.status}
                    </span>
                  </div>
                  <p className={styles.periodDates}>
                    {formatDate(period.startAt)} - {formatDate(period.endAt)}
                  </p>
                  <div className={styles.periodStats}>
                    <span>{formatMoney(period.totalRake)} rake</span>
                    <span>•</span>
                    <span>{period.totalHands.toLocaleString()} hands</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {/* Settlement Receipt for settled periods */}
      {selectedPeriod && selectedPeriod.status === 'settled' && (
        <SettlementReceipt
          receiptId={selectedPeriod.id}
          amount={selectedPeriod.totalRake}
          netAmount={selectedPeriod.totalRake - (selectedPeriod.totalBBJ || 0)}
          settledAt={selectedPeriod.endAt}
          periodStart={selectedPeriod.startAt}
          periodEnd={selectedPeriod.endAt}
          status="paid"
        />
      )}

      {/* Settlement Timeline */}
      {periods.length > 0 && (
        <div style={{ padding: '0 16px', marginBottom: 16 }}>
          <h3
            style={{
              margin: '12px 0 8px',
              fontSize: '0.875rem',
              color: '#8a9aaa',
              fontWeight: 600,
            }}
          >
            Settlement History
          </h3>
          <SettlementTimeline
            entries={periods.map((p) => ({
              id: p.id,
              amount: p.totalRake,
              netAmount: p.totalRake - (p.totalBBJ || 0),
              settledAt: p.endAt,
              status:
                p.status === 'settled'
                  ? ('paid' as const)
                  : p.status === 'processing'
                    ? ('processing' as const)
                    : ('pending' as const),
              periodLabel: `Week ${p.periodNumber}`,
            }))}
            onSelect={(id) => {
              const period = periods.find((p) => p.id === id);
              if (period) setSelectedPeriod(period);
            }}
          />
        </div>
      )}

      {/* Bottom Navigation */}
      {clubId && <ClubBottomNav clubId={clubId} />}
    </div>
  );
}

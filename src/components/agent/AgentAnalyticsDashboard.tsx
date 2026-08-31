/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT ANALYTICS DASHBOARD — Key performance metrics for agents
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Visualizes:
 * - Distribution volume over time
 * - Clawback rate (% of distributions clawed back)
 * - Top recipients by volume
 * - Promo efficiency (net chips out vs promo spent)
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './AgentAnalyticsDashboard.css';
import { reportError } from '../../utils/errorReporter';

interface AgentAnalyticsDashboardProps {
  userId: string;
  clubId: string;
}

interface TxnRecord {
  amount: number;
  created_at: string;
  transaction_type: string;
  clawed_back: boolean;
  to_user_id: string;
}

interface TopRecipient {
  name: string;
  totalAmount: number;
  count: number;
  clawedBackCount: number;
}

export default function AgentAnalyticsDashboard({ userId, clubId }: AgentAnalyticsDashboardProps) {
  const [data, setData] = useState<TxnRecord[]>([]);
  const [clawbackLogs, setClawbackLogs] = useState<
    { recovered_amount: number; clawed_back_at: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();

  const loadData = useCallback(async () => {
    if (!userId || !clubId) return;
    setLoading(true);

    try {
      const resolvedClub = await resolveClubUUID(clubId);

      // Fetch all distributions
      const { data: txns } = await supabase
        .from('chip_transactions')
        .select('amount, created_at, transaction_type, clawed_back, to_user_id')
        .eq('from_user_id', userId)
        .eq('club_id', resolvedClub)
        .in('transaction_type', ['agent_to_player', 'promo_agent_to_player', 'send'])
        .order('created_at', { ascending: false })
        .limit(500);

      // Fetch clawback audit logs
      const { data: logs } = await supabase
        .from('clawback_audit_log')
        .select('recovered_amount, clawed_back_at')
        .eq('agent_user_id', userId)
        .eq('club_id', resolvedClub)
        .order('clawed_back_at', { ascending: false })
        .limit(100);

      if (isMounted.current) {
        setData(txns || []);
        setClawbackLogs(logs || []);
      }
    } catch (err) {
      reportError(err, 'AgentAnalyticsDashboard.Error');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [userId, clubId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', () => loadData(), 1000),
      masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadData(), 2000),
    ];
    return () => unsubs.forEach((u) => u());
  }, [loadData]);

  // Computed metrics
  const metrics = useMemo(() => {
    const total = data.reduce((s, r) => s + r.amount, 0);
    const clawedBack = data.filter((r) => r.clawed_back);
    const clawbackTotal = clawedBack.reduce((s, r) => s + r.amount, 0);
    const clawbackRate = data.length > 0 ? (clawedBack.length / data.length) * 100 : 0;
    const netOut = total - clawbackTotal;
    const promoCount = data.filter((r) => r.transaction_type === 'promo_agent_to_player').length;
    const regularCount = data.filter((r) => r.transaction_type === 'agent_to_player').length;
    const avgDistribution = data.length > 0 ? total / data.length : 0;

    // Distributions per day (last 30 days)
    const thirtyDaysAgo = Date.now() - 30 * 86400000;
    const last30 = data.filter((r) => new Date(r.created_at).getTime() > thirtyDaysAgo);
    const perDay = last30.length / 30;

    // Top recipients
    const recipientMap = new Map<string, { total: number; count: number; clawed: number }>();
    data.forEach((r) => {
      const existing = recipientMap.get(r.to_user_id) || { total: 0, count: 0, clawed: 0 };
      existing.total += r.amount;
      existing.count += 1;
      if (r.clawed_back) existing.clawed += 1;
      recipientMap.set(r.to_user_id, existing);
    });

    return {
      totalDistributed: total,
      totalClawedBack: clawbackTotal,
      clawbackRate,
      netOut,
      promoCount,
      regularCount,
      avgDistribution,
      perDay,
      totalCount: data.length,
      recipientMap,
    };
  }, [data]);

  // Top 5 recipients
  const topRecipients = useMemo(() => {
    return Array.from(metrics.recipientMap.entries())
      .sort(([, a], [, b]) => b.total - a.total)
      .slice(0, 5)
      .map(([id, stats]) => ({ id, ...stats }));
  }, [metrics.recipientMap]);

  // Weekly volume chart (last 8 weeks)
  const weeklyVolume = useMemo(() => {
    const weeks: { label: string; amount: number; count: number }[] = [];
    for (let i = 7; i >= 0; i--) {
      const start = Date.now() - (i + 1) * 7 * 86400000;
      const end = Date.now() - i * 7 * 86400000;
      const weekData = data.filter((r) => {
        const t = new Date(r.created_at).getTime();
        return t >= start && t < end;
      });
      const weekStart = new Date(start);
      weeks.push({
        label: `${weekStart.getMonth() + 1}/${weekStart.getDate()}`,
        amount: weekData.reduce((s, r) => s + r.amount, 0),
        count: weekData.length,
      });
    }
    return weeks;
  }, [data]);

  const maxWeekly = Math.max(...weeklyVolume.map((w) => w.amount), 1);

  if (loading) {
    return (
      <div className="aad-container">
        <h3 className="aad-title">Agent Analytics</h3>
        <div className="aad-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="aad-skeleton" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="aad-container">
      <h3 className="aad-title">Agent Analytics</h3>

      {/* KPI Cards */}
      <div className="aad-kpis">
        <div className="aad-kpi">
          <span className="aad-kpi-value">{metrics.totalDistributed.toLocaleString()}</span>
          <span className="aad-kpi-label">Total Distributed</span>
        </div>
        <div className="aad-kpi">
          <span className="aad-kpi-value aad-green">{metrics.netOut.toLocaleString()}</span>
          <span className="aad-kpi-label">Net Out</span>
        </div>
        <div className="aad-kpi">
          <span className={`aad-kpi-value ${metrics.clawbackRate > 15 ? 'aad-red' : 'aad-amber'}`}>
            {metrics.clawbackRate.toFixed(1)}%
          </span>
          <span className="aad-kpi-label">Clawback Rate</span>
        </div>
        <div className="aad-kpi">
          <span className="aad-kpi-value">
            {Math.round(metrics.avgDistribution).toLocaleString()}
          </span>
          <span className="aad-kpi-label">Avg Per Txn</span>
        </div>
      </div>

      {/* Secondary stats */}
      <div className="aad-secondary">
        <div className="aad-sec-item">
          <span className="aad-sec-label">Distributions/Day (30D)</span>
          <span className="aad-sec-value">{metrics.perDay.toFixed(1)}</span>
        </div>
        <div className="aad-sec-item">
          <span className="aad-sec-label">Promo Distributions</span>
          <span className="aad-sec-value">{metrics.promoCount}</span>
        </div>
        <div className="aad-sec-item">
          <span className="aad-sec-label">Regular Distributions</span>
          <span className="aad-sec-value">{metrics.regularCount}</span>
        </div>
        <div className="aad-sec-item">
          <span className="aad-sec-label">Total Transactions</span>
          <span className="aad-sec-value">{metrics.totalCount}</span>
        </div>
      </div>

      {/* Weekly volume bars */}
      <div className="aad-chart-section">
        <h4 className="aad-chart-title">Weekly Volume (8 Weeks)</h4>
        <div className="aad-bars">
          {weeklyVolume.map((w, i) => (
            <div key={i} className="aad-bar-col">
              <div className="aad-bar-wrapper">
                <div
                  className="aad-bar"
                  style={{ height: `${Math.max((w.amount / maxWeekly) * 100, 2)}%` }}
                  title={`${w.amount.toLocaleString()} Chips (${w.count} Txns)`}
                />
              </div>
              <span className="aad-bar-label">{w.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Top recipients */}
      {topRecipients.length > 0 && (
        <div className="aad-top-section">
          <h4 className="aad-chart-title">Top Recipients</h4>
          {topRecipients.map((r, i) => (
            <div key={r.id} className="aad-top-row">
              <span className="aad-top-rank">#{i + 1}</span>
              <span className="aad-top-id">{r.id.slice(0, 8)}…</span>
              <span className="aad-top-amount">{r.total.toLocaleString()}</span>
              <span className="aad-top-count">{r.count} Txns</span>
              {r.clawed > 0 && <span className="aad-top-clawed">{r.clawed} ↩</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

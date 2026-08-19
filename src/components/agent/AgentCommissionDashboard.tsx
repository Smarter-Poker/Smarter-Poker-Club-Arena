/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT COMMISSION DASHBOARD — Track Agent Earnings
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useStaggerAnimation } from '../../hooks/useStaggerAnimation';
import { supabase } from '../../lib/supabase';
import { retryAsync } from '../../utils/retryAsync';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import './AgentCommissionDashboard.css';
import { reportError } from '../../utils/errorReporter';

interface CommissionSummary {
  totalEarned: number;
  thisWeek: number;
  thisMonth: number;
  pendingPayout: number;
  lastPayout: Date | null;
}

interface CommissionRecord {
  id: string;
  playerId: string;
  playerName: string;
  amount: number;
  rakeAmount: number;
  commissionRate: number;
  createdAt: Date;
  tableId?: string;
  tableName?: string;
}

interface SubAgent {
  id: string;
  username: string;
  avatarUrl: string;
  totalPlayers: number;
  totalCommission: number;
  commissionRate: number;
  joinedAt: Date;
}

export function AgentCommissionDashboard() {
  const isMounted = useIsMounted();
  const { user } = useAuthUser();
  const toast = useToast();

  const [summary, setSummary] = useState<CommissionSummary | null>(null);
  const [records, setRecords] = useState<CommissionRecord[]>([]);
  const [subAgents, setSubAgents] = useState<SubAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'summary' | 'records' | 'subagents'>('summary');

  // Stagger animations for each tab
  const { style: summaryStyle } = useStaggerAnimation(summary ? 4 : 0);
  const { style: recordsStyle } = useStaggerAnimation(records.length);
  const { style: subagentsStyle } = useStaggerAnimation(subAgents.length);

  useEffect(() => {
    if (user?.id) {
      loadData();
    }
  }, [user?.id]);

  // ── Real-time bus listeners for commission updates ──
  const loadDataRef = useRef<() => void>(() => {});
  useEffect(() => {
    loadDataRef.current = loadData;
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;

    // Postgres Changes: live commission_records updates
    const channelKey = `agent-commission-live-${user.id}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'commission_records',
          filter: `agent_id=eq.${user.id}`,
        },
        () => loadDataRef.current()
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'wallets',
          filter: `user_id=eq.${user.id}`,
        },
        () => loadDataRef.current()
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err)
            reportError(err?.message || err, 'AgentCommissionDashboard._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[AgentCommissionDashboard] Realtime channel timed out');
        }
      });

    // Bus event: BALANCE_UPDATED from engine
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadDataRef.current();
      },
      500
    );

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      unsubBalance();
    };
  }, [user?.id]);

  const loadData = async () => {
    if (!user?.id) return;
    setLoading(true);

    try {
      // Load commission summary
      const { data: summaryData, error: summaryErr } = await supabase.rpc(
        'fn_get_agent_commission_summary',
        { p_agent_id: user.id }
      );
      if (summaryErr) reportError(summaryErr, 'AgentCommissionDashboard.Summary_RPC_failed');

      if (summaryData) {
        setSummary({
          totalEarned: summaryData.total_earned || 0,
          thisWeek: summaryData.this_week || 0,
          thisMonth: summaryData.this_month || 0,
          pendingPayout: summaryData.pending_payout || 0,
          lastPayout: summaryData.last_payout ? new Date(summaryData.last_payout) : null,
        });
      }

      // Load recent records
      // commission_records schema: id, agent_id, period_id, gross_rake, commission_rate, commission_amount, status, paid_at, created_at, updated_at
      const { data: recordsData } = await supabase
        .from('commission_records')
        .select(
          'id, agent_id, period_id, gross_rake, commission_rate, commission_amount, status, created_at'
        )
        .eq('agent_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (recordsData) {
        setRecords(
          recordsData.map((r: any) => ({
            id: r.id,
            playerId: r.period_id || '',
            playerName: r.status || 'pending',
            amount: r.commission_amount || 0,
            rakeAmount: r.gross_rake || 0,
            commissionRate: r.commission_rate || 0,
            createdAt: new Date(r.created_at),
            tableId: undefined,
            tableName: undefined,
          }))
        );
      }

      // Load sub-agents
      // parent_agent_id stores agents.id PK (FK), NOT auth.users.id
      // Must resolve current user's agent PK first
      const { data: myAgent } = await supabase
        .from('agents')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

      const { data: subAgentsData } = myAgent
        ? await supabase
            .from('agents')
            .select('id, user_id, total_players, pending_commission, commission_rate, created_at')
            .eq('parent_agent_id', myAgent.id)
        : { data: null };

      if (subAgentsData) {
        // Batch-fetch sub-agent profiles (no FK hint needed)
        const subAgentUserIds = subAgentsData.map((a: any) => a.user_id).filter(Boolean);
        const subProfileMap: Record<string, { display_name?: string; avatar_url?: string }> = {};
        if (subAgentUserIds.length > 0) {
          try {
            const { data: profiles } = await supabase
              .from('profiles')
              .select('id, display_name, avatar_url')
              .in('id', subAgentUserIds);
            if (profiles) {
              for (const p of profiles) subProfileMap[p.id] = p;
            }
          } catch (e) {
            reportError(e, 'AgentCommissionDashboard.map');
            /* non-critical */
          }
        }

        setSubAgents(
          subAgentsData.map((a: any) => ({
            id: a.id,
            username:
              subProfileMap[a.user_id]?.display_name || a.user_id?.substring(0, 8) || 'Unknown',
            avatarUrl: subProfileMap[a.user_id]?.avatar_url || '',
            totalPlayers: a.total_players || 0,
            totalCommission: a.pending_commission || 0,
            commissionRate: a.commission_rate || 0,
            joinedAt: new Date(a.created_at),
          }))
        );
      }
    } catch (error) {
      if (isMounted.current) toast.error('Failed to load commission data');
    }

    if (isMounted.current) setLoading(false);
  };

  const requestPayout = () => {
    // Agent commissions are not paid on-demand — they accrue (pending_commission /
    // agent_commissions) and are disbursed automatically at the weekly settlement.
    // There is no request-payout RPC; give the agent clear feedback instead of a
    // silently-dead button.
    if (isMounted.current) {
      toast.info('Commissions are paid out automatically at the weekly settlement.');
    }
  };

  if (loading) {
    return (
      <div className="agent-commission">
        <div className="loading-state">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className="agent-commission">
      {/* Tabs */}
      <div className="agent-commission__tabs">
        <button
          className={activeTab === 'summary' ? 'active' : ''}
          onClick={() => setActiveTab('summary')}
        >
          Summary
        </button>
        <button
          className={activeTab === 'records' ? 'active' : ''}
          onClick={() => setActiveTab('records')}
        >
          Records
        </button>
        <button
          className={activeTab === 'subagents' ? 'active' : ''}
          onClick={() => setActiveTab('subagents')}
        >
          Sub-Agents
        </button>
      </div>

      {/* Summary Tab */}
      {activeTab === 'summary' && summary && (
        <div className="agent-commission__summary">
          {[
            { className: 'total', label: 'Total Earned', value: summary.totalEarned },
            { className: '', label: 'This Week', value: summary.thisWeek },
            { className: '', label: 'This Month', value: summary.thisMonth },
            { className: 'pending', label: 'Pending Payout', value: summary.pendingPayout },
          ].map((card, idx) => (
            <div key={idx} className={`summary-card ${card.className}`} style={summaryStyle(idx)}>
              <span className="label">{card.label}</span>
              <span className="value">{card.value.toLocaleString()}</span>
              {card.className === 'pending' && summary.pendingPayout > 0 && (
                <button className="payout-btn" onClick={requestPayout}>
                  Request Payout
                </button>
              )}
            </div>
          ))}

          {/* Commission Waterfall Visualization */}
          {summary.totalEarned > 0 && (
            <div
              style={{
                gridColumn: '1 / -1',
                padding: '16px',
                background: 'rgba(255,255,255,0.03)',
                borderRadius: '12px',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <h4
                style={{
                  margin: '0 0 12px',
                  fontSize: '0.8rem',
                  color: 'rgba(255,255,255,0.6)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                Commission Flow
              </h4>
              {[
                { label: 'Total Earned', value: summary.totalEarned, color: '#10b981', pct: 100 },
                {
                  label: 'This Month',
                  value: summary.thisMonth,
                  color: '#3b82f6',
                  pct:
                    summary.totalEarned > 0 ? (summary.thisMonth / summary.totalEarned) * 100 : 0,
                },
                {
                  label: 'This Week',
                  value: summary.thisWeek,
                  color: '#8b5cf6',
                  pct: summary.totalEarned > 0 ? (summary.thisWeek / summary.totalEarned) * 100 : 0,
                },
                {
                  label: 'Pending',
                  value: summary.pendingPayout,
                  color: '#f59e0b',
                  pct:
                    summary.totalEarned > 0
                      ? (summary.pendingPayout / summary.totalEarned) * 100
                      : 0,
                },
              ].map((tier, i) => (
                <div key={tier.label} style={{ marginBottom: i < 3 ? '8px' : 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '0.75rem',
                      marginBottom: '4px',
                    }}
                  >
                    <span style={{ color: 'rgba(255,255,255,0.5)' }}>{tier.label}</span>
                    <span style={{ color: tier.color, fontWeight: 600 }}>
                      {tier.value.toLocaleString()}
                    </span>
                  </div>
                  <div
                    style={{
                      height: '6px',
                      background: 'rgba(255,255,255,0.05)',
                      borderRadius: '3px',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.max(tier.pct, 2)}%`,
                        background: tier.color,
                        borderRadius: '3px',
                        transition: 'width 0.8s cubic-bezier(0.4, 0, 0.2, 1)',
                      }}
                    />
                  </div>
                </div>
              ))}

              {/* Month-over-month indicator */}
              {summary.thisMonth > 0 && summary.thisWeek > 0 && (
                <div
                  style={{
                    marginTop: '12px',
                    padding: '8px 12px',
                    background: 'rgba(255,255,255,0.03)',
                    borderRadius: '8px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: '0.75rem',
                  }}
                >
                  <span style={{ color: 'rgba(255,255,255,0.5)' }}>Weekly Avg</span>
                  <span style={{ color: '#10b981', fontWeight: 600 }}>
                    {(summary.thisMonth / 4).toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}{' '}
                    / week
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Records Tab */}
      {activeTab === 'records' && (
        <div className="agent-commission__records">
          {records.length === 0 ? (
            <div className="empty-state">No commission records yet</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Gross Rake</th>
                  <th>Rate</th>
                  <th>Commission</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record, idx) => (
                  <tr key={record.id} style={recordsStyle(idx)}>
                    <td>
                      <span
                        style={{
                          textTransform: 'capitalize',
                          color:
                            record.playerName === 'paid'
                              ? '#10b981'
                              : record.playerName === 'pending'
                                ? '#f59e0b'
                                : 'inherit',
                        }}
                      >
                        {record.playerName}
                      </span>
                    </td>
                    <td>{record.rakeAmount.toLocaleString()}</td>
                    <td>{(record.commissionRate * 100).toFixed(1)}%</td>
                    <td className="commission">{record.amount.toLocaleString()}</td>
                    <td>{record.createdAt.toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Sub-Agents Tab */}
      {activeTab === 'subagents' && (
        <div className="agent-commission__subagents">
          {subAgents.length === 0 ? (
            <div className="empty-state">No sub-agents yet</div>
          ) : (
            <div className="subagent-grid">
              {subAgents.map((agent, idx) => (
                <div key={agent.id} className="subagent-card" style={subagentsStyle(idx)}>
                  <span className="avatar">{agent.avatarUrl}</span>
                  <div className="info">
                    <span className="name">{agent.username}</span>
                    <span className="stats">
                      {agent.totalPlayers} players • {(agent.commissionRate * 100).toFixed(0)}% rate
                    </span>
                  </div>
                  <span className="earnings">{agent.totalCommission.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AgentCommissionDashboard;

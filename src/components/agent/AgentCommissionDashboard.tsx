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
import { CommissionService } from '../../services/CommissionService';

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

export function AgentCommissionDashboard({ clubId }: { clubId?: string } = {}) {
  const isMounted = useIsMounted();
  const { user } = useAuthUser();
  const toast = useToast();

  const [summary, setSummary] = useState<CommissionSummary | null>(null);
  const [records, setRecords] = useState<CommissionRecord[]>([]);
  const [subAgents, setSubAgents] = useState<SubAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'summary' | 'records' | 'subagents'>('summary');

  // WHAT THIS AGENT IS ACTUALLY OWED, read from agent_commissions rather than
  // agents.pending_commission - a column written by no function and no trigger
  // anywhere in the database. On 2026-08-31 it claimed 26,859.87 owed across 5
  // agents while the ledger held 394,904.61 across 96.
  const [owed, setOwed] = useState<number | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimProgress, setClaimProgress] = useState<number>(0);

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
      // 2026-08-24: the `wallets` (user_id=eq.<uid>) listener that sat here is
      // gone. PostgresSyncHooks' `global_db_sync:<userId>` channel already
      // carries that exact listener - same table, same filter - created once at
      // sign-in and never torn down by navigation, and it emits BALANCE_UPDATED.
      // The bus subscriber further down already calls loadDataRef.current() on
      // BALANCE_UPDATED, so the refresh is unchanged and one duplicate
      // subscription per mount disappears.
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

      // The real outstanding figure, per club. Cheap enough for a page load
      // (one indexed sum) and deliberately not inside the claim itself, where
      // it cost 1,474ms of an 8 second budget.
      if (clubId && user?.id) {
        try {
          const amount = await CommissionService.unsettledCommission(clubId, user.id);
          if (isMounted.current) setOwed(amount);
        } catch (e) {
          reportError(e, 'AgentCommissionDashboard.unsettled');
          if (isMounted.current) setOwed(null);
        }
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
              .select('id, display_name, avatar_url:arena_avatar_url')
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

  /**
   * CLAIM IT.
   *
   * This button used to tell the agent "Commissions are paid out automatically
   * at the weekly settlement." Nothing paid them out - no function, no cron, no
   * settlement job. It was a reassuring sentence in front of 394,904.61 chips
   * that had been sitting unclaimed since April.
   *
   * fn_agent_claim_commission pays the caller from the club bank and marks the
   * rows settled. It works in batches, so this reports progress rather than
   * appearing to hang: the largest agent has 192,135 rows to stamp.
   */
  const claimPayout = async () => {
    if (!clubId || claiming) return;
    setClaiming(true);
    setClaimProgress(0);
    try {
      const { claimed, stoppedEarly, reason } = await CommissionService.claimCommission(
        clubId,
        (soFar) => {
          if (isMounted.current) setClaimProgress(soFar);
        }
      );
      if (!isMounted.current) return;
      if (claimed > 0) {
        toast.success(`${claimed.toLocaleString()} Chips Are Now In Your Balance`);
      }
      if (stoppedEarly) {
        toast.info(reason || 'Some Commission Is Still Owed. Claim Again To Continue.');
      }
      await loadData();
    } catch (e) {
      reportError(e, 'AgentCommissionDashboard.claim');
      if (isMounted.current) {
        // The server's own sentence, which names the shortfall when the club
        // bank cannot cover the claim.
        toast.error(e instanceof Error ? e.message : 'The Claim Was Refused');
      }
    } finally {
      if (isMounted.current) {
        setClaiming(false);
        setClaimProgress(0);
      }
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
            {
              className: 'pending',
              label: 'Unclaimed Commission',
              value: owed ?? summary.pendingPayout,
            },
          ].map((card, idx) => (
            <div key={idx} className={`summary-card ${card.className}`} style={summaryStyle(idx)}>
              <span className="label">{card.label}</span>
              <span className="value">{card.value.toLocaleString()}</span>
              {card.className === 'pending' && (owed ?? 0) > 0 && (
                <button
                  className="payout-btn"
                  onClick={claimPayout}
                  disabled={claiming || !clubId}
                  title={!clubId ? 'Open This From A Club To Claim' : undefined}
                >
                  {claiming ? `Claiming... ${claimProgress.toLocaleString()}` : 'Claim Commission'}
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
                    / Week
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
            <div className="empty-state">No Commission Records Yet</div>
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
            <div className="empty-state">No Sub-Agents Yet</div>
          ) : (
            <div className="subagent-grid">
              {subAgents.map((agent, idx) => (
                <div key={agent.id} className="subagent-card" style={subagentsStyle(idx)}>
                  <span className="avatar">{agent.avatarUrl}</span>
                  <div className="info">
                    <span className="name">{agent.username}</span>
                    <span className="stats">
                      {agent.totalPlayers} Players • {(agent.commissionRate * 100).toFixed(0)}% Rate
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

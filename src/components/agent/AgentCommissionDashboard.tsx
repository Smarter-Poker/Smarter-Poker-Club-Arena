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

    // Postgres Changes: live commission updates.
    //
    // PHASE 7. This listened to commission_records, filtered on agent_id. That
    // table held zero rows on the day it was dropped and was never in the
    // supabase_realtime publication, so this subscription could not fire even
    // if a row had ever been written to it. agent_commissions is the ledger the
    // engine writes as hands settle, it IS in the publication, and its rows are
    // keyed by the auth user id.
    const channelKey = `agent-commission-live-${user.id}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_commissions',
          filter: `user_id=eq.${user.id}`,
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
      // Load commission summary.
      //
      // PHASE 7. Until this phase fn_get_agent_commission_summary was a stub
      // whose entire body was "return zeros" - and it RETURNED TABLE, which
      // reaches PostgREST as an array, so summaryData.total_earned was
      // undefined and every one of these four cards rendered 0 for every agent
      // on the platform. It answers from agent_commissions now, in chips rather
      // than whole numbers, and scoped to the club being looked at when there
      // is one.
      const { data: summaryData, error: summaryErr } = await supabase.rpc(
        'fn_get_agent_commission_summary',
        { p_agent_id: user.id, p_club_id: clubId ?? null }
      );
      if (summaryErr) reportError(summaryErr, 'AgentCommissionDashboard.Summary_RPC_failed');

      if (summaryData) {
        setSummary({
          totalEarned: Number(summaryData.total_earned) || 0,
          thisWeek: Number(summaryData.this_week) || 0,
          thisMonth: Number(summaryData.this_month) || 0,
          pendingPayout: Number(summaryData.pending_payout) || 0,
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

      // Load recent records.
      //
      // PHASE 7. These came from commission_records, a table that never held a
      // row, so this tab said "No Commission Records Yet" to agents with tens of
      // thousands of them. agent_commissions is the ledger: one row per piece of
      // rake, keyed by the auth user id, and RLS lets the agent read their own
      // and nobody else's. settled_at is what says whether it has been claimed;
      // there is no status column and there does not need to be.
      let recordsQuery = supabase
        .from('agent_commissions')
        .select('id, club_id, amount, source_type, source_id, notes, created_at, settled_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (clubId) recordsQuery = recordsQuery.eq('club_id', clubId);

      const { data: recordsData, error: recordsErr } = await recordsQuery;
      if (recordsErr) reportError(recordsErr, 'AgentCommissionDashboard.Records_load_failed');

      if (recordsData) {
        setRecords(
          recordsData.map((r: any) => ({
            id: r.id,
            playerId: r.source_id || '',
            playerName: r.settled_at ? 'claimed' : 'unclaimed',
            amount: Number(r.amount) || 0,
            rakeAmount: 0,
            commissionRate: 0,
            createdAt: new Date(r.created_at),
            tableId: undefined,
            tableName: r.source_type || undefined,
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
            .select('id, user_id, total_players, commission_rate, created_at')
            .eq('parent_agent_id', myAgent.id)
        : { data: null };

      // PHASE 7. What each downline is owed comes from the ledger, through a
      // definer function, because RLS on agent_commissions lets an agent read
      // THEIR OWN rows and nobody else's - which is right, and is why this
      // cannot be a select. It used to be agents.pending_commission, a column
      // nothing wrote, so this column of the tab was zeros.
      //
      // 2026-09-01: another change landed on main the same afternoon that fixed
      // this by looping fn_agent_unsettled_commission once per downline. Same
      // symptom, and it worked. This shape is kept over it for two reasons: it
      // is one round trip rather than one per sub agent, and it asks a function
      // that answers ONLY for the caller's own downline, rather than one that
      // will report any user id it is handed.
      const downlineOwed: Record<string, number> = {};
      if (myAgent) {
        try {
          for (const row of await CommissionService.downlineCommission(clubId)) {
            downlineOwed[row.agentId] = row.unclaimed;
          }
        } catch (e) {
          reportError(e, 'AgentCommissionDashboard.downline');
        }
      }

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
            totalCommission: downlineOwed[a.id] || 0,
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
            /* PHASE 7. Gross Rake and Rate are gone from this table rather
               than being filled with zeros. A commission row records the
               amount earned and what it came from; the rake behind it and the
               rate applied at the time are not on the row, and printing 0 and
               0.0% for them is the same class of thing this phase exists to
               remove. */
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Source</th>
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
                          color: record.playerName === 'claimed' ? '#10b981' : '#f59e0b',
                        }}
                      >
                        {record.playerName}
                      </span>
                    </td>
                    <td style={{ textTransform: 'capitalize' }}>
                      {(record.tableName || 'rake').replace(/_/g, ' ')}
                    </td>
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
                  {/* Unclaimed, not lifetime: what the club still owes this
                      downline, which is the figure their upline can act on. */}
                  <span className="earnings" title="Unclaimed Commission">
                    {agent.totalCommission.toLocaleString()}
                  </span>
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

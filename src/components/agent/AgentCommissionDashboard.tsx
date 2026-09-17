/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT COMMISSION DASHBOARD — Track Agent Earnings
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useStaggerAnimation } from '../../hooks/useStaggerAnimation';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import './AgentCommissionDashboard.css';
import { reportError } from '../../utils/errorReporter';
import { CommissionService } from '../../services/CommissionService';
import { leaveForHub } from '../../lib/openExternal';
import { resolveClubUUIDStrict } from '../../utils/clubIdResolver';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../../utils/playerDisplayName';

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
  /** Unclaimed commission. `null` means the read failed, NOT that it is zero. */
  totalCommission: number | null;
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
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);
  const [readError, setReadError] = useState(false);
  const [recordsUnavailable, setRecordsUnavailable] = useState(false);
  const [subAgentsError, setSubAgentsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'summary' | 'records' | 'subagents'>('summary');

  // WHAT THIS AGENT IS ACTUALLY OWED, read from agent_commissions rather than
  // agents.pending_commission - a column written by no function and no trigger
  // anywhere in the database. On 2026-08-31 it claimed 26,859.87 owed across 5
  // agents while the ledger held 394,904.61 across 96.
  const [owed, setOwed] = useState<number | null>(null);
  const readScope = `${user?.id || ''}:${clubId || ''}`;
  const readScopeRef = useRef(readScope);
  readScopeRef.current = readScope;
  const readGeneration = useRef(0);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);

  // Stagger animations for each tab
  const { style: summaryStyle } = useStaggerAnimation(summary ? 4 : 0);
  const { style: recordsStyle } = useStaggerAnimation(records.length);
  const { style: subagentsStyle } = useStaggerAnimation(subAgents.length);

  useEffect(() => {
    if (user?.id) {
      loadData();
    }
  }, [user?.id, clubId]);

  // ── Real-time bus listeners for commission updates ──
  const loadDataRef = useRef<() => void>(() => {});
  useEffect(() => {
    loadDataRef.current = loadData;
  }, [user?.id, clubId]);

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
    const scope = readScope;
    const generation = ++readGeneration.current;
    const current = () =>
      isMounted.current && readScopeRef.current === scope && readGeneration.current === generation;
    setLoading(true);
    setSummary(null);
    setOwed(null);
    setRecords([]);
    setSubAgents([]);
    setResolvedClubId(null);
    setReadError(false);
    setRecordsUnavailable(false);
    setSubAgentsError(null);

    try {
      // Routes may contain a numeric club number or slug. Financial readers and
      // Messenger require the authoritative UUID; a failed lookup must not widen
      // the request to every club or send the friendly identifier to a UUID RPC.
      const canonicalClubId = clubId ? await resolveClubUUIDStrict(clubId) : null;
      if (!current()) return;
      setResolvedClubId(canonicalClubId);

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
        { p_agent_id: user.id, p_club_id: canonicalClubId }
      );
      if (!current()) return;
      if (summaryErr) reportError(summaryErr, 'AgentCommissionDashboard.Summary_RPC_failed');

      const summaryAmounts = ['total_earned', 'this_week', 'this_month', 'pending_payout'];
      if (
        !summaryErr &&
        summaryData &&
        summaryAmounts.every(
          (key) =>
            (typeof summaryData[key] === 'number' || typeof summaryData[key] === 'string') &&
            String(summaryData[key]).trim() !== '' &&
            Number.isFinite(Number(summaryData[key]))
        )
      ) {
        setSummary({
          totalEarned: Number(summaryData.total_earned) || 0,
          thisWeek: Number(summaryData.this_week) || 0,
          thisMonth: Number(summaryData.this_month) || 0,
          pendingPayout: Number(summaryData.pending_payout) || 0,
          lastPayout: summaryData.last_payout ? new Date(summaryData.last_payout) : null,
        });
      }

      // The real outstanding figure, per club. Cheap enough for a page load
      // (one indexed sum). Settlement remains exclusively server scheduled.
      if (canonicalClubId) {
        try {
          const amount = await CommissionService.unsettledCommission(canonicalClubId, user.id);
          if (current()) setOwed(amount);
        } catch (e) {
          reportError(e, 'AgentCommissionDashboard.unsettled');
          if (current()) setOwed(null);
        }
      }

      if (!current()) return;

      // Load recent records.
      //
      // PHASE 7. These came from commission_records, a table that never held a
      // row, so this tab said "No Commission Records Yet" to agents with tens of
      // thousands of them. agent_commissions is the ledger: one row per piece of
      // rake, keyed by the auth user id, and RLS lets the agent read their own
      // and nobody else's.
      //
      // IT READS v_agent_commissions, NOT THE TABLE. Since 20260908025653 a row
      // can be paid without its own settled_at ever being written: round 2
      // records the period it covered in agent_commission_settlements instead
      // of stamping two million rows. The view is the reader that knows both
      // mechanisms - settled_at is COALESCE(own stamp, the settlement's paid_at)
      // and settled_via says which one paid it. Reading the bare table here
      // showed money the agent HAS been paid as 'unclaimed'.
      let recordsQuery = supabase
        .from('v_agent_commissions')
        .select(
          'id, club_id, amount, source_type, source_id, notes, created_at, settled_at, settled_via'
        )
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (canonicalClubId) recordsQuery = recordsQuery.eq('club_id', canonicalClubId);

      const { data: recordsData, error: recordsErr } = await recordsQuery;
      if (!current()) return;
      if (recordsErr || !Array.isArray(recordsData)) {
        setRecordsUnavailable(true);
        reportError(
          recordsErr || new Error('Commission Records Are Unavailable'),
          'AgentCommissionDashboard.Records_load_failed'
        );
      } else {
        setRecords(
          recordsData.map((r: any) => ({
            id: r.id,
            playerId: r.source_id || '',
            playerName: r.settled_at ? 'paid' : 'unpaid',
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
      // Resolve the current user's agent PK in this club. An agent can belong
      // to several clubs, so a user-only maybeSingle can fail or select wrongly.
      if (!canonicalClubId) return;
      const { data: myAgent, error: myAgentError } = await supabase
        .from('agents')
        .select('id')
        .eq('user_id', user.id)
        .eq('club_id', canonicalClubId)
        .maybeSingle();

      if (!current()) return;
      if (myAgentError) {
        setSubAgentsError('Your Sub-Agents Could Not Be Loaded.');
        reportError(myAgentError, 'AgentCommissionDashboard.Agent_load_failed');
        return;
      }
      if (!myAgent) return;
      const { data: subAgentsData, error: subAgentsErr } = await supabase
        .from('agents')
        .select('id, user_id, total_players, commission_rate, created_at')
        .eq('parent_agent_id', myAgent.id)
        .eq('club_id', canonicalClubId);
      if (!current()) return;
      if (subAgentsErr || !Array.isArray(subAgentsData)) {
        setSubAgentsError('Your Sub-Agents Could Not Be Loaded.');
        reportError(
          subAgentsErr || new Error('Sub-Agents Are Unavailable'),
          'AgentCommissionDashboard.SubAgents_load_failed'
        );
        return;
      }

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
      // PHASE 7 AUDIT (2026-09-02). `downlineFailed` exists because the catch
      // below used to leave downlineOwed empty, and every sub agent card then
      // rendered `0` - "the club owes this downline nothing" - which is
      // indistinguishable from the truth and is exactly the class of lie the
      // rest of this phase removed. A failed read renders Unavailable now.
      let downlineFailed = false;
      if (myAgent) {
        try {
          for (const row of await CommissionService.downlineCommission(canonicalClubId)) {
            downlineOwed[row.agentId] = row.unclaimed;
          }
          if (subAgentsData.some((agent: any) => downlineOwed[agent.id] === undefined)) {
            throw new Error('Sub-Agent Commission Response Is Incomplete');
          }
        } catch (e) {
          downlineFailed = true;
          reportError(e, 'AgentCommissionDashboard.downline');
        }
      }

      if (!current()) return;
      if (downlineFailed) setSubAgentsError('Sub-Agent Commission Balances Could Not Be Loaded.');
      if (subAgentsData) {
        // Batch-fetch sub-agent profiles (no FK hint needed)
        const subAgentUserIds = subAgentsData.map((a: any) => a.user_id).filter(Boolean);
        const subProfileMap: Record<string, { display_name?: string; avatar_url?: string }> = {};
        if (subAgentUserIds.length > 0) {
          try {
            const { data: profiles, error: profilesError } = await supabase
              .from('profiles')
              .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
              .in('id', subAgentUserIds);
            if (!current()) return;
            if (profilesError) throw profilesError;
            if (profiles) {
              for (const p of profiles) subProfileMap[p.id] = p;
            }
          } catch (e) {
            reportError(e, 'AgentCommissionDashboard.map');
            if (current()) setSubAgentsError('Sub-Agent Details Could Not Be Loaded.');
          }
        }

        if (!current()) return;
        setSubAgents(
          subAgentsData.map((a: any) => ({
            id: a.id,
            username: playerDisplayName(subProfileMap[a.user_id]),
            avatarUrl: subProfileMap[a.user_id]?.avatar_url || '',
            totalPlayers: a.total_players || 0,
            totalCommission: downlineFailed ? null : (downlineOwed[a.id] ?? null),
            commissionRate: a.commission_rate || 0,
            joinedAt: new Date(a.created_at),
          }))
        );
      }
    } catch (error) {
      reportError(error, 'AgentCommissionDashboard.load');
      if (current()) {
        setReadError(true);
        toast.error('Failed To Load Commission Data');
      }
    } finally {
      if (current()) {
        setLoadedScope(scope);
        setLoading(false);
      }
    }
  };

  const pendingCommission = clubId ? owed : (summary?.pendingPayout ?? null);

  if (!user?.id) {
    return (
      <div className="agent-commission">
        <p>Sign In To View Your Commission</p>
      </div>
    );
  }

  if (loading || loadedScope !== readScope) {
    return (
      <div className="agent-commission">
        <div className="loading-state">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  if (readError) {
    return (
      <div className="agent-commission empty-state" role="alert">
        <p>Your Commission Data Could Not Be Loaded.</p>
        <button className="payout-btn" onClick={() => loadDataRef.current()}>
          Try Again
        </button>
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

      {activeTab === 'summary' && (
        <section className="summary-card" aria-label="Automatic Weekly Settlement">
          <h3>Automatic Weekly Settlement</h3>
          <p>Scheduled Every Monday At 4:00 AM Central Time.</p>
          <p>Unpaid Commission Remains Outstanding Until A Verified Transfer Is Recorded.</p>
          {resolvedClubId && (
            <button
              className="payout-btn"
              onClick={() =>
                leaveForHub(
                  `/hub/messenger?clubId=${encodeURIComponent(resolvedClubId)}&folder=invoices`
                )
              }
            >
              View Invoices
            </button>
          )}
        </section>
      )}

      {/* Summary Tab */}
      {activeTab === 'summary' && summary && (
        <div className="agent-commission__summary">
          {[
            { className: 'total', label: 'Total Earned', value: summary.totalEarned },
            { className: '', label: 'This Week', value: summary.thisWeek },
            { className: '', label: 'This Month', value: summary.thisMonth },
            {
              className: 'pending',
              label: 'Unpaid Commission',
              value: pendingCommission,
            },
          ].map((card, idx) => (
            <div key={idx} className={`summary-card ${card.className}`} style={summaryStyle(idx)}>
              <span className="label">{card.label}</span>
              <span className="value">
                {card.value === null ? 'Unavailable' : card.value.toLocaleString()}
              </span>
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
                  value: pendingCommission,
                  color: '#f59e0b',
                  pct:
                    summary.totalEarned > 0 && pendingCommission !== null
                      ? (pendingCommission / summary.totalEarned) * 100
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
                      {tier.value === null ? 'Unavailable' : tier.value.toLocaleString()}
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

      {/* PHASE 7 AUDIT. The Summary panel is gated on `summary &&`, which is
          right - a failed read must never render four zero cards, because a
          zero on this screen means "you earned nothing" and the agent cannot
          tell it from "we could not ask". But the gate rendered NOTHING at
          all: a blank tab with no explanation and no way back. Say what
          happened and offer the retry. */}
      {activeTab === 'summary' && !summary && (
        <div className="empty-state">
          <p>Your Commission Summary Could Not Be Loaded.</p>
          <button className="payout-btn" onClick={() => loadDataRef.current()}>
            Try Again
          </button>
        </div>
      )}

      {/* Records Tab */}
      {activeTab === 'records' && (
        <div className="agent-commission__records">
          {recordsUnavailable ? (
            <div className="empty-state" role="alert">
              <p>Your Commission Records Could Not Be Loaded.</p>
              <button className="payout-btn" onClick={() => loadDataRef.current()}>
                Try Again
              </button>
            </div>
          ) : records.length === 0 ? (
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
                          color: record.playerName === 'paid' ? '#10b981' : '#f59e0b',
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
          {subAgentsError && (
            <div className="empty-state" role="alert">
              <p>{subAgentsError}</p>
              <button className="payout-btn" onClick={() => loadDataRef.current()}>
                Try Again
              </button>
            </div>
          )}
          {!resolvedClubId ? (
            <div className="empty-state">Select A Club To View Its Sub-Agents.</div>
          ) : subAgentsError && subAgents.length === 0 ? null : subAgents.length === 0 ? (
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
                  <span
                    className="earnings"
                    title={
                      agent.totalCommission === null
                        ? 'This Figure Could Not Be Loaded'
                        : 'Unpaid Commission'
                    }
                  >
                    {agent.totalCommission === null
                      ? 'Unavailable'
                      : agent.totalCommission.toLocaleString()}
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

/**
 * SUPER AGENT DASHBOARD — Agent Network Management with Live Updates
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useIsMounted } from '../hooks/useIsMounted';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { AgentService } from '../services/AgentService';
import type { Agent, AgentPlayer } from '../services/AgentService';
import { CommissionService } from '../services/CommissionService';
import type { CommissionSpread } from '../services/CommissionService';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { fmt } from '../utils/format';

/* The three agent roles, spelled the way an operator reads them. This list
   used to print the raw enum - a person saw "super_agent" where every other
   surface in the app says "Super Agent". */
const AGENT_ROLE_LABELS: Record<string, string> = {
  super_agent: 'Super Agent',
  agent: 'Agent',
  sub_agent: 'Sub-Agent',
};
import CreditRequestWidget from '../components/agent/CreditRequestWidget';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubUUID } from '../utils/clubIdResolver';
import './SuperAgentDashboard.css';
import { reportError } from '../utils/errorReporter';
import AgentBackOffice from '../components/agent/AgentBackOffice';

type DashboardTab = 'overview' | 'agents' | 'players' | 'commissions' | 'transfers' | 'backoffice';

export default function SuperAgentDashboard() {
  const navigate = useNavigate();
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();
  useVisibilityRefresh(() => {
    if (clubId && user?.id) loadDashboardData();
  });

  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const [agent, setAgent] = useState<Agent | null>(null);
  const [subAgents, setSubAgents] = useState<Agent[]>([]);
  const [players, setPlayers] = useState<AgentPlayer[]>([]);
  const [spread, setSpread] = useState<CommissionSpread | null>(null);
  const [loading, setLoading] = useState(true);
  /* Told apart from "you hold no agency here": see the catch in the loader. */
  const [loadFailed, setLoadFailed] = useState(false);

  const [transferPlayerId, setTransferPlayerId] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  const [visibleStatCards, setVisibleStatCards] = useState(new Set<number>());
  const [visibleAgentRows, setVisibleAgentRows] = useState(new Set<number>());
  const [visiblePlayerRows, setVisiblePlayerRows] = useState(new Set<number>());

  // Stagger stat cards on mount
  useEffect(() => {
    const timers = [0, 1, 2, 3].map((i) =>
      setTimeout(() => setVisibleStatCards((prev) => new Set([...prev, i])), i * 60)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  // Stagger agent rows
  useEffect(() => {
    setVisibleAgentRows(new Set());
    const timers = subAgents.map((_, i) =>
      setTimeout(() => setVisibleAgentRows((prev) => new Set([...prev, i])), i * 50)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [subAgents.length]);

  // Stagger player rows
  useEffect(() => {
    setVisiblePlayerRows(new Set());
    const timers = players.map((_, i) =>
      setTimeout(() => setVisiblePlayerRows((prev) => new Set([...prev, i])), i * 40)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [players.length]);

  useEffect(() => {
    if (clubId && user?.id) {
      loadDashboardData();

      // Real-time updates for agent activity
      let isMounted = true;
      const channelKey = 'super-agent-live';

      const setupRealtime = async () => {
        const resolvedId = await resolveClubUUID(clubId);
        if (!isMounted) return;

        const channel = masterBus.getOrCreateChannel(channelKey);
        channel
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'club_members',
              filter: `club_id=eq.${resolvedId}`,
            },
            () => loadDashboardData()
          )
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'chip_transactions',
              // DB LOAD PASS 2026-08-24: this had no filter, so every chip
              // movement anywhere on the platform was decoded and delivered to
              // every open super-agent dashboard, which then reloaded a view
              // that only ever shows THIS club. chip_transactions carries
              // club_id — scope to it, and do not widen it again.
              filter: `club_id=eq.${resolvedId}`,
            },
            () => loadDashboardData()
          )
          .subscribe((status: string, err?: Error) => {
            if (status === 'CHANNEL_ERROR') {
              if (err)
                reportError(err?.message || err, 'SuperAgentDashboard._Realtime_channel_error');
            }
            if (status === 'TIMED_OUT') {
              console.warn('[SuperAgentDashboard] Realtime channel timed out');
            }
          });
      };

      setupRealtime().catch((e) => console.warn('[SuperAgentDashboard] Realtime setup failed:', e));

      return () => {
        isMounted = false;
        masterBus.removeRegisteredChannel(channelKey);
      };
    }
  }, [clubId, user?.id]);

  // Bus event listeners for cross-component sync (debounced to prevent rapid-fire reloads)
  useEffect(() => {
    if (!clubId || !user?.id) return;
    const unsubWallet = masterBus.subscribeDebounced(
      'WALLET_REFRESHED',
      () => {
        loadDashboardData();
      },
      300
    );
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadDashboardData();
      },
      300
    );
    // Phase 4: Cross-page sync events (ported from World Hub agent-dashboard.js)
    const unsubCashoutApproved = masterBus.subscribeDebounced(
      'CASHOUT_APPROVED',
      () => loadDashboardData(),
      300
    );
    const unsubCashoutCancelled = masterBus.subscribeDebounced(
      'CASHOUT_CANCELLED',
      () => loadDashboardData(),
      300
    );
    const unsubCashoutReq = masterBus.subscribeDebounced(
      'CASHOUT_REQUESTED',
      () => loadDashboardData(),
      300
    );
    const unsubChips = masterBus.subscribeDebounced(
      'CHIPS_DISTRIBUTED',
      () => loadDashboardData(),
      300
    );
    const unsubAgent = masterBus.subscribeDebounced(
      'AGENT_UPDATED',
      () => loadDashboardData(),
      300
    );
    const unsubCredit = masterBus.subscribeDebounced(
      'CREDIT_UPDATED',
      () => loadDashboardData(),
      300
    );
    return () => {
      unsubWallet();
      unsubBalance();
      unsubCashoutApproved();
      unsubCashoutCancelled();
      unsubCashoutReq();
      unsubChips();
      unsubAgent();
      unsubCredit();
    };
  }, [clubId, user?.id]);

  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setActiveTab('overview');
    setTransferPlayerId('');
    setTransferAmount('');
    setIsTransferring(false);
    setVisibleStatCards(new Set());
    setVisibleAgentRows(new Set());
    setVisiblePlayerRows(new Set());
    loadingRef.current = false;
  }, [clubId]);

  const loadDashboardData = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const agents = await AgentService.getAgents(clubId!);
      if (!isMounted.current) return;
      const myAgent = agents.find((a) => a.userId === user?.id);
      if (myAgent) {
        setAgent(myAgent);
        setSubAgents(agents.filter((a) => a.parentAgentId === myAgent.id));
        const myPlayers =
          await /* Scoped to the club being viewed. Without it this list, the player count
             beside it and the transfer picker below all showed the agent's
             players from every club they hold an agents row in - while the
             transfer itself is scoped to THIS club, so an operator could send
             to a name that does not belong here. */
          AgentService.getAgentPlayers(myAgent.id, clubId!);
        if (!isMounted.current) return;
        setPlayers(myPlayers);
        const commSpread = await CommissionService.calculateSpread(myAgent.id);
        if (!isMounted.current) return;
        setSpread(commSpread);
      }
    } catch (error) {
      reportError(error, 'SuperAgentDashboard.Failed_to_load_dashboard');
      /* A FAILED READ IS NOT A VERDICT ON WHO YOU ARE. `agent` stays null when
         this throws, and the empty state below renders "You Are Not An Agent
         In This Club" - an accusation, for what is usually a network blip.
         The two are separated now. */
      if (isMounted.current) {
        setLoadFailed(true);
        toast.error('Failed to load dashboard data');
      }
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  };

  const handleTransfer = async () => {
    if (!agent || !transferPlayerId || !transferAmount) return;
    const amount = parseFloat(transferAmount);
    if (isNaN(amount) || amount <= 0) return;

    setIsTransferring(true);
    try {
      // The sender is no longer a parameter: fn_agent_wallet_send derives it
      // from auth.uid(). This used to pass agent.id - the agents-table ROW id -
      // where a user id was expected, so the transfer could never have landed.
      await AgentService.transferToPlayer(transferPlayerId, clubId!, amount);
      if (!isMounted.current) return;
      setTransferPlayerId('');
      if (isMounted.current)
        toast.success(`Transferred ${amount.toLocaleString()} chips successfully`);
      loadDashboardData();
    } catch (error) {
      reportError(error, 'SuperAgentDashboard.Transfer_failed');
      if (isMounted.current) toast.error('Transfer failed');
    }
    if (isMounted.current) setIsTransferring(false);
  };

  if (loading) {
    return (
      <div className="super-agent-dashboard">
        <PageSkeleton variant="dashboard" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="super-agent-dashboard">
        <div className="empty-state">
          <span className="empty-icon">♠</span>
          <p>
            {loadFailed
              ? 'Your Agent Details Could Not Be Loaded. This Is Not The Same As Holding No Agency Here.'
              : 'You Are Not An Agent In This Club'}
          </p>
          <button className="btn btn-primary" onClick={() => navigate(-1)}>
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="super-agent-dashboard">
      {/* Stats Grid */}
      <div className="stats-grid">
        <div
          className="stat-card"
          style={{
            opacity: visibleStatCards.has(0) ? 1 : 0,
            transform: visibleStatCards.has(0) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <span className="stat-icon">●</span>
          <div className="stat-info">
            <span className="stat-value">{fmt(agent.totalPlayers)}</span>
            <span className="stat-label">Total Players</span>
          </div>
        </div>
        <div
          className="stat-card"
          style={{
            opacity: visibleStatCards.has(1) ? 1 : 0,
            transform: visibleStatCards.has(1) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <span className="stat-icon">▶</span>
          <div className="stat-info">
            <span className="stat-value">{fmt(agent.activePlayerCount)}</span>
            <span className="stat-label">Active Now</span>
          </div>
        </div>
        <div
          className="stat-card"
          style={{
            opacity: visibleStatCards.has(2) ? 1 : 0,
            transform: visibleStatCards.has(2) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <span className="stat-icon">■</span>
          <div className="stat-info">
            <span className="stat-value">{fmt(agent.subAgentCount)}</span>
            <span className="stat-label">Sub-Agents</span>
          </div>
        </div>
        <div
          className="stat-card highlight"
          style={{
            opacity: visibleStatCards.has(3) ? 1 : 0,
            transform: visibleStatCards.has(3) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <span className="stat-icon">◉</span>
          <div className="stat-info">
            <span className="stat-value">{agent.weeklyRakeGenerated.toLocaleString()}</span>
            <span className="stat-label">Weekly Rake</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="dashboard-tabs">
        {(
          [
            'overview',
            'agents',
            'players',
            'commissions',
            'transfers',
            'backoffice',
          ] as DashboardTab[]
        ).map((tab) => (
          <button
            key={tab}
            className={activeTab === tab ? 'active' : ''}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'backoffice' ? 'Back Office' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="dashboard-content">
        {activeTab === 'overview' && (
          <div className="overview-section">
            <div className="balance-cards">
              <div className="balance-card">
                <span className="label">Business Balance</span>
                <span className="value">{agent.businessBalance.toLocaleString()}</span>
              </div>
              <div className="balance-card">
                <span className="label">Player Balance</span>
                <span className="value">{agent.playerBalance.toLocaleString()}</span>
              </div>
              <div className="balance-card">
                <span className="label">Credit Used</span>
                <span className="value">
                  {agent.creditUsed.toLocaleString()} / {agent.creditLimit.toLocaleString()}
                </span>
              </div>
            </div>
            <div className="rates-card">
              <h3>Your Rates</h3>
              <div className="rate-row">
                <span>Commission Rate</span>
                <span className="rate-value">
                  {((agent.commissionRate || 0) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="rate-row">
                <span>Player Rakeback</span>
                <span className="rate-value">
                  {((agent.playerRakebackRate || 0) * 100).toFixed(1)}%
                </span>
              </div>
            </div>
            {/* Credit Request Widget */}
            <div className="credit-section">
              <h3>Credit</h3>
              <CreditRequestWidget
                agentId={agent.id}
                agentName={agent.displayName || 'Agent'}
                parentAgentId={agent.parentAgentId}
                currentCreditLimit={agent.creditLimit}
                currentCreditUsed={agent.creditUsed}
              />
            </div>
          </div>
        )}

        {activeTab === 'agents' && (
          <div className="agents-section">
            <h3>Your Sub-Agents ({subAgents.length})</h3>
            {subAgents.length === 0 ? (
              <p className="empty-text">No Sub-Agents Yet</p>
            ) : (
              <div className="agent-list">
                {subAgents.map((sub, index) => (
                  <div
                    key={sub.id}
                    className="agent-row"
                    style={{
                      opacity: visibleAgentRows.has(index) ? 1 : 0,
                      transform: visibleAgentRows.has(index) ? 'translateY(0)' : 'translateY(8px)',
                      transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                    }}
                  >
                    <div className="agent-info">
                      <span className="agent-name">{sub.displayName || 'Agent'}</span>
                      <span className="agent-role">{AGENT_ROLE_LABELS[sub.role] || sub.role}</span>
                    </div>
                    <div className="agent-stats">
                      <span>{fmt(sub.totalPlayers)} Players</span>
                      <span className="rake">{sub.weeklyRakeGenerated.toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'players' && (
          <div className="players-section">
            <h3>Your Players ({players.length})</h3>
            <div className="player-list">
              {players.map((player, index) => (
                <div
                  key={player.id}
                  className="player-row"
                  style={{
                    opacity: visiblePlayerRows.has(index) ? 1 : 0,
                    transform: visiblePlayerRows.has(index) ? 'translateY(0)' : 'translateY(8px)',
                    transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <div className="player-avatar">
                    {player.avatarUrl ? (
                      <img src={player.avatarUrl} alt="" loading="lazy" />
                    ) : (
                      <span>{(player.displayName || 'P')[0].toUpperCase()}</span>
                    )}
                    {player.isOnline && <span className="online-dot" />}
                  </div>
                  <div className="player-info">
                    <span className="player-name">{player.displayName}</span>
                    <span className="player-rakeback">
                      {((player.rakebackPercent || 0) * 100).toFixed(1)}% Rakeback
                    </span>
                  </div>
                  <div className="player-balance">{(player.chipBalance ?? 0).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'commissions' && spread && (
          <div className="commissions-section">
            <h3>Commission Breakdown</h3>
            <div className="commission-summary">
              <div className="commission-row">
                <span>Gross Commission Rate</span>
                <span className="value">
                  {((spread.grossCommissionRate || 0) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="commission-row">
                <span>Paid To Downlines</span>
                <span className="value negative">-{spread.payoutToDownlines.toLocaleString()}</span>
              </div>
              <div className="commission-row total">
                <span>Net Margin</span>
                <span className="value">{spread.netMargin.toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'transfers' && (
          <div className="transfers-section">
            <h3>Transfer To Player</h3>
            <div className="transfer-form">
              <div className="form-row">
                <label>Select Player</label>
                <select
                  value={transferPlayerId}
                  onChange={(e) => setTransferPlayerId(e.target.value)}
                >
                  <option value="">Choose Player...</option>
                  {players.map((p) => (
                    <option key={p.id} value={p.userId}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Amount</label>
                <input
                  type="number"
                  placeholder="0.00"
                  value={transferAmount}
                  onChange={(e) => setTransferAmount(e.target.value)}
                />
              </div>
              <button
                className="btn btn-primary"
                onClick={handleTransfer}
                disabled={isTransferring || !transferPlayerId || !transferAmount}
              >
                {isTransferring ? 'Sending...' : 'Send Chips'}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'backoffice' && (
          <div className="backoffice-section">
            <AgentBackOffice />
          </div>
        )}
      </div>
    </div>
  );
}

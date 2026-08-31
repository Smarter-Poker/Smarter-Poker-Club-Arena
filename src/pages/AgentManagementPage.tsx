/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Agent Management Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Admin dashboard for managing agents, commissions, and credit lines
 * Real Supabase integration — no demo data
 */

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import styles from './AgentManagementPage.module.css';
import ConfirmModal from '@/components/common/ConfirmModal';
import { confirmDialog } from '../components/common/confirmDialog';
import { AgentService, type Agent } from '@/services/AgentService';
import { MembershipService, type ClubMembership } from '@/services/MembershipService';
import { exportToCSV } from '../lib/export';
import { useAuthUser } from '@/hooks/useAuthUser';
import { supabase } from '@/lib/supabase';
import { masterBus } from '../core/MasterBus';
import ChipTransferModal from '@/components/agent/ChipTransferModal';
import AgentTree from '@/components/agent/AgentTree';
import CommissionHistoryModal from '@/components/agent/CommissionHistoryModal';
import DistributionHistory from '@/components/agent/DistributionHistory';
import AgentAnalyticsDashboard from '@/components/agent/AgentAnalyticsDashboard';
import PlayerInviteModal from '@/components/agent/PlayerInviteModal';
import { CreditService } from '@/services/CreditService';
import AgentManager from '@/components/club/AgentManager';
import AdminReports from '@/components/club/AdminReports';
import SecurityAuditLog from '@/components/club/SecurityAuditLog';
import { PermissionService } from '@/services/PermissionService';
import { AgentFinancialPortal } from '@/components/dashboard/AgentFinancialPortal';
import AgentCommissionDashboard from '@/components/agent/AgentCommissionDashboard';
import { useToast } from '@/components/common/Toast';
import AgentAssignmentPanel from '@/components/agent/AgentAssignmentPanel';
import AgentCashoutPanel from '@/components/agent/AgentCashoutPanel';
import { PlayerSearch } from '@/components/admin/PlayerSearch';
import PageSkeleton from '../components/common/PageSkeleton';
import { EmptyState, ErrorState } from '../components/common/EmptyState';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { retryFetch } from '../utils/retryFetch';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';

import { safeErrorMessage } from '../utils/safeErrorMessage';
// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

type TabType = 'agents' | 'players' | 'hierarchy' | 'credit-limits' | 'commissions' | 'payouts';

export default function AgentManagementPage() {
  const { clubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  useVisibilityRefresh(async () => {
    if (!clubId) return;
    const data = await AgentService.getAgents(clubId);
    setAgents(data);
  });
  const [activeTab, setActiveTab] = useState<TabType>('agents');
  const swipeHandlers = useSwipeTabs({
    tabs: [
      'agents',
      'players',
      'hierarchy',
      'credit-limits',
      'commissions',
      'payouts',
    ] as TabType[],
    activeTab,
    onTabChange: setActiveTab,
  });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingLimit, setEditingLimit] = useState<string | null>(null);
  const [newLimit, setNewLimit] = useState<number>(0);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferAgentId, setTransferAgentId] = useState<string | null>(null);
  const [showCommissionModal, setShowCommissionModal] = useState(false);
  const [commissionAgentId, setCommissionAgentId] = useState<string | null>(null);
  const [commissionAgentName, setCommissionAgentName] = useState<string>('');
  const [showPlayerInviteModal, setShowPlayerInviteModal] = useState(false);
  // The agent's USER id, not the agents-table primary key. It used to hold
  // `agent.id` (the PK) and hand that to writes that wanted a user id.
  const [playerInviteAgentUserId, setPlayerInviteAgentUserId] = useState<string | null>(null);

  // Confirm modal state for destructive actions
  const [confirmAction, setConfirmAction] = useState<{
    type: 'promote' | 'ban';
    title: string;
    message: string;
    agentId?: string;
    newRole?: string;
    playerId?: string;
  } | null>(null);

  // Create Agent Form State
  const [availableMembers, setAvailableMembers] = useState<ClubMembership[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newAgentForm, setNewAgentForm] = useState({
    userId: '',
    role: 'agent' as 'super_agent' | 'agent' | 'sub_agent',
    parentAgentId: '',
    commissionRate: 50, // Default 50%
    playerRakebackRate: 30, // Default 30%
    creditLimit: 0, // MANDATORY - must be set
  });

  // Animation state
  const [visibleAgents, setVisibleAgents] = useState<Set<string>>(new Set());

  // Clawback state
  const [recentDistributions, setRecentDistributions] = useState<any[]>([]);
  const [clawbackProcessing, setClawbackProcessing] = useState<string | null>(null);

  // Stagger animation for agents list
  const isMounted = useIsMounted();

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setActiveTab('agents');
    setError(null);
    setSelectedAgent(null);
    setShowAddModal(false);
    setShowTransferModal(false);
    setShowCommissionModal(false);
    setShowPlayerInviteModal(false);
    setConfirmAction(null);
    setVisibleAgents(new Set());
    setClawbackProcessing(null);
  }, [clubId]);

  // Load agents from Supabase
  useEffect(() => {
    if (!clubId) return;

    setIsLoading(true);
    setError(null);

    AgentService.getAgents(clubId)
      .then((data) => {
        if (isMounted.current) setAgents(data);
      })
      .catch((err) => {
        if (isMounted.current) setError(safeErrorMessage(err));
      })
      .finally(() => {
        if (isMounted.current) setIsLoading(false);
      });
  }, [clubId]);

  // Load recent distributions for clawback
  const loadRecentDistributions = async () => {
    if (!clubId || !user?.id) return;
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data } = await retryFetch(
        () =>
          supabase
            .from('chip_transactions')
            .select(
              'id, from_user_id, to_user_id, amount, created_at, transaction_type, notes, profiles:to_user_id(username)'
            )
            .eq('club_id', resolvedId)
            .eq('from_user_id', user.id)
            .in('transaction_type', ['agent_to_player', 'promo_agent_to_player', 'send'])
            .gte('created_at', tenMinAgo)
            .eq('clawed_back', false)
            .order('created_at', { ascending: false })
            .limit(20)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );
      if (isMounted.current) setRecentDistributions(data || []);
    } catch (e) {
      reportError(e, 'AgentManagementPage.then');
      /* silent */
    }
  };

  useEffect(() => {
    if (activeTab === 'players') loadRecentDistributions();
  }, [activeTab, clubId, user?.id]);

  // Stagger animation for agents list
  useEffect(() => {
    if (agents.length === 0) return;
    setVisibleAgents(new Set());
    const timers = agents.map((agent, index) =>
      setTimeout(() => {
        setVisibleAgents((prev) => new Set(prev).add(agent.id));
      }, index * 60)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [agents]);

  // Load available members when modal opens
  useEffect(() => {
    if (!showAddModal || !clubId) return;

    setIsLoadingMembers(true);
    MembershipService.getEligibleForPromotion(clubId)
      .then((members) => {
        if (isMounted.current) setAvailableMembers(members);
      })
      .catch((err) => {
        reportError(err, 'AgentManagementPage.Failed_to_load_eligible_members');
        toast.error('Failed to load eligible members');
        if (isMounted.current) setAvailableMembers([]);
      })
      .finally(() => {
        if (isMounted.current) setIsLoadingMembers(false);
      });
  }, [showAddModal, clubId]);

  // Realtime subscription: auto-update on club_members and wallet_transactions changes
  useEffect(() => {
    if (!clubId) return;

    const loadAgentsData = async () => {
      setIsLoading(true);
      try {
        const data = await AgentService.getAgents(clubId);
        if (!isMounted.current) return;
        setAgents(data);
        setError(null);
      } catch (err) {
        if (!isMounted.current) return;
        reportError(err, 'AgentManagementPage.Failed_to_reload_agents');
        toast.error('Failed to load agents');
        setError(safeErrorMessage(err, 'Failed to reload agents'));
      } finally {
        if (isMounted.current) setIsLoading(false);
      }
    };

    const channelKey = `agent-mgmt-${clubId}`;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted.current) return;

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
          (payload) => {
            // Agents are club members with agent roles - reload on any change
            loadAgentsData();
          }
        )
        // wallet_transactions subscription removed (Phase 2 cost cut): the
        // canonical balance / commission state is derived via joins against
        // wallets + commission_records (both still in supabase_realtime).
        // Bus 'BALANCE_UPDATED' / 'WALLET_REFRESHED' listeners below backstop
        // admin-side commission edits.
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err)
              reportError(err?.message || err, 'AgentManagementPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[AgentManagementPage] Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[AgentManagementPage] Realtime setup failed:', e));

    // Bus event listeners for cross-component sync (debounced to prevent rapid-fire reloads)
    const unsubWallet = masterBus.subscribeDebounced(
      'WALLET_REFRESHED',
      () => {
        loadAgentsData();
      },
      300
    );
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadAgentsData();
        // Phase 13: Refresh clawback section after balance changes (e.g. clawback completes)
        loadRecentDistributions();
      },
      300
    );
    const unsubClub = masterBus.subscribeDebounced(
      'CLUB_UPDATED',
      (event) => {
        if (event.payload?.clubId === clubId) {
          loadAgentsData();
        }
      },
      300
    );
    // ── Ported from World Hub agent-dashboard.js: cross-page sync ──
    const unsubChipsDistributed = masterBus.subscribeDebounced(
      'CHIPS_DISTRIBUTED',
      () => {
        loadAgentsData();
        // Phase 13: Also refresh clawback section when new distribution happens
        loadRecentDistributions();
      },
      300
    );
    const unsubCashoutApproved = masterBus.subscribeDebounced(
      'CASHOUT_APPROVED',
      () => {
        loadAgentsData();
      },
      300
    );
    const unsubCashoutCancelled = masterBus.subscribeDebounced(
      'CASHOUT_CANCELLED',
      () => {
        loadAgentsData();
      },
      300
    );
    const unsubAgentUpdated = masterBus.subscribeDebounced(
      'AGENT_UPDATED',
      () => {
        loadAgentsData();
      },
      300
    );

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      unsubWallet();
      unsubBalance();
      unsubClub();
      unsubChipsDistributed();
      unsubCashoutApproved();
      unsubCashoutCancelled();
      unsubAgentUpdated();
    };
  }, [clubId]);

  // Stats summary
  const totalAgents = agents.length;
  const activeAgents = agents.filter((a) => a.status === 'active').length;
  const totalPlayers = agents.reduce((sum, a) => sum + a.totalPlayers, 0);
  const weeklyRake = agents.reduce((sum, a) => sum + a.weeklyRakeGenerated, 0);
  const totalCreditExtended = agents.reduce((sum, a) => sum + a.creditLimit, 0);

  // Format helpers
  const formatMoney = (amount: number) =>
    amount.toLocaleString('en-US', { minimumFractionDigits: 2 });
  const formatPercent = (rate: number) => `${((rate || 0) * 100).toFixed(0)}%`;
  const getCreditUtilization = (agent: Agent) =>
    agent.creditLimit > 0 ? (agent.creditUsed / agent.creditLimit) * 100 : 0;

  const getUtilizationStatus = (agent: Agent) => {
    const util = getCreditUtilization(agent);
    if (util >= 90) return 'critical';
    if (util >= 75) return 'warning';
    return 'healthy';
  };

  // Direct credit limit assignment (real Supabase call)
  const handleSetCreditLimit = async (agentId: string, limit: number) => {
    if (!user?.id) return;
    try {
      const success = await AgentService.setCreditLimit(agentId, limit, user.id);
      if (success) {
        setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, creditLimit: limit } : a)));
        toast.success(`Credit limit updated to ${limit.toLocaleString()}`);
        // Emit CREDIT_UPDATED so AgentDashboard, SuperAgentDashboard, etc. auto-refresh
        masterBus.emit('CREDIT_UPDATED', { clubId: clubId || '', amount: limit });
      } else {
        toast.error('Failed to update credit limit');
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to update credit limit');
    }
    setEditingLimit(null);
  };

  // Suspend agent (optimistic UI with rollback)
  const handleSuspendAgent = async (agentId: string) => {
    // Optimistic: update UI instantly for premium feel
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, status: 'suspended' as const } : a))
    );
    try {
      const success = await AgentService.updateAgentStatus(agentId, 'suspended');
      if (success) {
        masterBus.emit('AGENT_UPDATED', { clubId: clubId || '', agentId });
        masterBus.emit('ADMIN_ACTION', {
          action: 'agent_suspended',
          target: agentId,
          userId: user?.id,
        });
        toast.success('Agent suspended');
      } else {
        // Rollback: revert optimistic update
        setAgents((prev) =>
          prev.map((a) => (a.id === agentId ? { ...a, status: 'active' as const } : a))
        );
        toast.error('Failed to suspend agent');
      }
    } catch (err: any) {
      // Rollback on network error
      setAgents((prev) =>
        prev.map((a) => (a.id === agentId ? { ...a, status: 'active' as const } : a))
      );
      toast.error(err.message || 'Failed to suspend agent');
    }
  };

  // Reinstate agent (optimistic UI with rollback)
  const handleReinstateAgent = async (agentId: string) => {
    // Optimistic: update UI instantly for premium feel
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, status: 'active' as const } : a))
    );
    try {
      const success = await AgentService.updateAgentStatus(agentId, 'active');
      if (success) {
        masterBus.emit('AGENT_UPDATED', { clubId: clubId || '', agentId });
        masterBus.emit('ADMIN_ACTION', {
          action: 'agent_reinstated',
          target: agentId,
          userId: user?.id,
        });
        toast.success('Agent reinstated');
      } else {
        // Rollback
        setAgents((prev) =>
          prev.map((a) => (a.id === agentId ? { ...a, status: 'suspended' as const } : a))
        );
        toast.error('Failed to reinstate agent');
      }
    } catch (err: any) {
      // Rollback on network error
      setAgents((prev) =>
        prev.map((a) => (a.id === agentId ? { ...a, status: 'suspended' as const } : a))
      );
      toast.error(err.message || 'Failed to reinstate agent');
    }
  };

  // Promote agent to super_agent (real Supabase call)
  const handlePromoteAgent = async (agentId: string, currentRole: string) => {
    const newRole = currentRole === 'agent' ? 'super_agent' : 'agent';
    const action = currentRole === 'agent' ? 'Promote to Super Agent' : 'Demote to Agent';
    setConfirmAction({
      type: 'promote',
      title: action,
      message: `${action}? This will change their permissions and hierarchy level.`,
      agentId,
      newRole,
    });
  };

  const executeConfirmAction = async () => {
    if (!confirmAction) return;
    const { type, agentId, newRole, playerId } = confirmAction;
    setConfirmAction(null);

    if (type === 'promote' && agentId && newRole) {
      const success = await AgentService.updateAgentRole(
        agentId,
        newRole as 'super_agent' | 'agent' | 'sub_agent'
      );
      if (success) {
        setAgents((prev) =>
          prev.map((a) => (a.id === agentId ? { ...a, role: newRole as any } : a))
        );
        toast.success(
          `Agent role updated to ${newRole === 'super_agent' ? 'Super Agent' : 'Agent'}`
        );
        masterBus.emit('AGENT_UPDATED', { clubId: clubId || '', agentId });
        masterBus.emit('ADMIN_ACTION', {
          action: newRole === 'super_agent' ? 'agent_promoted' : 'agent_demoted',
          target: agentId,
          details: { newRole },
          userId: user?.id,
        });
      } else {
        toast.error('Failed to update agent role');
      }
    } else if (type === 'ban') {
      toast.success('Player banned');
    }
  };

  // Create new agent (real Supabase call)
  const handleCreateAgent = async () => {
    if (!clubId || !newAgentForm.userId) return;

    // Validate mandatory fields
    if (newAgentForm.creditLimit <= 0) {
      toast.error('Credit Limit is required and must be greater than 0');
      return;
    }
    if (newAgentForm.commissionRate <= 0 || newAgentForm.commissionRate > 70) {
      toast.error('Commission Rate must be between 1% and 70%');
      return;
    }
    if (newAgentForm.playerRakebackRate < 0 || newAgentForm.playerRakebackRate > 50) {
      toast.error('Rakeback Rate must be between 0% and 50%');
      return;
    }

    setIsCreating(true);
    try {
      const newAgent = await AgentService.createAgent({
        userId: newAgentForm.userId,
        clubId,
        role: newAgentForm.role,
        parentAgentId: newAgentForm.parentAgentId || undefined,
        commissionRate: newAgentForm.commissionRate / 100, // Convert to decimal
        playerRakebackRate: newAgentForm.playerRakebackRate / 100,
        creditLimit: newAgentForm.creditLimit,
      });

      setAgents((prev) => [newAgent, ...prev]);
      setShowAddModal(false);
      masterBus.emit('AGENT_UPDATED', { clubId: clubId || '', agentId: newAgent.id });
      setNewAgentForm({
        userId: '',
        role: 'agent',
        parentAgentId: '',
        commissionRate: 50,
        playerRakebackRate: 30,
        creditLimit: 0,
      });
    } catch (err: any) {
      toast.error('Failed to create agent: ' + err.message);
    } finally {
      setIsCreating(false);
    }
  };

  // Reset form when modal closes
  const handleCloseModal = () => {
    setShowAddModal(false);
    setNewAgentForm({
      userId: '',
      role: 'agent',
      parentAgentId: '',
      commissionRate: 50,
      playerRakebackRate: 30,
      creditLimit: 0,
    });
  };

  // No club selected
  if (!clubId) {
    return (
      <div className={styles.page}>
        <EmptyState
          icon="CLUB"
          eyebrow="Club Context Required"
          tone="permission"
          title="Choose A Club To Manage Agents"
          description="Agent Roles, Commissions, Credit Lines, And Players Belong To One Club. Open This Tool From That Club's Operations Menu."
          action={{ label: 'Return To Arena', onClick: () => navigate('/') }}
        />
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className={styles.page}>
        <PageSkeleton variant="dashboard" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={styles.page}>
        <ErrorState
          message={error}
          onRetry={() => {
            setIsLoading(true);
            setError(null);
            AgentService.getAgents(clubId)
              .then(setAgents)
              .catch((retryError) => setError(safeErrorMessage(retryError)))
              .finally(() => setIsLoading(false));
          }}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1>Agent Management</h1>
          <p className={styles.subtitle}>Manage Agents, Commissions, And Credit Lines</p>
        </div>
        <button className={styles.addButton} onClick={() => setShowAddModal(true)}>
          + Add Agent
        </button>
        {agents.length > 0 && (
          <button
            className={styles.addButton}
            style={{
              background: 'rgba(65,105,225,0.15)',
              color: '#4169E1',
              border: '1px solid rgba(65,105,225,0.3)',
            }}
            onClick={() => {
              try {
                exportToCSV(
                  agents.map((a) => ({
                    displayName: a.displayName || 'Unknown',
                    role: a.role,
                    status: a.status,
                    commissionRate: `${((a.commissionRate || 0) * 100).toFixed(0)}%`,
                    creditLimit: a.creditLimit,
                    totalPlayers: a.totalPlayers,
                    weeklyRake: a.weeklyRakeGenerated,
                  })),
                  'agents_list.csv',
                  [
                    { key: 'displayName', label: 'Agent' },
                    { key: 'role', label: 'Role' },
                    { key: 'status', label: 'Status' },
                    { key: 'commissionRate', label: 'Commission' },
                    { key: 'creditLimit', label: 'Credit Limit' },
                    { key: 'totalPlayers', label: 'Players' },
                    { key: 'weeklyRake', label: 'Weekly Rake' },
                  ]
                );
              } catch (e) {
                reportError(e, 'AgentManagementPage.map');
                /* silent */
              }
            }}
          >
            Export
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <div className={styles.summaryGrid}>
        <div className={styles.summaryCard}>
          <span className={styles.summaryIcon}></span>
          <div>
            <span className={styles.summaryValue}>
              {activeAgents}/{totalAgents}
            </span>
            <span className={styles.summaryLabel}>Active Agents</span>
          </div>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryIcon}></span>
          <div>
            <span className={styles.summaryValue}>{totalPlayers}</span>
            <span className={styles.summaryLabel}>Total Players</span>
          </div>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryIcon}></span>
          <div>
            <span className={styles.summaryValue}>{formatMoney(weeklyRake)}</span>
            <span className={styles.summaryLabel}>Weekly Rake</span>
          </div>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryIcon}></span>
          <div>
            <span className={styles.summaryValue}>{formatMoney(totalCreditExtended)}</span>
            <span className={styles.summaryLabel}>Credit Extended</span>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <nav className={styles.tabNav}>
        {(
          ['agents', 'players', 'hierarchy', 'credit-limits', 'commissions', 'payouts'] as TabType[]
        ).map((tab) => (
          <button
            key={tab}
            className={`${styles.tabButton} ${activeTab === tab ? styles.active : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'agents' && ' Agents'}
            {tab === 'players' && 'Players'}
            {tab === 'hierarchy' && 'Hierarchy'}
            {tab === 'credit-limits' && 'Credit Limits'}
            {tab === 'commissions' && ' Commissions'}
            {tab === 'payouts' && ' Payouts'}
          </button>
        ))}
      </nav>

      {/* Tab Content — Swipeable */}
      <div className={styles.content} {...swipeHandlers}>
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* AGENTS TAB */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'agents' && (
          <div className={styles.agentsList}>
            {agents.map((agent) => (
              <div
                key={agent.id}
                className={`${styles.agentCard} ${agent.status !== 'active' ? styles.inactive : ''} ${visibleAgents.has(agent.id) ? styles.fadeInUp : styles.hidden}`}
                style={
                  visibleAgents.has(agent.id)
                    ? undefined
                    : { opacity: 0, transform: 'translateY(8px)' }
                }
              >
                <div className={styles.agentHeader}>
                  <div className={styles.agentAvatar}>
                    {(agent.displayName || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className={styles.agentInfo}>
                    <h3>{agent.displayName || 'Unknown Agent'}</h3>
                    <div className={styles.agentMeta}>
                      <span className={`${styles.badge} ${styles[agent.role]}`}>
                        {agent.role === 'super_agent'
                          ? 'Super Agent'
                          : agent.role === 'agent'
                            ? 'Agent'
                            : 'Sub-Agent'}
                      </span>
                      <span className={`${styles.badge} ${styles[agent.status]}`}>
                        {agent.status}
                      </span>
                      {agent.parentAgentName && (
                        <span className={styles.parentAgent}>Under: {agent.parentAgentName}</span>
                      )}
                    </div>
                  </div>
                  <div className={styles.agentActions}>
                    {agent.status === 'active' ? (
                      <>
                        <button
                          className={styles.actionBtn}
                          onClick={() => handleSuspendAgent(agent.id)}
                        >
                          Suspend
                        </button>
                        <button
                          className={`${styles.actionBtn} ${styles.transfer}`}
                          onClick={() => {
                            setTransferAgentId(agent.userId);
                            setShowTransferModal(true);
                          }}
                        >
                          Transfer
                        </button>
                        {agent.role === 'agent' && (
                          <button
                            className={`${styles.actionBtn} ${styles.promote}`}
                            onClick={() => handlePromoteAgent(agent.id, agent.role)}
                          >
                            Promote
                          </button>
                        )}
                        {agent.role === 'super_agent' && (
                          <button
                            className={`${styles.actionBtn} ${styles.demote}`}
                            onClick={() => handlePromoteAgent(agent.id, agent.role)}
                          >
                            Demote
                          </button>
                        )}
                        <button
                          className={`${styles.actionBtn}`}
                          onClick={() => {
                            setPlayerInviteAgentUserId(agent.userId);
                            setShowPlayerInviteModal(true);
                          }}
                        >
                          Add Player
                        </button>
                        <button
                          className={`${styles.actionBtn}`}
                          onClick={() => {
                            setCommissionAgentId(agent.id);
                            setCommissionAgentName(agent.displayName || 'Agent');
                            setShowCommissionModal(true);
                          }}
                        >
                          History
                        </button>
                      </>
                    ) : (
                      <button
                        className={`${styles.actionBtn} ${styles.primary}`}
                        onClick={() => handleReinstateAgent(agent.id)}
                      >
                        Reinstate
                      </button>
                    )}
                  </div>
                </div>

                <div className={styles.agentStats}>
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>Commission</span>
                    <span className={styles.statValue}>{formatPercent(agent.commissionRate)}</span>
                  </div>
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>Rakeback</span>
                    <span className={styles.statValue}>
                      {formatPercent(agent.playerRakebackRate)}
                    </span>
                  </div>
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>Players</span>
                    <span className={styles.statValue}>
                      {agent.activePlayerCount}/{agent.totalPlayers}
                    </span>
                  </div>
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>Weekly Rake</span>
                    <span className={styles.statValue}>
                      {formatMoney(agent.weeklyRakeGenerated)}
                    </span>
                  </div>
                </div>

                <div className={styles.walletRow}>
                  <div className={styles.walletItem}>
                    <span className={styles.walletIcon}>◈</span>
                    <span>{formatMoney(agent.businessBalance)}</span>
                  </div>
                  <div className={styles.walletItem}>
                    <span className={styles.walletIcon}></span>
                    <span>{formatMoney(agent.playerBalance)}</span>
                  </div>
                  <div className={styles.walletItem}>
                    <span className={styles.walletIcon}></span>
                    <span>{formatMoney(agent.promoBalance)}</span>
                  </div>
                </div>

                {!agent.isPrepaid && (
                  <div className={styles.creditBar}>
                    <div className={styles.creditHeader}>
                      <span>
                        Credit Line: {formatMoney(agent.creditUsed)} /{' '}
                        {formatMoney(agent.creditLimit)}
                      </span>
                      <span
                        className={`${styles.utilBadge} ${styles[getUtilizationStatus(agent)]}`}
                      >
                        {(getCreditUtilization(agent) || 0).toFixed(0)}% Used
                      </span>
                    </div>
                    <div className={styles.creditProgress}>
                      <div
                        className={`${styles.creditFill} ${styles[getUtilizationStatus(agent)]}`}
                        style={{ width: `${Math.min(getCreditUtilization(agent), 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* PLAYERS TAB — Search and Manage Players */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'players' && (
          <div className={styles.playersSection}>
            <PlayerSearch
              /* Scopes the search to THIS club. The prop was declared on
                 PlayerSearch all along and never passed, so a staff member on
                 one club's Players tab searched every profile on the platform,
                 email included. */
              clubId={clubId}
              onPlayerSelect={(player) => {
                toast.info(`Selected: ${player.username}`);
              }}
              onBanPlayer={(playerId) => {
                setConfirmAction({
                  type: 'ban',
                  title: 'Ban Player',
                  message:
                    'Ban this player from the club? They will no longer be able to join or play.',
                  playerId,
                });
              }}
              onViewProfile={(playerId) => {
                navigate(`/profile/${playerId}`);
              }}
            />

            {/* Recent Distributions with Clawback */}
            {recentDistributions.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <h3
                  style={{ fontSize: '0.95rem', color: 'rgba(255,255,255,0.7)', marginBottom: 12 }}
                >
                  ↩ Recent Distributions (Clawback Window)
                </h3>
                {recentDistributions.map((tx) => {
                  const elapsed = Date.now() - new Date(tx.created_at).getTime();
                  const remainingSec = Math.max(0, Math.ceil((10 * 60 * 1000 - elapsed) / 1000));
                  const remainingMin = Math.floor(remainingSec / 60);
                  const remainingSecMod = remainingSec % 60;
                  const recipientName = (tx.profiles as any)?.username || 'Player';
                  return (
                    <div
                      key={tx.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 14px',
                        background: 'rgba(0,0,0,0.2)',
                        borderRadius: 8,
                        marginBottom: 8,
                        border: '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '0.85rem', color: '#fff', fontWeight: 600 }}>
                          {tx.amount.toLocaleString()} Chips → {recipientName}
                        </div>
                        <div
                          style={{
                            fontSize: '0.7rem',
                            color: 'rgba(255,255,255,0.4)',
                            marginTop: 2,
                          }}
                        >
                          {tx.transaction_type} •{' '}
                          <span style={{ color: remainingSec > 0 ? '#F5A623' : '#FA383E' }}>
                            {remainingSec > 0
                              ? `${remainingMin}:${String(remainingSecMod).padStart(2, '0')} Left`
                              : 'Expired'}
                          </span>
                        </div>
                      </div>
                      {remainingSec > 0 && (
                        <button
                          onClick={async () => {
                            if (
                              !(await confirmDialog({
                                message: `Clawback ${tx.amount.toLocaleString()} chips from ${recipientName}?`,
                                variant: 'danger',
                              }))
                            )
                              return;
                            setClawbackProcessing(tx.id);
                            try {
                              const result = await AgentService.clawbackDistribution(
                                tx.id,
                                clubId!,
                                user!.id
                              );
                              if (result.success) {
                                if (result.partial) {
                                  toast.success(
                                    `⚠ Partially recovered ${(result.recovered || 0).toLocaleString()} of ${tx.amount.toLocaleString()} chips (player had insufficient balance)`
                                  );
                                } else {
                                  toast.success(
                                    `Fully recovered ${(result.recovered || tx.amount).toLocaleString()} chips`
                                  );
                                }
                                masterBus.emit('BALANCE_UPDATED', { source: 'clawback' });
                                loadRecentDistributions();
                              } else {
                                toast.error(result.error || 'Clawback failed');
                              }
                            } catch (err: any) {
                              toast.error(err.message || 'Clawback failed');
                            } finally {
                              setClawbackProcessing(null);
                            }
                          }}
                          disabled={clawbackProcessing === tx.id}
                          style={{
                            padding: '6px 14px',
                            borderRadius: 6,
                            background: 'rgba(250,56,62,0.15)',
                            border: '1px solid rgba(250,56,62,0.3)',
                            color: '#FA383E',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {clawbackProcessing === tx.id ? '...' : '↩ Clawback'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* DISTRIBUTION HISTORY + AGENT ANALYTICS (Phase 4 — New Features) */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'players' && user && clubId && (
          <>
            <DistributionHistory userId={user.id} clubId={clubId} />
            <AgentAnalyticsDashboard userId={user.id} clubId={clubId} />
          </>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* HIERARCHY TAB — Visual Tree View */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'hierarchy' && clubId && (
          <div style={{ marginBottom: 20 }}>
            <AgentAssignmentPanel clubId={clubId} />
          </div>
        )}

        {activeTab === 'hierarchy' && clubId && (
          <AgentTree
            clubId={clubId}
            onAgentClick={(agent) => {
              setCommissionAgentId(agent.id);
              setCommissionAgentName(agent.displayName || 'Agent');
              setShowCommissionModal(true);
            }}
            onTransferClick={(agent) => {
              setTransferAgentId(agent.id);
              setShowTransferModal(true);
            }}
          />
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* CREDIT LIMITS TAB — Direct Assignment */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'credit-limits' && (
          <div className={styles.creditLimitsSection}>
            <div className={styles.creditHierarchy}>
              <h2>Credit Limit Assignment</h2>
              <p>
                Assign Credit Limits Directly. Clubs Set Limits For Agents. Agents Set Limits For
                Sub-Agents.
              </p>
            </div>

            <table className={styles.creditTable}>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Role</th>
                  <th>Assigned By</th>
                  <th>Credit Limit</th>
                  <th>Used</th>
                  <th>Utilization</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id} className={agent.status !== 'active' ? styles.inactive : ''}>
                    <td className={styles.agentCell}>{agent.displayName}</td>
                    <td>
                      <span className={`${styles.badge} ${styles[agent.role]}`}>
                        {agent.role === 'agent' ? 'Agent' : 'Sub-Agent'}
                      </span>
                    </td>
                    <td className={styles.assignedBy}>
                      {agent.role === 'agent' ? ' Club' : ` ${agent.parentAgentName || 'Agent'}`}
                    </td>
                    <td>
                      {editingLimit === agent.id ? (
                        <input
                          type="number"
                          className={styles.limitInput}
                          value={newLimit}
                          onChange={(e) => setNewLimit(Number(e.target.value))}
                          autoFocus
                        />
                      ) : (
                        <span className={styles.limitAmount}>{formatMoney(agent.creditLimit)}</span>
                      )}
                    </td>
                    <td>{formatMoney(agent.creditUsed)}</td>
                    <td>
                      <span
                        className={`${styles.utilBadge} ${styles[getUtilizationStatus(agent)]}`}
                      >
                        {(getCreditUtilization(agent) || 0).toFixed(0)}%
                      </span>
                    </td>
                    <td>
                      {editingLimit === agent.id ? (
                        <div className={styles.editActions}>
                          <button
                            className={`${styles.actionBtn} ${styles.approve}`}
                            onClick={() => handleSetCreditLimit(agent.id, newLimit)}
                          >
                            Save
                          </button>
                          <button
                            className={styles.actionBtn}
                            aria-label="Cancel"
                            onClick={() => setEditingLimit(null)}
                          ></button>
                        </div>
                      ) : (
                        <button
                          className={styles.actionBtn}
                          onClick={() => {
                            setEditingLimit(agent.id);
                            setNewLimit(agent.creditLimit);
                          }}
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className={styles.creditNote}>
              <h3> Credit Assignment Rules</h3>
              <ul>
                <li>
                  <strong>Club → Agent:</strong> Club Owner Assigns Credit Limits When Creating An
                  Agent
                </li>
                <li>
                  <strong>Agent → Sub-Agent:</strong> Agents Assign Limits To Their Sub-Agents
                  (Cannot Exceed Their Own Limit)
                </li>
                <li>
                  <strong>Adjustable:</strong> Limits Can Be Changed Anytime By The Assigning Level
                </li>
                <li>
                  <strong>Suspension:</strong> Agents At 90%+ Utilization Should Be Reviewed
                </li>
              </ul>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* COMMISSIONS TAB */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'commissions' && (
          <div className={styles.commissionsSection}>
            <AgentCommissionDashboard />
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* PAYOUTS TAB */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'payouts' && (
          <div className={styles.payoutsSection}>
            {/* Player Cashout Requests (wired to CashoutService) */}
            <AgentCashoutPanel clubId={clubId} />

            <div className={styles.payoutSchedule}>
              <h2>Settlement Schedule</h2>
              <div className={styles.scheduleGrid}>
                <div className={styles.scheduleItem}>
                  <span className={styles.scheduleIcon}>◷</span>
                  <div>
                    <strong>Sunday 11:59 PM PST</strong>
                    <p>Snapshot & Invoice Generation</p>
                  </div>
                </div>
                <div className={styles.scheduleItem}>
                  <span className={styles.scheduleIcon}></span>
                  <div>
                    <strong>Monday 4:00 AM PST</strong>
                    <p>Payout Execution</p>
                  </div>
                </div>
                <div className={styles.scheduleItem}>
                  <span className={styles.scheduleIcon}></span>
                  <div>
                    <strong>Tuesday 11:59 PM PST</strong>
                    <p>48-Hour Grace Period Ends</p>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.upcomingPayouts}>
              <h3>Upcoming Agent Payouts</h3>
              <table className={styles.payoutTable}>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Rake Generated</th>
                    <th>Commission</th>
                    <th>Net Payout</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {agents
                    .filter((a) => a.status === 'active')
                    .map((agent) => {
                      const commission = agent.weeklyRakeGenerated * agent.commissionRate;
                      const rakeback = agent.weeklyRakeGenerated * agent.playerRakebackRate;
                      const netPayout = commission - rakeback;
                      return (
                        <tr key={agent.id}>
                          <td>{agent.displayName}</td>
                          <td>{formatMoney(agent.weeklyRakeGenerated)}</td>
                          <td>{formatMoney(commission)}</td>
                          <td className={styles.netPayout}>{formatMoney(netPayout)}</td>
                          <td>
                            <span className={`${styles.badge} ${styles.pending}`}>Pending</span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════════════ */}
      {/* CREATE AGENT MODAL */}
      {/* ═══════════════════════════════════════════════════════════════════════════════ */}
      {showAddModal && (
        <div className={styles.modalOverlay} onClick={handleCloseModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2>Create New Agent</h2>
              <button className={styles.closeBtn} onClick={handleCloseModal}>
                ×
              </button>
            </div>

            <div className={styles.modalBody}>
              {/* Member Selection */}
              <div className={styles.formGroup}>
                <label>Select Member To Promote *</label>
                {isLoadingMembers ? (
                  <div className={styles.loadingSelect}>Loading Members...</div>
                ) : availableMembers.length === 0 ? (
                  <div className={styles.emptySelect}>
                    No Eligible Members Found. Members Must Be Active And Not Already Agents.
                  </div>
                ) : (
                  <select
                    value={newAgentForm.userId}
                    onChange={(e) => setNewAgentForm({ ...newAgentForm, userId: e.target.value })}
                    className={styles.formSelect}
                  >
                    <option value="">Choose A Member To Promote...</option>
                    {availableMembers.map((m) => (
                      <option key={m.id} value={m.userId}>
                        {m.displayName || 'Unknown'}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Role Selection */}
              <div className={styles.formGroup}>
                <label>Agent Role *</label>
                <div className={styles.roleSelector}>
                  <button
                    type="button"
                    className={`${styles.roleOption} ${newAgentForm.role === 'super_agent' ? styles.selected : ''}`}
                    onClick={() =>
                      setNewAgentForm({ ...newAgentForm, role: 'super_agent', parentAgentId: '' })
                    }
                  >
                    <span className={styles.roleIcon}></span>
                    <span className={styles.roleLabel}>Super Agent</span>
                    <span className={styles.roleDesc}>Can Have Agents Under Them</span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.roleOption} ${newAgentForm.role === 'agent' ? styles.selected : ''}`}
                    onClick={() => setNewAgentForm({ ...newAgentForm, role: 'agent' })}
                  >
                    <span className={styles.roleIcon}></span>
                    <span className={styles.roleLabel}>Agent</span>
                    <span className={styles.roleDesc}>Standard Agent Role</span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.roleOption} ${newAgentForm.role === 'sub_agent' ? styles.selected : ''}`}
                    onClick={() => setNewAgentForm({ ...newAgentForm, role: 'sub_agent' })}
                  >
                    <span className={styles.roleIcon}></span>
                    <span className={styles.roleLabel}>Sub-Agent</span>
                    <span className={styles.roleDesc}>Under Another Agent</span>
                  </button>
                </div>
              </div>

              {/* Parent Agent (for sub-agents) */}
              {(newAgentForm.role === 'agent' || newAgentForm.role === 'sub_agent') &&
                agents.filter(
                  (a) =>
                    a.role === 'super_agent' ||
                    (newAgentForm.role === 'sub_agent' && a.role === 'agent')
                ).length > 0 && (
                  <div className={styles.formGroup}>
                    <label>
                      Parent Agent {newAgentForm.role === 'sub_agent' ? '*' : '(Optional)'}
                    </label>
                    <select
                      value={newAgentForm.parentAgentId}
                      onChange={(e) =>
                        setNewAgentForm({ ...newAgentForm, parentAgentId: e.target.value })
                      }
                      className={styles.formSelect}
                    >
                      <option value="">Select Parent Agent...</option>
                      {agents
                        .filter(
                          (a) =>
                            a.role === 'super_agent' ||
                            (newAgentForm.role === 'sub_agent' && a.role === 'agent')
                        )
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.displayName || 'Unknown'}
                          </option>
                        ))}
                    </select>
                  </div>
                )}

              {/* Commission Rate */}
              <div className={styles.formGroup}>
                <label>
                  Commission Rate * <span className={styles.formHint}>(Max 70%)</span>
                </label>
                <div className={styles.sliderGroup}>
                  <input
                    type="range"
                    min="0"
                    max="70"
                    value={newAgentForm.commissionRate}
                    onChange={(e) =>
                      setNewAgentForm({ ...newAgentForm, commissionRate: Number(e.target.value) })
                    }
                    className={styles.slider}
                  />
                  <span className={styles.sliderValue}>{newAgentForm.commissionRate}%</span>
                </div>
                <p className={styles.fieldDesc}>
                  Percentage Of Rake This Agent Receives From The Club
                </p>
              </div>

              {/* Rakeback Rate */}
              <div className={styles.formGroup}>
                <label>
                  Player Rakeback Rate * <span className={styles.formHint}>(Max 50%)</span>
                </label>
                <div className={styles.sliderGroup}>
                  <input
                    type="range"
                    min="0"
                    max="50"
                    value={newAgentForm.playerRakebackRate}
                    onChange={(e) =>
                      setNewAgentForm({
                        ...newAgentForm,
                        playerRakebackRate: Number(e.target.value),
                      })
                    }
                    className={styles.slider}
                  />
                  <span className={styles.sliderValue}>{newAgentForm.playerRakebackRate}%</span>
                </div>
                <p className={styles.fieldDesc}>
                  Rakeback Rate - Percentage Of Rake Players Receive Back As Chips
                </p>
              </div>

              {/* Credit Limit */}
              <div className={styles.formGroup}>
                <label>
                  Credit Limit * <span className={styles.formHint}>(Required)</span>
                </label>
                <div className={styles.creditInputGroup}>
                  <span className={styles.currencySymbol}>◉</span>
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    placeholder="Enter Credit Limit"
                    value={newAgentForm.creditLimit || ''}
                    onChange={(e) =>
                      setNewAgentForm({ ...newAgentForm, creditLimit: Number(e.target.value) })
                    }
                    className={styles.creditInput}
                  />
                </div>
                <p className={styles.fieldDesc}>Maximum Credit This Agent Can Extend To Players</p>
              </div>

              {/* Summary */}
              <div className={styles.formSummary}>
                <h4> Agent Summary</h4>
                <div className={styles.summaryGrid}>
                  <div>
                    Role: <strong>{newAgentForm.role.replace('_', ' ')}</strong>
                  </div>
                  <div>
                    Commission: <strong>{newAgentForm.commissionRate}%</strong>
                  </div>
                  <div>
                    Rakeback: <strong>{newAgentForm.playerRakebackRate}%</strong>
                  </div>
                  <div>
                    Credit Limit:{' '}
                    <strong>
                      {newAgentForm.creditLimit.toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </strong>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.modalFooter}>
              <button className={styles.cancelBtn} onClick={handleCloseModal}>
                Cancel
              </button>
              <button
                className={styles.createBtn}
                onClick={handleCreateAgent}
                disabled={isCreating || !newAgentForm.userId || newAgentForm.creditLimit <= 0}
              >
                {isCreating ? 'Creating...' : ' Create Agent'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chip Transfer Modal */}
      <ChipTransferModal
        isOpen={showTransferModal}
        onClose={() => {
          setShowTransferModal(false);
          setTransferAgentId(null);
        }}
        clubId={clubId || ''}
        recipientId={transferAgentId || undefined}
        onTransferComplete={() => {
          // Refresh agents
          if (clubId) {
            AgentService.getAgents(clubId)
              .then(setAgents)
              .catch((e) =>
                console.warn('[AgentManagementPage] Failed to refresh agents after transfer:', e)
              );
          }
        }}
      />

      {/* Commission History Modal */}
      <CommissionHistoryModal
        isOpen={showCommissionModal}
        onClose={() => {
          setShowCommissionModal(false);
          setCommissionAgentId(null);
          setCommissionAgentName('');
        }}
        agentId={commissionAgentId || ''}
        agentName={commissionAgentName}
      />

      {/* Player Invite Modal */}
      <PlayerInviteModal
        isOpen={showPlayerInviteModal}
        onClose={() => {
          setShowPlayerInviteModal(false);
          setPlayerInviteAgentUserId(null);
        }}
        agentUserId={playerInviteAgentUserId || ''}
        clubId={clubId || ''}
        onPlayerAdded={() => {
          // Refresh agents
          if (clubId) {
            AgentService.getAgents(clubId)
              .then(setAgents)
              .catch((e) =>
                console.warn(
                  '[AgentManagementPage] Failed to refresh agents after player added:',
                  e
                )
              );
          }
        }}
      />

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmAction}
        title={confirmAction?.title || 'Confirm'}
        message={confirmAction?.message || ''}
        variant="danger"
        onConfirm={executeConfirmAction}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Agent Management Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Admin dashboard for managing agents, commissions, and credit lines
 * Real Supabase integration — no demo data
 *
 * ── #ClubArenaConsole (2026-09-09) ────────────────────────────────────────
 * The page was a gradient header bar with two pill buttons, a four-tile
 * summary grid, a six-pill tab rail, a stack of rounded agent cards each
 * carrying an avatar disc, five capsule badges, a four-tile stat grid, a
 * three-tile wallet row and a drawn progress bar, and TWO BORDERED HTML
 * TABLES (credit limits, payables) that ran off the side of a 393px phone.
 * It is now printed on Dan's approved spade master: one console per section,
 * every figure a row on the black glass with its label in the master's lit
 * blue on the left and its value in engraved silver on the right, separated
 * by the engraved rule the master cuts between its own rows. The two tables
 * are one row per agent with their fields stacked as label/value pairs.
 *
 * WHAT DID NOT CHANGE, AND MUST NOT. This page moves real chips and changes
 * real permissions, so every one of these is byte-identical: handleCreateAgent,
 * handleSetCreditLimit, handleSuspendAgent, handleReinstateAgent,
 * handlePromoteAgent, executeBan (fn_ca_ban_club_player, its reason minimum
 * and its expiry options), AgentService.claimBackDistribution and its confirm
 * dialog, the ChipTransferModal / PlayerInviteModal / CommissionHistoryModal
 * wiring (userId, never agent.id), the QUERY_LIMITS cap notice, the swipe
 * handlers, the stagger timers, and every commission, rakeback and credit
 * figure. Not one number, gate or handler was touched - only what draws them.
 *
 * THE FIGURES STAY EXACT. `compactChips` is used for the COUNTS in the
 * summary. It is not used for the money: a credit limit, a credit draw and an
 * unsettled commission are the sums an operator sets and then pays, and
 * `compactChips` floors below 1,000 - it would print a 750.40 commission as
 * "750" on the screen the club pays it from. `formatMoney` is untouched.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import styles from './AgentManagementPage.module.css';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { SpadeConsole, type ConsoleInk } from '../components/console/SpadeConsole';
import ConfirmModal from '@/components/common/ConfirmModal';
import { confirmDialog } from '../components/common/confirmDialog';
import { AgentService, type Agent, type ReversibleDistribution } from '@/services/AgentService';
import { MembershipService, type ClubMembership } from '@/services/MembershipService';
import { exportToCSV } from '../lib/export';
import { compactChips, fmt, fmtChips, timeAgo } from '../utils/format';
import { isAuthzError } from '../utils/clubDashboard';
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
import {
  adminRemovePlayerFromClubTables,
  liveSeatTableIds,
} from '../services/IntegrityActionService';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';

import { safeErrorMessage } from '../utils/safeErrorMessage';
import { QUERY_LIMITS } from '../lib/constants';
// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

type TabType = 'agents' | 'players' | 'hierarchy' | 'credit-limits' | 'commissions' | 'payouts';

/**
 * What fn_ca_agent_payables returns, read from the commission rollup. The
 * superseded arithmetic this page printed before phase 3 (weekly rake times
 * commission rate) rode alongside for one release and came down 2026-09-04.
 */
interface AgentPayableRow {
  agent_id: string;
  user_id: string;
  name: string;
  role: string;
  status: string;
  is_prepaid: boolean;
  credit_limit: number;
  credit_used: number;
  credit_available: number;
  utilization: number;
  owed: number;
  rows_behind: number;
  oldest_unsettled: string | null;
}

interface AgentPayables {
  agents: number;
  cap: number;
  total_owed: number;
  total_rows: number;
  oldest_unsettled: string | null;
  rows: AgentPayableRow[];
  generated_at: string;
}

export default function AgentManagementPage() {
  const { clubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  /* THE AGENTS ON SCREEN ARE THE AGENTS OF THE CLUB IN THE URL (2026-09-10).
     Every agents load was guarded by isMounted alone, so changing club while
     a read was in flight landed the previous club's credit limits, wallet
     balances and debt under the new club's header. Each load claims a
     ticket; a result whose ticket is no longer current is dropped. The
     ticket is reissued whenever the club changes. */
  const agentsLoadTicket = useRef(0);
  const claimAgentsLoad = () => ++agentsLoadTicket.current;
  const agentsLoadIsCurrent = (ticket: number) =>
    isMounted.current && ticket === agentsLoadTicket.current;
  useVisibilityRefresh(async () => {
    if (!clubId) return;
    const ticket = claimAgentsLoad();
    const data = await AgentService.getAgents(clubId);
    if (agentsLoadIsCurrent(ticket)) setAgents(data);
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
    type: 'promote';
    title: string;
    message: string;
    agentId?: string;
    newRole?: string;
  } | null>(null);
  /* The exclusion dialog collects what fn_ca_ban_club_player records: the
     reason an operator gives, and whether the exclusion ends. Until
     2026-09-04 the reason was a hardcoded sentence and the expiry was always
     never. */
  const [banTarget, setBanTarget] = useState<string | null>(null);
  const [banReason, setBanReason] = useState('');
  const [banDays, setBanDays] = useState<'' | '7' | '30' | '90'>('');
  const [banBusy, setBanBusy] = useState(false);

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
  const [recentDistributions, setRecentDistributions] = useState<ReversibleDistribution[]>([]);
  const [payables, setPayables] = useState<AgentPayables | null>(null);
  const [payablesError, setPayablesError] = useState<string | null>(null);
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
    setAgents([]);
    const ticket = claimAgentsLoad();

    AgentService.getAgents(clubId)
      .then((data) => {
        if (agentsLoadIsCurrent(ticket)) setAgents(data);
      })
      .catch((err) => {
        if (agentsLoadIsCurrent(ticket)) setError(safeErrorMessage(err));
      })
      .finally(() => {
        if (agentsLoadIsCurrent(ticket)) setIsLoading(false);
      });
    return () => {
      // A club change reissues the ticket so the read in flight is dropped.
      claimAgentsLoad();
    };
  }, [clubId]);

  // Load recent distributions for clawback
  /* WHAT THIS USED TO BE. A client select on chip_transactions filtered to
     transaction_type in ('agent_to_player','promo_agent_to_player','send') -
     three types that have zero rows in that table, estate-wide - so the panel
     below has been empty on every club since it shipped, and the Clawback
     button under it has never been rendered once.

     fn_agent_wallet_reversible is the list the wallet cashier has been reading
     all along: the signed-in agent's own sends that are still inside their
     window, with seconds_left computed by the database. */
  const loadRecentDistributions = useCallback(async () => {
    if (!clubId || !user?.id) return;
    try {
      const rows = await AgentService.reversibleDistributions(clubId);
      if (isMounted.current) setRecentDistributions(rows);
    } catch (e) {
      reportError(e, 'AgentManagementPage.reversibleDistributions');
      if (isMounted.current) setRecentDistributions([]);
    }
  }, [clubId, user?.id, isMounted]);

  /* What the club actually owes, from the commission ledger. It needs a
     function because agent_commissions grants `authenticated` one read -
     their own rows - so a club owner cannot see any of this from the browser
     by any query. Loaded when the tab is opened, not on every page load: it
     aggregates a quarter of a million rows. */
  const loadPayables = useCallback(async () => {
    if (!clubId) return;
    setPayablesError(null);
    try {
      const resolved = await resolveClubUUID(clubId);
      const { data, error } = await supabase.rpc('fn_ca_agent_payables', {
        p_club_id: resolved,
      });
      if (error) throw error;
      if (isMounted.current) setPayables(data as AgentPayables);
    } catch (e) {
      reportError(e, 'AgentManagementPage.payables');
      if (isMounted.current) {
        setPayables(null);
        setPayablesError(
          isAuthzError(e)
            ? 'Agent Payables Are Restricted To Club Owners And Administrators'
            : 'The Commission Ledger Could Not Be Read'
        );
      }
    }
  }, [clubId, isMounted]);

  useEffect(() => {
    if (activeTab === 'payouts') loadPayables();
  }, [activeTab, loadPayables]);

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
      const ticket = claimAgentsLoad();
      try {
        const data = await AgentService.getAgents(clubId);
        if (!agentsLoadIsCurrent(ticket)) return;
        setAgents(data);
        setError(null);
      } catch (err) {
        if (!agentsLoadIsCurrent(ticket)) return;
        reportError(err, 'AgentManagementPage.Failed_to_reload_agents');
        toast.error('Failed to load agents');
        setError(safeErrorMessage(err, 'Failed to reload agents'));
      } finally {
        if (agentsLoadIsCurrent(ticket)) setIsLoading(false);
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
        // wallets and agent_commissions.
        //
        // PHASE 7 (2026-09-01): this comment used to name commission_records
        // and say it was "still in supabase_realtime". Neither was true - that
        // table held zero rows for its whole life, was never in the
        // publication, and is now dropped. A comment that points at a dead
        // table is how the next person wires a subscription to nothing.
        //
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
  /* One place the three agent roles are spelled. The Credit Limits table used
     a two-branch ternary over three roles, so every super_agent in that table
     was labelled "Sub-Agent" while the Agents tab above it, which gets the
     ternary right, called the same person a Super Agent. */
  const AGENT_ROLE_LABELS: Record<string, string> = {
    super_agent: 'Super Agent',
    agent: 'Agent',
    sub_agent: 'Sub-Agent',
  };

  /* The reasons fn_ca_ban_club_player can refuse, in the words an operator
     should read rather than the enum the function returns. */
  const BAN_REFUSALS: Record<string, string> = {
    no_player: 'No Player Was Selected.',
    cannot_ban_the_owner: 'The Club Owner Cannot Be Excluded From Their Own Club.',
    cannot_ban_club_staff: 'Club Staff Cannot Be Excluded. Change Their Role First.',
    not_a_member_of_this_club: 'That Player Is Not A Member Of This Club.',
  };

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

  /* The ink a utilisation reads in. Same three thresholds as the badge it
     replaces (90 critical, 75 warning) - only the dress changed. */
  const utilizationInk = (agent: Agent): ConsoleInk => {
    const status = getUtilizationStatus(agent);
    return status === 'critical' ? 'red' : status === 'warning' ? 'gold' : 'green';
  };

  /* Lifted verbatim out of the old header button so the foot's painted plate
     can call it. Same rows, same columns, same filename, same silent-catch. */
  const handleExportAgents = () => {
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
    const { type, agentId, newRole } = confirmAction;
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
    }
  };

  /* THIS USED TO BE A SUCCESS TOAST AND NOTHING ELSE. The dialog collected
     the player id and dropped it; no operator who pressed this button had
     ever banned anybody.

     fn_ca_ban_club_player writes the blacklists row - which is not a label:
     atomic_table_buyin, atomic_table_rebuy and atomic_tournament_register all
     read that table, so the exclusion stops them buying in, rebuying and
     registering - and files the player_banned audit event. It deliberately
     does NOT delete the club_members row, because that row carries the
     player's chips, and it does not close a seat (CLAUDE.md 11.5). Both of
     those are reported back so the operator can act on them here. */
  const executeBan = async () => {
    const playerId = banTarget;
    if (!playerId || !clubId || banBusy) return;
    const reason = banReason.trim();
    if (reason.length < 3) {
      toast.error('Say Why. The Reason Is Written To The Exclusion Record.');
      return;
    }
    setBanBusy(true);
    try {
      const resolved = await resolveClubUUID(clubId);
      const expiresAt = banDays
        ? new Date(Date.now() + Number(banDays) * 86_400_000).toISOString()
        : null;
      const { data, error } = await supabase.rpc('fn_ca_ban_club_player', {
        p_club_id: resolved,
        p_user_id: playerId,
        p_reason: reason,
        p_expires_at: expiresAt,
      });
      if (error) throw error;
      const outcome = (data || {}) as {
        ok?: boolean;
        reason?: string;
        was_already_excluded?: boolean;
        chips_held?: number;
        credit_used?: number;
        live_seats?: number;
      };
      if (!outcome.ok) {
        toast.error(BAN_REFUSALS[outcome.reason || ''] || 'That Player Could Not Be Excluded.');
        return;
      }
      setBanTarget(null);
      setBanReason('');
      setBanDays('');
      toast.success(
        outcome.was_already_excluded
          ? 'That Player Was Already Excluded. The Exclusion Is Renewed.'
          : banDays
            ? `Player Excluded From This Club For ${banDays} Days.`
            : 'Player Excluded From This Club.'
      );
      if (outcome.live_seats) {
        const tableIds = await liveSeatTableIds(resolved, playerId);
        const removal = await adminRemovePlayerFromClubTables(
          tableIds,
          playerId,
          'Excluded from the club by an administrator'
        );
        toast.info(
          `Removed From ${fmt(removal.removed)} Tables; ${fmt(removal.pending)} Pending; ${fmt(removal.failed)} Failed. ${removal.firstError || ''}`.trim()
        );
      }
      if (Number(outcome.chips_held) > 0 || Number(outcome.credit_used) > 0) {
        toast.warning(
          `They Still Hold ${fmtChips(Number(outcome.chips_held) || 0)} Chips` +
            (Number(outcome.credit_used) > 0
              ? ` And Owe ${fmtChips(Number(outcome.credit_used))} On Credit`
              : '') +
            '. Settle That Before Removing Their Membership.'
        );
      }
      masterBus.emit('ADMIN_ACTION', {
        action: 'player_banned',
        target: playerId,
        userId: user?.id,
      });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'That Player Could Not Be Excluded.');
    } finally {
      setBanBusy(false);
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
      <StandardContentLayout className={styles.page}>
        <EmptyState
          icon="CLUB"
          eyebrow="Club Context Required"
          tone="permission"
          title="Choose A Club To Manage Agents"
          description="Agent Roles, Commissions, Credit Lines, And Players Belong To One Club. Open This Tool From That Club's Operations Menu."
          action={{ label: 'Return To Arena', onClick: () => navigate('/') }}
        />
      </StandardContentLayout>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <StandardContentLayout className={styles.page}>
        <SpadeConsole
          className={styles.console}
          aria-busy
          eyebrow="Club Arena"
          title="Agent Management"
          pill="Loading"
          pillInk="muted"
          foot="foot"
        >
          <PageSkeleton variant="dashboard" />
        </SpadeConsole>
      </StandardContentLayout>
    );
  }

  // Error state
  if (error) {
    return (
      <StandardContentLayout className={styles.page}>
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
      </StandardContentLayout>
    );
  }

  return (
    <StandardContentLayout className={styles.page}>
      {/* ── The head: the roster's own figures as rows on the glass ──── */}
      <SpadeConsole
        className={styles.console}
        eyebrow="Club Arena"
        title="Agent Management"
        subtitle="Manage Agents, Commissions, And Credit Lines"
        pill={compactChips(totalAgents)}
        pillInk={totalAgents === 0 ? 'muted' : 'blue'}
        foot="plates"
        /* TWO ACTIONS OR NONE: the foot paints both plates, so Export is
           always present and simply disabled with an empty roster, rather
           than leaving a painted plate with no word on it. */
        plates={{
          secondary: {
            label: 'Export',
            disabled: agents.length === 0,
            onClick: handleExportAgents,
          },
          primary: {
            label: 'Add Agent',
            ink: 'white',
            onClick: () => setShowAddModal(true),
          },
        }}
      >
        {/* AgentService.getAgents reads at most QUERY_LIMITS.MODERATE rows. A
            club at the cap sees exactly the cap, which used to look like the
            whole roster. */}
        {agents.length >= QUERY_LIMITS.MODERATE && (
          <p className="sc-copy" role="status">
            Showing The First {fmt(QUERY_LIMITS.MODERATE)} Agents. The Club Has More; The Summary
            Counts Only These.
          </p>
        )}

        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Active Agents</dt>
            <dd className={`${styles.factValue} sc-ink--silver`}>
              {compactChips(activeAgents)}/{compactChips(totalAgents)}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Total Players</dt>
            <dd className={`${styles.factValue} sc-ink--silver`}>{compactChips(totalPlayers)}</dd>
          </div>
          <div className={styles.fact}>
            <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Weekly Rake</dt>
            <dd className={`${styles.factValue} sc-ink--green`}>{formatMoney(weeklyRake)}</dd>
          </div>
          <div className={styles.fact}>
            <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Credit Extended</dt>
            <dd className={`${styles.factValue} sc-ink--gold`}>
              {formatMoney(totalCreditExtended)}
            </dd>
          </div>
        </dl>

        {/* The six views are lit words cut into the glass. The master paints
            no tab, so nothing here draws one. */}
        <nav className={styles.rail} role="tablist" aria-label="Agent Views">
          {(
            [
              'agents',
              'players',
              'hierarchy',
              'credit-limits',
              'commissions',
              'payouts',
            ] as TabType[]
          ).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={`${styles.railWord} ${
                activeTab === tab ? 'sc-ink--silver' : 'sc-ink--muted'
              }`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'agents' && 'Agents'}
              {tab === 'players' && 'Players'}
              {tab === 'hierarchy' && 'Hierarchy'}
              {tab === 'credit-limits' && 'Credit Limits'}
              {tab === 'commissions' && 'Commissions'}
              {tab === 'payouts' && 'Payouts'}
            </button>
          ))}
        </nav>
      </SpadeConsole>

      {/* Tab Content — Swipeable */}
      <div className={styles.content} {...swipeHandlers}>
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* AGENTS TAB */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'agents' && (
          <SpadeConsole
            className={styles.console}
            eyebrow="Agent Network"
            title="Agents"
            pill={agents.length === 0 ? 'Empty' : compactChips(agents.length)}
            pillInk={agents.length === 0 ? 'muted' : 'blue'}
            foot="foot"
          >
            {agents.length === 0 ? (
              <div className={styles.empty}>
                <span className="sc-label sc-ink--muted">No Agents Yet</span>
                <p className="sc-copy sc-copy--center">
                  Promote A Member To Start The Agent Network For This Club.
                </p>
              </div>
            ) : (
              <ol className={styles.list}>
                {agents.map((agent) => (
                  /* THE STAGGER STILL PLAYS. Same `visibleAgents` set, same
                     step, same eight-pixel lift - it runs on the global
                     `animationsFadeInUp` keyframe now instead of a module
                     copy of it. */
                  <li
                    key={agent.id}
                    className={styles.row}
                    style={
                      visibleAgents.has(agent.id)
                        ? {
                            opacity: 0,
                            transform: 'translateY(8px)',
                            animation: 'animationsFadeInUp 0.4s ease-out forwards',
                          }
                        : { opacity: 0, transform: 'translateY(8px)' }
                    }
                  >
                    <span className={`${styles.rowName} sc-ink--silver`}>
                      {agent.displayName || 'Unknown Agent'}
                    </span>
                    {/* Words in the master's own ink, never capsules. */}
                    <span className={styles.rowFlags}>
                      <span className="sc-label sc-ink--blue">
                        {agent.role === 'super_agent'
                          ? 'Super Agent'
                          : agent.role === 'agent'
                            ? 'Agent'
                            : 'Sub-Agent'}
                      </span>
                      <span
                        className={`sc-label ${
                          agent.status === 'active' ? 'sc-ink--green' : 'sc-ink--red'
                        }`}
                      >
                        {agent.status}
                      </span>
                      {agent.parentAgentName && (
                        <span className="sc-label sc-ink--muted">
                          Under: {agent.parentAgentName}
                        </span>
                      )}
                    </span>

                    <dl className={styles.facts}>
                      <div className={styles.fact}>
                        <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Commission</dt>
                        <dd className={`${styles.factValue} sc-ink--silver`}>
                          {formatPercent(agent.commissionRate)}
                        </dd>
                      </div>
                      <div className={styles.fact}>
                        <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Rakeback</dt>
                        <dd className={`${styles.factValue} sc-ink--silver`}>
                          {formatPercent(agent.playerRakebackRate)}
                        </dd>
                      </div>
                      <div className={styles.fact}>
                        <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Players</dt>
                        <dd className={`${styles.factValue} sc-ink--silver`}>
                          {fmt(agent.activePlayerCount)}/{fmt(agent.totalPlayers)}
                        </dd>
                      </div>
                      <div className={styles.fact}>
                        <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Weekly Rake</dt>
                        <dd className={`${styles.factValue} sc-ink--green`}>
                          {formatMoney(agent.weeklyRakeGenerated)}
                        </dd>
                      </div>
                      {/* Three balances used to sit beside one glyph and two
                          empty spans, so two of the three had no name. */}
                      <div className={styles.fact}>
                        <dt className={styles.walletLabel}>Agent</dt>
                        <dd className={`${styles.factValue} sc-ink--silver`}>
                          {formatMoney(agent.businessBalance)}
                        </dd>
                      </div>
                      <div className={styles.fact}>
                        <dt className={styles.walletLabel}>Player</dt>
                        <dd className={`${styles.factValue} sc-ink--silver`}>
                          {formatMoney(agent.playerBalance)}
                        </dd>
                      </div>
                      <div className={styles.fact}>
                        <dt className={styles.walletLabel}>Promo</dt>
                        <dd className={`${styles.factValue} sc-ink--silver`}>
                          {formatMoney(agent.promoBalance)}
                        </dd>
                      </div>
                      {!agent.isPrepaid && (
                        /* The drawn progress bar is gone. The same three
                           thresholds now colour the figure itself, which says
                           the same thing without painting a control. */
                        <div className={styles.fact}>
                          <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>
                            Credit Line
                          </dt>
                          <dd className={`${styles.factValue} sc-ink--${utilizationInk(agent)}`}>
                            {formatMoney(agent.creditUsed)} / {formatMoney(agent.creditLimit)} (
                            {(getCreditUtilization(agent) || 0).toFixed(0)}% Used)
                          </dd>
                        </div>
                      )}
                    </dl>

                    <div className={styles.rowActions}>
                      {agent.status === 'active' ? (
                        <>
                          <button
                            type="button"
                            className={`${styles.word} sc-ink--red`}
                            onClick={() => handleSuspendAgent(agent.id)}
                          >
                            Suspend
                          </button>
                          <button
                            type="button"
                            className={`${styles.word} sc-ink--blue`}
                            onClick={() => {
                              setTransferAgentId(agent.userId);
                              setShowTransferModal(true);
                            }}
                          >
                            Transfer
                          </button>
                          {agent.role === 'agent' && (
                            <button
                              type="button"
                              className={`${styles.word} sc-ink--gold`}
                              onClick={() => handlePromoteAgent(agent.id, agent.role)}
                            >
                              Promote
                            </button>
                          )}
                          {agent.role === 'super_agent' && (
                            <button
                              type="button"
                              className={`${styles.word} sc-ink--gold`}
                              onClick={() => handlePromoteAgent(agent.id, agent.role)}
                            >
                              Demote
                            </button>
                          )}
                          <button
                            type="button"
                            className={`${styles.word} sc-ink--blue`}
                            onClick={() => {
                              setPlayerInviteAgentUserId(agent.userId);
                              setShowPlayerInviteModal(true);
                            }}
                          >
                            Add Player
                          </button>
                          <button
                            type="button"
                            className={`${styles.word} sc-ink--blue`}
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
                          type="button"
                          className={`${styles.word} sc-ink--green`}
                          onClick={() => handleReinstateAgent(agent.id)}
                        >
                          Reinstate
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </SpadeConsole>
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
                setBanReason('');
                setBanDays('');
                setBanTarget(playerId);
              }}
              onViewProfile={(playerId) => {
                navigate(`/profile/${playerId}`);
              }}
            />

            {/* Sends this agent can still take back. The window, the amount
                already claimed back and the seconds left are all the
                database's, from fn_agent_wallet_reversible. */}
            {recentDistributions.length > 0 && (
              <SpadeConsole
                className={styles.console}
                eyebrow="Agent Wallet"
                title="Sends You Can Still Take Back"
                pill={compactChips(recentDistributions.length)}
                pillInk="gold"
                foot="foot"
              >
                {recentDistributions.map((tx) => {
                  const mins = Math.floor(tx.seconds_left / 60);
                  const secs = tx.seconds_left % 60;
                  const partial = Number(tx.claimed_back) > 0;
                  return (
                    <div key={tx.transaction_id} className={styles.row}>
                      <span className={`${styles.rowName} sc-ink--silver`}>
                        {fmtChips(tx.remaining)} Chips To {tx.to_name}
                      </span>
                      <span className={`${styles.rowMeta} sc-ink--muted`}>
                        {partial
                          ? `${fmtChips(tx.claimed_back)} Of ${fmtChips(tx.amount)} Already Taken Back - `
                          : ''}
                        {/* Gold while the window is open, red inside the last
                            ten seconds, exactly as a countdown reads
                            everywhere else on the master. */}
                        <span className={tx.seconds_left <= 10 ? 'sc-ink--red' : 'sc-ink--gold'}>
                          {mins}:{String(secs).padStart(2, '0')} Left
                        </span>
                      </span>
                      <button
                        type="button"
                        className={`${styles.word} sc-ink--red`}
                        onClick={async () => {
                          if (
                            !(await confirmDialog({
                              title: 'Take This Send Back',
                              message: `Take back ${fmtChips(tx.remaining)} chips from ${tx.to_name}? This returns them to your agent wallet.`,
                              confirmText: 'Take It Back',
                              variant: 'danger',
                            }))
                          )
                            return;
                          setClawbackProcessing(tx.transaction_id);
                          try {
                            const result = await AgentService.claimBackDistribution(
                              clubId!,
                              tx.transaction_id,
                              tx.remaining,
                              'Taken back from the agent network console'
                            );
                            if (result.success) {
                              toast.success(
                                `Took Back ${fmtChips(result.claimedBack || tx.remaining)} Chips.`
                              );
                              loadRecentDistributions();
                            } else {
                              toast.error(result.error || 'That Claim Back Was Refused.');
                            }
                          } catch (err: unknown) {
                            toast.error(
                              err instanceof Error ? err.message : 'That Claim Back Was Refused.'
                            );
                          } finally {
                            setClawbackProcessing(null);
                          }
                        }}
                        disabled={clawbackProcessing === tx.transaction_id}
                      >
                        {clawbackProcessing === tx.transaction_id ? 'Working' : 'Take Back'}
                      </button>
                    </div>
                  );
                })}
              </SpadeConsole>
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
              /* agent.userId, NOT agent.id. ChipTransferModal matches its
                 recipient against club_members joined to users, so the agents
                 primary key that used to be sent here selected nobody: a
                 transfer started from the hierarchy tree opened on a blank
                 recipient, while the identical button on the Agents tab, which
                 has always sent userId, worked. */
              setTransferAgentId(agent.userId);
              setShowTransferModal(true);
            }}
          />
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* CREDIT LIMITS TAB — Direct Assignment */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'credit-limits' && (
          /* THE TABLE IS GONE, AND HAD TO GO. Seven columns of credit figures
             on a 393px phone scrolled sideways off the screen; this is one row
             per agent with its fields stacked as label/value pairs. The Save /
             Cancel / Edit controls and handleSetCreditLimit are unchanged. */
          <SpadeConsole
            className={styles.console}
            eyebrow="Credit Limit Assignment"
            title="Credit Limits"
            pill={compactChips(agents.length)}
            pillInk="blue"
            foot="foot"
          >
            <p className="sc-copy">
              Assign Credit Limits Directly. Clubs Set Limits For Agents. Agents Set Limits For
              Sub-Agents.
            </p>

            <ol className={styles.list}>
              {agents.map((agent) => (
                <li key={agent.id} className={styles.row}>
                  <span className={`${styles.rowName} sc-ink--silver`}>{agent.displayName}</span>
                  <span className={styles.rowFlags}>
                    <span className="sc-label sc-ink--blue">
                      {AGENT_ROLE_LABELS[agent.role] || agent.role}
                    </span>
                    {agent.status !== 'active' && (
                      <span className="sc-label sc-ink--red">{agent.status}</span>
                    )}
                  </span>

                  <dl className={styles.facts}>
                    <div className={styles.fact}>
                      <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Assigned By</dt>
                      <dd className={`${styles.factValue} sc-ink--silver`}>
                        {/* A super agent is assigned by the club, the same as an
                            agent; only a sub-agent hangs off a parent. The old
                            two-branch test sent super agents down the parent
                            branch and printed the word "Agent" where the club
                            belonged. */}
                        {agent.parentAgentName || 'Club'}
                      </dd>
                    </div>
                    <div className={styles.fact}>
                      <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Credit Limit</dt>
                      <dd className={`${styles.factValue} sc-ink--silver`}>
                        {editingLimit === agent.id ? (
                          <input
                            type="number"
                            className={`${styles.groove} sc-ink--silver`}
                            value={newLimit}
                            onChange={(e) => setNewLimit(Number(e.target.value))}
                            aria-label="Credit Limit"
                            autoFocus
                          />
                        ) : (
                          formatMoney(agent.creditLimit)
                        )}
                      </dd>
                    </div>
                    <div className={styles.fact}>
                      <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Used</dt>
                      <dd className={`${styles.factValue} sc-ink--silver`}>
                        {formatMoney(agent.creditUsed)}
                      </dd>
                    </div>
                    <div className={styles.fact}>
                      <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Utilization</dt>
                      <dd className={`${styles.factValue} sc-ink--${utilizationInk(agent)}`}>
                        {(getCreditUtilization(agent) || 0).toFixed(0)}%
                      </dd>
                    </div>
                  </dl>

                  <div className={styles.rowActions}>
                    {editingLimit === agent.id ? (
                      <>
                        <button
                          type="button"
                          className={`${styles.word} sc-ink--green`}
                          onClick={() => handleSetCreditLimit(agent.id, newLimit)}
                        >
                          Save
                        </button>
                        {/* This button had NO CONTENT - an emoji was stripped
                            from it and the empty wrapper was left, so beside
                            Save there was an invisible control that only a
                            screen reader could find. */}
                        <button
                          type="button"
                          className={`${styles.word} sc-ink--muted`}
                          onClick={() => setEditingLimit(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={`${styles.word} sc-ink--blue`}
                        onClick={() => {
                          setEditingLimit(agent.id);
                          setNewLimit(agent.creditLimit);
                        }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            <div className={styles.rules}>
              <span className="sc-label sc-ink--blue">Credit Assignment Rules</span>
              <ul className={styles.ruleList}>
                <li className="sc-copy">
                  <strong>Club To Agent:</strong> Club Owner Assigns Credit Limits When Creating An
                  Agent
                </li>
                <li className="sc-copy">
                  <strong>Agent To Sub-Agent:</strong> Agents Assign Limits To Their Sub-Agents
                  (Cannot Exceed Their Own Limit)
                </li>
                <li className="sc-copy">
                  <strong>Adjustable:</strong> Limits Can Be Changed Anytime By The Assigning Level
                </li>
                <li className="sc-copy">
                  <strong>Suspension:</strong> Agents At 90%+ Utilization Should Be Reviewed
                </li>
              </ul>
            </div>
          </SpadeConsole>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* COMMISSIONS TAB */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'commissions' && (
          <div className={styles.commissionsSection}>
            <AgentCommissionDashboard clubId={clubId} />
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {/* PAYOUTS TAB */}
        {/* ═══════════════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'payouts' && (
          <div className={styles.payoutsSection}>
            {/* Player Cashout Requests (wired to CashoutService) */}
            <AgentCashoutPanel clubId={clubId} />

            {/*
              THE SCHEDULE THIS BLOCK USED TO PRINT WAS THREE LINES OF STATIC
              JSX - Sunday 11:59 PM PST, Monday 4:00 AM, a 48-hour grace period
              - sitting next to a payouts table as though it described this
              club's settlement run. It described nothing; no settlement_periods
              row was read anywhere on the page. This club has no settlement
              period at all, which is worth an operator knowing, so the block
              now says what is actually true and links to the settlement page
              rather than reciting a timetable nobody maintains.
            */}

            {/* SIX COLUMNS OF COMMISSION ON A 393px PHONE, GONE. One row per
                agent with its fields stacked; every figure is the ledger's,
                unchanged. */}
            <SpadeConsole
              className={styles.console}
              eyebrow="Commission Ledger"
              title="What This Club Owes Its Agents"
              pill={payables ? fmtChips(payables.total_owed) : undefined}
              pillInk="gold"
              foot="foot"
            >
              {payablesError ? (
                <p className="sc-copy sc-ink--red">{payablesError}</p>
              ) : !payables ? (
                <p className="sc-copy" aria-busy="true">
                  Reading The Commission Ledger
                </p>
              ) : (
                <>
                  <p className="sc-copy">
                    Unsettled Commission Across {fmt(payables.agents)}{' '}
                    {payables.agents === 1 ? 'Agent' : 'Agents'}, From {fmt(payables.total_rows)}{' '}
                    Earned {payables.total_rows === 1 ? 'Row' : 'Rows'}
                  </p>
                  <ol className={styles.list}>
                    {payables.rows.map((row) => (
                      <li key={row.agent_id} className={styles.row}>
                        <span className={`${styles.rowName} sc-ink--silver`}>{row.name}</span>
                        <span className={styles.rowFlags}>
                          <span className="sc-label sc-ink--blue">
                            {AGENT_ROLE_LABELS[row.role] || row.role}
                          </span>
                        </span>
                        <dl className={styles.facts}>
                          <div className={styles.fact}>
                            <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Owed</dt>
                            <dd className={`${styles.factValue} sc-ink--gold`}>
                              {fmtChips(row.owed)}
                            </dd>
                          </div>
                          <div className={styles.fact}>
                            <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>
                              Earned Rows
                            </dt>
                            <dd className={`${styles.factValue} sc-ink--silver`}>
                              {fmt(row.rows_behind)}
                            </dd>
                          </div>
                          <div className={styles.fact}>
                            <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>
                              Oldest Unsettled
                            </dt>
                            <dd className={`${styles.factValue} sc-ink--silver`}>
                              {row.oldest_unsettled
                                ? timeAgo(row.oldest_unsettled)
                                : 'Nothing Owed'}
                            </dd>
                          </div>
                          <div className={styles.fact}>
                            <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Funding</dt>
                            <dd className={`${styles.factValue} sc-ink--silver`}>
                              {row.is_prepaid
                                ? 'Prepaid'
                                : `${fmtChips(row.credit_used)} Of ${fmtChips(row.credit_limit)} Drawn`}
                            </dd>
                          </div>
                        </dl>
                      </li>
                    ))}
                  </ol>
                  {payables.agents > payables.rows.length && (
                    <p className="sc-copy">
                      Showing The {fmt(payables.rows.length)} Agents Who Are Owed The Most, Of{' '}
                      {fmt(payables.agents)}. The Total Above Counts Every One Of Them.
                    </p>
                  )}
                </>
              )}
            </SpadeConsole>
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
                    <span className={styles.roleLabel}>Super Agent</span>
                    <span className={styles.roleDesc}>Can Have Agents Under Them</span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.roleOption} ${newAgentForm.role === 'agent' ? styles.selected : ''}`}
                    onClick={() => setNewAgentForm({ ...newAgentForm, role: 'agent' })}
                  >
                    <span className={styles.roleLabel}>Agent</span>
                    <span className={styles.roleDesc}>Standard Agent Role</span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.roleOption} ${newAgentForm.role === 'sub_agent' ? styles.selected : ''}`}
                    onClick={() => setNewAgentForm({ ...newAgentForm, role: 'sub_agent' })}
                  >
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
                  {/* The chip glyph that used to sit here was a mark stuck on
                      top of a control; the field says what it holds instead. */}
                  <span className={styles.currencySymbol}>Chips</span>
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
                <h4>Agent Summary</h4>
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
                {isCreating ? 'Creating...' : 'Create Agent'}
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

      {/* Exclusion dialog: reason and expiry go to the record. */}
      {banTarget && (
        <div
          className={styles.banOverlay}
          onClick={() => !banBusy && setBanTarget(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !banBusy) setBanTarget(null);
          }}
        >
          <div
            className={styles.banDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ban-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="ban-dialog-title">Exclude Player From This Club</h3>
            <p className={styles.banHelp}>
              They Will Not Be Able To Buy In, Rebuy Or Register Here. Their Chips Stay In Their
              Wallet And Their Seat Is Not Closed.
            </p>
            <label className={styles.banField}>
              <span>Reason</span>
              <textarea
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="What Happened"
              />
            </label>
            <label className={styles.banField}>
              <span>Expires</span>
              <select
                value={banDays}
                onChange={(e) => setBanDays(e.target.value as typeof banDays)}
              >
                <option value="">Never</option>
                <option value="7">In 7 Days</option>
                <option value="30">In 30 Days</option>
                <option value="90">In 90 Days</option>
              </select>
            </label>
            <div className={styles.banActions}>
              <button
                type="button"
                className={styles.banCancel}
                onClick={() => setBanTarget(null)}
                disabled={banBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.banConfirm}
                onClick={() => void executeBan()}
                disabled={banBusy || banReason.trim().length < 3}
              >
                {banBusy ? 'Excluding...' : 'Exclude Player'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmAction}
        title={confirmAction?.title || 'Confirm'}
        message={confirmAction?.message || ''}
        variant="danger"
        onConfirm={executeConfirmAction}
        onCancel={() => setConfirmAction(null)}
      />
    </StandardContentLayout>
  );
}

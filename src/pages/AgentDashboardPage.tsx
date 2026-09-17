/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT DASHBOARD PAGE — Agent Operations Center
 * Ported from World Hub agent-dashboard.js → Club Arena TypeScript
 *
 * Tabs (8): Overview, Players, Cashouts, Commissions, Score, Analytics, Promo, Credit
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { isClubStaff } from '../types/clubRoles';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { resolveClubUUID } from '../utils/clubIdResolver';
import type { ChipTransaction } from '../types/database.types';
import {
  CashoutReceiptChecks,
  useCashoutReceiptChecks,
} from '../components/wallet/CashoutReceiptChecks';
import { useCashoutScope, useCashoutScopeKey } from '../hooks/useCashoutScope';
import {
  runCashoutOperation,
  recoverCashoutOperation,
  captureCashoutStart,
  assertCashoutStartCurrent,
  type CashoutStart,
} from '../services/CashoutOperation';
import {
  usePreparedCashoutOperations,
  isCashoutStartCurrent,
} from '../hooks/usePreparedCashoutOperations';
import { confirmDialog } from '../components/common/confirmDialog';
import { WalletService } from '../services/WalletService';
import { CreditService } from '../services/CreditService';
import {
  prepareCreditReduction,
  captureCreditReduction,
  assertCreditReductionCurrent,
  listPendingCreditReductions,
  capturePendingCreditReduction,
  recoverCreditReduction,
  retireCreditReduction,
  type PreparedCreditReduction,
  type PendingCreditReduction,
} from '../services/CreditReductionOperation';
import {
  creditReductionAmount,
  type CreditReductionEnvelope,
} from '../lib/CreditReductionContract';
import {
  assertChipAmount,
  runAgentWalletOperation,
  confirmedAgentWalletReceipt,
} from '../services/AgentWalletIntent';
import { exportToCSV } from '../lib/export';
import TransactionLedgerView from '../components/common/TransactionLedgerView';
import './AdminDashboardPage.css';
import AgentScoreCard from '../components/agent/AgentScoreCard';

import { useIsMounted } from '../hooks/useIsMounted';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { retryFetch } from '../utils/retryFetch';
import { fmt, fmtChips, timeAgo } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import AgentBackOffice from '../components/agent/AgentBackOffice';

import { safeErrorMessage } from '../utils/safeErrorMessage';
import { EmptyState } from '../components/common/EmptyState';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { resolvePageClubId, pickPreferredClubId } from '../utils/resolvePageClubId';
type AgentTab =
  | 'overview'
  | 'players'
  | 'cashouts'
  | 'commissions'
  | 'score'
  | 'analytics'
  | 'promo'
  | 'credit'
  | 'statement';

// ── Agent Dashboard Types ──────────────────────────────────────
interface AgentProfile {
  id: string;
  display_name?: string;
  username?: string;
  avatar_url?: string;
  last_seen?: string;
}
interface DownlineMember {
  user_id: string;
  role: string;
  chip_balance: number;
  status: string;
  created_at: string;
  /** club_members.agent_id - the assignment every write path in this app uses. */
  agent_id?: string;
  /** club_members.invited_by - the older referral column, kept as a fallback. */
  referred_by?: string;
  profile?: AgentProfile;
}
interface CashoutRequest {
  id: string;
  player_id: string;
  club_id: string;
  amount: number;
  status: string;
  player_note?: string;
  created_at: string;
  updated_at?: string;
}
interface AgentCommission {
  id: string;
  user_id: string;
  club_id: string;
  amount: number;
  source_type: string;
  source_id?: string;
  notes?: string;
  created_at: string;
  // Whether this row has been claimed. Phase 6 made commission claimable and
  // phase 7 made every other surface say so; this list showed a claimed row and
  // an owed one identically, which is the same figure meaning two things.
  settled_at?: string | null;
  /** 'claim' | 'round2' | null - which mechanism paid it (v_agent_commissions). */
  settled_via?: string | null;
}
// ChipTransaction imported from types/database.types (canonical definition)

export default function AgentDashboardPage() {
  const { user } = useAuthUser();
  const [params] = useSearchParams();
  const key = useCashoutScopeKey(user?.id, params.toString());
  return <AgentDashboardContent key={key} />;
}

function AgentDashboardContent() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthUser();
  const isCurrent = useCashoutScope(user?.id, searchParams.toString());
  const cashoutRowsCurrent = useRef<(() => boolean) | null>(null);
  const cashoutRowsScope = useRef<(() => boolean) | null>(null);
  const cashoutInFlight = useRef(false);
  const cashoutReadGeneration = useRef(0);

  const [tab, setTab] = useState<AgentTab>('overview');
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [clubId, setClubId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [role, setRole] = useState('agent');

  // Overview data
  const [players, setPlayers] = useState<DownlineMember[]>([]);
  const [cashoutsLoaded, setCashoutsAvailable] = useState(false);
  const cashoutsAvailable = cashoutsLoaded && cashoutRowsScope.current?.() === true;
  const [pendingCashouts, setPendingCashouts] = useState<CashoutRequest[]>([]);
  const [commissions, setCommissions] = useState<AgentCommission[]>([]);
  const [recentTx, setRecentTx] = useState<ChipTransaction[]>([]);

  // Search / Filter
  const [playerSearch, setPlayerSearch] = useState('');
  /* Both lists page from the SERVER. They used to fetch 100 transactions
     and 50 commissions once and page the 100 in the browser, so "Load More"
     could never reach row 101 and the commission list simply stopped at 50
     with no notice. */
  const TX_PAGE = 100;
  const COMMISSION_PAGE = 50;
  const [txHasMore, setTxHasMore] = useState(false);
  const [txLoadingMore, setTxLoadingMore] = useState(false);
  const [commissionsHasMore, setCommissionsHasMore] = useState(false);
  const [commissionsLoadingMore, setCommissionsLoadingMore] = useState(false);

  // Transfer modal
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferTarget, setTransferTarget] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNotes, setTransferNotes] = useState('');
  const walletOperationInFlightRef = useRef(false);

  // Credit management (owner-only)
  const [creditTarget, setCreditTarget] = useState('');
  const [creditAction, setCreditAction] = useState('issue_credit');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditNotes, setCreditNotes] = useState('');
  const creditInputEpoch = useRef(0);
  const [creditInputRevision, setCreditInputRevision] = useState(0);
  const invalidateCreditInput = () => {
    creditInputEpoch.current += 1;
    setCreditInputRevision(creditInputEpoch.current);
  };

  // Agents list (for promo/credit selectors)
  const [agents, setAgents] = useState<DownlineMember[]>([]);

  const mountedRef = useIsMounted();
  const toast = useToast();
  const SWR_TTL_MS = 5 * 60 * 1000; // 5-minute cache TTL
  const resolvedClubIdRef = useRef<string | null>(null);

  // Auto-clear success
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [success]);

  // Auto-clear errors after 6s
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  // Reset UUID cache when club changes
  useEffect(() => {
    resolvedClubIdRef.current = null;
  }, [clubId]);

  const dashLoadingRef = useRef(false);
  const dashReloadRef = useRef<string | null | undefined>(undefined);

  // ── Load Dashboard Data ───────────────────────────────────
  const loadDashboard = useCallback(
    async (cId: string | null) => {
      if (!isCurrent()) return;
      // Cashout events can arrive before the verified service receipt returns.
      // Keep that accepted row valid until acknowledgment, then refresh once.
      if (cashoutInFlight.current || dashLoadingRef.current) {
        dashReloadRef.current = cId;
        return;
      }
      dashLoadingRef.current = true;
      const cashoutGeneration = ++cashoutReadGeneration.current;
      const cashoutReadCurrent = () =>
        isCurrent() && cashoutReadGeneration.current === cashoutGeneration;
      cashoutRowsCurrent.current = null;
      setCashoutsAvailable(false);
      try {
        setLoading(true);
        setError(null);
        const targetClubId = cId || clubId;
        if (!targetClubId || !user?.id) {
          setError('No club selected.');
          setLoading(false);
          return;
        }

        // Use cached UUID when available to avoid redundant async lookups
        const uuid = resolvedClubIdRef.current || (await resolveClubUUID(targetClubId));
        if (!resolvedClubIdRef.current) resolvedClubIdRef.current = uuid;

        // Get current user's role
        const { data: membership } = await retryFetch(
          () =>
            supabase
              .from('club_members')
              .select('role')
              .eq('club_id', uuid)
              .eq('user_id', user.id)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: mountedRef }
        );
        if (mountedRef.current) setRole(membership?.role || 'agent');

        /*
          AN AGENT'S DOWNLINE IS club_members.agent_id, NOT invited_by.

          This page read `invited_by` and called it referred_by, while
          AgentService.getAgentPlayers, assignPlayerToAgent and
          fn_agent_attach_player all use `agent_id`. They are not the same
          column and they do not hold the same people: estate-wide, 1,575
          memberships carry an agent_id and 417 carry an invited_by. So every
          count on this page - Total Players, Online Now, Player Chips, the
          Players tab, the churn buckets, the CSV export - was computed over a
          different set of players than the agent network screen shows for the
          same agent, and a player assigned through the proper attach path
          appeared in neither.

          Both columns are read now: agent_id is the assignment, invited_by is
          kept as a fallback for the memberships that predate it, and a player
          who satisfies either is this agent's.
        */
        const { data: downline } = await retryFetch(
          () =>
            supabase
              .from('club_members')
              .select(
                'user_id, role, chip_balance, status, created_at, agent_id, referred_by:invited_by'
              )
              .eq('club_id', uuid)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: mountedRef }
        );

        // Filter to downline for non-owners
        const myDownline = (downline || []).filter(
          (m: DownlineMember) =>
            isClubStaff(membership?.role) || m.agent_id === user.id || m.referred_by === user.id
        );

        // Get profiles for all relevant users
        const allUserIds = (downline || []).map((m: DownlineMember) => m.user_id).filter(Boolean);
        const profileMap: Record<string, AgentProfile> = {};
        if (allUserIds.length > 0) {
          const { data: profiles } = await retryFetch(
            () =>
              supabase
                .from('profiles')
                .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url, last_seen`)
                .in('id', allUserIds)
                .then((r) => r),
            { maxRetries: 2, isMountedRef: mountedRef }
          );
          if (profiles)
            profiles.forEach((p: AgentProfile) => {
              profileMap[p.id] = p;
            });
        }

        // Enrich players with profiles
        const enrichedPlayers = myDownline.map((m: DownlineMember) => ({
          ...m,
          profile: profileMap[m.user_id] || {},
        }));

        // cashout_requests schema: player_id (not user_id), player_note (not notes), no payment_method
        const { data: cashouts, error: cashoutError } = await retryFetch(
          () =>
            supabase
              .from('cashout_requests')
              .select('id, player_id, club_id, amount, status, player_note, created_at, updated_at')
              .eq('club_id', uuid)
              .eq('status', 'pending')
              .order('created_at', { ascending: false })
              .then((r) => r),
          { maxRetries: 2, isMountedRef: mountedRef }
        );

        if (cashoutError) {
          cashoutRowsCurrent.current = null;
          throw cashoutError;
        }

        // Get commission history
        const { data: comms } = await retryFetch(
          () =>
            supabase
              // v_agent_commissions, not the table: since 20260908025653 round 2
              // pays a period without stamping each row, so the view's
              // settled_at (COALESCE(own stamp, settlement paid_at)) is the only
              // honest "has this been paid" on this screen.
              .from('v_agent_commissions')
              .select(
                'id, user_id, club_id, amount, source_type, source_id, notes, created_at, settled_at, settled_via'
              )
              .eq('club_id', uuid)
              .eq('user_id', user.id)
              .order('created_at', { ascending: false })
              .limit(COMMISSION_PAGE)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: mountedRef }
        );

        // Get recent transactions
        const { data: txns } = await retryFetch(
          () =>
            supabase
              .from('chip_transactions')
              .select(
                'id, from_user_id, to_user_id, club_id, amount, type:transaction_type, transaction_type, notes, created_at'
              )
              .eq('club_id', uuid)
              .order('created_at', { ascending: false })
              .limit(TX_PAGE)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: mountedRef }
        );

        // Get agents list
        const agentList = (downline || [])
          .filter((m: DownlineMember) => ['agent', 'sub_agent', 'super_agent'].includes(m.role))
          .map((m: DownlineMember) => ({
            ...m,
            profile: profileMap[m.user_id] || {},
          }));

        if (!isCurrent()) return;
        cashoutRowsCurrent.current = cashoutReadCurrent;
        cashoutRowsScope.current = isCurrent;
        setCashoutsAvailable(true);
        setPlayers(enrichedPlayers);
        setPendingCashouts(cashouts || []);
        setCommissions(comms || []);
        setCommissionsHasMore((comms || []).length >= COMMISSION_PAGE);
        setRecentTx((txns || []) as ChipTransaction[]);
        setTxHasMore((txns || []).length >= TX_PAGE);
        setAgents(agentList);

        // SWR: cache successful load for instant display on revisit
        try {
          const cacheKey = `agent_dashboard_swr_${user?.id}_${targetClubId}`;
          sessionStorage.setItem(
            cacheKey,
            // The stat cards sum these arrays. A cache that truncated them
            // to 30 / 20 / 30 / 20 rows painted "Total Players 30" and a
            // 30-player chip total on every revisit until the live read
            // landed. Whole arrays, so a cache hit and a fresh load agree.
            JSON.stringify({
              players: enrichedPlayers,
              pendingCashouts: cashouts || [],
              commissions: comms || [],
              recentTx: txns || [],
              agents: agentList,
              role: membership?.role || 'agent',
              cachedAt: Date.now(),
            })
          );
        } catch (e) {
          reportError(e, 'AgentDashboardPage.map');
          /* storage full */
        }
      } catch (err: unknown) {
        if (mountedRef.current) setError(safeErrorMessage(err));
      } finally {
        dashLoadingRef.current = false;
        const trailing = dashReloadRef.current;
        dashReloadRef.current = undefined;
        if (isCurrent()) {
          setLoading(false);
          if (trailing !== undefined) void loadDashboard(trailing);
        }
      }
    },
    [clubId, user?.id, isCurrent]
  );

  // ── Initial Load ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      if (!user?.id) return;
      /* The hamburger now stamps `?club=` on this link (it sits in the
         club-scoped Club Operations group), so an agent opening the dashboard
         from inside a club lands on THAT club's book. The param is resolved,
         so a slug works as well as a UUID.

         The fallback keeps its role filter — an agent's book only exists in
         clubs where they hold an agent-ish role — but no longer takes
         `mems[0]` from an unordered query. An agent working two clubs was
         shown whichever row came back first, which is a commission book
         chosen by the query planner. */
      const qClub = searchParams.get('club') || searchParams.get('clubId');
      let targetClub = qClub
        ? await resolvePageClubId({ routeClubId: qClub, allowFallback: false })
        : null;

      /* Named and unresolvable is a bad link. Do not answer it with a
         different club's commission book; say so. */
      if (qClub && !targetClub) {
        if (!cancelled) {
          setError('That Club Could Not Be Found.');
          setLoading(false);
        }
        return;
      }

      if (!targetClub) {
        const { data: mems } = await retryFetch(
          () =>
            supabase
              .from('club_members')
              .select('club_id')
              .eq('user_id', user.id)
              // co_owner was missing, so a co-owner with no other membership
              // was told they belong to no club at all.
              .in('role', ['agent', 'sub_agent', 'super_agent', 'owner', 'co_owner', 'admin'])
              .order('joined_at', { ascending: true })
              .then((r) => r),
          { maxRetries: 2, isMountedRef: mountedRef }
        );
        targetClub = pickPreferredClubId((mems || []).map((m: { club_id: string }) => m.club_id));
      }

      if (targetClub && !cancelled) {
        setClubId(targetClub);
        loadDashboard(targetClub);
      } else if (!cancelled) {
        setError('No club found or selected.');
        setLoading(false);
      }
    };
    init();
    return () => {
      cancelled = true;
    };
  }, [user?.id, searchParams, loadDashboard]);

  // SWR: try to display cached data instantly on mount
  useEffect(() => {
    if (!user?.id || !clubId) return;
    try {
      const cacheKey = `agent_dashboard_swr_${user.id}_${clubId}`;
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        const age = parsed.cachedAt ? Date.now() - parsed.cachedAt : Infinity;
        if (age < SWR_TTL_MS && parsed.players) {
          setPlayers(parsed.players);
          // Cashout decisions require the fresh scoped request read, never cached rows.
          if (parsed.commissions) {
            setCommissions(parsed.commissions);
            setCommissionsHasMore(parsed.commissions.length >= COMMISSION_PAGE);
          }
          if (parsed.recentTx) {
            setRecentTx(parsed.recentTx);
            setTxHasMore(parsed.recentTx.length >= TX_PAGE);
          }
          if (parsed.agents) setAgents(parsed.agents);
          if (parsed.role) setRole(parsed.role);
          setLoading(false);
        }
      }
    } catch (e) {
      reportError(e, 'AgentDashboardPage.useEffect');
      /* corrupt cache */
    }
  }, [user?.id, clubId]);

  // ── Bus Listeners (debounced + clubId-filtered) ──────────
  // Use non-blocking refresh for bus events (doesn't show full loading skeleton)
  const refreshDashboard = useCallback(
    async (cId: string | null) => {
      setIsRefreshing(true);
      try {
        await loadDashboard(cId);
      } finally {
        if (mountedRef.current) setIsRefreshing(false);
      }
    },
    [loadDashboard]
  );

  const loadMoreTransactions = useCallback(async () => {
    if (txLoadingMore || !txHasMore || !clubId) return;
    setTxLoadingMore(true);
    try {
      const uuid = resolvedClubIdRef.current || (await resolveClubUUID(clubId));
      const { data, error } = await supabase
        .from('chip_transactions')
        .select(
          'id, from_user_id, to_user_id, club_id, amount, type:transaction_type, transaction_type, notes, created_at'
        )
        .eq('club_id', uuid)
        .order('created_at', { ascending: false })
        .range(recentTx.length, recentTx.length + TX_PAGE - 1);
      if (error) throw error;
      const more = (data || []) as ChipTransaction[];
      if (!mountedRef.current) return;
      setRecentTx((prev) => [...prev, ...more]);
      setTxHasMore(more.length >= TX_PAGE);
    } catch (e) {
      reportError(e, 'AgentDashboardPage.loadMoreTransactions');
      toast.error('Could Not Load More Transactions');
    } finally {
      if (mountedRef.current) setTxLoadingMore(false);
    }
  }, [clubId, recentTx.length, txHasMore, txLoadingMore, toast]);

  const loadMoreCommissions = useCallback(async () => {
    if (commissionsLoadingMore || !commissionsHasMore || !clubId || !user?.id) return;
    setCommissionsLoadingMore(true);
    try {
      const uuid = resolvedClubIdRef.current || (await resolveClubUUID(clubId));
      const { data, error } = await supabase
        .from('v_agent_commissions')
        .select(
          'id, user_id, club_id, amount, source_type, source_id, notes, created_at, settled_at, settled_via'
        )
        .eq('club_id', uuid)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .range(commissions.length, commissions.length + COMMISSION_PAGE - 1);
      if (error) throw error;
      const more = (data || []) as AgentCommission[];
      if (!mountedRef.current) return;
      setCommissions((prev) => [...prev, ...more]);
      setCommissionsHasMore(more.length >= COMMISSION_PAGE);
    } catch (e) {
      reportError(e, 'AgentDashboardPage.loadMoreCommissions');
      toast.error('Could Not Load More Commissions');
    } finally {
      if (mountedRef.current) setCommissionsLoadingMore(false);
    }
  }, [clubId, user?.id, commissions.length, commissionsHasMore, commissionsLoadingMore, toast]);

  useEffect(() => {
    if (!clubId) return;
    const refresh = () => refreshDashboard(clubId);
    // Filtered refresh: only reload if the event is for this club (or has no clubId)
    const filteredRefresh = (event?: { payload?: { clubId?: string } }) => {
      if (!event?.payload?.clubId || event.payload.clubId === clubId) {
        refresh();
      }
    };
    const unsubs = [
      masterBus.subscribeDebounced('CASHOUT_APPROVED', filteredRefresh, 300),
      masterBus.subscribeDebounced('CASHOUT_CANCELLED', filteredRefresh, 300),
      masterBus.subscribeDebounced('CASHOUT_REQUESTED', filteredRefresh, 300),
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', filteredRefresh, 300),
      masterBus.subscribeDebounced('AGENT_UPDATED', filteredRefresh, 300),
      masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 300),
      masterBus.subscribeDebounced('CREDIT_UPDATED', filteredRefresh, 300),
    ];
    return () => unsubs.forEach((u) => u());
  }, [clubId, refreshDashboard]);

  // ── Supabase Realtime — cross-user WebSocket updates ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      const channelKey = `agent-dashboard-${clubId}`;
      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'cashout_requests',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => loadDashboard(clubId)
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'chip_transactions',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => loadDashboard(clubId)
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'AgentDashboardPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[AgentDashboardPage] Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[AgentDashboardPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(`agent-dashboard-${clubId}`);
    };
  }, [clubId, loadDashboard]);

  // ── Visibility Refresh — refresh on tab focus after 30s ──
  useVisibilityRefresh(() => loadDashboard(clubId));

  const decisions = usePreparedCashoutOperations(
    pendingCashouts.flatMap((row) => [
      {
        key: `${row.id}:approve`,
        intent: {
          userId: user?.id ?? '',
          receiptViewCurrent: isCurrent,
          playerId: row.player_id,
          clubId: row.club_id,
          targetId: row.id,
          kind: 'cashout_approve' as const,
          amount: row.amount,
        },
      },
      {
        key: `${row.id}:reject`,
        intent: {
          userId: user?.id ?? '',
          receiptViewCurrent: isCurrent,
          playerId: row.player_id,
          clubId: row.club_id,
          targetId: row.id,
          kind: 'cashout_decline' as const,
          amount: row.amount,
          note: 'Denied by agent',
        },
      },
    ]),
    cashoutRowsCurrent.current,
    pendingCashouts
  );

  const receiptChecks = useCashoutReceiptChecks(isCurrent, () => {
    void loadDashboard(clubId);
  });

  // Cashout decisions use a frozen scoped row and durable operation identity.
  const processCashout = async (cashoutId: string, action: 'approve' | 'reject') => {
    if (
      !user?.id ||
      !clubId ||
      !isCurrent() ||
      !cashoutRowsCurrent.current?.() ||
      cashoutInFlight.current
    )
      return;
    const cashout = pendingCashouts.find((row) => row.id === cashoutId && row.status === 'pending');
    if (!cashout || cashout.club_id !== resolvedClubIdRef.current) {
      setError('Refresh To Verify This Cashout Before Acting');
      return;
    }
    cashoutInFlight.current = true;
    let start: CashoutStart | null = null;
    let checkingOutcome = false;
    try {
      const prepared = decisions.get(
        `${cashout.id}:${action}`,
        action === 'approve' ? 'cashout_approve' : 'cashout_decline'
      );
      if (!prepared) throw new Error('Wait For This Cashout Request To Be Verified');
      start = captureCashoutStart(prepared);
      setProcessing(true);
      setError(null);
      checkingOutcome = true;
      const recovery = await recoverCashoutOperation(start);
      checkingOutcome = false;
      assertCashoutStartCurrent(start);
      if (!recovery.found) {
        const confirmed = await confirmDialog({
          message:
            action === 'approve'
              ? 'Approve this cashout request?'
              : 'Decline and return this cashout’s chips?',
          variant: 'danger',
        });
        if (!confirmed) return;
        assertCashoutStartCurrent(start);
        checkingOutcome = true;
        await runCashoutOperation(start);
        checkingOutcome = false;
      }
      assertCashoutStartCurrent(start);
      setSuccess(
        action === 'approve'
          ? 'Cashout approved. Invoice recorded.'
          : 'Cashout declined. Chips returned to the player.'
      );
      void loadDashboard(clubId);
    } catch (err) {
      if (checkingOutcome && start && isCurrent())
        receiptChecks.retain(
          `${cashout.id}:${action}`,
          cashout.amount,
          action === 'approve' ? 'Cashout Approval' : 'Cashout Decline',
          start
        );
      if (isCurrent() && (!start || isCashoutStartCurrent(start))) setError(safeErrorMessage(err));
    } finally {
      cashoutInFlight.current = false;
      if (isCurrent()) {
        setProcessing(false);
        if (!dashLoadingRef.current && dashReloadRef.current !== undefined) {
          const trailing = dashReloadRef.current;
          dashReloadRef.current = undefined;
          void loadDashboard(trailing);
        }
      }
    }
  };
  const approveCashout = (id: string) => processCashout(id, 'approve');
  const denyCashout = (id: string) => processCashout(id, 'reject');

  // ── Transfer ───────────────────────────────────────────────
  /**
   * WHAT THIS USED TO CALL, AND WHY NOTHING EVER MOVED.
   *
   * `WalletService.transferToUser` goes to the `wallet_user_transfer` RPC,
   * which is SECURITY INVOKER and on which `authenticated` holds no EXECUTE.
   * Every press of this button, on a modal titled "Agent-To-Agent Transfer",
   * came back a permission error. Had it been granted it would still have been
   * the wrong call: a bare PLAYER to PLAYER wallet move, with no club in it at
   * all, from a form that asks for a club member.
   *
   * fn_agent_wallet_send is the send the platform actually uses. It is
   * definer, it is granted, it enforces the downline server-side, it derives
   * the destination wallet from the recipient's role, and it takes a retry key
   * so a repeated call replays rather than sending twice. The note the form
   * has always collected and thrown away is now the send's reason.
   */
  const executeTransfer = async () => {
    if (
      !transferTarget ||
      !transferAmount ||
      !clubId ||
      !user?.id ||
      walletOperationInFlightRef.current
    )
      return;
    walletOperationInFlightRef.current = true;
    setProcessing(true);
    setError(null);
    try {
      const resolvedClub = await resolveClubUUID(clubId);
      const amt = Number(transferAmount);
      assertChipAmount(amt);
      await runAgentWalletOperation(
        {
          userId: user.id,
          clubId: resolvedClub,
          targetId: transferTarget,
          kind: 'agent_send',
          destination: 'agent_wallet',
          amount: amt,
        },
        async (operation) => {
          const { data, error: sendError } = await supabase.rpc('fn_agent_wallet_send', {
            p_club_id: resolvedClub,
            p_to_user_id: transferTarget,
            p_amount: amt,
            p_destination: 'agent_wallet',
            p_reason: transferNotes.trim() || 'Agent transfer',
            p_op_id: operation.operationId,
          });
          if (sendError) throw sendError;
          if (!confirmedAgentWalletReceipt(data, amt, 'agent_send', 'agent_wallet')) {
            throw new Error(data?.error || 'The Cashier Did Not Confirm That Transfer');
          }
        }
      );
      setSuccess(`Transferred ${fmtChips(amt)} chips.`);
      masterBus.emit('CHIPS_DISTRIBUTED', { clubId: resolvedClub, amount: amt });
      setShowTransfer(false);
      setTransferTarget('');
      setTransferAmount('');
      setTransferNotes('');
      loadDashboard(clubId);
    } catch (err: unknown) {
      setError(safeErrorMessage(err));
    } finally {
      walletOperationInFlightRef.current = false;
      setProcessing(false);
    }
  };

  // ── Derived Data ───────────────────────────────────────────
  const filteredPlayers = useMemo(() => {
    if (!playerSearch) return players;
    const q = playerSearch.toLowerCase();
    return players.filter((p) => {
      const name = (p.profile ? playerDisplayName(p.profile) : p.user_id || '').toLowerCase();
      return name.includes(q);
    });
  }, [players, playerSearch]);

  const totalPlayerChips = players.reduce((sum, p) => sum + (p.chip_balance || 0), 0);
  const onlinePlayers = players.filter((p) => {
    const lastSeen = p.profile?.last_seen;
    if (!lastSeen) return false;
    return Date.now() - new Date(lastSeen).getTime() < 300000;
  });

  // ── Loading State ──────────────────────────────────────────
  if (loading) {
    return (
      <div className="admin-page">
        <div className="admin-container">
          <div className="admin-skeleton" style={{ height: '48px', marginBottom: '16px' }} />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: '12px',
            }}
          >
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="admin-skeleton" style={{ height: '80px' }} />
            ))}
          </div>
          <div className="admin-skeleton" style={{ height: '36px', marginTop: '16px' }} />
          {[1, 2, 3].map((i) => (
            <div key={i} className="admin-skeleton" style={{ height: '60px', marginTop: '8px' }} />
          ))}
        </div>
      </div>
    );
  }

  if (!clubId) {
    return (
      <div className="admin-page">
        <EmptyState
          icon="AGENT"
          eyebrow="Agent Context Required"
          tone="permission"
          title="No Agent Workspace Is Available"
          description={
            error ||
            'Agent Balances, Downlines, Cashouts, And Commissions Belong To A Club. Open The Agent Team From An Authorized Club Workspace.'
          }
          action={{ label: 'Return To Arena', onClick: () => navigate('/') }}
          secondaryAction={{ label: 'Find Clubs', onClick: () => navigate('/search') }}
        />
      </div>
    );
  }

  const isOwnerOrAdmin = ['owner', 'co_owner', 'admin'].includes(role);
  const isOwner = role === 'owner';

  return (
    <div className="admin-page">
      <div className="admin-container">
        {/* Banners */}
        {error && <div className="admin-error-banner">{error}</div>}
        {success && <div className="admin-success-banner">{success}</div>}

        {/* Transfer Modal */}
        {showTransfer && (
          <div className="admin-modal-overlay" onClick={() => setShowTransfer(false)}>
            <div
              className="admin-card"
              style={{ maxWidth: '420px', margin: '60px auto' }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3
                className="admin-card-title"
                style={{ display: 'flex', justifyContent: 'space-between' }}
              >
                <span>Agent-To-Agent Transfer</span>
                <button
                  onClick={() => setShowTransfer(false)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: '18px',
                  }}
                >
                  ✕
                </button>
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div>
                  <label className="admin-label">Recipient Agent User ID</label>
                  <input
                    className="admin-input"
                    value={transferTarget}
                    onChange={(e) => setTransferTarget(e.target.value)}
                    placeholder="UUID Of Receiving Agent"
                  />
                </div>
                <div>
                  <label className="admin-label">Amount (Chips)</label>
                  <input
                    className="admin-input"
                    type="number"
                    value={transferAmount}
                    onChange={(e) => setTransferAmount(e.target.value)}
                    placeholder="0"
                    min="1"
                  />
                </div>
                <div>
                  <label className="admin-label">Notes (Optional)</label>
                  <input
                    className="admin-input"
                    value={transferNotes}
                    onChange={(e) => setTransferNotes(e.target.value)}
                    placeholder="Transfer Reason..."
                  />
                </div>
                <button
                  onClick={executeTransfer}
                  disabled={processing || !transferTarget || !transferAmount}
                  className="admin-btn admin-btn-primary"
                  style={{ width: '100%' }}
                >
                  {processing
                    ? 'Processing...'
                    : `Transfer ${transferAmount ? fmtChips(parseFloat(transferAmount)) : '0'} Chips`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="admin-page-header">
          <div className="admin-page-title">
            Agent Dashboard
            <span className="admin-badge" style={{ marginLeft: '12px' }}>
              {role.toUpperCase()}
            </span>
            {/* Bus-driven reloads were invisible: isRefreshing was set and
                never read, so a balance that changed under the operator
                changed with no sign the page had moved. */}
            {isRefreshing && (
              <span className="admin-badge" style={{ marginLeft: '8px' }} aria-live="polite">
                Refreshing...
              </span>
            )}
          </div>
          <div className="admin-header-actions">
            <button onClick={() => navigate('/')} className="admin-btn admin-btn-ghost">
              Lobby
            </button>
            <button onClick={() => setShowTransfer(true)} className="admin-btn admin-btn-ghost">
              Transfer
            </button>
            <button
              onClick={() => loadDashboard(clubId)}
              className="admin-btn admin-btn-ghost"
              disabled={processing}
            >
              ↻ Refresh
            </button>
            <button
              className="admin-btn admin-btn-ghost"
              onClick={() => {
                try {
                  if (tab === 'players' && players.length > 0) {
                    exportToCSV(
                      players.map((p) => ({
                        username: p.profile ? playerDisplayName(p.profile) : p.user_id,
                        role: p.role,
                        chip_balance: p.chip_balance,
                        status: p.status,
                        joined: p.created_at,
                      })),
                      'agent_players.csv',
                      [
                        { key: 'username', label: 'Player' },
                        { key: 'role', label: 'Role' },
                        { key: 'chip_balance', label: 'Balance' },
                        { key: 'status', label: 'Status' },
                        { key: 'joined', label: 'Joined' },
                      ]
                    );
                  } else if (
                    tab === 'cashouts' &&
                    cashoutsAvailable &&
                    pendingCashouts.length > 0
                  ) {
                    exportToCSV(pendingCashouts, 'agent_cashouts.csv', [
                      { key: 'player_id', label: 'Player ID' },
                      { key: 'amount', label: 'Amount' },
                      { key: 'status', label: 'Status' },
                      { key: 'created_at', label: 'Requested' },
                    ]);
                  } else if (tab === 'commissions' && commissions.length > 0) {
                    exportToCSV(commissions, 'agent_commissions.csv', [
                      { key: 'amount', label: 'Amount' },
                      // The export carries the same fact the table now shows:
                      // a claimed row and an owed row are not the same money.
                      { key: 'settled_at', label: 'Claimed At' },
                      { key: 'source_type', label: 'Source' },
                      { key: 'notes', label: 'Notes' },
                      { key: 'created_at', label: 'Date' },
                    ]);
                  } else if (tab === 'overview' && recentTx.length > 0) {
                    exportToCSV(recentTx, 'agent_transactions.csv', [
                      { key: 'transaction_type', label: 'Type' },
                      { key: 'amount', label: 'Amount' },
                      { key: 'from_user_id', label: 'From' },
                      { key: 'to_user_id', label: 'To' },
                      { key: 'created_at', label: 'Date' },
                    ]);
                  }
                } catch (e) {
                  reportError(e, 'AgentDashboardPage');
                  /* silent */
                }
              }}
            >
              Export
            </button>
          </div>
        </div>

        {/* Pending Cashouts Alert */}
        {cashoutsAvailable && pendingCashouts.length > 0 && tab !== 'cashouts' && (
          <div
            className="admin-error-banner"
            style={{
              background: 'rgba(245,166,35,0.1)',
              borderColor: 'rgba(245,166,35,0.3)',
              color: '#F5A623',
              cursor: 'pointer',
              marginBottom: '16px',
            }}
            onClick={() => setTab('cashouts')}
          >
            <strong>{pendingCashouts.length}</strong> Pending Cashout Request
            {pendingCashouts.length !== 1 ? 's' : ''} -{' '}
            {fmtChips(
              pendingCashouts.reduce((sum: number, c: CashoutRequest) => sum + (c.amount || 0), 0)
            )}{' '}
            Chips Waiting
          </div>
        )}

        {/* Tabs */}
        <div className="admin-tabs">
          {[
            { id: 'overview' as AgentTab, label: 'Overview' },
            { id: 'players' as AgentTab, label: 'Players', badge: players.length },
            {
              id: 'cashouts' as AgentTab,
              label: 'Cashouts',
              badge: cashoutsAvailable ? pendingCashouts.length || undefined : undefined,
            },
            { id: 'commissions' as AgentTab, label: 'Commissions' },
            { id: 'statement' as AgentTab, label: 'Statement' },
            { id: 'analytics' as AgentTab, label: 'Analytics' },
            { id: 'score' as AgentTab, label: 'Score' },
            ...(isOwnerOrAdmin ? [{ id: 'promo' as AgentTab, label: 'Promo' }] : []),
            ...(isOwner ? [{ id: 'credit' as AgentTab, label: 'Credit' }] : []),
          ].map((t) => (
            <button
              key={t.id}
              className={`admin-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.badge ? (
                <span
                  style={{
                    marginLeft: '6px',
                    background: 'rgba(69,153,255,0.15)',
                    padding: '2px 6px',
                    borderRadius: '8px',
                    fontSize: '11px',
                  }}
                >
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* ══════ TAB: OVERVIEW ══════ */}
        {tab === 'overview' && (
          <div className="admin-tab-content">
            <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                  {fmt(players.length)}
                </div>
                <div className="admin-stat-label">Total Players</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                  {fmt(onlinePlayers.length)}
                </div>
                <div className="admin-stat-label">Online Now</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">{fmtChips(totalPlayerChips)}</div>
                <div className="admin-stat-label">Player Chips</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                  {cashoutsAvailable ? fmt(pendingCashouts.length) : 'Unavailable'}
                </div>
                <div className="admin-stat-label">Pending Cashouts</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#FA383E' }}>
                  {cashoutsAvailable
                    ? fmtChips(
                        pendingCashouts.reduce((s: number, c: CashoutRequest) => s + c.amount, 0)
                      )
                    : 'Unavailable'}
                </div>
                <div className="admin-stat-label">Cashout Amount</div>
              </div>
            </div>

            {/* Recent Transactions */}
            <h3 className="admin-section-title">Recent Transactions</h3>
            {recentTx.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">▤</span>
                <span>No Recent Transactions</span>
              </div>
            ) : (
              <>
                <div className="admin-table-scroll">
                  <table className="admin-data-table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Amount</th>
                        <th>From / To</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentTx.map((tx, i: number) => (
                        <tr key={tx.id || i}>
                          <td>
                            <span className="admin-badge">{tx.transaction_type || 'Transfer'}</span>
                          </td>
                          <td style={{ fontWeight: 600 }}>{fmtChips(tx.amount)}</td>
                          <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {tx.from_user_id?.substring(0, 8) || '-'}.. →{' '}
                            {tx.to_user_id?.substring(0, 8) || '-'}..
                          </td>
                          <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {timeAgo(tx.created_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {txHasMore ? (
                  <button
                    onClick={() => void loadMoreTransactions()}
                    disabled={txLoadingMore}
                    className="admin-btn admin-btn-ghost"
                    style={{ width: '100%', marginTop: '12px' }}
                  >
                    {txLoadingMore ? 'Loading...' : `Load ${fmt(TX_PAGE)} More`}
                  </button>
                ) : (
                  <p className="admin-list-end">All {fmt(recentTx.length)} Transactions Loaded</p>
                )}
              </>
            )}
          </div>
        )}

        {/* ══════ TAB: PLAYERS ══════ */}
        {tab === 'players' && (
          <div className="admin-tab-content">
            <input
              className="admin-input"
              style={{ marginBottom: '16px' }}
              placeholder="Search Players By Name..."
              value={playerSearch}
              onChange={(e) => setPlayerSearch(e.target.value)}
            />
            <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                  {filteredPlayers.length}
                </div>
                <div className="admin-stat-label">
                  {playerSearch ? 'Matching' : 'Total'} Players
                </div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                  {
                    filteredPlayers.filter((p) => {
                      const ls = p.profile?.last_seen;
                      return ls && Date.now() - new Date(ls).getTime() < 300000;
                    }).length
                  }
                </div>
                <div className="admin-stat-label">Online Now</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">
                  {fmtChips(
                    filteredPlayers.reduce(
                      (sum: number, p: DownlineMember) => sum + (p.chip_balance || 0),
                      0
                    )
                  )}
                </div>
                <div className="admin-stat-label">Total Chips</div>
              </div>
            </div>

            {filteredPlayers.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">◉</span>
                <span>
                  {playerSearch
                    ? 'No Players Match Your Search'
                    : 'No Players In Your Downline Yet'}
                </span>
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: '12px',
                }}
              >
                {filteredPlayers.map((p) => {
                  const name = p.profile
                    ? playerDisplayName(p.profile)
                    : p.user_id?.substring(0, 8);
                  const isOnline =
                    p.profile?.last_seen &&
                    Date.now() - new Date(p.profile.last_seen).getTime() < 300000;
                  return (
                    <div key={p.user_id} className="admin-card" style={{ padding: '14px 16px' }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '8px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div
                            style={{
                              width: '10px',
                              height: '10px',
                              borderRadius: '50%',
                              background: isOnline ? '#31A24C' : '#6B7280',
                              boxShadow: isOnline ? '0 0 6px rgba(49,162,76,0.5)' : 'none',
                            }}
                          />
                          <span style={{ fontWeight: 600, fontSize: '14px' }}>{name}</span>
                        </div>
                        <span
                          className="admin-badge"
                          style={
                            ['agent', 'super_agent', 'sub_agent'].includes(p.role)
                              ? { background: 'rgba(168,85,247,0.15)', color: '#C084FC' }
                              : undefined
                          }
                        >
                          {p.role}
                        </span>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          gap: '12px',
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <span>
                          {' '}
                          {p.chip_balance !== undefined ? fmtChips(p.chip_balance) : '...'}
                        </span>
                        <span> {timeAgo(p.profile?.last_seen)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <CashoutReceiptChecks checks={receiptChecks} />
        {/* ══════ TAB: CASHOUTS ══════ */}
        {tab === 'cashouts' && (
          <div className="admin-tab-content">
            <h3 className="admin-section-title">
              Pending Cashout Requests
              <span className="admin-badge" style={{ marginLeft: '8px' }}>
                {cashoutsAvailable ? `${pendingCashouts.length} Pending` : 'Unavailable'}
              </span>
            </h3>

            {decisions.error && <p role="status">{decisions.error}</p>}
            {!cashoutsAvailable ? (
              <div className="admin-empty-state" role="status">
                <span>Pending Cashouts Could Not Be Verified.</span>
                <button onClick={() => void loadDashboard(clubId)}>Refresh Cashouts</button>
              </div>
            ) : pendingCashouts.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">✓</span>
                <span>No Pending Cashout Requests</span>
              </div>
            ) : (
              <div className="admin-table-scroll">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Amount</th>
                      <th>Note</th>
                      <th>Requested</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingCashouts.map((c) => (
                      <tr key={c.id}>
                        <td>{c.player_id?.substring(0, 8)}..</td>
                        <td style={{ fontWeight: 700, color: '#F7C52A' }}>{fmtChips(c.amount)}</td>
                        <td
                          style={{
                            fontSize: '12px',
                            color: 'var(--text-secondary)',
                            maxWidth: '200px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {c.player_note || '-'}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {timeAgo(c.created_at)}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              onClick={() => approveCashout(c.id)}
                              className="admin-btn admin-btn-success admin-btn-sm"
                              disabled={
                                processing || !decisions.get(`${c.id}:approve`, 'cashout_approve')
                              }
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => denyCashout(c.id)}
                              className="admin-btn admin-btn-danger admin-btn-sm"
                              disabled={
                                processing || !decisions.get(`${c.id}:reject`, 'cashout_decline')
                              }
                            >
                              Deny
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="admin-stats-grid" style={{ marginTop: '16px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                  {cashoutsAvailable ? fmt(pendingCashouts.length) : 'Unavailable'}
                </div>
                <div className="admin-stat-label">Pending</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#FA383E' }}>
                  {cashoutsAvailable
                    ? fmtChips(
                        pendingCashouts.reduce((s: number, c: CashoutRequest) => s + c.amount, 0)
                      )
                    : 'Unavailable'}
                </div>
                <div className="admin-stat-label">Total Amount</div>
              </div>
            </div>
          </div>
        )}

        {/* ══════ TAB: COMMISSIONS ══════ */}
        {tab === 'commissions' && (
          <div className="admin-tab-content">
            <h3 className="admin-section-title">Commission History</h3>
            {commissions.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">◆</span>
                <span>No Commission Records Yet</span>
              </div>
            ) : (
              <div className="admin-table-scroll">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Type</th>
                      <th>Notes</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {commissions.map((c: AgentCommission, i: number) => (
                      <tr key={c.id || i}>
                        <td style={{ fontWeight: 700, color: '#31A24C' }}>{fmtChips(c.amount)}</td>
                        {/* Claimed or not. Until phase 6 there was no way to claim
                            commission at all, so every row here meant the same
                            thing; now they do not, and a list that cannot tell
                            them apart is a list of two different numbers. */}
                        <td>
                          <span
                            className="admin-badge"
                            style={{ color: c.settled_at ? '#31A24C' : '#f59e0b' }}
                          >
                            {c.settled_at ? 'Claimed' : 'Unclaimed'}
                          </span>
                        </td>
                        <td>
                          <span className="admin-badge">{c.source_type || 'Rake'}</span>
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {c.notes || '-'}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {timeAgo(c.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {commissions.length > 0 &&
              (commissionsHasMore ? (
                <button
                  onClick={() => void loadMoreCommissions()}
                  disabled={commissionsLoadingMore}
                  className="admin-btn admin-btn-ghost"
                  style={{ width: '100%', marginTop: '12px' }}
                >
                  {commissionsLoadingMore ? 'Loading...' : `Load ${fmt(COMMISSION_PAGE)} More`}
                </button>
              ) : (
                <p className="admin-list-end">
                  All {fmt(commissions.length)} Commission Rows Loaded
                </p>
              ))}
          </div>
        )}

        {/* ══════ TAB: ANALYTICS ══════ */}
        {tab === 'analytics' && (
          <div className="admin-tab-content">
            <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                  {fmt(players.length)}
                </div>
                <div className="admin-stat-label">Total Players</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                  {fmt(onlinePlayers.length)}
                </div>
                <div className="admin-stat-label">Active (5Min)</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                  {fmt(
                    players.filter((p: DownlineMember) => {
                      const ls = p.profile?.last_seen;
                      if (!ls) return false;
                      const days = (Date.now() - new Date(ls).getTime()) / 86400000;
                      return days >= 5 && days < 14;
                    }).length
                  )}
                </div>
                <div className="admin-stat-label">At-Risk (5-14D)</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#FA383E' }}>
                  {fmt(
                    players.filter((p: DownlineMember) => {
                      const ls = p.profile?.last_seen;
                      if (!ls) return true;
                      return (Date.now() - new Date(ls).getTime()) / 86400000 >= 14;
                    }).length
                  )}
                </div>
                <div className="admin-stat-label">Churned (14D+)</div>
              </div>
            </div>

            <h3 className="admin-section-title">Player Activity</h3>
            {players.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">▦</span>
                <span>No Player Data</span>
              </div>
            ) : (
              <div className="admin-table-scroll">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Player</th>
                      <th>Chips</th>
                      <th>Last Active</th>
                      <th>Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {players.map((p: DownlineMember, i: number) => {
                      const lastSeen = p.profile?.last_seen;
                      const daysSince = lastSeen
                        ? Math.floor((Date.now() - new Date(lastSeen).getTime()) / 86400000)
                        : 999;
                      const color =
                        daysSince <= 5 ? '#31A24C' : daysSince <= 14 ? '#F7C52A' : '#FA383E';
                      return (
                        <tr key={p.user_id || i}>
                          <td>
                            <span
                              style={{
                                display: 'inline-block',
                                width: '10px',
                                height: '10px',
                                borderRadius: '50%',
                                background: color,
                                marginRight: '6px',
                              }}
                            />
                            {daysSince <= 5 ? 'Active' : daysSince <= 14 ? 'At Risk' : 'Churned'}
                          </td>
                          <td style={{ fontWeight: 600 }}>
                            {p.profile ? playerDisplayName(p.profile) : p.user_id?.substring(0, 8)}
                          </td>
                          <td>{p.chip_balance !== undefined ? fmtChips(p.chip_balance) : '...'}</td>
                          <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {timeAgo(lastSeen)}
                          </td>
                          <td style={{ fontWeight: 600, color }}>{daysSince}d</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══════ TAB: SCORE ══════ */}
        {tab === 'score' && user && (
          <div className="admin-tab-content">
            <AgentScoreCard userId={user.id} clubId={clubId || ''} />
          </div>
        )}

        {/* ══════ TAB: PROMO ══════ */}
        {tab === 'promo' && isOwnerOrAdmin && (
          <div className="admin-tab-content">
            <div className="admin-card" style={{ marginBottom: '20px', padding: '16px 20px' }}>
              <h3 className="admin-card-title">Grant Promo To Agent</h3>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <select
                  className="admin-input"
                  style={{ flex: '1 1 200px' }}
                  value={creditTarget}
                  onChange={(e) => setCreditTarget(e.target.value)}
                >
                  <option value="">Select Agent...</option>
                  {agents.map((a: DownlineMember) => (
                    <option key={a.user_id} value={a.user_id}>
                      {a.profile ? playerDisplayName(a.profile) : a.user_id?.slice(0, 8)} (
                      {a.chip_balance !== undefined ? fmtChips(a.chip_balance) : '...'} Chips)
                    </option>
                  ))}
                </select>
                <input
                  className="admin-input"
                  style={{ flex: '0 0 120px' }}
                  type="number"
                  placeholder="Amount"
                  min="1"
                  value={creditAmount}
                  onChange={(e) => setCreditAmount(e.target.value)}
                />
                <button
                  className="admin-btn admin-btn-primary"
                  disabled={processing || !creditTarget || !creditAmount}
                  onClick={async () => {
                    setProcessing(true);
                    setError(null);
                    try {
                      const promoAmt = Number(creditAmount);
                      if (isNaN(promoAmt) || promoAmt <= 0) {
                        setError('Enter a valid chip amount');
                        setProcessing(false);
                        return;
                      }
                      // Promo is disbursed by the owner of the float: the union
                      // when this club is in one, the club itself when it is not.
                      // WalletService.disbursePromo resolves that and the database
                      // refuses anyone who is not that owner.
                      const resolvedClub = await resolveClubUUID(clubId || '');
                      await WalletService.disbursePromo(
                        resolvedClub,
                        creditTarget,
                        promoAmt,
                        'Promo granted from the club dashboard'
                      );
                      setSuccess(`Granted ${fmtChips(promoAmt)} promo chips!`);
                      setCreditTarget('');
                      setCreditAmount('');
                      loadDashboard(clubId);
                    } catch (err: unknown) {
                      setError(safeErrorMessage(err));
                    } finally {
                      setProcessing(false);
                    }
                  }}
                >
                  {processing ? 'Granting...' : 'Grant Promo'}
                </button>
              </div>
            </div>

            {agents.length > 0 && (
              <>
                <h3 className="admin-section-title">Agent Breakdown</h3>
                <div className="admin-table-scroll">
                  <table className="admin-data-table">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Role</th>
                        <th style={{ textAlign: 'right' }}>Chip Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agents.map((a: DownlineMember) => (
                        <tr key={a.user_id}>
                          <td style={{ fontWeight: 600 }}>
                            {a.profile ? playerDisplayName(a.profile) : a.user_id?.substring(0, 8)}
                          </td>
                          <td>
                            <span className="admin-badge">{a.role}</span>
                          </td>
                          <td
                            style={{
                              textAlign: 'right',
                              fontWeight: 700,
                              color:
                                a.chip_balance !== undefined && a.chip_balance > 0
                                  ? '#31A24C'
                                  : 'var(--text-secondary)',
                            }}
                          >
                            {a.chip_balance !== undefined ? fmtChips(a.chip_balance) : '...'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* ══════ TAB: CREDIT ══════ */}
        {tab === 'credit' && isOwner && (
          <div className="admin-tab-content">
            <div className="admin-card" style={{ padding: '20px' }}>
              <h3 className="admin-card-title">Agent Credit Management</h3>
              <div
                className="admin-text-secondary"
                style={{ marginBottom: '16px', lineHeight: 1.5 }}
              >
                Issue Credit Lines, Add Prepaid Balances, Or Revoke Credit For Agents.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div>
                  <label className="admin-label">Agent</label>
                  <select
                    className="admin-input"
                    value={creditTarget}
                    onChange={(e) => {
                      invalidateCreditInput();
                      setCreditTarget(e.target.value);
                    }}
                  >
                    <option value="">Select Agent...</option>
                    {agents.map((a: DownlineMember) => (
                      <option key={a.user_id} value={a.user_id}>
                        {a.profile ? playerDisplayName(a.profile) : a.user_id?.slice(0, 8)} -{' '}
                        {a.role}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="admin-label">Action</label>
                  <select
                    className="admin-input"
                    value={creditAction}
                    onChange={(e) => {
                      invalidateCreditInput();
                      setCreditAction(e.target.value);
                    }}
                  >
                    <option value="issue_credit">Set Credit Line To</option>
                    <option value="add_prepaid">Send Prepaid Chips</option>
                    <option value="revoke_credit">Reduce Credit Line By</option>
                  </select>
                </div>
                <div>
                  <label className="admin-label">Amount</label>
                  <input
                    className="admin-input"
                    type="number"
                    value={creditAmount}
                    onChange={(e) => {
                      invalidateCreditInput();
                      setCreditAmount(e.target.value);
                    }}
                    placeholder="0"
                    min="1"
                  />
                </div>
                <div>
                  <label className="admin-label">Notes (Optional)</label>
                  <input
                    className="admin-input"
                    value={creditNotes}
                    onChange={(e) => {
                      invalidateCreditInput();
                      setCreditNotes(e.target.value);
                    }}
                    placeholder="Reason..."
                  />
                </div>
                {user?.id && clubId && (
                  <CreditReductionControls
                    key={`${user.id}:${clubId}`}
                    actorId={user.id}
                    clubId={clubId}
                    targetUserId={creditTarget}
                    amount={creditAmount}
                    note={creditNotes}
                    enabled={creditAction === 'revoke_credit'}
                    isCurrent={isCurrent}
                    revision={creditInputRevision}
                    getRevision={() => creditInputEpoch.current}
                  />
                )}
                {creditAction !== 'revoke_credit' && (
                  <button
                    className="admin-btn admin-btn-primary"
                    disabled={processing || !creditTarget || !creditAmount}
                    style={{ marginTop: '4px' }}
                    onClick={async () => {
                      if (!user?.id || !clubId || walletOperationInFlightRef.current) return;
                      walletOperationInFlightRef.current = true;
                      setProcessing(true);
                      setError(null);
                      try {
                        const amt = Number(creditAmount);
                        assertChipAmount(amt);
                        /*
                        ALL THREE OF THESE WERE WRONG, EACH IN ITS OWN WAY.

                        ISSUE CREDIT was the only one that could work, and it
                        passed the raw route param where a uuid was expected -
                        CreditService looks the agent up with
                        .eq('club_id', clubId), so on a slug or code URL it
                        found no row and told the operator "No agent found for
                        this club" about an agent that exists.

                        ADD PREPAID could never succeed at all. It called
                        setCreditLine(..., isPrepaid: true) with the amount as
                        the LIMIT, and fn_admin_update_agent refuses exactly
                        that pair: "a prepaid agent carries no credit line".
                        Any positive amount was rejected. Funding a prepaid
                        agent means sending them chips, which is
                        fn_agent_wallet_send into their agent wallet.

                        Credit reductions use the prepared operation controls below.
                      */
                        const resolvedCreditClub = await resolveClubUUID(clubId || '');
                        const note = creditNotes.trim() || undefined;
                        if (creditAction === 'issue_credit') {
                          await CreditService.setCreditLine(
                            creditTarget,
                            resolvedCreditClub,
                            amt,
                            false,
                            note
                          );
                        } else if (creditAction === 'add_prepaid') {
                          await runAgentWalletOperation(
                            {
                              userId: user.id,
                              clubId: resolvedCreditClub,
                              targetId: creditTarget,
                              kind: 'agent_send',
                              destination: 'agent_wallet',
                              amount: amt,
                            },
                            async (operation) => {
                              const { data, error: fundError } = await supabase.rpc(
                                'fn_agent_wallet_send',
                                {
                                  p_club_id: resolvedCreditClub,
                                  p_to_user_id: creditTarget,
                                  p_amount: amt,
                                  p_destination: 'agent_wallet',
                                  p_reason: note || 'Prepaid funding',
                                  p_op_id: operation.operationId,
                                }
                              );
                              if (fundError) throw fundError;
                              if (
                                !confirmedAgentWalletReceipt(
                                  data,
                                  amt,
                                  'agent_send',
                                  'agent_wallet'
                                )
                              ) {
                                throw new Error(
                                  data?.error || 'The Cashier Did Not Confirm That Funding'
                                );
                              }
                            }
                          );
                        }
                        const labels: Record<string, string> = {
                          issue_credit: 'Credit line set to',
                          add_prepaid: 'Prepaid balance sent',
                        };
                        setSuccess(`${labels[creditAction] || 'Done'} - ${fmtChips(amt)} chips`);
                        masterBus.emit('CREDIT_UPDATED', {
                          clubId: clubId || '',
                          userId: creditTarget,
                        });
                        setCreditAmount('');
                        setCreditNotes('');
                        loadDashboard(clubId);
                      } catch (err: unknown) {
                        setError(safeErrorMessage(err));
                      } finally {
                        walletOperationInFlightRef.current = false;
                        setProcessing(false);
                      }
                    }}
                  >
                    {processing
                      ? 'Processing...'
                      : creditAction === 'issue_credit'
                        ? 'Set Credit Line'
                        : creditAction === 'add_prepaid'
                          ? 'Send Prepaid Chips'
                          : 'Reduce Credit Line'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {tab === 'statement' && (
        <div style={{ padding: '0 16px 16px', maxWidth: '1100px', margin: '0 auto' }}>
          <div
            style={{
              background: 'rgba(255,255,255,0.03)',
              borderRadius: '12px',
              padding: '16px',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <AgentBackOffice
              key={`${user?.id}:${clubId}`}
              clubId={clubId ?? undefined}
              title="Weekly Statement & Roster"
            />
          </div>
        </div>
      )}

      {/* TRANSACTION HISTORY — chip_ledger entries for this agent */}
      <div style={{ padding: '0 16px 16px', maxWidth: '800px', margin: '0 auto' }}>
        <div
          style={{
            background: 'rgba(255,255,255,0.03)',
            borderRadius: '12px',
            padding: '16px',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 700, color: '#e0e0e0' }}>
            Transaction History
          </h3>
          <TransactionLedgerView
            userId={user?.id || undefined}
            clubId={clubId || undefined}
            limit={20}
          />
        </div>
      </div>
    </div>
  );
}

/** The reduction form owns its accepted intent; reload cards have receipt-only authority. */
export function CreditReductionControls(props: {
  actorId: string;
  clubId: string;
  targetUserId: string;
  amount: string;
  note: string;
  enabled: boolean;
  isCurrent: () => boolean;
  revision: number;
  getRevision: () => number;
}) {
  const { actorId, clubId } = props;
  const scope = useCashoutScope(actorId, clubId);
  const live = useRef(true);
  const token = useRef<object | null>(null);
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [prepared, setPrepared] = useState<{
    token: object;
    value: PreparedCreditReduction;
  } | null>(null);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [pendingRows, setPendingRows] = useState<{
    scope: () => boolean;
    rows: PendingCreditReduction[];
  } | null>(null);
  const [receipt, setReceipt] = useState<{
    scope: () => boolean;
    value: Readonly<CreditReductionEnvelope>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const inputKey = JSON.stringify([
    actorId,
    clubId,
    props.targetUserId,
    props.amount,
    props.note,
    props.enabled,
    props.revision,
    refresh,
  ]);
  const input = useRef<{ key: string; token: object } | null>(null);
  if (!input.current || input.current.key !== inputKey)
    input.current = { key: inputKey, token: {} };
  token.current = input.current.token;
  const formToken = input.current.token;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      token.current = null;
    };
  }, []);
  const receiptCurrent = useCallback(
    () => live.current && scope() && props.isCurrent(),
    [scope, props.isCurrent]
  );
  useEffect(() => {
    let active = true;
    setPendingRows(null);
    void listPendingCreditReductions(actorId, clubId, receiptCurrent)
      .then((rows) => {
        if (active && receiptCurrent()) setPendingRows({ scope: receiptCurrent, rows });
      })
      .catch(() => {
        if (active && receiptCurrent())
          setError(
            'Pending Credit Changes Are Unavailable. Keep This Browser Data And Check Again.'
          );
      });
    return () => {
      active = false;
    };
  }, [actorId, clubId, receiptCurrent, refresh]);
  useEffect(() => {
    setPrepared(null);
    setPreparationError(null);
    if (!props.enabled || !props.targetUserId || !props.amount) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () =>
      active &&
      receiptCurrent() &&
      token.current === formToken &&
      props.getRevision() === props.revision;
    try {
      const amount = creditReductionAmount(props.amount);
      const reason = props.note.trim() || null;
      // Invalidation above is immediate. Delay only idle snapshot/hash/storage
      // preparation so ordinary typing does not lock the server row per key.
      timer = setTimeout(() => {
        if (!current()) return;
        void prepareCreditReduction({
          actorId,
          clubId,
          targetUserId: props.targetUserId,
          amount,
          reason,
          isCurrent: current,
          receiptViewCurrent: receiptCurrent,
        })
          .then((value) => {
            if (current()) setPrepared({ token: formToken, value });
          })
          .catch((err) => {
            if (current()) setPreparationError(safeErrorMessage(err));
          });
      }, 300);
    } catch (err) {
      if (current()) setPreparationError(safeErrorMessage(err));
    }
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [formToken, receiptCurrent, actorId, clubId]);
  const canStart =
    props.enabled &&
    !working &&
    prepared?.token === formToken &&
    receiptCurrent() &&
    props.getRevision() === props.revision;
  const showResult = (value: Readonly<CreditReductionEnvelope>) => {
    if (!receiptCurrent()) return;
    setReceipt({ scope: receiptCurrent, value });
    setRefresh((value) => value + 1);
  };
  const rows = pendingRows?.scope() ? pendingRows.rows : [];
  const result = receipt?.scope() ? receipt.value : null;
  return (
    <div aria-label="Credit Reduction Recovery">
      {props.enabled && (
        <>
          {preparationError && <p role="alert">{preparationError}</p>}
          <button
            className="admin-btn admin-btn-primary"
            disabled={!canStart}
            onClick={async () => {
              if (!canStart || !prepared || busy.current) return;
              busy.current = true;
              setWorking(true);
              setError(null);
              try {
                // Capture before any wait. A capture refusal is shown without dispatching.
                const start = captureCreditReduction(prepared.value);
                const value = await CreditService.lowerCreditLine(start);
                assertCreditReductionCurrent(start);
                showResult(value);
              } catch (err) {
                if (receiptCurrent()) {
                  setError(safeErrorMessage(err));
                  setRefresh((value) => value + 1);
                }
              } finally {
                busy.current = false;
                if (receiptCurrent()) setWorking(false);
              }
            }}
          >
            {working ? 'Checking Credit Change...' : 'Reduce Credit Line'}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {rows.length > 0 && (
        <div aria-label="Pending Credit Changes">
          <p>
            A Pending Credit Change Must Be Checked Or Cancelled Before Another Change For That
            Agent.
          </p>
          {rows.map((row, index) => (
            <div key={row.operationId}>
              <span>Pending Credit Change {index + 1}</span>
              {(['check', 'cancel'] as const).map((action) => (
                <button
                  key={action}
                  disabled={working}
                  onClick={async () => {
                    if (busy.current || !receiptCurrent()) return;
                    busy.current = true;
                    setWorking(true);
                    setError(null);
                    try {
                      const start = capturePendingCreditReduction(row);
                      const value =
                        action === 'check'
                          ? await recoverCreditReduction(start)
                          : await retireCreditReduction(start);
                      assertCreditReductionCurrent(start);
                      showResult(value);
                    } catch (err) {
                      if (receiptCurrent()) setError(safeErrorMessage(err));
                    } finally {
                      busy.current = false;
                      if (receiptCurrent()) setWorking(false);
                    }
                  }}
                >
                  {action === 'check' ? 'Check Receipt' : 'Cancel Pending Change'}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {result?.state === 'recorded' && (
        <div role="status">
          <p>
            {result.receipt.outcome === 'no_change'
              ? 'No Credit Capacity Changed.'
              : `Credit Line Reduced By ${result.receipt.applied_reduction} Chips.`}
          </p>
          <p>Limit After This Change: {result.receipt.after_limit} Chips.</p>
          <p>This Is The Recorded Result Of That Change. No Chips Moved And No Payment Is Due.</p>
        </div>
      )}
      {result?.state === 'retired' && (
        <p role="status">Pending Change Cancelled. Its Original Request Cannot Apply.</p>
      )}
      {result?.state === 'absent' && (
        <p role="status">No Recorded Result Yet. This Change Remains Pending.</p>
      )}
    </div>
  );
}

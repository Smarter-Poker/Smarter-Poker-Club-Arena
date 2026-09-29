/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNION DASHBOARD PAGE — Union Operations Center
 *  Ported from World Hub union-dashboard.js → Club Arena TypeScript
 *
 *  8 Tabs: Overview, Clubs, Agents, Wallet, Treasury, Analytics, Applications, Settings
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useUnionRouteId } from '../hooks/useUnionRouteId';
import { supabase } from '../lib/supabase';
import { unionApi } from '../services/UnionApiService';
import { masterBus } from '../core/MasterBus';
import { watchBbjPool } from '../lib/bbjPoolFeed';
import { setBbjUnionMiniEnabled, setBbjUnionMiniFloor } from '../lib/bbjMiniFeed';
import { useAuthUser } from '../hooks/useAuthUser';
import { useCashoutScope } from '../hooks/useCashoutScope';
import { formatWeeklyChips } from '../services/ClubWeeklyAccountingReader';
import './AdminDashboardPage.css';
import { confirmDialog } from '../components/common/confirmDialog';
import { useIsMounted } from '../hooks/useIsMounted';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { fmt, timeAgo } from '../utils/format';
import UnionWalletModal, { type UnionWalletKey } from '../components/union/UnionWalletModal';
import UnionTreasuryDetailModal, {
  type TreasuryDetailMode,
} from '../components/union/UnionTreasuryDetailModal';
import SpinActivationPanel from '../components/club/SpinActivationPanel';
import { useSpinsWallet } from '../hooks/useSpinsWallet';
import TransactionLedgerView from '../components/common/TransactionLedgerView';
import { getUnionLevel } from '../utils/clubLevels';
import { reportError } from '../utils/errorReporter';
import UnionOpsPanel from '../components/union/UnionOpsPanel';
import UnionClubGovernance from '../components/union/UnionClubGovernance';

import { safeErrorMessage } from '../utils/safeErrorMessage';
import { EmptyState, ErrorState } from '../components/common/EmptyState';
import CasinoSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { downloadCsv } from '../utils/downloadCsv';
// ── Helpers ─────────────────────────────────────────────────
const pct = (n: number | null | undefined) => `${((Number(n) || 0) * 100).toFixed(1)}%`;

type UnionTab =
  | 'overview'
  | 'clubs'
  | 'players'
  | 'agents'
  | 'wallet'
  | 'treasury'
  | 'analytics'
  | 'applications'
  | 'operations'
  | 'settings';

const UNION_TABS = new Set<UnionTab>([
  'overview',
  'clubs',
  'players',
  'agents',
  'wallet',
  'treasury',
  'analytics',
  'applications',
  'operations',
  'settings',
]);

function requestedUnionTab(value: string | null): UnionTab {
  return value && UNION_TABS.has(value as UnionTab) ? (value as UnionTab) : 'overview';
}

const UNION_DASHBOARD_ROW_SELECT =
  'id, name, description, owner_id, created_at, member_count, settings, level, player_level, hierarchy_level, total_players, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next';

// ── Union Dashboard Types ────────────────────────────────────
interface UnionRow {
  id: string;
  name: string;
  description?: string;
  owner_id: string;
  created_at: string;
  logo_url?: string;
  member_count?: number;
  status?: string;
  code?: string;
  settings?: Record<string, number | string | boolean>;
}
interface UnionClubRow {
  id: string;
  club_id: string;
  clubs: Record<string, unknown>;
  club_commission_rate?: number;
  [key: string]: unknown;
}
interface EnrichedClub {
  id: string;
  name?: string;
  club_id?: string;
  member_count?: number;
  active_tables?: number;
  total_rake?: number;
  chip_treasury?: number;
  club_commission_rate: number;
  [key: string]: unknown;
}
interface UnionAgent {
  id?: string;
  user_id: string;
  club_id: string;
  role: string;
  status: string;
  commission_rate?: number;
  profiles?: { display_name?: string; username?: string; avatar_url?: string };
}
interface UnionAdmin {
  user_id: string;
  union_id: string;
  role: string;
  created_at: string;
  profile?: { display_name?: string; username?: string; avatar_url?: string };
}
interface UnionWallet {
  id: string;
  union_id: string;
  chip_balance: number;
  rake_wallet: number;
  bbj_wallet: number;
  promo_wallet: number;
  insurance_wallet: number;
  spin_reserve_wallet: number;
  total_rake_collected: number;
  total_settlements: number;
  created_at: string;
}
interface UnionApp {
  id: string;
  union_id: string;
  club_name: string;
  club_id?: string;
  applicant_id: string;
  status: string;
  notes?: string;
  created_at: string;
  applied_at?: string;
}
interface SettlementPeriod {
  id: string;
  period_number: number;
  year: number;
  start_at: string;
  end_at?: string;
  status: string;
  total_rake_collected?: number;
  total_hands_dealt?: number;
  settled_at?: string;
  created_at: string;
  club_id?: string;
}

/**
 * WHY THE MINI REFUSED, IN WORDS AN OPERATOR CAN ACT ON.
 *
 * The two union mini RPCs return a `reason` rather than throwing, and a reason
 * nobody translates is a reason nobody reads: `floor_below_one_payout` on a
 * screen is not an instruction. Every value either function can return has a
 * sentence here - the default is the LAST resort, not the usual path, because
 * a generic "could not be saved" is how an operator learns to stop trying.
 */
function miniRefusalText(reason: string, minimum?: number): string {
  switch (reason) {
    case 'not_a_union_operator':
      return 'Only A Union Owner Or Appointed Administrator Can Change This.';
    case 'not_signed_in':
      return 'You Are Signed Out. Sign In Again To Change This.';
    case 'union_not_found':
      return 'That Union No Longer Exists.';
    case 'pool_not_found':
      return 'This Union Has No Active Jackpot Pool Yet.';
    case 'union_and_enabled_required':
    case 'union_and_floor_required':
      return 'That Request Was Incomplete. Nothing Changed.';
    case 'floor_cannot_be_negative':
      return 'A Reserve Floor Cannot Be Negative.';
    case 'floor_below_one_payout':
      return minimum === undefined
        ? 'The Floor Must Cover At Least One Mini Payout At The Largest Stakes.'
        : `The Floor Must Be At Least ${fmt(minimum)}, Which Covers One Mini Payout At The Largest Stakes.`;
    case 'request_failed':
      return 'That Could Not Reach The Server. Nothing Changed.';
    default:
      return 'The Mini Jackpot Setting Could Not Be Saved. Nothing Changed.';
  }
}

export default function UnionDashboardPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { unionId: routeUnionId, unionRef } = useUnionRouteId();
  const { user } = useAuthUser();

  const [tab, setTabState] = useState<UnionTab>(() => requestedUnionTab(searchParams.get('tab')));
  const setTab = useCallback(
    (next: UnionTab) => {
      setTabState(next);
      setSearchParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next === 'overview') updated.delete('tab');
          else updated.set('tab', next);
          return updated;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  useEffect(() => {
    setTabState(requestedUnionTab(searchParams.get('tab')));
  }, [searchParams]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  // Union data
  const [unionId, setUnionId] = useState<string | null>(routeUnionId || null);
  const [union, setUnion] = useState<UnionRow | null>(null);
  const [adminRole, setAdminRole] = useState<string | null>(null);
  const [authorizedScope, setAuthorizedScope] = useState<{
    userId: string;
    unionId: string;
  } | null>(null);
  /**
   * Dan 2026-08-22: clicking any union wallet opens it with a send-to-member
   * flow. Before this, the four wallet tiles were static divs.
   */
  const [walletModal, setWalletModal] = useState<{
    key: UnionWalletKey;
    label: string;
    balance: number;
  } | null>(null);
  /**
   * Dan 2026-08-24: "rake treasury should open up to see all the data for all
   * rake accumulated" and "back up BBJ needs to be clickable as well and expand
   * to see data and transaction history and stats".
   *
   * Separate state from walletModal because they answer different questions.
   * walletModal asks "who do I pay from this wallet"; this asks "where did this
   * money come from and what has moved". The detail panel carries a Send From
   * This Wallet button that hands off to walletModal, so nothing that used to
   * be one click away is now two.
   */
  const [treasuryModal, setTreasuryModal] = useState<TreasuryDetailMode | null>(null);
  const [roster, setRoster] = useState<
    {
      user_id: string;
      username: string | null;
      display_name: string | null;
      club_name: string | null;
      member_role: string | null;
      member_status: string | null;
      currently_seated: boolean;
    }[]
  >([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterSearch, setRosterSearch] = useState('');
  const [clubs, setClubs] = useState<EnrichedClub[]>([]);

  /* THE JACKPOT TILE FOLLOWS THE SHARED POLL (BBJ phase 3.2, 2026-09-06).
     `fn_bbj_pool_for_club` is union-aware server-side, so ANY club in this
     union resolves to the union's own pool - which is why this can key off the
     first club rather than re-implementing the union rule here for a fifth
     time. Only `main_balance` moves on its own; every other column on the row
     changes on an operator action, and loadDashboard already carries those. */
  const anyUnionClubId = clubs[0]?.id as string | undefined;
  useEffect(() => {
    if (!anyUnionClubId) return;
    return watchBbjPool(anyUnionClubId, (snap) => {
      if (!mountedRef.current) return;
      setBbjPool((prev) => (prev ? { ...prev, main_balance: snap.mainBalance } : prev));
    });
  }, [anyUnionClubId]);
  const [agents, setAgents] = useState<UnionAgent[]>([]);
  const [admins, setAdmins] = useState<UnionAdmin[]>([]);
  const [wallets, setWallets] = useState<UnionWallet | null>(null);
  const [bbjPool, setBbjPool] = useState<{
    id: string;
    main_balance: number;
    backup_balance: number;
    promo_balance: number;
    total_contributed: number;
    total_paid_out: number;
    hit_count: number;
    last_hit_at: string | null;
    last_hit_amount: number;
    /* The mini's two controls. They live on the pool row, and until 2026-09-11
       there was no way for a UNION to reach either of them: both setters were
       keyed on a club and both refuse a club inside a union. */
    mini_enabled: boolean;
    mini_reserve_floor: number;
  } | null>(null);
  const [bbjFundAmount, setBbjFundAmount] = useState('');
  /** The floor an operator is typing. Null means "showing the stored value". */
  const [miniFloorDraft, setMiniFloorDraft] = useState<string | null>(null);
  const [spinReserveForm, setSpinReserveForm] = useState({ amount: '', from: 'promo_wallet' });
  const [recentPeriods, setRecentPeriods] = useState<SettlementPeriod[]>([]);
  /** Weekly union<->club player win/loss settlements (union_pnl_settlements). */
  const [pnlSettlements, setPnlSettlements] = useState<
    {
      id: string;
      period_start: string;
      period_end: string;
      status: string;
      total_collected: number;
      total_paid: number;
      total_unpaid: number;
      club_results: any;
      settled_at: string;
      [key: string]: any;
    }[]
  >([]);
  const [rakebackHistory, setRakebackHistory] = useState<
    {
      id: string;
      period_start: string;
      period_end: string;
      total_rakeback: string;
      executed_at: string;
    }[]
  >([]);

  // Applications
  const [apps, setApps] = useState<UnionApp[]>([]);
  const [appsFilter, setAppsFilter] = useState('pending');
  const [appsLoaded, setAppsLoaded] = useState(false);

  // Leave requests (IMPROVE 2026-07-21)
  const [leaveReqs, setLeaveReqs] = useState<
    Array<{ id: string; club_name?: string; reason?: string | null; requested_at: string }>
  >([]);

  // Activity

  // Wallet transfer form (Send Chips to Club)
  const [transferForm, setTransferForm] = useState({ clubId: '', amount: '', notes: '' });

  // Wallet deposit form (controlled — no getElementById)
  const [depositForm, setDepositForm] = useState({ amount: '', notes: '' });

  // Clawback form (controlled — no getElementById)
  const [clawbackForm, setClawbackForm] = useState({ target: '', amount: '', reason: '' });

  // Search / Filter
  const [clubSearch, setClubSearch] = useState('');
  const [agentSearch, setAgentSearch] = useState('');

  // Settings form
  const [settingsForm, setSettingsForm] = useState<Record<string, string>>({});

  // Commission edit modal
  const [editCommClub, setEditCommClub] = useState<EnrichedClub | null>(null);
  const [editCommRate, setEditCommRate] = useState('');

  // Announcement
  const [annMsg, setAnnMsg] = useState('');
  const [annClub, setAnnClub] = useState('');

  // Admin search
  const [adminSearch, setAdminSearch] = useState('');
  const [adminResults, setAdminResults] = useState<
    { id: string; display_name?: string; username?: string }[]
  >([]);

  const mountedRef = useIsMounted();

  // Auto-clear success
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [success]);

  // Auto-clear errors after 6s
  useEffect(() => {
    // A fatal load/permission error is the page's gate, not a transient banner.
    // Clearing it while `union` is still null would fall through to an empty
    // operations surface after six seconds.
    if (!error || !union) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error, union]);

  // ── Cache Invalidation on Union Change ─────────────────────
  useEffect(() => {
    setAppsLoaded(false);
    setApps([]);
  }, [unionId]);

  // ── Invalidate Apps Cache on Filter Change ─────────────────
  useEffect(() => {
    setAppsLoaded(false);
  }, [appsFilter]);

  // Route changes are allowed to supersede an in-flight union load. A boolean
  // lock dropped the new request entirely, then let the old union paint under
  // the new URL. A monotonically increasing request version makes every state
  // write and loading/error finalizer belong to one route intent.
  const dashLoadVersion = useRef(0);

  // The contextual route is authoritative. A user who moves between two union
  // workspaces in the same session must never keep the first union's cached ID.
  useEffect(() => {
    ++dashLoadVersion.current;
    setUnionId(routeUnionId || null);
    setAuthorizedScope(null);
    setUnion(null);
    setAdminRole(null);
    setError(null);
    setSuccess(null);
    setLoading(Boolean(user?.id && unionRef));
    setClubs([]);
    setAgents([]);
    setAdmins([]);
    setWallets(null);
    setBbjPool(null);
    setRecentPeriods([]);
    setPnlSettlements([]);
    setRoster([]);
    setApps([]);
    setAppsLoaded(false);
    setLeaveReqs([]);
    setRakebackHistory([]);
    setWalletModal(null);
    setTreasuryModal(null);
  }, [routeUnionId, unionRef, user?.id]);

  // ── Load Dashboard ─────────────────────────────────────────
  const loadDashboard = useCallback(
    async (uid?: string | null) => {
      const requestVersion = ++dashLoadVersion.current;
      const isCurrent = () => mountedRef.current && dashLoadVersion.current === requestVersion;
      try {
        if (isCurrent()) {
          setLoading(true);
          setError(null);
        }
        const id = uid;

        if (!id || !user?.id) return;

        // Authorize the ROUTED union before loading any operational data.
        // The old routed branch skipped this entirely: owners lost their lead
        // controls and any signed-in user could read a union's operations page.
        const [unionResult, operatorResult] = await Promise.all([
          supabase.from('unions').select(UNION_DASHBOARD_ROW_SELECT).eq('id', id).maybeSingle(),
          // This SECURITY DEFINER predicate is the canonical owner/admin check.
          // Reading union_admins directly is not equivalent: its RLS policy is
          // scoped to club members, while an appointed union admin does not
          // have to hold a club membership row.
          supabase.rpc('fn_is_union_operator', {
            p_union_id: id,
            p_user_id: user.id,
          }),
        ]);
        if (unionResult.error) throw unionResult.error;
        if (operatorResult.error) throw operatorResult.error;
        if (!unionResult.data) throw new Error('Union Not Found');

        const authorizedRole = unionResult.data.owner_id === user.id ? 'union_lead' : 'union_admin';
        if (operatorResult.data !== true) {
          if (isCurrent()) {
            setAuthorizedScope(null);
            setUnion(null);
            setAdminRole(null);
            setError('You are not a union admin or owner.');
          }
          return;
        }
        if (isCurrent()) {
          setUnionId(id);
          setAdminRole(authorizedRole);
          setAuthorizedScope({ userId: user.id, unionId: id });
        }
        await loadUnionData(id, requestVersion, unionResult.data as UnionRow, authorizedRole);
      } catch (err: any) {
        if (isCurrent()) {
          setAuthorizedScope(null);
          setUnion(null);
          setAdminRole(null);
          setError(safeErrorMessage(err));
        }
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [user?.id]
  );

  const loadUnionData = async (
    uid: string,
    requestVersion: number,
    authorizedUnionRow: UnionRow,
    authorizedRole: 'union_lead' | 'union_admin'
  ) => {
    const isCurrent = () => mountedRef.current && dashLoadVersion.current === requestVersion;
    // The authority read supplied this same row. Reusing it avoids a duplicate
    // network round trip and guarantees no protected state paints first.
    const unionRow = authorizedUnionRow;
    if (isCurrent()) {
      setUnion(unionRow);
      setAdminRole(authorizedRole);
    }

    // Load clubs in union
    const { data: unionClubs, error: unionClubsError } = await supabase
      .from('union_clubs')
      .select('*, clubs:club_id(*)')
      .eq('union_id', uid);
    if (unionClubsError) throw unionClubsError;
    const enrichedClubs = (unionClubs || []).map((uc: UnionClubRow) => ({
      id: uc.club_id,
      ...uc.clubs,
      // UNION AUDIT FIX 2026-07-21: live column is club_commission_rate
      // (commission_rate never existed on union_clubs — reads were undefined).
      club_commission_rate: uc.club_commission_rate || 0.9,
    }));
    if (isCurrent()) setClubs(enrichedClubs);

    // Load agents across clubs
    let loadedAgents: UnionAgent[] = [];
    const clubIds = enrichedClubs.map((c) => c.id).filter(Boolean);
    if (clubIds.length > 0) {
      /* Named columns, not `*`. club_members is moving to column-level grants
         (is_bot mirrors profiles.is_horse and must not reach a player), and
         PostgREST expands `*` to every column, withheld ones included - which
         fails the whole read with 42501. This page uses exactly these. */
      const { data: agentRows } = await supabase
        .from('club_members')
        .select('user_id, club_id, role, status, commission_rate')
        .in('club_id', clubIds)
        .in('role', ['agent', 'sub_agent', 'super_agent']);

      // Batch-fetch profiles (no FK between club_members and profiles)
      if (agentRows && agentRows.length > 0) {
        const agentUserIds = [...new Set(agentRows.map((a: any) => a.user_id))];
        const { data: agentProfiles } = await supabase
          .from('profiles')
          .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
          .in('id', agentUserIds);
        const agentProfileMap: Record<string, any> = {};
        if (agentProfiles) {
          for (const p of agentProfiles) agentProfileMap[p.id] = p;
        }
        // Attach profiles to agent rows
        for (const agent of agentRows) {
          (agent as any).profiles = agentProfileMap[agent.user_id] || null;
        }
      }

      loadedAgents = agentRows || [];
      if (isCurrent()) setAgents(loadedAgents);
    }

    // Load admins
    const { data: adminRows } = await supabase
      .from('union_admins')
      .select(`*, profile:user_id(${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url)`)
      .eq('union_id', uid);
    if (isCurrent()) setAdmins(adminRows || []);

    // Load wallets
    const { data: walletRow, error: walletError } = await supabase
      .from('union_wallets')
      // union_wallets schema: chip_balance, rake_wallet, bbj_wallet, promo_wallet,
      // insurance_wallet, spin_reserve_wallet, total_rake_collected, total_settlements.
      // spin_reserve_wallet holds the capital that seeds every Spin bonus pool this
      // union owns. It existed unread since 2026-08-22 - the pools were being seeded
      // out of promo_wallet because nothing surfaced the wallet meant to fund them.
      .select(
        'id, union_id, chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet, spin_reserve_wallet, total_rake_collected, total_settlements, created_at'
      )
      .eq('union_id', uid)
      .maybeSingle();
    if (walletError) throw walletError;
    if (isCurrent()) setWallets(walletRow);

    // BBJ UNIFICATION 2026-07-21: the shared jackpot lives in the union's
    // bbj_pools row (engine-fed contributions + manual funding + payouts) —
    // NOT in union_wallets.bbj_wallet. Load it for the BBJ tiles.
    const { data: poolRow } = await supabase
      .from('bbj_pools')
      .select(
        'id, main_balance, backup_balance, promo_balance, total_contributed, total_paid_out, hit_count, last_hit_at, last_hit_amount, mini_enabled, mini_reserve_floor'
      )
      .eq('union_id', uid)
      .eq('status', 'active')
      .maybeSingle();
    if (isCurrent()) setBbjPool(poolRow);

    // 2026-08-19: the comment here claimed "settlement_periods is a global
    // table (no club_id column)". That is wrong — it has club_id, and both
    // union_id and club_id are used by the settlement pipeline. The result was
    // an unscoped list (every club RLS allowed, from any union) whose Club
    // column always rendered "Unknown" because club_id was never selected.
    const unionClubIds = clubIds;
    let periodQuery = supabase
      .from('settlement_periods')
      .select(
        'id, club_id, union_id, period_number, year, start_at, end_at, status, total_rake_collected, total_player_winnings, total_player_losses, total_hands_dealt, settled_at, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(30);
    periodQuery = unionClubIds.length
      ? periodQuery.in('club_id', unionClubIds)
      : periodQuery.eq('union_id', uid);
    const { data: periods } = await periodQuery;
    if (isCurrent()) setRecentPeriods(periods || []);

    // ── Weekly union<->club player P&L settlements (added 2026-08-19) ──
    // Until now the weekly square-up had NO readable surface anywhere in the
    // app: a union admin could not see what was collected, what was paid, or
    // why a period was parked for review. A money process nobody can inspect
    // is a money process nobody trusts.
    const { data: pnlRows } = await supabase
      .from('union_pnl_settlements')
      .select(
        'id, period_start, period_end, status, total_collected, total_paid, total_unpaid, club_results, settled_at'
      )
      .eq('union_id', uid)
      .order('period_start', { ascending: false })
      .limit(12);
    if (isCurrent()) setPnlSettlements(pnlRows || []);
  };

  // ── Initial Load ───────────────────────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    // A slug has a route identity before it has a database UUID. Never fall
    // back to discovering an arbitrary union while that route is resolving.
    if (unionRef && !routeUnionId) {
      setLoading(true);
      return;
    }
    void loadDashboard(routeUnionId);
  }, [user?.id, loadDashboard, routeUnionId, unionRef]);

  const authorizedUnionId =
    user?.id &&
    unionId &&
    routeUnionId === unionId &&
    authorizedScope?.userId === user.id &&
    authorizedScope.unionId === unionId
      ? unionId
      : null;

  // ── Load Applications ──────────────────────────────────────
  const loadApps = useCallback(async () => {
    if (!authorizedUnionId) return;
    try {
      // UNION AUDIT FIX 2026-07-21: the direct select used columns that do not
      // exist (applicant_id/notes/created_at vs live applicant_user_id/message/
      // applied_at) AND union_applications RLS only lets the APPLICANT read —
      // union leads always saw an empty tab. The union-application API lists
      // with the service role after a union-lead auth check.
      const result = await unionApi.listApplications(authorizedUnionId, appsFilter);
      const rows = ((result.applications as any[]) || []).map((a) => ({
        id: a.id,
        union_id: a.union_id,
        club_name: a.club_name,
        club_id: a.club_id,
        applicant_id: a.applicant_user_id,
        status: a.status,
        notes: a.message ?? a.review_note ?? null,
        created_at: a.applied_at,
      }));
      if (mountedRef.current) {
        setApps(rows);
        setAppsLoaded(true);
      }
    } catch (_e) {
      /* silent */
    }
  }, [authorizedUnionId, appsFilter]);

  // ── Load leave requests (IMPROVE 2026-07-21) ───────────────
  const loadLeaveReqs = useCallback(async () => {
    if (!authorizedUnionId) return;
    try {
      const result = await unionApi.listLeaveRequests(authorizedUnionId);
      if (mountedRef.current) {
        setLeaveReqs((result.leaveRequests as any[]) || []);
      }
    } catch (_e) {
      /* silent — non-leads may not have access */
    }
  }, [authorizedUnionId]);

  // ── Tab-based lazy loading ─────────────────────────────────
  useEffect(() => {
    if (!authorizedUnionId) return;
    if (tab === 'applications' && !appsLoaded) {
      loadApps();
      loadLeaveReqs();
    }
  }, [tab, authorizedUnionId, appsLoaded, loadApps, loadLeaveReqs]);

  // ── Retained union rakeback history ──────────────────────────
  const rakebackScope = useCashoutScope(user?.id, JSON.stringify([unionRef, authorizedUnionId]));
  const rakebackRead = useRef(0);
  const rakebackOwner = useRef<(() => boolean) | null>(null);
  const [rakebackReadError, setRakebackReadError] = useState(false);
  const [rakebackLoading, setRakebackLoading] = useState(false);
  const rakebackVisible = rakebackScope() && rakebackOwner.current === rakebackScope;
  const loadRakebackHistory = useCallback(async () => {
    const read = ++rakebackRead.current;
    const current = () => rakebackScope() && read === rakebackRead.current;
    if (!authorizedUnionId || !current()) return;
    rakebackOwner.current = rakebackScope;
    setRakebackHistory([]);
    setRakebackReadError(false);
    setRakebackLoading(true);
    try {
      const { data, error } = await supabase
        .from('union_rakeback_log')
        .select('id, union_id, period_start, period_end, total_rakeback::text, executed_at')
        .eq('union_id', authorizedUnionId)
        .order('executed_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(12);
      if (!current()) return;
      if (error || !Array.isArray(data) || data.length > 12)
        throw new Error('Rakeback History Is Unavailable');
      const ids = new Set<string>();
      const rows = data.map((row) => {
        const amount =
          typeof row.total_rakeback === 'string' && row.total_rakeback.length <= 128
            ? /^(0|[1-9]\d{0,29})(?:\.(\d+))?$/.exec(row.total_rakeback)
            : null;
        if (
          !amount ||
          /[1-9]/.test((amount[2] ?? '').slice(2)) ||
          row.union_id !== authorizedUnionId ||
          typeof row.id !== 'string' ||
          !row.id ||
          ids.has(row.id) ||
          ![row.period_start, row.period_end, row.executed_at].every(
            (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
          ) ||
          Date.parse(row.period_start) >= Date.parse(row.period_end)
        )
          throw new Error('Rakeback History Could Not Be Verified');
        ids.add(row.id);
        return {
          id: row.id,
          period_start: row.period_start,
          period_end: row.period_end,
          executed_at: row.executed_at,
          total_rakeback: `${amount[1]}.${(amount[2] ?? '').padEnd(2, '0').slice(0, 2)}`,
        };
      });
      if (current()) setRakebackHistory(rows);
    } catch (error) {
      if (current()) {
        setRakebackHistory([]);
        setRakebackReadError(true);
      }
      reportError(error, 'UnionDashboardPage.loadRakebackHistory');
    } finally {
      if (current()) setRakebackLoading(false);
    }
  }, [authorizedUnionId, rakebackScope]);

  useEffect(() => {
    if (tab === 'treasury' && authorizedUnionId) void loadRakebackHistory();
    return () => {
      ++rakebackRead.current;
    };
  }, [tab, authorizedUnionId, loadRakebackHistory]);

  // ── Bus Listeners ──────────────────────────────────────────
  useEffect(() => {
    if (!authorizedUnionId) return;
    const refresh = () => loadDashboard(authorizedUnionId);
    const unsubs = [
      masterBus.subscribeDebounced('CLUB_UPDATED', refresh, 300),
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', refresh, 300),
      masterBus.subscribeDebounced('AGENT_UPDATED', refresh, 300),
      masterBus.subscribeDebounced('CASHOUT_APPROVED', refresh, 300),
      masterBus.subscribeDebounced('CASHOUT_REQUESTED', refresh, 300),
      masterBus.subscribeDebounced('TABLE_CREATED', refresh, 300),
      masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 300),
      masterBus.subscribeDebounced('CREDIT_UPDATED', refresh, 300),
      // Level recompute: union level updates when member roles change
      masterBus.subscribeDebounced('MEMBER_ROLE_CHANGED', refresh, 300),
      // Union level changes (from PostgresSyncHooks when unions table is updated)
      masterBus.subscribeDebounced('UNION_UPDATED', refresh, 300),
    ];
    return () => unsubs.forEach((u) => u());
  }, [authorizedUnionId, loadDashboard]);

  // ── Supabase Realtime — cross-user WebSocket updates ──
  useEffect(() => {
    if (!authorizedUnionId) return;
    const channelKey = `union-dashboard-${authorizedUnionId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'union_clubs',
          filter: `union_id=eq.${authorizedUnionId}`,
        },
        () => loadDashboard(authorizedUnionId)
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'union_applications',
          filter: `union_id=eq.${authorizedUnionId}`,
        },
        () => loadDashboard(authorizedUnionId)
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'union_admins',
          filter: `union_id=eq.${authorizedUnionId}`,
        },
        () => loadDashboard(authorizedUnionId)
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'union_wallets',
          filter: `union_id=eq.${authorizedUnionId}`,
        },
        () => loadDashboard(authorizedUnionId)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'unions', filter: `id=eq.${authorizedUnionId}` },
        () => loadDashboard(authorizedUnionId)
      )
      /* THE LIVE JACKPOT TICK MOVED OFF REALTIME (BBJ phase 3.2, 2026-09-06).
         `bbj_pools` updates on every raked hand at every union club - 40,219
         updates in twenty-four hours, measured on production - and six
         surfaces held a subscription to it so that a figure could be exact to
         the second. The tiles now follow the same shared ten-second poll every
         other jackpot surface uses (the effect below), which also stops this
         dashboard paying for the firehose while it sits open in a background
         tab. Everything else on the row still arrives through loadDashboard. */
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'UnionDashboardPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[UnionDashboardPage] Realtime channel timed out');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [authorizedUnionId, authorizedScope?.userId, loadDashboard, routeUnionId, user?.id]);

  // ── Visibility Refresh — refresh on tab focus after 30s ──
  useVisibilityRefresh(() => {
    if (authorizedUnionId) void loadDashboard(authorizedUnionId);
  });

  // ── Computed ───────────────────────────────────────────────
  const isLead = adminRole === 'union_lead';

  /**
   * The union's LIVE Spins wallet -- the float multipliers are actually paid
   * from. Deliberately distinct from the "Spin Reserve" tile beside it, which
   * shows union_wallets.spin_reserve_wallet: capital earmarked for Spins but
   * NOT yet deployed. The two never double-count, and until now only the
   * undeployed half had a tile anywhere in the product.
   */
  const unionSpins = useSpinsWallet(authorizedUnionId, Boolean(authorizedUnionId));

  // ── Union-wide player roster (Dan 2026-08-22: every player of every club,
  //    with their role — the union is for tracking, so it must SEE everyone). ──
  useEffect(() => {
    if (tab !== 'players' || !authorizedUnionId) return;
    setRosterLoading(true);
    void supabase
      .rpc('fn_union_player_directory', { p_union_id: authorizedUnionId })
      .then(({ data, error }) => {
        if (error) {
          reportError(error, 'UnionDashboard.roster_load_failed');
          setRoster([]);
        } else {
          setRoster((data as typeof roster) || []);
        }
        setRosterLoading(false);
      });
  }, [tab, authorizedUnionId]);

  const filteredRoster = useMemo(() => {
    const q = rosterSearch.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter(
      (r) =>
        (r.display_name || '').toLowerCase().includes(q) ||
        (r.username || '').toLowerCase().includes(q) ||
        (r.club_name || '').toLowerCase().includes(q) ||
        (r.member_role || '').toLowerCase().includes(q)
    );
  }, [roster, rosterSearch]);

  const filteredClubs = useMemo(() => {
    if (!clubSearch.trim()) return clubs;
    const q = clubSearch.toLowerCase();
    return clubs.filter((c) => c.name?.toLowerCase().includes(q) || String(c.club_id).includes(q));
  }, [clubs, clubSearch]);

  const filteredAgents = useMemo(() => {
    if (!agentSearch.trim()) return agents;
    const q = agentSearch.toLowerCase();
    return agents.filter(
      (a: UnionAgent) =>
        a.profiles?.display_name?.toLowerCase().includes(q) ||
        a.profiles?.username?.toLowerCase().includes(q) ||
        a.role?.toLowerCase().includes(q)
    );
  }, [agents, agentSearch]);

  // ── CSV Export ─────────────────────────────────────────────
  const downloadCSV = (filename: string, headers: string[], rows: (string | number)[][]) => {
    const csv = [
      headers.join(','),
      ...rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')),
    ].join('\n');
    downloadCsv(filename, csv);
  };

  const exportRoster = () => {
    const headers = ['Player', 'Club', 'Role', 'Status', 'Seated'];
    const rows = filteredRoster.map((r) => [
      r.display_name || r.username || r.user_id,
      r.club_name || '',
      r.member_role || 'member',
      r.member_status || '',
      r.currently_seated ? 'yes' : '',
    ]);
    downloadCSV(`union_players_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  };

  const exportAgents = () => {
    const headers = ['Agent', 'Club', 'Role', 'Commission', 'Status'];
    const rows = agents.map((a: UnionAgent) => {
      const club = clubs.find((c) => c.id === a.club_id);
      return [
        a.profiles ? playerDisplayName(a.profiles) : a.user_id,
        club?.name || 'Unknown',
        a.role,
        pct(a.commission_rate),
        a.status,
      ];
    });
    downloadCSV(`union_agents_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  };

  // ── Loading State ──────────────────────────────────────────
  const routeResolutionPending = Boolean(unionRef && !routeUnionId);

  if (loading || routeResolutionPending || (!authorizedUnionId && !error)) {
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
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="admin-skeleton" style={{ height: '80px' }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error && !authorizedUnionId) {
    const accessRestricted = /not a union admin|not.*owner/i.test(error);
    return (
      <div className="admin-page">
        {accessRestricted ? (
          <EmptyState
            icon="UNION"
            eyebrow="Union Permission Gate"
            tone="permission"
            title="No Union Workspace Is Available"
            description="Union Treasury, Clubs, Agents, And Settlement Controls Are Available Only To A Union Owner Or Appointed Administrator."
            /* Not /unions. This empty state exists BECAUSE the person was
               refused a union workspace, and since 2026-09-05 the directory is
               allowlisted too - so the old CTA offered a refused person a
               second refusal. /community is the section both live under, and an
               allowlisted operator still finds the Unions card there. */
            action={{ label: 'Back To Community', onClick: () => navigate('/community') }}
            secondaryAction={{ label: 'Return To Arena', onClick: () => navigate('/') }}
          />
        ) : (
          <ErrorState message={error} onRetry={() => void loadDashboard(unionId)} />
        )}
      </div>
    );
  }

  const pendingAppsCount = apps.filter((a) => a.status === 'pending').length;

  return (
    <div className="admin-page" data-arena-surface="union-operations">
      <div className="admin-container">
        {error && <div className="admin-error-banner">{error}</div>}
        {success && <div className="admin-success-banner">{success}</div>}

        <CasinoSurfaceHeader
          crest="club"
          eyebrow="Union Network / Operations"
          title={union?.name || 'Union Operations'}
          description="Govern Member Clubs, Agents, Treasury, Applications, Analytics, And Network Controls From One Permission-Backed Command Deck."
          artPath="assets/club-buttons/wallets/desktop/wallet-union-bank-v1.webp"
          status="UNION OPERATIONS // AUTHORIZED"
          metrics={[
            { label: 'Clubs', value: clubs.length, tone: 'live' },
            { label: 'Agents', value: agents.length },
            { label: 'Applications', value: pendingAppsCount, tone: 'attention' },
          ]}
        />

        {/* Edit Commission Modal */}
        {editCommClub && (
          <div
            className="admin-modal-overlay"
            onClick={() => setEditCommClub(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditCommClub(null);
            }}
          >
            <div
              className="admin-card"
              style={{ maxWidth: '380px', margin: '60px auto', padding: '20px' }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="admin-card-title">Edit Commission - {editCommClub.name}</h3>
              <div style={{ marginBottom: '12px' }}>
                <label className="admin-label">Commission Rate (%)</label>
                <input
                  className="admin-input"
                  type="number"
                  min="1"
                  max="100"
                  value={editCommRate}
                  onChange={(e) => setEditCommRate(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="admin-btn admin-btn-primary"
                  disabled={processing}
                  onClick={async () => {
                    const rate = parseFloat(editCommRate) / 100;
                    if (isNaN(rate) || rate < 0.01 || rate > 1) {
                      setError('Rate must be 1-100%');
                      return;
                    }
                    setProcessing(true);
                    setError(null);
                    try {
                      // UNION AUDIT FIX 2026-07-21: direct update targeted a
                      // non-existent column AND was RLS-blocked. Route through
                      // manage-union update_club_commission (service-role;
                      // syncs union_clubs + clubs).
                      await unionApi.updateClubCommission(unionId!, editCommClub.id, rate);
                      masterBus.emit('CLUB_UPDATED', { clubId: editCommClub.id });
                      setSuccess('Commission updated');
                      setEditCommClub(null);
                      loadDashboard(unionId);
                    } catch (err: any) {
                      setError(safeErrorMessage(err));
                    } finally {
                      setProcessing(false);
                    }
                  }}
                >
                  Save
                </button>
                <button className="admin-btn admin-btn-ghost" onClick={() => setEditCommClub(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="admin-page-header">
          <div className="admin-page-title">
            {union?.name || 'Union Dashboard'}
            {union?.code && (
              <span className="admin-badge" style={{ marginLeft: '12px' }}>
                {union.code}
              </span>
            )}
            {(() => {
              const uLevel = getUnionLevel({
                level: (union as any)?.level || 1,
                playerLevel: (union as any)?.player_level,
                hierarchyLevel: (union as any)?.hierarchy_level,
                totalPlayers: (union as any)?.total_players || 0,
                hierarchyUnitsRoundedUp: (union as any)?.hierarchy_units_rounded_up || 0,
                playerThresholdCurrent: (union as any)?.player_threshold_current || 0,
                playerThresholdNext: (union as any)?.player_threshold_next || 0,
                hierarchyThresholdCurrent: (union as any)?.hierarchy_threshold_current || 0,
                hierarchyThresholdNext: (union as any)?.hierarchy_threshold_next || 0,
              });
              return (
                <span
                  style={{
                    marginLeft: '12px',
                    fontSize: '0.65rem',
                    padding: '3px 10px',
                    borderRadius: '12px',
                    background: uLevel.gradient,
                    color: '#fff',
                    fontWeight: 700,
                    letterSpacing: '0.5px',
                    textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                    verticalAlign: 'middle',
                  }}
                >
                  Lv.{uLevel.level} - {uLevel.tierLabel}
                </span>
              );
            })()}
          </div>
          <div className="admin-header-actions">
            <button
              onClick={() => unionId && navigate(`/unions/${unionRef || unionId}/games`)}
              className="admin-btn admin-btn-primary"
              disabled={!unionId}
            >
              Games
            </button>
            <button onClick={() => navigate('/')} className="admin-btn admin-btn-ghost">
              Lobby
            </button>
            <button
              onClick={() => loadDashboard(unionId)}
              className="admin-btn admin-btn-ghost"
              disabled={processing}
            >
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div
          className="admin-tabs"
          role="tablist"
          aria-label="Union Operations"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const tabs = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
            );
            const index = Math.max(0, tabs.indexOf(event.target as HTMLButtonElement));
            const next =
              event.key === 'Home'
                ? tabs[0]
                : event.key === 'End'
                  ? tabs[tabs.length - 1]
                  : event.key === 'ArrowRight'
                    ? tabs[(index + 1) % tabs.length]
                    : tabs[(index - 1 + tabs.length) % tabs.length];
            event.preventDefault();
            next?.click();
            next?.focus();
          }}
        >
          {(
            [
              { id: 'overview' as UnionTab, label: 'Overview' },
              { id: 'clubs' as UnionTab, label: `Clubs (${clubs.length})` },
              { id: 'players' as UnionTab, label: 'Players' },
              { id: 'agents' as UnionTab, label: `Agents (${agents.length})` },
              { id: 'wallet' as UnionTab, label: 'Wallet' },
              { id: 'treasury' as UnionTab, label: 'Treasury' },
              { id: 'analytics' as UnionTab, label: 'Analytics' },
              {
                id: 'applications' as UnionTab,
                label: 'Applications',
                badge: pendingAppsCount || undefined,
              },
              { id: 'operations' as UnionTab, label: 'Operations' },
              { id: 'settings' as UnionTab, label: 'Settings' },
            ] as { id: UnionTab; label: string; badge?: number }[]
          ).map((t) => (
            <button
              key={t.id}
              id={`union-tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`union-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`admin-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.badge ? (
                <span
                  style={{
                    marginLeft: '6px',
                    background: 'rgba(250,56,62,0.15)',
                    padding: '2px 6px',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: '#FA383E',
                  }}
                >
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div
          id={`union-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`union-tab-${tab}`}
          tabIndex={0}
        >
          {/* ══════ TAB: OVERVIEW ══════ */}
          {tab === 'overview' && (
            <div className="admin-tab-content">
              <div className="admin-stats-grid">
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                    {fmt(clubs.length)}
                  </div>
                  <div className="admin-stat-label">Clubs</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value">
                    {fmt(clubs.reduce((s, c) => s + (c.member_count || 0), 0))}
                  </div>
                  <div className="admin-stat-label">Total Members</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                    {fmt(agents.length)}
                  </div>
                  <div className="admin-stat-label">Active Agents</div>
                </div>
              </div>

              {/* Wallet Summary */}
              {wallets && (
                <div className="admin-stats-grid" style={{ marginTop: '16px' }}>
                  {(
                    [
                      {
                        key: 'chips',
                        label: 'Chip Balance',
                        color: '#4599FF',
                        value: wallets.chip_balance,
                      },
                      {
                        key: 'rake',
                        label: 'Rake Treasury',
                        color: '#31A24C',
                        value: wallets.rake_wallet,
                        detail: 'rake',
                      },
                      {
                        key: 'bbj',
                        label: `BBJ Pool${bbjPool ? ` (${bbjPool.hit_count} Hits)` : ''}`,
                        color: '#F7C52A',
                        value: bbjPool?.main_balance ?? 0,
                        detail: 'bbj',
                      },
                      {
                        key: 'promo',
                        label: 'Promo Wallet',
                        color: '#C084FC',
                        value: wallets.promo_wallet,
                      },
                    ] as {
                      key: UnionWalletKey;
                      label: string;
                      color: string;
                      value: number;
                      /**
                       * Tiles WITH a detail mode open the data panel; tiles
                       * without open the send-to-member flow directly. Rake and
                       * BBJ are the two the operator reads before spending, so
                       * they lead with the numbers and offer Send inside.
                       */
                      detail?: TreasuryDetailMode;
                    }[]
                  ).map((w) => (
                    <button
                      key={w.key}
                      className="admin-stat-card"
                      style={{ cursor: 'pointer', textAlign: 'center', border: 'none' }}
                      aria-label={`Open ${w.label}`}
                      onClick={() =>
                        w.detail
                          ? setTreasuryModal(w.detail)
                          : setWalletModal({ key: w.key, label: w.label, balance: w.value || 0 })
                      }
                    >
                      <div className="admin-stat-value" style={{ color: w.color }}>
                        {fmt(w.value)}
                      </div>
                      <div className="admin-stat-label">{w.label} ›</div>
                    </button>
                  ))}
                  {/* BACKUP JACKPOT (Dan 2026-08-24). bbj_pools.backup_balance is
                    a real bank holding money — 12,055.65 at the time this was
                    added — and it had no tile anywhere in the product, so there
                    was no way to see it and no way to move it. Distinct from
                    union_wallets.bbj_wallet on the Wallet tab: that is a wallet
                    column, this is the pool's backup bank, different money. */}
                  <button
                    className="admin-stat-card"
                    style={{ cursor: 'pointer', textAlign: 'center', border: 'none' }}
                    aria-label="Open Backup Jackpot"
                    onClick={() => setTreasuryModal('backup')}
                  >
                    <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                      {fmt(bbjPool?.backup_balance ?? 0)}
                    </div>
                    {/* 2026-09-11: this bank is what the Mini Jackpot pays from
                        (fn_bbj_mini_payout debits backup_balance), and the tile
                        never said so. */}
                    <div className="admin-stat-label">Backup Jackpot - Funds The Mini ›</div>
                  </button>
                  {/* Spin reserve. It is NOT a send source - the pool is priced on
                    being net-neutral over volume, and a manual withdrawal would
                    break that silently - but it was the only tile on the page
                    you could not open, which meant the wallet that funds the
                    entire Spin economy had no ledger anywhere in the product.
                    It opens read-only: balance and full history, no send flow. */}
                  {/* THE DEPLOYED pool. The tile below shows
                    union_wallets.spin_reserve_wallet, which is capital
                    earmarked for Spins but NOT yet in play; this is the float
                    every multiplier is actually paid from. They never
                    double-count, and until now only the undeployed half had a
                    tile anywhere in the product. Opens the Spins tab, where
                    the activation panel explains the seed and the repayment
                    plan behind this number. */}
                  <button
                    className="admin-stat-card"
                    style={{ cursor: 'pointer', textAlign: 'center', border: 'none' }}
                    aria-label="Open Spins Wallet"
                    onClick={() => setTab('settings')}
                  >
                    <div className="admin-stat-value" style={{ color: '#39d17a' }}>
                      {unionSpins.state === null ? '-' : fmt(unionSpins.balance)}
                    </div>
                    <div className="admin-stat-label">Spins Wallet ›</div>
                  </button>
                  <button
                    className="admin-stat-card"
                    style={{ cursor: 'pointer', textAlign: 'center', border: 'none' }}
                    aria-label="Open Spin Reserve"
                    onClick={() =>
                      setWalletModal({
                        key: 'spin_reserve',
                        label: 'Spin Reserve',
                        balance: wallets.spin_reserve_wallet || 0,
                      })
                    }
                  >
                    <div className="admin-stat-value" style={{ color: '#39d17a' }}>
                      {fmt(wallets.spin_reserve_wallet)}
                    </div>
                    <div className="admin-stat-label">Spin Reserve ›</div>
                  </button>
                  {/* SPINS TREASURY (Dan 2026-08-24: "the wallet is still missing
                    the spins treasury"). The two tiles above are the halves:
                    Spin Reserve is capital earmarked but NOT in play, Spins
                    Wallet is the deployed pool float every multiplier is paid
                    from. They are disjoint by construction and never double
                    count, so the treasury is their sum — and until now the
                    union could see both halves and never the whole. Opens the
                    reserve ledger, the only one of the two with a history. */}
                  <button
                    className="admin-stat-card"
                    style={{ cursor: 'pointer', textAlign: 'center', border: 'none' }}
                    aria-label="Open Spins Treasury"
                    onClick={() =>
                      setWalletModal({
                        key: 'spin_reserve',
                        label: 'Spin Reserve',
                        balance: wallets.spin_reserve_wallet || 0,
                      })
                    }
                  >
                    <div className="admin-stat-value" style={{ color: '#39d17a' }}>
                      {unionSpins.state === null
                        ? '-'
                        : fmt((wallets.spin_reserve_wallet || 0) + unionSpins.balance)}
                    </div>
                    <div className="admin-stat-label">Spins Treasury ›</div>
                  </button>
                </div>
              )}

              {/* Broadcast (Lead only) */}
              {isLead && (
                <div className="admin-card" style={{ marginTop: '16px', padding: '16px' }}>
                  <h3 className="admin-card-title">Broadcast Announcement</h3>
                  <textarea
                    className="admin-input"
                    value={annMsg}
                    onChange={(e) => setAnnMsg(e.target.value)}
                    maxLength={500}
                    placeholder="Announcement To All Clubs..."
                    rows={3}
                    style={{ resize: 'vertical' }}
                  />
                  <div
                    style={{ display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center' }}
                  >
                    <select
                      className="admin-input"
                      style={{ maxWidth: '200px' }}
                      value={annClub}
                      onChange={(e) => setAnnClub(e.target.value)}
                    >
                      <option value="">All Clubs</option>
                      {clubs.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="admin-btn admin-btn-primary"
                      disabled={processing || !annMsg.trim()}
                      onClick={async () => {
                        setProcessing(true);
                        setError(null);
                        try {
                          // UNION AUDIT FIX 2026-07-21: union_announcements was a
                          // write-only dead table (nothing reads it). The
                          // manage-union API posts into club_announcements — the
                          // feed members actually see — for every club in the
                          // union (or one targeted club).
                          await unionApi.announce(unionId!, annMsg, annClub || undefined);
                          masterBus.emit('ANNOUNCEMENT_CHANGED', {
                            clubId: annClub || unionId || '',
                            action: 'created',
                          });
                          setSuccess('Announcement sent');
                          setAnnMsg('');
                          loadDashboard(unionId);
                        } catch (err: any) {
                          setError(safeErrorMessage(err));
                        } finally {
                          setProcessing(false);
                        }
                      }}
                    >
                      Send
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══════ TAB: CLUBS ══════ */}
          {tab === 'clubs' && (
            <div className="admin-tab-content">
              <input
                className="admin-input"
                value={clubSearch}
                onChange={(e) => setClubSearch(e.target.value)}
                placeholder="Search Clubs..."
                style={{ marginBottom: '16px', maxWidth: '300px' }}
              />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: '12px',
                }}
              >
                {filteredClubs.map((club) => (
                  <div key={club.id} className="admin-card" style={{ padding: '14px 16px' }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        marginBottom: '8px',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>{club.name}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          ID: {club.club_id}
                        </div>
                      </div>
                      <span className="admin-badge">{pct(club.club_commission_rate)} Comm</span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: '12px',
                        fontSize: '12px',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <span>{fmt(club.member_count)} Members</span>
                      <span>{fmt(club.active_tables)} Tables</span>
                      <span>{fmt(club.total_rake)} Rake</span>
                    </div>
                    {isLead && (
                      <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                        <button
                          className="admin-btn admin-btn-ghost admin-btn-sm"
                          onClick={() => {
                            setEditCommClub(club);
                            setEditCommRate(String((club.club_commission_rate || 0.9) * 100));
                          }}
                        >
                          Edit Rate
                        </button>
                        {/* Removal reads the exit blockers first. The previous
                          button called unionApi.removeClub straight from a
                          confirm dialog, so a club could be dropped while its
                          players were still seated in union games and its rake
                          and agent credit were unsettled. */}
                        {unionId && (
                          <UnionClubGovernance
                            unionId={unionId}
                            clubId={club.id}
                            clubName={club.name ?? 'this club'}
                            onExpelled={(id) => {
                              masterBus.emit('CLUB_UPDATED', { clubId: id });
                              loadDashboard(unionId);
                            }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {filteredClubs.length === 0 && (
                <div className="admin-empty-state">
                  <span className="admin-empty-icon">◆</span>
                  <span>{clubSearch ? 'No Clubs Match' : 'No Clubs Yet'}</span>
                </div>
              )}
            </div>
          )}

          {/* ══════ TAB: AGENTS ══════ */}
          {tab === 'agents' && (
            <div className="admin-tab-content">
              <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                    {fmt(agents.filter((a) => a.status === 'active').length)}
                  </div>
                  <div className="admin-stat-label">Active</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#FA383E' }}>
                    {fmt(agents.filter((a) => a.status === 'suspended').length)}
                  </div>
                  <div className="admin-stat-label">Suspended</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value">{fmt(agents.length)}</div>
                  <div className="admin-stat-label">Total Agents</div>
                </div>
              </div>

              <div
                style={{ display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' }}
              >
                <input
                  className="admin-input"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  placeholder="Search Agents..."
                  style={{ maxWidth: '300px' }}
                />
                <button className="admin-btn admin-btn-ghost admin-btn-sm" onClick={exportAgents}>
                  Export CSV
                </button>
              </div>

              <div className="admin-table-scroll">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Club</th>
                      <th>Role</th>
                      <th>Commission</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAgents.map((agent) => {
                      const club = clubs.find((c) => c.id === agent.club_id);
                      return (
                        <tr key={agent.id || agent.user_id}>
                          <td>
                            {agent.profiles
                              ? playerDisplayName(agent.profiles)
                              : agent.user_id?.slice(0, 8)}
                          </td>
                          <td>{club?.name || 'Unknown'}</td>
                          <td>{agent.role}</td>
                          <td>{pct(agent.commission_rate)}</td>
                          <td>
                            <span
                              className="admin-badge"
                              style={
                                agent.status === 'active'
                                  ? { background: 'rgba(49,162,76,0.15)', color: '#31A24C' }
                                  : { background: 'rgba(250,56,62,0.15)', color: '#FA383E' }
                              }
                            >
                              {agent.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filteredAgents.length === 0 && (
                <div className="admin-empty-state">
                  <span className="admin-empty-icon">◉</span>
                  <span>{agentSearch ? 'No Agents Match' : 'No Agents Found'}</span>
                </div>
              )}
            </div>
          )}

          {/* ══════ TAB: PLAYERS — the union-wide roster ══════ */}
          {tab === 'players' && (
            <div className="admin-tab-content">
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input
                  className="admin-input"
                  style={{ flex: 1 }}
                  placeholder="Search Players By Name, Club Or Role…"
                  value={rosterSearch}
                  onChange={(e) => setRosterSearch(e.target.value)}
                />
                <span style={{ alignSelf: 'center', color: '#888', fontSize: 12 }}>
                  {fmt(filteredRoster.length)} Players
                </span>
                <button className="admin-btn admin-btn-ghost admin-btn-sm" onClick={exportRoster}>
                  Export CSV
                </button>
              </div>
              {rosterLoading ? (
                <div className="admin-empty">Loading Roster…</div>
              ) : filteredRoster.length === 0 ? (
                <div className="admin-empty">
                  <span className="admin-empty-icon">◉</span>
                  <span>{rosterSearch ? 'No Players Match' : 'No Players Found'}</span>
                </div>
              ) : (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Club</th>
                        <th>Role</th>
                        <th>Status</th>
                        <th>Seated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRoster.slice(0, 500).map((r) => (
                        <tr key={`${r.user_id}-${r.club_name}`}>
                          <td style={{ color: '#fff', fontWeight: 600 }}>
                            {r.display_name || r.username || r.user_id.slice(0, 8)}
                          </td>
                          <td>{r.club_name || ''}</td>
                          <td>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                color:
                                  r.member_role === 'owner'
                                    ? '#F7C52A'
                                    : r.member_role === 'co_owner' || r.member_role === 'admin'
                                      ? '#4599FF'
                                      : r.member_role === 'agent' || r.member_role === 'super_agent'
                                        ? '#31A24C'
                                        : '#aaa',
                              }}
                            >
                              {(r.member_role || 'member').replace('_', ' ').toUpperCase()}
                            </span>
                          </td>
                          <td>{r.member_status || ''}</td>
                          <td>{r.currently_seated ? '● At Table' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ══════ TAB: WALLET ══════ */}
          {tab === 'wallet' && (
            <div className="admin-tab-content">
              {wallets && (
                <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
                  {(
                    [
                      {
                        key: 'chips',
                        label: 'Chip Balance',
                        color: '#4599FF',
                        value: wallets.chip_balance,
                      },
                      {
                        key: 'rake',
                        label: 'Weekly Rake Wallet',
                        color: '#31A24C',
                        value: wallets.rake_wallet,
                      },
                      {
                        // union_wallets.bbj_wallet, NOT bbj_pools.backup_balance.
                        // This tile read "Backup BBJ Wallet", which is the same
                        // words as the Backup Jackpot tile on the Overview tab
                        // and a different balance — two numbers under one name is
                        // how an operator moves the wrong money. Renamed to the
                        // column it actually shows.
                        key: 'bbj',
                        label: 'BBJ Reserve Wallet',
                        color: '#F7C52A',
                        value: wallets.bbj_wallet,
                      },
                      {
                        key: 'promo',
                        label: 'Promo Wallet',
                        color: '#C084FC',
                        value: wallets.promo_wallet,
                      },
                    ] as { key: UnionWalletKey; label: string; color: string; value: number }[]
                  ).map((w) => (
                    <button
                      key={w.key}
                      className="admin-stat-card"
                      style={{ cursor: 'pointer', textAlign: 'center', border: 'none' }}
                      aria-label={`Open ${w.label}`}
                      onClick={() =>
                        setWalletModal({ key: w.key, label: w.label, balance: w.value || 0 })
                      }
                    >
                      <div className="admin-stat-value" style={{ color: w.color }}>
                        {fmt(w.value)}
                      </div>
                      <div className="admin-stat-label">{w.label} ›</div>
                    </button>
                  ))}
                  {/* Spin reserve. It is NOT a send source - the pool is priced on
                    being net-neutral over volume, and a manual withdrawal would
                    break that silently - but it was the only tile on the page
                    you could not open, which meant the wallet that funds the
                    entire Spin economy had no ledger anywhere in the product.
                    It opens read-only: balance and full history, no send flow. */}
                  {/* THE DEPLOYED pool. The tile below shows
                    union_wallets.spin_reserve_wallet, which is capital
                    earmarked for Spins but NOT yet in play; this is the float
                    every multiplier is actually paid from. They never
                    double-count, and until now only the undeployed half had a
                    tile anywhere in the product. Opens the Spins tab, where
                    the activation panel explains the seed and the repayment
                    plan behind this number. */}
                  <button
                    className="admin-stat-card"
                    style={{ cursor: 'pointer', textAlign: 'center', border: 'none' }}
                    aria-label="Open Spins Wallet"
                    onClick={() => setTab('settings')}
                  >
                    <div className="admin-stat-value" style={{ color: '#39d17a' }}>
                      {unionSpins.state === null ? '-' : fmt(unionSpins.balance)}
                    </div>
                    <div className="admin-stat-label">Spins Wallet ›</div>
                  </button>
                  <button
                    className="admin-stat-card"
                    style={{ cursor: 'pointer', textAlign: 'center', border: 'none' }}
                    aria-label="Open Spin Reserve"
                    onClick={() =>
                      setWalletModal({
                        key: 'spin_reserve',
                        label: 'Spin Reserve',
                        balance: wallets.spin_reserve_wallet || 0,
                      })
                    }
                  >
                    <div className="admin-stat-value" style={{ color: '#39d17a' }}>
                      {fmt(wallets.spin_reserve_wallet)}
                    </div>
                    <div className="admin-stat-label">Spin Reserve ›</div>
                  </button>
                </div>
              )}

              {/* DEPOSIT TO UNION BANK — Move chips from owner's player wallet to union bank */}
              {isLead && (
                <div
                  className="admin-card"
                  style={{ padding: '16px', marginBottom: '16px', borderLeft: '3px solid #22c55e' }}
                >
                  <h3 className="admin-card-title" style={{ color: '#22c55e' }}>
                    Deposit To Union Bank
                  </h3>
                  <p style={{ fontSize: '12px', color: '#888', margin: '0 0 8px' }}>
                    Move Chips From Your Player Wallet Into The Union Main Bank
                  </p>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <input
                      className="admin-input"
                      style={{ flex: '0 0 150px' }}
                      type="number"
                      min="1"
                      placeholder="Amount"
                      value={depositForm.amount}
                      onChange={(e) => setDepositForm((f) => ({ ...f, amount: e.target.value }))}
                    />
                    <input
                      className="admin-input"
                      style={{ flex: '1 1 150px' }}
                      placeholder="Notes (Optional)"
                      value={depositForm.notes}
                      onChange={(e) => setDepositForm((f) => ({ ...f, notes: e.target.value }))}
                    />
                    <button
                      className="admin-btn admin-btn-primary"
                      style={{ background: '#22c55e' }}
                      disabled={processing}
                      onClick={async () => {
                        setProcessing(true);
                        setError(null);
                        try {
                          const amt = parseInt(depositForm.amount || '0', 10);
                          if (isNaN(amt) || amt <= 0) {
                            setError('Enter a valid amount');
                            setProcessing(false);
                            return;
                          }

                          // UNION AUDIT FIX 2026-07-21: was a two-step client-side
                          // chain (wallet debit succeeded, union credit RLS-blocked)
                          // that could strand the owner's chips. Now one atomic
                          // SECURITY DEFINER RPC — debit + credit + ledger in a
                          // single transaction, union-lead check inside.
                          const { data: depRes, error: depErr } = await supabase.rpc(
                            'fn_union_deposit_from_wallet',
                            {
                              p_union_id: unionId,
                              p_amount: amt,
                              p_notes: depositForm.notes || 'Union funding',
                            }
                          );
                          if (depErr) throw new Error(depErr.message || 'Deposit failed');
                          if (depRes && (depRes as any).success === false) {
                            throw new Error((depRes as any).error || 'Deposit failed');
                          }

                          setSuccess(`Deposited ${amt.toLocaleString()} chips to Union Bank`);
                          masterBus.emit('BALANCE_UPDATED', {
                            source: 'union_deposit',
                            userId: user!.id,
                          });
                          setDepositForm({ amount: '', notes: '' });
                          loadDashboard(unionId);
                        } catch (err: any) {
                          setError(safeErrorMessage(err, 'Deposit failed'));
                        } finally {
                          setProcessing(false);
                        }
                      }}
                    >
                      Deposit
                    </button>
                  </div>
                </div>
              )}

              {/* FUND SPIN RESERVE — union wallet -> spin_reserve_wallet (2026-08-22)
                The reserve is the capital every Spin bonus pool this union owns is
                seeded from, and a 100x is paid out of it. Before this control the
                only way in was the RPC typed by hand, which is why the live pool
                had been seeded 20,000 out of promo_wallet. */}
              {isLead && (
                <div
                  className="admin-card"
                  style={{ padding: '16px', marginBottom: '16px', borderLeft: '3px solid #39d17a' }}
                >
                  <h3 className="admin-card-title" style={{ color: '#39d17a' }}>
                    Fund Spin Reserve
                  </h3>
                  <p style={{ fontSize: '12px', color: '#888', margin: '0 0 8px' }}>
                    Move Chips Into The Wallet That Seeds Every Spin Bonus Pool This Union Owns.
                    {wallets ? ` Reserve Holds ${fmt(wallets.spin_reserve_wallet)}.` : ''}
                  </p>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <select
                      className="admin-input"
                      style={{ flex: '1 1 160px' }}
                      value={spinReserveForm.from}
                      onChange={(e) => setSpinReserveForm((f) => ({ ...f, from: e.target.value }))}
                    >
                      <option value="promo_wallet">From Promo Wallet</option>
                      <option value="rake_wallet">From Rake Wallet</option>
                      <option value="chip_balance">From Chip Balance</option>
                    </select>
                    <input
                      className="admin-input"
                      style={{ flex: '0 0 150px' }}
                      type="number"
                      min="1"
                      placeholder="Amount"
                      value={spinReserveForm.amount}
                      onChange={(e) =>
                        setSpinReserveForm((f) => ({ ...f, amount: e.target.value }))
                      }
                    />
                    <button
                      className="admin-btn admin-btn-primary"
                      style={{ background: '#39d17a', color: '#000' }}
                      disabled={processing || !spinReserveForm.amount}
                      onClick={async () => {
                        setProcessing(true);
                        setError(null);
                        try {
                          const amt = parseInt(spinReserveForm.amount || '0', 10);
                          if (isNaN(amt) || amt <= 0) {
                            setError('Enter a valid amount');
                            setProcessing(false);
                            return;
                          }
                          await unionApi.fundSpinReserve(
                            unionId!,
                            amt,
                            spinReserveForm.from as 'promo_wallet' | 'rake_wallet' | 'chip_balance'
                          );
                          setSuccess(`${amt.toLocaleString()} chips moved to the Spin reserve`);
                          setSpinReserveForm((f) => ({ ...f, amount: '' }));
                          masterBus.emit('BALANCE_UPDATED', { source: 'spin_reserve_fund' });
                          loadDashboard(unionId);
                        } catch (err: any) {
                          setError(safeErrorMessage(err, 'Spin reserve funding failed'));
                        } finally {
                          setProcessing(false);
                        }
                      }}
                    >
                      Fund Reserve
                    </button>
                  </div>
                </div>
              )}

              {/* FUND BBJ POOL — union bank -> shared jackpot (BBJ unification 2026-07-21) */}
              {isLead && (
                <div
                  className="admin-card"
                  style={{ padding: '16px', marginBottom: '16px', borderLeft: '3px solid #F7C52A' }}
                >
                  <h3 className="admin-card-title" style={{ color: '#F7C52A' }}>
                    Fund BBJ Pool
                  </h3>
                  <p style={{ fontSize: '12px', color: '#888', margin: '0 0 8px' }}>
                    Move Chips From The Union Bank Into The Shared Bad Beat Jackpot. Split Across
                    Main/Backup/Promo Per Your Union BBJ Settings.
                    {bbjPool
                      ? ` Current Pool: ${fmt(bbjPool.main_balance)} Main / ${fmt(bbjPool.backup_balance)} Backup / ${fmt(bbjPool.promo_balance)} Promo.`
                      : ' No Active Pool Found.'}
                  </p>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <input
                      className="admin-input"
                      style={{ flex: '0 0 150px' }}
                      type="number"
                      min="1"
                      placeholder="Amount"
                      value={bbjFundAmount}
                      onChange={(e) => setBbjFundAmount(e.target.value)}
                    />
                    <button
                      className="admin-btn admin-btn-primary"
                      style={{ background: '#F7C52A', color: '#000' }}
                      disabled={processing || !bbjFundAmount}
                      onClick={async () => {
                        setProcessing(true);
                        setError(null);
                        try {
                          const amt = parseInt(bbjFundAmount || '0', 10);
                          if (isNaN(amt) || amt <= 0) {
                            setError('Enter a valid amount');
                            setProcessing(false);
                            return;
                          }
                          await unionApi.fundBbjPool(unionId!, amt);
                          setSuccess(`${amt.toLocaleString()} chips moved to the BBJ pool`);
                          setBbjFundAmount('');
                          masterBus.emit('BALANCE_UPDATED', { source: 'bbj_fund' });
                          loadDashboard(unionId);
                        } catch (err: any) {
                          setError(safeErrorMessage(err, 'BBJ funding failed'));
                        } finally {
                          setProcessing(false);
                        }
                      }}
                    >
                      Fund Jackpot
                    </button>
                  </div>
                </div>
              )}

              {/* ══════════════════════════════════════════════════════════════
                  THE UNION'S MINI JACKPOT (2026-09-11)

                  Phase 3 gave the mini a switch and a reserve floor, both keyed
                  on a CLUB, and both refuse a club inside a union - correctly,
                  because one member club must not decide what every table under
                  the union pays. The union was then given nothing to follow
                  that sentence to, and the larger pool on this platform is a
                  union pool: nobody could turn this mini off and nobody could
                  move its floor.

                  It sits beside Fund BBJ Pool because it is the same money -
                  the mini is paid out of backup_balance - and behind the same
                  gate: this whole page refuses a viewer who is not the union's
                  owner or an appointed admin, and the two RPCs check
                  fn_is_union_operator again regardless of what the browser
                  believes. ══════════════════════════════════════════════ */}
              {bbjPool && (
                <div
                  className="admin-card"
                  style={{ padding: '16px', marginBottom: '16px', borderLeft: '3px solid #4599FF' }}
                >
                  <h3 className="admin-card-title" style={{ color: '#4599FF' }}>
                    Mini Jackpot
                  </h3>
                  <p style={{ fontSize: '12px', color: '#888', margin: '0 0 8px' }}>
                    {/* No possessive apostrophe in this copy on purpose: the
                        Title Case guard treats an HTML entity as a word
                        boundary, so "Union&rsquo;s" is rewritten to
                        "Union&rsquo;S" by its own --fix. Reworded rather than
                        exempted - never fix a message by disabling the
                        transform (CLAUDE.md section 5 rule 7). */}
                    A Second, Smaller Jackpot For The Bad Beats The Main Rule Turns Away. It Pays A
                    Flat Amount Set By The Stakes, Out Of The Backup Pool This Union Shares, And No
                    Extra Fee Is Taken For It. Every Club In This Union Has One Switch And One
                    Reserve Floor Between Them. Backup Pool: {fmt(bbjPool.backup_balance)}.
                  </p>
                  <div
                    style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}
                  >
                    <button
                      className="admin-btn"
                      style={{
                        background: bbjPool.mini_enabled ? '#4599FF' : '#333',
                        color: bbjPool.mini_enabled ? '#000' : '#ccc',
                      }}
                      disabled={processing}
                      aria-pressed={bbjPool.mini_enabled}
                      aria-label={
                        bbjPool.mini_enabled
                          ? 'Turn The Mini Jackpot Off For This Union'
                          : 'Turn The Mini Jackpot On For This Union'
                      }
                      onClick={async () => {
                        setProcessing(true);
                        setError(null);
                        try {
                          /* The button reflects what the DATABASE says after
                             the write, never what was clicked. An optimistic
                             flip the server then refused would leave an
                             operator believing they had switched off a jackpot
                             that kept paying. */
                          const res = await setBbjUnionMiniEnabled(unionId!, !bbjPool.mini_enabled);
                          if (!res.ok) {
                            setError(miniRefusalText(res.reason));
                            return;
                          }
                          setSuccess(res.enabled ? 'Mini Jackpot Is On' : 'Mini Jackpot Is Off');
                          loadDashboard(unionId);
                        } finally {
                          setProcessing(false);
                        }
                      }}
                    >
                      {bbjPool.mini_enabled ? 'ON' : 'OFF'}
                    </button>
                    <input
                      className="admin-input"
                      style={{ flex: '0 0 170px' }}
                      type="number"
                      min="0"
                      aria-label="Reserve Floor"
                      placeholder="Reserve Floor"
                      value={miniFloorDraft ?? String(bbjPool.mini_reserve_floor ?? '')}
                      onChange={(e) => setMiniFloorDraft(e.target.value)}
                    />
                    <button
                      className="admin-btn admin-btn-primary"
                      style={{ background: '#4599FF', color: '#000' }}
                      disabled={processing || miniFloorDraft === null}
                      onClick={async () => {
                        if (miniFloorDraft === null) return;
                        const next = Number(miniFloorDraft);
                        if (!Number.isFinite(next)) {
                          setError('That Is Not A Number.');
                          return;
                        }
                        setProcessing(true);
                        setError(null);
                        try {
                          const res = await setBbjUnionMiniFloor(unionId!, next);
                          if (!res.ok) {
                            setError(miniRefusalText(res.reason, res.minimum));
                            return;
                          }
                          setMiniFloorDraft(null);
                          setSuccess('Reserve Floor Saved');
                          loadDashboard(unionId);
                        } finally {
                          setProcessing(false);
                        }
                      }}
                    >
                      Save Floor
                    </button>
                  </div>
                  <p style={{ fontSize: '11px', color: '#666', margin: '8px 0 0' }}>
                    The Reserve Floor Is What Stays In The Backup Pool. A Mini That Would Take It
                    Below That Is Not Paid, So The Floor Cannot Be Set Under One Payout At The
                    Largest Stakes.
                  </p>
                </div>
              )}

              {/* CLAWBACK — Recall chips from any wallet (club, agent, player) back to union */}
              {isLead && (
                <div
                  className="admin-card"
                  style={{ padding: '16px', marginBottom: '16px', borderLeft: '3px solid #ef4444' }}
                >
                  <h3 className="admin-card-title" style={{ color: '#ef4444' }}>
                    Clawback Chips
                  </h3>
                  <p style={{ fontSize: '12px', color: '#888', margin: '0 0 8px' }}>
                    Recall Chips From Any Club Treasury, Agent Wallet, Or Player Wallet Back To
                    Union Bank
                  </p>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <select
                      className="admin-input"
                      style={{ flex: '1 1 200px' }}
                      value={clawbackForm.target}
                      onChange={(e) => setClawbackForm((f) => ({ ...f, target: e.target.value }))}
                    >
                      <option value="">Select Target...</option>
                      <optgroup label="Club Treasuries">
                        {clubs.map((c) => (
                          <option key={`club-${c.id}`} value={`club:${c.id}`}>
                            {c.name} (Treasury)
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    <input
                      className="admin-input"
                      style={{ flex: '0 0 120px' }}
                      type="number"
                      min="1"
                      placeholder="Amount"
                      value={clawbackForm.amount}
                      onChange={(e) => setClawbackForm((f) => ({ ...f, amount: e.target.value }))}
                    />
                    <input
                      className="admin-input"
                      style={{ flex: '1 1 150px' }}
                      placeholder="Reason"
                      value={clawbackForm.reason}
                      onChange={(e) => setClawbackForm((f) => ({ ...f, reason: e.target.value }))}
                    />
                    <button
                      className="admin-btn"
                      style={{ background: '#ef4444', color: '#fff' }}
                      disabled={processing}
                      onClick={async () => {
                        setProcessing(true);
                        setError(null);
                        try {
                          const target = clawbackForm.target;
                          const amt = parseInt(clawbackForm.amount || '0', 10);
                          const reason = clawbackForm.reason || 'Union clawback';

                          if (!target) {
                            setError('Select a target');
                            setProcessing(false);
                            return;
                          }
                          if (isNaN(amt) || amt <= 0) {
                            setError('Enter a valid amount');
                            setProcessing(false);
                            return;
                          }

                          const [targetType, targetId] = target.split(':');

                          if (targetType === 'club') {
                            // UNION AUDIT FIX 2026-07-21: was a two-step chain
                            // (treasury debit + separate union credit) that could
                            // strand chips if the second call failed. Now one
                            // atomic SECURITY DEFINER RPC with the union-lead
                            // check and both ledger rows inside.
                            const { data: clubName } = await supabase
                              .from('clubs')
                              .select('name')
                              .eq('id', targetId)
                              .maybeSingle();
                            const { data: cbRes, error: cbErr } = await supabase.rpc(
                              'fn_union_clawback_from_club',
                              {
                                p_union_id: unionId,
                                p_club_id: targetId,
                                p_amount: amt,
                                p_notes: reason,
                              }
                            );
                            if (cbErr) throw new Error(cbErr.message || 'Clawback failed');
                            if (cbRes && (cbRes as any).success === false) {
                              const msg = (cbRes as any).error || 'Clawback failed';
                              setError(
                                msg.includes('insufficient')
                                  ? 'Club has insufficient treasury balance'
                                  : msg
                              );
                              setProcessing(false);
                              return;
                            }

                            setSuccess(
                              `Clawed back ${amt.toLocaleString()} chips from ${clubName?.name || 'club'}`
                            );
                          }

                          masterBus.emit('BALANCE_UPDATED', { source: 'clawback' });
                          masterBus.emit('CLUB_UPDATED', { clubId: targetId });
                          setClawbackForm({ target: '', amount: '', reason: '' });
                          loadDashboard(unionId);
                        } catch (err: any) {
                          setError(safeErrorMessage(err, 'Clawback failed'));
                        } finally {
                          setProcessing(false);
                        }
                      }}
                    >
                      Clawback
                    </button>
                  </div>
                </div>
              )}

              {isLead && (
                <div className="admin-card" style={{ padding: '16px', marginBottom: '16px' }}>
                  <h3 className="admin-card-title">Send Chips To Club</h3>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <select
                      className="admin-input"
                      style={{ flex: '1 1 200px' }}
                      value={transferForm.clubId}
                      onChange={(e) => setTransferForm((f) => ({ ...f, clubId: e.target.value }))}
                    >
                      <option value="">Select Club...</option>
                      {clubs.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <input
                      className="admin-input"
                      style={{ flex: '0 0 120px' }}
                      type="number"
                      min="1"
                      value={transferForm.amount}
                      onChange={(e) => setTransferForm((f) => ({ ...f, amount: e.target.value }))}
                      placeholder="Amount"
                    />
                    <input
                      className="admin-input"
                      style={{ flex: '1 1 150px' }}
                      value={transferForm.notes}
                      onChange={(e) => setTransferForm((f) => ({ ...f, notes: e.target.value }))}
                      placeholder="Notes"
                    />
                    <button
                      className="admin-btn admin-btn-primary"
                      disabled={processing || !transferForm.clubId || !transferForm.amount}
                      onClick={async () => {
                        setProcessing(true);
                        setError(null);
                        try {
                          const chipAmount = parseInt(transferForm.amount, 10);
                          if (isNaN(chipAmount) || chipAmount <= 0) {
                            setError('Enter a valid chip amount');
                            setProcessing(false);
                            return;
                          }
                          // UNION AUDIT FIX 2026-07-21: fn_union_send_chips_to_club
                          // is not SECURITY DEFINER, so calling it as a browser
                          // user was RLS-blocked (silent no-op). Route through the
                          // hardened union-wallet API (service role, idempotency
                          // key, debit->credit with rollback).
                          await unionApi.sendToClub(
                            unionId!,
                            transferForm.clubId,
                            chipAmount,
                            transferForm.notes || undefined
                          );
                          setSuccess(`Sent ${chipAmount.toLocaleString()} chips to club`);
                          masterBus.emit('BALANCE_UPDATED', { source: 'union_transfer' });
                          setTransferForm({ clubId: '', amount: '', notes: '' });
                          loadDashboard(unionId);
                        } catch (err: any) {
                          setError(safeErrorMessage(err));
                        } finally {
                          setProcessing(false);
                        }
                      }}
                    >
                      Send
                    </button>
                  </div>
                </div>
              )}

              {/* TRANSACTION HISTORY from chip_ledger */}
              <TransactionLedgerView unionId={unionId || undefined} userId={user?.id || ''} />
            </div>
          )}

          {/* ══════ TAB: TREASURY ══════ */}
          {tab === 'treasury' && (
            <div className="admin-tab-content">
              <h3 className="admin-section-title">Club Treasury Breakdown</h3>
              {clubs.length === 0 ? (
                <div className="admin-empty-state">
                  <span className="admin-empty-icon">▦</span>
                  <span>No Clubs Yet</span>
                </div>
              ) : (
                <div className="admin-table-scroll">
                  <table className="admin-data-table">
                    <thead>
                      <tr>
                        <th>Club</th>
                        <th>Treasury</th>
                        <th>Agents</th>
                        <th>Members</th>
                        <th>Health</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clubs.map((c) => {
                        const treasury = c.chip_treasury || 0;
                        const agentCount = agents.filter((a) => a.club_id === c.id).length;
                        const health =
                          treasury > 100000
                            ? 'Excellent'
                            : treasury > 10000
                              ? 'Good'
                              : treasury > 0
                                ? 'Low'
                                : 'Empty';
                        const healthColor =
                          treasury > 100000
                            ? '#31A24C'
                            : treasury > 10000
                              ? '#4599FF'
                              : treasury > 0
                                ? '#F7C52A'
                                : '#FA383E';
                        return (
                          <tr key={c.id}>
                            <td style={{ fontWeight: 600 }}>{c.name}</td>
                            <td style={{ fontWeight: 700, color: '#31A24C' }}>{fmt(treasury)}</td>
                            <td>{agentCount}</td>
                            <td>{fmt(c.member_count)}</td>
                            <td>
                              <span style={{ color: healthColor, fontWeight: 600 }}>{health}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="admin-stats-grid" style={{ marginTop: '16px' }}>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                    {fmt(clubs.reduce((s, c) => s + (c.chip_treasury || 0), 0))}
                  </div>
                  <div className="admin-stat-label">Total Treasury</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                    {fmt(agents.length)}
                  </div>
                  <div className="admin-stat-label">Total Agents</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value">
                    {fmt(clubs.reduce((s, c) => s + (c.member_count || 0), 0))}
                  </div>
                  <div className="admin-stat-label">Total Members</div>
                </div>
              </div>
            </div>
          )}

          {/* ══════ TAB: ANALYTICS ══════ */}
          {tab === 'analytics' && (
            <div className="admin-tab-content">
              <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                    {fmt(clubs.length)}
                  </div>
                  <div className="admin-stat-label">Total Clubs</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                    {fmt(agents.length)}
                  </div>
                  <div className="admin-stat-label">Active Agents</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value">
                    {fmt(clubs.reduce((s, c) => s + (c.member_count || 0), 0))}
                  </div>
                  <div className="admin-stat-label">Total Members</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                    {fmt(recentPeriods.filter((p) => p.status === 'open').length)}
                  </div>
                  <div className="admin-stat-label">Open Periods</div>
                </div>
              </div>

              {/* Canonical weekly accounting navigation and retained records */}
              <h3 className="admin-section-title">Weekly Rakeback</h3>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  flexWrap: 'wrap',
                  marginBottom: '16px',
                }}
              >
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  View Recorded Weekly Accounting And Issued Invoices For This Union.
                </span>
                <button
                  className="admin-action-btn"
                  onClick={() =>
                    authorizedUnionId && navigate(`/unions/${authorizedUnionId}/settlement`)
                  }
                  disabled={!authorizedUnionId}
                >
                  View Accounting Status
                </button>
              </div>
              <h4>Recorded Rakeback History · Latest Up To 12 Records</h4>
              <button
                className="admin-action-btn"
                onClick={() => void loadRakebackHistory()}
                disabled={!rakebackScope() || (rakebackVisible && rakebackLoading)}
              >
                Refresh History
              </button>
              {rakebackVisible && rakebackLoading && (
                <p role="status">Loading Recorded Rakeback History…</p>
              )}
              {(!rakebackVisible || rakebackReadError) && (
                <p role="alert">Recorded Rakeback History Is Unavailable.</p>
              )}
              {rakebackVisible &&
                !rakebackLoading &&
                !rakebackReadError &&
                rakebackHistory.length === 0 && (
                  <p>No Recorded Rakeback History Was Found For This Union.</p>
                )}
              {rakebackVisible &&
                !rakebackLoading &&
                !rakebackReadError &&
                rakebackHistory.length > 0 && (
                  <div className="admin-table-scroll" style={{ marginBottom: '20px' }}>
                    <table className="admin-data-table">
                      <thead>
                        <tr>
                          <th>Period</th>
                          <th>Total Rakeback</th>
                          <th>Executed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rakebackHistory.map((r) => (
                          <tr key={r.id}>
                            <td style={{ fontSize: '12px' }}>
                              {new Date(r.period_start).toLocaleDateString()} -{' '}
                              {new Date(r.period_end).toLocaleDateString()}
                            </td>
                            <td>{formatWeeklyChips(r.total_rakeback)}</td>
                            <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                              {timeAgo(r.executed_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

              {/* ── Weekly Player P&L Settlement (added 2026-08-19) ──
                The club<->union square-up for player wins and losses. This is
                the only place it is visible; before this it ran with no
                surface at all. A period shown as "Review" moved NO chips on
                purpose: the club nets did not prove zero-sum, so the
                settlement refused to pay rather than pay a wrong number. */}
              <h3 className="admin-section-title">Weekly Player P&amp;L Settlement</h3>
              {pnlSettlements.length === 0 ? (
                <div className="admin-empty-state">
                  <span className="admin-empty-icon">▦</span>
                  <span>No Player P&amp;L Settlement Has Run Yet</span>
                </div>
              ) : (
                <div className="admin-table-scroll">
                  <table className="admin-data-table">
                    <thead>
                      <tr>
                        <th>Week Of</th>
                        <th>Status</th>
                        <th>Collected</th>
                        <th>Paid</th>
                        <th>Outstanding</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pnlSettlements.map((s: any) => {
                        const settled = s.status === 'settled';
                        const review = s.status === 'needs_review';
                        return (
                          <tr key={s.id}>
                            <td>{new Date(s.period_start).toLocaleDateString()}</td>
                            <td>
                              <span
                                className="admin-badge"
                                style={{
                                  background: review
                                    ? 'rgba(245,158,11,0.15)'
                                    : settled
                                      ? 'rgba(34,197,94,0.15)'
                                      : 'rgba(148,163,184,0.15)',
                                  color: review ? '#f59e0b' : settled ? '#22c55e' : '#94a3b8',
                                }}
                                title={
                                  review
                                    ? 'Club Nets Did Not Balance To Zero Across The Union - No Chips Were Moved, Pending Review.'
                                    : undefined
                                }
                              >
                                {review ? 'Review' : settled ? 'Settled' : s.status}
                              </span>
                            </td>
                            <td>{Number(s.total_collected || 0).toLocaleString()}</td>
                            <td>{Number(s.total_paid || 0).toLocaleString()}</td>
                            <td>
                              {Number(s.total_unpaid || 0) > 0
                                ? Number(s.total_unpaid).toLocaleString()
                                : '-'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Settlement Periods */}
              <h3 className="admin-section-title">Recent Settlement Periods</h3>
              {recentPeriods.length === 0 ? (
                <div className="admin-empty-state">
                  <span className="admin-empty-icon">▦</span>
                  <span>No Settlement Data Yet</span>
                </div>
              ) : (
                <div className="admin-table-scroll">
                  <table className="admin-data-table">
                    <thead>
                      <tr>
                        <th>Club</th>
                        <th>Period</th>
                        <th>Rake</th>
                        <th>Hands</th>
                        <th>Status</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentPeriods.slice(0, 20).map((p) => {
                        const club = clubs.find((c) => c.id === p.club_id);
                        return (
                          <tr key={p.id}>
                            <td>{club?.name || 'Unknown'}</td>
                            <td>#{p.period_number}</td>
                            <td style={{ color: '#31A24C' }}>{fmt(p.total_rake_collected)}</td>
                            <td>{fmt(p.total_hands_dealt)}</td>
                            <td>
                              <span className="admin-badge">{p.status}</span>
                            </td>
                            <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                              {timeAgo(p.created_at)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ══════ TAB: APPLICATIONS ══════ */}
          {tab === 'applications' && (
            <div className="admin-tab-content">
              {!appsLoaded && (
                <div
                  style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}
                >
                  Loading Applications...
                </div>
              )}
              <div
                style={{ display: 'flex', gap: '8px', marginBottom: '16px', alignItems: 'center' }}
              >
                <select
                  className="admin-input"
                  style={{ maxWidth: '200px' }}
                  value={appsFilter}
                  onChange={(e) => {
                    setAppsFilter(e.target.value);
                    setAppsLoaded(false);
                  }}
                >
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                  <option value="all">All</option>
                </select>
                <button
                  className="admin-btn admin-btn-ghost"
                  onClick={() => {
                    setAppsLoaded(false);
                    loadApps();
                  }}
                >
                  Refresh
                </button>
              </div>

              {apps.length > 0 ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: '12px',
                  }}
                >
                  {apps.map((app) => (
                    <div key={app.id} className="admin-card" style={{ padding: '14px 16px' }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          marginBottom: '8px',
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{app.club_name}</div>
                        <span className="admin-badge">{app.status}</span>
                      </div>
                      {app.notes && (
                        <div
                          style={{
                            fontSize: '13px',
                            color: 'var(--text-secondary)',
                            fontStyle: 'italic',
                            marginBottom: '6px',
                          }}
                        >
                          "{app.notes}"
                        </div>
                      )}
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        Applied {timeAgo(app.applied_at || app.created_at)}
                      </div>
                      {app.status === 'pending' && isLead && (
                        <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                          <button
                            className="admin-btn admin-btn-success admin-btn-sm"
                            disabled={processing}
                            onClick={async () => {
                              setProcessing(true);
                              setError(null);
                              try {
                                // UNION AUDIT FIX 2026-07-21: the direct upsert
                                // wrote a non-existent column (commission_rate)
                                // and was RLS-blocked anyway. The union-application
                                // API approves + integrates the club server-side
                                // (union_clubs upsert with the correct
                                // club_commission_rate, clubs.union_id link,
                                // application status) after a union-lead check.
                                const defaultCommRate =
                                  Number(union?.settings?.default_club_commission_rate) || 0.9;
                                await unionApi.approveApplication(
                                  unionId!,
                                  app.id,
                                  defaultCommRate
                                );
                                if (app.club_id) {
                                  masterBus.emit('CLUB_UPDATED', { clubId: app.club_id });
                                }

                                setSuccess(`${app.club_name} approved and joined the union`);
                                setAppsLoaded(false);
                                loadApps();
                                loadDashboard(unionId);
                              } catch (err: any) {
                                setError(safeErrorMessage(err));
                              } finally {
                                setProcessing(false);
                              }
                            }}
                          >
                            Approve
                          </button>
                          <button
                            className="admin-btn admin-btn-danger admin-btn-sm"
                            disabled={processing}
                            onClick={async () => {
                              if (
                                !(await confirmDialog({
                                  message: `Reject ${app.club_name}?`,
                                  variant: 'danger',
                                }))
                              )
                                return;
                              setProcessing(true);
                              setError(null);
                              try {
                                // UNION AUDIT FIX 2026-07-21: routed through the
                                // union-application API (RLS blocked the direct
                                // update for union leads).
                                await unionApi.rejectApplication(unionId!, app.id);
                                setSuccess(`${app.club_name} rejected`);
                                setAppsLoaded(false);
                                loadApps();
                              } catch (err: any) {
                                setError(safeErrorMessage(err));
                              } finally {
                                setProcessing(false);
                              }
                            }}
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="admin-empty-state">
                  <span className="admin-empty-icon">▤</span>
                  <span>No {appsFilter} Applications</span>
                </div>
              )}

              {/* LEAVE REQUESTS — clubs asking to exit the union (IMPROVE 2026-07-21) */}
              <h3 className="admin-section-title" style={{ marginTop: '24px' }}>
                Leave Requests
              </h3>
              {leaveReqs.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {leaveReqs.map((lr) => (
                    <div key={lr.id} className="admin-card" style={{ padding: '14px' }}>
                      <div style={{ fontWeight: 600 }}>{lr.club_name || 'Club'}</div>
                      {lr.reason && (
                        <div
                          style={{
                            fontSize: '13px',
                            color: 'var(--text-secondary)',
                            fontStyle: 'italic',
                            margin: '4px 0',
                          }}
                        >
                          "{lr.reason}"
                        </div>
                      )}
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        Requested {timeAgo(lr.requested_at)}
                      </div>
                      {isLead && (
                        <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                          <button
                            className="admin-btn admin-btn-success admin-btn-sm"
                            disabled={processing}
                            onClick={async () => {
                              if (
                                !(await confirmDialog({
                                  message: `Approve ${lr.club_name}'s exit from the union?`,
                                  variant: 'danger',
                                }))
                              )
                                return;
                              setProcessing(true);
                              setError(null);
                              try {
                                await unionApi.approveLeave(unionId!, lr.id);
                                setSuccess(`${lr.club_name} has left the union`);
                                loadLeaveReqs();
                                loadDashboard(unionId);
                              } catch (err: any) {
                                setError(safeErrorMessage(err));
                              } finally {
                                setProcessing(false);
                              }
                            }}
                          >
                            Approve Exit
                          </button>
                          <button
                            className="admin-btn admin-btn-danger admin-btn-sm"
                            disabled={processing}
                            onClick={async () => {
                              setProcessing(true);
                              setError(null);
                              try {
                                await unionApi.denyLeave(unionId!, lr.id);
                                setSuccess(`${lr.club_name}'s leave request denied`);
                                loadLeaveReqs();
                              } catch (err: any) {
                                setError(safeErrorMessage(err));
                              } finally {
                                setProcessing(false);
                              }
                            }}
                          >
                            Deny
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="admin-empty-state">
                  <span>No Pending Leave Requests</span>
                </div>
              )}
            </div>
          )}

          {/* ══════ TAB: SETTINGS ══════ */}
          {tab === 'operations' && (
            <div style={{ padding: '16px' }}>
              {/* The panel requires a union and has no fallback. This page
                  only ever operates on the union it authorized, so without one
                  it renders no panel at all and says so. */}
              {authorizedUnionId ? (
                <UnionOpsPanel unionId={authorizedUnionId} canRun={isLead} />
              ) : (
                <div className="admin-empty-state">
                  <span>No Union Selected</span>
                </div>
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="admin-tab-content">
              {/* SPINS - the union half of the owner menu.
                A union OWNS the Spin wallet for every club inside it
                (fn_spin_reserve_owner resolves COALESCE(clubs.union_id,
                club_id)), so this is the only place its lead can switch Spins
                on, choose the stake and seed the wallet. Passing the union's
                own id is correct and deliberate: it resolves through the same
                owner lookup as a club id and lands on the union's pool.

                Rendered for every admin, not just isLead. The panel asks the
                route who may act and shows a read-only view to anyone else -
                a union admin should be able to SEE where the multiplier money
                comes from without being able to spend it. */}
              {unionId && (
                <div className="admin-card" style={{ padding: '20px', marginBottom: '16px' }}>
                  <SpinActivationPanel clubId={unionId} />
                </div>
              )}

              {isLead ? (
                <div className="admin-card" style={{ padding: '20px' }}>
                  <h3 className="admin-card-title">Union Settings</h3>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
                      gap: '12px',
                      marginBottom: '16px',
                    }}
                  >
                    <div>
                      <label className="admin-label">Union Name</label>
                      <input
                        className="admin-input"
                        value={settingsForm.name ?? union?.name ?? ''}
                        onChange={(e) => setSettingsForm((f) => ({ ...f, name: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="admin-label">Rake Hold (%)</label>
                      <input
                        className="admin-input"
                        type="number"
                        min="0"
                        max="50"
                        step="0.1"
                        value={
                          settingsForm.union_rake_hold ??
                          (Number(union?.settings?.union_rake_hold) || 0.1) * 100
                        }
                        onChange={(e) =>
                          setSettingsForm((f) => ({ ...f, union_rake_hold: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <label className="admin-label">Default Agent Comm (%)</label>
                      <input
                        className="admin-input"
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={
                          settingsForm.default_agent_commission ??
                          (Number(union?.settings?.default_agent_commission) || 0.5) * 100
                        }
                        onChange={(e) =>
                          setSettingsForm((f) => ({
                            ...f,
                            default_agent_commission: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="admin-label">Default Club Comm (%)</label>
                      <input
                        className="admin-input"
                        type="number"
                        min="1"
                        max="100"
                        step="0.1"
                        value={
                          settingsForm.default_club_commission_rate ??
                          (Number(union?.settings?.default_club_commission_rate) || 0.9) * 100
                        }
                        onChange={(e) =>
                          setSettingsForm((f) => ({
                            ...f,
                            default_club_commission_rate: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                  <textarea
                    className="admin-input"
                    value={settingsForm.description ?? union?.description ?? ''}
                    onChange={(e) =>
                      setSettingsForm((f) => ({ ...f, description: e.target.value }))
                    }
                    placeholder="Description..."
                    rows={3}
                    style={{ marginBottom: '12px', resize: 'vertical' }}
                  />
                  <button
                    className="admin-btn admin-btn-primary"
                    disabled={processing}
                    onClick={async () => {
                      setProcessing(true);
                      setError(null);
                      try {
                        const updates: Record<
                          string,
                          string | Record<string, number | string | boolean>
                        > = {};
                        if (settingsForm.name) updates.name = settingsForm.name;
                        if (settingsForm.description !== undefined)
                          updates.description = settingsForm.description;
                        const settings: Record<string, number | string | boolean> = {};
                        if (settingsForm.union_rake_hold) {
                          const v = parseFloat(settingsForm.union_rake_hold) / 100;
                          if (isNaN(v)) {
                            setError('Invalid rake hold value');
                            setProcessing(false);
                            return;
                          }
                          settings.union_rake_hold = v;
                        }
                        if (settingsForm.default_agent_commission) {
                          const v = parseFloat(settingsForm.default_agent_commission) / 100;
                          if (isNaN(v)) {
                            setError('Invalid agent commission value');
                            setProcessing(false);
                            return;
                          }
                          settings.default_agent_commission = v;
                        }
                        if (settingsForm.default_club_commission_rate) {
                          const v = parseFloat(settingsForm.default_club_commission_rate) / 100;
                          if (isNaN(v)) {
                            setError('Invalid club commission value');
                            setProcessing(false);
                            return;
                          }
                          settings.default_club_commission_rate = v;
                        }
                        if (Object.keys(settings).length > 0)
                          updates.settings = { ...(union?.settings || {}), ...settings };
                        // UNION AUDIT FIX 2026-07-21: direct unions.update was
                        // RLS-blocked for browser users (silent no-op). Route
                        // through manage-union update_settings, which also
                        // validates the financial settings server-side.
                        await unionApi.updateSettings(unionId!, {
                          name: updates.name as string | undefined,
                          description: updates.description as string | undefined,
                          settings: updates.settings as Record<string, unknown> | undefined,
                        });
                        masterBus.emit('CLUB_UPDATED', { clubId: unionId || '' });
                        setSuccess('Settings saved');
                        loadDashboard(unionId);
                      } catch (err: any) {
                        setError(safeErrorMessage(err));
                      } finally {
                        setProcessing(false);
                      }
                    }}
                  >
                    Save Settings
                  </button>
                </div>
              ) : (
                <div className="admin-card" style={{ padding: '20px' }}>
                  <h3 className="admin-card-title">Union Settings (Read Only)</h3>
                  <div className="admin-text-secondary">
                    <div>Rake Hold: {pct(Number(union?.settings?.union_rake_hold))}</div>
                    <div>
                      Agent Commission: {pct(Number(union?.settings?.default_agent_commission))}
                    </div>
                    <div>
                      Club Commission: {pct(Number(union?.settings?.default_club_commission_rate))}
                    </div>
                  </div>
                </div>
              )}

              {/* Admin Management */}
              <div className="admin-card" style={{ padding: '20px', marginTop: '16px' }}>
                <h3 className="admin-card-title">Union Admins</h3>
                <div className="admin-table-scroll">
                  <table className="admin-data-table">
                    <thead>
                      <tr>
                        <th>Admin</th>
                        <th>Role</th>
                        <th>Since</th>
                        {isLead && <th>Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {admins.map((admin) => (
                        <tr key={admin.user_id}>
                          <td style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {admin.profile?.avatar_url && (
                              <img
                                src={admin.profile.avatar_url}
                                alt=""
                                style={{ width: 28, height: 28, borderRadius: '50%' }}
                              />
                            )}
                            {admin.profile
                              ? playerDisplayName(admin.profile)
                              : admin.user_id?.slice(0, 8)}
                          </td>
                          <td>
                            <span
                              className="admin-badge"
                              style={
                                admin.role === 'union_lead'
                                  ? { background: 'rgba(245,166,35,0.15)', color: '#F5A623' }
                                  : undefined
                              }
                            >
                              {admin.role}
                            </span>
                          </td>
                          <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {timeAgo(admin.created_at)}
                          </td>
                          {isLead && (
                            <td>
                              {admin.role !== 'union_lead' && (
                                <button
                                  className="admin-btn admin-btn-danger admin-btn-sm"
                                  disabled={processing}
                                  onClick={async () => {
                                    if (
                                      !(await confirmDialog({
                                        title: 'Remove Admin',
                                        message: 'Remove this admin?',
                                        confirmText: 'Remove',
                                        variant: 'danger',
                                      }))
                                    )
                                      return;
                                    setProcessing(true);
                                    setError(null);
                                    try {
                                      // UNION AUDIT FIX 2026-07-21: RLS-blocked
                                      // direct delete -> manage-union remove_admin.
                                      await unionApi.removeAdmin(unionId!, admin.user_id);
                                      masterBus.emit('CLUB_UPDATED', { clubId: unionId || '' });
                                      setSuccess('Admin removed');
                                      loadDashboard(unionId);
                                    } catch (err: any) {
                                      setError(safeErrorMessage(err));
                                    } finally {
                                      setProcessing(false);
                                    }
                                  }}
                                >
                                  Remove
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Add Admin */}
                {isLead && (
                  <div style={{ marginTop: '16px' }}>
                    <label className="admin-label">Add Admin</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        className="admin-input"
                        value={adminSearch}
                        onChange={(e) => setAdminSearch(e.target.value)}
                        placeholder="Search By Username..."
                      />
                      <button
                        className="admin-btn admin-btn-ghost"
                        disabled={processing || adminSearch.length < 2}
                        onClick={async () => {
                          setProcessing(true);
                          setError(null);
                          try {
                            const { data: users } = await supabase
                              .from('profiles')
                              .select(`id, ${PLAYER_NAME_COLUMNS}`)
                              .ilike('username', `%${adminSearch}%`)
                              .limit(5);
                            setAdminResults(users || []);
                          } catch (err: any) {
                            setError(safeErrorMessage(err));
                          } finally {
                            setProcessing(false);
                          }
                        }}
                      >
                        Search
                      </button>
                    </div>
                    {adminResults.length > 0 && (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                          marginTop: '8px',
                        }}
                      >
                        {adminResults.map((u) => (
                          <div
                            key={u.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '8px 12px',
                              background: 'var(--bg-secondary)',
                              borderRadius: '8px',
                            }}
                          >
                            <span>{playerDisplayName(u)}</span>
                            <button
                              className="admin-btn admin-btn-success admin-btn-sm"
                              disabled={processing}
                              onClick={async () => {
                                setProcessing(true);
                                setError(null);
                                try {
                                  // UNION AUDIT FIX 2026-07-21: RLS-blocked direct
                                  // insert -> manage-union add_admin.
                                  await unionApi.addAdmin(unionId!, u.id);
                                  masterBus.emit('CLUB_UPDATED', { clubId: unionId || '' });
                                  setSuccess(`${playerDisplayName(u)} added as admin`);
                                  setAdminResults([]);
                                  setAdminSearch('');
                                  loadDashboard(unionId);
                                } catch (err: any) {
                                  setError(safeErrorMessage(err));
                                } finally {
                                  setProcessing(false);
                                }
                              }}
                            >
                              Add
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {walletModal && unionId && (
        <UnionWalletModal
          isOpen
          onClose={() => setWalletModal(null)}
          unionId={unionId}
          walletKey={walletModal.key}
          walletLabel={walletModal.label}
          balance={walletModal.balance}
          onSent={() => void loadDashboard(unionId)}
        />
      )}

      {treasuryModal && unionId && (
        <UnionTreasuryDetailModal
          isOpen
          onClose={() => setTreasuryModal(null)}
          unionId={unionId}
          mode={treasuryModal}
          // A backup-to-main or backup-to-promo move changes the pool row the
          // tiles read, so the dashboard must refetch or the numbers behind the
          // panel are stale the moment it closes.
          onMoved={() => void loadDashboard(unionId)}
          // Backup is jackpot liability owed to players. It has no
          // send-to-member flow, deliberately: the only ways out are the two
          // in-union destinations offered inside the panel.
          onSendFrom={
            treasuryModal === 'backup'
              ? undefined
              : () => {
                  const isRake = treasuryModal === 'rake';
                  setTreasuryModal(null);
                  setWalletModal({
                    key: isRake ? 'rake' : 'bbj',
                    label: isRake ? 'Rake Treasury' : 'BBJ Pool',
                    balance: isRake ? wallets?.rake_wallet || 0 : (bbjPool?.main_balance ?? 0),
                  });
                }
          }
        />
      )}
    </div>
  );
}

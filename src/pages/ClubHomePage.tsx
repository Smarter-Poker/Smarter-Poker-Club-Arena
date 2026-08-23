/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB HOME PAGE — Premium-Style Club Dashboard
 * ═══════════════════════════════════════════════════════════════════════════════
 * Main page after entering a club. Shows:
 * - Modified Club Arena header (No Search, Settings = Club Settings)
 * - Club card with avatar, name, ID, member count
 * - Wallet display (Gold + Diamond chips)
 * - Bad Beat Jackpot display
 * - Game type filters (ALL, Hold'em, Omaha, Mixed, MTT, SNG)
 * - "Create New Table" button for club owners
 * - Active tables/games grid
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { ClubRole } from '../types/clubRoles';
import { isClubStaff } from '../types/clubRoles';
import { MEDIA_BASE } from '../utils/mediaBase';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import haptic from '../services/HapticService';
import ClubBottomNav from '../components/club/ClubBottomNav';
import CreateTournamentModal from '../components/club/CreateTournamentModal';
/* LOBBY V2 (Dan 2026-08-22): the large card grid (DynamicGameCard) is replaced
   by the dense line-based LobbyTable + the CasinoPlaque game lobby panel.
   Selecting a row NEVER joins or spends; every commit action goes through the
   panel, which reuses the existing flows (navigate-to-table seat+buy-in,
   WaitlistService, TournamentService, spinQuickJoin). */
import LobbyTable, { type LobbyCategory } from '../components/lobby/LobbyTable';
import GameLobbyPanel from '../components/lobby/GameLobbyPanel';
import {
  cashEntry,
  tournamentEntry,
  classifyTournament,
  type LobbyEntry,
  type LobbyTournamentRow,
} from '../components/lobby/lobbyEntries';
import { tournamentService } from '../services/TournamentService';
import { getClubLevel, ClubLevelInfo } from '../utils/clubLevels';
import { fmtChips } from '../utils/format';
import { BusToastBridge } from '../components/common/BusToastBridge';
import { DiamondService } from '../services/DiamondService';
import { useToast } from '../components/common/Toast';
import { waitlistService } from '../services/WaitlistService';
import ConfirmModal from '../components/common/ConfirmModal';
import confirmDialog from '../components/common/confirmDialog';
import { retryFetch } from '../utils/retryFetch';
import './ClubHomePage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubIdFilter, resolveClubUUID } from '../utils/clubIdResolver';
import { useIsMounted } from '../hooks/useIsMounted';
import GlobalUXIndicators from '../components/common/GlobalUXIndicators';
import DynamicWallet from '../components/wallet/DynamicWallet';
import { PromoWalletCashierModal } from '../components/wallet';
import ClubBankCashierModal from '../components/wallet/ClubBankCashierModal';
import BBJInfoModal from '../components/bbj/BBJInfoModal';
import { reportError } from '../utils/errorReporter';
import { SHARK_CLUB_ID, QUERY_LIMITS } from '../lib/constants';
import { matchesVariant } from '../utils/tournamentFilters';
import { useUserStore } from '../stores/useUserStore';
import LobbyAdStrip from '../components/lobby/LobbyAdStrip';
import AdvancedFilters, {
  loadFilters,
  saveFilters,
  type FilterStore,
} from '../components/lobby/AdvancedFilters';
import {
  FILTER_SPECS,
  emptyFilterValue,
  rowPassesFilter,
  isFilterActive,
  type FilterGameType,
} from '../components/lobby/advancedFilterSpec';
import {
  IconTrophy,
  IconLeaderboard,
  IconMembers,
  IconShareLink,
  IconSearch,
  IconSort,
} from '../components/icons/LobbyIcons';
import { CLUB_HOME_CACHE_PREFIX } from '../utils/clearUserCaches';
import { useTournamentRegistration } from '../hooks/useTournamentRegistration';

// Shark Club fallback logo — used when DB logo_url is null
/* Dan 2026-08-20: "replace the old logo image with the new one". v25 was a
   wide CARD graphic being cropped into a square avatar slot, so most of the
   art was thrown away by object-fit. shark-club-logo.jpg is the square
   emblem and fills the box as intended. */
const SHARK_CLUB_FALLBACK_LOGO = `${MEDIA_BASE}images/shark-club-logo.jpg`;

// SWR cache helpers for instant club data display.
//
// PERF PASS 2026-08-22 (handoff item 7): moved from sessionStorage to
// localStorage. sessionStorage dies with the tab, so the one load that
// matters most — a returning player cold-opening their club — always sat
// on the skeleton while the heaviest screen in the app fetched from zero.
// localStorage gives that visit the same instant paint the in-session
// revisits already had; loadClubData still revalidates immediately after.
// Only public club metadata and the table list are cached — never wallet,
// role, or member data. Entries carry their own timestamp because the
// staleCacheReaper only sweeps sessionStorage: reads ignore anything older
// than the TTL, and a quota failure drops every club-home entry and retries
// once, so the cache can never wedge itself full.
const CLUB_HOME_CACHE_VER = 'v2';
const CLUB_HOME_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getClubHomeCache(clubId: string) {
  try {
    const raw =
      localStorage.getItem(`${CLUB_HOME_CACHE_PREFIX}${CLUB_HOME_CACHE_VER}_${clubId}`) ??
      // Pre-v2 entries (unwrapped, sessionStorage) still hydrate one last
      // time during the transition; the next write lands in localStorage.
      sessionStorage.getItem(`${CLUB_HOME_CACHE_PREFIX}${clubId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'at' in parsed && 'data' in parsed) {
      if (Date.now() - parsed.at > CLUB_HOME_CACHE_TTL_MS) return null;
      return parsed.data;
    }
    return parsed;
  } catch {
    return null;
  }
}
function setClubHomeCache(clubId: string, data: { club: any; tables: any[] }) {
  const key = `${CLUB_HOME_CACHE_PREFIX}${CLUB_HOME_CACHE_VER}_${clubId}`;
  const value = JSON.stringify({ at: Date.now(), data });
  try {
    localStorage.setItem(key, value);
  } catch {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CLUB_HOME_CACHE_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable — instant paint is best-effort */
    }
  }
}

// Types
interface ClubData {
  id: string;
  club_id: number;
  name: string;
  slug?: string;
  description: string;
  avatar_url: string;
  logo_url?: string;
  member_count: number;
  online_count: number;
  owner_id: string;
  level: number;
  hierarchy_units_rounded_up: number;
  player_threshold_current: number;
  player_threshold_next: number;
  hierarchy_threshold_current: number;
  hierarchy_threshold_next: number;
  created_at: string;
  is_union: boolean;
}

interface TableData {
  id: string;
  name: string;
  game_variant: string;
  stakes: string;
  current_players: number;
  max_players: number;
  status: string;
  small_blind: number;
  big_blind: number;
  min_buy_in: number;
  max_buy_in: number;
  settings?: string;
}

interface TournamentData {
  id: string;
  name: string;
  game_type: string;
  buy_in_amount: number;
  buy_in_fee: number;
  guaranteed_prize: number | null;
  start_time: string;
  status: string;
  current_players: number;
  max_players: number;
  starting_chips: number;
  /**
   * Dan 2026-08-19: late-registration state is derived from these, not from a
   * status string. No tournament has ever carried a 'LATE_REG' status, so the
   * Late Reg filter matched nothing at all until this was wired up.
   */
  late_reg_mins?: number | null;
  late_reg_levels?: number | null;
  started_at?: string | null;
  current_level?: number | null;
}

interface WalletBalances {
  gold: number;
  diamonds: number;
}

/**
 * ── GAME ACTION BAR (Dan 2026-08-20) ─────────────────────────────────────────
 *
 * The lobby used to filter through THREE stacked rows: a main tab
 * (ALL / CASH GAMES / TOURNAMENTS), then a variant row whose contents changed
 * depending on the tab, then a status row. Finding Omaha took two taps through
 * a control that rearranged itself between them, and the two rows appeared and
 * vanished as the tab changed, so the grid jumped up and down the page.
 *
 * One bar now lists every game type the platform runs, flat. Status is a
 * refinement of a chosen type, so that row appears only once a type is picked,
 * and ordering moved to an explicit sort control instead of being implied by
 * whichever tab happened to be selected.
 */
type GameType = 'ALL' | 'HOLDEM' | 'OMAHA' | 'LIMIT' | 'MIXED' | 'MTT' | 'SNG' | 'SPIN';
type SortKey = 'recommended' | 'stakes_high' | 'stakes_low' | 'players' | 'starting_soon';
type TournVariant = 'ALL' | 'MTT' | 'Spin-It' | 'SN';
/* The CashSubFilter / TournamentSubFilter types went with the state they
   described (see the note further down). Status is one mechanism now:
   GameFilterValue.statuses, defined per game type in advancedFilterSpec. */

const CASH_TYPES: GameType[] = ['HOLDEM', 'OMAHA', 'LIMIT', 'MIXED'];
const TOURNAMENT_TYPES: GameType[] = ['MTT', 'SNG', 'SPIN'];

/**
 * Dan 2026-08-20: "remove Mixed games from the action bar."
 *
 * MIXED stays in the GameType union and in cashKind, because it is still the
 * bucket every table that is neither Hold'em nor Omaha falls into — dropping
 * the type would make those tables unclassifiable. It just has no tab of its
 * own any more, so they surface under All, which is where a player browsing
 * everything expects to find them.
 */
const GAME_TYPE_TABS: { key: GameType; label: string }[] = [
  /* LOBBY V2: All Games is a real tab now — the line-based table renders a
     combined column set for it, so it no longer needs to be hidden. */
  { key: 'ALL', label: 'ALL' },
  { key: 'MTT', label: 'MTT' },
  { key: 'HOLDEM', label: 'NLH' },
  { key: 'OMAHA', label: 'PLO' },
  { key: 'LIMIT', label: 'LIMIT' },
  { key: 'SPIN', label: 'SPINS' },
  { key: 'SNG', label: 'HEADS UP' },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'stakes_high', label: 'Stakes: High To Low' },
  { key: 'stakes_low', label: 'Stakes: Low To High' },
  { key: 'players', label: 'Most Players' },
  { key: 'starting_soon', label: 'Starting Time' },
];

/** Which tournament tab a GameType maps onto, for the shared variant matcher. */
const TOURN_VARIANT_FOR: Partial<Record<GameType, TournVariant>> = {
  MTT: 'MTT',
  SNG: 'SN',
  SPIN: 'Spin-It',
};

/** Classify a cash table into the bar's three cash types. */
function cashKind(t: { game_variant?: string }): 'HOLDEM' | 'OMAHA' | 'LIMIT' | 'MIXED' {
  const v = (t.game_variant || '').toLowerCase();
  // 'short' is Short Deck, which is a Hold'em variant — it belongs with NLH,
  // not in the Mixed bucket where an unlisted string falls.
  if (v.includes('flh') || (v.includes('limit') && !v.includes('no') && !v.includes('pot')))
    return 'LIMIT';
  if (v.includes('nlh') || v.includes('holdem') || v.includes("hold'em") || v.includes('short'))
    return 'HOLDEM';
  if (v.includes('plo') || v.includes('omaha')) return 'OMAHA';
  return 'MIXED';
}

// ── Lobby ordering (used by the ALL view): Hold'em → Omaha → Limit → Mixed for cash ──
function cashRank(t: { game_variant?: string }): number {
  const kind = cashKind(t);
  return kind === 'HOLDEM' ? 0 : kind === 'OMAHA' ? 1 : kind === 'LIMIT' ? 2 : 3;
}
// Tournaments open for registration (or not past late-reg) come first, soonest first.
function tournamentOpenFirst(
  a: { status?: string; start_time: string },
  b: { status?: string; start_time: string }
): number {
  const rank = (s?: string) => {
    const u = (s || '').toUpperCase();
    if (
      ['REGISTERING', 'OPEN', 'PENDING', 'ANNOUNCED', 'LATE_REG', 'LATE_REGISTRATION'].includes(u)
    )
      return 0;
    if (u === 'RUNNING' || u === 'IN_PROGRESS') return 1;
    return 2;
  };
  const r = rank(a.status) - rank(b.status);
  if (r !== 0) return r;
  return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
}

/**
 * Dan 2026-08-19: `clubIdOverride` lets the club lobby render OUTSIDE its own
 * route — specifically inside a Club Arena lobby tab after a player leaves a
 * table. Without it this page could only read clubId from useParams, so the
 * in-tab lobby fell back to the pre-lobby landing page instead of the actual
 * club lobby the player came from.
 */
export default function ClubHomePage({ clubIdOverride }: { clubIdOverride?: string } = {}) {
  const { register: registerMtt, isRegistering: isRegisteringMtt } = useTournamentRegistration();

  const { clubId: routeClubId } = useParams<{ clubId: string }>();
  const clubId = clubIdOverride || routeClubId;
  useVisibilityRefresh(() => loadClubData());
  const navigate = useNavigate();
  const isMountedRef = useIsMounted();

  // Refs to avoid stale closures in realtime subscriptions
  const clubIdRef = useRef(clubId);

  const [club, setClub] = useState<ClubData | null>(null);
  const [tables, setTables] = useState<TableData[]>([]);
  const [tournaments, setTournaments] = useState<TournamentData[]>([]);
  const [wallet, setWallet] = useState<WalletBalances>({ gold: 0, diamonds: 0 });
  const [jackpotAmount, setJackpotAmount] = useState(0);
  // BBJ-TICKER 2026-08-18: the resolved BBJ scope for the lobby ticker.
  // (jackpotAmount was live-subscribed but rendered NOWHERE before this —
  // the realtime feed fed a value no player could see.)
  const [bbjScope, setBbjScope] = useState<{ clubUuid: string | null; unionId: string | null }>({
    clubUuid: null,
    unionId: null,
  });
  // Tapping the lobby jackpot opens the SAME view as tapping it at a table:
  // last 5 hits, qualifying hands per game, payout % per stakes (Dan 2026-08-18).
  const [bbjPoolId, setBbjPoolId] = useState<string | null>(null);
  const [showBBJInfo, setShowBBJInfo] = useState(false);
  // Dan 2026-08-23: the Club Bank row opens the Club Bank Cashier - send outs
  // to agent wallets, the full chip ledger, and (standalone clubs only) the
  // Chip Mint, which used to be a "+" on the wallet panel itself.
  const [showClubBank, setShowClubBank] = useState(false);
  const [showPromoWallet, setShowPromoWallet] = useState(false);
  /* LOBBY V2 follow-up (Dan's QA, 2026-08-22): the lobby landed on the MTT
     tab, a leftover from before All Games was a real tab. A club with no open
     MTTs therefore opened onto an empty screen blaming "filters" - every
     single visit. All Games is the landing view of a dense lobby. */
  const [gameType, setGameType] = useState<GameType>('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('starting_soon');
  const [sortOpen, setSortOpen] = useState(false);
  /* Advanced Filters (Dan 2026-08-20). Loaded lazily from localStorage on
     first render so a returning player's preferences apply to the FIRST
     paint of the lobby rather than flashing an unfiltered list first. */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [advFilters, setAdvFilters] = useState<FilterStore>({});
  // Dan 2026-08-21: the header search icon was wired to `setSortOpen(false)` —
  // a literal no-op. It now toggles a real search box that filters both the
  // cash tables and the tournament cards by name.
  const [searchQuery, setSearchQuery] = useState('');
  // LOBBY V2: show only starred cash tables. Declared here (not with the rest
  // of the V2 state) because `narrowing` and `clearAllNarrowing` read it.
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [isEditingNotice, setIsEditingNotice] = useState(false);
  const [noticeDraft, setNoticeDraft] = useState('');
  // Status defaults are 'all' on BOTH axes now. They used to be 'live' and
  // 'running', which was invisible: picking a game type silently hid every
  // empty table and every tournament still taking registrations, so a club
  // with 30 open games could look empty the moment a player filtered. A filter
  // the player did not choose must not remove rows.
  /* AUDIT 2026-08-21: cashSubFilter / tournamentSubFilter are GONE.
     The quick-preference chips used to drive them; they now write
     `statuses` on the saved filter, which is the same mechanism the Advanced
     Filters sheet uses. Keeping both meant two status systems on one screen,
     and after the quick row was rewired the setters were never called at all -
     the state sat permanently on its default while the filter code below still
     branched on it. One mechanism, no dead state. */
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<ClubRole>('player');
  const [deletingTableId, setDeletingTableId] = useState<string | null>(null);
  const [isInUnion, setIsInUnion] = useState(false);
  /** Live seat count from get_club_home. Null until it answers; see the note
      where it is set - the stale clubs.online_count is never used. */
  const [playersPlaying, setPlayersPlaying] = useState<number | null>(null);
  const [unionIdForCreate, setUnionIdForCreate] = useState<string | undefined>(undefined);
  const [showCreateTournament, setShowCreateTournament] = useState(false);
  const [clubLevel, setClubLevel] = useState<ClubLevelInfo | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const toast = useToast();
  const hasDataRef = useRef(false);
  const loadingRef = useRef(false);
  const [wsConnected, setWsConnected] = useState(true);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  // React Router reuses the component when only the clubId param changes.
  useEffect(() => {
    setIsOwner(false);
    setUserRole('player');
    setIsInUnion(false);
    setDeletingTableId(null);
    setDeleteTableConfirm({ show: false, tableId: null, tableName: null });
    setClubLevel(null);
    setWallet({ gold: 0, diamonds: 0 });
    setJackpotAmount(0);
    loadingRef.current = false;
    hasDataRef.current = false;
  }, [clubId]);

  // ── Watchdog: a hung fetch must never strand the skeleton forever ──
  // Dan 2026-08-20 (real-browser E2E finding): entering a club intermittently
  // sat on the loading skeleton for 60s+ — a supabase fetch in loadClubData
  // stalled without resolving OR rejecting, so the finally{} that clears
  // `loading` never ran. Classic house bug shape: silent hang, no error, no
  // retry path. If the load is still pending after 15s, report it, unstick
  // the dedup ref so a retry can actually run, and drop `loading` — with no
  // club data that renders the existing "Club Not Found / Retry" panel; with
  // cached data it simply ends a background refresh that was going nowhere.
  const [loadStalled, setLoadStalled] = useState(false);
  /** Why the club read came back empty, shown on the error panel (2026-08-23). */
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  useEffect(() => {
    if (!loading) return;
    const watchdog = setTimeout(() => {
      reportError(
        new Error('club home initial load exceeded 15s (stalled fetch)'),
        'ClubHomePage.load_watchdog_timeout'
      );
      loadingRef.current = false;
      setLoadStalled(true);
      setLoading(false);
    }, 15000);
    return () => clearTimeout(watchdog);
  }, [loading]);

  // Any successful club load clears the stall state, so a slow-but-working
  // connection that finishes after the watchdog fired snaps back to normal.
  useEffect(() => {
    if (club) setLoadStalled(false);
  }, [club]);

  // SWR: show cached club data instantly on mount
  useEffect(() => {
    if (!clubId) return;
    const cached = getClubHomeCache(clubId);
    if (cached && cached.club) {
      setClub(cached.club);
      if (cached.tables?.length) setTables(cached.tables);
      hasDataRef.current = true;
      setLoading(false);
    }
  }, [clubId]);

  // Confirm modal state for table deletion
  const [deleteTableConfirm, setDeleteTableConfirm] = useState<{
    show: boolean;
    tableId: string | null;
    tableName: string | null;
  }>({ show: false, tableId: null, tableName: null });

  // Confirm modal state for table deletion

  useEffect(() => {
    if (clubId) {
      clubIdRef.current = clubId;
      let isMounted = true;
      loadClubData(() => isMounted);
      return () => {
        isMounted = false;
      };
    }
  }, [clubId]);

  // ── Realtime subscription: live table updates (player counts, status) ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      // UNION LAW (Dan 2026-08-20): remember the club the player entered
      // through. Buy-ins draw chips from THIS club and rake is earned for it,
      // so the club context must survive the hop into a union table.
      try {
        useUserStore.getState().setCurrentClub(resolvedId);
      } catch {
        /* non-fatal */
      }
      if (!isMounted) return;

      // Check if this club is in a union — if so, listen on union_id in addition to club_id
      let unionId: string | null = null;
      try {
        const { data: ucCheck } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (ucCheck?.union_id) {
          unionId = ucCheck.union_id;
        }
        if (isMounted) setBbjScope({ clubUuid: resolvedId, unionId });
      } catch (e) {
        reportError(e, 'ClubHomePage.setupRealtime');
        /* standalone club — no union_id */
      }

      if (!isMounted) return;

      const channelKey = `club-tables-${clubId}`;
      let channel = masterBus.getOrCreateChannel(channelKey);

      // Realtime admission rules — these MUST mirror the fetch queries below
      // (the cash-table query and the tournament queries). Realtime `filter:`
      // only supports single-column equality, so anything more expressive than
      // that has to be re-checked here or the live list and the fetched list
      // diverge until the next reload.
      const belongsInTableList = (row: any): boolean => {
        if (!row) return false;
        if (row.tournament_id) return false; // tournament sub-table, not a cash game
        if (row.is_deleted === true) return false;
        if (row.status === 'closed' || row.status === 'deleted') return false;
        if (unionId) {
          // Union club: the union's tables, plus THIS club's own private games.
          if (row.union_id === unionId) return true;
          return row.club_id === resolvedId && row.is_private === true;
        }
        return true;
      };

      const JOINABLE_TOURNAMENT_STATUS = ['REGISTERING', 'RUNNING'];
      const belongsInTournamentList = (row: any): boolean => {
        if (!row) return false;
        if (!JOINABLE_TOURNAMENT_STATUS.includes(String(row.status))) return false;
        if (unionId) {
          // Union club: union-owned tournaments, plus this club's own private ones.
          if (row.union_id === unionId) return true;
          return row.club_id === resolvedId && row.is_private === true;
        }
        return true;
      };

      const handleTableChange = (payload: any) => {
        if (!isMounted) return;
        if (payload.eventType === 'UPDATE' && payload.new) {
          const updated = payload.new as any;
          // P2-2: closeTable/deleteTable flip status='closed'/'deleted' or
          // is_deleted=true and arrive here as UPDATE events. Merging kept the
          // row as a clickable card (filteredTables doesn't exclude by status),
          // so drop it from the list instead of merging when it goes dead.
          if (
            updated.is_deleted === true ||
            updated.status === 'closed' ||
            updated.status === 'deleted'
          ) {
            setTables((prev) => prev.filter((t) => t.id !== updated.id));
          } else {
            setTables((prev) => prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)));
          }
        } else if (payload.eventType === 'INSERT' && payload.new) {
          // 2026-08-19: the INSERT branch checked nothing, so rows the fetch
          // deliberately excludes appeared live and stayed until a reload —
          // tournament sub-tables shown as joinable cash games, and (for a
          // union club) the club's own NON-private tables, which this lobby
          // must not list. Realtime `filter:` is single-column equality and
          // cannot express that rule, so it is enforced here instead.
          if (!belongsInTableList(payload.new)) return;
          setTables((prev) => {
            if (prev.some((t) => t.id === payload.new.id)) return prev;
            return [payload.new as any, ...prev];
          });
        } else if (payload.eventType === 'DELETE' && payload.old) {
          setTables((prev) => prev.filter((t) => t.id !== (payload.old as any).id));
        }
      };

      const handleTournamentChange = (payload: any) => {
        if (!isMounted) return;
        if (payload.eventType === 'UPDATE' && payload.new) {
          const updated = payload.new as any;
          // A tournament leaving a joinable state (CANCELLED/COMPLETED) used to
          // be merged and left on screen as a clickable card — re-opening the
          // silent-join bug live, without a refresh. Drop it instead, mirroring
          // the table handler.
          if (!belongsInTournamentList(updated)) {
            setTournaments((prev) => prev.filter((t) => t.id !== updated.id));
          } else {
            setTournaments((prev) =>
              prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t))
            );
          }
        } else if (payload.eventType === 'INSERT' && payload.new) {
          if (!belongsInTournamentList(payload.new)) return;
          setTournaments((prev) => {
            if (prev.some((t) => t.id === payload.new.id)) return prev;
            return [payload.new as any, ...prev];
          });
        } else if (payload.eventType === 'DELETE' && payload.old) {
          setTournaments((prev) => prev.filter((t) => t.id !== (payload.old as any).id));
        }
      };

      // 1. Subscribe to Club Tables
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tables', filter: `club_id=eq.${resolvedId}` },
        handleTableChange
      );

      // 2. Subscribe to Club Tournaments
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournaments', filter: `club_id=eq.${resolvedId}` },
        handleTournamentChange
      );

      // 3. Dual-Channel: Subscribe to Union Tables and Tournaments if applicable
      if (unionId) {
        channel = channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'tables', filter: `union_id=eq.${unionId}` },
          handleTableChange
        );
        channel = channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'tournaments', filter: `union_id=eq.${unionId}` },
          handleTournamentChange
        );
      }

      // 4. Live BBJ — subscribe to the CORRECT bbj_pools row (union pool for union
      // clubs, else club pool) so the header jackpot ticks up in real time as rake
      // funds it, instead of showing a value frozen at fetch time.
      const handleBBJChange = (payload: any) => {
        if (!isMounted) return;
        const row = (payload?.new ?? payload?.old) as
          | { main_balance?: number | string }
          | undefined;
        // main_balance is numeric(14,2), and PostgREST/Realtime deliver
        // numerics as STRINGS ("350.40"). The old guard was
        // `typeof row.main_balance === 'number'`, which is therefore NEVER
        // true - every live tick was silently dropped and the banner only
        // ever showed the value fetched at mount. Coerce first, then check.
        const next = Number(row?.main_balance);
        if (Number.isFinite(next)) setJackpotAmount(next);
      };
      channel = channel.on(
        'postgres_changes',
        unionId
          ? { event: '*', schema: 'public', table: 'bbj_pools', filter: `union_id=eq.${unionId}` }
          : {
              event: '*',
              schema: 'public',
              table: 'bbj_pools',
              filter: `club_id=eq.${resolvedId}`,
            },
        handleBBJChange
      );

      channel.subscribe((status: string, err?: Error) => {
        setWsConnected(status === 'SUBSCRIBED');
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'ClubHomePage._Tables_RT_channel_error');
        } else if (status === 'TIMED_OUT') {
          console.warn('[ClubHomePage] Tables RT channel timed out');
        }
      });
    };

    setupRealtime().catch((e) => console.warn('[ClubHomePage] Table realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(`club-tables-${clubId}`);
    };
  }, [clubId]);

  // ── Realtime subscription: club member count updates ──
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);

  // ── SPIN QUICK-JOIN (Dan 2026-08-20: "there is 'no lobby' for a spin, you
  // just start on a table") ──────────────────────────────────────────────────
  // Tap a spin tile -> register (hopping to an open sibling spin of the same
  // buy-in if this one is full or closed) -> the engine starts the game the
  // moment the held seat is taken (start-when-full, 5s discovery) -> poll for
  // our seat -> land on the table. The overlay covers the wait; Cancel backs
  // out of the WAIT (the registration stands — the game still starts).
  const [spinJoin, setSpinJoin] = useState<{ name: string; stage: string } | null>(null);
  const spinJoinCancelRef = useRef(false);

  const spinQuickJoin = useCallback(
    async (
      t: { id: string; name: string; buy_in_amount: number },
      variant: 'spin' | 'sng' = 'spin'
    ) => {
      if (spinJoin) return; // one join at a time
      spinJoinCancelRef.current = false;
      setSpinJoin({ name: t.name, stage: 'Opening The Table' });
      const fail = (msg: string) => {
        setSpinJoin(null);
        toast?.error?.(msg);
      };
      try {
        const { data: authData } = await getAuthUser();
        const uid = authData?.user?.id;
        if (!uid) return fail('Sign In To Play');

        // ── SEAT-FIRST (Dan 2026-08-21) ──────────────────────────────────
        // "A PLAYER SITS DOWN AT A TABLE AND BUYS INTO THE SPIN OR HEADS UP,
        // LIKE A CASH GAME." So a tile does NOT register anybody. It opens
        // the TABLE, where the seats are visible and one tap buys the seat
        // the player chose. Registering here instead would put them in the
        // game without a seat — the MTT shape Dan is replacing.
        const { data: tbls } = await supabase
          .from('tables')
          .select('id, status')
          .eq('tournament_id', t.id)
          .neq('status', 'closed')
          .limit(3);
        const tableId = (tbls || [])[0]?.id;
        if (tableId) {
          setSpinJoin(null);
          navigate(`/table/${tableId}`);
          return;
        }

        // No table yet: a game created before seat-first shipped, or one
        // whose table has closed. Fall back to the old registration path so
        // those legacy rows stay playable, then land on their table.
        setSpinJoin({ name: t.name, stage: 'Reserving Your Seat' });
        const { data: regData, error: regErr } = await supabase.rpc('fn_register_for_tournament', {
          p_tournament_id: t.id,
        });
        const reg = regData as { ok?: boolean; reason?: string } | null;
        const reason = regErr?.message || (reg?.ok === false ? reg.reason : null);
        if (reason && reason !== 'already_registered') {
          return fail(
            /insufficient/i.test(reason)
              ? 'Not Enough Chips For This Buy In'
              : variant === 'sng'
                ? 'Could Not Join The Sit N Go, Please Try Again'
                : 'Could Not Join The Spin, Please Try Again'
          );
        }
        setSpinJoin((prev) => (prev ? { ...prev, stage: 'Dealing You In' } : prev));
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          if (spinJoinCancelRef.current) return;
          const { data: t2 } = await supabase
            .from('tables')
            .select('id')
            .eq('tournament_id', t.id)
            .neq('status', 'closed')
            .limit(3);
          const ids = (t2 || []).map((x) => x.id);
          if (ids.length > 0) {
            const { data: seat } = await supabase
              .from('table_seats')
              .select('table_id')
              .in('table_id', ids)
              .eq('user_id', uid)
              .is('left_at', null)
              .limit(1)
              .maybeSingle();
            if (seat?.table_id) {
              setSpinJoin(null);
              navigate(`/table/${seat.table_id}`);
              return;
            }
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        setSpinJoin(null);
        toast?.info?.('Your Game Is Filling, It Will Start Momentarily');
        navigate(`/tournaments/${t.id}`);
      } catch (err: unknown) {
        reportError?.(err as Error, 'ClubHomePage.spinQuickJoin');
        fail('Could Not Open That Game, Please Try Again');
      }
    },
    [spinJoin, navigate, toast]
  );

  useEffect(() => {
    if (!clubId) {
      setResolvedClubId(null);
      return;
    }
    resolveClubUUID(clubId)
      .then(setResolvedClubId)
      .catch((e) => console.warn('[ClubHomePage] Failed to resolve clubId:', e));
  }, [clubId]);

  /* Saved Advanced Filters are keyed per club, so they can only be read once
     the UUID is known. Re-runs on a club switch: one club's "Bomb Pot only"
     must never silently apply to another club's lobby. */
  useEffect(() => {
    if (!resolvedClubId) {
      setAdvFilters({});
      return;
    }
    setAdvFilters(loadFilters(resolvedClubId));
  }, [resolvedClubId]);

  const handleMemberUpdate = useCallback(() => {
    loadClubData();
  }, []);

  useMasterBusChannel({
    channelName: clubId ? `club-members-${clubId}` : null,
    table: 'club_members',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: handleMemberUpdate,
    enabled: !!resolvedClubId,
  });

  // ── Bus Listeners: cross-page event reactivity (subscribeDebounced) ──
  useEffect(() => {
    let isMounted = true;
    const reload = () => {
      if (isMounted) loadClubData(() => isMounted);
    };

    const unsubs = [
      masterBus.subscribeDebounced('CLUB_JOINED', reload, 300),
      masterBus.subscribeDebounced('CLUB_LEFT', reload, 300),
      masterBus.subscribeDebounced('BALANCE_UPDATED', reload, 300),
      masterBus.subscribeDebounced('DIAMOND_BALANCE_CHANGED', reload, 300),
      masterBus.subscribeDebounced('ANNOUNCEMENT_CHANGED', reload, 300),
      // Phase 11: Only reload for OUR club's updates (not every club in the platform)
      masterBus.subscribeDebounced(
        'CLUB_UPDATED',
        (event) => {
          if (!clubIdRef.current || event.payload?.clubId === clubIdRef.current) {
            reload();
          }
        },
        300
      ),
      masterBus.subscribeDebounced(
        'CLUB_SETTINGS_UPDATED',
        (event) => {
          if (!clubIdRef.current || event.payload?.clubId === clubIdRef.current) {
            reload();
          }
        },
        300
      ),
      masterBus.subscribeDebounced('WAITLIST_PROMOTED', reload, 300),
    ];

    // 1-minute fallback interval to ensure the page data doesn't get completely stale
    // when real-time events are missed.
    const fallbackInterval = setInterval(() => {
      reload();
    }, 60_000);

    return () => {
      isMounted = false;
      clearInterval(fallbackInterval);
      unsubs.forEach((u) => u());
    };
  }, []);

  const loadClubData = async (getIsMounted?: () => boolean) => {
    if (!clubId) return;
    // Request deduplication — skip if already loading
    if (loadingRef.current) return;
    loadingRef.current = true;
    // Only show loading spinner on initial load (no cached data), not background refreshes
    if (!hasDataRef.current && (!getIsMounted || getIsMounted())) setLoading(true);

    try {
      if (getIsMounted && !getIsMounted()) return;

      // Load club info — smart resolve: clubId may be UUID or integer club_id
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId);
      const { data: clubData, error: clubError } = await retryFetch(
        () =>
          supabase
            .from('clubs')
            .select(
              'id, club_id, name, slug, description, avatar_url, logo_url, member_count, online_count, owner_id, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next, created_at, is_union, union_id'
            )
            .eq(clubCol, clubVal)
            .maybeSingle()
            .then((r) => r),
        { maxRetries: 2, isMountedRef }
      );

      if (clubError || !clubData) {
        reportError(clubError, 'ClubHomePage.Failed_to_load_club');
        toast.error('Failed to load club details');
        /* Dan 2026-08-23 reported this panel appearing every time on his phone,
           and it could not be reproduced from a clean session on any of his
           three clubs, by either entry path. The reason is that this state
           throws away the only fact that matters: WHY the read came back
           empty. A refused row (RLS), a malformed id (PostgREST 400) and a
           dropped connection all render the identical "moved or deleted"
           sentence, which is also a lie in two of those three cases.
           Keep the cause so the panel can show it and the next report carries
           its own diagnosis. */
        if (!getIsMounted || getIsMounted()) {
          setLoadFailure(
            clubError
              ? `${clubError.code ? clubError.code + ': ' : ''}${clubError.message || 'request failed'}`
              : `no club matched ${String(clubId).slice(0, 40)}`
          );
          setLoading(false);
        }
        return;
      }

      if (getIsMounted && !getIsMounted()) return;
      setClub(clubData);

      // ── ONE ROUND TRIP FOR THE WHOLE VISIBLE LOBBY ────────────────────────
      //
      // PERF 2026-08-23. Painting this page took SIX sequential round trips:
      // club row, membership+wallet, union row, union club ids, member count,
      // then finally tables+tournaments+BBJ. Measured against production the
      // queries cost ~9ms server-side; the wait is network latency, 150-250ms
      // per trip wired and 250-400ms on mobile - 1-1.5s, or 2-3s on a phone,
      // of watching a skeleton.
      //
      // public.get_club_home() returns all of it in ONE call (38ms measured on
      // the largest club: 1,172 members, 42 tables). It is SECURITY INVOKER,
      // so every RLS policy still applies and it can return only what this
      // browser could already fetch for itself - a latency fix, not a
      // permissions change.
      //
      // It runs ALONGSIDE the existing chain rather than replacing it: the
      // chain below still fills in diamonds, club level, XMTT tournaments and
      // the rest, and remains authoritative. This just gets the tables on
      // screen five round trips earlier. `lobbyPainted` guarantees the fast
      // path can only ever paint BEFORE the authoritative data, never over it.
      let lobbyPainted = false;
      Promise.resolve(supabase.rpc('get_club_home', { p_club_key: clubId }))
        .then(({ data: home, error: homeErr }) => {
          if (homeErr || !home || home.found !== true) return;

          /**
           * PLAYERS CURRENTLY PLAYING (Dan, 2026-08-23): "the 0 players
           * currently playing is a bug... every horse needs to be considered a
           * current player, this an accumulation of all active players in all
           * clubs total."
           *
           * clubs.online_count is a denormalised column nothing keeps current
           * - it read 12 for JAQK and 0 for Shark and Midway while 579 seats
           * were occupied. get_club_home counts the live seats themselves,
           * horses included, across the whole platform.
           *
           * SET BEFORE THE lobbyPainted GUARD, deliberately. That guard exists
           * to stop a stale SNAPSHOT OF THE LISTS painting over fresher rows;
           * this number is not in the lists and has no fresher writer. Behind
           * the guard it was skipped on every warm load where the chain won
           * the race, and the header fell back to the stale 12 - which is
           * precisely the flapping being fixed here.
           */
          if (typeof home.players_playing === 'number') {
            setPlayersPlaying(home.players_playing);
          }

          if (lobbyPainted) return; // the real chain already answered
          if (getIsMounted && !getIsMounted()) return;
          lobbyPainted = true;
          try {
            if (home.club) {
              setClub((prev) => ({
                ...(prev || {}),
                ...home.club,
                member_count: home.member_count ?? home.club.member_count,
              }));
            }
            if (Array.isArray(home.tables)) setTables(home.tables);
            if (Array.isArray(home.tournaments)) setTournaments(home.tournaments);
            if (home.union_id) {
              setIsInUnion(true);
              setUnionIdForCreate(home.union_id);
            }
            if (home.membership) {
              setUserRole((home.membership.role as ClubRole) || 'player');
            }
            const bal = Number(home.bbj?.main_balance);
            if (Number.isFinite(bal)) setJackpotAmount(bal);
            if (home.bbj?.id) setBbjPoolId(home.bbj.id);
            hasDataRef.current = true;
            setLoading(false);
          } catch (e) {
            reportError(e, 'ClubHomePage.fastPath');
          }
        })
        .catch(() => {
          // Best effort only. The authoritative chain below is untouched, so a
          // failure here costs the speed-up and nothing else.
        });

      // Use resolved UUID for all downstream FK queries
      const resolvedId = clubData.id;

      // ── START THE resolvedId-ONLY QUERIES NOW, AWAIT THEM WHERE THEY WERE ──
      //
      // PERF 2026-08-23. Getting the table list on screen took SIX sequential
      // round trips after the club row: member+diamonds, union row, union
      // clubs, member count, live count, then finally tables. Measured against
      // production the queries themselves are ~9ms; the wait is almost
      // entirely network latency, ~150-250ms per trip wired and 250-400ms on
      // mobile. That is 1-1.5s wired and 2-3s on mobile of pure waiting, more
      // than every remaining byte on the boot path combined.
      //
      // Neither of these two depends on the auth/membership chain they were
      // queued behind - both need only resolvedId - so they are started here
      // and awaited unchanged below. Nothing about the order of state updates
      // moves; only the network overlaps.
      //
      // The rejection handlers matter: a hoisted promise that rejects before
      // its await would otherwise surface as an unhandled rejection. Shaping
      // the failure as { data|count: null, error } keeps the existing
      // fail-open handling at each await site exactly as it was.
      const unionRowPromise = supabase
        .from('union_clubs')
        .select('union_id')
        .eq('club_id', resolvedId)
        .limit(1)
        .maybeSingle()
        .then(
          (r) => r,
          (error) => ({ data: null, error })
        );

      // Standalone clubs need a live member count (clubs.member_count is
      // denormalised and goes stale). Union clubs ignore it - one cheap
      // indexed count is a better trade than a whole round trip in series.
      const liveMemberCountPromise = supabase
        .from('club_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('club_id', resolvedId)
        .in('status', ['active', 'approved'])
        .then(
          (r) => r,
          (error) => ({ count: null, error })
        );

      // Check if current user is owner
      const {
        data: { user: authUser },
      } = await getAuthUser();
      if (authUser) {
        if (getIsMounted && !getIsMounted()) return;
        setCurrentUserId(authUser.id);
        setIsOwner(clubData.owner_id === authUser.id);

        // ── Batch: member data + diamond wallet in parallel ──
        const [memberResult, diamondWallet] = await Promise.all([
          supabase
            .from('club_members')
            .select('chip_balance, role')
            .eq('club_id', resolvedId)
            .eq('user_id', authUser.id)
            .maybeSingle(),
          DiamondService.getBalance(authUser.id),
        ]);

        if (memberResult.data) {
          if (getIsMounted && !getIsMounted()) return;
          setWallet({
            gold: memberResult.data.chip_balance || 0,
            diamonds: diamondWallet.balance || 0,
          });
          setUserRole(memberResult.data.role || 'member');
        }
      }

      /**
       * THE UNION -> CLUB CASCADE (rebuilt 2026-08-23)
       *
       * Dan: "the mtt, spins and heads up tournaments keep breaking and not
       * displaying correctly. Sometimes it displays, then it disappears."
       *
       * Everything below forks on `unionId`. With it, a union club lists its
       * own private games PLUS every union game (138 games, 35 of them MTTs).
       * Without it, the same club lists only what it owns - and a union club
       * owns almost nothing, so the MTT tab reads "Nothing Here On This Tab"
       * while 138 games are running one join away.
       *
       * That fork hung on ONE `union_clubs` read whose catch treated FAILURE
       * exactly like ABSENCE. A timeout, a 500, an RLS hiccup - any of them
       * silently demoted the club to standalone and emptied the lobby. The
       * database has been timing statements out under load all day, so this
       * fired often enough for Dan to watch the board appear and vanish.
       *
       * A club's union membership changes approximately never, so the answer
       * is resolved from three independent sources and only ever downgraded
       * on POSITIVE evidence of absence:
       *
       *   1. the union_clubs row          (authoritative)
       *   2. clubs.union_id               (already on the row we just fetched
       *                                    - no extra round trip)
       *   3. the last answer we cached    (survives a blip entirely)
       *
       * Standalone is concluded only when a query SUCCEEDS and returns
       * nothing, and nothing is cached. Anything else keeps the last known
       * good scope, because showing a union club its union is right far more
       * often than showing it an empty room.
       */
      const unionCacheKey = `ca_union_of_${resolvedId}`;
      const readCachedUnion = (): string | null => {
        try {
          return sessionStorage.getItem(unionCacheKey) || null;
        } catch {
          return null;
        }
      };
      const cacheUnion = (id: string | null) => {
        try {
          if (id) sessionStorage.setItem(unionCacheKey, id);
          else sessionStorage.removeItem(unionCacheKey);
        } catch {
          /* storage unavailable */
        }
      };

      // Check if this club is inside a union
      let unionId: string | null = null;
      let unionClubIds: string[] = [resolvedId];
      try {
        const { data: ucRow, error: ucErr } = await unionRowPromise;
        if (ucErr) {
          // FAILURE IS NOT ABSENCE. Fall back, in order, to the club row we
          // already hold and then to the last good answer.
          const fallback =
            (clubData as { union_id?: string | null } | null)?.union_id || readCachedUnion();
          if (fallback) {
            unionId = fallback;
            if (getIsMounted && !getIsMounted()) return;
            setIsInUnion(true);
            setUnionIdForCreate(fallback);
            // Deliberately NOT re-querying union_clubs for the sibling ids:
            // clubHomeWaterfall.test.ts forbids an inline read here and is
            // right to - that is how this page got its waterfall back last
            // time. unionClubIds only widens the CASH-table filter; the
            // tournament fork that empties the MTT tab keys on unionId alone.
            // A rare fallback showing club-scoped cash tables is a far smaller
            // wrong than an empty lobby.
          }
        }
        if (!ucErr && !ucRow) {
          // A clean answer of "no row" is still only half the story: the club
          // row itself may name a union (they are written by different paths).
          const fromClubRow = (clubData as { union_id?: string | null } | null)?.union_id || null;
          if (fromClubRow) {
            unionId = fromClubRow;
            if (getIsMounted && !getIsMounted()) return;
            setIsInUnion(true);
            setUnionIdForCreate(fromClubRow);
            // Same reasoning as the error branch above: no inline read here.
          } else {
            cacheUnion(null); // genuinely standalone, on positive evidence
          }
        }
        if (!ucErr && ucRow) {
          if (getIsMounted && !getIsMounted()) return;
          setIsInUnion(true);
          unionId = ucRow.union_id;
          setUnionIdForCreate(ucRow.union_id);
          // Remember it: the next load survives a timeout without emptying.
          cacheUnion(ucRow.union_id);

          // Get ALL club IDs in this union + member count in parallel
          const [allUcResult, memberCountResult] = await Promise.all([
            supabase.from('union_clubs').select('club_id').eq('union_id', unionId),
            supabase
              .from('club_members')
              .select('user_id', { count: 'exact', head: true })
              .eq('club_id', resolvedId) // Will be updated below if union has multiple clubs
              .in('status', ['active', 'approved']),
          ]);

          if (allUcResult.data && allUcResult.data.length > 0) {
            unionClubIds = allUcResult.data.map((r) => r.club_id);
          }

          /**
           * A CLUB'S MEMBER COUNT IS ITS OWN (Dan, 2026-08-23).
           *
           * "club jaqk doesn't have 1172 players" - and it does not: it has
           * 584. 1,172 was Club JAQK plus Shark Club, because a union club
           * used to be shown the whole union's membership. Shark then read
           * 1,172 as well, and the two clubs were indistinguishable.
           *
           * It also FLIPPED. Dan: "bounces back and forth from 1172 players to
           * 588." get_club_home answered with one number and this block with
           * the other, and whichever landed last won - the same two-writers,
           * one-rule shape as the lobby scope bug earlier today. There is one
           * rule now, stated in both places: count this club's members.
           *
           * The union-wide re-query that used to sit here was also AWAITED IN
           * SERIES, ahead of the tables and tournaments queries, so the games
           * waited on a number nobody wanted.
           */
          if (memberCountResult.count != null) {
            if (getIsMounted && !getIsMounted()) return;
            setClub((prev) =>
              prev ? { ...prev, member_count: memberCountResult.count as number } : prev
            );
          }
        }
      } catch (e) {
        reportError(e, 'ClubHomePage.setClub');
        // Query error — fail-open for standalone clubs
      }

      // ── Fix: Live member count for standalone clubs (not in a union) ──
      // Without this, standalone clubs display the stale clubs.member_count value
      if (!unionId) {
        try {
          const { count: liveCount } = await liveMemberCountPromise;

          if (liveCount != null && liveCount > 0) {
            if (getIsMounted && !getIsMounted()) return;
            setClub((prev) => (prev ? { ...prev, member_count: liveCount } : prev));
            // Also update clubData so the level calculation below uses the live count
            clubData.member_count = liveCount;
          }
        } catch (e) {
          reportError(e, 'ClubHomePage.setClub');
          // Fall back to denormalized clubs.member_count
        }
      }

      // ── Batch: tables + tournaments + BBJ in parallel ──
      // Build table query: use union_id for union clubs, club_id for standalone
      const tableQuery = supabase
        .from('tables')
        .select(
          'id, name, game_variant, stakes, current_players, max_players, status, small_blind, big_blind, min_buy_in, max_buy_in, settings, created_at'
        );
      if (unionId) {
        // Union governance (2026-08-19): union clubs see the UNION's tables
        // plus their OWN private club games. Other clubs' private games are
        // never visible here.
        tableQuery.or(`union_id.eq.${unionId},and(club_id.eq.${resolvedId},is_private.eq.true)`);
      } else {
        tableQuery.in('club_id', unionClubIds);
      }
      // P1-1: mirror TableService cash-lobby filters on BOTH branches (chained
      // on the shared builder). Without status/tournament filters and a limit,
      // this pulled tens of thousands of closed/tournament rows and buried the
      // real cash tables. Exclude closed + tournament tables and cap the result.
      tableQuery
        .eq('is_deleted', false)
        /* belongsInTableList (the realtime admission rule above) drops BOTH
           'closed' and 'deleted'. The fetch only dropped 'closed', so a
           status='deleted' row would load on first paint and then be refused
           by realtime - the two lists disagreeing, which is precisely what
           that rule exists to prevent. No such row exists today; this keeps
           it that way. */
        /* THE VALUE IS A POSTGREST GROUP, NOT A JS ARRAY (Dan 2026-08-23).
           `.not(col, 'in', value)` interpolates the value straight into
           `not.in.<value>`, so an array stringifies to `not.in.closed,deleted`
           and PostgREST answers PGRST100 -- "failed to parse filter". A 400
           here is total: the whole cash list comes back null, so EVERY club
           lobby, union or standalone, shows zero tables while dozens are
           running. Measured on production 2026-08-23 from Club JAQK: 400 with
           the array, 200 with 44 tables the moment the filter was rewritten.
           The group form below is what `.in()` builds for itself. */
        .not('status', 'in', '("closed","deleted")')
        .is('tournament_id', null)
        .order('created_at', { ascending: false })
        .limit(QUERY_LIMITS.LIST);

      // Union governance (2026-08-19): for union clubs the club-scoped query
      // returns ONLY the club's own PRIVATE tournaments; every union-visible
      // tournament comes from the union-scoped query below. Standalone clubs
      // keep the original club_id scoping.
      const clubTournamentQuery = supabase
        .from('tournaments')
        .select(
          'id, name, game_type, buy_in_amount, buy_in_fee, guaranteed_prize, start_time, status, current_players, max_players, starting_chips, club_id, variant, table_size, late_reg_mins, late_reg_levels, started_at, current_level'
        )
        // Joinable-only (Dan 2026-08-15, round 2 of the silent-join fix): the
        // COMPLETED-only exclusion let all 6,669 CANCELLED tournaments
        // through, and this page -- /clubs/:clubId, the one the featured
        // club card opens -- kept serving a cancelled April Sit&Go as a
        // joinable 6/6 card after TournamentService was fixed, because it
        // runs its own query rather than the service. Same rule as the
        // service now: a lobby lists what can be ENTERED.
        .in('status', ['REGISTERING', 'RUNNING', 'LATE_REG', 'STARTING_SOON'])
        .order('start_time', { ascending: true })
        /* The tables query has been capped since P1-1; these two were not
           capped at all. An unbounded list query is the shape that pulled
           tens of thousands of rows into this page once already. */
        .limit(QUERY_LIMITS.LIST);
      if (unionId) {
        clubTournamentQuery.eq('club_id', resolvedId).eq('is_private', true);
      } else {
        clubTournamentQuery.in('club_id', unionClubIds);
      }

      const [tableResult, clubTournamentResult, bbjResult, ...xmttResults] = await Promise.all([
        tableQuery,
        clubTournamentQuery,
        (async () => {
          try {
            // BUGFIX: resolve the CORRECT BBJ pool. Union clubs contribute to the
            // UNION pool (that's the one that grows); a club-level pool row may exist
            // but is stale. Fetch by union_id when in a union, else club_id.
            const q = supabase.from('bbj_pools').select('id, main_balance');
            if (unionId) {
              const allIds = [resolvedId, ...(unionClubIds || [])];
              const filter = `union_id.eq.${unionId},club_id.in.(${allIds.join(',')})`;
              return await q.or(filter);
            } else {
              return await q.eq('club_id', resolvedId).limit(1).maybeSingle();
            }
          } catch (e) {
            reportError(e, 'ClubHomePage.async');
            return { data: null, error: null };
          }
        })(),
        // Conditionally fetch XMTT tournaments if in a union
        ...(unionId
          ? [
              supabase
                .from('tournaments')
                .select(
                  'id, name, game_type, buy_in_amount, buy_in_fee, guaranteed_prize, start_time, status, current_players, max_players, starting_chips, club_id, union_id, variant, table_size, is_xmtt, late_reg_mins, late_reg_levels, started_at, current_level'
                )
                // Union governance (2026-08-19): ALL union-owned tournaments
                // (XMTT and union-stamped recurring games), not just XMTT.
                .eq('union_id', unionId)
                // Joinable-only -- same rule as the club query above.
                .in('status', ['REGISTERING', 'RUNNING', 'LATE_REG', 'STARTING_SOON'])
                .order('start_time', { ascending: true })
                .limit(QUERY_LIMITS.LIST),
            ]
          : []),
      ]);

      if (getIsMounted && !getIsMounted()) return;

      // From here the authoritative data is in hand; the fast path above must
      // not paint after this point (it would replace fresher rows with the
      // snapshot it fetched a moment earlier).
      lobbyPainted = true;

      const tableData = tableResult.data;
      /* Keep the last good list when the query fails rather than blanking the
         lobby -- but SAY SO. The malformed filter above 400'd on every load
         for hours and nothing anywhere reported it, because a swallowed error
         and an empty club look identical on screen. */
      if (tableResult.error) {
        reportError(tableResult.error, 'ClubHomePage.tablesQueryFailed');
      } else if (tableData) {
        setTables(tableData);
      }
      const tableCapped = (tableData?.length ?? 0) >= QUERY_LIMITS.LIST;

      // SWR: cache club + tables for instant display on revisit
      if (clubId && clubData) {
        setClubHomeCache(clubId, { club: clubData, tables: tableData || [] });
      }
      hasDataRef.current = true;

      // Merge club tournaments + XMTT tournaments
      const tournamentError =
        clubTournamentResult.error || (xmttResults.length > 0 && xmttResults[0].error);
      if (!tournamentError) {
        const allTournaments: TournamentData[] = clubTournamentResult.data
          ? [...clubTournamentResult.data]
          : [];
        if (xmttResults.length > 0 && xmttResults[0]?.data) {
          const existingIds = new Set(allTournaments.map((t) => t.id));
          for (const xmtt of xmttResults[0].data) {
            if (!existingIds.has(xmtt.id)) {
              allTournaments.push(xmtt);
            }
          }
        }
        setTournaments(allTournaments);
      }
      setCountsCapped(
        tableCapped ||
          (clubTournamentResult.data?.length ?? 0) >= QUERY_LIMITS.LIST ||
          (xmttResults[0]?.data?.length ?? 0) >= QUERY_LIMITS.LIST
      );

      // BBJ jackpot. Number() is load-bearing, not cosmetic: main_balance is
      // numeric(14,2) and arrives as the STRING "10500.67". Assigning it raw
      // put a string into a number-typed state, which then failed BBJTicker's
      // `typeof poolAmount === 'number'` ownership check and left the ticker
      // and the page disagreeing about who owns the value.
      if (bbjResult?.data && !(bbjResult as any).error) {
        if (Array.isArray(bbjResult.data)) {
          let sum = 0;
          let unionPoolId = null;
          for (const row of bbjResult.data) {
            const bal = Number(row.main_balance);
            if (Number.isFinite(bal)) sum += bal;
            // Prefer the first pool ID we find (or we could specifically find the union's)
            if (!unionPoolId) unionPoolId = row.id;
          }
          setJackpotAmount(sum);
          setBbjPoolId(unionPoolId);
        } else {
          const initial = Number((bbjResult.data as any)?.main_balance);
          setJackpotAmount(Number.isFinite(initial) ? initial : 0);
          setBbjPoolId((bbjResult.data as any)?.id || null);
        }
      }

      // Calculate Club Level from live metrics
      const activeTables = tableData
        ? tableData.filter((t: any) => t.status === 'running' || t.current_players > 0).length
        : 0;

      // Auto-recompute club level if stuck at default (1 or null)
      // The RPC updates clubs.level in-place and returns VOID,
      // so we re-read the level column after calling it.
      // Session dedup: only fire the RPC once per session per club to avoid waste
      let effectiveLevel = clubData.level || 1;
      const levelRecomputeKey = `level_recomputed_${resolvedId}`;
      if (effectiveLevel <= 1 && !sessionStorage.getItem(levelRecomputeKey)) {
        try {
          // Trigger server-side recompute (updates clubs.level in DB)
          const { error: rpcErr } = await supabase.rpc('recompute_club_levels', {
            p_club_id: resolvedId,
          });
          if (!rpcErr) {
            sessionStorage.setItem(levelRecomputeKey, '1');
            // Re-read the updated level from DB
            const { data: refreshedClub } = await supabase
              .from('clubs')
              .select(
                'level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
              )
              .eq('id', resolvedId)
              .maybeSingle();
            if (refreshedClub && refreshedClub.level > 1) {
              effectiveLevel = refreshedClub.level;
              // Also update threshold values for accurate progress bar
              clubData.hierarchy_units_rounded_up =
                refreshedClub.hierarchy_units_rounded_up ?? clubData.hierarchy_units_rounded_up;
              clubData.player_threshold_current =
                refreshedClub.player_threshold_current ?? clubData.player_threshold_current;
              clubData.player_threshold_next =
                refreshedClub.player_threshold_next ?? clubData.player_threshold_next;
              clubData.hierarchy_threshold_current =
                refreshedClub.hierarchy_threshold_current ?? clubData.hierarchy_threshold_current;
              clubData.hierarchy_threshold_next =
                refreshedClub.hierarchy_threshold_next ?? clubData.hierarchy_threshold_next;
            }
          }
        } catch (e) {
          reportError(e, 'ClubHomePage');
          // RPC not available — use default level
        }
      }

      const levelInfo = getClubLevel({
        level: effectiveLevel,
        playerCount: clubData.member_count || 0,
        hierarchyUnits: clubData.hierarchy_units_rounded_up || 0,
        playerThresholdCurrent: clubData.player_threshold_current || 0,
        playerThresholdNext: clubData.player_threshold_next || 0,
        hierarchyThresholdCurrent: clubData.hierarchy_threshold_current || 0,
        hierarchyThresholdNext: clubData.hierarchy_threshold_next || 0,
      });
      if (getIsMounted && !getIsMounted()) return;

      // Level-up celebration: detect when level increased vs previous render
      setClubLevel((prev) => {
        if (prev && prev.level > 0 && levelInfo.level > prev.level) {
          // Level went up — celebrate!
          toast.success(
            `Level Up! Your club reached Lv.${levelInfo.level} - ${levelInfo.tierLabel}!`
          );
          haptic.success();
        }
        return levelInfo;
      });
    } catch (error: any) {
      reportError(error, 'ClubHomePage.Error_loading_club_data');
      toast.error(error.message || 'Failed to load club data');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  // Which halves of the lobby the chosen type can produce. Derived once so the
  // filters, the status row and the empty state cannot disagree about it.
  const showsCash = gameType === 'ALL' || CASH_TYPES.includes(gameType);
  const showsTournaments = gameType === 'ALL' || TOURNAMENT_TYPES.includes(gameType);
  const showTournaments = TOURNAMENT_TYPES.includes(gameType);

  const filteredTables = useMemo(() => {
    if (!showsCash) return [];

    const q = searchQuery.trim().toLowerCase();
    /* Advanced Filters apply to the tab they were saved on. On ALL there is no
       single tab to read, so they do not apply - ALL means "show me
       everything", and quietly narrowing it would make the tab a lie. */
    const advType = gameType === 'ALL' ? null : (gameType as FilterGameType);
    const advSpec = advType && advType !== 'ALL' ? FILTER_SPECS[advType] : undefined;
    const advValue = advType ? advFilters[advType] : undefined;

    const rows = tables.filter((table) => {
      if (q && !(table.name || '').toLowerCase().includes(q)) return false;
      if (gameType !== 'ALL' && cashKind(table) !== gameType) return false;

      if (advSpec && advValue) {
        /* ONE decision function for both halves of the lobby - see
           rowPassesFilter. Applying the fields inline here is what let games,
           format and statuses drift into being collected-but-ignored. */
        const settings =
          typeof table.settings === 'string'
            ? (() => {
                try {
                  return JSON.parse(table.settings) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })()
            : ((table.settings as unknown as Record<string, unknown> | undefined) ?? {});
        if (
          !rowPassesFilter(advSpec, advValue, {
            variant: table.game_variant,
            price: Number(table.big_blind) || 0,
            seats: Number(table.max_players) || 0,
            seatsTaken: Number(table.current_players) || 0,
            name: table.name,
            row: table as unknown as Record<string, unknown>,
            settings,
          })
        ) {
          return false;
        }
      }

      return true;
    });

    const bb = (t: TableData) => Number(t.big_blind) || 0;
    const cmpStakes = (a: TableData, b: TableData) => bb(b) - bb(a);
    const cmpStakesLow = (a: TableData, b: TableData) => bb(a) - bb(b);
    const cmpPlayers = (a: TableData, b: TableData) =>
      (b.current_players || 0) - (a.current_players || 0);
    const cmpName = (a: TableData, b: TableData) => (a.name || '').localeCompare(b.name || '');

    switch (sortKey) {
      case 'stakes_high':
        return rows.sort((a, b) => cmpStakes(a, b) || cmpPlayers(a, b) || cmpName(a, b));
      case 'stakes_low':
        return rows.sort((a, b) => cmpStakesLow(a, b) || cmpPlayers(a, b) || cmpName(a, b));
      case 'players':
      case 'starting_soon':
        return rows.sort((a, b) => cmpPlayers(a, b) || cmpStakes(a, b) || cmpName(a, b));
      case 'recommended':
      default:
        return rows.sort((a, b) => cmpStakes(a, b) || cmpPlayers(a, b) || cmpName(a, b));
    }
  }, [tables, gameType, showsCash, sortKey, searchQuery, advFilters]);

  /**
   * Is the lobby showing less than everything, and why.
   *
   * Three independent things narrow this list: the game-type tab, the search
   * box, and the saved Advanced Filters for that tab. The empty state already
   * had to work this out to explain itself; the result count needs exactly the
   * same answer, so it is computed once here rather than twice in the markup.
   */
  const narrowing = useMemo(() => {
    const fSpec = FILTER_SPECS[gameType as Exclude<FilterGameType, 'ALL'>];
    const fVal = advFilters[gameType as FilterGameType];
    const filtered = Boolean(fSpec && fVal && isFilterActive(fSpec, fVal));
    const searching = searchQuery.trim().length > 0;
    return {
      fSpec,
      filtered,
      searching,
      tabbed: gameType !== 'ALL',
      any: filtered || searching || gameType !== 'ALL' || favoritesOnly,
    };
  }, [gameType, advFilters, searchQuery, favoritesOnly]);

  /**
   * Clear EVERY narrowing at once.
   *
   * Undoing them one at a time means guessing which one was responsible, and
   * the saved Advanced Filters are not visible from the lobby at all. Shared
   * by the result count and the empty state so the two cannot drift into
   * clearing different things.
   */
  const clearAllNarrowing = useCallback(() => {
    haptic.selection();
    setSearchQuery('');
    setFavoritesOnly(false);
    setGameType('ALL');
    if (narrowing.fSpec) {
      const next: FilterStore = {
        ...advFilters,
        [gameType]: emptyFilterValue(narrowing.fSpec),
      };
      setAdvFilters(next);
      if (resolvedClubId) saveFilters(resolvedClubId, next);
    }
  }, [narrowing.fSpec, advFilters, gameType, resolvedClubId]);

  const filteredTournaments = useMemo(() => {
    if (!showsTournaments) return [];

    const variant: TournVariant = TOURN_VARIANT_FOR[gameType] ?? 'ALL';
    const q = searchQuery.trim().toLowerCase();
    const advType = gameType === 'ALL' ? null : (gameType as FilterGameType);
    const advSpec = advType && advType !== 'ALL' ? FILTER_SPECS[advType] : undefined;
    const advValue = advType ? advFilters[advType] : undefined;

    const stillEnterable = (t: TournamentData) => {
      const status = String(t.status).toUpperCase();
      if (['REGISTERING', 'LATE_REG', 'LATE_REGISTRATION', 'STARTING_SOON'].includes(status))
        return true;
      if (status === 'RUNNING') {
        const levels = Number(t.late_reg_levels ?? 0);
        if (levels > 0) return Number(t.current_level ?? 0) <= levels;
        const mins = Number(t.late_reg_mins ?? 0);
        if (mins > 0 && t.started_at) {
          return Date.now() - new Date(t.started_at).getTime() <= mins * 60_000;
        }
      }
      return false;
    };

    const rows = tournaments.filter((t) => {
      if (!stillEnterable(t)) return false;
      if (q && !((t.name as string) || '').toLowerCase().includes(q)) return false;
      if (!matchesVariant(t, variant)) return false;

      if (advSpec && advValue) {
        // The tournament price is the TOTAL a player pays, not the prize half.
        const total = (Number(t.buy_in_amount) || 0) + (Number(t.buy_in_fee) || 0);
        if (
          !rowPassesFilter(advSpec, advValue, {
            variant: t.game_type,
            price: total,
            seats: Number(t.max_players) || 0,
            // The "Table Size" slider filters on seats at a TABLE, not on the
            // size of the field. Null when the row does not carry it, which
            // skips the range rather than measuring an MTT against 2-9.
            tableSeats: (t as unknown as { table_size?: number | null }).table_size ?? null,
            seatsTaken: Number(t.current_players) || 0,
            status: t.status,
            name: t.name,
            row: t as unknown as Record<string, unknown>,
            settings: {},
          })
        ) {
          return false;
        }
      }

      return true;
    });

    const buyIn = (t: TournamentData) =>
      (Number(t.buy_in_amount) || 0) + (Number(t.buy_in_fee) || 0);
    const cmpBuyIn = (a: TournamentData, b: TournamentData) => buyIn(b) - buyIn(a);
    const cmpBuyInLow = (a: TournamentData, b: TournamentData) => buyIn(a) - buyIn(b);
    const cmpPlayersTourn = (a: TournamentData, b: TournamentData) =>
      (b.current_players || 0) - (a.current_players || 0);
    const cmpNameTourn = (a: TournamentData, b: TournamentData) =>
      (a.name || '').localeCompare(b.name || '');

    switch (sortKey) {
      case 'stakes_high':
        return rows.sort((a, b) => cmpBuyIn(a, b) || cmpPlayersTourn(a, b) || cmpNameTourn(a, b));
      case 'stakes_low':
        return rows.sort(
          (a, b) => cmpBuyInLow(a, b) || cmpPlayersTourn(a, b) || cmpNameTourn(a, b)
        );
      case 'players':
        return rows.sort((a, b) => cmpPlayersTourn(a, b) || cmpBuyIn(a, b) || cmpNameTourn(a, b));
      case 'starting_soon': {
        const at = (t: TournamentData) => {
          const ms = new Date(t.start_time).getTime();
          return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
        };
        return rows.sort((a, b) => {
          const ea = stillEnterable(a) ? 0 : 1;
          const eb = stillEnterable(b) ? 0 : 1;
          if (ea !== eb) return ea - eb;
          return at(a) - at(b) || cmpBuyIn(a, b) || cmpPlayersTourn(a, b) || cmpNameTourn(a, b);
        });
      }
      case 'recommended':
      default:
        return rows.sort(
          (a, b) =>
            tournamentOpenFirst(a, b) ||
            cmpBuyIn(a, b) ||
            cmpPlayersTourn(a, b) ||
            cmpNameTourn(a, b)
        );
    }
  }, [tournaments, gameType, showsTournaments, sortKey, searchQuery, advFilters]);

  /**
   * Tables this player already holds an active place in the queue for.
   *
   * Loaded once per club visit rather than per card: a lobby renders up to
   * ~170 cards, and asking each one whether it is waitlisted would be ~170
   * round trips to answer a question one query answers for all of them.
   */
  const [waitlistedTableIds, setWaitlistedTableIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!currentUserId) {
      setWaitlistedTableIds(new Set());
      return;
    }
    let cancelled = false;
    waitlistService
      .myWaitlists()
      .then((rows) => {
        if (!cancelled) setWaitlistedTableIds(new Set(rows.map((r) => r.tableId)));
      })
      .catch((e) => reportError(e, 'ClubHomePage.loadMyWaitlists'));
    return () => {
      cancelled = true;
    };
  }, [currentUserId]);

  const handleWaitlistToggle = useCallback(
    async (tableId: string, joining: boolean) => {
      if (!currentUserId) {
        toast.error('Sign In To Join A Waitlist');
        return;
      }
      haptic.selection();
      /* Optimistic, then reconciled. The button is on a card in a long grid
         and the round trip is not instant; leaving it unchanged until the
         server answers reads as a dead tap and invites a second one, which
         would toggle it straight back. */
      setWaitlistedTableIds((prev) => {
        const next = new Set(prev);
        if (joining) next.add(tableId);
        else next.delete(tableId);
        return next;
      });

      try {
        if (joining) {
          const entry = await waitlistService.joinWaitlist(tableId);
          if (!entry) throw new Error('Could not join the waitlist');
          const pos = await waitlistService.getPosition(tableId);
          toast.success(
            pos && pos.position > 0
              ? `Added To The Waitlist. You Are Number ${pos.position} In Line.`
              : 'Added To The Waitlist.'
          );
        } else {
          const left = await waitlistService.leave(tableId);
          if (!left) throw new Error('Could not leave the waitlist');
          toast.success('Removed From The Waitlist.');
        }
      } catch (e) {
        // Put the button back where it was; the queue did not change.
        setWaitlistedTableIds((prev) => {
          const next = new Set(prev);
          if (joining) next.delete(tableId);
          else next.add(tableId);
          return next;
        });
        reportError(e, 'ClubHomePage.handleWaitlistToggle', { tableId, joining });
        toast.error(joining ? 'Could Not Join The Waitlist' : 'Could Not Leave The Waitlist');
      }
    },
    [currentUserId, toast]
  );

  // ═══════════════════════════════════════════════════════════════════════
  // LOBBY V2 — player relationship to games (seated / registered / favorite)
  // plus row selection + the game lobby panel.
  // ═══════════════════════════════════════════════════════════════════════
  /* True when a list query came back exactly full, i.e. the cap may have cut
     it. The lobby then reports its total as a floor ("200+ Games") instead of
     an exact number it cannot know. Counting for real would cost two extra
     round trips on every club load to answer a question that, at today's
     ceiling of 42 live tables in any club, nobody is asking. */
  const [countsCapped, setCountsCapped] = useState(false);
  const [seatedTableIds, setSeatedTableIds] = useState<Set<string>>(new Set());
  const [registeredTournamentIds, setRegisteredTournamentIds] = useState<Set<string>>(new Set());
  const [favoriteTableIds, setFavoriteTableIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  /* ── Selected game in the URL (?game=<id>) ──────────────────────────────
     A refresh or a shared link reopens the same game lobby. replace:true
     keeps history clean, so the back button still leaves the page rather
     than stepping through every row the player looked at. The MultiTablePage
     embed passes clubIdOverride and must never rewrite its host URL. */
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSyncEnabled = !clubIdOverride;
  // Captured at first render, before the sync effect below can strip it.
  const pendingGameRef = useRef<string | null>(searchParams.get('game'));

  useEffect(() => {
    if (!urlSyncEnabled) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (panelOpen && selectedId) next.set('game', selectedId);
        else next.delete('game');
        return next;
      },
      { replace: true }
    );
  }, [urlSyncEnabled, panelOpen, selectedId, setSearchParams]);
  const [actionBusy, setActionBusy] = useState(false);

  const loadMyGameStates = useCallback(async () => {
    if (!currentUserId) {
      setSeatedTableIds(new Set());
      setRegisteredTournamentIds(new Set());
      setFavoriteTableIds(new Set());
      return;
    }
    try {
      const [seatsRes, regsRes, favsRes] = await Promise.all([
        supabase
          .from('table_seats')
          .select('table_id')
          .eq('user_id', currentUserId)
          .is('left_at', null),
        supabase
          .from('tournament_players')
          .select('tournament_id')
          .eq('user_id', currentUserId)
          .in('status', ['registered', 'playing']),
        supabase.from('favorite_tables').select('table_id').eq('user_id', currentUserId),
      ]);
      setSeatedTableIds(new Set((seatsRes.data || []).map((r) => r.table_id)));
      setRegisteredTournamentIds(new Set((regsRes.data || []).map((r) => r.tournament_id)));
      setFavoriteTableIds(new Set((favsRes.data || []).map((r) => r.table_id)));
    } catch (e) {
      reportError(e, 'ClubHomePage.loadMyGameStates');
    }
  }, [currentUserId]);

  useEffect(() => {
    loadMyGameStates();
  }, [loadMyGameStates]);

  // Keep the seated / registered chips live: these events already fire on the
  // bus for the balance reload; they also change my relationship to the rows.
  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced('TABLE_SEATED', loadMyGameStates, 300),
      masterBus.subscribeDebounced('TABLE_LEFT', loadMyGameStates, 300),
      masterBus.subscribeDebounced('TOURNAMENT_REGISTERED', loadMyGameStates, 300),
      masterBus.subscribeDebounced('TOURNAMENT_UPDATED', loadMyGameStates, 300),
    ];
    return () => unsubs.forEach((u) => u());
  }, [loadMyGameStates]);

  /** Star / unstar a cash table. Reuses the favorite_tables infrastructure. */
  const handleToggleFavorite = useCallback(
    async (tableId: string, next: boolean) => {
      if (!currentUserId) {
        toast.error('Sign In To Save Favorites');
        return;
      }
      haptic.selection();
      setFavoriteTableIds((prev) => {
        const s = new Set(prev);
        if (next) s.add(tableId);
        else s.delete(tableId);
        return s;
      });
      try {
        if (next) {
          const { error } = await supabase
            .from('favorite_tables')
            .insert({ user_id: currentUserId, table_id: tableId });
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from('favorite_tables')
            .delete()
            .eq('user_id', currentUserId)
            .eq('table_id', tableId);
          if (error) throw error;
        }
      } catch (e) {
        // Roll back the optimistic star; the row did not change.
        setFavoriteTableIds((prev) => {
          const s = new Set(prev);
          if (next) s.delete(tableId);
          else s.add(tableId);
          return s;
        });
        reportError(e, 'ClubHomePage.handleToggleFavorite', { tableId, next });
        toast.error(next ? 'Could Not Save Favorite' : 'Could Not Remove Favorite');
      }
    },
    [currentUserId, toast]
  );

  /** Row selection — opens the game lobby panel. NEVER joins or spends. */
  const openEntry = useCallback(
    (entry: LobbyEntry) => {
      haptic.selection();
      if (
        entry.kind === 'mtt' &&
        (entry.status === 'running' || entry.status === 'late_reg' || entry.status === 'completed')
      ) {
        navigate(`/tournaments/${entry.id}`);
        return;
      }
      setSelectedId(entry.id);
      setPanelOpen(true);
    },
    [navigate]
  );

  const handleJoinTable = useCallback(
    (tableId: string) => {
      haptic.medium();
      setPanelOpen(false);
      // Execute navigate in the next tick to ensure the panel unmounts safely
      // without interrupting React Router transition internals
      setTimeout(() => navigate(`/table/${tableId}`), 0);
    },
    [navigate]
  );

  const handleRegister = useCallback(
    (t: LobbyTournamentRow) => {
      registerMtt(
        {
          id: t.id,
          name: t.name,
          buy_in_amount: t.buy_in_amount,
          buy_in_fee: t.buy_in_fee,
        },
        () => {
          setRegisteredTournamentIds((prev) => new Set(prev).add(t.id));
          setPanelOpen(false);
        }
      );
    },
    [registerMtt]
  );

  const handleUnregister = useCallback(
    async (t: LobbyTournamentRow) => {
      if (!currentUserId || actionBusy) return;
      setActionBusy(true);
      try {
        await tournamentService.unregisterPlayer(t.id, currentUserId);
        setRegisteredTournamentIds((prev) => {
          const s = new Set(prev);
          s.delete(t.id);
          return s;
        });
        toast.success('You Are No Longer Registered');
      } catch (e) {
        reportError(e, 'ClubHomePage.handleUnregister', { tournamentId: t.id });
        toast.error(e instanceof Error ? e.message : 'Could Not Unregister, Please Try Again');
      } finally {
        setActionBusy(false);
      }
    },
    [currentUserId, actionBusy, toast]
  );

  // ── LOBBY V2 view models — the SAME filtered/sorted rows, normalized ──
  const lobbyEntries = useMemo<LobbyEntry[]>(() => {
    const tourns = filteredTournaments.map((t) =>
      tournamentEntry(
        t as unknown as LobbyTournamentRow,
        classifyTournament(t as unknown as LobbyTournamentRow)
      )
    );
    let cash = filteredTables.map(cashEntry);
    if (favoritesOnly) cash = cash.filter((e) => favoriteTableIds.has(e.id));

    if (gameType === 'ALL') {
      const isMtt = (e: LobbyEntry) => e.kind === 'mtt';
      const isLateRegOrStarting = (e: LobbyEntry) =>
        e.status === 'registering' || e.status === 'late_reg' || e.status === 'starting_soon';

      const selectedTourns = tourns.filter((t) => isMtt(t) && isLateRegOrStarting(t)).slice(0, 10);

      const holdemCash = cash.filter((c) => cashKind(c.raw as any) === 'HOLDEM').slice(0, 10);
      const omahaCash = cash.filter((c) => cashKind(c.raw as any) === 'OMAHA').slice(0, 10);
      const limitCash = cash.filter((c) => cashKind(c.raw as any) === 'LIMIT').slice(0, 10);

      return [...selectedTourns, ...holdemCash, ...omahaCash, ...limitCash];
    }

    // Tournaments first, cash after — same order the card grid used, so the
    // page-level sort control keeps meaning what it meant.
    return [...tourns, ...cash];
  }, [filteredTournaments, filteredTables, favoritesOnly, favoriteTableIds, gameType]);

  const selectedEntry = useMemo(
    () => (selectedId ? lobbyEntries.find((e) => e.id === selectedId) || null : null),
    [selectedId, lobbyEntries]
  );

  // A selected row that leaves the list (deleted, filtered out, status change)
  // closes the panel rather than showing a stale game.
  useEffect(() => {
    if (panelOpen && selectedId && !selectedEntry) setPanelOpen(false);
  }, [panelOpen, selectedId, selectedEntry]);

  // Reopen the game a ?game=<id> URL points at, once the list contains it.
  // A dead id (deleted game, another club's game) is dropped on the first
  // loaded list instead of lying in wait forever.
  useEffect(() => {
    if (!urlSyncEnabled || !pendingGameRef.current) return;
    if (lobbyEntries.length === 0) return;
    const id = pendingGameRef.current;
    pendingGameRef.current = null;
    const entry = lobbyEntries.find((e) => e.id === id);
    if (entry) {
      setSelectedId(id);
      setPanelOpen(true);
    }
  }, [urlSyncEnabled, lobbyEntries]);

  /** How many rows the lobby is about to render. */
  const shownCount = lobbyEntries.length;

  /**
   * Everything the club is running, before ANY narrowing.
   *
   * Deliberately the whole club rather than the current tab: the count exists
   * to answer "am I missing games?", and a per-tab total would answer that
   * question with the tab's own filter already applied, which is the one
   * narrowing most likely to be forgotten.
   */
  const totalGameCount = tables.length + tournaments.length;

  const formatNumber = (num: number) => {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatJackpot = (num: number) => {
    if (num === 0) return '-';
    return num.toLocaleString();
  };

  if (loading) {
    return (
      <div className="club-home loading" style={{ padding: '1rem' }}>
        {/* Skeleton header */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '1.5rem' }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.08)',
              animation: 'animationsPulse 1.5s ease-in-out infinite',
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                width: '60%',
                height: 20,
                borderRadius: 6,
                background: 'rgba(255,255,255,0.08)',
                marginBottom: 8,
                animation: 'animationsPulse 1.5s ease-in-out infinite',
              }}
            />
            <div
              style={{
                width: '40%',
                height: 14,
                borderRadius: 4,
                background: 'rgba(255,255,255,0.06)',
                animation: 'animationsPulse 1.5s ease-in-out infinite',
              }}
            />
          </div>
        </div>
        {/* Skeleton stat bar */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '1.5rem' }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: 60,
                borderRadius: 10,
                background: 'rgba(255,255,255,0.05)',
                animation: 'animationsPulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </div>
        {/* Skeleton table cards */}
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: 80,
              borderRadius: 12,
              background: 'rgba(255,255,255,0.04)',
              marginBottom: 12,
              animation: 'animationsPulse 1.5s ease-in-out infinite',
            }}
          />
        ))}
      </div>
    );
  }

  if (!club) {
    /**
     * Dan 2026-08-20: distinguish "we asked and the club is not there" from
     * "our request never came back". The watchdog above unsticks a stalled
     * load, and this panel used to tell those players their club had been
     * "moved or deleted" — a flatly untrue message during the 2026-08-20
     * Supabase API degradation, when the club existed and 39 of its tables
     * were running. Same panel, same Retry button, honest wording.
     */
    return (
      <div className="club-home error">
        <h2>{loadStalled ? 'Still Loading' : 'Club Not Found'}</h2>
        <p style={{ color: '#888', fontSize: '0.9rem', margin: '0 0 1rem' }}>
          {loadStalled
            ? 'This is taking longer than usual - the connection may be slow right now. Your chips and seats are safe.'
            : 'The club may have been moved or deleted.'}
        </p>
        {/* The cause, verbatim. A player can read it out and it names the bug
            immediately; without it every failure mode looks the same. */}
        {!loadStalled && loadFailure && (
          <p
            style={{
              color: '#6a7a8a',
              fontSize: '0.72rem',
              fontFamily: 'monospace',
              margin: '0 0 1rem',
              wordBreak: 'break-word',
            }}
          >
            {loadFailure}
          </p>
        )}
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            className="btn btn-primary"
            onClick={() => {
              loadingRef.current = false;
              setLoadStalled(false);
              /* Drop the previous cause, or a retry that fails differently
                 would still be showing the first attempt's reason. */
              setLoadFailure(null);
              loadClubData();
            }}
            style={{
              background: '#1877f2',
              border: 'none',
              color: 'white',
              padding: '0.6rem 1.2rem',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Retry
          </button>
          <Link
            to="/clubs"
            className="btn btn-primary"
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: 'white',
              padding: '0.6rem 1.2rem',
              borderRadius: 8,
              textDecoration: 'none',
              fontWeight: 600,
            }}
          >
            Back To Clubs
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="club-home">
      <GlobalUXIndicators wsConnected={wsConnected} />
      {/* Dan 2026-08-19: the resume bar moved into the persistent multi-table
          layer (PersistentTableLayer in App.tsx), which now shows it on EVERY
          non-/table route — a per-page copy here would double-render it. */}
      {/* Animations moved to ClubHomePage.css */}

      {/* ═══════════════════════════════════════════════════════════════════
          LOBBY HEADER — rebuilt 2026-08-20 (Dan).
          One header block instead of four loosely-stacked rows. Every icon in
          here was an emoji glyph (trophy / bar-chart / two-people / chain-link)
          rendered from the platform font, so the same header drew differently
          on every device and broke the house no-emoji-in-source rule. All of
          them are inline SVG on currentColor now — see LobbyIcons.tsx.
      ═══════════════════════════════════════════════════════════════════ */}
      <header className="lobby-top">
        {/* ── Club identity + wallet ── */}
        <div className="lobby-top__main">
          <div className="lobby-club">
            <div className="lobby-club__avatar">
              {club.logo_url || club.avatar_url ? (
                <img src={club.logo_url || club.avatar_url} alt={club.name} loading="lazy" />
              ) : Number(club.club_id) === SHARK_CLUB_ID ? (
                <img src={SHARK_CLUB_FALLBACK_LOGO} alt="Shark Club" loading="lazy" />
              ) : (
                <span className="lobby-club__avatar-fallback">&#9824;</span>
              )}
            </div>

            <div className="lobby-club__info">
              <h2 className="lobby-club__name" title={club.name}>
                {club.name}
              </h2>
              <div className="lobby-club__meta">
                <span className="lobby-club__id">ID {club.club_id}</span>
                <span className="lobby-club__members">
                  <IconMembers />
                  {(club.member_count || 0).toLocaleString()}
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  marginTop: '6px',
                  flexDirection: 'column',
                }}
              >
                {clubLevel && (
                  <div className="lobby-club__level">
                    <span
                      className="club-level-badge"
                      style={{ background: clubLevel.gradient }}
                      title={`Level ${clubLevel.level} - ${clubLevel.tierLabel}`}
                    >
                      <span className="club-level-badge__number">Level {clubLevel.level}</span>
                      <span className="club-level-badge__tier">{clubLevel.tierLabel}</span>
                    </span>
                  </div>
                )}

                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}
                >
                  {playersPlaying !== null && (
                    <div style={{ fontSize: '0.8rem', color: '#9aa5b6' }}>
                      {playersPlaying.toLocaleString()} Players Currently Playing
                    </div>
                  )}

                  <button
                    className="lobby-club__share"
                    aria-label="Share club invite link"
                    title="Share"
                    onClick={async () => {
                      haptic.medium();
                      const shareUrl = `${window.location.origin}/clubs/${club.slug || clubId}`;
                      try {
                        if (navigator.share) {
                          await navigator.share({
                            title: club.name,
                            text: `Join ${club.name} on Smarter Poker!`,
                            url: shareUrl,
                          });
                        } else {
                          await navigator.clipboard.writeText(shareUrl);
                          toast.success('Club link copied!');
                        }
                      } catch (e) {
                        reportError(e, 'ClubHomePage.async');
                        /* user cancelled share */
                      }
                    }}
                  >
                    <IconShareLink />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ── Wallet ──
              WALLET SEPARATION LAW (Dan 2026-08-20): this is a CLUB screen, so
              it renders CLUB money. The variant used to become 'union' whenever
              a union owner opened one of his own clubs, which replaced Club
              Bank with Union Bank / Rake Treasury / Clubs Wallet / Backup BBJ —
              the union's books, on the club's lobby. Owning both does not merge
              them; one wallet never gets access to the other. Union figures are
              managed on the union's own surfaces and appear nowhere here.

              The BBJ now leads the wallet stack (see showBBJ below) rather
              than sitting in its own strip above the club card. */}
          {currentUserId && resolvedClubId && (
            <div className="lobby-top__wallet">
              {/* Dan 2026-08-20: "the BBJ amount should be on top of the rest
                  of the wallet data." It was a full-width strip ABOVE the club
                  card, which put it in a different column from the money it
                  belongs with. showBBJ={true} renders it as the first row of
                  the wallet stack instead, where it reads as the headline
                  figure over the balances beneath it.

                  Dan 2026-08-20: tapping that BBJ figure opens the jackpot
                  POPUP (total + last 5 winners + fee schedule + qualifying
                  hands), not a route change. It used to navigate to the BBJ
                  page, which left showBBJInfo with no way to ever become true
                  and no popup anywhere in the lobby. */}
              <DynamicWallet
                userId={currentUserId}
                clubId={resolvedClubId}
                // WHOSE books. A union's own lobby shows union books; every
                // club lobby shows club books, whoever is standing in it.
                variant={club?.is_union ? 'union' : 'club'}
                // WHO is looking. Decides which rows exist - see walletRows.ts.
                // The club's owner_id outranks a stale club_members row, which
                // is how a brand new owner sees their own Club Bank.
                role={isOwner ? 'owner' : userRole}
                showBBJ
                onBuyDiamonds={() => {
                  haptic.medium();
                  navigate(`/clubs/${clubId}/detail`);
                }}
                // Dan 2026-08-23: "if they click on Club Bank, that should
                // open the Club Bank Cashier." The row only renders for owner,
                // co-owner, admin and super agent, and fn_can_use_club_bank
                // refuses everyone else server-side. The Chip Mint moved
                // INSIDE that cashier - there is no mint button out here any
                // more, and no mint at all once the club is in a union.
                onOpenPromoWallet={() => setShowPromoWallet(true)}
                onOpenClubBank={() => {
                  haptic.medium();
                  setShowClubBank(true);
                }}
                onOpenBBJ={() => {
                  haptic.medium();
                  setShowBBJInfo(true);
                }}
              />
            </div>
          )}
        </div>

        {/* ── Editable Club Notice ── */}
        {(club.description?.trim() || isOwner || isClubStaff(userRole)) && (
          <div
            className={`lobby-top__notice ${isOwner || isClubStaff(userRole) ? 'lobby-top__notice--editable' : ''}`}
            onClick={() => {
              if ((isOwner || isClubStaff(userRole)) && !isEditingNotice) {
                setNoticeDraft(club.description || '');
                setIsEditingNotice(true);
              }
            }}
          >
            {isEditingNotice ? (
              <div className="lobby-top__notice-editor" onClick={(e) => e.stopPropagation()}>
                <textarea
                  value={noticeDraft}
                  onChange={(e) => setNoticeDraft(e.target.value)}
                  placeholder="Welcome to the Shark Club, all fish of all shapes and sizes are welcome!"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setIsEditingNotice(false);
                  }}
                />
                <div className="lobby-top__notice-actions">
                  <button onClick={() => setIsEditingNotice(false)}>Cancel</button>
                  <button
                    onClick={() => {
                      const newDesc = noticeDraft.trim();
                      // Optimistic UI update
                      setClub((prev) => (prev ? { ...prev, description: newDesc } : prev));
                      setIsEditingNotice(false);
                      toast.success('Successfully updated');

                      // Fire and forget background update
                      supabase
                        .from('clubs')
                        .update({ description: newDesc })
                        .eq('id', resolvedClubId)
                        .then(({ error }) => {
                          if (error) {
                            console.error('Background save failed', error);
                            toast.error('Failed to sync welcome message to server');
                          }
                        });
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <p>{club.description?.trim() || 'Click to add a welcome message...'}</p>
            )}
          </div>
        )}
      </header>

      <ClubBankCashierModal
        isOpen={showClubBank}
        onClose={() => setShowClubBank(false)}
        clubId={resolvedClubId || clubId || ''}
        role={isOwner ? 'owner' : userRole}
      />
      <BBJInfoModal
        isOpen={showBBJInfo}
        onClose={() => setShowBBJInfo(false)}
        poolId={bbjPoolId}
        poolAmount={jackpotAmount}
        currentUserId={currentUserId}
      />

      {/* ═══════════════════════════════════════════════════════════════════
          GAME ACTION BAR — every game type, flat, plus explicit sorting
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="game-bar">
        <div className="game-bar__types" role="tablist" aria-label="Game type">
          {GAME_TYPE_TABS.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={gameType === tab.key}
              className={`game-bar__type ${gameType === tab.key ? 'is-active' : ''}`}
              onClick={() => {
                haptic.selection();
                setGameType(tab.key);
                setSortOpen(false);
                if (tab.key === 'MTT') {
                  setSortKey('starting_soon');
                } else if (tab.key === 'HOLDEM' || tab.key === 'OMAHA') {
                  setSortKey('recommended');
                }
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Advanced Filters. Hidden on ALL, which has no spec of its own and
            means "show everything" - offering a filter sheet there would imply
            the tab can be narrowed when it deliberately cannot. */}
        <button
          className={`game-bar__filter-btn ${(() => {
            if (gameType === 'ALL') return sortKey !== 'recommended' ? 'is-set' : '';
            const fSpec = FILTER_SPECS[gameType as Exclude<FilterGameType, 'ALL'>];
            const fVal = advFilters[gameType as FilterGameType];
            const isFilt = fSpec && fVal && isFilterActive(fSpec, fVal);
            return isFilt || sortKey !== 'recommended' ? 'is-set' : '';
          })()}`}
          aria-label="Filters and Sort"
          title="Filters and Sort"
          onClick={() => {
            haptic.light();
            setSortOpen(false);
            setFiltersOpen(true);
          }}
        >
          <IconSort />
          <span>Filters</span>
        </button>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          QUICK PREFERENCES — the one-tap shortcuts under the action bar
          ───────────────────────────────────────────────────────────────────
          Dan 2026-08-21: "you never added the quick preference link under the
          action bar."

          Two rows, matching the reference: the stakes/buy-in TIERS, and the
          seat-status chips. The tier chips are not a separate filter - they
          write the same saved range the Advanced Filters sheet does, so the
          two can never disagree, and the icon on the right opens that sheet
          for everything the row has no space for.
      ═══════════════════════════════════════════════════════════════════ */}
      {gameType !== 'ALL' &&
        (() => {
          const qSpec = FILTER_SPECS[gameType as Exclude<FilterGameType, 'ALL'>];
          if (!qSpec) return null;
          const qVal = advFilters[gameType as FilterGameType] ?? emptyFilterValue(qSpec);

          return (
            <div className="quickprefs">
              <div className="quickprefs__row">
                {qSpec.range.presets.map((p) => {
                  const on = (qVal.selectedRanges || []).includes(p.key);
                  return (
                    <button
                      key={p.key}
                      className={`quickprefs__chip ${on ? 'is-on' : ''}`}
                      aria-pressed={on}
                      onClick={() => {
                        haptic.selection();
                        const arr = qVal.selectedRanges || [];
                        const nextArr = on ? arr.filter((k) => k !== p.key) : [...arr, p.key];
                        const next: FilterStore = {
                          ...advFilters,
                          [gameType]: { ...qVal, selectedRanges: nextArr },
                        };
                        setAdvFilters(next);
                        if (resolvedClubId) saveFilters(resolvedClubId, next);
                      }}
                    >
                      {p.label}
                    </button>
                  );
                })}
                {currentUserId && (
                  <button
                    type="button"
                    className={`quickprefs__chip ${favoritesOnly ? 'is-on' : ''}`}
                    aria-pressed={favoritesOnly}
                    onClick={() => {
                      haptic.selection();
                      setFavoritesOnly((v) => !v);
                    }}
                  >
                    Favorites
                  </button>
                )}
                <button
                  className="quickprefs__more"
                  aria-label="Advanced filters"
                  title="Advanced Filters"
                  onClick={() => {
                    haptic.light();
                    setSortOpen(false);
                    setFiltersOpen(true);
                  }}
                >
                  <IconSort />
                </button>
              </div>

              <div className="quickprefs__row quickprefs__row--status">
                <span className="quickprefs__label">{showsCash ? 'Tables:' : 'Games:'}</span>
                {/* AUDIT 2026-08-21: these chips used to be a hand-written list
                    chosen by showsCash, which disagreed with the sheet on the
                    same screen - Spin-It offered Full/Empty/Open Seats inside
                    Advanced Filters and Running/Registering out here. Both now
                    read spec.statuses, so there is one vocabulary per game type
                    and one place to change it.

                    They also write the SAVED filter now rather than the local
                    sub-filter state, which is what makes them agree with the
                    sheet after a reload instead of resetting. */}
                {qSpec.statuses.map((sf) => {
                  const on = qVal.statuses.includes(sf.key);
                  return (
                    <button
                      key={sf.key}
                      className={`quickprefs__chip ${on ? 'is-on' : ''}`}
                      aria-pressed={on}
                      onClick={() => {
                        haptic.selection();
                        const next: FilterStore = {
                          ...advFilters,
                          [gameType]: {
                            ...qVal,
                            statuses: on
                              ? qVal.statuses.filter((k) => k !== sf.key)
                              : [...qVal.statuses, sf.key],
                          },
                        };
                        setAdvFilters(next);
                        if (resolvedClubId) saveFilters(resolvedClubId, next);
                      }}
                    >
                      {sf.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}

      {/* ═══════════════════════════════════════════════════════════════════
          CLUB / UNION AD STRIP — directly under the action bar
      ═══════════════════════════════════════════════════════════════════ */}
      {filtersOpen && resolvedClubId && (
        <AdvancedFilters
          clubId={resolvedClubId}
          initialType={gameType as FilterGameType}
          onClose={() => setFiltersOpen(false)}
          onApply={setAdvFilters}
          sortKey={sortKey}
          onSortChange={setSortKey}
          sortOptions={SORT_OPTIONS}
        />
      )}

      <LobbyAdStrip
        clubId={bbjScope.clubUuid || resolvedClubId}
        unionId={bbjScope.unionId}
        onOpen={() => {
          haptic.selection();
          navigate(`/clubs/${clubId}/announcements`);
        }}
      />

      {/* The standalone STATUS REFINEMENT row was folded into the quick
          preferences block above on 2026-08-21. Keeping both would have shown
          the same four chips twice, a few pixels apart, with the lower copy
          the only working one. */}

      {/* ═══════════════════════════════════════════════════════════════════
          RESULT COUNT
          ─────────────────────────────────────────────────────────────────
          The lobby runs 60 to 170 cards and three independent things narrow
          it, one of which (Advanced Filters) is SAVED and survives a reload.
          Without a count, a player who set a filter days ago sees a short
          list and reads it as "this club is dead" rather than "you are
          looking at 12 of 170". The count only claims "of N" when something
          is actually narrowing, so it never implies a filter that is not set,
          and it carries the same one-tap clear the empty state uses.
      ═══════════════════════════════════════════════════════════════════ */}
      {shownCount > 0 && (
        <div className="lobby-count">
          <span className="lobby-count__text">
            {narrowing.any && totalGameCount > shownCount ? (
              <>
                {/* countsCapped: a list query came back exactly full, so the
                    total is a floor, not a fact. Say "200+" rather than a
                    number we cannot stand behind. */}
                Showing <strong>{shownCount.toLocaleString()}</strong> Of{' '}
                {totalGameCount.toLocaleString()}
                {countsCapped ? '+' : ''} Games
              </>
            ) : (
              <>
                <strong>{shownCount.toLocaleString()}</strong> Game
                {shownCount === 1 ? '' : 's'}
              </>
            )}
          </span>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          LOBBY V2 — dense line-based game table + game lobby panel
          ─────────────────────────────────────────────────────────────────
          One compact row per game, columns adapted to the selected category.
          Clicking a row SELECTS it and opens the CasinoPlaque game lobby —
          it never joins, registers, or spends. All commit actions live in
          the panel and reuse the existing platform flows.
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="club-home__games club-home__games--v2">
        <div className="lobby-actionsrow">
          {/* CREATE NEW GAME - owners/admins of STANDALONE clubs and UNIONS.
              Same branch main shipped on the old create tile: a tournament
              tab opens CreateTournamentModal, a cash tab goes to the
              create-table page. */}
          {(isOwner || userRole === 'admin') && (!isInUnion || club?.is_union) && (
            <button
              type="button"
              className="lobby-createbtn"
              onClick={() => {
                haptic.selection();
                if (['MTT', 'SNG', 'SPIN'].includes(gameType)) {
                  setShowCreateTournament(true);
                } else {
                  navigate(`/clubs/${clubId}/create-table`);
                }
              }}
            >
              + Create New {TOURNAMENT_TYPES.includes(gameType) ? 'Game' : 'Table'}
            </button>
          )}
        </div>

        {/* Render while loading too: LobbyTable owns the skeleton rows, and
            gating on entries>0 made them unreachable - first load flashed the
            empty state instead (review 2026-08-22). */}
        {(lobbyEntries.length > 0 || loading) && (
          <LobbyTable
            entries={lobbyEntries}
            clubId={resolvedClubId || clubId}
            category={gameType as LobbyCategory}
            selectedId={panelOpen ? selectedId : null}
            onSelect={openEntry}
            onActivate={openEntry}
            loading={loading}
            ctx={{
              waitlistedIds: waitlistedTableIds,
              seatedIds: seatedTableIds,
              registeredIds: registeredTournamentIds,
              favoriteIds: favoriteTableIds,
              onToggleFavorite: currentUserId ? handleToggleFavorite : undefined,
            }}
          />
        )}

        {/* ═══════════════════════════════════════════════════════════════
            EMPTY STATE — say WHY, and offer the way out
            ───────────────────────────────────────────────────────────────
            AUDIT 2026-08-21. This said "No tables available / wait for the
            owner to create tables" for every empty result, and hid itself from
            owners entirely (`!isOwner`). Both are wrong, and the filter fix in
            this same pass makes them dangerous: filters now genuinely filter,
            so the most likely reason a lobby is empty is the player's own
            search or saved preferences - and the screen was blaming the club
            for it while offering no way back. An owner who over-filters saw a
            blank grid with no message at all.

            It now distinguishes the three real causes and, when the player
            caused it, clears the cause in one tap.
        ═══════════════════════════════════════════════════════════════ */}
        {!loading &&
          lobbyEntries.length === 0 &&
          (() => {
            // Same three causes the result count reads, from the same place.
            const totalHere = totalGameCount;
            const { searching, filtered } = narrowing;
            const narrowed = narrowing.any;

            return (
              <div className="empty-tables">
                {!narrowed || totalHere === 0 ? (
                  <>
                    <p>{showTournaments ? 'No Tournaments Yet' : 'No Tables Yet'}</p>
                    <p className="empty-hint">
                      Nothing Is Running Here Right Now. New Games Open All The Time.
                    </p>
                  </>
                ) : !filtered && !searching ? (
                  <>
                    {/* Tab (or Favorites) is the ONLY narrowing: blaming
                        "filters" here sent players hunting for filters they
                        never set (QA 2026-08-22). Name the real cause. */}
                    <p>Nothing Here On This Tab</p>
                    <p className="empty-hint">
                      {totalHere.toLocaleString()}
                      {countsCapped ? '+' : ''} Game{totalHere === 1 ? ' Is' : 's Are'} Open In This
                      Club, Just None Of This Type Right Now.
                    </p>
                    <div className="empty-actions">
                      <button className="empty-action" onClick={clearAllNarrowing}>
                        Show All Games
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>Nothing Matches Your Filters</p>
                    <p className="empty-hint">
                      {totalHere.toLocaleString()}
                      {countsCapped ? '+' : ''} Game{totalHere === 1 ? '' : 's'} Are Open In This
                      Club, But {searching ? 'your search and ' : ''}
                      The Filters On This Tab Hide {totalHere === 1 ? 'it' : 'them all'}.
                    </p>
                    <div className="empty-actions">
                      <button className="empty-action" onClick={clearAllNarrowing}>
                        Show All Games
                      </button>
                      {filtered && (
                        <button
                          className="empty-action empty-action--ghost"
                          onClick={() => {
                            haptic.light();
                            setFiltersOpen(true);
                          }}
                        >
                          Edit Filters
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })()}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          SELECTED GAME LOBBY — CasinoPlaque panel (renders ONLY for the
          selected game; closes on Escape, backdrop, or the X)
      ═══════════════════════════════════════════════════════════════════ */}
      {panelOpen && selectedEntry && clubId && (
        <GameLobbyPanel
          embedded={Boolean(clubIdOverride)}
          entry={selectedEntry}
          clubId={clubId}
          currentUserId={currentUserId}
          waitlisted={waitlistedTableIds.has(selectedEntry.id)}
          seated={seatedTableIds.has(selectedEntry.id)}
          registered={registeredTournamentIds.has(selectedEntry.id)}
          busy={actionBusy}
          onClose={() => setPanelOpen(false)}
          onJoinTable={handleJoinTable}
          onWaitlistToggle={handleWaitlistToggle}
          onRegister={handleRegister}
          onUnregister={handleUnregister}
          onSpinJoin={(t, variant) => {
            setPanelOpen(false);
            spinQuickJoin({ id: t.id, name: t.name, buy_in_amount: t.buy_in_amount }, variant);
          }}
          canDelete={isOwner || userRole === 'admin'}
          onDeleteTable={(id) => {
            setPanelOpen(false);
            setDeleteTableConfirm({ show: true, tableId: id, tableName: selectedEntry.name });
          }}
        />
      )}

      {/* ═══════════════════════════════════════════════════════════════════
                BACKGROUND IMAGE (Premium Bar Scene)
            ═══════════════════════════════════════════════════════════════════ */}

      {/* ═══════════════════════════════════════════════════════════════════
                BOTTOM NAVIGATION BAR
            ═══════════════════════════════════════════════════════════════════ */}
      {/* SPIN QUICK-JOIN overlay — covers the register -> seat wait. */}
      {spinJoin && (
        <div className="spin-join-overlay" role="status">
          <div className="spin-join-card">
            <div className="spin-join-spinner" aria-hidden="true" />
            <div className="spin-join-title">{spinJoin.stage}</div>
            <div className="spin-join-sub">{spinJoin.name}</div>
            <button
              type="button"
              className="spin-join-cancel"
              onClick={() => {
                spinJoinCancelRef.current = true;
                setSpinJoin(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} clubName={club?.name} />}

      {/* Confirm Modal for Table Deletion */}
      <ConfirmModal
        isOpen={deleteTableConfirm.show}
        title="Delete Table"
        message={`Delete table "${deleteTableConfirm.tableName || ''}"? This cannot be undone.`}
        variant="danger"
        confirmText="Delete"
        onConfirm={async () => {
          if (deleteTableConfirm.tableId) {
            const id = deleteTableConfirm.tableId;
            setDeleteTableConfirm({ show: false, tableId: null, tableName: null });
            setDeletingTableId(id);
            try {
              // Defense-in-depth: scope the delete to tables this club can own.
              // 2026-08-19: this scoped on club_id ALONE. Union games are owned
              // BY the union, so club_id is the union's id, not club.id — the
              // UPDATE matched ZERO rows, returned no error, the card was
              // optimistically removed and the user was told "Table deleted".
              // The table stayed live and reappeared on reload. Accept either
              // the club's own tables or its union's.
              const resolvedClubId = club?.id;
              let query = supabase
                .from('tables')
                .update({ status: 'deleted', is_active: false, is_deleted: true })
                .eq('id', id);
              if (resolvedClubId) {
                query = bbjScope.unionId
                  ? query.or(`club_id.eq.${resolvedClubId},union_id.eq.${bbjScope.unionId}`)
                  : query.eq('club_id', resolvedClubId);
              }
              // Return the affected rows so a no-op cannot masquerade as success.
              const { data: deleted, error } = await query.select('id');
              if (error) throw error;
              if (!deleted || deleted.length === 0) {
                toast.error('That table could not be deleted - you may not own it.');
                return;
              }
              setTables((prev) => prev.filter((t) => t.id !== id));
              toast.success('Table deleted');
            } catch (err) {
              reportError(err, 'ClubHomePage.Failed_to_delete_table');
              toast.error('Failed to delete table');
            } finally {
              setDeletingTableId(null);
            }
          }
        }}
        onCancel={() => setDeleteTableConfirm({ show: false, tableId: null, tableName: null })}
      />

      {showCreateTournament && resolvedClubId && (
        <CreateTournamentModal
          clubId={resolvedClubId}
          unionId={unionIdForCreate}
          initialFormat={
            gameType === 'SPIN' ? 'spin' : gameType === 'SNG' ? 'sng' : 'mtt_freezeout'
          }
          onClose={() => setShowCreateTournament(false)}
          onSuccess={() => {
            setShowCreateTournament(false);
            haptic.success();
            toast.success('Tournament created successfully');
            // Tables auto-refresh via the visibility hook / focus return
          }}
        />
      )}
    </div>
  );
}

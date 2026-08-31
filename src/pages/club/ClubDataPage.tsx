/**
 * CLUB DATA
 * ============================================================================
 * The club owner's real-time view of what their club is generating, and what
 * they owe the union at the end of the week.
 *
 * Data comes from two RPCs, both gated server-side by
 * ca_can_view_club_finances (owner / admin / super_agent, or platform admin):
 *
 *   ca_club_data_snapshot     summary tiles + one row per game, and the same
 *                             summary for the equal-length window immediately
 *                             before it, so a headline number can be read
 *                             against what it was. Cash figures come from the
 *                             club_table_daily rollup because expanding rake
 *                             attribution live over a fourteen-day window does
 *                             not finish inside the statement timeout;
 *                             tournaments and spins are computed live.
 *   ca_club_player_breakdown  per-player net and rake over the same window.
 *                             The per-game list cannot answer "which of my
 *                             players is winning", which is the question a club
 *                             owner actually asks.
 *   ca_club_union_invoices    the weekly square-up statements the union issues
 *                             every Monday.
 *
 * The client gate below is cosmetic. The RPCs raise 42501 on their own.
 *
 * Dates are UTC end to end, because the rollup the cash figures come from is
 * keyed on UTC days. The range chip says UTC rather than showing a bare date
 * that disagrees with the reader's own calendar late in their evening.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { sizedStorageUrl, generateAvatarSvg } from '../../utils/avatarGenerator';
import { useAuthUser } from '../../hooks/useAuthUser';
import { resolveClubUUID, isUUID } from '../../utils/clubIdResolver';
import { isAuthzError } from '../../utils/clubDashboard';
import { reportError } from '../../utils/errorReporter';
import { downloadCsv, csvEscape } from '../../utils/downloadCsv';
import {
  fetchClubDataExport,
  isClubDataExportAbort,
  type ClubDataExportProgress,
} from '../../utils/clubDataExport';
import { retryFetch } from '../../utils/retryFetch';
import { uuid } from '../../utils/uuid';
import {
  clubDataQueryKey,
  readClubDataCache,
  removeClubDataCaches,
  writeClubDataCache,
} from '../../lib/clubDataCache';
import {
  auditClubDataSnapshot,
  formatClubDataAge,
  preserveExpandedClubDataRows,
} from '../../lib/clubDataIntegrity';
import { useMasterBusChannel } from '../../hooks/useMasterBusChannel';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import type { BusEventType } from '../../core/MasterBus';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { EmptyState, LoadingState, PermissionState } from '../../components/common/EmptyState';
import styles from './ClubDataPage.module.css';

type PresetId = 1 | 7 | 14;
type GameFilter = 'ALL' | 'HOLDEM' | 'OMAHA' | 'MIXED' | 'MTT' | 'SNG';
type StakesFilter = 'ALL' | 'MICRO' | 'SMALL' | 'MID' | 'HIGH';
type GameSort = 'recent' | 'fee' | 'winnings' | 'hands';

interface SnapshotRow {
  kind: string;
  id: string;
  name: string;
  variant: string;
  game_class: string;
  stakes_tier: string;
  blinds: string | null;
  rake_percent: number | null;
  started_at: string | null;
  status: string | null;
  creator_id: string | null;
  creator_name: string | null;
  creator_avatar: string | null;
  fee: number;
  winnings: number;
  hands: number;
  players: number;
}

interface SnapshotSummary {
  games: number;
  total_winnings: number;
  mtt_winnings: number;
  cash_winnings: number;
  fee: number;
  cash_fee?: number;
  mtt_fee?: number;
  hands: number;
}

interface Snapshot {
  range: { start: string; end: string; days: number };
  previous_range: { start: string; end: string; days: number };
  summary: SnapshotSummary;
  // the same summary for the window immediately before this one, same filters
  previous: SnapshotSummary;
  // pct fields are null when the prior window is zero: there is no baseline to
  // be a percentage of, and "+100%" against nothing would be a lie
  delta: {
    fee_pct: number | null;
    games_pct: number | null;
    winnings_abs: number;
    fee_abs: number;
  };
  rows: SnapshotRow[];
  row_count: number;
  union_id: string | null;
  data_updated_at: string | null;
  generated_at: string;
}

interface PlayerRow {
  user_id: string;
  username: string;
  avatar_url: string | null;
  is_horse: boolean;
  net: number;
  cash_net: number;
  tournament_net: number;
  rake: number;
  hands: number;
}

interface PlayerBreakdown {
  range: { start: string; end: string; days: number };
  // per-player rake comes from the daily rollup, which only finalises complete
  // UTC days, so today is not in it. Surfaced rather than quietly short.
  rake_complete_through: string | null;
  totals: { players: number; net: number; rake: number; hands: number };
  players: PlayerRow[];
  player_count: number;
  generated_at: string;
}

interface PageCursor {
  [key: string]: string | number;
}

interface GamePage {
  rows: SnapshotRow[];
  next_cursor: PageCursor | null;
  has_more: boolean;
  filtered_count?: number | null;
  generated_at: string;
}

interface PlayerPage {
  rows: PlayerRow[];
  next_cursor: PageCursor | null;
  has_more: boolean;
  filtered_count: number;
  generated_at: string;
}

interface InvoiceRow {
  invoice_id: string;
  status: string;
  issued_at: string;
  due_at: string | null;
  amount: number;
  direction: string | null;
  period_start: string | null;
  period_end: string | null;
  breakdown: Record<string, unknown> | null;
  message_sent: boolean;
}

const GAME_FILTERS: Array<{ id: GameFilter; label: string }> = [
  { id: 'ALL', label: 'ALL' },
  { id: 'HOLDEM', label: "Hold'em" },
  { id: 'OMAHA', label: 'Omaha' },
  { id: 'MIXED', label: 'Mixed' },
  { id: 'MTT', label: 'MTT' },
  { id: 'SNG', label: 'Heads Up' },
];

const STAKES_FILTERS: Array<{ id: StakesFilter; label: string }> = [
  { id: 'MICRO', label: 'Micro' },
  { id: 'SMALL', label: 'Small' },
  { id: 'MID', label: 'Mid' },
  { id: 'HIGH', label: 'High' },
];

const GAME_SORTS: Array<{ id: GameSort; label: string }> = [
  { id: 'recent', label: 'Most Recent' },
  { id: 'fee', label: 'Highest Fee' },
  { id: 'winnings', label: 'Highest Net' },
  { id: 'hands', label: 'Most Hands' },
];

type PlayerSort = 'winners' | 'losers' | 'rake' | 'hands';

const PLAYER_SORTS: Array<{ id: PlayerSort; label: string }> = [
  { id: 'winners', label: 'Biggest Winners' },
  { id: 'losers', label: 'Biggest Losers' },
  { id: 'rake', label: 'Most Rake' },
  { id: 'hands', label: 'Most Hands' },
];

const REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PLAYER_REQUEST_TIMEOUT_MS = 25_000;
const PLAYER_PAGE_SIZE = 100;
const GAME_PAGE_SIZE = 100;
const DATA_ROW_HEIGHT = 92;
const DATA_VIEWPORT_HEIGHT = 736;
const COLD_READ_ATTEMPT_TIMEOUT_MS = 12_000;
const COLD_READ_RETRY_DELAY_MS = 350;
const CLUB_DATA_BUS_EVENTS: BusEventType[] = [
  'CLUB_UPDATED',
  'BALANCE_UPDATED',
  'TABLE_UPDATED',
  'TABLE_CLOSED',
  'TABLE_CREATED',
  'TOURNAMENT_UPDATED',
  'SETTLEMENT_COMPLETED',
  'SETTLEMENT_CYCLE_COMPLETED',
  'MEMBER_ROLE_CHANGED',
];
type RealtimeFeed = 'tables' | 'tournaments' | 'invoices' | 'members';
type RealtimeFeedState = 'connecting' | 'live' | 'degraded';
const INITIAL_REALTIME_FEEDS: Record<RealtimeFeed, RealtimeFeedState> = {
  tables: 'connecting',
  tournaments: 'connecting',
  invoices: 'connecting',
  members: 'connecting',
};

interface CachedGameLedger {
  snapshot: Snapshot;
  cursor: PageCursor | null;
  hasMore: boolean;
}

interface PrefetchedGamePage {
  key: string;
  rows: SnapshotRow[];
  nextCursor: PageCursor | null;
  hasMore: boolean;
}

interface CachedPlayerLedger {
  players: PlayerBreakdown;
  cursor: PageCursor | null;
  hasMore: boolean;
}

/** What a money tile shows when there is no figure to show. Never "0.00". */
const NO_VALUE = '-';

type AbortableRequest<T> = PromiseLike<T> & {
  abortSignal?: (signal: AbortSignal) => AbortableRequest<T>;
};

function withTimeout<T>(
  request: AbortableRequest<T>,
  message: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(message));
    }, timeoutMs);
  });
  const abortableRequest =
    typeof request.abortSignal === 'function' ? request.abortSignal(controller.signal) : request;

  return Promise.race([Promise.resolve(abortableRequest), timeout])
    .catch((error: unknown) => {
      if (timedOut) throw new Error(message);
      throw error;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/**
 * A newly scaled-to-zero database connection can cancel the first reporting
 * statement while a later attempt succeeds. Production contention can outlive
 * two attempts (the health probe and even a one-row club-name read have timed
 * out together), so first paint gets four bounded attempts. These RPCs are
 * read-only and each attempt owns its AbortSignal. Continuation reads may use
 * fewer attempts because already-rendered rows remain usable.
 */
function coldRead<T>(
  request: () => AbortableRequest<T>,
  message: string,
  maxRetries = 3
): Promise<T> {
  return retryFetch(() => withTimeout(request(), message, COLD_READ_ATTEMPT_TIMEOUT_MS), {
    maxRetries,
    baseDelayMs: COLD_READ_RETRY_DELAY_MS,
  });
}

/**
 * Every other timestamp on this page is UTC and the range chip is badged UTC.
 * This one was the browser's local zone with no marker, so "updated 19:42"
 * could look like it preceded a range ending "today". No isNaN guard either -
 * a malformed value rendered "Invalid Date".
 */
function utcTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return `${d.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })} UTC`;
}

function recentCursor(rows: SnapshotRow[]): PageCursor | null {
  const last = rows[rows.length - 1];
  if (!last?.started_at) return null;
  const epoch = Date.parse(last.started_at) / 1000;
  if (!Number.isFinite(epoch)) return null;
  return { value: epoch, time: epoch, kind: last.kind, id: last.id };
}

/** settlement_invoices.status reached the owner raw: "awaiting_payment". */
function invoiceStatusLabel(status: string): string {
  return String(status)
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** " (90%)" when both figures are real, empty string otherwise. */
function splitPct(part: unknown, whole: unknown): string {
  const p = Number(part);
  const w = Number(whole);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w === 0) return '';
  return ` (${Math.round((p / w) * 100)}%)`;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function money(n: number | null | undefined): string {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function compactInt(n: number | null | undefined): string {
  return Number(n || 0).toLocaleString('en-US');
}

function badgeClass(row: SnapshotRow): string {
  if (row.kind === 'MTT') return `${styles.badge} ${styles.badgeMtt}`;
  if (row.kind === 'SNG') return `${styles.badge} ${styles.badgeSng}`;
  if (row.kind === 'SPIN') return `${styles.badge} ${styles.badgeSpin}`;
  return styles.badge;
}

function rowsToCsv(rows: SnapshotRow[]): string {
  const esc = csvEscape;
  const head = [
    'started_at',
    'kind',
    'name',
    'variant',
    'blinds',
    'rake_percent',
    'hands',
    'players',
    'fee',
    'winnings',
  ];
  const lines = rows.map((r) =>
    [
      r.started_at,
      r.kind,
      r.name,
      r.variant,
      r.blinds,
      r.rake_percent,
      r.hands,
      r.players,
      r.fee,
      r.winnings,
    ]
      .map(esc)
      .join(',')
  );
  return [head.join(','), ...lines].join('\n');
}

function playersToCsv(rows: PlayerRow[]): string {
  const esc = csvEscape;
  const head = ['user_id', 'username', 'hands', 'rake', 'net', 'cash_net', 'tournament_net'];
  const lines = rows.map((r) =>
    [r.user_id, r.username, r.hands, r.rake, r.net, r.cash_net, r.tournament_net].map(esc).join(',')
  );
  return [head.join(','), ...lines].join('\n');
}

export default function ClubDataPage() {
  const navigate = useNavigate();
  const params = useParams<{ clubId?: string }>();
  const [searchParams] = useSearchParams();
  const { user, isHydrating } = useAuthUser();

  const clubParam = params.clubId || searchParams.get('club') || '';

  const [clubUuid, setClubUuid] = useState<string | null>(isUUID(clubParam) ? clubParam : null);
  const [clubName, setClubName] = useState<string>('');
  const [preset, setPreset] = useState<PresetId>(14);
  const [endDate, setEndDate] = useState<string>(() => toISODate(new Date()));
  const [game, setGame] = useState<GameFilter>('ALL');
  const [stakes, setStakes] = useState<StakesFilter>('ALL');
  const [gameSort, setGameSort] = useState<GameSort>('recent');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [gameCursor, setGameCursor] = useState<PageCursor | null>(null);
  const [gamesHasMore, setGamesHasMore] = useState(false);
  const [gamesLoadingMore, setGamesLoadingMore] = useState(false);
  const [gamesPageError, setGamesPageError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [showInvoiceDetail, setShowInvoiceDetail] = useState(false);
  const [showInvoiceHistory, setShowInvoiceHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ClubDataExportProgress | null>(null);
  const [ledgerSource, setLedgerSource] = useState<'cold' | 'cached' | 'live' | 'degraded'>('cold');
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [tab, setTab] = useState<'games' | 'players'>('games');
  /** Read by the poll/visibility handlers, which must not re-register per tab. */
  const tabRef = useRef<'games' | 'players'>('games');
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  const [players, setPlayers] = useState<PlayerBreakdown | null>(null);
  const [playersLoading, setPlayersLoading] = useState(false);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [playerSort, setPlayerSort] = useState<PlayerSort>('winners');
  const [playerCursor, setPlayerCursor] = useState<PageCursor | null>(null);
  const [playersHasMore, setPlayersHasMore] = useState(false);
  const [playersLoadingMore, setPlayersLoadingMore] = useState(false);
  const [playersPageError, setPlayersPageError] = useState<string | null>(null);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<number | null>(null);
  const [lastRequestMs, setLastRequestMs] = useState<number | null>(null);
  const [telemetryClock, setTelemetryClock] = useState(() => Date.now());
  const [realtimeFeeds, setRealtimeFeeds] =
    useState<Record<RealtimeFeed, RealtimeFeedState>>(INITIAL_REALTIME_FEEDS);

  // cancelledRef guards UNMOUNT. It cannot tell a stale response from a fresh
  // one, and this page reloads on six different inputs plus a 60s poll plus
  // every visibilitychange - so tapping HOLDEM then OMAHA could land the older
  // payload last, leaving the chips saying one thing and the money another.
  // A version per request fixes the ordering; the ref still handles unmount.
  const loadVersion = useRef(0);
  const playersVersion = useRef(0);
  const invoicesVersion = useRef(0);
  const resolveVersion = useRef(0);
  const clubNameVersion = useRef(0);
  const gamesMoreRef = useRef(false);
  const snapshotRef = useRef<Snapshot | null>(null);
  const gameCursorRef = useRef<PageCursor | null>(null);
  const prefetchedGamePageRef = useRef<PrefetchedGamePage | null>(null);
  const playersRef = useRef<PlayerBreakdown | null>(null);
  const playerCursorRef = useRef<PageCursor | null>(null);
  const playersMoreRef = useRef(false);
  const exportControllerRef = useRef<AbortController | null>(null);
  const restoredGameKeyRef = useRef<string | null>(null);
  const restoredGameCacheHitRef = useRef(false);
  const restoredPlayerKeyRef = useRef<string | null>(null);
  const restoredInvoiceKeyRef = useRef<string | null>(null);
  const eventRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEventRefreshRef = useRef({ ledger: false, invoices: false });
  const cancelledRef = useRef(false);
  const gamesTabRef = useRef<HTMLButtonElement>(null);
  const playersTabRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      exportControllerRef.current?.abort();
      if (eventRefreshTimerRef.current) clearTimeout(eventRefreshTimerRef.current);
    };
  }, []);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    gameCursorRef.current = gameCursor;
  }, [gameCursor]);
  useEffect(() => {
    playersRef.current = players;
  }, [players]);
  useEffect(() => {
    playerCursorRef.current = playerCursor;
  }, [playerCursor]);

  // debounce the search box so typing does not fire an RPC per keystroke
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const startDate = useMemo(() => {
    const d = new Date(`${endDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (preset - 1));
    return toISODate(d);
  }, [endDate, preset]);

  const isToday = endDate >= toISODate(new Date());

  const gameCacheKey = useMemo(
    () =>
      clubDataQueryKey({
        kind: 'games',
        startDate,
        endDate,
        game,
        stakes,
        search,
        gameSort,
      }),
    [startDate, endDate, game, stakes, search, gameSort]
  );
  const playerCacheKey = useMemo(
    () => clubDataQueryKey({ kind: 'players', startDate, endDate, playerSort }),
    [startDate, endDate, playerSort]
  );
  const invoiceCacheKey = 'kind=invoices';

  // Invalidate every club-scoped value before the browser paints a new route.
  // A normal effect runs after paint; that left one frame where changing from
  // one club slug to another showed the first club's money under the new URL.
  useLayoutEffect(() => {
    loadVersion.current += 1;
    playersVersion.current += 1;
    invoicesVersion.current += 1;
    resolveVersion.current += 1;
    clubNameVersion.current += 1;
    setClubUuid(isUUID(clubParam) ? clubParam : null);
    setClubName('');
    setSnapshot(null);
    snapshotRef.current = null;
    setGameCursor(null);
    gameCursorRef.current = null;
    prefetchedGamePageRef.current = null;
    setGamesHasMore(false);
    setGamesLoadingMore(false);
    setGamesPageError(null);
    setInvoices([]);
    setPlayers(null);
    playersRef.current = null;
    setPlayerCursor(null);
    playerCursorRef.current = null;
    setPlayersHasMore(false);
    setPlayersLoadingMore(false);
    setPlayersPageError(null);
    setError(null);
    setInvoicesError(null);
    setPlayersError(null);
    setExportNote(null);
    setRefreshNote(null);
    setLedgerSource('cold');
    setLastVerifiedAt(null);
    setLastRequestMs(null);
    setRealtimeFeeds(INITIAL_REALTIME_FEEDS);
    restoredGameKeyRef.current = null;
    restoredGameCacheHitRef.current = false;
    restoredPlayerKeyRef.current = null;
    restoredInvoiceKeyRef.current = null;
    if (eventRefreshTimerRef.current) clearTimeout(eventRefreshTimerRef.current);
    eventRefreshTimerRef.current = null;
    pendingEventRefreshRef.current = { ledger: false, invoices: false };
    setShowInvoiceDetail(false);
    setShowInvoiceHistory(false);
    setLoading(Boolean(clubParam));
    setPlayersLoading(false);
    setInvoicesLoading(false);
  }, [clubParam]);

  // Resolve a club code or slug only after auth restoration. A protected club
  // lookup that races the session can return "not found" for a valid club and
  // never retry when the user arrives.
  useEffect(() => {
    let cancelled = false;
    if (!clubParam || isUUID(clubParam) || isHydrating || !user) return;
    const myVersion = ++resolveVersion.current;
    const stale = () => cancelled || resolveVersion.current !== myVersion;
    withTimeout(resolveClubUUID(clubParam), 'Club lookup timed out')
      .then((uuid) => {
        if (stale()) return;
        // isUUID, not truthiness: resolveClubUUID returns the INPUT unchanged
        // when it cannot resolve, so this branch was unreachable and the
        // comment below described a fix the code did not implement - a bad club
        // code went straight into ca_club_data_snapshot as p_club_id.
        if (isUUID(uuid)) {
          setClubUuid(uuid);
          return;
        }
        // A club code that resolves to nothing used to leave clubUuid null with
        // no error set, and load() bails before its try/finally - so `loading`
        // stayed true and the page showed skeleton rows forever with no way
        // out. Same failure shape as the messenger's "Loading your clubs...".
        setClubUuid(null);
        setError('Club not found.');
        setLoading(false);
      })
      .catch((err) => {
        reportError(err, 'ClubDataPage.resolve_club');
        if (stale()) return;
        setError('Club not found.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clubParam, isHydrating, user]);

  useEffect(() => {
    if (!clubUuid || isHydrating || !user) return;
    let cancelled = false;
    const myVersion = ++clubNameVersion.current;
    const stale = () => cancelled || clubNameVersion.current !== myVersion;
    withTimeout(
      supabase.from('clubs').select('name').eq('id', clubUuid).maybeSingle(),
      'Club name request timed out'
    ).then(
      ({ data }) => {
        if (!stale()) setClubName(data?.name || '');
      },
      (err: unknown) => {
        if (!stale()) reportError(err, 'ClubDataPage.club_name');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [clubUuid, isHydrating, user]);

  const load = useCallback(
    async (showSpinner: boolean, preserveOnError = false): Promise<boolean> => {
      if (!clubUuid || isHydrating || !user) return false;
      const requestStartedAt = performance.now();
      const myVersion = ++loadVersion.current;
      const stale = () => cancelledRef.current || loadVersion.current !== myVersion;
      if (showSpinner) setLoading(true);
      setGamesPageError(null);
      try {
        // The snapshot already owns the optimized recent-row query. Running a
        // second 42k-row page sort beside it doubled cold database pressure and
        // could cancel both statements before the first paint. Recent is the
        // default view, so let one bounded RPC return its summary, count, and
        // first 100 rows. Non-recent sorts still use the page RPC in parallel.
        const snapshotRequest = coldRead(
          () =>
            supabase.rpc('ca_club_data_snapshot', {
              p_club_id: clubUuid,
              p_start: startDate,
              p_end: endDate,
              p_game: game,
              p_stakes: stakes,
              p_search: search || null,
              // Keep the first continuation inside the same bounded snapshot
              // read. Only the first 100 rows paint; the verified remainder is
              // held locally until the operator asks for it.
              p_limit: gameSort === 'recent' ? GAME_PAGE_SIZE * 2 : 1,
            }),
          'Club data request timed out'
        );
        const pageRequest =
          gameSort === 'recent'
            ? Promise.resolve(null)
            : coldRead(
                () =>
                  supabase.rpc('ca_club_game_page', {
                    p_club_id: clubUuid,
                    p_start: startDate,
                    p_end: endDate,
                    p_game: game,
                    p_stakes: stakes,
                    p_search: search || null,
                    p_sort: gameSort,
                    p_cursor: null,
                    // Metric ordering must aggregate Shark Club's 43k+ game
                    // window before it can rank anything. Fetch the next
                    // visible slice in the same pass so the first Load More
                    // does not repeat that expensive sort in every open tab.
                    p_limit: GAME_PAGE_SIZE * 2,
                  }),
                'Club games request timed out'
              );
        const [snapshotResult, pageResult] = await Promise.all([snapshotRequest, pageRequest]);
        if (stale()) return false;
        const rpcError = snapshotResult.error || pageResult?.error;
        const data = snapshotResult.data;
        const page = pageResult?.data as GamePage | null | undefined;
        if (rpcError) {
          if (isAuthzError(rpcError)) {
            setError('You need to be an owner or admin of this club to see its data.');
            removeClubDataCaches(user.id, clubUuid);
            setLedgerSource('cold');
          } else {
            reportError(rpcError, 'ClubDataPage.snapshot_rpc');
            if (preserveOnError) {
              setError(null);
              setLedgerSource('degraded');
            } else {
              setError('Could not load club data.');
            }
          }
          if (isAuthzError(rpcError) || !preserveOnError) setSnapshot(null);
          return false;
        } else if (
          !auditClubDataSnapshot(data).renderable ||
          (gameSort !== 'recent' && (!page || !Array.isArray(page.rows)))
        ) {
          // A null or shapeless payload used to be stored as success, leaving a
          // page with no data, no skeleton and no message.
          reportError(new Error('snapshot payload was empty'), 'ClubDataPage.snapshot_shape');
          if (preserveOnError) {
            setError(null);
            setLedgerSource('degraded');
          } else {
            setError('Could not load club data.');
            setSnapshot(null);
          }
          return false;
        } else {
          const snapshot = data as Snapshot;
          const currentRows = snapshotRef.current?.rows || [];
          const sourceRows = gameSort === 'recent' ? snapshot.rows : page!.rows;
          const keepExpandedSourceRows = preserveOnError && currentRows.length > GAME_PAGE_SIZE;
          const refreshedRows = keepExpandedSourceRows
            ? sourceRows
            : sourceRows.slice(0, GAME_PAGE_SIZE);
          const rows = preserveExpandedClubDataRows(currentRows, refreshedRows, preserveOnError);
          const nextSnapshot = {
            ...snapshot,
            rows,
            row_count: Number(page?.filtered_count ?? snapshot.row_count),
          };
          const keptExpandedRows = rows.length > refreshedRows.length;
          const sourceCursor =
            gameSort === 'recent' ? recentCursor(sourceRows) : page!.next_cursor || null;
          const sourceHasMore =
            gameSort === 'recent'
              ? Number(snapshot.row_count) > sourceRows.length
              : Boolean(page!.has_more);
          const prefetchedRows = keepExpandedSourceRows ? [] : sourceRows.slice(GAME_PAGE_SIZE);
          prefetchedGamePageRef.current = prefetchedRows.length
            ? {
                key: gameCacheKey,
                rows: prefetchedRows,
                nextCursor: sourceCursor,
                hasMore: sourceHasMore,
              }
            : null;
          const nextCursor = keptExpandedRows ? gameCursorRef.current : sourceCursor;
          const nextHasMore = Number(nextSnapshot.row_count) > rows.length;
          setError(null);
          setSnapshot(nextSnapshot);
          snapshotRef.current = nextSnapshot;
          setGameCursor(nextCursor);
          gameCursorRef.current = nextCursor;
          setGamesHasMore(nextHasMore);
          setLedgerSource('live');
          setLastVerifiedAt(Date.now());
          const cachedSnapshot = prefetchedRows.length
            ? { ...nextSnapshot, rows: [...rows, ...prefetchedRows] }
            : nextSnapshot;
          writeClubDataCache<CachedGameLedger>(user.id, clubUuid, gameCacheKey, {
            snapshot: cachedSnapshot,
            cursor: prefetchedRows.length ? sourceCursor : nextCursor,
            hasMore: prefetchedRows.length ? sourceHasMore : nextHasMore,
          });
          return true;
        }
      } catch (err) {
        if (stale()) return false;
        reportError(err, 'ClubDataPage.snapshot_request');
        if (preserveOnError) {
          setError(null);
          setLedgerSource('degraded');
        } else {
          setError('Club data took too long to respond. Try again.');
          setSnapshot(null);
        }
        return false;
      } finally {
        // Only the newest request may clear the skeleton. A background poll that
        // finished first used to pull it out from under a load the user had just
        // started, leaving stale rows looking settled.
        if (!stale()) {
          setLastRequestMs(Math.max(0, Math.round(performance.now() - requestStartedAt)));
          setLoading(false);
        }
      }
    },
    [clubUuid, startDate, endDate, game, stakes, search, gameSort, isHydrating, user, gameCacheKey]
  );

  useEffect(() => {
    if (!clubUuid || isHydrating || !user) return;
    const restoreKey = `${user.id}:${clubUuid}:${gameCacheKey}`;
    if (restoredGameKeyRef.current === restoreKey) return;
    restoredGameKeyRef.current = restoreKey;
    restoredGameCacheHitRef.current = false;
    const cached = readClubDataCache<CachedGameLedger>(user.id, clubUuid, gameCacheKey);
    if (!cached?.snapshot || !auditClubDataSnapshot(cached.snapshot).renderable) {
      if (cached) removeClubDataCaches(user.id, clubUuid);
      return;
    }
    restoredGameCacheHitRef.current = true;
    setSnapshot(cached.snapshot);
    snapshotRef.current = cached.snapshot;
    setGameCursor(cached.cursor);
    gameCursorRef.current = cached.cursor;
    setGamesHasMore(cached.hasMore);
    setLoading(false);
    setError(null);
    setLedgerSource('cached');
    const generatedAt = Date.parse(cached.snapshot.generated_at);
    setLastVerifiedAt(Number.isFinite(generatedAt) ? generatedAt : Date.now());
  }, [clubUuid, gameCacheKey, isHydrating, user]);

  useEffect(() => {
    if (!snapshot) return;
    setTelemetryClock(Date.now());
    const id = setInterval(() => setTelemetryClock(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [snapshot]);

  useEffect(() => {
    if (!clubUuid || isHydrating || !user) return;
    const restored = restoredGameCacheHitRef.current;
    void load(!restored, restored);
  }, [load, clubUuid, gameCacheKey, isHydrating, user]);

  // Players are fetched only when that tab is open. It is a second scan over
  // the same window and there is no reason to pay for it on every visit.
  const loadPlayers = useCallback(
    async (preserveOnError = false): Promise<boolean> => {
      if (!clubUuid || isHydrating || !user) return false;
      // Pagination owns the cursor while it is in flight. A heartbeat is a
      // recovery mechanism, not a reason to invalidate that user action.
      if (preserveOnError && playersMoreRef.current) return true;
      const myVersion = ++playersVersion.current;
      const stale = () => cancelledRef.current || playersVersion.current !== myVersion;
      setPlayersLoading(true);
      setPlayersError(null);
      setPlayersPageError(null);
      try {
        const [breakdownResult, pageResult] = await Promise.all([
          coldRead(
            () =>
              supabase.rpc('ca_club_player_breakdown', {
                p_club_id: clubUuid,
                p_start: startDate,
                p_end: endDate,
                p_limit: 1,
              }),
            'Player totals request timed out'
          ),
          coldRead(
            () =>
              supabase.rpc('ca_club_player_page', {
                p_club_id: clubUuid,
                p_start: startDate,
                p_end: endDate,
                p_sort: playerSort,
                p_search: null,
                p_cursor: null,
                p_limit: PLAYER_PAGE_SIZE,
              }),
            'Player data request timed out'
          ),
        ]);
        if (stale()) return false;
        const rpcError = breakdownResult.error || pageResult.error;
        const data = breakdownResult.data;
        const page = pageResult.data as PlayerPage | null;
        if (rpcError) {
          if (isAuthzError(rpcError)) {
            setPlayersError('You need to be an owner or admin of this club to see player data.');
            removeClubDataCaches(user.id, clubUuid);
          } else {
            reportError(rpcError, 'ClubDataPage.players_rpc');
            setPlayersError(preserveOnError ? null : 'Could not load player data.');
          }
          if (isAuthzError(rpcError) || !preserveOnError) setPlayers(null);
          return false;
        } else if (
          !data ||
          !Array.isArray((data as PlayerBreakdown).players) ||
          !page ||
          !Array.isArray(page.rows)
        ) {
          reportError(new Error('player payload was empty'), 'ClubDataPage.players_shape');
          setPlayersError(preserveOnError ? null : 'Could not load player data.');
          if (!preserveOnError) setPlayers(null);
          return false;
        } else {
          const breakdown = data as PlayerBreakdown;
          const rows = preserveExpandedClubDataRows(
            playersRef.current?.players || [],
            page.rows,
            preserveOnError
          );
          const playerCount = Number(page.filtered_count ?? breakdown.player_count);
          const keptExpandedRows = rows.length > page.rows.length;
          const nextPlayers = { ...breakdown, players: rows, player_count: playerCount };
          const nextCursor = keptExpandedRows ? playerCursorRef.current : page.next_cursor || null;
          const nextHasMore = playerCount > rows.length;
          setPlayersError(null);
          setPlayers(nextPlayers);
          playersRef.current = nextPlayers;
          setPlayerCursor(nextCursor);
          playerCursorRef.current = nextCursor;
          setPlayersHasMore(nextHasMore);
          writeClubDataCache<CachedPlayerLedger>(user.id, clubUuid, playerCacheKey, {
            players: nextPlayers,
            cursor: nextCursor,
            hasMore: nextHasMore,
          });
          return true;
        }
      } catch (err) {
        if (stale()) return false;
        reportError(err, 'ClubDataPage.players_request');
        setPlayersError(
          preserveOnError ? null : 'Player data took too long to respond. Try again.'
        );
        if (!preserveOnError) setPlayers(null);
        return false;
      } finally {
        if (!stale()) setPlayersLoading(false);
      }
    },
    [clubUuid, startDate, endDate, playerSort, isHydrating, user, playerCacheKey]
  );

  useEffect(() => {
    if (tab !== 'players') return;
    if (!clubUuid || isHydrating || !user) return;
    const restoreKey = `${user.id}:${clubUuid}:${playerCacheKey}`;
    let preserveExistingRows = true;
    if (restoredPlayerKeyRef.current !== restoreKey) {
      restoredPlayerKeyRef.current = restoreKey;
      const cached = readClubDataCache<CachedPlayerLedger>(user.id, clubUuid, playerCacheKey);
      if (cached?.players && Array.isArray(cached.players.players)) {
        setPlayers(cached.players);
        playersRef.current = cached.players;
        setPlayerCursor(cached.cursor);
        playerCursorRef.current = cached.cursor;
        setPlayersHasMore(cached.hasMore);
        setPlayersLoading(false);
        setPlayersError(null);
      } else {
        // A new range/sort is a different ledger. Do not mistake rows from the
        // previous query for an expanded window that should survive refresh.
        preserveExistingRows = false;
        setPlayers(null);
        playersRef.current = null;
        setPlayerCursor(null);
        playerCursorRef.current = null;
        setPlayersHasMore(false);
      }
    }
    void loadPlayers(preserveExistingRows);
  }, [tab, loadPlayers, clubUuid, isHydrating, user, playerCacheKey]);

  const loadMoreGames = useCallback(async () => {
    if (!clubUuid || gamesMoreRef.current || isHydrating || !user) return;
    const prefetched = prefetchedGamePageRef.current;
    const current = snapshotRef.current;
    if (prefetched?.key === gameCacheKey && prefetched.rows.length && current) {
      const known = new Set(current.rows.map((row) => `${row.kind}:${row.id}`));
      const nextSnapshot = {
        ...current,
        rows: [
          ...current.rows,
          ...prefetched.rows.filter((row) => !known.has(`${row.kind}:${row.id}`)),
        ],
      };
      prefetchedGamePageRef.current = null;
      setSnapshot(nextSnapshot);
      snapshotRef.current = nextSnapshot;
      setGameCursor(prefetched.nextCursor);
      gameCursorRef.current = prefetched.nextCursor;
      setGamesHasMore(prefetched.hasMore);
      writeClubDataCache<CachedGameLedger>(user.id, clubUuid, gameCacheKey, {
        snapshot: nextSnapshot,
        cursor: prefetched.nextCursor,
        hasMore: prefetched.hasMore,
      });
      return;
    }
    if (!gameCursor || !gamesHasMore) return;
    gamesMoreRef.current = true;
    setGamesLoadingMore(true);
    setGamesPageError(null);
    const myVersion = loadVersion.current;
    const stale = () => cancelledRef.current || loadVersion.current !== myVersion;
    try {
      // Recent ordering is the one PostgreSQL is most likely to cancel on a
      // cold cache. The first screen is already visible, so two safe read-only
      // retries are preferable to turning a transient cancellation into a
      // dead Load More control.
      const { data, error: pageError } = await coldRead(
        () =>
          supabase.rpc('ca_club_game_page', {
            p_club_id: clubUuid,
            p_start: startDate,
            p_end: endDate,
            p_game: game,
            p_stakes: stakes,
            p_search: search || null,
            p_sort: gameSort,
            p_cursor: gameCursor,
            p_limit: GAME_PAGE_SIZE,
          }),
        'More games request timed out',
        2
      );
      if (stale()) return;
      const page = data as GamePage | null;
      if (pageError || !page || !Array.isArray(page.rows)) {
        if (pageError && !isAuthzError(pageError))
          reportError(pageError, 'ClubDataPage.games_page_rpc');
        setGamesPageError(
          isAuthzError(pageError)
            ? 'You No Longer Have Access To This Club\u2019s Data.'
            : 'Could Not Load More Games.'
        );
        if (isAuthzError(pageError)) {
          removeClubDataCaches(user.id, clubUuid);
          setSnapshot(null);
          setGamesHasMore(false);
        }
        return;
      }
      const current = snapshotRef.current;
      if (current) {
        const known = new Set(current.rows.map((row) => `${row.kind}:${row.id}`));
        const nextSnapshot = {
          ...current,
          rows: [
            ...current.rows,
            ...page.rows.filter((row) => !known.has(`${row.kind}:${row.id}`)),
          ],
        };
        setSnapshot(nextSnapshot);
        snapshotRef.current = nextSnapshot;
      }
      setGameCursor(page.next_cursor || null);
      gameCursorRef.current = page.next_cursor || null;
      setGamesHasMore(Boolean(page.has_more));
    } catch (pageError) {
      if (stale()) return;
      reportError(pageError, 'ClubDataPage.games_page_request');
      setGamesPageError('Could Not Load More Games.');
    } finally {
      gamesMoreRef.current = false;
      if (!stale()) setGamesLoadingMore(false);
    }
  }, [
    clubUuid,
    gameCursor,
    gamesHasMore,
    isHydrating,
    user,
    startDate,
    endDate,
    game,
    stakes,
    search,
    gameSort,
    gameCacheKey,
  ]);

  const loadMorePlayers = useCallback(async () => {
    if (
      !clubUuid ||
      !playerCursor ||
      !playersHasMore ||
      playersMoreRef.current ||
      isHydrating ||
      !user
    )
      return;
    playersMoreRef.current = true;
    setPlayersLoadingMore(true);
    setPlayersPageError(null);
    const myVersion = playersVersion.current;
    const stale = () => cancelledRef.current || playersVersion.current !== myVersion;
    try {
      const { data, error: pageError } = await withTimeout(
        supabase.rpc('ca_club_player_page', {
          p_club_id: clubUuid,
          p_start: startDate,
          p_end: endDate,
          p_sort: playerSort,
          p_search: null,
          p_cursor: playerCursor,
          p_limit: PLAYER_PAGE_SIZE,
        }),
        'More players request timed out',
        PLAYER_REQUEST_TIMEOUT_MS
      );
      if (stale()) return;
      const page = data as PlayerPage | null;
      if (pageError || !page || !Array.isArray(page.rows)) {
        if (pageError && !isAuthzError(pageError))
          reportError(pageError, 'ClubDataPage.players_page_rpc');
        setPlayersPageError(
          isAuthzError(pageError)
            ? 'You No Longer Have Access To This Club\u2019s Player Data.'
            : 'Could Not Load More Players.'
        );
        if (isAuthzError(pageError)) {
          removeClubDataCaches(user.id, clubUuid);
          setPlayers(null);
          setPlayersHasMore(false);
        }
        return;
      }
      const current = playersRef.current;
      if (current) {
        const known = new Set(current.players.map((row) => row.user_id));
        const nextPlayers = {
          ...current,
          players: [...current.players, ...page.rows.filter((row) => !known.has(row.user_id))],
        };
        setPlayers(nextPlayers);
        playersRef.current = nextPlayers;
      }
      setPlayerCursor(page.next_cursor || null);
      playerCursorRef.current = page.next_cursor || null;
      setPlayersHasMore(Boolean(page.has_more));
    } catch (pageError) {
      if (stale()) return;
      reportError(pageError, 'ClubDataPage.players_page_request');
      setPlayersPageError('Could Not Load More Players.');
    } finally {
      playersMoreRef.current = false;
      if (!stale()) setPlayersLoadingMore(false);
    }
  }, [clubUuid, playerCursor, playersHasMore, isHydrating, user, startDate, endDate, playerSort]);

  // ca_club_player_page owns ordering before it applies the keyset cursor. A
  // client sort here would corrupt page boundaries (and was why "losers"
  // previously meant the least-positive row from the top-winners slice).
  const sortedPlayers = useMemo(() => {
    return players?.players || [];
  }, [players]);

  const gameRows = snapshot?.rows || [];
  const gameVirtual = useVirtualScroll(gameRows, {
    itemHeight: DATA_ROW_HEIGHT,
    viewportHeight: DATA_VIEWPORT_HEIGHT,
    buffer: 6,
  });
  const playerVirtual = useVirtualScroll(sortedPlayers, {
    itemHeight: DATA_ROW_HEIGHT,
    viewportHeight: DATA_VIEWPORT_HEIGHT,
    buffer: 6,
  });
  const resetGameVirtual = gameVirtual.reset;
  const resetPlayerVirtual = playerVirtual.reset;

  useEffect(() => {
    resetGameVirtual();
  }, [startDate, endDate, game, stakes, search, gameSort, resetGameVirtual]);
  useEffect(() => {
    resetPlayerVirtual();
  }, [startDate, endDate, playerSort, resetPlayerVirtual]);
  useEffect(() => {
    if (tab === 'games' && gamesHasMore && gameVirtual.endIndex >= gameRows.length - 8) {
      void loadMoreGames();
    }
  }, [tab, gamesHasMore, gameVirtual.endIndex, gameRows.length, loadMoreGames]);
  useEffect(() => {
    if (tab === 'players' && playersHasMore && playerVirtual.endIndex >= sortedPlayers.length - 8) {
      void loadMorePlayers();
    }
  }, [tab, playersHasMore, playerVirtual.endIndex, sortedPlayers.length, loadMorePlayers]);

  // near-real-time: re-poll on an interval and whenever the tab regains focus
  useEffect(() => {
    if (!clubUuid || isHydrating || !user) return;
    // Roll `endDate` forward across UTC midnight. It was set once at mount, so
    // a page left open overnight polled YESTERDAY's window forever: the owner
    // watched live rake stop growing and the forward arrow silently arm itself.
    // Only for someone still pinned to today - a deliberate step back stays.
    const pinToToday = () => {
      const today = toISODate(new Date());
      setEndDate((cur) => (cur >= today ? today : cur));
    };
    const id = setInterval(() => {
      pinToToday();
      void load(false, true);
      if (tabRef.current === 'players') void loadPlayers(true);
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      pinToToday();
      void load(false, true);
      // The Players tab was never refreshed by either trigger, so the tiles
      // ticked over every minute above a list frozen at whenever it was opened.
      if (tabRef.current === 'players') void loadPlayers(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [clubUuid, isHydrating, user, load, loadPlayers]);

  const loadInvoices = useCallback(async (): Promise<boolean> => {
    if (!clubUuid || isHydrating || !user) return false;
    const myVersion = ++invoicesVersion.current;
    const stale = () => cancelledRef.current || invoicesVersion.current !== myVersion;
    setInvoicesLoading(true);
    try {
      const { data, error: invErr } = await withTimeout(
        supabase.rpc('ca_club_union_invoices', { p_club_id: clubUuid, p_limit: 8 }),
        'Union statement request timed out'
      );
      if (stale()) return false;
      if (invErr) {
        if (!isAuthzError(invErr)) reportError(invErr, 'ClubDataPage.invoices_rpc');
        setInvoicesError(
          isAuthzError(invErr)
            ? 'You Do Not Have Access To This Club\u2019s Union Statements.'
            : 'Could Not Refresh Your Union Statement.'
        );
        // Keep the last verified statement for a transient refresh failure.
        // Authorization failures are different: stale financial data must not
        // survive after access is revoked.
        if (isAuthzError(invErr)) setInvoices([]);
        if (isAuthzError(invErr)) removeClubDataCaches(user.id, clubUuid);
        return false;
      } else {
        setInvoicesError(null);
        const rows = (data as InvoiceRow[]) || [];
        setInvoices(rows);
        writeClubDataCache<InvoiceRow[]>(user.id, clubUuid, invoiceCacheKey, rows);
        return true;
      }
    } catch (err) {
      if (stale()) return false;
      reportError(err, 'ClubDataPage.invoices_rpc');
      setInvoicesError('Could Not Refresh Your Union Statement.');
      return false;
    } finally {
      if (!stale()) setInvoicesLoading(false);
    }
  }, [clubUuid, isHydrating, user]);

  useEffect(() => {
    if (!clubUuid || isHydrating || !user) return;
    const restoreKey = `${user.id}:${clubUuid}:${invoiceCacheKey}`;
    if (restoredInvoiceKeyRef.current !== restoreKey) {
      restoredInvoiceKeyRef.current = restoreKey;
      const cached = readClubDataCache<InvoiceRow[]>(user.id, clubUuid, invoiceCacheKey);
      if (cached) {
        setInvoices(cached);
        setInvoicesLoading(false);
      }
    }
    void loadInvoices();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadInvoices();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [clubUuid, isHydrating, user, loadInvoices]);

  /**
   * Realtime is a low-latency invalidation signal, not a second source of
   * financial truth. Keep the verified rows on screen, expire every cached
   * query immediately, and coalesce mutation bursts into one authoritative
   * RPC refresh. The 60-second poll above remains the recovery path if the
   * websocket is unavailable.
   */
  const queueEventRefresh = useCallback(
    (scope: 'ledger' | 'invoices' | 'all') => {
      if (!clubUuid || isHydrating || !user) return;
      removeClubDataCaches(user.id, clubUuid);
      if (scope === 'ledger' || scope === 'all') pendingEventRefreshRef.current.ledger = true;
      if (scope === 'invoices' || scope === 'all') pendingEventRefreshRef.current.invoices = true;
      if (eventRefreshTimerRef.current) clearTimeout(eventRefreshTimerRef.current);
      eventRefreshTimerRef.current = setTimeout(() => {
        eventRefreshTimerRef.current = null;
        const pending = pendingEventRefreshRef.current;
        pendingEventRefreshRef.current = { ledger: false, invoices: false };
        if (pending.ledger) {
          void load(false, true);
          if (tabRef.current === 'players') void loadPlayers(true);
        }
        if (pending.invoices) void loadInvoices();
      }, 750);
    },
    [clubUuid, isHydrating, user, load, loadPlayers, loadInvoices]
  );

  const realtimeFilter = clubUuid ? `club_id=eq.${clubUuid}` : null;
  const realtimeEnabled = Boolean(clubUuid && user && !isHydrating);
  const markRealtimeStatus = useCallback((feed: RealtimeFeed, status: string) => {
    const next: RealtimeFeedState =
      status === 'SUBSCRIBED'
        ? 'live'
        : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'
          ? 'degraded'
          : 'connecting';
    setRealtimeFeeds((current) =>
      current[feed] === next ? current : { ...current, [feed]: next }
    );
  }, []);

  useMasterBusChannel({
    channelName: clubUuid ? `club-data-tables-${clubUuid}` : null,
    table: 'tables',
    filter: realtimeFilter,
    event: '*',
    onPayload: () => queueEventRefresh('ledger'),
    onSubscriptionError: (status) => {
      markRealtimeStatus('tables', status);
      queueEventRefresh('ledger');
    },
    onSubscriptionStatus: (status) => markRealtimeStatus('tables', status),
    enabled: realtimeEnabled,
  });
  useMasterBusChannel({
    channelName: clubUuid ? `club-data-tournaments-${clubUuid}` : null,
    table: 'tournaments',
    filter: realtimeFilter,
    event: '*',
    onPayload: () => queueEventRefresh('ledger'),
    onSubscriptionError: (status) => {
      markRealtimeStatus('tournaments', status);
      queueEventRefresh('ledger');
    },
    onSubscriptionStatus: (status) => markRealtimeStatus('tournaments', status),
    enabled: realtimeEnabled,
  });
  useMasterBusChannel({
    channelName: clubUuid ? `club-data-invoices-${clubUuid}` : null,
    table: 'settlement_invoices',
    filter: realtimeFilter,
    event: '*',
    onPayload: () => queueEventRefresh('invoices'),
    onSubscriptionError: (status) => {
      markRealtimeStatus('invoices', status);
      queueEventRefresh('invoices');
    },
    onSubscriptionStatus: (status) => markRealtimeStatus('invoices', status),
    enabled: realtimeEnabled,
  });
  useMasterBusChannel({
    channelName: clubUuid ? `club-data-members-${clubUuid}` : null,
    table: 'club_members',
    filter: realtimeFilter,
    event: '*',
    onPayload: () => queueEventRefresh('all'),
    onSubscriptionError: (status) => {
      markRealtimeStatus('members', status);
      queueEventRefresh('all');
    },
    onSubscriptionStatus: (status) => markRealtimeStatus('members', status),
    enabled: realtimeEnabled,
  });

  useMasterBusSubscriptions(
    CLUB_DATA_BUS_EVENTS,
    (payload) => {
      const eventClubId =
        payload && typeof payload === 'object' && 'clubId' in payload
          ? String((payload as { clubId?: unknown }).clubId || '')
          : '';
      if (eventClubId && eventClubId !== clubUuid) return;
      queueEventRefresh('all');
    },
    { debounce: 750 }
  );

  const integrity = useMemo(() => (snapshot ? auditClubDataSnapshot(snapshot) : null), [snapshot]);
  const liveFeedCount = useMemo(
    () => Object.values(realtimeFeeds).filter((state) => state === 'live').length,
    [realtimeFeeds]
  );
  const integrityNeedsAttention = Boolean(
    integrity &&
    (integrity.level === 'attention' ||
      ledgerSource === 'degraded' ||
      (lastRequestMs !== null && lastRequestMs > COLD_READ_ATTEMPT_TIMEOUT_MS))
  );

  const shiftRange = useCallback(
    (direction: -1 | 1) => {
      const d = new Date(`${endDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + direction * preset);
      const next = toISODate(d);
      const today = toISODate(new Date());
      setEndDate(next > today ? today : next);
    },
    [endDate, preset]
  );

  const refreshAll = useCallback(async () => {
    if (manualRefreshing || !clubUuid || isHydrating || !user) return;
    setManualRefreshing(true);
    setRefreshNote('Refreshing Club Ledger.');
    try {
      const requests: Array<Promise<boolean>> = [load(true, true), loadInvoices()];
      if (tab === 'players') requests.push(loadPlayers(true));
      const outcomes = await Promise.all(requests);
      if (!cancelledRef.current) {
        setRefreshNote(
          outcomes.every(Boolean)
            ? 'Club Ledger Refreshed.'
            : 'Refresh Finished With Some Data Unavailable.'
        );
      }
    } finally {
      if (!cancelledRef.current) setManualRefreshing(false);
    }
  }, [manualRefreshing, clubUuid, isHydrating, user, load, loadInvoices, loadPlayers, tab]);

  const exportCsv = useCallback(async () => {
    if (!clubUuid || exporting) return;
    const controller = new AbortController();
    exportControllerRef.current = controller;
    setExporting(true);
    setExportNote(null);
    setExportProgress({ stage: 'preparing', loaded: 0, total: null });
    try {
      const requestId = uuid();
      if (tab === 'players') {
        const rows = await fetchClubDataExport<PlayerRow>({
          rpc: supabase.rpc.bind(supabase),
          startRpc: 'ca_club_player_export_start',
          startArgs: {
            p_club_id: clubUuid,
            p_start: startDate,
            p_end: endDate,
            p_sort: playerSort,
          },
          requestId,
          signal: controller.signal,
          rowKey: (row) => row.user_id,
          onProgress: setExportProgress,
        });
        if (!downloadCsv(`club_players_${startDate}_${endDate}.csv`, playersToCsv(rows))) {
          setExportNote('This browser could not start the download.');
        } else {
          setExportNote(`Exported all ${compactInt(rows.length)} players.`);
        }
        return;
      }

      const rows = await fetchClubDataExport<SnapshotRow>({
        rpc: supabase.rpc.bind(supabase),
        startRpc: 'ca_club_game_export_start',
        startArgs: {
          p_club_id: clubUuid,
          p_start: startDate,
          p_end: endDate,
          p_game: game,
          p_stakes: stakes,
          p_search: search || null,
          p_sort: gameSort,
        },
        requestId,
        signal: controller.signal,
        rowKey: (row) => `${row.kind}:${row.id}`,
        onProgress: setExportProgress,
      });
      if (!downloadCsv(`club_data_${startDate}_${endDate}.csv`, rowsToCsv(rows))) {
        setExportNote('This browser could not start the download.');
      } else {
        setExportNote(`Exported all ${compactInt(rows.length)} games.`);
      }
    } catch (e) {
      if (isClubDataExportAbort(e)) {
        setExportNote('Export cancelled. No partial file was downloaded.');
      } else {
        reportError(e, 'ClubDataPage.export_prepare');
        setExportNote(
          'The complete export could not be prepared. No partial file was downloaded. Try again.'
        );
      }
    } finally {
      if (!cancelledRef.current) {
        setExporting(false);
        setExportProgress(null);
      }
      if (exportControllerRef.current === controller) exportControllerRef.current = null;
    }
  }, [clubUuid, exporting, tab, startDate, endDate, playerSort, game, stakes, search, gameSort]);

  const cancelExport = useCallback(() => {
    exportControllerRef.current?.abort();
  }, []);

  /**
   * The RPC is asked for 8 statements and nothing orders the result, so
   * `invoices[0]` was "whatever came back first" - if it ever returns
   * ascending, the headline square-up figure is the OLDEST of eight. Sort
   * here rather than trusting the row order of a function we do not own.
   */
  const latestInvoice = useMemo(
    () =>
      [...invoices].sort((a, b) =>
        String(b.issued_at || '').localeCompare(String(a.issued_at || ''))
      )[0] || null,
    [invoices]
  );
  /**
   * The RPC is asked for EIGHT statements and rendered one. An owner disputing
   * a square-up ("was I charged this last week too?") had no history anywhere
   * in the app, while seven rows of already-paid-for data were discarded on
   * every load. Same sort as latestInvoice, so the two cannot disagree.
   */
  const olderInvoices = useMemo(
    () =>
      [...invoices]
        .sort((a, b) => String(b.issued_at || '').localeCompare(String(a.issued_at || '')))
        .slice(1),
    [invoices]
  );

  const summary = snapshot?.summary;
  const filtersActive = game !== 'ALL' || stakes !== 'ALL' || search.trim() !== '';
  const unionOwesClub = latestInvoice?.direction === 'union owes club';
  const delta = snapshot?.delta;
  const prevRange = snapshot?.previous_range;

  const onTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    let next: 'games' | 'players' | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'Home') {
      next = 'games';
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'End') {
      next = 'players';
    }
    if (!next) return;
    event.preventDefault();
    setTab(next);
    requestAnimationFrame(() => {
      (next === 'games' ? gamesTabRef : playersTabRef).current?.focus();
    });
  }, []);

  // "vs prev 14d" under a headline number. Null pct means the prior window was
  // zero, and nothing is a percentage of nothing - so nothing is shown.
  const pctNote = (pct: number | null | undefined) => {
    if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return null;
    // The RPC rounds to one decimal; rounding again here means a hand-rolled
    // caller cannot push 33.33333333333333% into a 93px tile.
    const v = Math.round(Number(pct) * 10) / 10;
    const cls = v > 0 ? styles.deltaUp : v < 0 ? styles.deltaDown : styles.deltaFlat;
    return (
      <span
        className={`${styles.delta} ${cls}`}
        title={prevRange ? `Previous Period ${prevRange.start} To ${prevRange.end}` : undefined}
      >
        {v > 0 ? '+' : ''}
        {/* prevRange, not `preset`: the preset flips the instant the button is
            tapped while the snapshot is still the old window, so this read
            "Vs Prev 1d" over a 14-day comparison for the whole fetch. */}
        {v}% Vs Prev {prevRange?.days ?? preset}d
      </span>
    );
  };

  const absNote = (abs: number | null | undefined) => {
    if (abs === null || abs === undefined || !Number.isFinite(Number(abs))) return null;
    const v = Number(abs);
    const cls = v > 0 ? styles.deltaUp : v < 0 ? styles.deltaDown : styles.deltaFlat;
    return (
      <span
        className={`${styles.delta} ${cls}`}
        title={prevRange ? `Previous Period ${prevRange.start} To ${prevRange.end}` : undefined}
      >
        {v > 0 ? '+' : ''}
        {money(v)} Vs Prev {prevRange?.days ?? preset}d
      </span>
    );
  };

  if (isHydrating && !user) {
    return (
      <div className={styles.page}>
        <LoadingState message="Opening Club Data" />
      </div>
    );
  }
  if (!user) {
    return (
      <div className={styles.page}>
        <PermissionState
          title="Sign In To View Club Data"
          description="Financial And Player Analytics Are Restricted To Authenticated Club Operators."
          onBack={() => navigate('/')}
        />
      </div>
    );
  }
  if (!clubParam) {
    /* Dan 2026-08-25: the footer stays on this state deliberately. Landing on
       "No Club Selected" with no navigation is a dead end - the bar is the way
       out, and it can resolve a club of its own even when the route gave none. */
    return (
      <div className={styles.page}>
        <EmptyState
          icon="CLUB"
          eyebrow="Club Context Required"
          tone="permission"
          title="Choose A Club To View Its Data"
          description="Revenue, Rake, Player Results, And Union Invoices Belong To A Specific Club. Open Club Data From That Club's Operations Menu."
          action={{ label: 'Return To Arena', onClick: () => navigate('/') }}
          secondaryAction={{ label: 'Find Clubs', onClick: () => navigate('/search') }}
        />
      </div>
    );
  }

  return (
    <div className={styles.page} data-page="club-data">
      <header className={styles.header}>
        <button
          type="button"
          className={`${styles.headerBtn} ${styles.backButton}`}
          onClick={() => navigate(-1)}
          aria-label="Go Back"
        >
          <span aria-hidden="true">&#8592;</span>
          <span>Back</span>
        </button>
        <span className={styles.headerIdentity}>Club Intelligence</span>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.headerBtn}
            onClick={() => void refreshAll()}
            disabled={manualRefreshing || loading || playersLoading || invoicesLoading}
            aria-label="Refresh Club Ledger"
          >
            {manualRefreshing ? 'Refreshing' : 'Refresh'}
          </button>
          <button
            type="button"
            className={`${styles.headerBtn} ${styles.exportButton}`}
            onClick={() => {
              if (exporting) cancelExport();
              else void exportCsv();
            }}
            disabled={
              !exporting && (tab === 'players' ? !sortedPlayers.length : !snapshot?.rows?.length)
            }
            aria-label={exporting ? 'Cancel CSV Export' : 'Export As CSV'}
            title={exporting ? 'Cancel CSV Export' : 'Export As CSV'}
          >
            {exporting ? 'Cancel Export' : 'Export CSV'}
          </button>
        </div>
      </header>

      <div className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
        {refreshNote ||
          exportNote ||
          (exportProgress?.stage === 'preparing'
            ? 'Preparing Complete Export.'
            : exportProgress?.total !== null && exportProgress
              ? `Exporting ${compactInt(exportProgress.loaded)} Of ${compactInt(exportProgress.total)} Rows.`
              : '')}
      </div>

      <section className={styles.hero} aria-labelledby="club-data-title">
        <img
          className={styles.heroArt}
          src="/hub/club-arena/images/club-data/data-vault-hero-v1.webp"
          alt=""
          width="1600"
          height="901"
          fetchPriority="high"
          decoding="async"
        />
        <div className={styles.heroShade} aria-hidden="true" />
        <div className={styles.heroContent}>
          <div className={styles.heroEyebrow} aria-live="polite">
            <span className={styles.statusLight} aria-hidden="true" />
            {loading && !snapshot
              ? 'Synchronizing Ledger'
              : ledgerSource === 'cached'
                ? 'Recent Verified Snapshot'
                : ledgerSource === 'degraded'
                  ? 'Live Refresh Delayed'
                  : 'Live Club Ledger'}
          </div>
          <h1 className={styles.title} id="club-data-title">
            Read The Room.
            <span>Own The Numbers.</span>
          </h1>
          <p className={styles.heroCopy}>
            Track Every Game, Fee, Player Result, And Union Square-Up From One Operator-Grade View.
          </p>
          <div className={styles.heroMeta}>
            <span>{clubName || 'Club Data'}</span>
            <span>
              {snapshot?.data_updated_at
                ? `Cash Updated ${utcTime(snapshot.data_updated_at)}`
                : loading
                  ? 'Loading Live Records'
                  : 'Live Records Ready'}
            </span>
          </div>
        </div>
      </section>

      {(ledgerSource === 'cached' || ledgerSource === 'degraded') && snapshot && (
        <div className={styles.footNote} role="status">
          {ledgerSource === 'cached'
            ? 'Showing A Recent Verified Snapshot While Live Numbers Refresh.'
            : 'Live Refresh Is Delayed. Showing The Last Verified Snapshot And Retrying Automatically.'}
        </div>
      )}

      <section
        className={`${styles.integrityPanel} ${integrityNeedsAttention ? styles.integrityAttention : ''}`}
        aria-labelledby="club-data-integrity-title"
      >
        <div className={styles.integrityHeading}>
          <div>
            <span>Operator Trust Layer</span>
            <h2 id="club-data-integrity-title">Data Integrity</h2>
          </div>
          <span className={styles.integrityBadge} role="status" aria-live="polite">
            {!snapshot ? 'Checking' : integrityNeedsAttention ? 'Recovery Active' : 'Verified'}
          </span>
        </div>
        <dl className={styles.integrityGrid}>
          <div>
            <dt>Payload Checks</dt>
            <dd>{integrity ? `${integrity.passed} / ${integrity.checks}` : NO_VALUE}</dd>
          </div>
          <div>
            <dt>Live Feeds</dt>
            <dd>{realtimeEnabled ? `${liveFeedCount} / 4` : 'Standby'}</dd>
          </div>
          <div>
            <dt>Last Verified</dt>
            <dd>
              {lastVerifiedAt ? formatClubDataAge(telemetryClock - lastVerifiedAt) : 'Checking'}
            </dd>
          </div>
          <div>
            <dt>Ledger Read</dt>
            <dd>{lastRequestMs === null ? 'Checking' : `${lastRequestMs.toLocaleString()}ms`}</dd>
          </div>
        </dl>
        <p className={styles.integrityNote}>
          {integrity?.issues.length
            ? `${integrity.issues.length} Integrity Check${integrity.issues.length === 1 ? '' : 's'} Need Review. Verified Rows Stay Visible While Recovery Runs.`
            : liveFeedCount < 4 && realtimeEnabled
              ? 'The 60-Second Verified Poll Remains Active While Live Feeds Reconnect.'
              : 'Internal Totals Reconcile. Live Invalidations And The 60-Second Verified Poll Are Active.'}
        </p>
        {integrity?.issues.length ? (
          <ul className={styles.integrityIssues}>
            {integrity.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className={styles.controlDeck} aria-label="Reporting Period">
        <div className={styles.controlLabel}>Reporting Window</div>
        <div className={styles.rangeBar}>
          <button
            type="button"
            className={styles.arrow}
            onClick={() => shiftRange(-1)}
            aria-label="Previous Period"
          >
            &#8592;
          </button>
          <div className={styles.rangeChip}>
            <span>{startDate}</span>
            <span className={styles.rangeDivider}>&mdash;</span>
            <span>{endDate}</span>
            <span className={styles.rangeTz}>UTC</span>
          </div>
          <button
            type="button"
            className={styles.arrow}
            onClick={() => shiftRange(1)}
            disabled={isToday}
            aria-label="Next Period"
          >
            &#8594;
          </button>
        </div>

        {/* role="group" + aria-pressed, not a tablist. These control no tabpanel,
          and the stakes row is a TOGGLE - tapping the active chip clears it,
          which is impossible for a tab and leaves a tablist with nothing
          selected. A screen reader was told "tab 3 of 6" for a filter. */}
        <div className={styles.presets} role="group" aria-label="Date Range">
          {([1, 7, 14] as PresetId[]).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={preset === p}
              className={`${styles.preset} ${preset === p ? styles.active : ''}`}
              onClick={() => setPreset(p)}
            >
              {p === 1 ? '1 Day' : `${p} Days`}
            </button>
          ))}
        </div>
      </section>

      <div className={styles.sectionThreshold}>
        <div>
          <span>Performance Ledger</span>
          <h2>Club Pulse</h2>
        </div>
        <span className={styles.thresholdStatus}>{loading ? 'Syncing' : 'Live'}</span>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="View">
        <button
          ref={gamesTabRef}
          type="button"
          role="tab"
          id="club-data-tab-games"
          aria-controls="club-data-panel-games"
          aria-selected={tab === 'games'}
          tabIndex={tab === 'games' ? 0 : -1}
          className={`${styles.tab} ${tab === 'games' ? styles.active : ''}`}
          onClick={() => setTab('games')}
          onKeyDown={onTabKeyDown}
        >
          Games
        </button>
        <button
          ref={playersTabRef}
          type="button"
          role="tab"
          id="club-data-tab-players"
          aria-controls="club-data-panel-players"
          aria-selected={tab === 'players'}
          tabIndex={tab === 'players' ? 0 : -1}
          className={`${styles.tab} ${tab === 'players' ? styles.active : ''}`}
          onClick={() => setTab('players')}
          onKeyDown={onTabKeyDown}
        >
          Players
        </button>
      </div>

      {/* ZEROS ARE A LIE ON THIS PAGE (Dan 2026-08-25).
          money(undefined) is "0.00", so any failed RPC - an authz refusal, a
          timeout, a shapeless payload - painted "Games 0, Total Winnings 0.00,
          Fee 0.00" in confident green with the real message buried in the list
          below. On the screen that answers "what do I owe the union", a zero
          has to mean zero. Dashes while there is no snapshot to read. */}
      <dl className={styles.summary} aria-busy={loading} aria-label="Club Performance Summary">
        <div className={styles.tile}>
          <dt className={styles.tileLabel}>Games</dt>
          <dd className={styles.tileValue}>{summary ? compactInt(summary.games) : NO_VALUE}</dd>
          {summary && <dd className={styles.tileMeta}>{pctNote(delta?.games_pct)}</dd>}
        </div>
        <div className={styles.tile}>
          <dt className={styles.tileLabel}>Total Winnings</dt>
          <dd
            className={`${styles.tileValue} ${summary && Number(summary.total_winnings) < 0 ? styles.neg : styles.pos}`}
          >
            {summary ? money(summary.total_winnings) : NO_VALUE}
          </dd>
          {summary && <dd className={styles.tileMeta}>{absNote(delta?.winnings_abs)}</dd>}
        </div>
        <div className={styles.tile}>
          <dt className={styles.tileLabel}>MTT Winnings</dt>
          <dd
            className={`${styles.tileValue} ${summary && Number(summary.mtt_winnings) < 0 ? styles.neg : styles.pos}`}
          >
            {summary ? money(summary.mtt_winnings) : NO_VALUE}
          </dd>
        </div>
        <div className={styles.tile}>
          <dt className={styles.tileLabel}>Fee</dt>
          <dd className={styles.tileValue}>{summary ? money(summary.fee) : NO_VALUE}</dd>
          {/* cash_fee and mtt_fee are already in the payload and rendered
              nowhere. Cash rake is a percentage of pots; MTT fee is a fixed cut
              of buy-ins. Blending them into one number meant an owner deciding
              "more tournaments or more cash tables" could not answer it from
              the page that exists to answer it. Dan 2026-08-25. */}
          {summary &&
            Number.isFinite(Number(summary.cash_fee)) &&
            Number.isFinite(Number(summary.mtt_fee)) && (
              <dd className={`${styles.tileSub} ${styles.tileMeta}`}>
                {money(summary.cash_fee)} Cash - {money(summary.mtt_fee)} MTT
              </dd>
            )}
          {summary && <dd className={styles.tileMeta}>{pctNote(delta?.fee_pct)}</dd>}
        </div>
      </dl>

      {/* The tiles are filtered by the game/stakes/search chips, which are only
          RENDERED on the Games tab. Switching to Players left Omaha-only totals
          sitting above a whole-club per-player breakdown with nothing saying
          so. Say so. */}
      {summary && filtersActive && (
        <div className={styles.footNote} role="status">
          These Totals Are Filtered{game !== 'ALL' ? ` - ${game}` : ''}
          {stakes !== 'ALL' ? ` - ${stakes}` : ''}
          {search ? ` - "${search}"` : ''}.
          {tab === 'players' ? ' The Player Breakdown Below Is Not.' : ''}
        </div>
      )}

      {invoicesError && (
        <div className={`${styles.state} ${styles.error}`} role="alert">
          <span>
            {invoicesError}
            {latestInvoice ? ' Showing The Last Verified Statement.' : ''}
          </span>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => void loadInvoices()}
            disabled={invoicesLoading}
          >
            {invoicesLoading ? 'Refreshing' : 'Try Again'}
          </button>
        </div>
      )}

      {olderInvoices.length > 0 && latestInvoice && (
        <div className={styles.invoiceHistory}>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setShowInvoiceHistory((v) => !v)}
            aria-expanded={showInvoiceHistory}
            aria-controls="club-data-invoice-history"
          >
            {showInvoiceHistory
              ? 'Hide Earlier Statements'
              : `Earlier Statements (${olderInvoices.length})`}
          </button>
          {showInvoiceHistory && (
            <div id="club-data-invoice-history">
              {olderInvoices.map((inv) => (
                <div className={styles.invoiceLine} key={inv.invoice_id}>
                  <span>
                    {String(inv.period_start || '').slice(0, 10)} To{' '}
                    {String(inv.period_end || '').slice(0, 10)}
                  </span>
                  <span>
                    {inv.direction === 'union owes club' ? '+' : '-'}
                    {Number.isFinite(Number(inv.amount))
                      ? money(Math.abs(Number(inv.amount)))
                      : NO_VALUE}
                    {inv.status ? ` - ${invoiceStatusLabel(inv.status)}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {latestInvoice && (
        <div
          /* `direction` was read for the LABEL and ignored by the styling, so
             an invoice where the union owes the club rendered in the red that
             means "you owe", above a bare unsigned figure. Direction decides
             the colour and the sign; status only decides whether it is settled. */
          className={`${styles.invoice} ${
            latestInvoice.status === 'paid'
              ? styles.invoicePaid
              : unionOwesClub
                ? styles.invoiceCredit
                : Number(latestInvoice.amount) > 0
                  ? styles.invoiceOwed
                  : ''
          }`}
          aria-busy={invoicesLoading}
        >
          <div className={styles.invoiceTop}>
            <span className={styles.invoiceLabel}>
              {latestInvoice.direction === 'union owes club'
                ? 'Union Owes You'
                : 'Weekly Square-Up'}
            </span>
            <span className={styles.invoiceAmount}>
              {unionOwesClub ? '+' : Number(latestInvoice.amount) > 0 ? '-' : ''}
              {money(Math.abs(Number(latestInvoice.amount) || 0))}
            </span>
          </div>
          <div className={styles.invoiceMeta}>
            {String(latestInvoice.period_start || '').slice(0, 10)} To{' '}
            {String(latestInvoice.period_end || '').slice(0, 10)}
            {latestInvoice.due_at ? ` - due ${String(latestInvoice.due_at).slice(0, 10)}` : ''}
            {latestInvoice.status ? ` - ${invoiceStatusLabel(latestInvoice.status)}` : ''}
          </div>

          {showInvoiceDetail && latestInvoice.breakdown && (
            <div className={styles.invoiceLines} id="club-data-invoice-detail">
              {[
                // The figures come from the invoice; the percentages used to be
                // literals, so any club on a non-standard deal got a label that
                // contradicted its own numbers. Derive them or omit them.
                ['Rake generated', latestInvoice.breakdown.rake_generated],
                [
                  `Your rakeback${splitPct(latestInvoice.breakdown.rakeback_due, latestInvoice.breakdown.rake_generated)}`,
                  latestInvoice.breakdown.rakeback_due,
                ],
                [
                  `Union fee kept${splitPct(latestInvoice.breakdown.union_fee_kept, latestInvoice.breakdown.rake_generated)}`,
                  latestInvoice.breakdown.union_fee_kept,
                ],
                ['Player win/loss', latestInvoice.breakdown.players_won],
                ['Settled in chips', latestInvoice.breakdown.settled_in_chips],
                ['ECO adjustment', latestInvoice.breakdown.eco_amount],
                ['Payments received', latestInvoice.breakdown.presettled],
              ].map(([label, value]) => (
                <div className={styles.invoiceLine} key={String(label)}>
                  <span>{String(label)}</span>
                  {/* money(Number('n/a')) is NaN, and NaN is falsy, so a corrupt
                      line item printed as a real 0.00. Show that it is missing. */}
                  <span>{Number.isFinite(Number(value)) ? money(Number(value)) : NO_VALUE}</span>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setShowInvoiceDetail((v) => !v)}
            disabled={!latestInvoice.breakdown}
            title={latestInvoice.breakdown ? undefined : 'No Line Detail On This Statement'}
            aria-expanded={latestInvoice.breakdown ? showInvoiceDetail : undefined}
            aria-controls={latestInvoice.breakdown ? 'club-data-invoice-detail' : undefined}
          >
            {!latestInvoice.breakdown
              ? 'No Statement Detail'
              : showInvoiceDetail
                ? 'Hide Statement'
                : 'View Statement'}
          </button>
        </div>
      )}

      {tab === 'games' && (
        <div
          role="tabpanel"
          id="club-data-panel-games"
          aria-labelledby="club-data-tab-games"
          tabIndex={0}
        >
          <div className={styles.searchRow}>
            <label className={styles.srOnly} htmlFor="club-data-search">
              Search Games
            </label>
            <input
              id="club-data-search"
              className={styles.searchInput}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Type In The Name Of The Game, Creator ID Or Player ID"
            />
          </div>

          <div className={styles.filterRow} role="group" aria-label="Game Type">
            {GAME_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={game === f.id}
                className={`${styles.chip} ${game === f.id ? styles.active : ''}`}
                onClick={() => setGame(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div
            className={`${styles.filterRow} ${styles.stakesRow}`}
            role="group"
            aria-label="Stakes"
          >
            {STAKES_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={stakes === f.id}
                className={`${styles.chip} ${stakes === f.id ? styles.active : ''}`}
                onClick={() => setStakes((cur) => (cur === f.id ? 'ALL' : f.id))}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className={styles.filterRow} role="group" aria-label="Sort Games">
            {GAME_SORTS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={gameSort === option.id}
                className={`${styles.chip} ${gameSort === option.id ? styles.active : ''}`}
                onClick={() => setGameSort(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {filtersActive && (
            <div className={styles.filterUtility}>
              <span>
                {compactInt(snapshot?.row_count || 0)} Matching Game
                {Number(snapshot?.row_count || 0) === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setGame('ALL');
                  setStakes('ALL');
                  setSearchInput('');
                  setSearch('');
                }}
              >
                Reset Filters
              </button>
            </div>
          )}

          <div
            ref={gameVirtual.containerRef}
            className={`${styles.list} ${styles.virtualList}`}
            role={snapshot?.rows.length ? 'list' : undefined}
            aria-busy={loading}
            aria-label="Games"
            tabIndex={0}
          >
            {loading && !snapshot && !error && (
              <>
                <span className={styles.srOnly} role="status">
                  Loading Games
                </span>
                <div className={styles.skeletonRow} aria-hidden="true" />
                <div className={styles.skeletonRow} aria-hidden="true" />
                <div className={styles.skeletonRow} aria-hidden="true" />
              </>
            )}

            {error && (
              <div className={`${styles.state} ${styles.error}`} role="alert">
                <span>{error}</span>
                <button
                  type="button"
                  className={styles.retryButton}
                  onClick={() => void load(true, true)}
                >
                  Try Again
                </button>
              </div>
            )}

            {!loading && !error && snapshot && snapshot.rows.length === 0 && (
              <div className={styles.state}>No Games In This Period.</div>
            )}

            {!error && gameVirtual.paddingTop > 0 && (
              <div aria-hidden="true" style={{ height: gameVirtual.paddingTop }} />
            )}

            {!error &&
              gameVirtual.visibleItems.map((row, virtualIndex) => {
                // Intl, not padStart (CLAUDE.md §5.5) - and padStart could not
                // see an Invalid Date, so a malformed started_at rendered
                // "NaN:NaN". en-GB + timeZone UTC gives the same 24h HH:MM and
                // DD/MM this was hand-rolling, with the guard for free.
                const started = row.started_at ? new Date(row.started_at) : null;
                const validStart = started && Number.isFinite(started.getTime()) ? started : null;
                const hhmm = validStart
                  ? validStart.toLocaleTimeString('en-GB', {
                      timeZone: 'UTC',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '--:--';
                const ddmm = validStart
                  ? validStart.toLocaleDateString('en-GB', {
                      timeZone: 'UTC',
                      day: '2-digit',
                      month: '2-digit',
                    })
                  : '';
                const idLabel =
                  row.creator_name ||
                  (row.creator_id ? row.creator_id.slice(0, 8) : row.id.slice(0, 8));

                return (
                  <div
                    className={styles.row}
                    key={`${row.kind}-${row.id}`}
                    role="listitem"
                    aria-posinset={gameVirtual.startIndex + virtualIndex + 1}
                    aria-setsize={snapshot?.row_count}
                  >
                    <div className={styles.rowTime}>
                      <div className={styles.rowTimeMain}>{hhmm}</div>
                      <div className={styles.rowTimeSub}>{ddmm}</div>
                    </div>

                    <div className={styles.avatarWrap}>
                      {/* Sized and error-guarded, matching the player rows below.
                          This rendered the raw URL with no onError, so a dead
                          storage object showed the browser's broken-image glyph
                          and pulled a full-size asset into a 40px box. */}
                      {row.creator_avatar ? (
                        <img
                          className={styles.avatar}
                          src={sizedStorageUrl(row.creator_avatar, 40)}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.onerror = null;
                            e.currentTarget.src = generateAvatarSvg(
                              row.creator_id || row.id,
                              row.creator_name || row.name || '?'
                            );
                          }}
                        />
                      ) : (
                        <div className={styles.avatarFallback} aria-hidden="true">
                          {(row.name || '?').slice(0, 1).toUpperCase()}
                        </div>
                      )}
                      <div className={styles.rowId} title={idLabel}>
                        {idLabel}
                      </div>
                    </div>

                    <div className={styles.rowMain}>
                      <div className={styles.rowName} title={row.name}>
                        {row.name}
                      </div>
                      <div className={styles.rowTags}>
                        {row.rake_percent !== null && (
                          <span className={styles.rakePct}>{Number(row.rake_percent)}%</span>
                        )}
                        <span className={badgeClass(row)}>
                          {row.kind === 'CASH' ? row.variant : row.kind}
                        </span>
                      </div>
                      {row.blinds && <div className={styles.rowBlinds}>Blinds: {row.blinds}</div>}
                      {!row.blinds && row.players > 0 && (
                        <div className={styles.rowBlinds}>{compactInt(row.players)} Players</div>
                      )}
                    </div>

                    <div className={styles.rowFee}>
                      <div className={styles.rowFeeValue}>{money(row.fee)}</div>
                      <div className={styles.rowFeeLabel}>Fee</div>
                      <div
                        className={`${styles.rowWin} ${row.winnings < 0 ? styles.neg : styles.pos}`}
                      >
                        {money(row.winnings)}
                      </div>
                    </div>
                  </div>
                );
              })}

            {!error && gameVirtual.paddingBottom > 0 && (
              <div aria-hidden="true" style={{ height: gameVirtual.paddingBottom }} />
            )}
          </div>

          {gamesPageError && (
            <div className={`${styles.state} ${styles.error}`} role="alert">
              <span>{gamesPageError}</span>
              <button
                type="button"
                className={styles.retryButton}
                onClick={() => void loadMoreGames()}
                disabled={gamesLoadingMore}
              >
                {gamesLoadingMore ? 'Loading' : 'Try Again'}
              </button>
            </div>
          )}

          {snapshot && !error && (gamesHasMore || gamesLoadingMore) && (
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => void loadMoreGames()}
              disabled={gamesLoadingMore}
            >
              {gamesLoadingMore
                ? 'Loading More Games'
                : `Load More Games - ${compactInt(snapshot.rows.length)} Of ${compactInt(snapshot.row_count)}`}
            </button>
          )}
        </div>
      )}

      {tab === 'players' && (
        <div
          className={styles.playersPanel}
          role="tabpanel"
          id="club-data-panel-players"
          aria-labelledby="club-data-tab-players"
          aria-busy={playersLoading}
          tabIndex={0}
        >
          <div className={styles.filterRow} role="group" aria-label="Sort Players">
            {PLAYER_SORTS.map((o) => (
              <button
                key={o.id}
                type="button"
                aria-pressed={playerSort === o.id}
                className={`${styles.chip} ${playerSort === o.id ? styles.active : ''}`}
                onClick={() => setPlayerSort(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>

          {players && (
            <div className={styles.playerTotals}>
              <span>{compactInt(players.totals.players)} Players</span>
              <span className={Number(players.totals.net) < 0 ? styles.neg : styles.pos}>
                {money(players.totals.net)} Net
              </span>
              <span>{money(players.totals.rake)} Rake</span>
            </div>
          )}

          <div
            ref={playerVirtual.containerRef}
            className={`${styles.list} ${styles.virtualList}`}
            role={sortedPlayers.length ? 'list' : undefined}
            aria-busy={playersLoading}
            aria-label="Players"
            tabIndex={0}
          >
            {playersLoading && !players && !playersError && (
              <>
                <span className={styles.srOnly} role="status">
                  Loading Players
                </span>
                <div className={styles.skeletonRow} aria-hidden="true" />
                <div className={styles.skeletonRow} aria-hidden="true" />
                <div className={styles.skeletonRow} aria-hidden="true" />
              </>
            )}

            {playersError && (
              <div className={`${styles.state} ${styles.error}`} role="alert">
                <span>{playersError}</span>
                <button
                  type="button"
                  className={styles.retryButton}
                  onClick={() => void loadPlayers(true)}
                >
                  Try Again
                </button>
              </div>
            )}

            {!playersLoading && !playersError && players && sortedPlayers.length === 0 && (
              <div className={styles.state}>No Player Activity In This Period.</div>
            )}

            {!playersError && playerVirtual.paddingTop > 0 && (
              <div aria-hidden="true" style={{ height: playerVirtual.paddingTop }} />
            )}

            {!playersError &&
              playerVirtual.visibleItems.map((pl, i) => (
                <div
                  className={styles.playerRow}
                  key={pl.user_id}
                  role="listitem"
                  aria-posinset={playerVirtual.startIndex + i + 1}
                  aria-setsize={players?.player_count}
                >
                  <div className={styles.playerRank}>{playerVirtual.startIndex + i + 1}</div>

                  <div className={styles.avatarWrap}>
                    {pl.avatar_url ? (
                      <img
                        className={styles.avatar}
                        src={sizedStorageUrl(pl.avatar_url, 40)}
                        alt=""
                        loading="lazy"
                        onError={(e) => {
                          e.currentTarget.onerror = null;
                          e.currentTarget.src = generateAvatarSvg(pl.user_id, pl.username || '?');
                        }}
                      />
                    ) : (
                      <div className={styles.avatarFallback} aria-hidden="true">
                        {(pl.username || '?').slice(0, 1).toUpperCase()}
                      </div>
                    )}
                  </div>

                  <div className={styles.rowMain}>
                    <div className={styles.rowName} title={pl.username}>
                      {pl.username}
                    </div>
                    <div className={styles.rowBlinds}>
                      {compactInt(pl.hands)} Hands &middot; {money(pl.rake)} Rake
                    </div>
                  </div>

                  <div className={styles.rowFee}>
                    <div
                      className={`${styles.rowFeeValue} ${pl.net < 0 ? styles.neg : styles.pos}`}
                    >
                      {money(pl.net)}
                    </div>
                    <div className={styles.rowFeeLabel}>Net</div>
                  </div>
                </div>
              ))}

            {!playersError && playerVirtual.paddingBottom > 0 && (
              <div aria-hidden="true" style={{ height: playerVirtual.paddingBottom }} />
            )}
          </div>

          {playersPageError && (
            <div className={`${styles.state} ${styles.error}`} role="alert">
              <span>{playersPageError}</span>
              <button
                type="button"
                className={styles.retryButton}
                onClick={() => void loadMorePlayers()}
                disabled={playersLoadingMore}
              >
                {playersLoadingMore ? 'Loading' : 'Try Again'}
              </button>
            </div>
          )}

          {players && !playersError && (playersHasMore || playersLoadingMore) && (
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => void loadMorePlayers()}
              disabled={playersLoadingMore}
            >
              {playersLoadingMore
                ? 'Loading More Players'
                : `Load More Players - ${compactInt(sortedPlayers.length)} Of ${compactInt(players.player_count)}`}
            </button>
          )}

          {players && !playersError && (
            <div className={styles.footNote}>
              A Positive Net Means The Player Is Up.
              {(() => {
                // Sliced, not compared raw: this is typed `string` and a
                // timestamp would both fail the comparison - silently
                // suppressing the caveat exactly when it matters - and print
                // its time component into the sentence.
                const through = String(players.rake_complete_through || '').slice(0, 10);
                return through && through < endDate
                  ? ` Per-player rake is complete through ${through}; today's rake lands in tomorrow's rollup.`
                  : '';
              })()}
              {players.player_count > sortedPlayers.length
                ? ` Showing ${compactInt(sortedPlayers.length)} Of ${compactInt(players.player_count)} Players, Ordered By ${PLAYER_SORTS.find((option) => option.id === playerSort)?.label || 'Server Rank'}.`
                : ''}
            </div>
          )}
        </div>
      )}

      {exportNote && (
        <div className={styles.footNote} role="status">
          {exportNote}
        </div>
      )}

      {exportProgress && (
        <div className={styles.footNote} role="status" aria-live="polite">
          {exportProgress.stage === 'preparing'
            ? 'Preparing An Exact Snapshot For Export...'
            : `Downloading ${compactInt(exportProgress.loaded)} Of ${compactInt(exportProgress.total)} Rows...`}
        </div>
      )}

      {tab === 'games' && snapshot && (
        <div className={styles.footNote}>
          {clubName ? `${clubName} - ` : ''}
          Showing {compactInt(snapshot.rows.length)} Of {compactInt(snapshot.row_count)} Games
          {snapshot.data_updated_at
            ? ` - cash data updated ${utcTime(snapshot.data_updated_at)}`
            : ''}
        </div>
      )}
    </div>
  );
}

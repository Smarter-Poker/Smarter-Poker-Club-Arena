import { getTournamentEntryCapacity } from '../utils/tournamentPresentation';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COMMUNITY SEARCH — /search
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Rebuilt 2026-09-05 after Dan's audit of `/search?q=MIDWAY`:
 *
 *   - "buttons are covered / the buttons don't work" — the old stylesheet used
 *     GLOBAL class names (`.search-results`, `.search-clear`) that collide with
 *     `components/common/Search.css`, which is loaded by the header on every
 *     page. That file sets `.search-results { position: absolute; top: 100% }`
 *     and `.search-clear { width: 20px }`: the result list was yanked out of
 *     the panel to the bottom of the viewport and the Clear button was clipped
 *     to twenty pixels under the Search button. This page now owns its classes
 *     through a CSS module; `tests/community-search-owns-its-classes.law.test.ts`
 *     keeps it that way.
 *   - "328 members instead of the real total" — Midway Union is a union, and a
 *     union's count is every club's members added up (1,177), which the server
 *     now computes in `fn_community_search` via the same RPC the union lobby
 *     uses. Live, not the stale denormalised column.
 *   - "not pulling real club images" — `logo_url` is where club logos live;
 *     the server resolves logo_url > avatar_url > logo.
 *   - "the fuzzy match doesn't match right" — one tokenised, trigram-fuzzy,
 *     ranked matcher on the server for clubs, tables and tournaments;
 *     players go through `fn_search_players` (which also enforces the
 *     discoverable / privacy preferences the old raw `ilike` bypassed).
 *   - "Live Indexes dead, Current Scope dead" — both are measured now: the
 *     server reports how many records each index holds and the page reports
 *     how many indexes answered this query; scope is the live tab and the
 *     index strip switches it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import CommunitySurfaceHeader from '../components/community/CommunitySurfaceHeader';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useDebounce } from '../hooks/useDebounce';
import { STORAGE_KEYS } from '../lib/storage';
import { supabase } from '../lib/supabase';
import { PlayerSearchService, type PlayerSearchResult } from '../services/PlayerSearchService';
import { generateAvatarSvg, sizedStorageUrl } from '../utils/avatarGenerator';
import { formatBuyInShort } from '../utils/buyIn';
import { reportError } from '../utils/errorReporter';
import styles from './SearchPage.module.css';

// ── Types ────────────────────────────────────────────────────────────────────

export type SearchCategory = 'all' | 'players' | 'clubs' | 'tables' | 'tournaments';
type IndexKey = 'clubs' | 'players' | 'tables' | 'tournaments';
type IndexStatus = 'idle' | 'live' | 'failed';
type SearchFreshness = 'live' | 'partial' | 'cached';

export interface ClubHit {
  id: string;
  slug: string | null;
  club_number: number | null;
  name: string;
  tagline: string | null;
  description: string | null;
  image_url: string | null;
  card_image_url: string | null;
  is_union: boolean;
  union_id: string | null;
  union_name: string | null;
  member_count: number;
  online_count: number;
  table_count: number;
  seated_count: number;
  tournament_count: number;
  level: number | null;
  is_public: boolean;
  requires_approval: boolean;
  viewer_status: string | null;
  match_score: number;
}

export interface TableHit {
  id: string;
  name: string;
  game_variant: string | null;
  game_type: string | null;
  stakes: string | null;
  small_blind: number | null;
  big_blind: number | null;
  current_players: number;
  max_players: number;
  status: string | null;
  is_featured: boolean;
  is_new: boolean;
  club_id: string | null;
  club_name: string | null;
  club_slug: string | null;
  club_is_union: boolean;
  match_score: number;
}

export interface TournamentHit {
  format_contract?: unknown;
  id: string;
  name: string;
  status: string;
  tournament_type: string | null;
  satellite_target_id?: string | null;
  variant: string | null;
  buy_in_amount: number;
  buy_in_fee: number;
  guaranteed_prize: number;
  prize_pool: number;
  current_players: number;
  max_players: number | null;
  start_time: string | null;
  is_bounty: boolean;
  is_turbo: boolean;
  club_id: string | null;
  club_name: string | null;
  club_slug: string | null;
  is_registered: boolean;
  match_score: number;
}

export interface IndexHealth {
  clubs: number;
  players: number;
  tables: number;
  tournaments: number;
}

interface CommunitySearchPayload {
  clubs: ClubHit[];
  tables: TableHit[];
  tournaments: TournamentHit[];
  totals: { clubs: number; tables: number; tournaments: number };
  index_health: IndexHealth;
  fuzzy: boolean;
}

interface SearchSnapshot {
  clubs: ClubHit[];
  players: PlayerSearchResult[];
  tables: TableHit[];
  tournaments: TournamentHit[];
  totals: Record<IndexKey, number>;
  fuzzy: boolean;
}

interface SearchCacheRecord {
  cachedAt: number;
  snapshot: SearchSnapshot;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const CATEGORIES: Array<{ id: SearchCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'players', label: 'Players' },
  { id: 'clubs', label: 'Clubs' },
  { id: 'tables', label: 'Tables' },
  { id: 'tournaments', label: 'Tournaments' },
];

const INDEXES: Array<{ id: IndexKey; label: string; scope: SearchCategory }> = [
  { id: 'clubs', label: 'Clubs', scope: 'clubs' },
  { id: 'players', label: 'Players', scope: 'players' },
  { id: 'tables', label: 'Tables', scope: 'tables' },
  { id: 'tournaments', label: 'Tournaments', scope: 'tournaments' },
];

const SCOPE_LABEL: Record<SearchCategory, string> = {
  all: 'Network',
  players: 'Players',
  clubs: 'Clubs',
  tables: 'Tables',
  tournaments: 'Tournaments',
};

/** Matches per index when scanning the whole network; the full page when scoped. */
const PREVIEW_LIMIT = 6;
const SCOPED_LIMIT = 40;
const PLAYER_MIN_CHARS = 2;
const SEARCH_CACHE_PREFIX = 'community_search_v2:';
const SEARCH_CACHE_TTL = 10 * 60 * 1000;

const EMPTY_TOTALS: Record<IndexKey, number> = { clubs: 0, players: 0, tables: 0, tournaments: 0 };
const EMPTY_SNAPSHOT: SearchSnapshot = {
  clubs: [],
  players: [],
  tables: [],
  tournaments: [],
  totals: EMPTY_TOTALS,
  fuzzy: false,
};

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function getSearchCategory(value: string | null): SearchCategory {
  return CATEGORIES.some((category) => category.id === value) ? (value as SearchCategory) : 'all';
}

/** Which server indexes a scope consults. Players live in their own RPC. */
export function indexesForScope(scope: SearchCategory): IndexKey[] {
  if (scope === 'all') return ['clubs', 'players', 'tables', 'tournaments'];
  return [scope];
}

export function formatCount(value: number | null | undefined): string {
  return (Number(value) || 0).toLocaleString();
}

export function variantLabel(variant: string | null | undefined): string {
  const key = (variant || '').toLowerCase();
  const labels: Record<string, string> = {
    nlh: 'NLH',
    flh: 'FLH',
    plo: 'PLO',
    plo4: 'PLO4',
    plo5: 'PLO5',
    plo6: 'PLO6',
    plo8: 'PLO8',
    flo8: 'FLO8',
    pineapple: 'Pineapple',
    short_deck: 'Short Deck',
    ofc: 'OFC',
    mixed: 'Mixed',
    cash: 'Cash',
  };
  if (labels[key]) return labels[key];
  return key ? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Poker';
}

export function tournamentStatusLabel(status: string): string {
  switch (status) {
    case 'RUNNING':
      return 'Running';
    case 'REGISTERING':
      return 'Registering';
    case 'ANNOUNCED':
      return 'Announced';
    default:
      return status ? status.charAt(0) + status.slice(1).toLowerCase() : 'Scheduled';
  }
}

export function formatStartTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'Start TBA';
  const start = new Date(iso).getTime();
  if (!Number.isFinite(start)) return 'Start TBA';
  const diff = start - now;
  if (diff <= 0) return 'Started';
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `Starts In ${minutes}m`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `Starts In ${hours}h ${rest}m` : `Starts In ${hours}h`;
  }
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function clubDestination(club: Pick<ClubHit, 'id' | 'slug'>): string {
  return `/clubs/${club.slug || club.id}`;
}

export function clubMembershipLabel(club: Pick<ClubHit, 'viewer_status' | 'requires_approval'>): {
  label: string;
  tone: 'member' | 'pending' | 'open';
} {
  const status = (club.viewer_status || '').toLowerCase();
  if (status === 'active' || status === 'approved') return { label: 'Member', tone: 'member' };
  if (status === 'pending') return { label: 'Pending', tone: 'pending' };
  return { label: club.requires_approval ? 'Apply' : 'Open', tone: 'open' };
}

export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('') || '?'
  );
}

function getSearchCacheKey(query: string, category: SearchCategory): string {
  return `${SEARCH_CACHE_PREFIX}${category}:${query.trim().toLocaleLowerCase()}`;
}

function readSearchCache(query: string, category: SearchCategory): SearchSnapshot | null {
  try {
    const raw = sessionStorage.getItem(getSearchCacheKey(query, category));
    if (!raw) return null;
    const record = JSON.parse(raw) as SearchCacheRecord;
    if (Date.now() - record.cachedAt > SEARCH_CACHE_TTL || !record.snapshot) {
      sessionStorage.removeItem(getSearchCacheKey(query, category));
      return null;
    }
    return record.snapshot;
  } catch {
    return null;
  }
}

function writeSearchCache(query: string, category: SearchCategory, snapshot: SearchSnapshot): void {
  try {
    const record: SearchCacheRecord = { cachedAt: Date.now(), snapshot };
    sessionStorage.setItem(getSearchCacheKey(query, category), JSON.stringify(record));
  } catch {
    // Search remains fully usable when session storage is unavailable or full.
  }
}

export function asPayload(data: unknown): CommunitySearchPayload {
  const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const totals = (raw.totals && typeof raw.totals === 'object' ? raw.totals : {}) as Record<
    string,
    unknown
  >;
  const health = (
    raw.index_health && typeof raw.index_health === 'object' ? raw.index_health : {}
  ) as Record<string, unknown>;
  return {
    clubs: Array.isArray(raw.clubs) ? (raw.clubs as ClubHit[]) : [],
    tables: Array.isArray(raw.tables) ? (raw.tables as TableHit[]) : [],
    tournaments: Array.isArray(raw.tournaments) ? (raw.tournaments as TournamentHit[]) : [],
    totals: {
      clubs: Number(totals.clubs) || 0,
      tables: Number(totals.tables) || 0,
      tournaments: Number(totals.tournaments) || 0,
    },
    index_health: {
      clubs: Number(health.clubs) || 0,
      players: Number(health.players) || 0,
      tables: Number(health.tables) || 0,
      tournaments: Number(health.tournaments) || 0,
    },
    fuzzy: raw.fuzzy === true,
  };
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SearchPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuthUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryFromUrl = searchParams.get('q') || '';
  const category = getSearchCategory(searchParams.get('type') || searchParams.get('tab'));
  const [query, setQuery] = useState(queryFromUrl);
  const [snapshot, setSnapshot] = useState<SearchSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchFreshness, setSearchFreshness] = useState<SearchFreshness>('live');
  const [indexHealth, setIndexHealth] = useState<IndexHealth | null>(null);
  const [indexStatus, setIndexStatus] = useState<Record<IndexKey, IndexStatus>>({
    clubs: 'idle',
    players: 'idle',
    tables: 'idle',
    tournaments: 'idle',
  });
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [friendAdded, setFriendAdded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const searchRequestIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Community Search | Smarter Poker';
  }, []);

  useEffect(() => {
    setQuery(queryFromUrl);
  }, [queryFromUrl]);

  useEffect(() => {
    const legacyCategory = searchParams.get('tab');
    if (!legacyCategory) return;
    const next = new URLSearchParams(searchParams);
    if (!next.has('type')) {
      const resolved = getSearchCategory(legacyCategory);
      if (resolved !== 'all') next.set('type', resolved);
    }
    next.delete('tab');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.RECENT_SEARCHES);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) setRecentSearches(parsed.filter((v) => typeof v === 'string'));
    } catch {
      localStorage.removeItem(STORAGE_KEYS.RECENT_SEARCHES);
    }
  }, []);

  /* The index strip is live before the first keystroke: an empty query is a
     cheap call that returns only the four record counts. */
  useEffect(() => {
    let cancelled = false;
    supabase
      .rpc('fn_community_search', { p_query: '', p_scope: 'all', p_limit: 1 })
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        setIndexHealth(asPayload(data).index_health);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateLocation = useCallback(
    (nextQuery: string, nextCategory = category, replace = true) => {
      const next = new URLSearchParams(searchParams);
      next.delete('tab');
      if (nextCategory === 'all') next.delete('type');
      else next.set('type', nextCategory);
      if (nextQuery.trim()) next.set('q', nextQuery.trim());
      else next.delete('q');
      setSearchParams(next, { replace });
    },
    [category, searchParams, setSearchParams]
  );

  const rememberSearch = useCallback((value: string) => {
    const normalized = value.trim();
    if (normalized.length < 2) return;
    setRecentSearches((previous) => {
      const updated = [normalized, ...previous.filter((item) => item !== normalized)].slice(0, 6);
      localStorage.setItem(STORAGE_KEYS.RECENT_SEARCHES, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const search = useCallback(
    async (searchQuery: string, getIsMounted?: () => boolean) => {
      const alive = () => !getIsMounted || getIsMounted();
      const normalized = searchQuery.trim().replace(/\s+/g, ' ').slice(0, 64);
      if (!normalized) {
        searchRequestIdRef.current += 1;
        if (alive()) {
          setSnapshot(EMPTY_SNAPSHOT);
          setSearchError(null);
          setSearchFreshness('live');
          setLoading(false);
        }
        return;
      }

      const requestId = ++searchRequestIdRef.current;
      if (alive()) {
        setLoading(true);
        setSearchError(null);
      }

      const wanted = indexesForScope(category);
      const limit = category === 'all' ? PREVIEW_LIMIT : SCOPED_LIMIT;
      const rpcScope: 'all' | 'clubs' | 'tables' | 'tournaments' | null =
        category === 'players' ? null : category;

      const communityTask: Promise<CommunitySearchPayload | null> = rpcScope
        ? (async () => {
            const { data, error } = await supabase.rpc('fn_community_search', {
              p_query: normalized,
              p_scope: rpcScope,
              p_limit: limit,
            });
            if (error) throw error;
            return asPayload(data);
          })()
        : Promise.resolve(null);

      const wantsPlayers = wanted.includes('players');
      const playersTask: Promise<{ items: PlayerSearchResult[]; total: number } | null> =
        wantsPlayers && normalized.length >= PLAYER_MIN_CHARS
          ? PlayerSearchService.search({
              query: normalized,
              limit: category === 'all' ? PREVIEW_LIMIT : 50,
            }).then((page) => ({ items: page.items, total: page.total }))
          : Promise.resolve(wantsPlayers ? { items: [], total: 0 } : null);

      const [communityResult, playersResult] = await Promise.allSettled([
        communityTask,
        playersTask,
      ]);
      if (!alive() || requestId !== searchRequestIdRef.current) return;

      const next: SearchSnapshot = {
        clubs: [],
        players: [],
        tables: [],
        tournaments: [],
        totals: { ...EMPTY_TOTALS },
        fuzzy: false,
      };
      const status: Record<IndexKey, IndexStatus> = {
        clubs: 'idle',
        players: 'idle',
        tables: 'idle',
        tournaments: 'idle',
      };
      const failures: string[] = [];

      if (communityResult.status === 'fulfilled') {
        const payload = communityResult.value;
        if (payload) {
          next.clubs = payload.clubs;
          next.tables = payload.tables;
          next.tournaments = payload.tournaments;
          next.totals.clubs = payload.totals.clubs;
          next.totals.tables = payload.totals.tables;
          next.totals.tournaments = payload.totals.tournaments;
          next.fuzzy = payload.fuzzy;
          setIndexHealth(payload.index_health);
          for (const key of wanted) if (key !== 'players') status[key] = 'live';
        }
      } else {
        reportError(communityResult.reason, 'SearchPage.community_index_failed');
        for (const key of wanted) if (key !== 'players') status[key] = 'failed';
        failures.push('clubs, tables and tournaments');
      }

      if (playersResult.status === 'fulfilled') {
        if (playersResult.value) {
          next.players = playersResult.value.items;
          next.totals.players = playersResult.value.total;
          status.players = 'live';
        }
      } else {
        reportError(playersResult.reason, 'SearchPage.player_index_failed');
        status.players = 'failed';
        failures.push('players');
      }

      setIndexStatus(status);
      const attempted = wanted.length;
      const failedCount = wanted.filter((key) => status[key] === 'failed').length;

      if (failedCount === attempted) {
        const cached = readSearchCache(normalized, category);
        setSnapshot(cached || EMPTY_SNAPSHOT);
        setSearchFreshness(cached ? 'cached' : 'partial');
        setSearchError(
          cached
            ? 'The live index is temporarily unavailable. A recent local snapshot is shown below.'
            : 'The community index is temporarily unavailable. Your query is safe to retry.'
        );
      } else if (failedCount > 0) {
        setSnapshot(next);
        setSearchFreshness('partial');
        setSearchError(
          `The ${failures.join(' and ')} index could not be reached. The results below are partial.`
        );
        writeSearchCache(normalized, category, next);
      } else {
        setSnapshot(next);
        setSearchFreshness('live');
        setSearchError(null);
        writeSearchCache(normalized, category, next);
      }
      setLoading(false);
    },
    [category]
  );

  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    if (debouncedQuery.trim() !== queryFromUrl.trim()) updateLocation(debouncedQuery);
    let isMounted = true;
    search(debouncedQuery, () => isMounted);
    return () => {
      isMounted = false;
    };
  }, [debouncedQuery, queryFromUrl, search, updateLocation]);

  useEffect(() => {
    let isMounted = true;
    const refresh = () => {
      if (isMounted && query.trim()) search(query, () => isMounted);
    };
    const unsubs = [
      masterBus.subscribeDebounced('CLUB_UPDATED', refresh, 500),
      masterBus.subscribeDebounced('PROFILE_UPDATED', refresh, 500),
      masterBus.subscribeDebounced('CLUB_JOINED', refresh, 500),
      masterBus.subscribeDebounced('TOURNAMENT_UPDATED', refresh, 500),
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [query, search]);

  // ── Actions ────────────────────────────────────────────────────────────

  const handleAddFriend = async (playerId: string) => {
    if (!user?.id) return;
    setBusyId(playerId);
    try {
      const { error } = await supabase.from('friendships').insert({
        user_id: user.id,
        friend_id: playerId,
        status: 'pending',
      });
      if (error && error.code !== '23505') throw error;
      setFriendAdded((previous) => new Set(previous).add(playerId));
      masterBus.emit('FRIEND_REQUEST_SENT', { fromUserId: user.id, toUserId: playerId });
      toast.success(
        error?.code === '23505' ? 'Friend request already sent' : 'Friend request sent!'
      );
    } catch (error) {
      reportError(error, 'SearchPage.add_friend_failed');
      toast.error('Failed to send request');
    } finally {
      setBusyId(null);
    }
  };

  const openTable = async (table: TableHit) => {
    setBusyId(table.id);
    try {
      /* Revalidated at click time: a seat count or a membership can change
         between the search and the tap, and stale access must not route. */
      const access = await PlayerSearchService.getTableWatchAccess(table.id);
      if (access.can_watch) {
        navigate(`/table/${table.id}?observer=1`);
        return;
      }
      if (['join', 'request_join', 'pending'].includes(access.action)) {
        toast.info(
          access.action === 'pending'
            ? 'Your membership request is still pending'
            : 'Join the club to sit at this table'
        );
        navigate(clubDestination({ id: table.club_id || '', slug: table.club_slug }));
        return;
      }
      if (access.action === 'observers_restricted') {
        toast.info('This table does not allow observers');
        return;
      }
      toast.error('That table is not available right now');
    } catch (error) {
      reportError(error, 'SearchPage.open_table_failed');
      toast.error('Could not open that table');
    } finally {
      setBusyId(null);
    }
  };

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    rememberSearch(query);
    updateLocation(query, category, false);
    search(query);
  };

  const setScope = (scope: SearchCategory) => {
    updateLocation(query, scope, false);
  };

  const clearQuery = () => {
    setQuery('');
    inputRef.current?.focus();
  };

  const clearHistory = () => {
    setRecentSearches([]);
    localStorage.removeItem(STORAGE_KEYS.RECENT_SEARCHES);
  };

  // ── Derived ────────────────────────────────────────────────────────────

  const wantedIndexes = indexesForScope(category);
  const liveIndexes = wantedIndexes.filter((key) => indexStatus[key] === 'live').length;
  const failedIndexes = wantedIndexes.filter((key) => indexStatus[key] === 'failed').length;
  const hasSearched = Boolean(query.trim());
  const shownCount =
    snapshot.clubs.length +
    snapshot.players.length +
    snapshot.tables.length +
    snapshot.tournaments.length;
  const totalMatches = wantedIndexes.reduce((sum, key) => sum + (snapshot.totals[key] || 0), 0);

  const sections = useMemo(() => {
    const order: IndexKey[] = ['clubs', 'players', 'tables', 'tournaments'];
    return order
      .filter((key) => wantedIndexes.includes(key))
      .map((key) => ({
        key,
        label: INDEXES.find((index) => index.id === key)?.label || key,
        shown:
          key === 'clubs'
            ? snapshot.clubs.length
            : key === 'players'
              ? snapshot.players.length
              : key === 'tables'
                ? snapshot.tables.length
                : snapshot.tournaments.length,
        total: snapshot.totals[key] || 0,
        status: indexStatus[key],
      }))
      .filter((section) => section.shown > 0 || section.status === 'failed');
  }, [indexStatus, snapshot, wantedIndexes]);

  const liveIndexesMetric = hasSearched
    ? `${liveIndexes}/${wantedIndexes.length}`
    : indexHealth
      ? '4/4'
      : '…';

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <main className={styles.page}>
      <CommunitySurfaceHeader
        eyebrow="Community / Discovery"
        title="Find Your Next Game"
        description="Scan Live Players, Clubs, Open Tables, And Active Tournaments From One Precise Community Index."
        metrics={[
          {
            label: 'Live Indexes',
            value: liveIndexesMetric,
            tone: failedIndexes > 0 ? 'attention' : 'live',
          },
          { label: 'Current Scope', value: SCOPE_LABEL[category] },
          {
            label: 'Results',
            value: loading ? 'Scanning' : hasSearched ? formatCount(totalMatches) : '0',
          },
        ]}
      />

      <section className={styles.console} aria-labelledby="search-console-title">
        <div className={styles.consoleHeading}>
          <div>
            <p className={styles.kicker}>Network Scanner</p>
            <h2 id="search-console-title">Community Search</h2>
          </div>
          <span className={styles.indexStatus} data-state={searchFreshness}>
            {searchFreshness === 'cached'
              ? 'RECENT SNAPSHOT'
              : searchFreshness === 'partial'
                ? 'PARTIAL INDEX'
                : 'LIVE DATA'}
          </span>
        </div>

        <form className={styles.form} role="search" onSubmit={submitSearch}>
          <label htmlFor="community-search">Search The Smarter Poker Network</label>
          <div className={styles.fieldShell}>
            <span className={styles.fieldMark} aria-hidden="true">
              ⌕
            </span>
            <input
              ref={inputRef}
              id="community-search"
              type="search"
              autoComplete="off"
              enterKeyHint="search"
              maxLength={64}
              placeholder="Player, Club, Club Number, Table, Or Tournament"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
            {query && (
              <button
                className={styles.clearButton}
                type="button"
                onClick={clearQuery}
                aria-label="Clear Search"
              >
                Clear
              </button>
            )}
            <button className={styles.submitButton} type="submit">
              Search
            </button>
          </div>
        </form>

        <div className={styles.indexStrip} aria-label="Live Index Health">
          {INDEXES.map((index) => {
            const health = indexHealth ? indexHealth[index.id] : null;
            const state = hasSearched ? indexStatus[index.id] : indexHealth ? 'live' : 'idle';
            return (
              <button
                key={index.id}
                type="button"
                className={styles.indexChip}
                data-state={state}
                data-active={category === index.scope}
                onClick={() => setScope(category === index.scope ? 'all' : index.scope)}
                aria-pressed={category === index.scope}
                title={
                  state === 'failed'
                    ? `${index.label} Index Unreachable`
                    : `${index.label}: ${formatCount(health)} Indexed`
                }
              >
                <i aria-hidden="true" />
                <span>{index.label}</span>
                <strong>{health == null ? '…' : formatCount(health)}</strong>
              </button>
            );
          })}
        </div>

        <div className={styles.categoryRail} role="tablist" aria-label="Search Categories">
          {CATEGORIES.map((item) => (
            <button
              key={item.id}
              id={`search-tab-${item.id}`}
              className={category === item.id ? styles.tabActive : styles.tab}
              type="button"
              role="tab"
              aria-selected={category === item.id}
              aria-controls="search-results-panel"
              onClick={() => setScope(item.id)}
            >
              {item.label}
              {hasSearched && item.id !== 'all' && snapshot.totals[item.id] > 0 && (
                <em>{formatCount(snapshot.totals[item.id])}</em>
              )}
            </button>
          ))}
        </div>

        <div
          id="search-results-panel"
          className={styles.content}
          role="tabpanel"
          aria-labelledby={`search-tab-${category}`}
        >
          {searchError && (
            <div className={styles.errorBanner} role="alert">
              <div>
                <strong>
                  {searchFreshness === 'cached'
                    ? 'Showing Recent Results'
                    : 'Index Connection Interrupted'}
                </strong>
                <span>{searchError}</span>
              </div>
              <button type="button" onClick={() => search(query)}>
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <div className={styles.skeletons} role="status" aria-label="Scanning Community Index">
              {Array.from({ length: 4 }).map((_, index) => (
                <div className={styles.skeleton} key={index}>
                  <span />
                  <div>
                    <i />
                    <i />
                  </div>
                </div>
              ))}
            </div>
          ) : !hasSearched ? (
            <div className={styles.history}>
              <div className={styles.historyHeading}>
                <div>
                  <p className={styles.kicker}>Local History</p>
                  <h3>Recent Searches</h3>
                </div>
                {recentSearches.length > 0 && (
                  <button type="button" onClick={clearHistory}>
                    Clear History
                  </button>
                )}
              </div>
              {recentSearches.length === 0 ? (
                <div className={`${styles.empty} ${styles.emptyCompact}`}>
                  <span aria-hidden="true">◇</span>
                  <p>Your Submitted Searches Will Appear Here.</p>
                </div>
              ) : (
                <div className={styles.historyList}>
                  {recentSearches.map((recent) => (
                    <button key={recent} type="button" onClick={() => setQuery(recent)}>
                      <span aria-hidden="true">↗</span>
                      {recent}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : shownCount === 0 ? (
            searchError ? null : (
              <div className={styles.empty}>
                <span aria-hidden="true">⌁</span>
                <h3>No Matches For “{query.trim()}”</h3>
                <p>
                  {category === 'players' && query.trim().length < PLAYER_MIN_CHARS
                    ? 'Type At Least Two Characters To Search Players.'
                    : category === 'all'
                      ? 'Check The Spelling Or Try A Broader Term. Club Numbers And Stakes Work Too.'
                      : 'Switch To All Or Try A Broader Term.'}
                </p>
              </div>
            )
          ) : (
            <div className={styles.results} aria-live="polite">
              <div className={styles.resultsHeading}>
                <span>
                  {formatCount(totalMatches)} {totalMatches === 1 ? 'Match' : 'Matches'}
                  {shownCount < totalMatches ? ` · Showing ${formatCount(shownCount)}` : ''}
                </span>
                <span>
                  {category === 'all'
                    ? 'Across The Network'
                    : `Filtered To ${SCOPE_LABEL[category]}`}
                  {snapshot.fuzzy ? ' · Fuzzy On' : ''}
                </span>
              </div>

              {sections.map((section) => (
                <section
                  key={section.key}
                  className={styles.group}
                  aria-label={`${section.label} Results`}
                >
                  <header className={styles.groupHeading}>
                    <h3>
                      {section.label}
                      <em>{formatCount(section.total)}</em>
                    </h3>
                    {category === 'all' && section.total > section.shown && (
                      <button type="button" onClick={() => setScope(section.key)}>
                        View All {formatCount(section.total)}
                      </button>
                    )}
                  </header>

                  {section.status === 'failed' && section.shown === 0 && (
                    <p className={styles.groupNote}>This Index Did Not Answer. Retry Above.</p>
                  )}

                  {section.key === 'clubs' &&
                    snapshot.clubs.map((club) => {
                      const membership = clubMembershipLabel(club);
                      const kind = club.is_union ? 'union' : 'club';
                      return (
                        <article className={styles.card} key={`club-${club.id}`} data-kind={kind}>
                          <button
                            className={styles.cardPrimary}
                            type="button"
                            onClick={() => {
                              rememberSearch(query);
                              navigate(clubDestination(club));
                            }}
                            aria-label={`Open ${club.name}`}
                          >
                            <span className={styles.avatar} data-shape="square">
                              {club.image_url ? (
                                <img
                                  src={sizedStorageUrl(club.image_url, 56)}
                                  alt=""
                                  loading="lazy"
                                  decoding="async"
                                />
                              ) : (
                                <b>{initialsOf(club.name)}</b>
                              )}
                            </span>
                            <span className={styles.copy}>
                              <span className={styles.titleRow}>
                                <strong>{club.name}</strong>
                                <span className={styles.kindPill} data-kind={kind}>
                                  {club.is_union ? 'Union' : 'Club'}
                                </span>
                                {club.level ? (
                                  <span className={styles.levelPill}>Lv {club.level}</span>
                                ) : null}
                              </span>
                              <span className={styles.metaRow}>
                                <span>
                                  <strong>{formatCount(club.member_count)}</strong> Members
                                </span>
                                <span>
                                  <strong>{formatCount(club.table_count)}</strong> Tables
                                </span>
                                <span>
                                  <strong>{formatCount(club.seated_count)}</strong> Seated
                                </span>
                                <span>
                                  <strong>{formatCount(club.tournament_count)}</strong> Tournaments
                                </span>
                              </span>
                              <span className={styles.subRow}>
                                {club.club_number ? `#${club.club_number}` : null}
                                {club.club_number && (club.union_name || club.tagline)
                                  ? ' · '
                                  : null}
                                {club.union_name ? `Member Of ${club.union_name}` : club.tagline}
                              </span>
                            </span>
                            <span className={styles.statusPill} data-tone={membership.tone}>
                              {membership.label}
                            </span>
                          </button>
                          <div className={styles.actions}>
                            {club.is_union && (
                              <button type="button" onClick={() => navigate(`/unions/${club.id}`)}>
                                Union Hub
                              </button>
                            )}
                            <button
                              className={styles.primaryAction}
                              type="button"
                              onClick={() => {
                                rememberSearch(query);
                                navigate(clubDestination(club));
                              }}
                            >
                              Open Lobby
                            </button>
                          </div>
                        </article>
                      );
                    })}

                  {section.key === 'players' &&
                    snapshot.players.map((player) => {
                      const isSelf = player.id === user?.id;
                      const name = player.display_name || player.username;
                      return (
                        <article
                          className={styles.card}
                          key={`player-${player.id}`}
                          data-kind="player"
                        >
                          <button
                            className={styles.cardPrimary}
                            type="button"
                            onClick={() => {
                              rememberSearch(query);
                              navigate(`/profile/${player.id}`);
                            }}
                            aria-label={`Open ${name}`}
                          >
                            <span className={styles.avatar}>
                              <img
                                src={
                                  player.avatar_url
                                    ? sizedStorageUrl(player.avatar_url, 56)
                                    : generateAvatarSvg(player.id, name, 112)
                                }
                                alt=""
                                loading="lazy"
                                decoding="async"
                              />
                              <i
                                className={styles.presence}
                                data-status={player.presence_status}
                                aria-hidden="true"
                              />
                            </span>
                            <span className={styles.copy}>
                              <span className={styles.titleRow}>
                                <strong>{name}</strong>
                                {player.relationship !== 'public' && (
                                  <span className={styles.kindPill} data-kind={player.relationship}>
                                    {isSelf ? 'You' : player.relationship}
                                  </span>
                                )}
                              </span>
                              <span className={styles.subRow}>
                                @{player.username}
                                {' · '}
                                {player.presence_status === 'playing'
                                  ? 'Playing Now'
                                  : player.presence_status === 'online'
                                    ? 'Online'
                                    : 'Offline'}
                                {player.tables.length > 0 ? ` · ${player.tables[0].name}` : ''}
                              </span>
                            </span>
                          </button>
                          {!isSelf && (
                            <div className={styles.actions}>
                              {player.relationship === 'friend' || friendAdded.has(player.id) ? (
                                <span className={styles.sentPill}>
                                  {player.relationship === 'friend' ? 'Friends' : 'Request Sent'}
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  disabled={busyId === player.id}
                                  onClick={() => handleAddFriend(player.id)}
                                >
                                  Add Friend
                                </button>
                              )}
                              <button
                                className={styles.primaryAction}
                                type="button"
                                onClick={() => navigate(`/messages?compose=${player.id}`)}
                              >
                                Message
                              </button>
                            </div>
                          )}
                        </article>
                      );
                    })}

                  {section.key === 'tables' &&
                    snapshot.tables.map((table) => (
                      <article className={styles.card} key={`table-${table.id}`} data-kind="table">
                        <button
                          className={styles.cardPrimary}
                          type="button"
                          disabled={busyId === table.id}
                          onClick={() => {
                            rememberSearch(query);
                            void openTable(table);
                          }}
                          aria-label={`Open ${table.name}`}
                        >
                          <span className={styles.avatar} data-shape="square">
                            <b className={styles.variant}>{variantLabel(table.game_variant)}</b>
                          </span>
                          <span className={styles.copy}>
                            <span className={styles.titleRow}>
                              <strong>{table.name}</strong>
                              <span
                                className={styles.kindPill}
                                data-kind={table.status === 'running' ? 'running' : 'waiting'}
                              >
                                {table.status === 'running' ? 'Running' : 'Waiting'}
                              </span>
                              {table.is_featured ? (
                                <span className={styles.levelPill}>Featured</span>
                              ) : null}
                              {table.is_new ? <span className={styles.levelPill}>New</span> : null}
                            </span>
                            <span className={styles.metaRow}>
                              <span>
                                <strong>{table.stakes || 'Stakes TBA'}</strong>
                              </span>
                              <span>
                                <strong>
                                  {formatCount(table.current_players)}/
                                  {formatCount(table.max_players)}
                                </strong>{' '}
                                Seated
                              </span>
                              {table.game_type ? (
                                <span>
                                  <strong>{variantLabel(table.game_type)}</strong>
                                </span>
                              ) : null}
                            </span>
                            <span className={styles.subRow}>
                              {table.club_name ? table.club_name : 'Private Host'}
                            </span>
                          </span>
                          <span className={styles.seatMeter} aria-hidden="true">
                            <i
                              style={{
                                width: `${Math.min(
                                  100,
                                  Math.round(
                                    (table.current_players / Math.max(1, table.max_players)) * 100
                                  )
                                )}%`,
                              }}
                            />
                          </span>
                        </button>
                        <div className={styles.actions}>
                          {table.club_id && (
                            <button
                              type="button"
                              onClick={() =>
                                navigate(
                                  clubDestination({
                                    id: table.club_id || '',
                                    slug: table.club_slug,
                                  })
                                )
                              }
                            >
                              Club
                            </button>
                          )}
                          <button
                            className={styles.primaryAction}
                            type="button"
                            disabled={busyId === table.id}
                            onClick={() => {
                              rememberSearch(query);
                              void openTable(table);
                            }}
                          >
                            {busyId === table.id ? 'Checking' : 'Observe'}
                          </button>
                        </div>
                      </article>
                    ))}

                  {section.key === 'tournaments' &&
                    snapshot.tournaments.map((tournament) => (
                      <article
                        className={styles.card}
                        key={`tournament-${tournament.id}`}
                        data-kind="tournament"
                      >
                        <button
                          className={styles.cardPrimary}
                          type="button"
                          onClick={() => {
                            rememberSearch(query);
                            navigate(`/tournaments/${tournament.id}`);
                          }}
                          aria-label={`Open ${tournament.name}`}
                        >
                          <span className={styles.avatar} data-shape="square">
                            <b className={styles.variant}>
                              {tournament.tournament_type && tournament.tournament_type !== 'MTT'
                                ? tournament.tournament_type
                                : formatBuyInShort(tournament.buy_in_amount, tournament.buy_in_fee)}
                            </b>
                          </span>
                          <span className={styles.copy}>
                            <span className={styles.titleRow}>
                              <strong>{tournament.name}</strong>
                              <span
                                className={styles.kindPill}
                                data-kind={tournament.status.toLowerCase()}
                              >
                                {tournamentStatusLabel(tournament.status)}
                              </span>
                              {tournament.is_registered ? (
                                <span className={styles.levelPill} data-tone="member">
                                  Registered
                                </span>
                              ) : null}
                            </span>
                            <span className={styles.metaRow}>
                              <span>
                                <strong>
                                  {formatBuyInShort(
                                    tournament.buy_in_amount,
                                    tournament.buy_in_fee
                                  )}
                                </strong>{' '}
                                Buy-In
                              </span>
                              {tournament.guaranteed_prize > 0 ? (
                                <span>
                                  <strong>{formatCount(tournament.guaranteed_prize)}</strong> GTD
                                </span>
                              ) : tournament.prize_pool > 0 ? (
                                <span>
                                  <strong>{formatCount(tournament.prize_pool)}</strong> Pool
                                </span>
                              ) : null}
                              <span>
                                <strong>
                                  {formatCount(tournament.current_players)}
                                  {getTournamentEntryCapacity(tournament) !== null
                                    ? `/${formatCount(tournament.max_players)}`
                                    : ''}
                                </strong>{' '}
                                Players
                              </span>
                              {tournament.is_bounty ? (
                                <span>
                                  <strong>Bounty</strong>
                                </span>
                              ) : null}
                              {tournament.is_turbo ? (
                                <span>
                                  <strong>Turbo</strong>
                                </span>
                              ) : null}
                            </span>
                            <span className={styles.subRow}>
                              {formatStartTime(tournament.start_time)}
                              {tournament.club_name ? ` · ${tournament.club_name}` : ''}
                            </span>
                          </span>
                        </button>
                        <div className={styles.actions}>
                          {tournament.club_id && (
                            <button
                              type="button"
                              onClick={() =>
                                navigate(
                                  clubDestination({
                                    id: tournament.club_id || '',
                                    slug: tournament.club_slug,
                                  })
                                )
                              }
                            >
                              Club
                            </button>
                          )}
                          <button
                            className={styles.primaryAction}
                            type="button"
                            onClick={() => {
                              rememberSearch(query);
                              navigate(`/tournaments/${tournament.id}`);
                            }}
                          >
                            {tournament.is_registered
                              ? 'Open Lobby'
                              : tournament.status === 'RUNNING'
                                ? 'Watch'
                                : 'Register'}
                          </button>
                        </div>
                      </article>
                    ))}
                </section>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { sizedStorageUrl, generateAvatarSvg } from '../utils/avatarGenerator';
import { useAuthUser } from '../hooks/useAuthUser';
import { useDebounce } from '../hooks/useDebounce';
import { useMasterBusSubscriptions } from '../hooks/useMasterBusSubscription';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import { useToast } from '../components/common/Toast';
import { useVirtualScroll } from '../hooks/useVirtualScroll';
import PageSkeleton from '../components/common/PageSkeleton';
import RoleBadge, { roleColor } from '../components/club/RoleBadge';
import RosterConnectionStatus from '../components/club/RosterConnectionStatus';
import { exportToCSV } from '../lib/export';
import { ClubNotFoundError, resolveClubUUIDStrict } from '../utils/strictClubIdResolver';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import {
  computeRosterRetryDelay,
  type RosterConnectionState,
} from '../utils/rosterReadReliability';
import { titleCase } from '../utils/titleCase';
import { AGENT_ROLES, roleLabel } from '../types/clubRoles';
import ClubRosterService, {
  type RosterCursor,
  type RosterFilter,
  type RosterMember,
  type RosterSort,
  type RosterSummary,
} from '../services/ClubRosterService';
import {
  purgeRosterCache,
  readRosterCache,
  rosterSearchKey,
  writeRosterCache,
} from '../lib/rosterCache';
import { RosterSummaryCoordinator, settleRosterReadsIndependently } from '../lib/rosterLoadPolicy';
import './ClubMembersPage.css';

const ROSTER_OPERATIONS_ART = `${import.meta.env.BASE_URL}images/club-members/roster-ledger-desk-v2.webp`;
const PAGE_SIZE = 80;
const ROW_HEIGHT = 123;

const FILTER_LABEL: Record<RosterFilter, string> = {
  all: 'All Players',
  mine: 'My Downline',
  seated: 'At Tables',
  online: 'Online',
  agents: 'Agents',
  admins: 'Admins',
  inactive_30: 'Inactive 30d',
  inactive_60: 'Inactive 60d',
  inactive_90: 'Inactive 90d',
  high_fees: 'Fees 100+',
};

const SORT_LABEL: Record<RosterSort, string> = {
  hierarchy: 'Role Hierarchy',
  activity: 'Recent Activity',
  name: 'Name (A To Z)',
  downlines: 'Downlines',
  wallet: 'Wallet Balance',
  fees: 'Fees',
};

type OptionalColumn = 'downlines' | 'wallets' | 'fees' | 'activity';
type SummaryFreshness = 'loading' | 'fresh' | 'stale' | 'failed';
type RosterLoadOptions = { forceSummary?: boolean; resetRecovery?: boolean };

const DEFAULT_SUMMARY: RosterSummary = {
  viewer_role: 'player',
  capabilities: {
    can_view_financials: false,
    can_export: false,
    can_manage_members: false,
    can_view_notes: false,
  },
  counts: { total: 0, online: 0, seated: 0, agents: 0, admins: 0 },
  data_version: null,
  page_size: PAGE_SIZE,
};

function readFilter(value: string | null): RosterFilter {
  return value && value in FILTER_LABEL ? (value as RosterFilter) : 'all';
}

function readSort(value: string | null): RosterSort {
  return value && value in SORT_LABEL ? (value as RosterSort) : 'hierarchy';
}

function chips(value: number | null): string {
  return value === null
    ? 'Restricted'
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function abortLike(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

export default function ClubMembersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { clubId: routeClubId } = useParams();
  const routeClub = routeClubId || searchParams.get('club') || '';
  const { user } = useAuthUser();
  const toast = useToast();
  const navigate = useNavigate();

  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);
  const [summary, setSummary] = useState<RosterSummary>(DEFAULT_SUMMARY);
  const [summaryAvailable, setSummaryAvailable] = useState(false);
  const [summaryFreshness, setSummaryFreshness] = useState<SummaryFreshness>('loading');
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [cursor, setCursor] = useState<RosterCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [filter, setFilter] = useState<RosterFilter>(() => readFilter(searchParams.get('view')));
  const [sortKey, setSortKey] = useState<RosterSort>(() => readSort(searchParams.get('sort')));
  const [searchQuery, setSearchQuery] = useState('');
  const [columns, setColumns] = useState<Set<OptionalColumn>>(
    () => new Set(['downlines', 'wallets', 'fees', 'activity'])
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [loadSlow, setLoadSlow] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [dataFreshness, setDataFreshness] = useState<'loading' | 'fresh' | 'stale' | 'failed'>(
    'loading'
  );
  const [realtimeConnection, setRealtimeConnection] = useState<'connecting' | 'live' | 'degraded'>(
    'connecting'
  );
  const [browserOnline, setBrowserOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine !== false
  );
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<number | null>(null);
  const [resolutionAttempt, setResolutionAttempt] = useState(0);

  const debouncedSearch = useDebounce(searchQuery, 260);
  const requestEpochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);
  const moreRef = useRef(false);
  const membersRef = useRef<RosterMember[]>([]);
  const summaryAvailableRef = useRef(false);
  const summaryCoordinatorRef = useRef(new RosterSummaryCoordinator<RosterSummary | null>());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryAttemptRef = useRef(0);
  const recoveryRequestKeyRef = useRef('');
  const realtimeConnectionRef = useRef<'connecting' | 'live' | 'degraded'>('connecting');
  const latestLoadRef = useRef<(options?: RosterLoadOptions) => Promise<void>>(
    async () => undefined
  );

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    if (filter === 'all') next.delete('view');
    else next.set('view', filter);
    if (sortKey === 'hierarchy') next.delete('sort');
    else next.set('sort', sortKey);
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [filter, searchParams, setSearchParams, sortKey]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    abortRef.current?.abort();
    moreAbortRef.current?.abort();
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
    recoveryAttemptRef.current = 0;
    recoveryRequestKeyRef.current = '';
    requestEpochRef.current += 1;
    setResolvedClubId(null);
    membersRef.current = [];
    setMembers([]);
    summaryCoordinatorRef.current.reset();
    summaryAvailableRef.current = false;
    setSummary(DEFAULT_SUMMARY);
    setSummaryAvailable(false);
    setSummaryFreshness('loading');
    setSelected(new Set());
    setCursor(null);
    setHasMore(false);
    setFilteredTotal(0);
    setLoadError(false);
    setNotFound(false);
    setAccessDenied(false);
    setSearchQuery('');
    setDataFreshness('loading');
    setLastSuccessfulSyncAt(null);
    realtimeConnectionRef.current = 'connecting';
    setRealtimeConnection('connecting');

    if (!routeClub) {
      setLoading(false);
      setNotFound(true);
      setDataFreshness('failed');
      return () => {
        active = false;
      };
    }

    void resolveClubUUIDStrict(routeClub)
      .then((id) => {
        if (!active) return;
        setResolvedClubId(id);
        if (user?.id) {
          try {
            const rawSearch = sessionStorage.getItem(rosterSearchKey(user.id, id));
            const savedSearch = rawSearch ? (JSON.parse(rawSearch) as string) : '';
            if (savedSearch) setSearchQuery(savedSearch.slice(0, 120));
            if (filter === 'all' && sortKey === 'hierarchy' && !savedSearch) {
              const cached = readRosterCache(user.id, id);
              if (cached) {
                membersRef.current = cached.rows;
                setMembers(cached.rows);
                summaryAvailableRef.current = true;
                setSummary(cached.summary);
                setSummaryAvailable(true);
                setSummaryFreshness('stale');
                setFilteredTotal(cached.summary.counts.total);
                setLastSuccessfulSyncAt(cached.cachedAt);
                setDataFreshness('stale');
              }
            }
          } catch {
            // Session storage is optional.
          }
        }
      })
      .catch((error) => {
        reportError(error, 'ClubMembersPage.resolveClub');
        if (active) {
          if (error instanceof ClubNotFoundError) setNotFound(true);
          else setLoadError(true);
          setDataFreshness('failed');
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
    // Filter and sort are intentionally not reset when the same URL re-resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolutionAttempt, routeClub, user?.id]);

  useEffect(() => {
    if (!resolvedClubId || !user?.id) return;
    try {
      const key = rosterSearchKey(user.id, resolvedClubId);
      if (searchQuery) sessionStorage.setItem(key, JSON.stringify(searchQuery.slice(0, 120)));
      else sessionStorage.removeItem(key);
    } catch {
      // Search continuity is optional; unlike URL state it never leaves the tab.
    }
  }, [resolvedClubId, searchQuery, user?.id]);

  const scheduleConnectionRecovery = useCallback(
    (maxAttempts: number = Number.POSITIVE_INFINITY): boolean => {
      if (
        !resolvedClubId ||
        refreshTimerRef.current ||
        !browserOnline ||
        recoveryAttemptRef.current >= maxAttempts
      ) {
        return false;
      }
      const delay = computeRosterRetryDelay(recoveryAttemptRef.current, 1_200, 30_000);
      recoveryAttemptRef.current += 1;
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void latestLoadRef.current({ forceSummary: true });
      }, delay);
      return true;
    },
    [browserOnline, resolvedClubId]
  );

  const loadFirstPage = useCallback(
    async (options: RosterLoadOptions = {}) => {
      if (!resolvedClubId) return;
      const recoveryRequestKey = `${resolvedClubId}:${debouncedSearch}:${filter}:${sortKey}`;
      if (options.resetRecovery === true || recoveryRequestKeyRef.current !== recoveryRequestKey) {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
        recoveryAttemptRef.current = 0;
        recoveryRequestKeyRef.current = recoveryRequestKey;
      }
      const epoch = ++requestEpochRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      moreAbortRef.current?.abort();
      setLoading(true);
      setLoadError(false);
      setLoadSlow(false);
      setSelected(new Set());
      setDataFreshness('loading');
      if (!summaryAvailableRef.current) setSummaryFreshness('loading');

      const isCurrent = () => !controller.signal.aborted && epoch === requestEpochRef.current;
      const summaryKey = `${user?.id ?? 'anonymous'}:${resolvedClubId}`;
      const summaryRequest = summaryCoordinatorRef.current.read(
        summaryKey,
        () => ClubRosterService.getSummary(resolvedClubId),
        { force: options.forceSummary === true }
      );
      const pageRequest = ClubRosterService.getRosterPage(resolvedClubId, {
        search: debouncedSearch,
        filter,
        sort: sortKey,
        limit: PAGE_SIZE,
        signal: controller.signal,
      }).finally(() => {
        if (isCurrent()) {
          setLoading(false);
          setIsRefreshing(false);
          setLoadSlow(false);
        }
      });

      const [summaryResult, pageResult] = await settleRosterReadsIndependently({
        summary: summaryRequest,
        page: pageRequest,
        onSummary: (nextSummary) => {
          if (!isCurrent()) return;
          if (!nextSummary) {
            controller.abort();
            requestEpochRef.current += 1;
            setAccessDenied(true);
            if (user?.id) purgeRosterCache(user.id, resolvedClubId);
            summaryAvailableRef.current = false;
            setSummary(DEFAULT_SUMMARY);
            setSummaryAvailable(false);
            setSummaryFreshness('fresh');
            membersRef.current = [];
            setMembers([]);
            setCursor(null);
            setHasMore(false);
            setFilteredTotal(0);
            setLoadError(false);
            setLoading(false);
            setIsRefreshing(false);
            setLoadSlow(false);
            setDataFreshness('fresh');
            setLastSuccessfulSyncAt(Date.now());
            return;
          }
          summaryAvailableRef.current = true;
          setSummary(nextSummary);
          setSummaryAvailable(true);
          setSummaryFreshness('fresh');
          setNotFound(false);
          setAccessDenied(false);
        },
        onPage: (page) => {
          if (!isCurrent()) return;
          membersRef.current = page.items;
          setMembers(page.items);
          setCursor(page.next_cursor);
          setHasMore(page.has_more);
          setFilteredTotal(page.filtered_total);
          setLoadError(false);
          setNotFound(false);
          setAccessDenied(false);
          setDataFreshness('fresh');
          setLastSuccessfulSyncAt(Date.now());
          recoveryAttemptRef.current = 0;
          // ca_touch_member_fee_rollup used to be nudged here. Nothing reads
          // member_fee_rollup any more (verified against pg_proc 2026-09-04:
          // only its own refresh and backfill mention it), so the write was a
          // roster open spending the database on a table nobody looks at.
        },
        onSummaryError: (error) => {
          if (!isCurrent()) return;
          reportError(error, 'ClubMembersPage.loadSummary');
          setSummaryFreshness(summaryAvailableRef.current ? 'stale' : 'failed');
        },
        onPageError: (error) => {
          if (!isCurrent() || abortLike(error)) return;
          const hasSavedRows = membersRef.current.length > 0;
          const recoveryScheduled = scheduleConnectionRecovery(2);
          if (!recoveryScheduled) reportError(error, 'ClubMembersPage.loadFirstPage');
          setLoadError(!recoveryScheduled && !hasSavedRows);
          setLoading(recoveryScheduled && !hasSavedRows);
          setDataFreshness(hasSavedRows ? 'stale' : recoveryScheduled ? 'loading' : 'failed');
        },
      });

      if (
        isCurrent() &&
        summaryResult.status === 'fulfilled' &&
        summaryResult.value &&
        pageResult.status === 'fulfilled' &&
        user?.id &&
        !debouncedSearch &&
        filter === 'all' &&
        sortKey === 'hierarchy'
      ) {
        writeRosterCache(user.id, resolvedClubId, pageResult.value.items, summaryResult.value);
      }
    },
    [debouncedSearch, filter, resolvedClubId, scheduleConnectionRecovery, sortKey, user?.id]
  );

  useEffect(() => {
    latestLoadRef.current = loadFirstPage;
  }, [loadFirstPage]);

  useEffect(() => {
    const handleOffline = () => {
      setBrowserOnline(false);
      realtimeConnectionRef.current = 'degraded';
      setRealtimeConnection('degraded');
      abortRef.current?.abort();
      moreAbortRef.current?.abort();
      setDataFreshness(membersRef.current.length > 0 ? 'stale' : 'failed');
    };
    const handleOnline = () => {
      setBrowserOnline(true);
      realtimeConnectionRef.current = 'connecting';
      setRealtimeConnection('connecting');
      setResolutionAttempt((current) => current + 1);
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  useEffect(() => {
    if (!resolvedClubId) return;
    void loadFirstPage();
    return () => abortRef.current?.abort();
  }, [loadFirstPage, resolvedClubId]);

  useEffect(() => {
    if (!loading || members.length > 0) {
      setLoadSlow(false);
      return;
    }
    const timer = setTimeout(() => setLoadSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [loading, members.length]);

  const refresh = useCallback(async () => {
    if (!resolvedClubId) return;
    setIsRefreshing(true);
    await latestLoadRef.current({ forceSummary: true, resetRecovery: true });
  }, [resolvedClubId]);

  const retryLiveSync = useCallback(() => {
    if (resolvedClubId) {
      void refresh();
      return;
    }
    setLoadError(false);
    setNotFound(false);
    setLoading(true);
    setResolutionAttempt((current) => current + 1);
  }, [refresh, resolvedClubId]);

  const scheduleStructuralRefresh = useCallback(() => {
    if (!resolvedClubId || refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void latestLoadRef.current({ forceSummary: true, resetRecovery: true });
    }, 1200);
  }, [resolvedClubId]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      abortRef.current?.abort();
      moreAbortRef.current?.abort();
    },
    []
  );

  useMasterBusSubscriptions(
    ['CLUB_JOINED', 'CLUB_LEFT', 'MEMBER_ROLE_CHANGED'],
    scheduleStructuralRefresh,
    { debounce: 800 }
  );

  useMasterBusChannel({
    channelName: resolvedClubId ? `club-members-sync-${resolvedClubId}` : null,
    table: 'club_members',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: (payload) => {
      const value = payload as { eventType?: string; new?: { status?: string } } | null;
      const status = value?.new?.status;
      if (
        value?.eventType === 'INSERT' ||
        value?.eventType === 'DELETE' ||
        (value?.eventType === 'UPDATE' && (status === 'banned' || status === 'suspended'))
      )
        scheduleStructuralRefresh();
    },
    onSubscriptionStatus: (status) => {
      if (status !== 'SUBSCRIBED') return;
      const recovered = realtimeConnectionRef.current === 'degraded';
      realtimeConnectionRef.current = 'live';
      setRealtimeConnection('live');
      if (recovered) scheduleStructuralRefresh();
    },
    onSubscriptionError: () => {
      realtimeConnectionRef.current = 'degraded';
      setRealtimeConnection('degraded');
      // Bounded: a flapping channel used to schedule a forced summary + page
      // reload on every error event, for ever, and each successful page reset
      // the attempt counter so the bound never bit. The SUBSCRIBED handler
      // above already refreshes once the channel comes back.
      scheduleConnectionRecovery(2);
    },
    enabled: !!resolvedClubId,
  });

  const loadMore = useCallback(async () => {
    if (!resolvedClubId || !cursor || !hasMore || moreRef.current) return;
    moreRef.current = true;
    setIsLoadingMore(true);
    const epoch = requestEpochRef.current;
    const controller = new AbortController();
    moreAbortRef.current?.abort();
    moreAbortRef.current = controller;
    try {
      const page = await ClubRosterService.getRosterPage(resolvedClubId, {
        search: debouncedSearch,
        filter,
        sort: sortKey,
        cursor,
        limit: PAGE_SIZE,
        signal: controller.signal,
      });
      if (controller.signal.aborted || epoch !== requestEpochRef.current) return;
      setMembers((current) => {
        const known = new Set(current.map((row) => row.user_id));
        const next = [...current, ...page.items.filter((row) => !known.has(row.user_id))];
        membersRef.current = next;
        return next;
      });
      setCursor(page.next_cursor);
      setHasMore(page.has_more);
      setFilteredTotal(page.filtered_total);
    } catch (error) {
      if (!abortLike(error)) {
        reportError(error, 'ClubMembersPage.loadMore');
        toast.error('Could Not Load More Players');
      }
    } finally {
      moreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [cursor, debouncedSearch, filter, hasMore, resolvedClubId, sortKey, toast]);

  const virtual = useVirtualScroll(members, {
    itemHeight: ROW_HEIGHT,
    viewportHeight: 696,
    buffer: 5,
  });
  const resetVirtual = virtual.reset;

  useEffect(() => {
    resetVirtual();
  }, [debouncedSearch, filter, resetVirtual, sortKey]);
  useEffect(() => {
    if (hasMore && virtual.endIndex >= members.length - 8) void loadMore();
  }, [hasMore, loadMore, members.length, virtual.endIndex]);

  const canUseFinancialViews = summary.capabilities.can_view_financials;
  const isAgent = AGENT_ROLES.includes(summary.viewer_role);
  const filters = (Object.keys(FILTER_LABEL) as RosterFilter[]).filter((value) => {
    if (value === 'mine') return isAgent;
    if (value.startsWith('inactive_') || value === 'high_fees') return canUseFinancialViews;
    return true;
  });
  const sorts = (Object.keys(SORT_LABEL) as RosterSort[]).filter(
    (value) => canUseFinancialViews || !['activity', 'downlines', 'wallet', 'fees'].includes(value)
  );

  // Reconcile a deep-linked filter or sort against the viewer's capabilities
  // only once the summary that CARRIES those capabilities has actually
  // answered. It used to gate on the directory's own loading flag: whenever
  // the page RPC beat the summary RPC (or a cached paint landed first, which
  // zeroes capabilities), every financial view was reset to All / Hierarchy,
  // the URL rewritten, and a second page load fired - for an owner.
  useEffect(() => {
    if (summaryFreshness !== 'fresh') return;
    if (!filters.includes(filter)) setFilter('all');
    if (!sorts.includes(sortKey)) setSortKey('hierarchy');
  }, [filter, filters, summaryFreshness, sortKey, sorts]);

  const toggleSelected = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleColumn = useCallback((column: OptionalColumn) => {
    setColumns((current) => {
      const next = new Set(current);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  }, []);

  const openMember = useCallback(
    (userId: string) => {
      if (routeClub) navigate(`/clubs/${routeClub}/members/${userId}`);
    },
    [navigate, routeClub]
  );

  const handleExport = useCallback(async () => {
    if (
      !resolvedClubId ||
      !summary.capabilities.can_export ||
      isExporting ||
      searchQuery.trim() !== debouncedSearch.trim()
    )
      return;
    setIsExporting(true);
    try {
      const result = await ClubRosterService.exportRoster(
        resolvedClubId,
        { search: debouncedSearch, filter, sort: sortKey },
        selected.size ? [...selected] : null
      );
      /* AN EMPTY ROSTER PRODUCES NO FILE. `exportToCSV` returns early when the
         row array is empty (src/lib/export.ts), so "0 Players Exported" was a
         success message for a download that never started. ClubFinancialsPage
         already checks its export's return value; this one now says which of
         the two happened. */
      if (result.rows.length === 0) {
        toast.error('There Are No Players To Export For That Filter.');
        return;
      }
      exportToCSV(
        result.rows.map((row) => ({ ...row, role: roleLabel(row.role as any) })),
        `club-roster-${new Date().toISOString().slice(0, 10)}.csv`
      );
      toast.success(`${result.row_count.toLocaleString()} Players Exported`);
    } catch (error) {
      reportError(error, 'ClubMembersPage.export');
      // The RPC's own refusal (the 5,000-selection cap, for one) is the
      // useful part of the message.
      toast.error(safeErrorMessage(error, 'Could Not Export The Roster'));
    } finally {
      setIsExporting(false);
    }
  }, [
    debouncedSearch,
    filter,
    isExporting,
    resolvedClubId,
    searchQuery,
    selected,
    sortKey,
    summary.capabilities.can_export,
    toast,
  ]);

  const hasPaintedRoster = members.length > 0;
  const searchIsSettling = searchQuery.trim() !== debouncedSearch.trim();
  const stat = (value: number) => {
    if (!summaryAvailable) return summaryFreshness === 'loading' ? '...' : 'N/A';
    return value.toLocaleString();
  };
  const summaryStatusMessage =
    summaryFreshness === 'loading'
      ? 'Live Player Totals Connecting.'
      : summaryFreshness === 'stale'
        ? 'Showing The Last Verified Player Totals While Live Counts Reconnect.'
        : summaryFreshness === 'failed'
          ? 'Live Player Totals Are Unavailable. The Directory Remains Available.'
          : null;
  const connectionState: RosterConnectionState = !browserOnline
    ? 'offline'
    : dataFreshness === 'stale' || (dataFreshness === 'failed' && !notFound && !accessDenied)
      ? 'stale'
      : realtimeConnection === 'degraded'
        ? 'reconnecting'
        : dataFreshness === 'loading'
          ? 'connecting'
          : 'live';

  return (
    <div className="club-members-page" aria-busy={loading}>
      <section className="members-hero" aria-labelledby="members-page-title">
        <img
          className="members-hero__art"
          src={ROSTER_OPERATIONS_ART}
          alt=""
          aria-hidden="true"
          width="1774"
          height="887"
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
        <div className="members-hero__content">
          <div className="members-hero__copy">
            <span className="members-eyebrow">Club Personnel Vault</span>
            <h1 id="members-page-title">Player Command</h1>
            <p>
              Find Any Member, Read Their Live Club Status, And Open The Controls Behind Their Seat.
            </p>
          </div>
          <div className="members-summary-shell">
            <dl
              className="members-summary"
              aria-label="Roster Summary"
              aria-busy={summaryFreshness === 'loading'}
            >
              <SummaryStat value={stat(summary.counts.total)} label="Total Members" />
              <SummaryStat
                value={stat(summary.counts.online)}
                label="Online Now"
                modifier="online"
              />
              <SummaryStat
                value={stat(summary.counts.seated)}
                label="At Tables"
                modifier="seated"
              />
              <SummaryStat value={stat(summary.counts.agents)} label="Agents" modifier="agents" />
            </dl>
            {summaryStatusMessage && (
              <span className="members-summary__status" role="status" aria-live="polite">
                {summaryStatusMessage}
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="members-console" aria-labelledby="members-directory-title">
        <div className="members-console__heading">
          <div>
            <span className="members-eyebrow">Pit Tape Directory</span>
            <h2 id="members-directory-title">Find A Player</h2>
          </div>
          <span className="members-result-count" aria-live="polite">
            {loading && !hasPaintedRoster
              ? 'Loading...'
              : `${filteredTotal.toLocaleString()} Results`}
          </span>
        </div>

        <label className="members-search">
          <span>Search The Roster</span>
          <input
            type="search"
            placeholder={titleCase('search name, number, club, or upline')}
            aria-label="Search Club Members"
            value={searchQuery}
            maxLength={120}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>

        <div className="members-filter-rail" role="group" aria-label="Saved Roster Views">
          <div className="members-filters">
            {filters.map((value) => (
              <button
                key={value}
                type="button"
                className={filter === value ? 'active' : ''}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {FILTER_LABEL[value]}
              </button>
            ))}
          </div>
        </div>

        <div className="members-toolbar">
          <label className="members-sort">
            <span className="members-sort__label">Sort By</span>
            <select
              aria-label="Sort Players"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as RosterSort)}
            >
              {sorts.map((value) => (
                <option key={value} value={value}>
                  {SORT_LABEL[value]}
                </option>
              ))}
            </select>
          </label>

          {canUseFinancialViews && (
            <details className="members-columns">
              <summary>Columns</summary>
              <div className="members-columns__menu">
                {(['downlines', 'wallets', 'fees', 'activity'] as OptionalColumn[]).map(
                  (column) => (
                    <label key={column}>
                      <input
                        type="checkbox"
                        checked={columns.has(column)}
                        onChange={() => toggleColumn(column)}
                      />
                      {titleCase(column)}
                    </label>
                  )
                )}
              </div>
            </details>
          )}

          {summary.capabilities.can_export && members.length > 0 && (
            <button
              type="button"
              className="members-select-loaded"
              aria-pressed={selected.size === members.length}
              onClick={() =>
                setSelected(
                  selected.size === members.length
                    ? new Set()
                    : new Set(members.map((row) => row.user_id))
                )
              }
            >
              {selected.size === members.length ? 'Clear Selection' : 'Select Loaded'}
            </button>
          )}

          <button
            type="button"
            className="members-refresh"
            onClick={() => void refresh()}
            disabled={loading || isRefreshing}
            aria-busy={isRefreshing}
          >
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          {summary.capabilities.can_export && (
            <button
              type="button"
              className="members-export"
              onClick={() => void handleExport()}
              disabled={loading || isRefreshing || isExporting || searchIsSettling}
            >
              {isExporting
                ? 'Preparing...'
                : selected.size
                  ? `Export Selected (${selected.size})`
                  : 'Export CSV'}
            </button>
          )}
        </div>

        <RosterConnectionStatus
          state={connectionState}
          hasData={hasPaintedRoster}
          lastSuccessfulSyncAt={lastSuccessfulSyncAt}
          isRefreshing={isRefreshing}
          isSlow={loadSlow}
          onRetry={retryLiveSync}
        />
      </section>

      {summary.capabilities.can_export && selected.size > 0 && (
        <div className="members-bulk" role="region" aria-label="Selected Players">
          <strong>{selected.size.toLocaleString()} Selected</strong>
          <button
            type="button"
            onClick={() => setSelected(new Set(members.map((row) => row.user_id)))}
          >
            Select Loaded
          </button>
          <button type="button" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={loading || isRefreshing || isExporting || searchIsSettling}
          >
            Export Selected
          </button>
        </div>
      )}

      <div
        className="members-list"
        role="list"
        aria-label="Club Member Directory"
        aria-busy={loading || isLoadingMore}
      >
        {loading && members.length === 0 ? (
          <>
            <PageSkeleton variant="list" />
            {loadSlow && <p className="members-slow">The Roster Is Still Connecting.</p>}
          </>
        ) : notFound ? (
          <div className="members-error" role="alert">
            We Could Not Find That Club.
          </div>
        ) : accessDenied ? (
          <div className="members-error" role="alert">
            This Roster Is Available Only To Approved Club Members.
          </div>
        ) : loadError && members.length === 0 ? (
          <div className="members-error" role="alert">
            Could Not Load The Roster.
            <button type="button" className="members-export" onClick={retryLiveSync}>
              Try Again
            </button>
          </div>
        ) : members.length === 0 ? (
          <EmptyRoster filter={filter} searchQuery={searchQuery} />
        ) : (
          <div ref={virtual.containerRef} className="members-viewport" style={{ height: 696 }}>
            <div aria-hidden="true" style={{ height: virtual.paddingTop }} />
            {virtual.visibleItems.map((member, index) => (
              <MemberRow
                key={member.user_id}
                member={member}
                position={virtual.startIndex + index + 1}
                total={filteredTotal}
                query={debouncedSearch}
                onOpen={openMember}
                selectable={summary.capabilities.can_export}
                selected={selected.has(member.user_id)}
                onSelect={toggleSelected}
                columns={columns}
              />
            ))}
            <div aria-hidden="true" style={{ height: virtual.paddingBottom }} />
            <div ref={virtual.sentinelRef} className="members-sentinel" />
          </div>
        )}
      </div>
      {members.length > 0 && (
        <div className="members-count" role="status" aria-live="polite">
          {isLoadingMore
            ? 'Loading More Players...'
            : `Loaded ${members.length.toLocaleString()} Of ${filteredTotal.toLocaleString()}`}
        </div>
      )}
    </div>
  );
}

function SummaryStat({
  value,
  label,
  modifier,
}: {
  value: string;
  label: string;
  modifier?: string;
}) {
  return (
    <div className={`summary-stat${modifier ? ` summary-stat--${modifier}` : ''}`}>
      <dt className="stat-label">{label}</dt>
      <dd className="stat-value">{value}</dd>
    </div>
  );
}

function highlight(value: string, query: string) {
  const clean = query.trim();
  if (!clean) return value;
  const index = value.toLocaleLowerCase().indexOf(clean.toLocaleLowerCase());
  if (index < 0) return value;
  return (
    <>
      {value.slice(0, index)}
      <mark>{value.slice(index, index + clean.length)}</mark>
      {value.slice(index + clean.length)}
    </>
  );
}

function dormancy(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '';
  const days = Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
  if (days < 1) return 'Today';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function MemberRow({
  member,
  position,
  total,
  query,
  onOpen,
  selectable,
  selected,
  onSelect,
  columns,
}: {
  member: RosterMember;
  position: number;
  total: number;
  query: string;
  onOpen: (id: string) => void;
  selectable: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  columns: Set<OptionalColumn>;
}) {
  const initial = (member.alias || '?')[0]?.toUpperCase() ?? '?';
  const status = member.is_seated ? 'At A Table' : member.is_online ? 'Online' : 'Offline';
  return (
    <article
      className={`member-row${member.is_seated ? ' member-row--seated' : member.is_online ? ' member-row--online' : ''}`}
      role="listitem"
      aria-posinset={position}
      aria-setsize={total}
    >
      {selectable && (
        <label className="member-select" aria-label={`Select ${member.alias}`}>
          <input type="checkbox" checked={selected} onChange={() => onSelect(member.user_id)} />
        </label>
      )}
      <button
        type="button"
        className="member-row__open"
        onClick={() => onOpen(member.user_id)}
        aria-label={`Open ${member.alias}, ${roleLabel(member.role)}, ${status}`}
      >
        <span className="member-avatar">
          {member.avatar_url ? (
            <img
              src={sizedStorageUrl(member.avatar_url, 64)}
              alt=""
              loading="lazy"
              onError={(event) => {
                const image = event.currentTarget;
                image.onerror = null;
                image.src = generateAvatarSvg(member.user_id, member.alias || '?');
              }}
            />
          ) : (
            <span>{initial}</span>
          )}
        </span>
        <span className="member-main">
          <span className="member-identity">
            <RoleBadge role={member.role} size="sm" />
            <span className="member-alias">{highlight(member.alias, query)}</span>
            {member.username && member.username.toLowerCase() !== member.alias.toLowerCase() && (
              <span className="member-username">{highlight(member.username, query)}</span>
            )}
          </span>
          <span className="member-subline">
            <span className="member-role" style={{ color: roleColor(member.role) }}>
              {roleLabel(member.role)}
            </span>
            {member.player_number && (
              <span className="member-number">No. {highlight(member.player_number, query)}</span>
            )}
            {member.home_club_name && (
              <span className="member-club">{highlight(member.home_club_name, query)}</span>
            )}
            {member.upline_name && (
              <span className="member-upline">Under {highlight(member.upline_name, query)}</span>
            )}
            {member.is_seated ? (
              <span className="member-seated">At Table</span>
            ) : member.is_online ? (
              <span className="member-online">Online</span>
            ) : columns.has('activity') && member.last_login ? (
              <span className="member-seen">{dormancy(member.last_login)}</span>
            ) : null}
          </span>
          {member.can_view_financials && (
            <span className="member-metrics">
              {columns.has('downlines') && (
                <Metric label="Downlines" value={chips(member.downline_total)} />
              )}
              {columns.has('wallets') && (
                <>
                  <Metric label="Agent Wallet" value={chips(member.agent_wallet)} />
                  <Metric label="Player Wallet" value={chips(member.player_wallet)} />
                </>
              )}
              {columns.has('fees') && (
                <>
                  <Metric label="Indiv. Fees" value={chips(member.total_fees)} accent />
                  <Metric label="Total Fees" value={chips(member.downline_fees)} accent />
                </>
              )}
            </span>
          )}
        </span>
        <span className="member-chevron" aria-hidden="true">
          &rsaquo;
        </span>
      </button>
    </article>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <span className={`member-metric${accent ? ' member-metric--accent' : ''}`}>
      <span className="member-metric__value" title={value}>
        {value}
      </span>
      <span className="member-metric__label">{label}</span>
    </span>
  );
}

function EmptyRoster({ filter, searchQuery }: { filter: RosterFilter; searchQuery: string }) {
  const searching = searchQuery.trim().length > 0;
  const copy: Partial<Record<RosterFilter, [string, string]>> = {
    agents: ['No Agents Yet', 'No Agent Roles Match This View.'],
    admins: ['No Admins Found', 'No One With Admin Privileges Matches This View.'],
    online: ['No Members Online', 'No Club Members Are Currently Connected.'],
    seated: ['No Players At Tables', 'No Club Members Are Currently Seated At A Live Table.'],
    mine: ['No Downline Players', 'No Players In Your Recursive Downline Match This View.'],
    inactive_30: ['No Inactive Players', 'No Visible Players Have Been Inactive For 30 Days.'],
    inactive_60: ['No Inactive Players', 'No Visible Players Have Been Inactive For 60 Days.'],
    inactive_90: ['No Inactive Players', 'No Visible Players Have Been Inactive For 90 Days.'],
    high_fees: ['No High-Fee Players', 'No Visible Players Have Recorded At Least 100 In Fees.'],
  };
  const [heading, body] = searching
    ? ['No Results Found', `No Results For "${searchQuery}".`]
    : (copy[filter] ?? ['No Members Found', 'Invite Players To Grow Your Club.']);
  return (
    <div className="members-empty">
      <span className="members-empty__mark" aria-hidden="true">
        &bull;
      </span>
      <p className="members-empty__heading">{heading}</p>
      <p className="members-empty__body">{body}</p>
    </div>
  );
}

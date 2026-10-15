import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Link,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { sizedStorageUrl, generateAvatarSvg } from '../utils/avatarGenerator';
import { useAuthUser } from '../hooks/useAuthUser';
import { useDebounce } from '../hooks/useDebounce';
import { useOnlineNow } from '../hooks/useProfilePresence';
import { useMasterBusSubscriptions } from '../hooks/useMasterBusSubscription';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import { useMasterBusBroadcastChannel } from '../hooks/useMasterBusBroadcastChannel';
import { useRosterWalletUpdates } from '../hooks/useRosterWalletUpdates';
import { useToast } from '../components/common/Toast';
import { useVirtualScroll } from '../hooks/useVirtualScroll';
import PageSkeleton from '../components/common/PageSkeleton';
import RoleBadge, { roleColor } from '../components/club/RoleBadge';
import RosterConnectionStatus from '../components/club/RosterConnectionStatus';
import PlayerChangeHistory from '../components/club/PlayerChangeHistory';
import { exportToCSV } from '../lib/export';
import { ClubNotFoundError, resolveClubUUIDStrict } from '../utils/strictClubIdResolver';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { type RosterConnectionState } from '../utils/rosterReadReliability';
import { feeFigure } from '../utils/format';
import { titleCase } from '../utils/titleCase';
import {
  MAX_ROSTER_SELECTION,
  loadedRosterSelection,
  selectLoadedRoster,
  allLoadedSelected,
} from '../utils/rosterSelection';
import { AGENT_ROLES, roleLabel } from '../types/clubRoles';
import ClubRosterService, {
  type RosterCursor,
  type RosterFilter,
  type RosterMember,
  type RosterSort,
  type RosterSummary,
} from '../services/ClubRosterService';
import { purgeRosterCache, readRosterCache, writeRosterCache } from '../lib/rosterCache';
import { RosterSummaryCoordinator, settleRosterReadsIndependently } from '../lib/rosterLoadPolicy';
import {
  ROSTER_ROW_HEIGHT,
  defaultRosterWorkspace,
  readRosterWorkspace,
  writeRosterWorkspace,
  writeRosterReturnPosition,
  takeRosterReturnPosition,
  sameRosterQuery,
  type RosterColumn,
  type RosterReturnPosition,
  type RosterWorkspace,
} from '../lib/rosterWorkspace';
import './ClubMembersPage.css';

const ROSTER_OPERATIONS_ART = `${import.meta.env.BASE_URL}images/club-members/roster-ledger-desk-v2.webp`;
const PAGE_SIZE = 80;
const ROW_HEIGHT = ROSTER_ROW_HEIGHT;

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

type OptionalColumn = RosterColumn;
type SummaryFreshness = 'loading' | 'fresh' | 'stale' | 'failed';
type RosterLoadOptions = { forceSummary?: boolean };
type ExportOperation = {
  owner: object;
  state: 'preparing' | 'success' | 'empty' | 'error';
  filter: RosterFilter;
  sort: RosterSort;
  selectedCount: number;
  searchApplied: boolean;
  auditId?: string;
  rowCount?: number;
  message?: string;
};

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
  return value && Object.prototype.hasOwnProperty.call(FILTER_LABEL, value)
    ? (value as RosterFilter)
    : 'all';
}

function readSort(value: string | null): RosterSort {
  return value && Object.prototype.hasOwnProperty.call(SORT_LABEL, value)
    ? (value as RosterSort)
    : 'hierarchy';
}

function chips(value: number | null): string {
  return value === null
    ? 'Restricted'
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function feeTitle(member: RosterMember): string | undefined {
  if (member.total_fees === null) return undefined;
  const exact = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return member.downline_fees !== null && (member.downline_total ?? 0) > 0
    ? `Fees Generated ${exact(member.total_fees)}. Downline Fees ${exact(member.downline_fees)}.`
    : `Fees Generated ${exact(member.total_fees)}.`;
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
  const location = useLocation();
  const navigationType = useNavigationType();

  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);
  const [summary, setSummary] = useState<RosterSummary>(DEFAULT_SUMMARY);
  const [summaryAvailable, setSummaryAvailable] = useState(false);
  const [summaryFreshness, setSummaryFreshness] = useState<SummaryFreshness>('loading');
  const [directoryAvailable, setDirectoryAvailable] = useState(false);
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [cursor, setCursor] = useState<RosterCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [filter, setFilter] = useState<RosterFilter>(() => readFilter(searchParams.get('view')));
  const [sortKey, setSortKey] = useState<RosterSort>(() => readSort(searchParams.get('sort')));
  const [simpleMode, setSimpleMode] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [columns, setColumns] = useState<Set<OptionalColumn>>(
    () => new Set(defaultRosterWorkspace().columns)
  );
  const [selectedIds, setSelected] = useState<Set<string>>(new Set());
  const selectionQuery = JSON.stringify([routeClub, user?.id, searchQuery, filter, sortKey]);
  const selectionQueryRef = useRef(selectionQuery);
  const loadedMemberIds = useMemo(() => members.map((row) => row.user_id), [members]);
  const selectionQueryCurrent = selectionQueryRef.current === selectionQuery;
  const selected = useMemo(
    () =>
      selectionQueryCurrent
        ? loadedRosterSelection(selectedIds, loadedMemberIds)
        : new Set<string>(),
    [selectionQueryCurrent, selectedIds, loadedMemberIds]
  );
  const loadedSelected = useMemo(
    () => allLoadedSelected(selected, loadedMemberIds),
    [selected, loadedMemberIds]
  );
  const [exportOperation, setExportOperation] = useState<ExportOperation | null>(null);
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
  const [realtimeRetries, setRealtimeRetries] = useState({ members: 0, wallet: 0, audit: 0 });
  const failedRealtimeFeedsRef = useRef(new Set<'members' | 'wallet' | 'audit'>());
  const liveRealtimeFeedsRef = useRef(
    new Map<
      'members' | 'wallet' | 'audit',
      { key: string; state: 'connecting' | 'live' | 'degraded' }
    >()
  );
  const [browserOnline, setBrowserOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine !== false
  );
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<number | null>(null);
  const [resolutionAttempt, setResolutionAttempt] = useState(0);

  const [hydratedSearch, setHydratedSearch] = useState<string | null>('');
  const pendingSearch = useDebounce(searchQuery, 260);
  // Hydration is already validated and committed. Only typed edits owe a debounce.
  const debouncedSearch = searchQuery === hydratedSearch ? searchQuery : pendingSearch;
  const searchSettlingRef = useRef(false);
  searchSettlingRef.current = searchQuery !== debouncedSearch;
  const forceNextSummaryRef = useRef(false);
  const requestEpochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const activePageReadRef = useRef<AbortController | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const exportScopeKey = `${routeClub}:${user?.id ?? ''}`;
  const exportScopeRef = useRef({ key: exportScopeKey });
  // Rotate during render: an old answer cannot land between a scope change
  // and its effect, or become current again after an A/B/A navigation.
  if (exportScopeRef.current.key !== exportScopeKey) {
    exportScopeRef.current = { key: exportScopeKey };
  }
  const [workspaceScope, setWorkspaceScope] = useState<string | null>(null);
  const [loadedQuery, setLoadedQuery] = useState<RosterWorkspace | null>(null);
  const pendingPositionRef = useRef<RosterReturnPosition | null>(null);
  const positionPagesRef = useRef(0);
  const lastWrittenUrlRef = useRef<{ scope: string; query: string } | null>(null);
  const pendingOwnUrlRef = useRef<{
    scope: string;
    sourceEntryKey: string;
    sourceQuery: string;
    targetQuery: string;
  } | null>(null);
  const currentWorkspace: RosterWorkspace = {
    search: searchQuery.slice(0, 120),
    filter,
    sort: sortKey,
    columns: [...columns],
  };
  const moreAbortRef = useRef<AbortController | null>(null);
  const moreRef = useRef(false);
  const membersRef = useRef<RosterMember[]>([]);
  const directoryAvailableRef = useRef(false);
  const summaryAvailableRef = useRef(false);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const summaryCoordinatorRef = useRef(new RosterSummaryCoordinator<RosterSummary | null>());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const realtimeConnectionRef = useRef<'connecting' | 'live' | 'degraded'>('connecting');
  const latestLoadRef = useRef<(options?: RosterLoadOptions) => Promise<void>>(
    async () => undefined
  );

  const wallets = useRosterWalletUpdates(
    `${routeClub}:${user?.id ?? ''}:${searchQuery}:${filter}:${sortKey}`,
    resolvedClubId,
    membersRef,
    setMembers,
    () => setDataFreshness('stale')
  );

  const pendingOwnUrl = pendingOwnUrlRef.current;
  const awaitingOwnUrl =
    pendingOwnUrl?.scope === exportScopeKey &&
    pendingOwnUrl.sourceEntryKey === location.key &&
    pendingOwnUrl.sourceQuery === searchParams.toString();
  const acknowledgedOwnUrl =
    pendingOwnUrl?.scope === exportScopeKey &&
    navigationType === 'REPLACE' &&
    pendingOwnUrl.targetQuery === searchParams.toString() &&
    !awaitingOwnUrl;
  const externalWorkspaceUrl =
    workspaceScope === exportScopeKey &&
    lastWrittenUrlRef.current?.scope === exportScopeKey &&
    !awaitingOwnUrl &&
    !acknowledgedOwnUrl &&
    (pendingOwnUrl?.scope === exportScopeKey ||
      lastWrittenUrlRef.current.query !== searchParams.toString());
  useEffect(() => {
    if (acknowledgedOwnUrl) pendingOwnUrlRef.current = null;
    if (!externalWorkspaceUrl) return;
    pendingOwnUrlRef.current = null;
    // A new history entry can keep this page mounted. Its explicit query
    // must be consumed before the controls write their own replacement URL.
    setFilter(readFilter(searchParams.get('view')));
    setSortKey(readSort(searchParams.get('sort')));
    lastWrittenUrlRef.current = { scope: exportScopeKey, query: searchParams.toString() };
  }, [acknowledgedOwnUrl, exportScopeKey, externalWorkspaceUrl, searchParams]);
  useEffect(() => {
    if (workspaceScope !== exportScopeKey || externalWorkspaceUrl || awaitingOwnUrl) return;
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    if (filter === 'all') next.delete('view');
    else next.set('view', filter);
    if (sortKey === 'hierarchy') next.delete('sort');
    else next.set('sort', sortKey);
    lastWrittenUrlRef.current = { scope: exportScopeKey, query: next.toString() };
    if (next.toString() !== searchParams.toString()) {
      // Only one replacement is outstanding. An urgent page-load render may
      // still see its source URL; wait for the router's acknowledgment before
      // writing any newer control choice.
      pendingOwnUrlRef.current = {
        scope: exportScopeKey,
        sourceEntryKey: location.key,
        sourceQuery: searchParams.toString(),
        targetQuery: next.toString(),
      };
      setSearchParams(next, { replace: true });
    }
  }, [
    awaitingOwnUrl,
    exportScopeKey,
    externalWorkspaceUrl,
    filter,
    location.key,
    searchParams,
    setSearchParams,
    sortKey,
    workspaceScope,
  ]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setWorkspaceScope(null);
    setLoadedQuery(null);
    pendingOwnUrlRef.current = null;
    pendingPositionRef.current = null;
    positionPagesRef.current = 0;
    const inheritedUrl =
      lastWrittenUrlRef.current?.scope !== exportScopeKey &&
      lastWrittenUrlRef.current?.query === searchParams.toString();
    const explicitFilter = !inheritedUrl && searchParams.has('view');
    const explicitSort = !inheritedUrl && searchParams.has('sort');
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    setIsExporting(false);
    setExportOperation(null);
    abortRef.current?.abort();
    moreAbortRef.current?.abort();
    summaryAbortRef.current?.abort();
    summaryAbortRef.current = null;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
    requestEpochRef.current += 1;
    setResolvedClubId(null);
    membersRef.current = [];
    setMembers([]);
    directoryAvailableRef.current = false;
    setDirectoryAvailable(false);
    summaryCoordinatorRef.current.reset();
    forceNextSummaryRef.current = false;
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
    failedRealtimeFeedsRef.current.clear();
    liveRealtimeFeedsRef.current.clear();

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
        const saved = user?.id ? readRosterWorkspace(user.id, id) : null;
        const workspace = saved ?? defaultRosterWorkspace();
        if (explicitFilter) workspace.filter = readFilter(searchParams.get('view'));
        if (explicitSort) workspace.sort = readSort(searchParams.get('sort'));
        setFilter(workspace.filter);
        setSortKey(workspace.sort);
        setColumns(new Set(workspace.columns));
        setHydratedSearch(workspace.search);
        setSearchQuery(workspace.search);
        if (user?.id) {
          const position = takeRosterReturnPosition(user.id, id, location.key);
          if (
            navigationType === 'POP' &&
            position &&
            sameRosterQuery(position.workspace, workspace)
          ) {
            pendingPositionRef.current = position;
          }
          if (workspace.filter === 'all' && workspace.sort === 'hierarchy' && !workspace.search) {
            const cached = readRosterCache(user.id, id);
            if (cached) {
              membersRef.current = cached.rows;
              setMembers(cached.rows);
              directoryAvailableRef.current = true;
              setDirectoryAvailable(true);
              summaryAvailableRef.current = true;
              setSummary(cached.summary);
              setSummaryAvailable(true);
              setSummaryFreshness('stale');
              setFilteredTotal(cached.summary.counts.total);
              setLastSuccessfulSyncAt(cached.cachedAt);
              setDataFreshness('stale');
            }
          }
        }
        setWorkspaceScope(exportScopeKey);
        setResolvedClubId(id);
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
    // Each resolved account/club hydrates its own validated workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolutionAttempt, routeClub, user?.id]);

  useEffect(() => {
    if (!resolvedClubId || !user?.id || workspaceScope !== exportScopeKey) return;
    writeRosterWorkspace(user.id, resolvedClubId, {
      search: searchQuery.slice(0, 120),
      filter,
      sort: sortKey,
      columns: [...columns],
    });
  }, [
    columns,
    exportScopeKey,
    filter,
    resolvedClubId,
    searchQuery,
    sortKey,
    user?.id,
    workspaceScope,
  ]);

  const loadFirstPage = useCallback(
    async (options: RosterLoadOptions = {}) => {
      if (!resolvedClubId || workspaceScope !== exportScopeKey || searchSettlingRef.current) return;
      const forceSummary = options.forceSummary === true || forceNextSummaryRef.current;
      forceNextSummaryRef.current = false;
      const epoch = ++requestEpochRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      activePageReadRef.current = controller;
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
        () => {
          const summaryController = new AbortController();
          summaryAbortRef.current = summaryController;
          return ClubRosterService.getSummary(resolvedClubId, summaryController.signal).finally(
            () => {
              if (summaryAbortRef.current === summaryController) summaryAbortRef.current = null;
            }
          );
        },
        { force: forceSummary }
      );
      const walletRevision = wallets.snapshot();
      const pageRequest = ClubRosterService.getRosterPage(resolvedClubId, {
        search: debouncedSearch,
        filter,
        sort: sortKey,
        limit: PAGE_SIZE,
        signal: controller.signal,
      }).finally(() => {
        if (activePageReadRef.current === controller) activePageReadRef.current = null;
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
          // A confirmed denial retires the pending receipt, even when the
          // account and club have not changed. An unreadable summary does not.
          if (!nextSummary?.capabilities.can_export) {
            exportAbortRef.current?.abort();
            exportAbortRef.current = null;
            setIsExporting(false);
            setExportOperation(null);
            setSelected(new Set());
          }
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
            directoryAvailableRef.current = false;
            setDirectoryAvailable(false);
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
          setLoadedQuery({ search: debouncedSearch, filter, sort: sortKey, columns: [] });
          const nextRows = wallets.reconcile(page.items, walletRevision);
          membersRef.current = nextRows;
          setMembers(nextRows);
          directoryAvailableRef.current = true;
          setDirectoryAvailable(true);
          setCursor(page.next_cursor);
          setHasMore(page.has_more);
          setFilteredTotal(page.filtered_total);
          setLoadError(false);
          setNotFound(false);
          setAccessDenied(false);
          setDataFreshness('fresh');
          setLastSuccessfulSyncAt(Date.now());
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
          const hasVerifiedDirectory = directoryAvailableRef.current;
          // ClubRosterService gives this expensive page read one uninterrupted
          // 40s attempt. Do not automatically launch another database copy
          // when it expires; the visible retry control is the deliberate next
          // attempt. Automatic retry multiplication was the reason a cold page
          // could remain loading while abandoned queries piled up.
          reportError(error, 'ClubMembersPage.loadFirstPage');
          setLoadError(!hasVerifiedDirectory);
          setLoading(false);
          setDataFreshness(hasVerifiedDirectory ? 'stale' : 'failed');
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
        writeRosterCache(user.id, resolvedClubId, membersRef.current, summaryResult.value);
      }
      // A structural event may arrive after this read started. Preserve its
      // invalidation, but let the healthy page publish before reading again.
      // Query changes already consume the same flag in their own first read.
      if (
        isCurrent() &&
        pageResult.status === 'fulfilled' &&
        forceNextSummaryRef.current &&
        !searchSettlingRef.current
      ) {
        void latestLoadRef.current({ forceSummary: true });
      }
    },
    [debouncedSearch, exportScopeKey, filter, resolvedClubId, sortKey, user?.id, workspaceScope]
  );

  useEffect(() => {
    latestLoadRef.current = loadFirstPage;
  }, [loadFirstPage]);

  useEffect(() => {
    const handleOffline = () => {
      setBrowserOnline(false);
      realtimeConnectionRef.current = 'degraded';
      setRealtimeConnection('degraded');
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
      abortRef.current?.abort();
      moreAbortRef.current?.abort();
      summaryAbortRef.current?.abort();
      summaryAbortRef.current = null;
      // An aborted request deliberately fails the isCurrent() guard, so its
      // own finally block cannot clear these flags. Clear them at the event
      // that owns the abort or the directory can remain aria-busy forever.
      setLoadError(!directoryAvailableRef.current);
      setLoading(false);
      setIsRefreshing(false);
      setLoadSlow(false);
      setSummaryFreshness(summaryAvailableRef.current ? 'stale' : 'failed');
      setDataFreshness(directoryAvailableRef.current ? 'stale' : 'failed');
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
    // Reverting to the already committed query can cancel the debounce without
    // changing loadFirstPage. That still owes the deferred structural read.
    if (
      searchQuery !== debouncedSearch ||
      !forceNextSummaryRef.current ||
      activePageReadRef.current
    )
      return;
    forceNextSummaryRef.current = false;
    void latestLoadRef.current({ forceSummary: true });
  }, [debouncedSearch, searchQuery]);

  useEffect(() => {
    if (!loading || members.length > 0) {
      setLoadSlow(false);
      return;
    }
    const timer = setTimeout(() => setLoadSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [loading, members.length]);

  const refresh = useCallback(async () => {
    // No request is admitted while the search debounce is unsettled. Do not
    // claim a refresh started when its loader must return without one.
    if (!resolvedClubId || searchSettlingRef.current) return;
    setIsRefreshing(true);
    await latestLoadRef.current({ forceSummary: true });
  }, [resolvedClubId]);

  const retryLiveSync = useCallback(() => {
    if (resolvedClubId) {
      // A roster read cannot repair a failed WebSocket join. Retry only the
      // bindings that reported failure; healthy channels retain their owner.
      const failed = [...failedRealtimeFeedsRef.current];
      if (failed.length) {
        setRealtimeRetries((current) => {
          const next = { ...current };
          for (const feed of failed) next[feed]++;
          return next;
        });
      }
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
      // The pending query owns its next read. Starting the old search here
      // would be aborted as soon as its debounce commits. Carry the structural
      // summary invalidation into that same new query instead.
      if (searchSettlingRef.current || activePageReadRef.current) {
        forceNextSummaryRef.current = true;
        return;
      }
      void latestLoadRef.current({ forceSummary: true });
    }, 1200);
  }, [resolvedClubId]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      abortRef.current?.abort();
      moreAbortRef.current?.abort();
      summaryAbortRef.current?.abort();
      exportAbortRef.current?.abort();
    },
    []
  );

  const auditEnabled =
    !!resolvedClubId && ['owner', 'co_owner', 'admin'].includes(summary.viewer_role);
  const publishRealtimeAggregate = useCallback(() => {
    const states = [...liveRealtimeFeedsRef.current.values()].map((feed) => feed.state);
    const next = states.includes('degraded')
      ? 'degraded'
      : states.length > 0 && states.every((state) => state === 'live')
        ? 'live'
        : 'connecting';
    realtimeConnectionRef.current = next;
    setRealtimeConnection(next);
  }, []);
  const markRealtimeFeed = useCallback(
    (feed: 'members' | 'wallet' | 'audit', status: string) => {
      const current = liveRealtimeFeedsRef.current.get(feed);
      if (!current) return false;
      const recovered = current.state === 'degraded';
      if (status === 'SUBSCRIBED') {
        current.state = 'live';
        failedRealtimeFeedsRef.current.delete(feed);
      } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        current.state = 'degraded';
        failedRealtimeFeedsRef.current.add(feed);
      }
      publishRealtimeAggregate();
      return recovered;
    },
    [publishRealtimeAggregate]
  );
  // Register pending feeds before the subscription effects run. A role change
  // can add audit coverage after the other feeds have already acknowledged.
  useEffect(() => {
    const enabled = {
      members: !!resolvedClubId,
      wallet: !!resolvedClubId && !!user?.id,
      audit: auditEnabled,
    };
    for (const feed of ['members', 'wallet', 'audit'] as const) {
      if (!enabled[feed]) {
        liveRealtimeFeedsRef.current.delete(feed);
        failedRealtimeFeedsRef.current.delete(feed);
        continue;
      }
      const key = `${user?.id}:${resolvedClubId}:${realtimeRetries[feed]}`;
      if (liveRealtimeFeedsRef.current.get(feed)?.key !== key) {
        liveRealtimeFeedsRef.current.set(feed, { key, state: 'connecting' });
        failedRealtimeFeedsRef.current.delete(feed);
      }
    }
    publishRealtimeAggregate();
  }, [resolvedClubId, user?.id, auditEnabled, realtimeRetries, publishRealtimeAggregate]);

  useMasterBusSubscriptions(
    ['CLUB_JOINED', 'CLUB_LEFT', 'MEMBER_ROLE_CHANGED'],
    (payload) => {
      const event = payload as { clubId?: string } | null;
      if (event?.clubId === resolvedClubId) scheduleStructuralRefresh();
    },
    { debounce: 800 }
  );

  useMasterBusChannel({
    channelName: resolvedClubId ? `club-members-sync-${resolvedClubId}` : null,
    restartKey: realtimeRetries.members,
    table: 'club_members',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: (payload) => {
      const value = payload as {
        eventType?: string;
        new?: Record<string, unknown>;
        old?: Record<string, unknown>;
      } | null;
      const next = value?.new;
      if (value?.eventType === 'UPDATE' && next) wallets.membership(next);
      const previous = value?.old;
      const member = membersRef.current.find((row) => row.user_id === next?.user_id);
      // WAL's default old image has only keys. Compare a full old image when
      // present, otherwise the displayed identity. Wallet churn alone must not
      // abort a healthy directory load.
      const structural = ['role', 'status', 'agent_id', 'nickname', 'notes', 'display_name'].some(
        (field) =>
          next && previous && field in next && field in previous && next[field] !== previous[field]
      );
      const displayedIdentityChanged =
        member &&
        next &&
        ((typeof next.role === 'string' && next.role !== member.role) ||
          ('agent_id' in next && next.agent_id !== member.upline_user_id) ||
          (member.can_view_notes &&
            (('nickname' in next && next.nickname !== member.nickname) ||
              ('notes' in next && next.notes !== member.remark))));
      if (
        value?.eventType === 'INSERT' ||
        value?.eventType === 'DELETE' ||
        (value?.eventType === 'UPDATE' &&
          (structural ||
            displayedIdentityChanged ||
            next?.status === 'banned' ||
            next?.status === 'suspended'))
      )
        scheduleStructuralRefresh();
    },
    onSubscriptionStatus: (status) => {
      if (status !== 'SUBSCRIBED') return;
      const recovered = markRealtimeFeed('members', status);
      if (recovered) scheduleStructuralRefresh();
    },
    onSubscriptionError: () => {
      markRealtimeFeed('members', 'CHANNEL_ERROR');
      // A channel error is not evidence that the roster snapshot is stale.
      // Reload once SUBSCRIBED confirms recovery; scheduling work here let a
      // flapping socket abort healthy directory reads and reset its own bound.
    },
    enabled: !!resolvedClubId,
  });

  const walletChannelDegradedRef = useRef(false);
  useMasterBusBroadcastChannel({
    channelName: resolvedClubId ? `club-roster-wallet:${resolvedClubId}` : null,
    restartKey: realtimeRetries.wallet,
    event: 'wallet_changed',
    enabled: !!resolvedClubId && !!user?.id,
    onPayload: (value) => {
      const payload = (value as { payload?: { club_id?: string; user_id?: string } } | null)
        ?.payload;
      if (payload?.club_id === resolvedClubId && typeof payload.user_id === 'string') {
        wallets.refresh(payload.user_id);
      }
    },
    onSubscriptionError: () => {
      markRealtimeFeed('wallet', 'CHANNEL_ERROR');
      walletChannelDegradedRef.current = true;
      setDataFreshness('stale');
    },
    onSubscriptionStatus: (status) => {
      if (status !== 'SUBSCRIBED') return;
      markRealtimeFeed('wallet', status);
      const recovered = walletChannelDegradedRef.current;
      walletChannelDegradedRef.current = false;
      if (recovered) wallets.refresh();
    },
  });
  useMasterBusSubscriptions(['BALANCE_UPDATED'], (value) => {
    const payload = value as { clubId?: string; userId?: string } | null;
    if (payload?.clubId && payload.clubId !== resolvedClubId) return;
    if (payload?.clubId === resolvedClubId || typeof payload?.userId === 'string') {
      wallets.refresh(payload?.userId);
    }
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
      const walletRevision = wallets.snapshot();
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
        const next = [
          ...current,
          ...wallets.reconcile(page.items, walletRevision).filter((row) => !known.has(row.user_id)),
        ];
        membersRef.current = next;
        return next;
      });
      if (page.items.length === 0 || JSON.stringify(page.next_cursor) === JSON.stringify(cursor)) {
        pendingPositionRef.current = null;
      }
      setCursor(page.next_cursor);
      setHasMore(page.has_more);
      setFilteredTotal(page.filtered_total);
    } catch (error) {
      if (!abortLike(error)) {
        pendingPositionRef.current = null;
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
    const position = pendingPositionRef.current;
    if (!position) return;
    if (loadError || accessDenied || dataFreshness === 'failed') {
      pendingPositionRef.current = null;
      return;
    }
    if (
      workspaceScope !== exportScopeKey ||
      !sameRosterQuery(position.workspace, currentWorkspace)
    ) {
      pendingPositionRef.current = null;
      return;
    }
    if (
      searchQuery !== debouncedSearch ||
      loading ||
      isLoadingMore ||
      !loadedQuery ||
      !sameRosterQuery(loadedQuery, currentWorkspace) ||
      dataFreshness !== 'fresh'
    )
      return;
    const node = virtual.containerRef.current;
    const viewportHeight = node?.clientHeight || 696;
    const requiredRows = Math.ceil((position.viewportTop + viewportHeight) / ROW_HEIGHT);
    if (hasMore && members.length < requiredRows) {
      if (positionPagesRef.current >= Math.ceil(requiredRows / PAGE_SIZE)) {
        pendingPositionRef.current = null;
        return;
      }
      positionPagesRef.current += 1;
      void loadMore();
      return;
    }
    if (node) {
      node.scrollTop = Math.min(
        position.viewportTop,
        Math.max(0, node.scrollHeight - viewportHeight)
      );
      node.dispatchEvent(new Event('scroll'));
    }
    window.scrollTo({ top: position.windowTop, behavior: 'instant' });
    pendingPositionRef.current = null;
  }, [
    accessDenied,
    dataFreshness,
    debouncedSearch,
    exportScopeKey,
    filter,
    hasMore,
    isLoadingMore,
    loadError,
    loadMore,
    loadedQuery,
    loading,
    members.length,
    searchQuery,
    sortKey,
    workspaceScope,
  ]);
  useEffect(() => {
    if (!pendingPositionRef.current && hasMore && virtual.endIndex >= members.length - 8)
      void loadMore();
  }, [hasMore, loadMore, members.length, virtual.endIndex]);

  // Default WAL old images cannot identify an off-page promotion. The
  // already-authorized, persisted audit event carries its structural cause;
  // wallet traffic never enters this lane. Existing RLS remains authoritative.
  useMasterBusChannel({
    channelName: resolvedClubId ? `club-members-audit-${resolvedClubId}` : null,
    restartKey: realtimeRetries.audit,
    table: 'audit_trail',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: 'INSERT',
    onPayload: (payload) => {
      const row = (payload as { new?: Record<string, unknown> } | null)?.new;
      if (
        row?.club_id === resolvedClubId &&
        row?.target_type === 'club_member' &&
        ['set_member_role', 'set_member_status', 'update_member_notes'].includes(String(row.action))
      )
        scheduleStructuralRefresh();
    },
    enabled: auditEnabled,
    onSubscriptionError: () => {
      markRealtimeFeed('audit', 'CHANNEL_ERROR');
    },
    onSubscriptionStatus: (status) => {
      if (status !== 'SUBSCRIBED') return;
      const recovered = markRealtimeFeed('audit', status);
      if (recovered) scheduleStructuralRefresh();
    },
  });

  const canUseFinancialViews = summary.capabilities.can_view_financials;
  const isAgent = AGENT_ROLES.includes(summary.viewer_role);
  const filters = useMemo(
    () =>
      (Object.keys(FILTER_LABEL) as RosterFilter[]).filter((value) => {
        if (value === 'mine') return isAgent;
        if (value.startsWith('inactive_') || value === 'high_fees') return canUseFinancialViews;
        return true;
      }),
    [isAgent, canUseFinancialViews]
  );
  const sorts = useMemo(
    () =>
      (Object.keys(SORT_LABEL) as RosterSort[]).filter(
        (value) =>
          canUseFinancialViews || !['activity', 'downlines', 'wallet', 'fees'].includes(value)
      ),
    [canUseFinancialViews]
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

  useEffect(() => {
    selectionQueryRef.current = selectionQuery;
    setSelected(new Set());
  }, [selectionQuery]);
  useEffect(() => {
    setSelected((current) => {
      const next = loadedRosterSelection(current, loadedMemberIds);
      return next.size === current.size && [...next].every((id) => current.has(id))
        ? current
        : next;
    });
  }, [loadedMemberIds]);

  const toggleSelected = useCallback((id: string) => {
    if (!membersRef.current.some((row) => row.user_id === id)) return;
    setSelected((current) => {
      const next = loadedRosterSelection(
        current,
        membersRef.current.map((row) => row.user_id)
      );
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_ROSTER_SELECTION) next.add(id);
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
      if (!routeClub || workspaceScope !== exportScopeKey) return;
      if (resolvedClubId && user?.id) {
        writeRosterWorkspace(user.id, resolvedClubId, currentWorkspace);
        writeRosterReturnPosition(user.id, resolvedClubId, {
          version: 1,
          entryKey: location.key,
          workspace: currentWorkspace,
          viewportTop: virtual.containerRef.current?.scrollTop ?? 0,
          windowTop: window.scrollY,
        });
      }
      navigate(`/clubs/${routeClub}/members/${userId}`);
    },
    [
      columns,
      exportScopeKey,
      filter,
      location.key,
      navigate,
      resolvedClubId,
      routeClub,
      searchQuery,
      sortKey,
      user?.id,
      workspaceScope,
    ]
  );

  const handleExport = useCallback(async () => {
    if (
      !resolvedClubId ||
      !summary.capabilities.can_export ||
      isExporting ||
      exportAbortRef.current !== null ||
      (selectedIds.size > 0 && selected.size === 0) ||
      searchQuery.trim() !== debouncedSearch.trim()
    )
      return;
    const controller = new AbortController();
    const scope = exportScopeRef.current;
    exportAbortRef.current = controller;
    const ownsExport = () =>
      !controller.signal.aborted &&
      exportScopeRef.current === scope &&
      exportAbortRef.current === controller;
    // These describe this request, even if the viewer changes controls while
    // the authorized export is being prepared. They are not a snapshot time.
    const exportQuery = { search: debouncedSearch.trim().slice(0, 120), filter, sort: sortKey };
    const exportSelection = selected.size ? [...selected] : null;
    const requestedAt = new Date().toISOString();
    const operation = {
      owner: scope,
      state: 'preparing' as const,
      filter: exportQuery.filter,
      sort: exportQuery.sort,
      selectedCount: exportSelection?.length ?? 0,
      searchApplied: exportQuery.search.length > 0,
    };
    setExportOperation(operation);
    setIsExporting(true);
    try {
      const result = await ClubRosterService.exportRoster(
        resolvedClubId,
        exportQuery,
        exportSelection,
        controller.signal
      );
      if (!ownsExport()) return;
      /* AN EMPTY ROSTER PRODUCES NO FILE. `exportToCSV` returns early when the
         row array is empty (src/lib/export.ts), so "0 Players Exported" was a
         success message for a download that never started. ClubFinancialsPage
         already checks its export's return value; this one now says which of
         the two happened. */
      if (result.rows.length === 0) {
        setExportOperation({
          ...operation,
          state: 'empty',
          auditId: result.audit_id,
          rowCount: result.row_count,
        });
        toast.error('There Are No Players To Export For That Filter.');
        return;
      }
      const completedAt = new Date().toISOString();
      exportToCSV(
        result.rows.map((row) => ({
          ...row,
          role: roleLabel(row.role as any),
          export_club_id: resolvedClubId,
          export_scope: exportSelection ? 'selected_matching' : 'all_matching',
          export_filter: exportQuery.filter,
          export_sort: exportQuery.sort,
          export_search: exportQuery.search,
          export_selected_count: exportSelection?.length ?? 0,
          export_row_count: result.row_count,
          export_requested_at_utc: requestedAt,
          export_completed_at_utc: completedAt,
          export_audit_id: result.audit_id,
          export_activity_period: 'All Recorded Activity',
          export_units: 'Club Chips',
        })),
        `club-roster-${new Date().toISOString().slice(0, 10)}.csv`
      );
      toast.success(`${result.row_count.toLocaleString()} Players Exported`);
      setExportOperation({
        ...operation,
        state: 'success',
        auditId: result.audit_id,
        rowCount: result.row_count,
      });
    } catch (error) {
      if (!ownsExport()) return;
      reportError(error, 'ClubMembersPage.export');
      // The RPC's own refusal (the 5,000-selection cap, for one) is the
      // useful part of the message.
      toast.error(safeErrorMessage(error, 'Could Not Export The Roster'));
      setExportOperation({
        ...operation,
        state: 'error',
        message: safeErrorMessage(error, 'Could Not Export The Roster'),
      });
    } finally {
      if (ownsExport()) {
        exportAbortRef.current = null;
        setIsExporting(false);
      }
    }
  }, [
    debouncedSearch,
    filter,
    isExporting,
    resolvedClubId,
    searchQuery,
    selected,
    selectedIds,
    sortKey,
    summary.capabilities.can_export,
    toast,
  ]);

  const hasVerifiedDirectory = directoryAvailable;
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
          : realtimeConnection === 'connecting'
            ? 'connecting'
            : 'live';

  return (
    <div
      className={`club-members-page${simpleMode ? ' members-simple' : ''}`}
      aria-busy={loading}
      data-players-mode={simpleMode ? 'simple' : 'advanced'}
    >
      <div className="members-mode-heading">
        {simpleMode ? <h1>Player Management</h1> : <span>Player Management</span>}
        <div role="group" aria-label="Player Management Mode">
          <button type="button" aria-pressed={simpleMode} onClick={() => setSimpleMode(true)}>
            Simple
          </button>
          <button type="button" aria-pressed={!simpleMode} onClick={() => setSimpleMode(false)}>
            Advanced
          </button>
        </div>
      </div>
      {!simpleMode && (
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
              <span className="members-eyebrow">Club Players</span>
              <h1 id="members-page-title">Player Command</h1>
              {summary.capabilities.can_manage_members && (
                <Link className="members-applicants" to={`/clubs/${routeClubId}/applicants`}>
                  Review Applicants
                </Link>
              )}

              <p>
                Find Any Member, Read Their Live Club Status, And Open The Controls Behind Their
                Seat.
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
      )}

      <section
        className="members-console"
        aria-label={simpleMode ? 'Player Directory' : undefined}
        aria-labelledby={simpleMode ? undefined : 'members-directory-title'}
      >
        {!simpleMode && (
          <div className="members-console__heading">
            <div>
              <span className="members-eyebrow">Member Directory</span>
              <h2 id="members-directory-title">Find A Player</h2>
            </div>
            <span className="members-result-count" aria-live="polite">
              {loading && !hasVerifiedDirectory
                ? 'Loading...'
                : `${filteredTotal.toLocaleString()} Results`}
            </span>
          </div>
        )}

        {simpleMode && (
          <div className="members-simple-tabs" role="group" aria-label="Player Views">
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              All
            </button>
            <button
              type="button"
              aria-pressed={filter === 'agents'}
              onClick={() => setFilter('agents')}
            >
              Agents
            </button>
            {summary.capabilities.can_manage_members && (
              <Link to={`/clubs/${routeClubId}/applicants`}>Applicants</Link>
            )}
          </div>
        )}
        {simpleMode && !['all', 'agents'].includes(filter) && (
          <button type="button" className="members-active-view" onClick={() => setFilter('all')}>
            {FILTER_LABEL[filter]}: Clear Filter
          </button>
        )}
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
            onChange={(event) => {
              setHydratedSearch(null);
              setSearchQuery(event.target.value);
            }}
          />
        </label>

        {!simpleMode && (
          <div className="members-filter-rail" role="group" aria-label="Saved Roster Views">
            <label className="members-view-filter">
              <span>Filter Players</span>
              <select
                aria-label="Filter Players"
                value={filter}
                onChange={(event) => setFilter(event.target.value as RosterFilter)}
              >
                {filters.map((value) => (
                  <option key={value} value={value}>
                    {FILTER_LABEL[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="members-toolbar">
          {simpleMode && (
            <button
              type="button"
              className="members-group-role"
              aria-pressed={sortKey === 'hierarchy'}
              onClick={() => setSortKey(sortKey === 'hierarchy' ? 'name' : 'hierarchy')}
            >
              Group By Role
            </button>
          )}
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

          {!simpleMode && canUseFinancialViews && (
            <details className="members-columns">
              <summary>Columns</summary>
              <div className="members-columns__menu">
                {(['fees', 'downlines', 'activity', 'wallets'] as OptionalColumn[]).map(
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

          {!simpleMode && summary.capabilities.can_export && members.length > 0 && (
            <button
              type="button"
              className="members-select-loaded"
              aria-pressed={loadedSelected}
              onClick={() =>
                setSelected(loadedSelected ? new Set() : selectLoadedRoster(loadedMemberIds))
              }
            >
              {loadedSelected ? 'Clear Selection' : 'Select Loaded'}
            </button>
          )}

          <button
            type="button"
            className="members-refresh"
            onClick={() => void refresh()}
            disabled={loading || isRefreshing || searchQuery !== debouncedSearch}
            aria-busy={isRefreshing}
          >
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          {!simpleMode && summary.capabilities.can_export && (
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

        {!simpleMode && summary.capabilities.can_export && (
          <p className="members-count" role="note" aria-label="Export Scope">
            <strong>Export Scope: </strong>
            <span>
              {selected.size
                ? 'Selected Players Matching The Current Filter And Search'
                : 'All Matching Players Across Every Page'}
            </span>{' '}
            Includes Authorized Fields Regardless Of Visible Columns.
          </p>
        )}
        {!simpleMode && (
          <details className="members-columns">
            <summary>Metric Definitions</summary>
            <div className="members-count">
              <p>Downlines: Players In The Recursive Downline, Excluding This Player.</p>
              <p>
                Player Wallet: Current Club Member Chip Balance. Agent Wallet: Current Active Agent
                Chip Balance. Wallets Are An Optional Column And Never Replace Fees.
              </p>
              <p>
                Fees Generated (Indiv. Fees): Cash Game Rake Attributed To This Player Plus Their
                Tournament Entry Fees. Downline Fees: Fees Generated By The Recursive Downline Only,
                Excluding This Player.
              </p>
              <p>
                Fees Are Read From The Club Fee Ledgers That Pay Agents And Rakeback, All Time, With
                No Date Filter On This Roster. Wallets And Fees Are In Club Chips.
              </p>
              <p>
                Recent Activity Uses Login Time When Available, Otherwise Presence Or Club Activity
                Time. Online Includes Players At A Live Table Or With Fresh Presence.
              </p>
              <p>
                Select Loaded Selects Only Players Already Loaded. Export Without A Selection Reads
                All Authorized Matches Across Every Page. A Selection Is Further Limited By The
                Current Filter And Search.
              </p>
            </div>
          </details>
        )}

        <RosterConnectionStatus
          state={connectionState}
          hasData={hasVerifiedDirectory}
          lastSuccessfulSyncAt={lastSuccessfulSyncAt}
          isRefreshing={isRefreshing}
          isSlow={loadSlow}
          onRetry={retryLiveSync}
        />
        <p
          className="members-count"
          role="status"
          aria-label="Roster Operations"
          aria-live="polite"
        >
          {hasVerifiedDirectory && workspaceScope === exportScopeKey
            ? loadedQuery && sameRosterQuery(loadedQuery, currentWorkspace) && !searchIsSettling
              ? `${members.length.toLocaleString()} Loaded Of ${filteredTotal.toLocaleString()} Matching Players.`
              : `Showing ${members.length.toLocaleString()} Previously Verified Players. Current Filter And Search Not Yet Verified.`
            : 'Directory Not Yet Verified.'}{' '}
          {!simpleMode && summary.capabilities.can_export
            ? `${selected.size.toLocaleString()} Loaded Players Selected. Selection Limit ${MAX_ROSTER_SELECTION.toLocaleString()}.`
            : ''}
        </p>
        {exportOperation &&
          exportOperation.owner === exportScopeRef.current &&
          summary.capabilities.can_export && (
            <p
              className="members-count"
              role="status"
              aria-label="Export Operation"
              aria-live="polite"
              data-operation-state={exportOperation.state}
            >
              {exportOperation.state === 'preparing'
                ? 'Preparing Export.'
                : exportOperation.state === 'success'
                  ? `${exportOperation.rowCount?.toLocaleString()} Players Exported. CSV Prepared. Download Requested.`
                  : exportOperation.state === 'empty'
                    ? 'No Matching Players. No CSV Download Started.'
                    : `Export Failed. ${titleCase(exportOperation.message ?? 'Could Not Export The Roster')}`}{' '}
              {exportOperation.selectedCount
                ? `${exportOperation.selectedCount.toLocaleString()} Selected Loaded Players.`
                : 'All Matching Players Across Every Page.'}{' '}
              Filter: {FILTER_LABEL[exportOperation.filter]}. Sort:{' '}
              {SORT_LABEL[exportOperation.sort]}. Search:{' '}
              {exportOperation.searchApplied ? 'Applied' : 'None'}.
              {exportOperation.auditId ? ` Audit Reference: ${exportOperation.auditId}.` : ''}
            </p>
          )}
        {!simpleMode && resolvedClubId && user?.id && (
          <PlayerChangeHistory
            key={`history:${resolvedClubId}:${user.id}`}
            clubId={resolvedClubId}
            viewerId={user.id}
            enabled={!accessDenied && ['owner', 'co_owner', 'admin'].includes(summary.viewer_role)}
          />
        )}
      </section>

      {!simpleMode && summary.capabilities.can_export && selected.size > 0 && (
        <div className="members-bulk" role="region" aria-label="Selected Players">
          <strong>{selected.size.toLocaleString()} Selected</strong>
          <button type="button" onClick={() => setSelected(selectLoadedRoster(loadedMemberIds))}>
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
          <div
            ref={virtual.containerRef}
            className="members-viewport"
            style={{ height: 696 }}
            onScroll={() => {
              pendingPositionRef.current = null;
            }}
          >
            <div aria-hidden="true" style={{ height: virtual.paddingTop }} />
            {virtual.visibleItems.map((member, index) => (
              <MemberRow
                key={member.user_id}
                member={member}
                position={virtual.startIndex + index + 1}
                total={filteredTotal}
                query={debouncedSearch}
                onOpen={openMember}
                selectable={!simpleMode && summary.capabilities.can_export}
                simpleMode={simpleMode}
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

function lastSeen(iso: string): string {
  const age = dormancy(iso);
  if (!age) return '';
  return age === 'Today' ? 'Seen Today' : `Seen ${age} Ago`;
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

export const MemberRow = memo(function MemberRow({
  member,
  position,
  total,
  query,
  onOpen,
  selectable,
  selected,
  onSelect,
  columns,
  simpleMode = false,
}: {
  simpleMode?: boolean;
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
  /* The roster's is_online is "seated OR fresh presence"; off a seat it is the
     presence door's answer, re-asked every minute while the row is shown so
     it goes dark when the heartbeat does (presence-has-one-definition law). */
  const online = useOnlineNow(member.user_id, member.is_online);
  const status = member.is_seated ? 'At A Table' : online ? 'Online' : 'Offline';
  return (
    <div
      className={`member-row${member.is_seated ? ' member-row--seated' : online ? ' member-row--online' : ''}`}
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
            {!simpleMode && <RoleBadge role={member.role} size="sm" />}
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
              <span className="member-number">
                {simpleMode ? 'ID: ' : 'No. '}
                {highlight(member.player_number, query)}
              </span>
            )}
            {member.home_club_name && (
              <span className="member-club">{highlight(member.home_club_name, query)}</span>
            )}
            {member.upline_name && (
              <span className="member-upline">Under {highlight(member.upline_name, query)}</span>
            )}
            {member.is_seated ? (
              <span className="member-seated">At Table</span>
            ) : online ? (
              <span className="member-online">Online</span>
            ) : columns.has('activity') && member.last_login ? (
              <span className="member-seen">{lastSeen(member.last_login)}</span>
            ) : null}
          </span>
          {simpleMode && member.can_view_financials && (
            <span className="member-simple-balance" title={feeTitle(member)}>
              <strong>{feeFigure(member.total_fees)}</strong>
              <span>Fees Generated</span>
              {(member.downline_total ?? 0) > 0 && member.downline_fees !== null && (
                <span className="member-simple-balance__downline">
                  Downline {feeFigure(member.downline_fees)}
                </span>
              )}
            </span>
          )}
          {!simpleMode && member.can_view_financials && (
            <span className="member-metrics">
              {columns.has('downlines') && (
                <Metric label="Downlines" value={chips(member.downline_total)} />
              )}
              {columns.has('fees') && (
                <>
                  <Metric label="Indiv. Fees" value={chips(member.total_fees)} accent />
                  <Metric label="Downline Fees" value={chips(member.downline_fees)} accent />
                </>
              )}
              {columns.has('wallets') && (
                <>
                  <Metric label="Agent Wallet" value={chips(member.agent_wallet)} />
                  <Metric label="Player Wallet" value={chips(member.player_wallet)} />
                </>
              )}
            </span>
          )}
        </span>
        <span className="member-chevron" aria-hidden="true">
          &rsaquo;
        </span>
      </button>
    </div>
  );
});

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

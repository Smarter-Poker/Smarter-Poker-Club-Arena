import { usePlayerPreference } from '../hooks/usePlayerPreference';
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
import PageBar from '../components/help/PageBar';
import type { TutorialStep } from '../components/help/PageHelp';
import RoleBadge, { roleColor } from '../components/club/RoleBadge';
import RosterConnectionStatus from '../components/club/RosterConnectionStatus';
import PlayerChangeHistory from '../components/club/PlayerChangeHistory';
import { exportToCSV } from '../lib/export';
import { ClubNotFoundError, resolveClubUUIDStrict } from '../utils/strictClubIdResolver';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { type RosterConnectionState } from '../utils/rosterReadReliability';
import { countFigure, feeFigure, formatWalletChips, winLossChips } from '../utils/format';
import { useRosterWinLoss } from '../hooks/useRosterWinLoss';
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
  type WinLossFigure,
  type WinLossPeriod,
} from '../services/ClubRosterService';
import { purgeRosterCache, readRosterCache, writeRosterCache } from '../lib/rosterCache';
import { RosterSummaryCoordinator, settleRosterReadsIndependently } from '../lib/rosterLoadPolicy';
import {
  ROSTER_ROW_HEIGHT,
  defaultRosterWorkspace,
  loadRosterWorkspace,
  writeRosterWorkspace,
  writeRosterReturnPosition,
  takeRosterReturnPosition,
  sameRosterQuery,
  type RosterColumn,
  type RosterReturnPosition,
  type RosterWorkspace,
} from '../lib/rosterWorkspace';
import './ClubMembersPage.css';

/* The page's tour. The controls that matter here are a toggle, a search, a
   filter and a list, none of them a section heading, so the generic tour
   would miss them (Dan 2026-10-17: the words moved behind the "?"). */
const SHARED_TOUR_HEAD: TutorialStep[] = [
  {
    title: 'Simple Or Advanced',
    body: 'Simple Is A Compact Directory. Advanced Opens The Full Desk With Totals, Saved Views, Columns, Export And Player History.',
    target: '.members-mode-toggle',
  },
  {
    title: 'Search',
    body: 'Find A Player By Name, Number, Club Or Upline.',
    target: '.members-search',
  },
];
const SHARED_TOUR_TAIL: TutorialStep[] = [
  {
    title: 'Sort Players',
    body: 'Order The List By Club Join Date Or Group It By Role.',
    target: '.members-toolbar',
  },
  {
    title: 'The Directory',
    body: 'Tap A Player To Open The Controls Behind Their Seat.',
    target: '.members-list',
  },
];
const SIMPLE_TOUR: TutorialStep[] = [
  ...SHARED_TOUR_HEAD,
  {
    title: 'Player Views',
    body: 'Switch Between Every Player, Your Agents And Pending Applicants.',
    target: '.members-simple-tabs',
  },
  ...SHARED_TOUR_TAIL,
];
const ADVANCED_TOUR: TutorialStep[] = [
  ...SHARED_TOUR_HEAD,
  {
    title: 'Saved Views',
    body: 'Filter The Roster To Online Players, Players At Tables, Agents And More.',
    target: '.members-view-filter',
  },
  {
    title: 'Columns And Export',
    body: 'Choose The Columns You Read And Export Every Matching Player As A CSV.',
    target: '.members-columns',
  },
  ...SHARED_TOUR_TAIL,
];
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
  high_fees: 'Overall Fees 100+',
};

/** Selected financial periods share Chicago calendar boundaries. */
const WIN_LOSS_LABEL: Record<WinLossPeriod, string> = {
  overall: 'Win / Loss Overall',
  month: 'Win / Loss This Month',
  week: 'Win / Loss This Week',
  today: 'Win / Loss Today',
};
const PERIOD_FEE_LABEL: Record<WinLossPeriod, string> = {
  week: 'Fees This Week',
  today: 'Fees Today',
  month: 'Fees This Month',
  overall: 'Fees Overall',
};
const WIN_LOSS_SHORT: Record<WinLossPeriod, string> = {
  overall: 'Win / Loss',
  month: 'Month W/L',
  week: 'Week W/L',
  today: 'Today W/L',
};

const SORT_LABEL: Record<RosterSort, string> = {
  newest: 'Newest Players First',
  oldest: 'Oldest Players First',
  hierarchy: 'Role Hierarchy',
  activity: 'Recent Activity',
  name: 'Name (A To Z)',
  downlines: 'Downlines',
  wallet: 'Wallet Balance',
  fees: 'Most Overall Fees',
};

type OptionalColumn = RosterColumn;
// Live record signals (horse play, chip and activity updates) arrive continuously
// in an active club. A background reconciliation re-reads the whole loaded
// window, so it waits until this long after the most recent roster read began.
// Dan, 2026-10-25: "STOP AUTO REFRESHING THE PLAYER MANAGEMENT PAGE. ONCE
// EVERY 180 SECONDS IS FINE, NOTHING SOONER." Every automatic re-read (live
// signals, focus, tab return) goes through this floor. Explicit refresh and
// query changes still read immediately.
export const liveRosterRefreshPolicy = { minIntervalMs: 180_000 };
const LIVE_REFRESH_DEBOUNCE_MS = 1200;
type SummaryFreshness = 'loading' | 'fresh' | 'stale' | 'failed';
type RosterLoadOptions = { forceSummary?: boolean; preserveWindow?: boolean };
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
    : 'newest';
}

/* One formatter per kind of figure, shared with the record and Player
   Statistics (utils/format): fees feeFigure, wallets formatWalletChips, signed
   results winLossChips, counts countFigure. Null is a figure this viewer may
   not see. */
function walletFigure(value: number | null): string {
  return value == null ? 'Restricted' : formatWalletChips(value);
}

/** Win / loss for one row: the figure, "Unavailable" after a failed read, or "...". */
function winLossText(winLoss: WinLossFigure | undefined, unavailable: boolean): string {
  if (winLoss) return winLossChips(winLoss.net);
  return unavailable ? 'Unavailable' : '...';
}

function periodFeeText(value: number | undefined, unavailable: boolean): string {
  return value === undefined ? (unavailable ? 'Unavailable' : '...') : feeFigure(value);
}

function feeTitle(
  member: RosterMember,
  figures: WinLossFigure | undefined,
  label: string
): string | undefined {
  if (figures?.fees === undefined) return undefined;
  const exact = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return figures.downline_fees !== undefined && (member.downline_total ?? 0) > 0
    ? `${label} ${exact(figures.fees)}. Downline Fees ${exact(figures.downline_fees)}.`
    : `${label} ${exact(figures.fees)}.`;
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
  const [simpleMode, setSimpleMode] = usePlayerPreference('roster:simpleMode', true, routeClub);
  const [winLossPeriod, setWinLossPeriod] = usePlayerPreference<WinLossPeriod>(
    'roster:winLossPeriod',
    'week',
    routeClub
  );
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
  const [recordRevision, setRecordRevision] = useState(0);
  const [recordRetry, setRecordRetry] = useState(0);
  const recordDegradedRef = useRef(false);
  const [recordConnecting, setRecordConnecting] = useState(true);
  const recordBindingRef = useRef({ scope: '', generation: 0 });
  const recordScope = `${routeClub}:${user?.id}:${recordRetry}`;
  if (recordBindingRef.current.scope !== recordScope) {
    recordBindingRef.current = {
      scope: recordScope,
      generation: recordBindingRef.current.generation + 1,
    };
  }
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
  // Initial account/club hydration owns these values until it has settled.
  // Do not accept edits that the pending workspace read would then replace.
  const workspaceReady = Boolean(user?.id && resolvedClubId && workspaceScope === exportScopeKey);
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
  const lastRosterReadStartedAtRef = useRef(0);
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
    if (sortKey === 'newest') next.delete('sort');
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
      .then(async (id) => {
        if (!active) return;
        const saved = user?.id ? await loadRosterWorkspace(user.id, id) : null;
        if (!active) return;
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
      const preserveWindow = options.preserveWindow === true;
      const retainedRows = preserveWindow
        ? Math.max(PAGE_SIZE, membersRef.current.length)
        : PAGE_SIZE;
      const scope = exportScopeRef.current;
      forceNextSummaryRef.current = false;
      const epoch = ++requestEpochRef.current;
      lastRosterReadStartedAtRef.current = Date.now();
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      activePageReadRef.current = controller;
      moreAbortRef.current?.abort();
      setLoading(true);
      setLoadError(false);
      setLoadSlow(false);
      if (!preserveWindow) setSelected(new Set());
      setDataFreshness('loading');
      if (!summaryAvailableRef.current) setSummaryFreshness('loading');

      const isCurrent = () =>
        !controller.signal.aborted &&
        epoch === requestEpochRef.current &&
        scope === exportScopeRef.current;
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
      const pageRequest = (async () => {
        let page = await ClubRosterService.getRosterPage(resolvedClubId, {
          search: debouncedSearch,
          filter,
          sort: sortKey,
          limit: PAGE_SIZE,
          signal: controller.signal,
        });
        const items = [...page.items];
        const seen = new Set(items.map((row) => row.user_id));
        // Reconcile exactly the loaded window, using fresh cursors so reordered
        // rows cannot leave duplicates or holes across previously loaded pages.
        while (isCurrent() && items.length < retainedRows && page.has_more && page.next_cursor) {
          const cursor = page.next_cursor;
          const next = await ClubRosterService.getRosterPage(resolvedClubId, {
            search: debouncedSearch,
            filter,
            sort: sortKey,
            limit: PAGE_SIZE,
            cursor,
            signal: controller.signal,
          });
          let added = 0;
          for (const row of next.items)
            if (!seen.has(row.user_id)) {
              seen.add(row.user_id);
              items.push(row);
              added++;
            }
          page = next;
          if (!added || JSON.stringify(next.next_cursor) === JSON.stringify(cursor)) break;
        }
        return { ...page, items };
      })().finally(() => {
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
          setRecordRevision((revision) => revision + 1);
          if (preserveWindow) {
            const eligible = new Set(
              nextRows.filter((row) => row.can_view_financials).map((row) => row.user_id)
            );
            setSelected((current) => new Set([...current].filter((id) => eligible.has(id))));
          }
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
        void latestLoadRef.current({ forceSummary: true, preserveWindow: true });
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
      setRecordRetry((retry) => retry + 1);
      setRealtimeRetries((retry) => ({
        members: retry.members + 1,
        wallet: retry.wallet + 1,
        audit: retry.audit + 1,
      }));
      if (activePageReadRef.current && !activePageReadRef.current.signal.aborted) {
        forceNextSummaryRef.current = true;
      } else {
        void latestLoadRef.current({ forceSummary: true, preserveWindow: true });
      }
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
    void latestLoadRef.current({ forceSummary: true, preserveWindow: true });
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
    await latestLoadRef.current({ forceSummary: true, preserveWindow: true });
  }, [resolvedClubId]);

  const retryLiveSync = useCallback(() => {
    if (recordDegradedRef.current) setRecordRetry((retry) => retry + 1);
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
    const sinceLastRead = Date.now() - lastRosterReadStartedAtRef.current;
    const delay = Math.max(
      LIVE_REFRESH_DEBOUNCE_MS,
      liveRosterRefreshPolicy.minIntervalMs - sinceLastRead
    );
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      // The pending query owns its next read. Starting the old search here
      // would be aborted as soon as its debounce commits. Carry the structural
      // summary invalidation into that same new query instead.
      if (searchSettlingRef.current || activePageReadRef.current || moreRef.current) {
        forceNextSummaryRef.current = true;
        return;
      }
      void latestLoadRef.current({ forceSummary: true, preserveWindow: true });
    }, delay);
  }, [resolvedClubId]);

  useMasterBusBroadcastChannel({
    channelName: resolvedClubId ? `club-roster:${resolvedClubId}` : null,
    restartKey: recordBindingRef.current.generation,
    event: 'record_changed',
    enabled: !!resolvedClubId && !!user?.id,
    onPayload: () => scheduleStructuralRefresh(),
    onSubscriptionStatus: (status) => {
      if (status === 'CONNECTING') {
        setRecordConnecting(true);
        return;
      }
      if (status !== 'SUBSCRIBED') return;
      setRecordConnecting(false);
      recordDegradedRef.current = false;
      scheduleStructuralRefresh();
    },
    onSubscriptionError: () => {
      setRecordConnecting(false);
      recordDegradedRef.current = true;
      setDataFreshness('stale');
    },
  });

  useEffect(() => {
    if (!resolvedClubId) return;
    const visible = () => {
      if (document.visibilityState !== 'hidden') scheduleStructuralRefresh();
    };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    let timer: ReturnType<typeof setTimeout>;
    const boundary = () => {
      const now = new Date();
      timer = setTimeout(
        () => {
          scheduleStructuralRefresh();
          boundary();
        },
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime() + 25
      );
    };
    boundary();
    return () => {
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
      clearTimeout(timer);
    };
  }, [resolvedClubId, scheduleStructuralRefresh]);

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
      if (
        forceNextSummaryRef.current &&
        !controller.signal.aborted &&
        epoch === requestEpochRef.current
      ) {
        scheduleStructuralRefresh();
      }
    }
  }, [
    cursor,
    debouncedSearch,
    filter,
    hasMore,
    resolvedClubId,
    sortKey,
    toast,
    scheduleStructuralRefresh,
  ]);

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
  // Win / loss for the loaded rows, in the chosen window (Dan 2026-10-16).
  // An agent may see only their own downline's figures, so the window is
  // offered whenever any loaded row is financially visible, not only to
  // viewers with the club-wide financial view.
  const showWinLoss = canUseFinancialViews || members.some((m) => m.can_view_financials);
  const winLoss = useRosterWinLoss(
    resolvedClubId,
    members,
    winLossPeriod,
    showWinLoss,
    recordRevision,
    user?.id
  );
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
    if (!sorts.includes(sortKey)) setSortKey('newest');
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
      : recordDegradedRef.current || realtimeConnection === 'degraded'
        ? 'reconnecting'
        : recordConnecting
          ? 'connecting'
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
      data-roster-connection={connectionState}
    >
      <PageBar
        className="members-page-bar"
        title="Player Management"
        titleId="members-page-title"
        summary="Find Any Member, Read Their Live Club Status, And Open The Controls Behind Their Seat."
        status={simpleMode ? undefined : (summaryStatusMessage ?? undefined)}
        statusTone={
          summaryFreshness === 'failed'
            ? 'danger'
            : summaryFreshness === 'stale'
              ? 'attention'
              : 'default'
        }
        metrics={
          simpleMode
            ? []
            : [
                { label: 'Total Members', value: stat(summary.counts.total) },
                { label: 'Online Now', value: stat(summary.counts.online), tone: 'live' },
                { label: 'At Tables', value: stat(summary.counts.seated) },
                { label: 'Agents', value: stat(summary.counts.agents) },
              ]
        }
        steps={simpleMode ? SIMPLE_TOUR : ADVANCED_TOUR}
      >
        {!simpleMode && summary.capabilities.can_manage_members && (
          <Link className="members-applicants" to={`/clubs/${routeClubId}/applicants`}>
            Review Applicants
          </Link>
        )}
        <div className="members-mode-toggle" role="group" aria-label="Player Management Mode">
          <button type="button" aria-pressed={simpleMode} onClick={() => setSimpleMode(true)}>
            Simple
          </button>
          <button type="button" aria-pressed={!simpleMode} onClick={() => setSimpleMode(false)}>
            Advanced
          </button>
        </div>
      </PageBar>

      <section
        className="members-console"
        aria-label={simpleMode ? 'Player Directory' : undefined}
        aria-labelledby={simpleMode ? undefined : 'members-directory-title'}
      >
        {!simpleMode && (
          <div className="members-console__heading">
            <h2 id="members-directory-title">Find A Player</h2>
            <span className="members-result-count" aria-live="polite">
              {loading && !hasVerifiedDirectory
                ? 'Loading...'
                : `${filteredTotal.toLocaleString()} Results`}
            </span>
          </div>
        )}

        {simpleMode && (
          <div className="members-simple-tabs" role="group" aria-label="Player Views">
            <button
              type="button"
              disabled={!workspaceReady}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              All
            </button>
            <button
              type="button"
              disabled={!workspaceReady}
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
          <button
            type="button"
            disabled={!workspaceReady}
            className="members-active-view"
            onClick={() => setFilter('all')}
          >
            {FILTER_LABEL[filter]}: Clear Filter
          </button>
        )}
        <label className="members-search">
          <span>Search The Roster</span>
          <input
            type="search"
            placeholder={titleCase('search name, number, club, or upline')}
            aria-label="Search Club Members"
            disabled={!workspaceReady}
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
                disabled={!workspaceReady}
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
              aria-pressed={!searchQuery.trim() && sortKey === 'hierarchy'}
              disabled={!workspaceReady || Boolean(searchQuery.trim())}
              onClick={() => setSortKey(sortKey === 'hierarchy' ? 'name' : 'hierarchy')}
            >
              Group By Role
            </button>
          )}
          {showWinLoss && (
            <label className="members-sort members-winloss-period">
              <span className="members-sort__label">Win / Loss</span>
              <select
                aria-label="Win And Loss Period"
                value={winLossPeriod}
                onChange={(event) => setWinLossPeriod(event.target.value as WinLossPeriod)}
              >
                {(Object.keys(WIN_LOSS_LABEL) as WinLossPeriod[]).map((value) => (
                  <option key={value} value={value}>
                    {WIN_LOSS_LABEL[value]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="members-sort">
            <span className="members-sort__label">Sort By</span>
            <select
              aria-label="Sort Players"
              disabled={!workspaceReady || Boolean(searchQuery.trim())}
              value={searchQuery.trim() ? 'search' : sortKey}
              onChange={(event) => setSortKey(event.target.value as RosterSort)}
            >
              {searchQuery.trim() && <option value="search">Player Name Matches</option>}
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
                        disabled={!workspaceReady}
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
                Fees Are Read From The Club Fee Ledgers That Pay Agents And Rakeback. They Count
                From The Week Of October 12, 2026 (Monday Midnight Pacific) And Keep Accumulating
                From Then On, With No Weekly Reset. Wallets And Fees Are In Club Chips.
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

        {(loadSlow || !['live', 'connecting'].includes(connectionState)) && (
          <RosterConnectionStatus
            state={connectionState}
            hasData={hasVerifiedDirectory}
            lastSuccessfulSyncAt={lastSuccessfulSyncAt}
            isRefreshing={isRefreshing}
            isSlow={loadSlow}
            onRetry={retryLiveSync}
          />
        )}
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
              {exportOperation.searchApplied
                ? 'Player Name Matches'
                : SORT_LABEL[exportOperation.sort]}
              . Search: {exportOperation.searchApplied ? 'Applied' : 'None'}.
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
                winLoss={winLoss.get(member.user_id)}
                winLossUnavailable={winLoss.unavailable.has(member.user_id)}
                winLossLabel={WIN_LOSS_SHORT[winLossPeriod]}
                feeLabel={PERIOD_FEE_LABEL[winLossPeriod]}
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
  winLoss,
  winLossUnavailable = false,
  winLossLabel = 'Win / Loss',
  feeLabel = 'Fees This Week',
}: {
  simpleMode?: boolean;
  /** The net for the chosen window; undefined while it loads. */
  winLoss?: WinLossFigure;
  /** The last read for this row failed; it is being retried. */
  winLossUnavailable?: boolean;
  winLossLabel?: string;
  feeLabel?: string;
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
  const winLossTone =
    !winLoss || winLoss.net === 0
      ? ''
      : winLoss.net > 0
        ? ' member-winloss--up'
        : ' member-winloss--down';
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
            {/* Dan, 2026-10-25: "I WANT TO SEE THE UPLINE AGENT, UNDER THE
                PLAYER OR AGENTS NAME." Its own line directly beneath the
                name, in Simple and Advanced mode alike. The roster nulls
                upline_name for viewers without financial access. */}
            {member.upline_name && (
              <span className="member-upline">
                {'Upline: '}
                {highlight(member.upline_name, query)}
              </span>
            )}
          </span>
          <span className="member-subline">
            {(!simpleMode || member.role !== 'player') && (
              <span
                className="member-role"
                style={{ color: simpleMode ? undefined : roleColor(member.role) }}
              >
                {roleLabel(member.role)}
              </span>
            )}
            {member.player_number && (
              <span className="member-number">
                {'PlayerID: '}
                {highlight(member.player_number, query)}
              </span>
            )}
            {member.home_club_name && (
              <span className="member-club">{highlight(member.home_club_name, query)}</span>
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
            <span className="member-simple-balance" title={feeTitle(member, winLoss, feeLabel)}>
              <strong>{periodFeeText(winLoss?.fees, winLossUnavailable)}</strong>
              <span>{feeLabel}</span>
              {(member.downline_total ?? 0) > 0 && winLoss?.downline_fees !== undefined && (
                <span className="member-simple-balance__downline">
                  Downline {periodFeeText(winLoss?.downline_fees, winLossUnavailable)}
                </span>
              )}
              <strong
                className={`member-simple-balance__winloss${winLossTone}`}
                aria-label={`${winLossLabel} ${winLossText(winLoss, winLossUnavailable)}`}
              >
                {winLossText(winLoss, winLossUnavailable)}
              </strong>
            </span>
          )}
          {!simpleMode && member.can_view_financials && (
            <span className="member-metrics">
              <span
                className={`member-metric member-metric--winloss${winLossTone}`}
                aria-label={`${winLossLabel} ${winLossText(winLoss, winLossUnavailable)}`}
              >
                <span className="member-metric__value">
                  {winLossText(winLoss, winLossUnavailable)}
                </span>
              </span>
              {columns.has('downlines') && (
                <Metric label="Downlines" value={countFigure(member.downline_total)} />
              )}
              {columns.has('fees') && (
                <>
                  <Metric
                    label={feeLabel}
                    value={periodFeeText(winLoss?.fees, winLossUnavailable)}
                    accent
                  />
                  <Metric
                    label="Downline Fees"
                    value={periodFeeText(winLoss?.downline_fees, winLossUnavailable)}
                    accent
                  />
                </>
              )}
              {columns.has('wallets') && (
                <>
                  <Metric label="Agent Wallet" value={walletFigure(member.agent_wallet)} />
                  <Metric label="Player Wallet" value={walletFigure(member.player_wallet)} />
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
    high_fees: [
      'No Players With High Overall Fees',
      'No Visible Players Have Recorded At Least 100 In Overall Fees.',
    ],
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

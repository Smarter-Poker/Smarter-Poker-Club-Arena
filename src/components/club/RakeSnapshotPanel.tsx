/**
 * RAKE SNAPSHOT — one strip that answers "how are we doing", then "who did it".
 *
 * The ledger below this panel lists games. This panel does not: it reads the
 * daily rollups only, which is why it can be asked for a year when the ledger
 * clamps at 93 days, and why switching from Day to Year does not cost a
 * different order of magnitude of query.
 *
 * Scope chips are built from what the viewer actually holds. A club owner with
 * no union sees Club alone; a union owner sees Union and Club; an agent sees
 * Downline. The database refuses anything else on its own - the chips exist so
 * nobody is offered a button that will only tell them no.
 *
 * Each scope has a second question under the headline, and it is a different
 * question each time:
 *
 *   Union     which club is carrying the union
 *   Club      which agent is carrying the club
 *   Downline  which player is carrying you, and the agents among them open
 *             into their own downline, as deep as the chain goes
 *
 * Zeros are a lie on this page (Dan 2026-08-25): a failed read shows dashes,
 * never a confident 0.00.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClubRakeSnapshotService,
  RAKE_PERIODS,
  RAKE_SORTS,
  describeRakeSnapshotError,
  periodToRange,
  type PeriodKey,
  type RakeAgentRow,
  type RakeBreakdownRow,
  type RakeClubRow,
  type RakeDownlineRow,
  type RakeScope,
  type RakeSnapshot,
  type RakeSortKey,
} from '../../services/ClubRakeSnapshotService';
import { reportError } from '../../utils/errorReporter';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import type { BusEventType } from '../../core/MasterBus';
import {
  clubDataQueryKey,
  readClubDataCache,
  removeClubDataCaches,
  writeClubDataCache,
} from '../../lib/clubDataCache';
import { supabase } from '../../lib/supabase';
import { downloadCsv } from '../../utils/downloadCsv';
import { isClubDataExportAbort, type ClubDataExportProgress } from '../../utils/clubDataExport';
import {
  fetchRakeSnapshotExport,
  isRakeExportAuthorizationError,
  isRakeExportBusy,
  isRakeExportEntitlementChanged,
  isRakeExportUnavailable,
  RAKE_EXPORT_SEARCH_MAX_LENGTH,
  rakeSnapshotExportToCsv,
} from '../../utils/rakeSnapshotExport';
import { uuid } from '../../utils/uuid';
import { SpadeConsole } from '../console/SpadeConsole';
import { titleCase } from '../../utils/titleCase';
import { compactChips } from '../../utils/format';
import styles from './RakeSnapshotPanel.module.css';

const NO_VALUE = '-';
const REFRESH_MS = 60_000;
/** One page. Deliberately smaller than the RPC's 200 ceiling. */
const PAGE_SIZE = 50;

/**
 * The same events the ledger below this panel listens to. A snapshot that only
 * polled was up to a minute stale next to a ledger that was not, on the same
 * screen, with no way for an operator to tell which one to believe.
 */
const RAKE_BUS_EVENTS: BusEventType[] = [
  'CLUB_UPDATED',
  'BALANCE_UPDATED',
  'TABLE_UPDATED',
  'TABLE_CLOSED',
  'TABLE_CREATED',
  'TOURNAMENT_UPDATED',
  'MEMBER_ROLE_CHANGED',
];
/** Deeper than any real agent chain, and a hard stop if one ever loops. */
const MAX_DRILL = 8;
/**
 * Long enough that a name is typed rather than transmitted a letter at a time,
 * short enough that the list feels answerable. Each keystroke would otherwise
 * be a round trip through a definer function that walks an agent tree.
 */
const SEARCH_DEBOUNCE_MS = 300;

const SCOPE_COPY: Record<RakeScope, { label: string; note: string }> = {
  union: { label: 'Union', note: 'Every Club Beneath The Union' },
  club: { label: 'Club', note: 'This Club Only' },
  agent: { label: 'Downline', note: 'Players Beneath You' },
};

const ROLE_LABEL: Record<string, string> = {
  super_agent: 'Super Agent',
  agent: 'Agent',
  sub_agent: 'Sub Agent',
  owner: 'Owner',
  admin: 'Admin',
  member: 'Player',
  none: 'Direct',
};

function roleLabel(role: string | null | undefined): string {
  if (!role) return 'Player';
  return ROLE_LABEL[role] ?? role.replace(/_/g, ' ');
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return NO_VALUE;
  return compactChips(Number(n));
}

function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return NO_VALUE;
  return Number(n).toLocaleString('en-US');
}

/** Every timestamp on this page is UTC and badged as such. A bare local time
 *  beside a UTC range is how "updated 19:42" comes to look like it preceded a
 *  window ending today. */
function utcTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'Unknown';
  return `${d.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })} UTC`;
}

function bucketLabel(iso: string, unit: 'day' | 'week' | 'month'): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return iso;
  if (unit === 'month') {
    return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: '2-digit' });
  }
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

/** A share is only meaningful against a total the row is actually part of. */
function share(part: number, total: number | null | undefined): number {
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.max(0, Math.min(100, (Number(part) / t) * 100));
}

/**
 * One stable identity per row, whatever the breakdown is of. Used to dedupe an
 * appended page: the window keeps moving while an operator reads it, so a row
 * can legitimately arrive twice, and appending blind would double it on screen
 * and in anything summed from it.
 */
function rowKey(r: RakeBreakdownRow): string {
  const any = r as Partial<RakeClubRow & RakeAgentRow & RakeDownlineRow>;
  return String(any.club_id ?? any.agent_user_id ?? any.player_id ?? any.name ?? '');
}

interface Crumb {
  userId: string;
  name: string;
}

export interface RakeSnapshotPanelProps {
  /**
   * The club this panel reports on, or null on the union page - a union owner
   * has a union and need not have a club at all.
   */
  clubId: string | null;
  /**
   * The union this panel reports on. Given without a clubId, the union scope
   * asks the database for the union DIRECTLY rather than deriving it from
   * whichever member club the operator happened to walk in through.
   */
  unionId?: string | null;
  /** Cache is keyed per viewer; without it one operator could paint another's. */
  userId?: string | null;
  /** Scopes the viewer holds, in the order they should be offered. */
  scopes: RakeScope[];
  /** Only meaningful for the agent scope; null means "me". */
  agentUserId?: string | null;
  /** Bumping this re-reads without changing the period. */
  refreshToken?: number;
}

export default function RakeSnapshotPanel({
  clubId,
  unionId = null,
  userId = null,
  scopes,
  agentUserId = null,
  refreshToken = 0,
}: RakeSnapshotPanelProps) {
  // Memoised: a fresh array identity on every render would re-run the effect
  // below on every render, and that effect can call setScope.
  const available = useMemo<RakeScope[]>(() => (scopes.length ? scopes : ['club']), [scopes]);
  const [scope, setScope] = useState<RakeScope>(available[0]);
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [custom, setCustom] = useState(() => periodToRange('month'));
  const [snapshot, setSnapshot] = useState<RakeSnapshot | null>(null);
  /** The complete reporting question that produced the painted snapshot. */
  const [snapshotViewKey, setSnapshotViewKey] = useState<string | null>(null);
  /**
   * Rows accumulate across pages; the snapshot only ever holds the LAST page.
   * Keeping them apart is what lets a Load More append without the summary,
   * the trend or the totals flickering through a re-read they did not need.
   */
  const [rows, setRows] = useState<RakeBreakdownRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The chain walked into, deepest last. Empty means "my own book". */
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  /**
   * Where a drill STARTED, when it started somewhere other than the downline
   * scope. Without it, backing out of an agent opened from the Club list drops
   * the operator into "My Downline" - a book a club owner may not even have,
   * and never the one they were reading.
   */
  const [drillOrigin, setDrillOrigin] = useState<RakeScope | null>(null);
  /**
   * The member club opened FROM the union list, if any. The union page has no
   * club of its own, so the club scope has to be told which one to read.
   */
  const [clubCrumb, setClubCrumb] = useState<{ clubId: string; name: string } | null>(null);
  /** What is typed, and what has actually been asked for. */
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<RakeSortKey>('rake');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ClubDataExportProgress | null>(null);
  const [exportAnnouncement, setExportAnnouncement] = useState('');

  const version = useRef(0);
  const cancelled = useRef(false);
  const exportAbortControllerRef = useRef<AbortController | null>(null);
  const exportGenerationRef = useRef(0);
  /** Whether the last head read failed - see the bus subscription below. */
  const lastReadFailed = useRef(false);
  /**
   * How many rows the SERVER has handed over, which is not how many are on
   * screen. Rows are deduped on append, so paging on rows.length walks the
   * cursor backwards a little every time a duplicate is dropped: the next page
   * re-reads rows already shown, dedupe drops those too, and on a busy list the
   * control stops advancing while still offering Load More.
   */
  const cursor = useRef(0);
  /**
   * True once the operator has pressed Load More. A background refresh must not
   * throw away pages they opened - see the guard in load().
   */
  const expanded = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      exportGenerationRef.current += 1;
      exportAbortControllerRef.current?.abort();
      exportAbortControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // If the viewer's roles resolve after first paint, the selected chip may no
  // longer be one they hold. Fall back rather than keep asking for a refusal.
  useEffect(() => {
    // A club owner holds no downline of their own, so 'agent' is not among the
    // scopes they are offered - but opening an agent FROM the club list puts
    // them in it legitimately. Without this the fallback fires on the next
    // render and bounces them straight back out of the row they just opened.
    if (scope === 'agent' && crumbs.length > 0) return;
    // Same reasoning for a club opened from the union list: a union lead who
    // holds no club role is not offered the Club chip, but opening a member
    // club from their own union list is legitimate.
    if (scope === 'club' && clubCrumb) return;
    if (!available.includes(scope)) setScope(available[0]);
  }, [available, scope, crumbs.length, clubCrumb]);

  // Leaving the downline scope must drop the trail with it, or coming back
  // lands you inside somebody else's book with no visible reason why.
  useEffect(() => {
    // The drill is a CHAIN - union, then a club inside it, then an agent
    // inside that - so the club being read has to survive descending PAST it
    // into an agent. Clearing it on any scope but 'club' lost which club the
    // agent belonged to the moment you opened one, and backing out then asked
    // for club scope with no club, which the database rejects outright.
    if (scope !== 'agent') setCrumbs([]);
    if (scope === 'union') {
      setClubCrumb(null);
      setDrillOrigin(null);
    }
  }, [scope]);

  const range = useMemo(
    () => (period === 'custom' ? periodToRange('custom', custom) : periodToRange(period)),
    [period, custom]
  );

  const focusUserId = crumbs.length ? crumbs[crumbs.length - 1].userId : agentUserId;
  const focusClubId = clubCrumb?.clubId ?? clubId;
  /**
   * Something to hang a cache and a bus filter on. The union page has no club,
   * so without this every union read would be uncacheable and every club event
   * would be discarded as belonging to somebody else.
   */
  const contextId = focusClubId ?? unionId;
  const viewIdentityRef = useRef('');

  // A financial answer belongs to one authenticated viewer and one reporting
  // context. Never leave the previous viewer's rows painted while the next
  // account or club is being resolved, and never let a late export cross that
  // boundary.
  useEffect(() => {
    const nextIdentity = `${userId ?? ''}:${contextId ?? ''}`;
    if (viewIdentityRef.current === nextIdentity) return;
    const hadIdentity = viewIdentityRef.current.length > 0;
    viewIdentityRef.current = nextIdentity;
    version.current += 1;
    cursor.current = 0;
    expanded.current = false;
    if (hadIdentity) {
      setSnapshot(null);
      setSnapshotViewKey(null);
      setRows([]);
      setError(null);
      setPageError(null);
    }
    const active = exportAbortControllerRef.current;
    if (active) {
      exportAbortControllerRef.current = null;
      exportGenerationRef.current += 1;
      active.abort();
      setExporting(false);
      setExportProgress(null);
      setExportAnnouncement(
        'Reporting Access Changed During Export. No Partial File Was Downloaded.'
      );
    }
  }, [userId, contextId]);

  /**
   * One key per distinct question. Scope, period and the agent being drilled
   * into all change the answer, so all three are in it - a cache keyed only on
   * the club would serve the Union figure under the Club chip.
   */
  const cacheKey = useMemo(
    () =>
      clubDataQueryKey({
        kind: 'rake-snapshot',
        scope,
        start: range.start,
        end: range.end,
        agent: scope === 'agent' ? (focusUserId ?? 'me') : null,
        // A union read and a club read are different questions even at the
        // same moment, and drilling changes which club is being asked about.
        club: focusClubId,
        union: unionId ?? null,
        // A different sort is a different page of the same question, so it has
        // to be in the key or Load More would append rows ordered by something
        // else. The SEARCH is in it for the same reason.
        sort,
        q: query || null,
      }),
    [scope, range.start, range.end, focusUserId, focusClubId, unionId, sort, query]
  );

  // Search, sort, range, scope and drill depth define the export question. If
  // one changes while the immutable snapshot is being prepared, cancel it so
  // the control can never hand off a file answering the previous question.
  useEffect(() => {
    const active = exportAbortControllerRef.current;
    if (!active) return;
    exportAbortControllerRef.current = null;
    exportGenerationRef.current += 1;
    active.abort();
    setExporting(false);
    setExportProgress(null);
    setExportAnnouncement('Export Cancelled After The Reporting View Changed.');
  }, [cacheKey]);

  // A new question is a new list. Anything carried over from the last one -
  // the cursor, the fact that it was expanded - describes rows that are gone.
  useEffect(() => {
    cursor.current = 0;
    expanded.current = false;
  }, [cacheKey]);

  /** Paint the last verified answer immediately, then read live over it. */
  useEffect(() => {
    if (!userId || !contextId) return;
    // A search is a transient question. Caching one would fill the store with
    // an entry per prefix an operator ever typed, to be served back later as
    // though it were the list.
    if (query) return;
    const cached = readClubDataCache<RakeSnapshot>(userId, contextId, cacheKey);
    if (!cached) return;
    const cachedRows = Array.isArray(cached.breakdown) ? cached.breakdown : [];
    setSnapshot(cached);
    setSnapshotViewKey(cacheKey);
    setRows(cachedRows);
    cursor.current = cachedRows.length;
    setLoading(false);
  }, [userId, contextId, cacheKey, query]);

  const load = useCallback(
    async (quiet = false) => {
      // A union page has no club, and that is not a reason not to read.
      if (!clubId && !unionId) return;
      const mine = ++version.current;
      if (!quiet) setLoading(true);
      setError(null);
      setPageError(null);
      try {
        const next = await ClubRakeSnapshotService.get({
          scope,
          clubId: focusClubId,
          unionId: unionId ?? null,
          start: range.start,
          end: range.end,
          agentUserId: scope === 'agent' ? focusUserId : null,
          limit: PAGE_SIZE,
          offset: 0,
          search: query || null,
          sort,
        });
        if (cancelled.current || mine !== version.current) return;
        lastReadFailed.current = false;
        setSnapshot(next);
        setSnapshotViewKey(cacheKey);
        // THE HEAD ALWAYS REFRESHES. The rows only refresh if the operator has
        // not opened past page one.
        //
        // Phase 3 added paging and realtime in the same change and they fought:
        // every poll and every bus event re-read page one and replaced the
        // list, so an operator who had loaded four pages watched them vanish
        // whenever anyone at the club played a hand - which, with realtime
        // wired up, is constantly. Refusing to touch an expanded list costs at
        // most sixty seconds of staleness in rows whose totals above them are
        // live, and that is the smaller lie by a wide margin.
        if (!expanded.current) {
          setRows(next.breakdown);
          cursor.current = next.breakdown.length;
        }
        if (userId && contextId && !query)
          writeClubDataCache<RakeSnapshot>(userId, contextId, cacheKey, next);
      } catch (e) {
        if (cancelled.current || mine !== version.current) return;
        // The previous snapshot stays on screen. A refusal for one scope must not
        // wipe the figure the operator was already reading.
        lastReadFailed.current = true;
        setError(describeRakeSnapshotError(e));
        reportError(e, 'RakeSnapshotPanel.load');
      } finally {
        if (!cancelled.current && mine === version.current) setLoading(false);
      }
    },
    [
      clubId,
      unionId,
      focusClubId,
      contextId,
      scope,
      range.start,
      range.end,
      focusUserId,
      userId,
      cacheKey,
      query,
      sort,
    ]
  );

  /**
   * Append the next page. It carries its own error state: a failed Load More
   * must not blank the rows already on screen, which is what a shared error
   * would do.
   */
  const loadMore = useCallback(async () => {
    if ((!clubId && !unionId) || loadingMore) return;
    const mine = version.current;
    setLoadingMore(true);
    setPageError(null);
    try {
      const next = await ClubRakeSnapshotService.get({
        scope,
        clubId: focusClubId,
        unionId: unionId ?? null,
        start: range.start,
        end: range.end,
        agentUserId: scope === 'agent' ? focusUserId : null,
        limit: PAGE_SIZE,
        offset: cursor.current,
        search: query || null,
        sort,
      });
      if (cancelled.current || mine !== version.current) return;
      // Advance by what the SERVER returned, before any deduping. This is the
      // whole point of keeping a cursor separate from the row count.
      cursor.current += next.breakdown.length;
      expanded.current = true;
      // Adopt the FRESHER count, floored at what is on screen by the reader
      // below. Keeping page one's count meant a list that had shrunk under the
      // operator kept offering Load More against rows that were no longer
      // there, and the control could never resolve. Only the count is taken -
      // the rest of the head belongs to the read that fetched it.
      setSnapshot((cur) => (cur ? { ...cur, breakdown_count: next.breakdown_count } : cur));
      setRows((cur) => {
        // The window moves while an operator reads it, so a row already shown
        // can arrive again in the next page. Appending blind duplicates it and
        // double-counts it in anything the client sums.
        const seen = new Set(cur.map(rowKey));
        return [...cur, ...next.breakdown.filter((r) => !seen.has(rowKey(r)))];
      });
    } catch (e) {
      if (cancelled.current || mine !== version.current) return;
      setPageError(describeRakeSnapshotError(e));
      reportError(e, 'RakeSnapshotPanel.loadMore');
    } finally {
      if (!cancelled.current) setLoadingMore(false);
    }
  }, [
    clubId,
    unionId,
    focusClubId,
    scope,
    range.start,
    range.end,
    focusUserId,
    loadingMore,
    query,
    sort,
  ]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  // Same 60s cadence as the ledger, and only while the tab is visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  /**
   * Live invalidation, same events and same debounce as the ledger below.
   * Quiet, because a bus event should refresh the figures without throwing the
   * panel back to a loading state under the operator's eyes.
   */
  useMasterBusSubscriptions(
    RAKE_BUS_EVENTS,
    (payload) => {
      const eventClubId =
        payload && typeof payload === 'object' && 'clubId' in payload
          ? String((payload as { clubId?: unknown }).clubId || '')
          : '';
      // On the union page there is no club to compare against, and a union
      // moves when ANY of its clubs does - so the filter only applies when
      // this panel is actually pinned to one club.
      if (focusClubId && eventClubId && eventClubId !== focusClubId) return;
      // A READ THAT IS FAILING IS NOT RETRIED BY THE FIREHOSE (2026-09-04).
      // These events fire on every chip movement in the club, and a busy club
      // moves chips constantly - so when the read itself was failing, this
      // subscription re-issued it seven times in fourteen seconds, each one an
      // eight-second query that the database then had to run and abandon.
      // Measured on the club data page while ca_rake_snapshot was timing out.
      // The sixty-second poll and the operator's own Refresh still retry; the
      // firehose does not.
      if (lastReadFailed.current) return;
      void load(true);
    },
    { debounce: 750 }
  );

  /**
   * Sorting by Cost and then switching to the downline list would ask for a
   * column that list does not have. The server falls back to rake and says so,
   * but the control would still be reading "Cost" - so it is reset here rather
   * than left describing something that is not happening.
   */
  const sortOptions = useMemo(
    () => RAKE_SORTS[(snapshot?.breakdown_kind ?? 'club') as 'club' | 'agent' | 'downline'] ?? [],
    [snapshot?.breakdown_kind]
  );
  useEffect(() => {
    if (sortOptions.length && !sortOptions.some((o) => o.key === sort)) setSort('rake');
  }, [sortOptions, sort]);

  const summary = snapshot?.summary ?? null;
  const delta = snapshot?.delta ?? null;
  const isAgent = snapshot?.scope === 'agent';
  const kind = snapshot?.breakdown_kind ?? 'none';
  const total = snapshot?.breakdown_total ?? null;

  /**
   * Never below what is already on screen. The window keeps moving, so a later
   * read can return a smaller count than the rows already accumulated, and
   * "Showing 60 of 55" reads as a bug in the page rather than in the world.
   */
  const breakdownCount = useMemo(
    () => Math.max(Number(snapshot?.breakdown_count ?? 0) || 0, rows.length),
    [snapshot, rows.length]
  );
  const hasMore = rows.length < breakdownCount;

  const series = useMemo(() => snapshot?.series ?? [], [snapshot]);
  const peak = useMemo(
    () => series.reduce((m, p) => Math.max(m, Math.abs(Number(p.fee) || 0)), 0),
    [series]
  );

  /**
   * The breakdown reads live; the headline is an hourly rollup. Between runs
   * the agent column can sum to MORE than the club total beside it, which
   * looks like an error and is not.
   *
   * Only declared when the two actually disagree by more than a cent. Saying
   * it unconditionally would put a permanent caveat under a table that agrees
   * with itself for most of every hour, and a caveat nobody ever needs is a
   * caveat nobody reads when they do.
   */
  const liveAhead = useMemo(() => {
    if (!snapshot?.breakdown_live) return null;
    const shown = Number(snapshot.breakdown_total);
    const headline = Number(snapshot.summary?.cash_fee ?? snapshot.summary?.fee);
    if (!Number.isFinite(shown) || !Number.isFinite(headline)) return null;
    if (Math.abs(shown - headline) < 0.01) return null;
    return { shown, headline, at: snapshot.data_updated_at ?? null };
  }, [snapshot]);

  const drillInto = useCallback((userId: string, name: string) => {
    setCrumbs((c) => (c.length >= MAX_DRILL ? c : [...c, { userId, name }]));
  }, []);

  /**
   * Open an agent from the CLUB list. The club breakdown gives a network total
   * and no way to ask who inside it produced it; this is that way.
   *
   * A search is dropped on the way in. It was matching agent names in the club
   * list and would arrive filtering player names in the downline, silently
   * hiding most of the book the operator just asked to see.
   */
  const openAgent = useCallback(
    (agentUserId: string, name: string) => {
      setDrillOrigin(scope);
      setSearch('');
      setQuery('');
      setCrumbs([{ userId: agentUserId, name }]);
      setScope('agent');
    },
    [scope]
  );

  /**
   * Open a member club from the UNION list. The union breakdown says SHARK
   * CLUB produced 3,023,403.87 and, until now, gave no way to ask which agents
   * produced it.
   *
   * The search is dropped on the way in for the same reason it is dropped
   * entering a downline: it was matching CLUB names and would arrive filtering
   * AGENT names, hiding most of the list the operator just asked to see.
   */
  const openClub = useCallback(
    (id: string, name: string) => {
      setDrillOrigin(scope);
      setSearch('');
      setQuery('');
      setClubCrumb({ clubId: id, name });
      setScope('club');
    },
    [scope]
  );

  /** Back out of a drill, to wherever it started. */
  /**
   * Step back ONE level of the chain, not all of it.
   *
   * An agent opened from a club that was itself opened from a union has two
   * levels above it. Collapsing straight to the top was wrong in both
   * directions: it threw away a club the operator was still reading, and it
   * left the club scope with no club to read.
   */
  const leaveDrill = useCallback(() => {
    if (scope === 'agent') {
      // Back to wherever this agent was opened FROM - the club it belongs to,
      // when that club was itself opened from a union. drillOrigin already
      // records that; an extra branch on clubCrumb was a second way of saying
      // the same thing, and a mutation deleting it changed nothing.
      setCrumbs([]);
      if (drillOrigin && drillOrigin !== 'agent') {
        setScope(drillOrigin);
        setDrillOrigin(null);
      }
      return;
    }
    if (scope === 'club' && clubCrumb) {
      setClubCrumb(null);
      setScope('union');
      setDrillOrigin(null);
    }
  }, [scope, clubCrumb, drillOrigin]);

  const deltaNote = (pct: number | null | undefined, abs: number | null | undefined) => {
    const hasPct = pct !== null && pct !== undefined && Number.isFinite(Number(pct));
    const hasAbs = abs !== null && abs !== undefined && Number.isFinite(Number(abs));
    if (!hasPct && !hasAbs) return null;
    const basis = hasPct ? Number(pct) : Number(abs);
    const cls = basis > 0 ? 'sc-ink--green' : basis < 0 ? 'sc-ink--red' : 'sc-ink--muted';
    const text = hasPct
      ? `${Number(pct) > 0 ? '+' : ''}${Math.round(Number(pct) * 10) / 10}%`
      : `${Number(abs) > 0 ? '+' : ''}${money(abs)}`;
    return (
      <span
        className={`${styles.delta} ${cls}`}
        title={
          snapshot
            ? `Previous Period ${snapshot.previous_range.start} To ${snapshot.previous_range.end} UTC`
            : undefined
        }
      >
        {text} Vs Prev
      </span>
    );
  };

  const exportSnapshot = useCallback(async () => {
    if (exporting) {
      const active = exportAbortControllerRef.current;
      if (!active) return;
      exportAbortControllerRef.current = null;
      exportGenerationRef.current += 1;
      active.abort();
      setExporting(false);
      setExportProgress(null);
      setExportAnnouncement('Export Cancelled. No Partial File Was Downloaded.');
      return;
    }

    const scopeId = scope === 'union' ? unionId : focusClubId;
    const normalizedQuery = query || null;
    if (
      !snapshot ||
      !userId ||
      !scopeId ||
      loading ||
      snapshot.range.start !== range.start ||
      snapshot.range.end !== range.end ||
      snapshot.applied_search !== normalizedQuery ||
      snapshot.applied_sort !== sort ||
      snapshot.scope !== scope ||
      snapshotViewKey !== cacheKey
    ) {
      return;
    }

    const controller = new AbortController();
    const generation = ++exportGenerationRef.current;
    exportAbortControllerRef.current = controller;
    setExporting(true);
    setExportProgress({ stage: 'preparing', loaded: 0, total: null });
    setExportAnnouncement('');

    const ownsExport = () =>
      !cancelled.current &&
      exportAbortControllerRef.current === controller &&
      exportGenerationRef.current === generation &&
      !controller.signal.aborted;

    try {
      const result = await fetchRakeSnapshotExport({
        rpc: supabase.rpc.bind(supabase),
        scope,
        scopeId,
        start: snapshot.range.start,
        end: snapshot.range.end,
        agentUserId: scope === 'agent' ? focusUserId : null,
        viewerUserId: userId,
        search: snapshot.applied_search,
        sort: snapshot.applied_sort,
        requestId: uuid(),
        signal: controller.signal,
        onProgress: (progress) => {
          if (ownsExport()) setExportProgress(progress);
        },
      });
      if (!ownsExport()) return;
      const downloaded = await downloadCsv(
        `rake-snapshot-${result.metadata.scope_type}-${result.metadata.date_from}-to-${result.metadata.date_to}.csv`,
        rakeSnapshotExportToCsv(result),
        ownsExport
      );
      if (!ownsExport()) return;
      if (!downloaded) {
        setExportAnnouncement('This Browser Could Not Start The Rake CSV Download.');
        return;
      }
      setExportAnnouncement(
        `Exported All ${count(result.totalRows)} ${result.totalRows === 1 ? 'Row' : 'Rows'} From The Exact Server Snapshot.`
      );
    } catch (exportError) {
      if (
        exportAbortControllerRef.current !== controller ||
        exportGenerationRef.current !== generation
      ) {
        return;
      }
      if (isClubDataExportAbort(exportError)) {
        setExportAnnouncement('Export Cancelled. No Partial File Was Downloaded.');
      } else if (isRakeExportUnavailable(exportError)) {
        setExportAnnouncement(
          'The Prepared Rake Export Expired Or Was No Longer Available. No Partial File Was Downloaded. Try Again.'
        );
      } else if (isRakeExportEntitlementChanged(exportError)) {
        setExportAnnouncement(
          'Reporting Access Changed During Export. No Partial File Was Downloaded. Prepare A New Export.'
        );
        version.current += 1;
        void load(true);
      } else if (isRakeExportBusy(exportError)) {
        setExportAnnouncement(
          'Another Club Data Export Is Being Prepared. Wait A Moment, Then Try Again.'
        );
      } else if (isRakeExportAuthorizationError(exportError)) {
        if (userId && contextId) removeClubDataCaches(userId, contextId);
        version.current += 1;
        cursor.current = 0;
        expanded.current = false;
        setSnapshot(null);
        setSnapshotViewKey(null);
        setRows([]);
        setError(describeRakeSnapshotError(exportError));
        setExportAnnouncement(
          'Reporting Access Changed During Export. No Partial File Was Downloaded.'
        );
      } else {
        reportError(exportError, 'RakeSnapshotPanel.export');
        setExportAnnouncement(
          'The Complete Rake Export Could Not Be Prepared. No Partial File Was Downloaded. Try Again.'
        );
      }
    } finally {
      if (
        exportAbortControllerRef.current === controller &&
        exportGenerationRef.current === generation
      ) {
        exportAbortControllerRef.current = null;
        setExporting(false);
        setExportProgress(null);
      }
    }
  }, [
    exporting,
    scope,
    unionId,
    focusClubId,
    snapshot,
    userId,
    loading,
    range.start,
    range.end,
    query,
    focusUserId,
    contextId,
    sort,
    snapshotViewKey,
    cacheKey,
    load,
  ]);

  const subject = snapshot
    ? `${titleCase(snapshot.scope_label)}${
        snapshot.scope === 'union' && snapshot.club_count
          ? ` - ${count(snapshot.club_count)} Club${snapshot.club_count === 1 ? '' : 's'}`
          : ''
      }`
    : SCOPE_COPY[scope].note;
  const exportReady = Boolean(
    snapshot &&
    userId &&
    !loading &&
    snapshot.range.start === range.start &&
    snapshot.range.end === range.end &&
    snapshot.applied_search === (query || null) &&
    snapshot.applied_sort === sort &&
    snapshot.scope === scope &&
    snapshotViewKey === cacheKey
  );
  const exportStatus =
    exportProgress?.stage === 'preparing'
      ? 'Preparing An Exact Rake Snapshot For Export.'
      : exportProgress
        ? `Downloading ${count(exportProgress.loaded)} Of ${count(exportProgress.total)} Rows.`
        : exportAnnouncement;
  const seriesUnit = snapshot?.series_bucket ?? 'day';
  const wordInk = (active: boolean) => (active ? 'sc-ink--white' : 'sc-ink--muted');

  return (
    <SpadeConsole
      eyebrow="Operator Snapshot"
      title="Rake Produced"
      titleId="rake-snapshot-title"
      subtitle={subject}
      pill={SCOPE_COPY[scope].label}
      pillInk="blue"
      crest="spade"
      family="shark"
      foot="foot"
      className={styles.panel}
      aria-labelledby="rake-snapshot-title"
    >
      <div className={styles.headActions}>
        {available.length > 1 ? (
          <div className={styles.scopes} role="group" aria-label="Reporting Scope">
            {available.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={scope === s}
                className={`${styles.scope} ${wordInk(scope === s)}`}
                onClick={() => setScope(s)}
                title={SCOPE_COPY[s].note}
              >
                {SCOPE_COPY[s].label}
              </button>
            ))}
          </div>
        ) : (
          <span className={`sc-label sc-ink--blue ${styles.scopeNote}`}>
            {SCOPE_COPY[scope].note}
          </span>
        )}
        <button
          type="button"
          className={`${styles.exportBtn} sc-ink--white`}
          onClick={() => void exportSnapshot()}
          disabled={!exporting && !exportReady}
          title={exporting ? 'Cancel Exact CSV Export' : 'Export Complete Snapshot As CSV'}
        >
          {exporting ? 'Cancel Export' : 'Export CSV'}
        </button>
      </div>

      <p
        className={`sc-ink--blue ${styles.exportStatus}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Rake Export Status"
      >
        {exportStatus}
      </p>

      <div className={styles.periods} role="group" aria-label="Reporting Period">
        {RAKE_PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            aria-pressed={period === p.key}
            className={`${styles.period} ${wordInk(period === p.key)}`}
            onClick={() => {
              if (p.key === 'custom' && period !== 'custom') setCustom(range);
              setPeriod(p.key);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {period === 'custom' ? (
        <div className={styles.customRange}>
          <label className={styles.dateField}>
            <span className={styles.srOnly}>Range Start</span>
            <input
              className={`sc-ink--silver ${styles.dateInput}`}
              type="date"
              value={custom.start}
              max={custom.end}
              onChange={(e) => setCustom((c) => ({ ...c, start: e.target.value }))}
            />
          </label>
          <span className={`sc-ink--muted ${styles.rangeDivider}`} aria-hidden="true">
            -
          </span>
          <label className={styles.dateField}>
            <span className={styles.srOnly}>Range End</span>
            <input
              className={`sc-ink--silver ${styles.dateInput}`}
              type="date"
              value={custom.end}
              min={custom.start}
              onChange={(e) => setCustom((c) => ({ ...c, end: e.target.value }))}
            />
          </label>
          <span className={`sc-label sc-ink--blue ${styles.rangeTz}`}>UTC</span>
        </div>
      ) : (
        <div className={`sc-ink--silver ${styles.rangeChip}`} aria-live="polite">
          <span>{snapshot?.range.start ?? range.start}</span>
          <span className={`sc-ink--muted ${styles.rangeDivider}`}>-</span>
          <span>{snapshot?.range.end ?? range.end}</span>
          <span className={`sc-label sc-ink--blue ${styles.rangeTz}`}>UTC</span>
        </div>
      )}

      {error && (
        <p className={`sc-copy sc-ink--red ${styles.error}`} role="status">
          {titleCase(error)}
        </p>
      )}

      <dl className={styles.rows} aria-busy={loading} aria-label="Rake Snapshot Totals">
        <div className={`${styles.tile} ${styles.headline}`}>
          <dt className={`sc-label sc-ink--blue ${styles.label}`}>Rake / Fee</dt>
          <dd className={`sc-ink--silver ${styles.value} ${styles.valueBig}`}>
            {summary ? money(summary.fee) : NO_VALUE}
          </dd>
          <dd className={styles.meta}>
            {summary && !isAgent && summary.cash_fee !== null && summary.mtt_fee !== null ? (
              <span className={`sc-ink--muted ${styles.split}`}>
                {money(summary.cash_fee)} Cash - {money(summary.mtt_fee)} MTT
              </span>
            ) : null}
            {deltaNote(delta?.fee_pct, delta?.fee_abs)}
          </dd>
        </div>

        {isAgent ? (
          <>
            <div className={styles.tile}>
              <dt className={`sc-label sc-ink--blue ${styles.label}`}>Est. Commission</dt>
              <dd className={`sc-ink--silver ${styles.value}`}>
                {summary ? money(summary.estimated_commission) : NO_VALUE}
              </dd>
              <dd className={`sc-ink--muted ${styles.meta}`}>
                {summary?.commission_rate !== null && summary?.commission_rate !== undefined
                  ? `${(Number(summary.commission_rate) * 100).toFixed(1)}% Rate`
                  : null}
              </dd>
            </div>
            <div className={styles.tile}>
              <dt className={`sc-label sc-ink--blue ${styles.label}`}>Active Players</dt>
              <dd className={`sc-ink--silver ${styles.value}`}>
                {summary ? compactChips(summary.active) : NO_VALUE}
              </dd>
              <dd className={`sc-ink--muted ${styles.meta}`}>
                {summary ? `${compactChips(summary.members)} In Downline` : null}
              </dd>
            </div>
            <div className={styles.tile}>
              <dt className={`sc-label sc-ink--blue ${styles.label}`}>Hands</dt>
              <dd className={`sc-ink--silver ${styles.value}`}>
                {summary ? compactChips(summary.hands) : NO_VALUE}
              </dd>
              <dd className={`sc-ink--muted ${styles.meta}`}>
                {snapshot?.top_earner?.username
                  ? `Top ${titleCase(snapshot.top_earner.username)}`
                  : null}
              </dd>
            </div>
          </>
        ) : (
          <>
            <div className={styles.tile}>
              <dt className={`sc-label sc-ink--blue ${styles.label}`}>Total Winnings</dt>
              <dd
                className={`${styles.value} ${
                  summary && Number(summary.total_winnings) < 0 ? 'sc-ink--red' : 'sc-ink--green'
                }`}
              >
                {summary ? money(summary.total_winnings) : NO_VALUE}
              </dd>
              <dd className={styles.meta}>{deltaNote(null, delta?.winnings_abs)}</dd>
            </div>
            <div className={styles.tile}>
              <dt className={`sc-label sc-ink--blue ${styles.label}`}>MTT Winnings</dt>
              <dd
                className={`${styles.value} ${
                  summary && Number(summary.mtt_winnings) < 0 ? 'sc-ink--red' : 'sc-ink--green'
                }`}
              >
                {summary ? money(summary.mtt_winnings) : NO_VALUE}
              </dd>
              <dd className={`sc-ink--muted ${styles.meta}`}>
                {summary && summary.mtt_games !== null && summary.mtt_games !== undefined
                  ? `${compactChips(summary.mtt_games)} Tournaments`
                  : null}
              </dd>
            </div>
            <div className={styles.tile}>
              <dt className={`sc-label sc-ink--blue ${styles.label}`}>Games</dt>
              <dd className={`sc-ink--silver ${styles.value}`}>
                {summary ? compactChips(summary.games) : NO_VALUE}
              </dd>
              <dd className={styles.meta}>
                {summary ? (
                  <span className={`sc-ink--muted ${styles.split}`}>
                    {compactChips(summary.hands)} Hands
                  </span>
                ) : null}
                {deltaNote(delta?.games_pct, null)}
              </dd>
            </div>
          </>
        )}
      </dl>

      {series.length > 1 && (
        <figure className={styles.trend}>
          <figcaption className={`sc-label sc-ink--blue ${styles.trendCaption}`}>
            Rake By{' '}
            {snapshot?.series_bucket === 'month'
              ? 'Month'
              : snapshot?.series_bucket === 'week'
                ? 'Week'
                : 'Day'}
          </figcaption>
          {/* The one thing the art does not paint: a bar per bucket, solid blue
              ink on the glass, no gradient, no rounding. */}
          <div
            className={styles.bars}
            role="img"
            aria-label="Rake Trend Across The Selected Period"
          >
            {series.map((p) => {
              const v = Math.abs(Number(p.fee) || 0);
              const h = peak > 0 ? Math.max(2, Math.round((v / peak) * 100)) : 2;
              return (
                <span
                  key={p.bucket}
                  className={styles.bar}
                  style={{ height: `${h}%` }}
                  title={`${bucketLabel(p.bucket, seriesUnit)} - ${money(p.fee)}`}
                />
              );
            })}
          </div>
          <div className={`sc-ink--muted ${styles.trendAxis}`} aria-hidden="true">
            <span>{bucketLabel(series[0].bucket, seriesUnit)}</span>
            <span>Peak {money(peak)}</span>
            <span>{bucketLabel(series[series.length - 1].bucket, seriesUnit)}</span>
          </div>
        </figure>
      )}

      {/*
        Search and sort run on the SERVER. Filtering the fifty rows that happen
        to be loaded, out of two hundred, would find only what was already
        fetched - which is the kind of search that looks like it works.
      */}
      {kind !== 'none' && (rows.length > 0 || !!query) && (
        <div className={styles.listTools}>
          <label className={styles.toolSearch}>
            <span className={styles.srOnly}>Search This List</span>
            <input
              type="search"
              value={search}
              maxLength={RAKE_EXPORT_SEARCH_MAX_LENGTH}
              placeholder="Search By Name"
              autoComplete="off"
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {search ? (
            <button
              type="button"
              className={`${styles.toolClear} sc-ink--white`}
              onClick={() => setSearch('')}
            >
              Clear
            </button>
          ) : null}
          <label className={styles.toolSort}>
            <span className={styles.srOnly}>Sort This List</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as RakeSortKey)}>
              {sortOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  Sort By {o.label}
                </option>
              ))}
            </select>
          </label>
          {query ? (
            <p className={`sc-copy ${styles.toolCount}`} aria-live="polite">
              {/* The count is of MATCHES. The shares beside each row stay
                  against the whole club, so they mean the same thing whether
                  or not anything is typed. */}
              {count(breakdownCount)} Matching {breakdownCount === 1 ? 'Row' : 'Rows'} For "
              {titleCase(snapshot?.applied_search ?? query)}"
            </p>
          ) : null}
        </div>
      )}

      {kind !== 'none' && !!query && rows.length === 0 && !loading && (
        <p className={`sc-copy ${styles.noMatches}`}>
          Nothing In This List Matches "{titleCase(query)}". Clear The Search To See Everything
          Again.
        </p>
      )}

      {/* ------------------------------------------------------ by club --- */}
      {kind === 'club' && rows.length > 0 && (
        <div className={styles.breakdown}>
          <h3 className={`sc-label sc-ink--blue ${styles.breakdownTitle}`}>Rake By Club</h3>
          <ul className={styles.listClub}>
            {(rows as RakeClubRow[]).map((r) => {
              const pct = share(r.fee, total ?? summary?.fee);
              const name = titleCase(r.name);
              return (
                <li key={r.club_id}>
                  <span className={styles.rowName} title={name}>
                    {/* Only rows the server says will open are offered as
                        buttons - can_drill is the same gate the club scope
                        enforces, so this is not a guess. */}
                    {r.can_drill && r.club_id ? (
                      <button
                        type="button"
                        className={`${styles.drillIn} sc-ink--white`}
                        onClick={() => openClub(r.club_id, r.name)}
                        title={`Open ${name}`}
                      >
                        {name}
                      </button>
                    ) : (
                      name
                    )}
                    {r.code ? <em className={styles.rowEm}>#{r.code}</em> : null}
                  </span>
                  <span className={styles.rowBar} aria-hidden="true">
                    <span style={{ width: `${Math.max(1, pct)}%` }} />
                  </span>
                  <span className={styles.rowFee}>{money(r.fee)}</span>
                  <span className={styles.rowShare}>{pct.toFixed(1)}%</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ----------------------------------------------------- by agent --- */}
      {kind === 'agent' && rows.length > 0 && (
        <div className={styles.breakdown}>
          <h3 className={`sc-label sc-ink--blue ${styles.breakdownTitle}`}>
            {clubCrumb ? `${titleCase(clubCrumb.name)} - Rake By Agent` : 'Rake By Agent'}
          </h3>
          {clubCrumb && (
            <nav className={styles.crumbs} aria-label="Union Trail">
              <button
                type="button"
                className={`${styles.crumb} sc-ink--white`}
                onClick={leaveDrill}
              >
                Back To {SCOPE_COPY.union.label}
              </button>
              <button
                type="button"
                className={`${styles.crumb} sc-ink--muted`}
                aria-current="true"
                disabled
              >
                {titleCase(clubCrumb.name)}
              </button>
            </nav>
          )}
          <div className={`sc-label sc-ink--muted ${styles.legend}`} aria-hidden="true">
            <span>Direct</span>
            <span>Network</span>
            <span>Cost</span>
          </div>
          <ul className={styles.listAgent}>
            {(rows as RakeAgentRow[]).map((r) => {
              const pct = share(r.direct_rake, total);
              const name = titleCase(r.name);
              return (
                <li
                  // Unassigned and Unlisted Recipients BOTH have a null agent
                  // id, so keying on it alone collides and React reuses one
                  // row's DOM for the other.
                  key={r.agent_user_id ?? r.name}
                  className={r.is_unassigned ? styles.rowMuted : undefined}
                >
                  <span className={styles.rowName} title={name}>
                    {/* Only rows the server says will open are offered as
                        buttons. can_drill is computed from the same conditions
                        the downline gate enforces, so this is not a guess. */}
                    {r.can_drill && r.agent_user_id ? (
                      <button
                        type="button"
                        className={`${styles.drillIn} sc-ink--white`}
                        onClick={() => openAgent(r.agent_user_id as string, r.name)}
                        title={`Open ${name}'s Downline`}
                      >
                        {name}
                      </button>
                    ) : (
                      name
                    )}
                    <em className={styles.rowEm}>{roleLabel(r.role)}</em>
                  </span>
                  <span className={styles.rowCount}>
                    {count(r.direct_active)}/{count(r.direct_players)}
                    {r.sub_agents > 0 ? ` - ${count(r.sub_agents)} Sub` : ''}
                  </span>
                  <span className={styles.rowBar} aria-hidden="true">
                    <span style={{ width: `${Math.max(1, pct)}%` }} />
                  </span>
                  <span className={styles.rowFee}>{money(r.direct_rake)}</span>
                  <span
                    className={styles.rowNetwork}
                    title={
                      r.sub_agents > 0
                        ? 'This Agent Plus Everyone Beneath Them. Overlaps With The Rows Below It, So It Does Not Sum.'
                        : undefined
                    }
                  >
                    {r.sub_agents > 0 ? money(r.network_rake) : NO_VALUE}
                  </span>
                  <span
                    className={styles.rowCost}
                    title={
                      r.commission_earned === null
                        ? undefined
                        : 'What This Agent Earns, Including From Everyone Beneath Them. Not The Rake Column Times The Rate.'
                    }
                  >
                    {/* null is NOT DISCLOSED and renders as a dash. A zero here
                        would say the agent costs nothing. */}
                    {money(r.commission_earned)}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className={`sc-copy ${styles.rowNote}`}>
            Direct Is The Rake Of Players Assigned To That Agent, And Sums To {money(total)}.
            Network Adds Everyone Beneath Them, So It Overlaps And Does Not Sum.
            {snapshot?.commission_total !== null && snapshot?.commission_total !== undefined ? (
              <>
                {' '}
                Cost Is What Each Agent Earns, Cascade Included - It Is Not The Direct Column Times
                A Rate - And It Sums To {money(snapshot.commission_total)}.
              </>
            ) : null}
          </p>
        </div>
      )}

      {/* -------------------------------------------------- by downline --- */}
      {kind === 'downline' && (
        <div className={styles.breakdown}>
          <h3 className={`sc-label sc-ink--blue ${styles.breakdownTitle}`}>
            {crumbs.length
              ? `${titleCase(crumbs[crumbs.length - 1].name)}'s Downline`
              : 'My Downline'}
          </h3>

          {crumbs.length > 0 && (
            <nav className={styles.crumbs} aria-label="Downline Trail">
              {/* Named for where backing out actually LANDS. A club owner
                  who opened an agent from the club list has no downline of
                  their own, so "My Downline" would be both wrong and a dead
                  end. */}
              <button
                type="button"
                className={`${styles.crumb} sc-ink--white`}
                onClick={leaveDrill}
              >
                {clubCrumb
                  ? `Back To ${titleCase(clubCrumb.name)}`
                  : drillOrigin && drillOrigin !== 'agent'
                    ? `Back To ${SCOPE_COPY[drillOrigin].label}`
                    : 'My Downline'}
              </button>
              {crumbs.map((c, i) => (
                <button
                  key={c.userId}
                  type="button"
                  className={`${styles.crumb} ${i === crumbs.length - 1 ? 'sc-ink--muted' : 'sc-ink--white'}`}
                  onClick={() => setCrumbs((cur) => cur.slice(0, i + 1))}
                  aria-current={i === crumbs.length - 1 ? 'true' : undefined}
                  disabled={i === crumbs.length - 1}
                >
                  {titleCase(c.name)}
                </button>
              ))}
            </nav>
          )}

          {rows.length === 0 ? (
            <p className={`sc-copy ${styles.rowNote}`}>
              {loading ? 'Reading The Chain' : 'Nobody Beneath You Has Played In This Period.'}
            </p>
          ) : (
            <ul className={styles.listDownline}>
              {(rows as RakeDownlineRow[]).map((r) => {
                const pct = share(r.rake, total);
                const opens = r.downline_players > 0 && crumbs.length < MAX_DRILL;
                const name = titleCase(r.name);
                return (
                  <li key={r.player_id}>
                    <span className={styles.rowName} title={name}>
                      {opens ? (
                        <button
                          type="button"
                          className={`${styles.drill} sc-ink--white`}
                          onClick={() => drillInto(r.player_id, r.name)}
                          title={`Open ${name}'s Downline`}
                        >
                          {name}
                        </button>
                      ) : (
                        name
                      )}
                      <em className={styles.rowEm}>{roleLabel(r.role)}</em>
                    </span>
                    <span className={styles.rowCount}>
                      {count(r.hands)} Hands
                      {r.downline_players > 0 ? ` - ${count(r.downline_players)} Below` : ''}
                    </span>
                    <span className={styles.rowBar} aria-hidden="true">
                      <span style={{ width: `${Math.max(1, pct)}%` }} />
                    </span>
                    <span className={styles.rowFee}>{money(r.rake)}</span>
                    <span className={styles.rowNetwork}>
                      {r.downline_players > 0 ? money(r.downline_rake) : NO_VALUE}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {kind !== 'none' && rows.length > 0 && (
        <div className={styles.pager}>
          <span className={`sc-ink--muted ${styles.pagerCount}`}>
            {/* The count is the whole point. A list that stops at fifty and
                says nothing makes the fifty-first row indistinguishable from
                a row that does not exist. */}
            Showing {count(rows.length)} Of {count(breakdownCount)}
          </span>
          {hasMore && (
            <button
              type="button"
              className={`${styles.pagerBtn} sc-ink--white`}
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore
                ? 'Loading'
                : `Load ${count(Math.min(PAGE_SIZE, breakdownCount - rows.length))} More`}
            </button>
          )}
        </div>
      )}

      {pageError && (
        <p className={`sc-copy sc-ink--red ${styles.error}`} role="status">
          {titleCase(pageError)}
        </p>
      )}

      {liveAhead && (
        <p className={`sc-copy ${styles.notice}`} role="status">
          This Table Is Live To The Second. The Headline Above Is A Rollup Written Hourly
          {liveAhead.at ? `, Last At ${utcTime(liveAhead.at)}` : ''}, So The Two Differ Until It
          Runs Again.
        </p>
      )}

      <p className={`sc-label sc-ink--muted ${styles.foot}`}>
        {loading && !snapshot
          ? 'Reading Rollups'
          : snapshot
            ? `Compared Against ${snapshot.previous_range.start} - ${snapshot.previous_range.end} UTC`
            : 'No Snapshot Loaded'}
      </p>
    </SpadeConsole>
  );
}

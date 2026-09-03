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
  describeRakeSnapshotError,
  periodToRange,
  type PeriodKey,
  type RakeAgentRow,
  type RakeBreakdownRow,
  type RakeClubRow,
  type RakeDownlineRow,
  type RakeScope,
  type RakeSnapshot,
} from '../../services/ClubRakeSnapshotService';
import { reportError } from '../../utils/errorReporter';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import type { BusEventType } from '../../core/MasterBus';
import { clubDataQueryKey, readClubDataCache, writeClubDataCache } from '../../lib/clubDataCache';
import { downloadCsv, csvEscape } from '../../utils/downloadCsv';
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
  'SETTLEMENT_COMPLETED',
  'SETTLEMENT_CYCLE_COMPLETED',
  'MEMBER_ROLE_CHANGED',
];
/** Deeper than any real agent chain, and a hard stop if one ever loops. */
const MAX_DRILL = 8;

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
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
  if (!Number.isFinite(d.getTime())) return 'unknown';
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
  clubId: string | null;
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

  const version = useRef(0);
  const cancelled = useRef(false);
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
    };
  }, []);

  // If the viewer's roles resolve after first paint, the selected chip may no
  // longer be one they hold. Fall back rather than keep asking for a refusal.
  useEffect(() => {
    if (!available.includes(scope)) setScope(available[0]);
  }, [available, scope]);

  // Leaving the downline scope must drop the trail with it, or coming back
  // lands you inside somebody else's book with no visible reason why.
  useEffect(() => {
    if (scope !== 'agent') setCrumbs([]);
  }, [scope]);

  const range = useMemo(
    () => (period === 'custom' ? periodToRange('custom', custom) : periodToRange(period)),
    [period, custom]
  );

  const focusUserId = crumbs.length ? crumbs[crumbs.length - 1].userId : agentUserId;

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
      }),
    [scope, range.start, range.end, focusUserId]
  );

  // A new question is a new list. Anything carried over from the last one -
  // the cursor, the fact that it was expanded - describes rows that are gone.
  useEffect(() => {
    cursor.current = 0;
    expanded.current = false;
  }, [cacheKey]);

  /** Paint the last verified answer immediately, then read live over it. */
  useEffect(() => {
    if (!userId || !clubId) return;
    const cached = readClubDataCache<RakeSnapshot>(userId, clubId, cacheKey);
    if (!cached) return;
    const cachedRows = Array.isArray(cached.breakdown) ? cached.breakdown : [];
    setSnapshot(cached);
    setRows(cachedRows);
    cursor.current = cachedRows.length;
    setLoading(false);
  }, [userId, clubId, cacheKey]);

  const load = useCallback(
    async (quiet = false) => {
      if (!clubId) return;
      const mine = ++version.current;
      if (!quiet) setLoading(true);
      setError(null);
      setPageError(null);
      try {
        const next = await ClubRakeSnapshotService.get({
          scope,
          clubId,
          start: range.start,
          end: range.end,
          agentUserId: scope === 'agent' ? focusUserId : null,
          limit: PAGE_SIZE,
          offset: 0,
        });
        if (cancelled.current || mine !== version.current) return;
        setSnapshot(next);
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
        if (userId) writeClubDataCache<RakeSnapshot>(userId, clubId, cacheKey, next);
      } catch (e) {
        if (cancelled.current || mine !== version.current) return;
        // The previous snapshot stays on screen. A refusal for one scope must not
        // wipe the figure the operator was already reading.
        setError(describeRakeSnapshotError(e));
        reportError(e, 'RakeSnapshotPanel.load');
      } finally {
        if (!cancelled.current && mine === version.current) setLoading(false);
      }
    },
    [clubId, scope, range.start, range.end, focusUserId, userId, cacheKey]
  );

  /**
   * Append the next page. It carries its own error state: a failed Load More
   * must not blank the rows already on screen, which is what a shared error
   * would do.
   */
  const loadMore = useCallback(async () => {
    if (!clubId || loadingMore) return;
    const mine = version.current;
    setLoadingMore(true);
    setPageError(null);
    try {
      const next = await ClubRakeSnapshotService.get({
        scope,
        clubId,
        start: range.start,
        end: range.end,
        agentUserId: scope === 'agent' ? focusUserId : null,
        limit: PAGE_SIZE,
        offset: cursor.current,
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
  }, [clubId, scope, range.start, range.end, focusUserId, loadingMore]);

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
      if (eventClubId && eventClubId !== clubId) return;
      void load(true);
    },
    { debounce: 750 }
  );

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

  const deltaNote = (pct: number | null | undefined, abs: number | null | undefined) => {
    const hasPct = pct !== null && pct !== undefined && Number.isFinite(Number(pct));
    const hasAbs = abs !== null && abs !== undefined && Number.isFinite(Number(abs));
    if (!hasPct && !hasAbs) return null;
    const basis = hasPct ? Number(pct) : Number(abs);
    const cls = basis > 0 ? styles.up : basis < 0 ? styles.down : styles.flat;
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

  const exportSnapshot = useCallback(() => {
    if (!snapshot) return;
    const lines: string[] = [];
    lines.push(
      [
        'scope',
        'label',
        'start',
        'end',
        'days',
        'fee',
        'cash_fee',
        'mtt_fee',
        'games',
        'hands',
        'total_winnings',
        'mtt_winnings',
      ].join(',')
    );
    lines.push(
      [
        snapshot.scope,
        snapshot.scope_label,
        snapshot.range.start,
        snapshot.range.end,
        snapshot.range.days,
        snapshot.summary.fee,
        snapshot.summary.cash_fee,
        snapshot.summary.mtt_fee,
        snapshot.summary.games,
        snapshot.summary.hands,
        snapshot.summary.total_winnings,
        snapshot.summary.mtt_winnings,
      ]
        .map(csvEscape)
        .join(',')
    );

    // The EXPORT takes what is on screen, which is rows, not the last page the
    // RPC happened to return. Exporting snapshot.breakdown after a Load More
    // would hand the operator page two only.
    if (rows.length) {
      lines.push('');
      if (snapshot.breakdown_kind === 'club') {
        lines.push(
          [
            'club_id',
            'name',
            'code',
            'games',
            'hands',
            'fee',
            'cash_fee',
            'mtt_fee',
            'winnings',
          ].join(',')
        );
        for (const r of rows as RakeClubRow[]) {
          lines.push(
            [r.club_id, r.name, r.code, r.games, r.hands, r.fee, r.cash_fee, r.mtt_fee, r.winnings]
              .map(csvEscape)
              .join(',')
          );
        }
      } else if (snapshot.breakdown_kind === 'agent') {
        lines.push(
          [
            'agent_user_id',
            'name',
            'role',
            'commission_rate',
            'direct_players',
            'direct_active',
            'direct_hands',
            'direct_rake',
            'sub_agents',
            'network_players',
            'network_rake',
          ].join(',')
        );
        for (const r of rows as RakeAgentRow[]) {
          lines.push(
            [
              r.agent_user_id,
              r.name,
              r.role,
              r.commission_rate,
              r.direct_players,
              r.direct_active,
              r.direct_hands,
              r.direct_rake,
              r.sub_agents,
              r.network_players,
              r.network_rake,
            ]
              .map(csvEscape)
              .join(',')
          );
        }
      } else {
        lines.push(
          [
            'player_id',
            'name',
            'role',
            'depth',
            'upline',
            'hands',
            'rake',
            'downline_players',
            'downline_rake',
          ].join(',')
        );
        for (const r of rows as RakeDownlineRow[]) {
          lines.push(
            [
              r.player_id,
              r.name,
              r.role,
              r.depth,
              r.upline_name,
              r.hands,
              r.rake,
              r.downline_players,
              r.downline_rake,
            ]
              .map(csvEscape)
              .join(',')
          );
        }
      }
    }

    downloadCsv(
      `rake-snapshot-${snapshot.scope}-${snapshot.range.start}-to-${snapshot.range.end}.csv`,
      lines.join('\n')
    );
  }, [snapshot, rows]);

  return (
    <section className={styles.panel} aria-labelledby="rake-snapshot-title">
      <header className={styles.head}>
        <div className={styles.identity}>
          <span className={styles.eyebrow}>
            <span className={styles.light} aria-hidden="true" />
            Operator Snapshot
          </span>
          <h2 id="rake-snapshot-title">Rake Produced</h2>
          <p className={styles.subject}>
            {snapshot
              ? `${snapshot.scope_label}${
                  snapshot.scope === 'union' && snapshot.club_count
                    ? ` - ${count(snapshot.club_count)} Club${snapshot.club_count === 1 ? '' : 's'}`
                    : ''
                }`
              : SCOPE_COPY[scope].note}
          </p>
        </div>

        <div className={styles.headActions}>
          {available.length > 1 && (
            <div className={styles.scopes} role="group" aria-label="Reporting Scope">
              {available.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={scope === s}
                  className={`${styles.scope} ${scope === s ? styles.active : ''}`}
                  onClick={() => setScope(s)}
                  title={SCOPE_COPY[s].note}
                >
                  {SCOPE_COPY[s].label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className={styles.exportBtn}
            onClick={exportSnapshot}
            disabled={!snapshot}
            title="Export This Snapshot As CSV"
          >
            Export
          </button>
        </div>
      </header>

      <div className={styles.periodRow}>
        <div className={styles.periods} role="group" aria-label="Reporting Period">
          {RAKE_PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={period === p.key}
              className={`${styles.period} ${period === p.key ? styles.active : ''}`}
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
            <label>
              <span className={styles.srOnly}>Range Start</span>
              <input
                type="date"
                value={custom.start}
                max={custom.end}
                onChange={(e) => setCustom((c) => ({ ...c, start: e.target.value }))}
              />
            </label>
            <span className={styles.rangeDivider} aria-hidden="true">
              -
            </span>
            <label>
              <span className={styles.srOnly}>Range End</span>
              <input
                type="date"
                value={custom.end}
                min={custom.start}
                onChange={(e) => setCustom((c) => ({ ...c, end: e.target.value }))}
              />
            </label>
            <span className={styles.rangeTz}>UTC</span>
          </div>
        ) : (
          <div className={styles.rangeChip} aria-live="polite">
            <span>{snapshot?.range.start ?? range.start}</span>
            <span className={styles.rangeDivider}>-</span>
            <span>{snapshot?.range.end ?? range.end}</span>
            <span className={styles.rangeTz}>UTC</span>
          </div>
        )}
      </div>

      {error && (
        <p className={styles.error} role="status">
          {error}
        </p>
      )}

      <dl className={styles.tiles} aria-busy={loading} aria-label="Rake Snapshot Totals">
        <div className={`${styles.tile} ${styles.headline}`}>
          <dt>Rake / Fee</dt>
          <dd className={styles.value}>{summary ? money(summary.fee) : NO_VALUE}</dd>
          <dd className={styles.meta}>
            {summary && !isAgent && summary.cash_fee !== null && summary.mtt_fee !== null ? (
              <span className={styles.split}>
                {money(summary.cash_fee)} Cash - {money(summary.mtt_fee)} MTT
              </span>
            ) : null}
            {deltaNote(delta?.fee_pct, delta?.fee_abs)}
          </dd>
        </div>

        {isAgent ? (
          <>
            <div className={styles.tile}>
              <dt>Est. Commission</dt>
              <dd className={styles.value}>
                {summary ? money(summary.estimated_commission) : NO_VALUE}
              </dd>
              <dd className={styles.meta}>
                {summary?.commission_rate !== null && summary?.commission_rate !== undefined
                  ? `${(Number(summary.commission_rate) * 100).toFixed(1)}% Rate`
                  : null}
              </dd>
            </div>
            <div className={styles.tile}>
              <dt>Active Players</dt>
              <dd className={styles.value}>{summary ? count(summary.active) : NO_VALUE}</dd>
              <dd className={styles.meta}>
                {summary ? `${count(summary.members)} In Downline` : null}
              </dd>
            </div>
            <div className={styles.tile}>
              <dt>Hands</dt>
              <dd className={styles.value}>{summary ? count(summary.hands) : NO_VALUE}</dd>
              <dd className={styles.meta}>
                {snapshot?.top_earner?.username ? `Top ${snapshot.top_earner.username}` : null}
              </dd>
            </div>
          </>
        ) : (
          <>
            <div className={styles.tile}>
              <dt>Total Winnings</dt>
              <dd
                className={`${styles.value} ${
                  summary && Number(summary.total_winnings) < 0 ? styles.neg : styles.pos
                }`}
              >
                {summary ? money(summary.total_winnings) : NO_VALUE}
              </dd>
              <dd className={styles.meta}>{deltaNote(null, delta?.winnings_abs)}</dd>
            </div>
            <div className={styles.tile}>
              <dt>MTT Winnings</dt>
              <dd
                className={`${styles.value} ${
                  summary && Number(summary.mtt_winnings) < 0 ? styles.neg : styles.pos
                }`}
              >
                {summary ? money(summary.mtt_winnings) : NO_VALUE}
              </dd>
              <dd className={styles.meta}>
                {summary && summary.mtt_games !== null && summary.mtt_games !== undefined
                  ? `${count(summary.mtt_games)} Tournaments`
                  : null}
              </dd>
            </div>
            <div className={styles.tile}>
              <dt>Games</dt>
              <dd className={styles.value}>{summary ? count(summary.games) : NO_VALUE}</dd>
              <dd className={styles.meta}>
                {summary ? `${count(summary.hands)} Hands` : null}
                {deltaNote(delta?.games_pct, null)}
              </dd>
            </div>
          </>
        )}
      </dl>

      {series.length > 1 && (
        <figure className={styles.trend}>
          <figcaption>
            Rake By{' '}
            {snapshot?.series_bucket === 'month'
              ? 'Month'
              : snapshot?.series_bucket === 'week'
                ? 'Week'
                : 'Day'}
          </figcaption>
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
                  title={`${bucketLabel(p.bucket, snapshot?.series_bucket ?? 'day')} - ${money(p.fee)}`}
                />
              );
            })}
          </div>
          <div className={styles.trendAxis} aria-hidden="true">
            <span>{bucketLabel(series[0].bucket, snapshot?.series_bucket ?? 'day')}</span>
            <span>Peak {money(peak)}</span>
            <span>
              {bucketLabel(series[series.length - 1].bucket, snapshot?.series_bucket ?? 'day')}
            </span>
          </div>
        </figure>
      )}

      {/* ------------------------------------------------------ by club --- */}
      {kind === 'club' && rows.length > 0 && (
        <div className={styles.breakdown}>
          <h3>Rake By Club</h3>
          <ul>
            {(rows as RakeClubRow[]).map((r) => {
              const pct = share(r.fee, total ?? summary?.fee);
              return (
                <li key={r.club_id}>
                  <span className={styles.rowName} title={r.name}>
                    {r.name}
                    {r.code ? <em>#{r.code}</em> : null}
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
          <h3>Rake By Agent</h3>
          <div className={styles.legend} aria-hidden="true">
            <span>Direct</span>
            <span>Network</span>
          </div>
          <ul>
            {(rows as RakeAgentRow[]).map((r) => {
              const pct = share(r.direct_rake, total);
              return (
                <li
                  key={r.agent_user_id ?? 'unassigned'}
                  className={r.is_unassigned ? styles.rowMuted : undefined}
                >
                  <span className={styles.rowName} title={r.name}>
                    {r.name}
                    <em>{roleLabel(r.role)}</em>
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
                </li>
              );
            })}
          </ul>
          <p className={styles.rowNote}>
            Direct Is The Rake Of Players Assigned To That Agent, And Sums To {money(total)}.
            Network Adds Everyone Beneath Them, So It Overlaps And Does Not Sum.
          </p>
        </div>
      )}

      {/* -------------------------------------------------- by downline --- */}
      {kind === 'downline' && (
        <div className={styles.breakdown}>
          <h3>{crumbs.length ? `${crumbs[crumbs.length - 1].name}'s Downline` : 'My Downline'}</h3>

          {crumbs.length > 0 && (
            <nav className={styles.crumbs} aria-label="Downline Trail">
              <button type="button" onClick={() => setCrumbs([])}>
                My Downline
              </button>
              {crumbs.map((c, i) => (
                <button
                  key={c.userId}
                  type="button"
                  onClick={() => setCrumbs((cur) => cur.slice(0, i + 1))}
                  aria-current={i === crumbs.length - 1 ? 'true' : undefined}
                  disabled={i === crumbs.length - 1}
                >
                  {c.name}
                </button>
              ))}
            </nav>
          )}

          {rows.length === 0 ? (
            <p className={styles.rowNote}>
              {loading ? 'Reading The Chain' : 'Nobody Beneath You Has Played In This Period.'}
            </p>
          ) : (
            <ul>
              {(rows as RakeDownlineRow[]).map((r) => {
                const pct = share(r.rake, total);
                const opens = r.downline_players > 0 && crumbs.length < MAX_DRILL;
                return (
                  <li key={r.player_id}>
                    <span className={styles.rowName} title={r.name}>
                      {opens ? (
                        <button
                          type="button"
                          className={styles.drill}
                          onClick={() => drillInto(r.player_id, r.name)}
                          title={`Open ${r.name}'s Downline`}
                        >
                          {r.name}
                        </button>
                      ) : (
                        r.name
                      )}
                      <em>{roleLabel(r.role)}</em>
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
          <span className={styles.pagerCount}>
            {/* The count is the whole point. A list that stops at fifty and
                says nothing makes the fifty-first row indistinguishable from
                a row that does not exist. */}
            Showing {count(rows.length)} Of {count(breakdownCount)}
          </span>
          {hasMore && (
            <button
              type="button"
              className={styles.pagerBtn}
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
        <p className={styles.error} role="status">
          {pageError}
        </p>
      )}

      {liveAhead && (
        <p className={styles.notice} role="status">
          This Table Is Live To The Second. The Headline Above Is A Rollup Written Hourly
          {liveAhead.at ? `, Last At ${utcTime(liveAhead.at)}` : ''}, So The Two Differ Until It
          Runs Again.
        </p>
      )}

      <p className={styles.foot}>
        {loading && !snapshot
          ? 'Reading Rollups'
          : snapshot
            ? `Compared Against ${snapshot.previous_range.start} - ${snapshot.previous_range.end} UTC`
            : 'No Snapshot Loaded'}
      </p>
    </section>
  );
}

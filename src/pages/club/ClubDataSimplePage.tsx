/**
 * CLUB DATA (the owner's everyday screen)
 * ============================================================================
 * Dan 2026-10-14: "THE DATA PAGE IS NOT ACCURATE, AND THE UI NEEDS TO BE
 * IMPROVED TO BE MORE 'POKER BROS' STYLE AND SIMPLICITY. MAKE SURE THAT ALL
 * THE DATA IS REAL TIME ACCURATE DATA."
 *
 * One screen, one read: ca_club_data_screen. It answers what the club has
 * generated in the window - games, total winnings, MTT winnings, fee - and
 * one row per game, all under the same filters.
 *
 * Why the numbers are live (migration 20261015100638): cash rake and cash
 * buy-ins / cash-outs are now written to club_table_daily by the same insert
 * triggers that already fed tournaments, in the transaction that moves the
 * money. Nothing waits for an hourly rebuild. A seated player's stack counts
 * toward winnings, so chips on the felt no longer read as a loss.
 *
 * The page re-reads every 15 seconds on the 1 Day view (60 seconds on the
 * longer windows, which cost the database more), and immediately when the
 * tab comes back into view. A read that fails keeps the last good figures on
 * screen and says so; it never paints zeros.
 *
 * Days are America/Chicago calendar days, daylight saving included (Dan,
 * 2026-10-22), because the server buckets every figure by the Chicago day
 * (20261022103651, 20261022120121). Times on the page are Chicago time too.
 * MTT Winnings are finished MTTs only; a running MTT's entries are shown as
 * Unfinished MTT Entries, and both are inside Total Winnings.
 * The full operator report (union statement, per-player breakdown, export)
 * lives one tap away at ./advanced.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { resolveClubUUID, isUUID } from '../../utils/clubIdResolver';
import { isAuthzError } from '../../utils/clubDashboard';
import { reportError } from '../../utils/errorReporter';
import styles from './ClubDataSimplePage.module.css';
import { useClubGameHost } from '../../hooks/useClubGameHost';
import { usePageTitle } from '../../hooks/usePageTitle';
import { ClubRosterService, type RosterMember } from '../../services/ClubRosterService';
import { titleCase } from '../../utils/titleCase';
import { playerDisplayName } from '../../utils/playerDisplayName';
import { useFitText } from '../../components/lobby/game-cards/useFitText';
import {
  CLUB_DATA_ZONE_LABEL,
  addCalendarDays,
  chicagoClock,
  chicagoDay,
  chicagoStamp,
} from '../../lib/clubDataDay';

type Preset = 1 | 7 | 14;
type GameFilter = 'ALL' | 'HOLDEM' | 'OMAHA' | 'MIXED' | 'MTT' | 'SNG';
type StakesFilter = 'ALL' | 'MICRO' | 'SMALL' | 'MID' | 'HIGH';

export interface ClubDataSummary {
  games: number;
  total_winnings: number;
  mtt_winnings: number;
  /** Entries and payouts so far of MTTs that have not finished (20261022120121). */
  running_mtt_entries?: number;
  running_mtt_fee?: number;
  tournament_winnings?: number;
  cash_winnings?: number;
  fee: number;
  cash_fee?: number;
  mtt_fee?: number;
  on_felt?: number;
  live_games?: number;
}

export interface ClubDataRow {
  kind: 'CASH' | 'MTT' | 'SNG' | 'SPIN' | string;
  id: string;
  name: string;
  variant?: string | null;
  game_class?: string | null;
  blinds?: string | null;
  started_at?: string | null;
  /** Last money movement inside the window (ca_club_data_screen). */
  activity_at?: string | null;
  status?: string | null;
  creator_name?: string | null;
  fee?: number | null;
  winnings?: number | null;
  players?: number | null;
  live?: boolean;
  seated?: number | null;
  on_felt?: number | null;
}

interface Snapshot {
  range: { start: string; end: string; days: number };
  summary: ClubDataSummary;
  member_fees?: {
    cash_fees: number;
    tournament_fees: number;
    total_fees: number;
    day_basis: string;
  } | null;
  rows: ClubDataRow[];
  generated_at?: string;
  /** 'club' for the owner, co-owner and admins; 'downline' for an agent. */
  scope?: 'club' | 'downline';
  club_name?: string | null;
  reporting_scope?: 'club' | 'union';
  accounting_basis?: 'utc_net_money_flow' | 'chicago_net_money_flow';
  /** First day the per-club facts cover. */
  facts_from?: string | null;
}

const PRESETS: Preset[] = [1, 7, 14];
const GAME_FILTERS: Array<{ id: GameFilter; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'HOLDEM', label: "Hold'em" },
  { id: 'OMAHA', label: 'Omaha' },
  { id: 'MIXED', label: 'Mixed' },
  { id: 'MTT', label: 'MTT' },
  { id: 'SNG', label: 'SNG' },
];
const STAKES_FILTERS: Array<{ id: Exclude<StakesFilter, 'ALL'>; label: string }> = [
  { id: 'MICRO', label: 'Micro' },
  { id: 'SMALL', label: 'Small' },
  { id: 'MID', label: 'Mid' },
  { id: 'HIGH', label: 'High' },
];
const ROW_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 20_000;

export function refreshIntervalMs(preset: Preset): number {
  return preset === 1 ? 15_000 : 60_000;
}

/** Today on the Club Data clock: the America/Chicago calendar day. */
export function clubDataToday(now: Date = new Date()): string {
  return chicagoDay(now);
}

export function addDays(iso: string, days: number): string {
  return addCalendarDays(iso, days);
}

export function formatMoney(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * A total in a quarter of a 375px strip. Seen on a phone on 2026-10-15:
 * SHARK CLUB's day read "-55,66..." and "149,60..." because six digits and two
 * decimals do not fit. Below 10,000 the figure is exact to the cent; above it
 * the tile shows 149.6K / 3.54M and the exact amount stays in the title and
 * the accessible name, and in every game row below.
 */
export function formatTotal(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v);
  if (a < 10_000) return formatMoney(v);
  const sign = v < 0 ? '-' : '';
  if (a < 1_000_000)
    return `${sign}${(Math.floor(a / 100) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })}K`;
  return `${sign}${(Math.floor(a / 10_000) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
}

function inkFor(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return styles.inkNeutral;
  return v > 0 ? styles.inkWin : styles.inkLoss;
}

function kindLabel(row: ClubDataRow): string {
  if (row.kind === 'CASH') {
    const v = String(row.variant || 'NLH').toUpperCase();
    const name = v.includes('PLO') ? v : v === 'NLH' || v === 'HOLDEM' ? 'NLH' : v;
    return row.blinds ? `${name} ${row.blinds}` : name;
  }
  if (row.kind === 'SPIN') return 'Spin';
  return row.kind;
}

function startedLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  return chicagoStamp(iso);
}

export function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const s = v.summary as Record<string, unknown> | undefined;
  return (
    (v.scope === 'club' || v.scope === 'downline') &&
    !!v.range &&
    !!s &&
    typeof s === 'object' &&
    ['games', 'total_winnings', 'mtt_winnings', 'fee'].every((k) =>
      Number.isFinite(Number(s[k]))
    ) &&
    Array.isArray(v.rows)
  );
}

export default function ClubDataSimplePage() {
  usePageTitle('Club Data');
  const navigate = useNavigate();
  const params = useParams<{ clubId?: string }>();
  const [searchParams] = useSearchParams();
  const { user, isHydrating } = useAuthUser();
  const userId = user?.id ?? null;
  const clubParam = params.clubId || searchParams.get('club') || '';

  const [clubUuid, setClubUuid] = useState<string | null>(isUUID(clubParam) ? clubParam : null);
  const [preset, setPreset] = useState<Preset>(1);
  const [endDate, setEndDate] = useState<string>(() => clubDataToday());
  const observedDayRef = useRef(endDate);
  const [game, setGame] = useState<GameFilter>('ALL');
  const [stakes, setStakes] = useState<StakesFilter>('ALL');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [playerResults, setPlayerResults] = useState<{
    key: string;
    items: RosterMember[];
    failed: boolean;
  } | null>(null);
  const [playerSearchAccess, setPlayerSearchAccess] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotScope, setSnapshotScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const requestRef = useRef(0);
  // "CLUB JAQK - CLUB DATA": the name stays in the header while a window loads.
  const [clubName, setClubName] = useState<string | null>(null);

  const gameHost = useClubGameHost(clubUuid, !!userId && !isHydrating);
  const today = clubDataToday();
  const isToday = endDate >= today;
  const startDate = addDays(endDate, -(preset - 1));
  const stakesApply = game === 'ALL' || game === 'HOLDEM' || game === 'OMAHA' || game === 'MIXED';
  const scopeKey = JSON.stringify([
    userId,
    clubParam,
    clubUuid,
    startDate,
    endDate,
    game,
    stakes,
    search,
  ]);
  const identityKey = JSON.stringify([userId, clubParam, clubUuid]);
  const playerSearchReady =
    !isHydrating && !!userId && playerSearchAccess === identityKey && !denied;
  const activeScopeRef = useRef(scopeKey);
  activeScopeRef.current = scopeKey;
  const visibleSnapshot = !isHydrating && userId && snapshotScope === scopeKey ? snapshot : null;

  // Retire private figures and pending completions before another account or
  // club can paint. A request number alone does not cover an account switch
  // while the new session is still hydrating, or a response after unmount.
  useLayoutEffect(() => {
    ++requestRef.current;
    setSnapshot(null);
    setSnapshotScope(null);
    setDenied(false);
    setError(null);
    setUpdatedAt(null);
    setLoading(true);
    return () => {
      ++requestRef.current;
    };
  }, [scopeKey]);

  useEffect(() => {
    if (isUUID(clubParam)) {
      setClubUuid(clubParam);
      return;
    }
    if (!clubParam) return;
    let dead = false;
    // A resolver is not a guard: an unknown slug comes back as itself.
    void resolveClubUUID(clubParam)
      .then((id) => {
        if (dead) return;
        if (id && isUUID(id)) {
          setClubUuid(id);
        } else {
          setLoading(false);
          setError('This Club Could Not Be Found.');
        }
      })
      .catch((err) => {
        if (dead) return;
        reportError(err, 'ClubDataSimplePage.resolve_club');
        setLoading(false);
        setError('This Club Could Not Be Found.');
      });
    return () => {
      dead = true;
    };
  }, [clubParam]);

  // The header names the club before the figures arrive, and on the refusal too.
  useEffect(() => {
    if (!clubUuid) return;
    let dead = false;
    let read: PromiseLike<{ data: unknown }>;
    try {
      read = supabase.from('clubs').select('name').eq('id', clubUuid).maybeSingle();
    } catch {
      return undefined; // the screen read carries the name too
    }
    void Promise.resolve(read)
      .then(({ data }) => {
        const name = (data as { name?: string | null } | null)?.name;
        if (!dead && name) setClubName((prev) => prev ?? name);
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [clubUuid]);

  // A new filter or window starts a fresh picture: the old one described
  // something else and must not sit under the new heading.
  useEffect(() => {
    setSnapshot(null);
    setLoading(true);
  }, [clubUuid, preset, endDate, game, stakes, search]);

  const load = useCallback(async () => {
    if (!clubUuid || isHydrating || !userId) return;
    const mine = ++requestRef.current;
    const requestScope = scopeKey;
    const isCurrent = () => mine === requestRef.current && activeScopeRef.current === requestScope;
    let timer = 0;
    try {
      const read = supabase.rpc('ca_club_data_screen', {
        p_club_id: clubUuid,
        p_start: startDate,
        p_end: endDate,
        p_game: game,
        p_stakes: stakesApply ? stakes : 'ALL',
        p_search: search || null,
        p_limit: ROW_LIMIT,
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('club_data_timeout')), REQUEST_TIMEOUT_MS);
      });
      const { data, error: rpcError } = await Promise.race([Promise.resolve(read), timeout]);
      if (!isCurrent()) return;
      if (rpcError) {
        if (isAuthzError(rpcError)) {
          setSnapshot(null);
          setSnapshotScope(null);
          setDenied(true);
          setPlayerSearchAccess(null);
          setError(null);
        } else {
          reportError(rpcError, 'ClubDataSimplePage.snapshot');
          setError('Club Data Could Not Be Read. Showing The Last Good Figures.');
        }
        return;
      }
      if (!isSnapshot(data)) {
        setError('Club Data Came Back Incomplete. Showing The Last Good Figures.');
        return;
      }
      setSnapshot(data);
      setPlayerSearchAccess(identityKey);
      setSnapshotScope(requestScope);
      if (data.club_name) setClubName(data.club_name);
      setDenied(false);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (!isCurrent()) return;
      reportError(err, 'ClubDataSimplePage.snapshot');
      setError('Club Data Could Not Be Read. Showing The Last Good Figures.');
    } finally {
      window.clearTimeout(timer);
      if (isCurrent()) setLoading(false);
    }
  }, [
    clubUuid,
    isHydrating,
    userId,
    startDate,
    endDate,
    game,
    stakes,
    stakesApply,
    search,
    scopeKey,
    identityKey,
  ]);

  // Server roster permissions remain authoritative. Bind results to the exact
  // viewer, club and query, and retire them before a changed identity paints.
  useEffect(() => {
    if (!clubUuid || !playerSearchReady || !search) return;
    const controller = new AbortController();
    let dead = false;
    const key = scopeKey;
    void ClubRosterService.getDataPlayerMatches(clubUuid, {
      search,
      signal: controller.signal,
    })
      .then((page) => {
        if (!dead && activeScopeRef.current === key) {
          setPlayerResults({
            key,
            items: page.items.filter((p) => p.can_view_financials),
            failed: false,
          });
        }
      })
      .catch((err) => {
        if (!dead && activeScopeRef.current === key) {
          reportError(err, 'ClubDataSimplePage.player_search');
          setPlayerResults({ key, items: [], failed: true });
        }
      });
    return () => {
      dead = true;
      controller.abort();
    };
  }, [clubUuid, playerSearchReady, search, scopeKey]);

  // Read now, then keep reading while the screen is in view.
  useEffect(() => {
    void load();
    const every = refreshIntervalMs(isToday ? preset : 14);
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, every);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, preset, isToday]);

  // When the Chicago day turns over on an open "today" view, follow it.
  useEffect(() => {
    const followDay = () => {
      const now = clubDataToday();
      const previousDay = observedDayRef.current;
      observedDayRef.current = now;
      // A refresh may render after midnight before this callback runs. Keep
      // the last observed day instead of relying on render-derived isToday.
      // Comparing dates also handles a tab suspended for more than one day.
      setEndDate((prev) => (prev === previousDay || prev > now ? now : prev));
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') followDay();
    };
    const id = window.setInterval(followDay, 30_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Search waits for the typing to stop.
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const shift = (dir: -1 | 1) => {
    const next = addDays(endDate, dir * preset);
    setEndDate(next > today ? today : next);
  };

  const summary = visibleSnapshot?.summary ?? null;
  const isDownline = visibleSnapshot?.scope === 'downline';
  const feeText = isDownline
    ? formatMoney(visibleSnapshot?.member_fees?.total_fees)
    : summary
      ? formatMoney(summary.fee)
      : '-';
  const feeRef = useFitText<HTMLElement>(feeText, 1, 0.3);
  const factsFrom = visibleSnapshot?.facts_from ?? null;
  const rows = useMemo(() => visibleSnapshot?.rows ?? [], [visibleSnapshot]);
  const liveCount = summary?.live_games ?? rows.filter((r) => r.live).length;
  // A route segment, never a `??` inside the template: the reachability law
  // reads everything after a `?` as a query string.
  const clubKey = clubUuid || clubParam;
  const updatedLabel = updatedAt ? chicagoClock(updatedAt) : null;

  if (denied) {
    return (
      <div className={styles.page}>
        <Header onBack={() => navigate(-1)} clubName={clubName} />
        <div className={styles.empty}>
          <SpadeMark />
          <p className={styles.emptyText}>
            Club Data Is Open To The Club Owner, Admins And Agents.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <Header
        onBack={() => navigate(-1)}
        clubName={clubName}
        /* The full report is the whole club's; an agent's view is his own. */
        onAdvanced={
          visibleSnapshot?.scope === 'club'
            ? () => navigate(`/clubs/${clubKey}/data/advanced`)
            : undefined
        }
      />

      {visibleSnapshot?.reporting_scope === 'union' && (
        <div className={styles.agentScopeBanner}>All Member Clubs And Union Account</div>
      )}
      {isDownline && <div className={styles.agentScopeBanner}>You And Your Downline</div>}

      <div className={styles.rangeBar}>
        <button
          type="button"
          className={styles.arrow}
          onClick={() => shift(-1)}
          aria-label="Previous Period"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M16 3 L5 12 L16 21 Z" />
          </svg>
        </button>
        <div className={styles.rangeChip} aria-live="polite">
          <span>{startDate}</span>
          <span className={styles.rangeDash}>-</span>
          <span>{endDate}</span>
          <span className={styles.rangeTz}>{CLUB_DATA_ZONE_LABEL}</span>
        </div>
        <button
          type="button"
          className={styles.arrow}
          onClick={() => shift(1)}
          disabled={isToday}
          aria-label="Next Period"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 3 L19 12 L8 21 Z" />
          </svg>
        </button>
      </div>

      <div className={styles.segment} role="group" aria-label="Date Range">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={preset === p}
            className={`${styles.segmentButton} ${preset === p ? styles.segmentActive : ''}`}
            onClick={() => setPreset(p)}
          >
            {p === 1 ? '1 Day' : `${p} Days`}
          </button>
        ))}
      </div>

      <dl className={styles.stats} aria-busy={loading} aria-label="Club Totals">
        <div className={styles.stat}>
          <dt className={styles.statLabel}>Games</dt>
          <dd className={styles.statValue}>
            {summary ? Number(summary.games).toLocaleString('en-US') : '-'}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>Total Winnings</dt>
          <dd
            className={`${styles.statValue} ${summary ? inkFor(summary.total_winnings) : ''}`}
            title={summary ? formatMoney(summary.total_winnings) : undefined}
            aria-label={summary ? formatMoney(summary.total_winnings) : undefined}
          >
            {summary ? formatTotal(summary.total_winnings) : '-'}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>MTT Winnings</dt>
          <dd
            className={`${styles.statValue} ${summary ? inkFor(summary.mtt_winnings) : ''}`}
            title={summary ? formatMoney(summary.mtt_winnings) : undefined}
            aria-label={summary ? formatMoney(summary.mtt_winnings) : undefined}
          >
            {summary ? formatTotal(summary.mtt_winnings) : '-'}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>
            {visibleSnapshot?.scope === 'downline' ? 'My Fees Earned' : 'Fee'}
          </dt>
          <dd
            className={styles.statValue}
            ref={feeRef}
            title={
              visibleSnapshot?.scope === 'downline'
                ? formatMoney(visibleSnapshot.member_fees?.total_fees)
                : summary
                  ? formatMoney(summary.fee)
                  : undefined
            }
            aria-label={
              visibleSnapshot?.scope === 'downline'
                ? formatMoney(visibleSnapshot.member_fees?.total_fees)
                : summary
                  ? formatMoney(summary.fee)
                  : undefined
            }
          >
            {feeText}
          </dd>
        </div>
      </dl>
      {visibleSnapshot?.scope === 'downline' && (
        <p className={styles.liveLine}>
          Your Fees After Shares And Adjustments, Across All Games For These UTC Dates. Game Rows
          Show Downline Fees Generated.
        </p>
      )}
      {summary &&
        summary.running_mtt_entries !== undefined &&
        summary.running_mtt_entries !== null && (
          <dl className={styles.runningLine} aria-label="Unfinished MTT Entries">
            <dt>Unfinished MTT Entries</dt>
            <dd
              className={inkFor(summary.running_mtt_entries)}
              title={formatMoney(summary.running_mtt_entries)}
            >
              {formatMoney(summary.running_mtt_entries)}
            </dd>
          </dl>
        )}

      <div className={styles.liveLine} role="status">
        {error ? (
          <span className={styles.inkLoss}>{error}</span>
        ) : loading && !snapshot ? (
          <span>Reading Live Data</span>
        ) : (
          <>
            <span className={styles.liveDot} aria-hidden="true" />
            <span>
              Live{updatedLabel ? ` - Updated ${updatedLabel} ${CLUB_DATA_ZONE_LABEL}` : ''}
              {liveCount > 0 ? ` - ${liveCount} Game${liveCount === 1 ? '' : 's'} In Play` : ''}
            </span>
          </>
        )}
      </div>
      {visibleSnapshot?.accounting_basis === 'chicago_net_money_flow' && (
        <p className={styles.liveLine}>
          Net Entries And Payouts In Chicago Time. MTT Winnings Count Finished MTTs Only. Unfinished
          MTT Entries Are Buy-Ins For MTTs Still Running Or Not Yet Started.
        </p>
      )}
      {visibleSnapshot?.accounting_basis === 'utc_net_money_flow' && (
        <p className={styles.liveLine}>
          Net Entries And Payouts In UTC. Unfinished Event Entries Included.
        </p>
      )}
      {factsFrom && startDate < factsFrom && (
        <p className={styles.liveLine}>Figures Begin {factsFrom}</p>
      )}

      <label className={styles.search}>
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search Player, Game, Creator Or ID"
          aria-label="Search Players And Games"
        />
        <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.searchIcon}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5 L21 21" />
        </svg>
      </label>

      {playerSearchReady &&
        search &&
        searchInput.trim() === search &&
        playerResults?.key === scopeKey && (
          <section aria-label="Matching Players">
            {playerResults.failed ? (
              <p role="status" className={styles.liveLine}>
                Player Search Could Not Be Read.
              </p>
            ) : (
              <ul className={styles.list}>
                {playerResults.items.map((player) => (
                  <li key={player.user_id}>
                    <button
                      type="button"
                      className={`${styles.row} ${styles.playerResult}`}
                      onClick={() =>
                        navigate(
                          `/clubs/${player.management_club_id || clubUuid}/members/${player.user_id}`
                        )
                      }
                    >
                      <span className={styles.rowName}>{titleCase(playerDisplayName(player))}</span>
                      <span className={styles.rowFee}>View Player Data</span>
                    </button>
                  </li>
                ))}
                {playerResults.items.length === 0 && (
                  <li className={styles.more}>No Matching Players In Your Data Scope.</li>
                )}
              </ul>
            )}
          </section>
        )}

      <div className={styles.tabs} role="group" aria-label="Game Type">
        {GAME_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={game === f.id}
            className={`${styles.tab} ${game === f.id ? styles.tabActive : ''}`}
            onClick={() => setGame(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {stakesApply && (
        <div className={styles.stakes} role="group" aria-label="Stakes">
          {STAKES_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={stakes === f.id}
              className={`${styles.stake} ${stakes === f.id ? styles.stakeActive : ''}`}
              onClick={() => setStakes((prev) => (prev === f.id ? 'ALL' : f.id))}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {snapshot && rows.length === 0 ? (
        <div className={styles.empty}>
          <SpadeMark />
          <p className={styles.emptyText}>No Data In This Period.</p>
        </div>
      ) : !snapshot && !loading ? (
        <div className={styles.empty}>
          <SpadeMark />
          <p className={styles.emptyText}>{error ?? 'No Data In This Period.'}</p>
          <button type="button" className={styles.retry} onClick={() => void load()}>
            Try Again
          </button>
        </div>
      ) : (
        <ul className={styles.list} aria-label="Games">
          {rows.map((row) => (
            <li key={`${row.kind}-${row.id}`} className={styles.row}>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>
                  <span className={styles.rowName}>{row.name}</span>
                  {row.live && <span className={styles.badgeLive}>Live</span>}
                </div>
                <div className={styles.rowMeta}>
                  <span className={styles.kind}>{kindLabel(row)}</span>
                  {(row.kind === 'CASH' ? row.activity_at : row.started_at) && (
                    <span>
                      {startedLabel(row.kind === 'CASH' ? row.activity_at : row.started_at)}
                    </span>
                  )}
                  {Number(row.players) > 0 && (
                    <span>
                      {Number(row.players).toLocaleString('en-US')} Player
                      {Number(row.players) === 1 ? '' : 's'}
                    </span>
                  )}
                  {(gameHost || clubName) && <span>By {gameHost || clubName}</span>}
                </div>
              </div>
              <div className={styles.rowFigures}>
                <span className={`${styles.rowWin} ${inkFor(row.winnings)}`}>
                  {formatMoney(row.winnings)}
                </span>
                <span className={styles.rowFee}>Fee {formatMoney(row.fee)}</span>
              </div>
            </li>
          ))}
          {rows.length >= ROW_LIMIT && summary && Number(summary.games) > rows.length && (
            <li className={styles.more}>
              Showing The {rows.length.toLocaleString('en-US')} Most Recent Of{' '}
              {Number(summary.games).toLocaleString('en-US')} Games. Totals Above Cover Them All.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** "CLUB JAQK - CLUB DATA" (Dan 2026-10-17); the club's name is the part that gives way on a narrow phone. */
export function headerTitle(clubName: string | null | undefined): string {
  const name = (clubName || '').trim();
  return name ? `${name.toUpperCase()} - CLUB DATA` : 'Club Data';
}

function Header({
  onBack,
  onAdvanced,
  clubName,
}: {
  onBack: () => void;
  onAdvanced?: () => void;
  clubName?: string | null;
}) {
  return (
    <header className={styles.header}>
      <button type="button" className={styles.back} onClick={onBack} aria-label="Back">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5 L5 12 L12 19 M19 5 L12 12 L19 19" />
        </svg>
      </button>
      <h1 className={styles.title} title={headerTitle(clubName)}>
        {clubName ? (
          <>
            <span className={styles.titleClub}>{clubName.trim().toUpperCase()}</span>
            <span className={styles.titleRest}>&nbsp;- CLUB DATA</span>
          </>
        ) : (
          'Club Data'
        )}
      </h1>
      {onAdvanced ? (
        <button type="button" className={styles.headerAction} onClick={onAdvanced}>
          Report
        </button>
      ) : (
        <span className={styles.headerSpacer} />
      )}
    </header>
  );
}

function SpadeMark() {
  return (
    <svg viewBox="0 0 64 64" className={styles.spade} aria-hidden="true">
      <path d="M32 6 C24 18 10 26 10 38 C10 46 16 51 23 51 C27 51 30 49 31 47 C30 52 28 55 24 58 L40 58 C36 55 34 52 33 47 C34 49 37 51 41 51 C48 51 54 46 54 38 C54 26 40 18 32 6 Z" />
    </svg>
  );
}

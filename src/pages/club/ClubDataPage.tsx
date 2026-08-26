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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { sizedStorageUrl, generateAvatarSvg } from '../../utils/avatarGenerator';
import { useAuthUser } from '../../hooks/useAuthUser';
import { resolveClubUUID, isUUID } from '../../utils/clubIdResolver';
import { isAuthzError } from '../../utils/clubDashboard';
import { reportError } from '../../utils/errorReporter';
import { downloadCsv, csvEscape } from '../../utils/downloadCsv';
import ClubBottomNav from '../../components/club/ClubBottomNav';
import styles from './ClubDataPage.module.css';

type PresetId = 1 | 7 | 14;
type GameFilter = 'ALL' | 'HOLDEM' | 'OMAHA' | 'MIXED' | 'MTT' | 'SNG';
type StakesFilter = 'ALL' | 'MICRO' | 'SMALL' | 'MID' | 'HIGH';

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

type PlayerSort = 'winners' | 'losers' | 'rake' | 'hands';

const PLAYER_SORTS: Array<{ id: PlayerSort; label: string }> = [
  { id: 'winners', label: 'Biggest winners' },
  { id: 'losers', label: 'Biggest losers' },
  { id: 'rake', label: 'Most rake' },
  { id: 'hands', label: 'Most hands' },
];

const REFRESH_MS = 60_000;

/** What a money tile shows when there is no figure to show. Never "0.00". */
const NO_VALUE = '-';

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
  const head = [
    'user_id',
    'username',
    'is_horse',
    'hands',
    'rake',
    'net',
    'cash_net',
    'tournament_net',
  ];
  const lines = rows.map((r) =>
    [r.user_id, r.username, r.is_horse, r.hands, r.rake, r.net, r.cash_net, r.tournament_net]
      .map(esc)
      .join(',')
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
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [showInvoiceDetail, setShowInvoiceDetail] = useState(false);
  const [showInvoiceHistory, setShowInvoiceHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
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

  // cancelledRef guards UNMOUNT. It cannot tell a stale response from a fresh
  // one, and this page reloads on six different inputs plus a 60s poll plus
  // every visibilitychange - so tapping HOLDEM then OMAHA could land the older
  // payload last, leaving the chips saying one thing and the money another.
  // A version per request fixes the ordering; the ref still handles unmount.
  const loadVersion = useRef(0);
  const playersVersion = useRef(0);
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

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

  // resolve a club code or slug into a uuid once
  useEffect(() => {
    let cancelled = false;
    if (!clubParam) {
      setClubUuid(null);
      return;
    }
    if (isUUID(clubParam)) {
      setClubUuid(clubParam);
      return;
    }
    resolveClubUUID(clubParam)
      .then((uuid) => {
        if (cancelled) return;
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
        if (cancelled) return;
        setError('Club not found.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clubParam]);

  // Every piece of per-club state is cleared the moment the club changes.
  // Before this, clubName was only written on success (so a club with no name
  // row kept the PREVIOUS club's name in the footer), and snapshot, invoices
  // and players simply stayed put - the old club's money under the new club's
  // heading, with no skeleton, because the skeleton is gated on !snapshot.
  useEffect(() => {
    setSnapshot(null);
    setInvoices([]);
    setPlayers(null);
    setPlayersError(null);
    setClubName('');
    setExportNote(null);
    setShowInvoiceDetail(false);
  }, [clubUuid]);

  useEffect(() => {
    if (!clubUuid) return;
    let cancelled = false;
    supabase
      .from('clubs')
      .select('name')
      .eq('id', clubUuid)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setClubName(data?.name || '');
      });
    return () => {
      cancelled = true;
    };
  }, [clubUuid]);

  const load = useCallback(
    async (showSpinner: boolean) => {
      if (!clubUuid) return;
      const myVersion = ++loadVersion.current;
      const stale = () => cancelledRef.current || loadVersion.current !== myVersion;
      if (showSpinner) setLoading(true);
      try {
        const { data, error: rpcError } = await supabase.rpc('ca_club_data_snapshot', {
          p_club_id: clubUuid,
          p_start: startDate,
          p_end: endDate,
          p_game: game,
          p_stakes: stakes,
          p_search: search || null,
          p_limit: 200,
        });
        if (stale()) return;
        if (rpcError) {
          if (isAuthzError(rpcError)) {
            setError('You need to be an owner or admin of this club to see its data.');
          } else {
            reportError(rpcError, 'ClubDataPage.snapshot_rpc');
            setError('Could not load club data.');
          }
          setSnapshot(null);
        } else if (!data || !Array.isArray((data as Snapshot).rows)) {
          // A null or shapeless payload used to be stored as success, leaving a
          // page with no data, no skeleton and no message.
          reportError(new Error('snapshot payload was empty'), 'ClubDataPage.snapshot_shape');
          setError('Could not load club data.');
          setSnapshot(null);
        } else {
          setError(null);
          setSnapshot(data as Snapshot);
        }
      } finally {
        // Only the newest request may clear the skeleton. A background poll that
        // finished first used to pull it out from under a load the user had just
        // started, leaving stale rows looking settled.
        if (!stale()) setLoading(false);
      }
    },
    [clubUuid, startDate, endDate, game, stakes, search]
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // Players are fetched only when that tab is open. It is a second scan over
  // the same window and there is no reason to pay for it on every visit.
  const loadPlayers = useCallback(async () => {
    if (!clubUuid) return;
    const myVersion = ++playersVersion.current;
    const stale = () => cancelledRef.current || playersVersion.current !== myVersion;
    setPlayersLoading(true);
    try {
      const { data, error: rpcError } = await supabase.rpc('ca_club_player_breakdown', {
        p_club_id: clubUuid,
        p_start: startDate,
        p_end: endDate,
        p_limit: 500,
      });
      if (stale()) return;
      if (rpcError) {
        if (isAuthzError(rpcError)) {
          setPlayersError('You need to be an owner or admin of this club to see player data.');
        } else {
          reportError(rpcError, 'ClubDataPage.players_rpc');
          setPlayersError('Could not load player data.');
        }
        setPlayers(null);
      } else if (!data || !Array.isArray((data as PlayerBreakdown).players)) {
        reportError(new Error('player payload was empty'), 'ClubDataPage.players_shape');
        setPlayersError('Could not load player data.');
        setPlayers(null);
      } else {
        setPlayersError(null);
        setPlayers(data as PlayerBreakdown);
      }
    } finally {
      if (!stale()) setPlayersLoading(false);
    }
  }, [clubUuid, startDate, endDate]);

  useEffect(() => {
    if (tab !== 'players') return;
    void loadPlayers();
  }, [tab, loadPlayers]);

  // The RPC returns the top slice by net. Re-sorting client-side is honest for
  // every order except "biggest losers", which reads from the far end of a list
  // that was cut at the near end - so the foot note says when the list is cut.
  const sortedPlayers = useMemo(() => {
    const list = players?.players ? [...players.players] : [];
    if (playerSort === 'losers') return list.sort((a, b) => a.net - b.net);
    if (playerSort === 'rake') return list.sort((a, b) => b.rake - a.rake);
    if (playerSort === 'hands') return list.sort((a, b) => b.hands - a.hands);
    return list.sort((a, b) => b.net - a.net);
  }, [players, playerSort]);

  // near-real-time: re-poll on an interval and whenever the tab regains focus
  useEffect(() => {
    if (!clubUuid) return;
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
      void load(false);
      if (tabRef.current === 'players') void loadPlayers();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      pinToToday();
      void load(false);
      // The Players tab was never refreshed by either trigger, so the tiles
      // ticked over every minute above a list frozen at whenever it was opened.
      if (tabRef.current === 'players') void loadPlayers();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [clubUuid, load, loadPlayers]);

  useEffect(() => {
    if (!clubUuid) return;
    let cancelled = false;
    supabase.rpc('ca_club_union_invoices', { p_club_id: clubUuid, p_limit: 8 }).then(
      ({ data, error: invErr }) => {
        if (cancelled) return;
        if (invErr) {
          if (!isAuthzError(invErr)) reportError(invErr, 'ClubDataPage.invoices_rpc');
          // An empty list hides the whole square-up banner, which an owner
          // reads as "nothing outstanding". A failed read has to say so.
          setInvoicesError(
            isAuthzError(invErr)
              ? 'You Do Not Have Access To This Club\u2019s Union Statements.'
              : 'Could Not Load Your Union Statement.'
          );
          setInvoices([]);
        } else {
          setInvoicesError(null);
          setInvoices((data as InvoiceRow[]) || []);
        }
      },
      (err: unknown) => {
        // No rejection handler at all previously: an unhandled promise
        // rejection, and still a silent banner.
        if (cancelled) return;
        reportError(err, 'ClubDataPage.invoices_rpc');
        setInvoicesError('Could Not Load Your Union Statement.');
        setInvoices([]);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [clubUuid]);

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

  // The screen holds one page of rows. Exporting that silently would hand
  // someone a CSV of 200 games labelled as the period's data when the period
  // has thousands - on a financial page that is not acceptable, so the export
  // re-fetches at the RPC's ceiling and says so when even that is not enough.
  const exportCsv = useCallback(async () => {
    if (!clubUuid) return;
    setExportNote(null);

    if (tab === 'players') {
      if (!sortedPlayers.length) return;
      if (players && players.player_count > sortedPlayers.length) {
        setExportNote(
          `Exported ${sortedPlayers.length} of ${players.player_count} players. Narrow the date range to export the rest.`
        );
      }
      if (!downloadCsv(`club_players_${startDate}_${endDate}.csv`, playersToCsv(sortedPlayers))) {
        setExportNote('This browser could not start the download.');
      }
      return;
    }

    if (!snapshot) return;
    let rows = snapshot.rows;
    try {
      if (snapshot.row_count > rows.length) {
        const { data, error: exportError } = await supabase.rpc('ca_club_data_snapshot', {
          p_club_id: clubUuid,
          p_start: startDate,
          p_end: endDate,
          p_game: game,
          p_stakes: stakes,
          p_search: search || null,
          p_limit: 500,
        });
        if (!exportError && Array.isArray((data as Snapshot)?.rows)) {
          rows = (data as Snapshot).rows;
        }
      }
    } catch (e) {
      reportError(e, 'ClubDataPage.export_refetch');
    }
    if (!rows?.length) return;
    if (snapshot.row_count > rows.length) {
      setExportNote(
        `Exported the ${rows.length} most recent of ${snapshot.row_count} games. Narrow the date range to export the rest.`
      );
    }
    if (!downloadCsv(`club_data_${startDate}_${endDate}.csv`, rowsToCsv(rows))) {
      setExportNote('This browser could not start the download.');
    }
  }, [clubUuid, snapshot, startDate, endDate, game, stakes, search, tab, players, sortedPlayers]);

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

  // "vs prev 14d" under a headline number. Null pct means the prior window was
  // zero, and nothing is a percentage of nothing - so nothing is shown.
  const pctNote = (pct: number | null | undefined) => {
    if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return null;
    // The RPC rounds to one decimal; rounding again here means a hand-rolled
    // caller cannot push 33.33333333333333% into a 93px tile.
    const v = Math.round(Number(pct) * 10) / 10;
    const cls = v > 0 ? styles.deltaUp : v < 0 ? styles.deltaDown : styles.deltaFlat;
    return (
      <div
        className={`${styles.delta} ${cls}`}
        title={prevRange ? `previous period ${prevRange.start} to ${prevRange.end}` : undefined}
      >
        {v > 0 ? '+' : ''}
        {/* prevRange, not `preset`: the preset flips the instant the button is
            tapped while the snapshot is still the old window, so this read
            "Vs Prev 1d" over a 14-day comparison for the whole fetch. */}
        {v}% Vs Prev {prevRange?.days ?? preset}d
      </div>
    );
  };

  const absNote = (abs: number | null | undefined) => {
    if (abs === null || abs === undefined || !Number.isFinite(Number(abs))) return null;
    const v = Number(abs);
    const cls = v > 0 ? styles.deltaUp : v < 0 ? styles.deltaDown : styles.deltaFlat;
    return (
      <div
        className={`${styles.delta} ${cls}`}
        title={prevRange ? `previous period ${prevRange.start} to ${prevRange.end}` : undefined}
      >
        {v > 0 ? '+' : ''}
        {money(v)} Vs Prev {prevRange?.days ?? preset}d
      </div>
    );
  };

  if (isHydrating) {
    return (
      <div className={styles.page}>
        <div className={styles.state}>Loading...</div>
      </div>
    );
  }
  if (!user) {
    return (
      <div className={styles.page}>
        <div className={styles.state}>Sign In To View Club Data.</div>
      </div>
    );
  }
  if (!clubParam) {
    /* Dan 2026-08-25: the footer stays on this state deliberately. Landing on
       "No Club Selected" with no navigation is a dead end - the bar is the way
       out, and it can resolve a club of its own even when the route gave none. */
    return (
      <div className={styles.page}>
        <div className={styles.state}>No Club Selected.</div>
        <ClubBottomNav />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.headerBtn}
          onClick={() => navigate(-1)}
          aria-label="Go back"
        >
          &laquo;
        </button>
        <h1 className={styles.title}>Club Data</h1>
        <button
          type="button"
          className={styles.headerBtn}
          onClick={() => {
            void exportCsv();
          }}
          disabled={tab === 'players' ? !sortedPlayers.length : !snapshot?.rows?.length}
          aria-label="Export as CSV"
          title="Export as CSV"
        >
          CSV
        </button>
      </header>

      <div className={styles.rangeBar}>
        <button
          type="button"
          className={styles.arrow}
          onClick={() => shiftRange(-1)}
          aria-label="Previous period"
        >
          &#9664;
        </button>
        <div className={styles.rangeChip}>
          <span>{startDate}</span>
          <span>&mdash;</span>
          <span>{endDate}</span>
          <span className={styles.rangeTz}>UTC</span>
        </div>
        <button
          type="button"
          className={styles.arrow}
          onClick={() => shiftRange(1)}
          disabled={isToday}
          aria-label="Next period"
        >
          &#9654;
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
            {p === 1 ? '1 day' : `${p} days`}
          </button>
        ))}
      </div>

      <div className={styles.tabs} role="tablist" aria-label="View">
        <button
          type="button"
          role="tab"
          id="club-data-tab-games"
          aria-controls="club-data-panel-games"
          aria-selected={tab === 'games'}
          className={`${styles.tab} ${tab === 'games' ? styles.active : ''}`}
          onClick={() => setTab('games')}
        >
          Games
        </button>
        <button
          type="button"
          role="tab"
          id="club-data-tab-players"
          aria-controls="club-data-panel-players"
          aria-selected={tab === 'players'}
          className={`${styles.tab} ${tab === 'players' ? styles.active : ''}`}
          onClick={() => setTab('players')}
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
      <div className={styles.summary} aria-busy={loading}>
        <div className={styles.tile}>
          <div className={styles.tileValue}>{summary ? compactInt(summary.games) : NO_VALUE}</div>
          <div className={styles.tileLabel}>Games</div>
          {summary && pctNote(delta?.games_pct)}
        </div>
        <div className={styles.tile}>
          <div
            className={`${styles.tileValue} ${summary && Number(summary.total_winnings) < 0 ? styles.neg : styles.pos}`}
          >
            {summary ? money(summary.total_winnings) : NO_VALUE}
          </div>
          <div className={styles.tileLabel}>Total Winnings</div>
          {summary && absNote(delta?.winnings_abs)}
        </div>
        <div className={styles.tile}>
          <div
            className={`${styles.tileValue} ${summary && Number(summary.mtt_winnings) < 0 ? styles.neg : styles.pos}`}
          >
            {summary ? money(summary.mtt_winnings) : NO_VALUE}
          </div>
          <div className={styles.tileLabel}>MTT Winnings</div>
        </div>
        <div className={styles.tile}>
          <div className={styles.tileValue}>{summary ? money(summary.fee) : NO_VALUE}</div>
          <div className={styles.tileLabel}>Fee</div>
          {/* cash_fee and mtt_fee are already in the payload and rendered
              nowhere. Cash rake is a percentage of pots; MTT fee is a fixed cut
              of buy-ins. Blending them into one number meant an owner deciding
              "more tournaments or more cash tables" could not answer it from
              the page that exists to answer it. Dan 2026-08-25. */}
          {summary &&
            Number.isFinite(Number(summary.cash_fee)) &&
            Number.isFinite(Number(summary.mtt_fee)) && (
              <div className={styles.tileSub}>
                {money(summary.cash_fee)} Cash - {money(summary.mtt_fee)} MTT
              </div>
            )}
          {summary && pctNote(delta?.fee_pct)}
        </div>
      </div>

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

      {!latestInvoice && invoicesError && (
        <div className={`${styles.state} ${styles.error}`} role="alert">
          {invoicesError}
        </div>
      )}

      {olderInvoices.length > 0 && latestInvoice && (
        <div className={styles.invoiceHistory}>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setShowInvoiceHistory((v) => !v)}
          >
            {showInvoiceHistory
              ? 'Hide Earlier Statements'
              : `Earlier Statements (${olderInvoices.length})`}
          </button>
          {showInvoiceHistory &&
            olderInvoices.map((inv) => (
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
        >
          <div className={styles.invoiceTop}>
            <span className={styles.invoiceLabel}>
              {latestInvoice.direction === 'union owes club'
                ? 'Union owes you'
                : 'Weekly square-up'}
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
            <div className={styles.invoiceLines}>
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
          >
            {!latestInvoice.breakdown
              ? 'No Statement Detail'
              : showInvoiceDetail
                ? 'Hide statement'
                : 'View statement'}
          </button>
        </div>
      )}

      {tab === 'games' && (
        <div role="tabpanel" id="club-data-panel-games" aria-labelledby="club-data-tab-games">
          <div className={styles.searchRow}>
            <input
              className={styles.searchInput}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Type In The Name Of The Game, Creator ID Or Player ID"
              aria-label="Search games"
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

          <div className={styles.list}>
            {loading && !snapshot && !error && (
              <>
                <div className={styles.skeletonRow} />
                <div className={styles.skeletonRow} />
                <div className={styles.skeletonRow} />
              </>
            )}

            {error && (
              <div className={`${styles.state} ${styles.error}`} role="alert">
                {error}
              </div>
            )}

            {!loading && !error && snapshot && snapshot.rows.length === 0 && (
              <div className={styles.state}>No Games In This Period.</div>
            )}

            {!error &&
              snapshot?.rows.map((row) => {
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
                  <div className={styles.row} key={`${row.kind}-${row.id}`}>
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
          </div>
        </div>
      )}

      {tab === 'players' && (
        <div
          className={styles.playersPanel}
          role="tabpanel"
          id="club-data-panel-players"
          aria-labelledby="club-data-tab-players"
          aria-busy={playersLoading}
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

          <div className={styles.list}>
            {playersLoading && !players && !playersError && (
              <>
                <div className={styles.skeletonRow} />
                <div className={styles.skeletonRow} />
                <div className={styles.skeletonRow} />
              </>
            )}

            {playersError && (
              <div className={`${styles.state} ${styles.error}`} role="alert">
                {playersError}
              </div>
            )}

            {!playersLoading && !playersError && players && sortedPlayers.length === 0 && (
              <div className={styles.state}>No Player Activity In This Period.</div>
            )}

            {!playersError &&
              sortedPlayers.map((pl, i) => (
                <div className={styles.playerRow} key={pl.user_id}>
                  <div className={styles.playerRank}>{i + 1}</div>

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
                      {pl.is_horse && <span className={styles.horseTag}>HORSE</span>}
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
          </div>

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
                ? ` Showing ${compactInt(sortedPlayers.length)} of ${compactInt(players.player_count)} players, taken from the top by net.`
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

      {tab === 'games' && snapshot && (
        <div className={styles.footNote}>
          {clubName ? `${clubName} - ` : ''}
          Showing {compactInt(snapshot.rows.length)} Of {compactInt(snapshot.row_count)} Games
          {snapshot.data_updated_at
            ? ` - cash data updated ${utcTime(snapshot.data_updated_at)}`
            : ''}
        </div>
      )}

      {/* Dan 2026-08-25: Club Data is the footer's Data tab, so it carries the
          footer itself. The Data tab hides itself while you are here. */}
      <ClubBottomNav clubId={clubUuid || undefined} />
    </div>
  );
}

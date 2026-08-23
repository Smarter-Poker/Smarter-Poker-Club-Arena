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
import { useAuthUser } from '../../hooks/useAuthUser';
import { resolveClubUUID, isUUID } from '../../utils/clubIdResolver';
import { isAuthzError } from '../../utils/clubDashboard';
import { reportError } from '../../utils/errorReporter';
import { downloadCsv, csvEscape } from '../../utils/downloadCsv';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [tab, setTab] = useState<'games' | 'players'>('games');
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
        if (uuid) {
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
    const id = setInterval(() => {
      void load(false);
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [clubUuid, load]);

  useEffect(() => {
    if (!clubUuid) return;
    let cancelled = false;
    supabase
      .rpc('ca_club_union_invoices', { p_club_id: clubUuid, p_limit: 8 })
      .then(({ data, error: invErr }) => {
        if (cancelled) return;
        if (invErr) {
          if (!isAuthzError(invErr)) reportError(invErr, 'ClubDataPage.invoices_rpc');
          setInvoices([]);
        } else {
          setInvoices((data as InvoiceRow[]) || []);
        }
      });
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

  const latestInvoice = invoices[0] || null;
  const summary = snapshot?.summary;
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
        {v}% Vs Prev {preset}d
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
        {money(v)} Vs Prev {preset}d
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
    return (
      <div className={styles.page}>
        <div className={styles.state}>No Club Selected.</div>
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

      <div className={styles.presets} role="tablist" aria-label="Date range">
        {([1, 7, 14] as PresetId[]).map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={preset === p}
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
          aria-selected={tab === 'games'}
          className={`${styles.tab} ${tab === 'games' ? styles.active : ''}`}
          onClick={() => setTab('games')}
        >
          Games
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'players'}
          className={`${styles.tab} ${tab === 'players' ? styles.active : ''}`}
          onClick={() => setTab('players')}
        >
          Players
        </button>
      </div>

      <div className={styles.summary}>
        <div className={styles.tile}>
          <div className={styles.tileValue}>{compactInt(summary?.games)}</div>
          <div className={styles.tileLabel}>Games</div>
          {pctNote(delta?.games_pct)}
        </div>
        <div className={styles.tile}>
          <div
            className={`${styles.tileValue} ${Number(summary?.total_winnings || 0) < 0 ? styles.neg : styles.pos}`}
          >
            {money(summary?.total_winnings)}
          </div>
          <div className={styles.tileLabel}>Total Winnings</div>
          {absNote(delta?.winnings_abs)}
        </div>
        <div className={styles.tile}>
          <div
            className={`${styles.tileValue} ${Number(summary?.mtt_winnings || 0) < 0 ? styles.neg : styles.pos}`}
          >
            {money(summary?.mtt_winnings)}
          </div>
          <div className={styles.tileLabel}>MTT Winnings</div>
        </div>
        <div className={styles.tile}>
          <div className={styles.tileValue}>{money(summary?.fee)}</div>
          <div className={styles.tileLabel}>Fee</div>
          {pctNote(delta?.fee_pct)}
        </div>
      </div>

      {latestInvoice && (
        <div
          className={`${styles.invoice} ${
            latestInvoice.status === 'paid'
              ? styles.invoicePaid
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
            <span className={styles.invoiceAmount}>{money(latestInvoice.amount)}</span>
          </div>
          <div className={styles.invoiceMeta}>
            {String(latestInvoice.period_start || '').slice(0, 10)} To{' '}
            {String(latestInvoice.period_end || '').slice(0, 10)}
            {latestInvoice.due_at ? ` - due ${String(latestInvoice.due_at).slice(0, 10)}` : ''}
            {latestInvoice.status ? ` - ${latestInvoice.status}` : ''}
          </div>

          {showInvoiceDetail && latestInvoice.breakdown && (
            <div className={styles.invoiceLines}>
              {[
                ['Rake generated', latestInvoice.breakdown.rake_generated],
                ['Your rakeback (90%)', latestInvoice.breakdown.rakeback_due],
                ['Union fee kept (10%)', latestInvoice.breakdown.union_fee_kept],
                ['Player win/loss', latestInvoice.breakdown.players_won],
                ['Settled in chips', latestInvoice.breakdown.settled_in_chips],
                ['ECO adjustment', latestInvoice.breakdown.eco_amount],
                ['Payments received', latestInvoice.breakdown.presettled],
              ].map(([label, value]) => (
                <div className={styles.invoiceLine} key={String(label)}>
                  <span>{String(label)}</span>
                  <span>{money(Number(value || 0))}</span>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setShowInvoiceDetail((v) => !v)}
          >
            {showInvoiceDetail ? 'Hide statement' : 'View statement'}
          </button>
        </div>
      )}

      {tab === 'games' && (
        <>
          <div className={styles.searchRow}>
            <input
              className={styles.searchInput}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Type In The Name Of The Game, Creator ID Or Player ID"
              aria-label="Search games"
            />
          </div>

          <div className={styles.filterRow} role="tablist" aria-label="Game type">
            {GAME_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={game === f.id}
                className={`${styles.chip} ${game === f.id ? styles.active : ''}`}
                onClick={() => setGame(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div
            className={`${styles.filterRow} ${styles.stakesRow}`}
            role="tablist"
            aria-label="Stakes"
          >
            {STAKES_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={stakes === f.id}
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

            {error && <div className={`${styles.state} ${styles.error}`}>{error}</div>}

            {!loading && !error && snapshot && snapshot.rows.length === 0 && (
              <div className={styles.state}>No Games In This Period.</div>
            )}

            {!error &&
              snapshot?.rows.map((row) => {
                const started = row.started_at ? new Date(row.started_at) : null;
                const hhmm = started
                  ? `${String(started.getUTCHours()).padStart(2, '0')}:${String(started.getUTCMinutes()).padStart(2, '0')}`
                  : '--:--';
                const ddmm = started
                  ? `${String(started.getUTCDate()).padStart(2, '0')}/${String(started.getUTCMonth() + 1).padStart(2, '0')}`
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
                      {row.creator_avatar ? (
                        <img
                          className={styles.avatar}
                          src={row.creator_avatar}
                          alt=""
                          loading="lazy"
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
        </>
      )}

      {tab === 'players' && (
        <div className={styles.playersPanel}>
          <div className={styles.filterRow} role="tablist" aria-label="Sort players">
            {PLAYER_SORTS.map((o) => (
              <button
                key={o.id}
                type="button"
                role="tab"
                aria-selected={playerSort === o.id}
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
              <div className={`${styles.state} ${styles.error}`}>{playersError}</div>
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
                      <img className={styles.avatar} src={pl.avatar_url} alt="" loading="lazy" />
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
                ? ` Showing ${sortedPlayers.length} of ${compactInt(players.player_count)} players, taken from the top by net.`
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
          Showing {snapshot.rows.length} Of {compactInt(snapshot.row_count)} Games
          {snapshot.data_updated_at
            ? ` - cash data updated ${new Date(snapshot.data_updated_at).toLocaleTimeString()}`
            : ''}
        </div>
      )}
    </div>
  );
}

/**
 * CLUB DATA
 * ============================================================================
 * The club owner's real-time view of what their club is generating, and what
 * they owe the union at the end of the week.
 *
 * Data comes from two RPCs, both gated server-side by
 * ca_can_view_club_finances (owner / admin / super_agent, or platform admin):
 *
 *   ca_club_data_snapshot   summary tiles + one row per game. Cash figures are
 *                           read from the club_table_daily rollup because
 *                           expanding rake attribution live over a fourteen-day
 *                           window does not finish inside the statement
 *                           timeout; tournaments and spins are computed live.
 *   ca_club_union_invoices  the weekly square-up statements the union issues
 *                           every Monday.
 *
 * The client gate below is cosmetic. The RPCs raise 42501 on their own.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { resolveClubUUID, isUUID } from '../../utils/clubIdResolver';
import { isAuthzError } from '../../utils/clubDashboard';
import { reportError } from '../../utils/errorReporter';
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

interface Snapshot {
  range: { start: string; end: string; days: number };
  summary: {
    games: number;
    total_winnings: number;
    mtt_winnings: number;
    cash_winnings: number;
    fee: number;
    cash_fee: number;
    mtt_fee: number;
    hands: number;
  };
  rows: SnapshotRow[];
  row_count: number;
  union_id: string | null;
  data_updated_at: string | null;
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
  { id: 'SNG', label: 'SNG' },
];

const STAKES_FILTERS: Array<{ id: StakesFilter; label: string }> = [
  { id: 'MICRO', label: 'Micro' },
  { id: 'SMALL', label: 'Small' },
  { id: 'MID', label: 'Mid' },
  { id: 'HIGH', label: 'High' },
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
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    'started_at', 'kind', 'name', 'variant', 'blinds', 'rake_percent',
    'hands', 'players', 'fee', 'winnings',
  ];
  const lines = rows.map((r) =>
    [r.started_at, r.kind, r.name, r.variant, r.blinds, r.rake_percent,
      r.hands, r.players, r.fee, r.winnings].map(esc).join(','));
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

  // guards every async write so nothing lands in an unmounted tree
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
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
    if (!clubParam) { setClubUuid(null); return; }
    if (isUUID(clubParam)) { setClubUuid(clubParam); return; }
    resolveClubUUID(clubParam)
      .then((uuid) => { if (!cancelled) setClubUuid(uuid || null); })
      .catch((err) => {
        reportError(err, 'ClubDataPage.resolve_club');
        if (!cancelled) setError('Club not found');
      });
    return () => { cancelled = true; };
  }, [clubParam]);

  useEffect(() => {
    if (!clubUuid) return;
    let cancelled = false;
    supabase.from('clubs').select('name').eq('id', clubUuid).maybeSingle()
      .then(({ data }) => { if (!cancelled && data?.name) setClubName(data.name); });
    return () => { cancelled = true; };
  }, [clubUuid]);

  const load = useCallback(async (showSpinner: boolean) => {
    if (!clubUuid) return;
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
      if (cancelledRef.current) return;
      if (rpcError) {
        if (isAuthzError(rpcError)) {
          setError('You need to be an owner or admin of this club to see its data.');
        } else {
          reportError(rpcError, 'ClubDataPage.snapshot_rpc');
          setError('Could not load club data.');
        }
        setSnapshot(null);
      } else {
        setError(null);
        setSnapshot(data as Snapshot);
      }
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [clubUuid, startDate, endDate, game, stakes, search]);

  useEffect(() => { void load(true); }, [load]);

  // near-real-time: re-poll on an interval and whenever the tab regains focus
  useEffect(() => {
    if (!clubUuid) return;
    const id = setInterval(() => { void load(false); }, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(false); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [clubUuid, load]);

  useEffect(() => {
    if (!clubUuid) return;
    let cancelled = false;
    supabase.rpc('ca_club_union_invoices', { p_club_id: clubUuid, p_limit: 8 })
      .then(({ data, error: invErr }) => {
        if (cancelled) return;
        if (invErr) {
          if (!isAuthzError(invErr)) reportError(invErr, 'ClubDataPage.invoices_rpc');
          setInvoices([]);
        } else {
          setInvoices((data as InvoiceRow[]) || []);
        }
      });
    return () => { cancelled = true; };
  }, [clubUuid]);

  const shiftRange = useCallback((direction: -1 | 1) => {
    const d = new Date(`${endDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + direction * preset);
    const next = toISODate(d);
    const today = toISODate(new Date());
    setEndDate(next > today ? today : next);
  }, [endDate, preset]);

  const exportCsv = useCallback(() => {
    if (!snapshot?.rows?.length) return;
    const blob = new Blob([rowsToCsv(snapshot.rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `club_data_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [snapshot, startDate, endDate]);

  const latestInvoice = invoices[0] || null;
  const summary = snapshot?.summary;

  if (isHydrating) {
    return <div className={styles.page}><div className={styles.state}>Loading...</div></div>;
  }
  if (!user) {
    return <div className={styles.page}><div className={styles.state}>Sign in to view club data.</div></div>;
  }
  if (!clubParam) {
    return <div className={styles.page}><div className={styles.state}>No club selected.</div></div>;
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
          onClick={exportCsv}
          disabled={!snapshot?.rows?.length}
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

      <div className={styles.summary}>
        <div className={styles.tile}>
          <div className={styles.tileValue}>{compactInt(summary?.games)}</div>
          <div className={styles.tileLabel}>Games</div>
        </div>
        <div className={styles.tile}>
          <div className={`${styles.tileValue} ${Number(summary?.total_winnings || 0) < 0 ? styles.neg : styles.pos}`}>
            {money(summary?.total_winnings)}
          </div>
          <div className={styles.tileLabel}>Total Winnings</div>
        </div>
        <div className={styles.tile}>
          <div className={`${styles.tileValue} ${Number(summary?.mtt_winnings || 0) < 0 ? styles.neg : styles.pos}`}>
            {money(summary?.mtt_winnings)}
          </div>
          <div className={styles.tileLabel}>MTT Winnings</div>
        </div>
        <div className={styles.tile}>
          <div className={styles.tileValue}>{money(summary?.fee)}</div>
          <div className={styles.tileLabel}>Fee</div>
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
              {latestInvoice.direction === 'union owes club' ? 'Union owes you' : 'Weekly square-up'}
            </span>
            <span className={styles.invoiceAmount}>{money(latestInvoice.amount)}</span>
          </div>
          <div className={styles.invoiceMeta}>
            {String(latestInvoice.period_start || '').slice(0, 10)} to{' '}
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

      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Type in the name of the game, creator ID or player ID"
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

      <div className={`${styles.filterRow} ${styles.stakesRow}`} role="tablist" aria-label="Stakes">
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
        {loading && !snapshot && (
          <>
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
          </>
        )}

        {error && <div className={`${styles.state} ${styles.error}`}>{error}</div>}

        {!loading && !error && snapshot && snapshot.rows.length === 0 && (
          <div className={styles.state}>No games in this period.</div>
        )}

        {!error && snapshot?.rows.map((row) => {
          const started = row.started_at ? new Date(row.started_at) : null;
          const hhmm = started
            ? `${String(started.getUTCHours()).padStart(2, '0')}:${String(started.getUTCMinutes()).padStart(2, '0')}`
            : '--:--';
          const ddmm = started
            ? `${String(started.getUTCDate()).padStart(2, '0')}/${String(started.getUTCMonth() + 1).padStart(2, '0')}`
            : '';
          const idLabel = row.creator_name || (row.creator_id ? row.creator_id.slice(0, 8) : row.id.slice(0, 8));

          return (
            <div className={styles.row} key={`${row.kind}-${row.id}`}>
              <div className={styles.rowTime}>
                <div className={styles.rowTimeMain}>{hhmm}</div>
                <div className={styles.rowTimeSub}>{ddmm}</div>
              </div>

              <div className={styles.avatarWrap}>
                {row.creator_avatar ? (
                  <img className={styles.avatar} src={row.creator_avatar} alt="" loading="lazy" />
                ) : (
                  <div className={styles.avatarFallback} aria-hidden="true">
                    {(row.name || '?').slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className={styles.rowId} title={idLabel}>{idLabel}</div>
              </div>

              <div className={styles.rowMain}>
                <div className={styles.rowName} title={row.name}>{row.name}</div>
                <div className={styles.rowTags}>
                  {row.rake_percent !== null && (
                    <span className={styles.rakePct}>{Number(row.rake_percent)}%</span>
                  )}
                  <span className={badgeClass(row)}>{row.kind === 'CASH' ? row.variant : row.kind}</span>
                </div>
                {row.blinds && <div className={styles.rowBlinds}>Blinds: {row.blinds}</div>}
                {!row.blinds && row.players > 0 && (
                  <div className={styles.rowBlinds}>{compactInt(row.players)} players</div>
                )}
              </div>

              <div className={styles.rowFee}>
                <div className={styles.rowFeeValue}>{money(row.fee)}</div>
                <div className={styles.rowFeeLabel}>Fee</div>
                <div className={`${styles.rowWin} ${row.winnings < 0 ? styles.neg : styles.pos}`}>
                  {money(row.winnings)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {snapshot && (
        <div className={styles.footNote}>
          {clubName ? `${clubName} - ` : ''}
          showing {snapshot.rows.length} of {compactInt(snapshot.row_count)} games
          {snapshot.data_updated_at
            ? ` - cash data updated ${new Date(snapshot.data_updated_at).toLocaleTimeString()}`
            : ''}
        </div>
      )}
    </div>
  );
}

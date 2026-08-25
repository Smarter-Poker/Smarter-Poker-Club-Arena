/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LOBBY TABLE — dense, line-based game browser (Club Arena Lobby V2)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Replaces the large card grid with a professional desktop-poker-client table:
 * sticky headers, compact sortable rows, per-category columns, keyboard
 * navigation, and explicit row states. Selecting a row NEVER joins or spends —
 * it opens the game lobby panel where the player commits explicitly.
 *
 * Sorting always uses the underlying numeric values on LobbyEntry
 * (stakesValue / buyInValue / startValue), never the formatted strings.
 */

import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import type { LobbyEntry, LobbyStatusKey, LobbyTournamentRow } from './lobbyEntries';
import { mttPhaseText, mttTitleLine } from './lobbyEntries';
import { prefetchIntent } from '../../utils/ChunkPreloader';
import './LobbyTable.css';

type SortDir = 'asc' | 'desc';

export type LobbyCategory = 'ALL' | 'HOLDEM' | 'OMAHA' | 'LIMIT' | 'MIXED' | 'MTT' | 'SNG' | 'SPIN';

/* Remembered column sort, per club and per category. A player who sorts by
   Stakes lost it the moment they looked at another tab and came back, which
   on a lobby this dense is the sort of small forgetting that makes a screen
   feel like it is not listening. Storage failures are silent: the sort still
   works for the session, only the memory of it is lost. */
const SORT_KEY = (clubId: string | undefined, category: string) =>
  `ca_lobby_sort_${clubId || 'any'}_${category}`;

function readSort(
  clubId: string | undefined,
  category: string
): { key: string; dir: SortDir } | null {
  try {
    const raw = localStorage.getItem(SORT_KEY(clubId, category));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { key?: unknown; dir?: unknown };
    if (typeof parsed?.key !== 'string') return null;
    if (parsed.dir !== 'asc' && parsed.dir !== 'desc') return null;
    return { key: parsed.key, dir: parsed.dir };
  } catch {
    return null;
  }
}

/**
 * The order a tab opens in when the player has never sorted it themselves.
 *
 * Dan 2026-08-23: "SPINS NEED TO BE ORGANIZED BY BUY IN AMOUNT BY DEFAULT, LOW
 * TO HIGH." Spins arrive from the recycler in creation order, which is
 * effectively random — 25, then 1, then 100 — so the cheapest game, the one a
 * new player is looking for, could be anywhere in a list of thirty. Buy-in
 * ascending is the only order that means anything on a tab where every row is
 * the same game at a different price.
 */
function defaultSortFor(category: string): { key: string; dir: SortDir } | null {
  if (category === 'SPIN' || category === 'SNG') return { key: 'buyin', dir: 'asc' };
  return null;
}

function writeSort(
  clubId: string | undefined,
  category: string,
  sort: { key: string; dir: SortDir } | null
) {
  try {
    if (sort) localStorage.setItem(SORT_KEY(clubId, category), JSON.stringify(sort));
    else localStorage.removeItem(SORT_KEY(clubId, category));
  } catch {
    /* quota or private mode - the sort still applies for this session */
  }
}

export interface LobbyRowContext {
  waitlistedIds: Set<string>;
  seatedIds: Set<string>;
  registeredIds: Set<string>;
  favoriteIds: Set<string>;
  /* Dan 2026-08-24: every card carries its own action. These are optional so
     any other surface can keep rendering the table read-only — a card with no
     handler simply shows no button rather than a dead one. */
  onRegister?: (e: LobbyEntry) => void;
  onJoinTable?: (e: LobbyEntry) => void;
  onViewTable?: (e: LobbyEntry) => void;
  onToggleFavorite?: (tableId: string, next: boolean) => void;
}

interface ColumnDef {
  key: string;
  label: string;
  /* Dan 2026-08-24: "FOR TOURNAMENTS IT SHOULD SAY BUY-IN, NOT STAKES." The
     ALL tab's cost column renders a stake for a cash game and a buy-in for a
     tournament out of the same cell, so one static heading is wrong for half
     the rows. On a phone the header row is gone and this label is printed on
     the card itself, which makes the mismatch visible rather than merely
     imprecise. */
  labelFor?: (e: LobbyEntry) => string;
  className?: string;
  hideOnMobile?: boolean;
  sortable?: boolean;
  sortValue?: (e: LobbyEntry) => number | string;
  render: (e: LobbyEntry, ctx: LobbyRowContext) => React.ReactNode;
}

// ─── Cell renderers ────────────────────────────────────────────────────────
const RULE_ABBR: Record<string, string> = {
  rit: 'RIT',
  insurance: 'INS',
  straddle: 'STR',
  bomb: 'BOMB',
  ante: 'ANTE',
  double_board: '2BRD',
  seven_deuce: '72',
  time_bank: 'TB',
  vpip: 'VPIP',
  call_time: 'CT',
  no_rathole: 'NR',
};

function RulesCell({ entry }: { entry: LobbyEntry }) {
  const shown = entry.rules;
  const hidden: typeof entry.rules = [];
  const extra = hidden.length;
  if (shown.length === 0) return <span className="lt-dim">-</span>;
  return (
    <span className="lt-rules">
      {shown.map((r) => (
        <abbr key={r.key} title={r.tip} className="lt-rule">
          {r.label}
        </abbr>
      ))}
      {/* "+2" used to be the end of the sentence: the player could see that
          something was hidden and had no way to learn what without opening the
          game. It names them now, and the panel still lists all of them with
          full explanations. */}
      {extra > 0 && (
        <abbr
          className="lt-rule lt-rule--more"
          title={`Also: ${hidden.map((r) => r.label).join(', ')}`}
        >
          +{extra}
        </abbr>
      )}
    </span>
  );
}

function LiveCountdown({ time }: { time: string | number | Date }) {
  const [mins, setMins] = useState(() =>
    Math.max(0, Math.floor((new Date(time).getTime() - Date.now()) / 60000))
  );

  useEffect(() => {
    const t = new Date(time).getTime();
    if (isNaN(t)) return;
    const update = () => {
      setMins(Math.max(0, Math.floor((t - Date.now()) / 60000)));
    };
    update();
    const interval = setInterval(update, 10000); // Check every 10s to ensure it updates close to the minute mark
    return () => clearInterval(interval);
  }, [time]);

  if (isNaN(mins) || mins <= 0 || mins > 60) return null;
  return (
    <span
      className="lt-countdown"
      style={{
        fontSize: '0.65rem',
        color: 'var(--text-secondary, #c8ccd4)',
        fontWeight: 700,
        marginRight: '8px',
        letterSpacing: '0.02em',
      }}
    >
      Starts In {mins} Min...
    </span>
  );
}

/**
 * ONE interval for every countdown in the table (Dan 2026-08-24: 30+ MTT
 * rows each ran their own setInterval — 30 timers ticking a second apart,
 * so adjacent countdowns visibly disagreed). All subscribers now fire from
 * the same tick: one timer, all clocks in step. The interval starts with
 * the first subscriber and dies with the last.
 */
const tickSubscribers = new Set<() => void>();
let tickInterval: ReturnType<typeof setInterval> | null = null;
function useSharedSecondTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const cb = () => setNow(Date.now());
    tickSubscribers.add(cb);
    if (tickInterval == null)
      tickInterval = setInterval(() => {
        tickSubscribers.forEach((f) => f());
      }, 1000);
    return () => {
      tickSubscribers.delete(cb);
      if (tickSubscribers.size === 0 && tickInterval != null) {
        clearInterval(tickInterval);
        tickInterval = null;
      }
    };
  }, []);
  return now;
}

/**
 * Second line of an MTT title (Dan 2026-08-23): Guarantee, the scheduled
 * start clock time, and a live seconds countdown — "Starting In 17:33..."
 * before the cards are in the air, or how long LATE REGISTRATION has left
 * once they are (level-based windows tick too, computed from the blind
 * structure). The phrase itself is mttPhaseText in lobbyEntries — pure and
 * pinned by tests.
 */
function MttTitleMeta({ entry }: { entry: LobbyEntry }) {
  const now = useSharedSecondTick();

  const startMs = entry.startTime ? new Date(entry.startTime).getTime() : NaN;
  const startClock = Number.isFinite(startMs)
    ? new Date(startMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : null;
  const phase = mttPhaseText(entry, now);

  const parts: { node: React.ReactNode; cls?: string }[] = [];
  if (entry.guaranteeLabel)
    parts.push({
      node: <span className="lt-name__gtd">{entry.guaranteeLabel}</span>,
    });
  /* The clock part carries its own class: on phones it is the piece the
     meta line sheds (the countdown is the information; the wall-clock time
     is recoverable from the panel once the row is opened). */
  if (startClock) parts.push({ node: startClock, cls: 'lt-name__clockpart' });
  if (phase) parts.push({ node: <span className="lt-name__phase">{phase}</span> });
  if (parts.length === 0) return null;

  return (
    <span className="lt-name__meta">
      {parts.map((p, i) => (
        <span key={i} className={`lt-name__metapart${p.cls ? ` ${p.cls}` : ''}`}>
          {i > 0 && (
            <span className="lt-name__sep" aria-hidden="true">
              {'·'}
            </span>
          )}
          {p.node}
        </span>
      ))}
    </span>
  );
}

export function LobbyStatusBadge({ status, label }: { status: LobbyStatusKey; label: string }) {
  return <span className={`lt-status lt-status--${status}`}>{label}</span>;
}

function PlayerStateChip({ entry, ctx }: { entry: LobbyEntry; ctx: LobbyRowContext }) {
  if (entry.kind === 'cash') {
    if (ctx.seatedIds.has(entry.id)) return <span className="lt-mine">Seated</span>;
    if (ctx.waitlistedIds.has(entry.id))
      return <span className="lt-mine lt-mine--wait">Waitlisted</span>;
    return null;
  }
  if (ctx.registeredIds.has(entry.id)) return <span className="lt-mine">Registered</span>;
  return null;
}

function StartsCell({ entry }: { entry: LobbyEntry }) {
  if (!entry.startTime) return <span className="lt-dim">When Full</span>;
  const d = new Date(entry.startTime);
  if (!Number.isFinite(d.getTime())) return <span className="lt-dim">-</span>;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return <span>{time}</span>;
  return (
    <span>
      {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} {time}
    </span>
  );
}

function SeatsMeter({ entry }: { entry: LobbyEntry }) {
  const pct =
    entry.capacity > 0 ? Math.min(100, Math.round((entry.players / entry.capacity) * 100)) : 0;
  const full = entry.capacity > 0 && entry.players >= entry.capacity;
  return (
    <span className={`lt-seats${full ? ' lt-seats--full' : ''}`}>
      <span className="lt-seats__num">
        {entry.players}/{entry.capacity || '-'}
      </span>
      <span className="lt-seats__bar" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function FavCell({ entry, ctx }: { entry: LobbyEntry; ctx: LobbyRowContext }) {
  if (entry.kind !== 'cash' || !ctx.onToggleFavorite) return <span className="lt-dim" />;
  const isFav = ctx.favoriteIds.has(entry.id);
  return (
    <button
      type="button"
      className={`lt-fav${isFav ? ' is-on' : ''}`}
      aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
      aria-pressed={isFav}
      title={isFav ? 'Remove From Favorites' : 'Add To Favorites'}
      onClick={(e) => {
        e.stopPropagation();
        ctx.onToggleFavorite?.(entry.id, !isFav);
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9L12 2.6z"
          fill={isFav ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    </button>
  );
}

// ─── Column sets per category ──────────────────────────────────────────────
const COL_FAV: ColumnDef = {
  key: 'fav',
  label: '',
  className: 'lt-col-fav',
  render: (e, ctx) => <FavCell entry={e} ctx={ctx} />,
};
const COL_NAME: ColumnDef = {
  key: 'name',
  label: 'Game',
  className: 'lt-col-name',
  sortable: true,
  sortValue: (e) => (e.name || '').toLowerCase(),
  render: (e) =>
    e.kind === 'mtt' ? (
      /* Dan 2026-08-23: MTT titles are two lines — name + variation on top,
         guarantee / start clock / live countdown (or late-reg time left)
         underneath. The guarantee lives in the title now, not only in its
         own column. */
      <span className="lt-name lt-name--mtt" title={mttTitleLine(e)}>
        <span className="lt-name__line1">
          {e.live && <i className="lt-live" aria-hidden="true" title="Live" />}
          {mttTitleLine(e)}
        </span>
        <MttTitleMeta entry={e} />
      </span>
    ) : (
      <span className="lt-name" title={e.name}>
        {e.live && <i className="lt-live" aria-hidden="true" title="Live" />}
        {e.name}
      </span>
    ),
};
const COL_TNAME: ColumnDef = { ...COL_NAME, label: 'Tournament Name' };
const COL_STAKES: ColumnDef = {
  key: 'stakes',
  label: 'Stakes',
  className: 'lt-col-num',
  sortable: true,
  sortValue: (e) => e.stakesValue,
  render: (e) => <span className="lt-mono">{e.stakesLabel || '-'}</span>,
};
const COL_VARIANT: ColumnDef = {
  key: 'variant',
  label: 'Variant',
  className: 'lt-col-variant',
  sortable: true,
  sortValue: (e) => e.gameLabel,
  render: (e) => (
    <abbr className="lt-variant" title={e.variantLabel}>
      {e.gameLabel}
    </abbr>
  ),
};
const COL_PLAYERS: ColumnDef = {
  key: 'players',
  label: 'Players',
  className: 'lt-col-players',
  sortable: true,
  sortValue: (e) => e.players,
  render: (e) => <SeatsMeter entry={e} />,
};
const COL_BUYIN: ColumnDef = {
  key: 'buyin',
  label: 'Buy-In',
  className: 'lt-col-num',
  sortable: true,
  sortValue: (e) => e.buyInValue,
  render: (e) => <span className="lt-mono">{e.buyInLabel}</span>,
};
const COL_GTD: ColumnDef = {
  key: 'gtd',
  label: 'Guarantee',
  className: 'lt-col-num',
  sortable: true,
  sortValue: (e) => e.guaranteeValue,
  render: (e) =>
    e.guaranteeLabel ? (
      <span className="lt-mono lt-gtd">{e.guaranteeLabel}</span>
    ) : (
      <span className="lt-dim">-</span>
    ),
};
const COL_RULES: ColumnDef = {
  key: 'rules',
  label: 'Rules',
  className: 'lt-col-rules',
  render: (e) => <RulesCell entry={e} />,
};
const COL_STARTS: ColumnDef = {
  key: 'starts',
  label: 'Starting Time',
  className: 'lt-col-starts',
  sortable: true,
  sortValue: (e) => e.startValue,
  render: (e) => <StartsCell entry={e} />,
};
const COL_SPEED: ColumnDef = {
  key: 'speed',
  label: 'Speed',
  className: 'lt-col-speed',
  sortable: true,
  sortValue: (e) => e.speedLabel || '',
  render: (e) => (e.speedLabel ? <span>{e.speedLabel}</span> : <span className="lt-dim">-</span>),
};
/** Joinable-first lobby order - not the alphabet ('closed' before 'open'
    told the player the dead games mattered most). */
const STATUS_RANK: Record<LobbyStatusKey, number> = {
  open: 0,
  starting_soon: 1,
  registering: 2,
  late_reg: 3,
  running: 4,
  waitlist: 5,
  full: 6,
  closed: 7,
  completed: 8,
};
const COL_STATUS: ColumnDef = {
  key: 'status',
  label: 'Status',
  className: 'lt-col-status',
  sortable: true,
  sortValue: (e) => STATUS_RANK[e.status] ?? 9,
  render: (e, ctx) => (
    <span className="lt-statuscell">
      {/* MTTs carry a live seconds countdown in their two-line title now;
          repeating a coarser minutes one here would just disagree with it. */}
      {e.kind !== 'cash' &&
        e.kind !== 'mtt' &&
        ['registering', 'starting_soon'].includes(e.status) &&
        e.startTime && <LiveCountdown time={e.startTime} />}
      <LobbyStatusBadge status={e.status} label={e.statusLabel} />
      <PlayerStateChip entry={e} ctx={ctx} />
    </span>
  ),
};
const COL_KIND: ColumnDef = {
  key: 'kind',
  label: 'Type',
  className: 'lt-col-kind',
  sortable: true,
  sortValue: (e) => e.kind,
  render: (e) => (
    <span className="lt-kind">
      {e.kind === 'cash'
        ? 'Cash'
        : e.kind === 'mtt'
          ? 'MTT'
          : e.kind === 'spin'
            ? 'Spin'
            : 'Heads Up'}
    </span>
  ),
};
const COL_COST: ColumnDef = {
  key: 'cost',
  /* Dan 2026-08-24: the ALL tab's cost column is titled just "Stakes". */
  label: 'Stakes',
  labelFor: (e) => (e.kind === 'cash' ? 'Stakes' : 'Buy-In'),
  className: 'lt-col-num',
  sortable: true,
  sortValue: (e) => (e.kind === 'cash' ? e.stakesValue : e.buyInValue),
  render: (e) => (
    <span className="lt-mono">{e.kind === 'cash' ? e.stakesLabel : e.buyInLabel}</span>
  ),
};

/* ── THE ACTION CELL ────────────────────────────────────────────────────────
   Dan 2026-08-24: "EVERY CARD SHOULD HAVE A REGISTER BUTTON. CASH GAMES
   SHOULD HAVE VIEW TABLE AND JOIN TABLE. SPINS AND HEADS UP SHOULD HAVE SIT
   DOWN."

   What each button DOES is deliberately the existing platform flow, not a new
   one: Register calls the same registration the panel calls, Join Table the
   same navigation, View Table opens the game lobby panel. A lobby card is the
   worst possible place to invent a second way to spend money.

   A heads-up table is a cash game with two seats, so it is detected from the
   capacity rather than from a category the entry does not carry. */
/* Dan 2026-08-24: "IT SHOULD ALSO HAVE THE STARTING STACK AND CURRENT BLIND
   LEVELS." Both live on the tournament row already — starting_chips is set at
   creation, and current_level plus blind_structure are what the clock runs
   on — they were simply never surfaced outside the tournament screen. A card
   for a game you have not entered yet is exactly where they answer "is this
   the game I want": a 20,000 stack and a level-1 clock is a different
   proposition from a 20,000 stack at level 9. */
function blindsForLevel(t: LobbyTournamentRow): string | null {
  if (!t.blind_structure || !t.current_level) return null;
  try {
    const levels = JSON.parse(t.blind_structure) as Array<{
      level?: number;
      smallBlind?: number;
      bigBlind?: number;
    }>;
    const lv = levels.find((l) => l.level === t.current_level) || levels[t.current_level - 1];
    if (!lv?.smallBlind || !lv?.bigBlind) return null;
    return `${lv.smallBlind.toLocaleString()}/${lv.bigBlind.toLocaleString()}`;
  } catch {
    return null;
  }
}

const COL_TSTATS: ColumnDef = {
  key: 'tstats',
  label: 'Stack',
  className: 'lt-col-tstats',
  render: (e) => {
    if (e.kind === 'cash') return null;
    const t = e.raw as LobbyTournamentRow;
    const stack = t.starting_chips ? t.starting_chips.toLocaleString() : null;
    const blinds = blindsForLevel(t);
    if (!stack && !blinds) return null;
    return (
      <span className="lt-tstats">
        {stack && (
          <span className="lt-tstat">
            <span className="lt-tstat__k">Stack</span>
            <span className="lt-tstat__v">{stack}</span>
          </span>
        )}
        {blinds && (
          <span className="lt-tstat">
            <span className="lt-tstat__k">Level {t.current_level}</span>
            <span className="lt-tstat__v">{blinds}</span>
          </span>
        )}
      </span>
    );
  },
};

const COL_ACTIONS: ColumnDef = {
  key: 'actions',
  label: '',
  className: 'lt-col-actions',
  render: (e, ctx) => {
    const stop = (fn?: (x: LobbyEntry) => void) => (ev: React.MouseEvent) => {
      ev.stopPropagation();
      fn?.(e);
    };

    if (e.kind === 'cash') {
      const seated = ctx.seatedIds.has(e.id);
      const headsUp = e.capacity === 2;
      return (
        <span className="lt-actions">
          {ctx.onViewTable && (
            <button type="button" className="lt-act lt-act--ghost" onClick={stop(ctx.onViewTable)}>
              View Table
            </button>
          )}
          {ctx.onJoinTable && (
            <button
              type="button"
              className="lt-act lt-act--primary"
              onClick={stop(ctx.onJoinTable)}
            >
              {seated ? 'Return To Table' : headsUp ? 'Sit Down' : 'Join Table'}
            </button>
          )}
        </span>
      );
    }

    if (e.kind === 'spin' || e.kind === 'sng') {
      return (
        <span className="lt-actions">
          {ctx.onRegister && (
            <button type="button" className="lt-act lt-act--primary" onClick={stop(ctx.onRegister)}>
              Sit Down
            </button>
          )}
        </span>
      );
    }

    const registered = ctx.registeredIds.has(e.id);
    return (
      <span className="lt-actions">
        {ctx.onViewTable && (
          <button type="button" className="lt-act lt-act--ghost" onClick={stop(ctx.onViewTable)}>
            Details
          </button>
        )}
        {ctx.onRegister && (
          <button
            type="button"
            className={`lt-act ${registered ? 'lt-act--done' : 'lt-act--primary'}`}
            onClick={stop(registered ? ctx.onViewTable : ctx.onRegister)}
          >
            {registered ? 'Registered' : 'Register'}
          </button>
        )}
      </span>
    );
  },
};

export function columnsFor(category: LobbyCategory): ColumnDef[] {
  switch (category) {
    case 'HOLDEM':
    case 'OMAHA':
    case 'LIMIT':
    case 'MIXED':
      return [
        COL_FAV,
        COL_NAME,
        COL_STAKES,
        COL_VARIANT,
        COL_PLAYERS,
        COL_BUYIN,
        COL_RULES,
        COL_STATUS,
        COL_ACTIONS,
      ];
    case 'MTT':
      return [
        COL_STARTS,
        { ...COL_VARIANT, label: 'Game Type' },
        COL_BUYIN,
        COL_TNAME,
        COL_GTD,
        COL_SPEED,
        { ...COL_PLAYERS, label: 'Enrolled', hideOnMobile: true },
        COL_STATUS,
        COL_TSTATS,
        COL_RULES,
        COL_ACTIONS,
      ];
    case 'SPIN':
      /* Dan 2026-08-23: "SPEED SHOULDN'T CHANGE, ONLY THE STARTING STACK.
         BLIND LEVELS WILL ALWAYS BE THE SAME." Every Spin runs the one blind
         structure, so a Speed column is a whole column of the same word — and
         a sortable one at that, inviting a sort that can never reorder
         anything. What actually varies is the buy-in, which is already here. */
      return [COL_NAME, COL_VARIANT, COL_BUYIN, COL_PLAYERS, COL_STATUS, COL_ACTIONS];
    case 'SNG':
      return [COL_NAME, COL_VARIANT, COL_BUYIN, COL_PLAYERS, COL_STATUS, COL_ACTIONS];
    case 'ALL':
    default:
      return [
        COL_FAV,
        COL_NAME,
        COL_KIND,
        COL_VARIANT,
        COL_COST,
        COL_PLAYERS,
        COL_STARTS,
        COL_RULES,
        COL_STATUS,
        COL_TSTATS,
        COL_ACTIONS,
      ];
  }
}

// ─── The table ─────────────────────────────────────────────────────────────
interface LobbyTableProps {
  entries: LobbyEntry[];
  category: LobbyCategory;
  selectedId: string | null;
  onSelect: (entry: LobbyEntry) => void;
  /** Enter key / double click — open the game lobby (same as select; never joins). */
  onActivate: (entry: LobbyEntry) => void;
  ctx: LobbyRowContext;
  loading?: boolean;
  /** Scopes the remembered sort; omit and it is remembered globally. */
  clubId?: string;
}

export default function LobbyTable({
  entries,
  category,
  selectedId,
  onSelect,
  onActivate,
  ctx,
  loading,
  clubId,
}: LobbyTableProps) {
  const columns = useMemo(() => columnsFor(category), [category]);
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(
    () => readSort(clubId, category) ?? defaultSortFor(category)
  );
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  /* The columns change with the category, so the sort cannot carry across -
     it is restored from what this player last chose on THIS tab instead. A
     remembered key that the new column set does not define is dropped by the
     sort itself (columns.find returns undefined -> original order). */
  useEffect(
    () => setSort(readSort(clubId, category) ?? defaultSortFor(category)),
    [category, clubId]
  );

  const sorted = useMemo(() => {
    if (!sort) return entries;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return entries;
    const sv = col.sortValue;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...entries].sort((a, b) => {
      const va = sv(a);
      const vb = sv(b);
      if (typeof va === 'number' && typeof vb === 'number') {
        /* Rows with no value (cash games under a Starts sort carry Infinity)
           sort LAST in both directions - and two of them compare equal.
           The old (na - nb) * dir produced Infinity - Infinity = NaN, which
           is comparator poison: Array.sort's order becomes implementation-
           defined the moment a comparator returns NaN. */
        const aBad = !Number.isFinite(va);
        const bBad = !Number.isFinite(vb);
        if (aBad || bBad) return aBad && bBad ? 0 : aBad ? 1 : -1;
        return (va - vb) * dir;
      }
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [entries, sort, columns]);

  const handleHeaderClick = (col: ColumnDef) => {
    if (!col.sortable) return;
    setSort((prev) => {
      /**
       * TWO STATES, NOT THREE (Dan 2026-08-23: "CLICK A 3RD TIME AND ITS
       * RANDOM. REMOVE THE RANDOM ONLY HIGH AND LOW. SAME BROKEN
       * FUNCTIONALITY WHEN YOU SELECT PLAYERS.")
       *
       * The third click used to clear the sort and fall back to the page-level
       * order, which on the Spins tab is creation order — indistinguishable
       * from random. From the player's side a header they had just used twice
       * appeared to scramble the list on the third tap. A header now only ever
       * flips between ascending and descending; the way back to the unsorted
       * order is to leave the tab, not to overshoot a column.
       */
      const next: { key: string; dir: SortDir } =
        !prev || prev.key !== col.key
          ? { key: col.key, dir: 'asc' }
          : { key: col.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      writeSort(clubId, category, next);
      return next;
    });
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      /* Home/End/PageUp/PageDown are what a keyboard user reaches for in a
         list this dense - 111 rows is a lot of ArrowDown. */
      const NAV = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'];
      if (!NAV.includes(e.key) && e.key !== 'Enter') return;
      if (sorted.length === 0) return;
      const idx = sorted.findIndex((r) => r.id === selectedId);
      if (e.key === 'Enter') {
        if (idx >= 0) {
          e.preventDefault();
          onActivate(sorted[idx]);
        }
        return;
      }
      e.preventDefault();
      const last = sorted.length - 1;
      const from = idx < 0 ? 0 : idx;
      const PAGE = 10;
      const next =
        e.key === 'ArrowDown'
          ? Math.min(last, idx + 1)
          : e.key === 'ArrowUp'
            ? Math.max(0, from - 1)
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? last
                : e.key === 'PageDown'
                  ? Math.min(last, from + PAGE)
                  : Math.max(0, from - PAGE);
      onSelect(sorted[next]);
      // Keep the focused row in view inside the sticky-header scroller.
      const rowEl = bodyRef.current?.querySelector<HTMLTableRowElement>(
        `tr[data-id="${sorted[next].id}"]`
      );
      rowEl?.scrollIntoView({ block: 'nearest' });
    },
    [sorted, selectedId, onSelect, onActivate]
  );

  return (
    <div
      className="lobby-table-wrap"
      role="region"
      aria-label={`Game list, ${sorted.length} game${sorted.length === 1 ? '' : 's'}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* role=grid: aria-selected on a <tr> is only valid inside a grid, and
          without it a screen reader announces none of the selection state the
          keyboard navigation produces. */}
      {/* Sorting rearranges the whole list with no visible message and, until
          now, no audible one either: a screen-reader user pressed Enter on a
          header and nothing was announced. */}
      <span className="sr-only" role="status" aria-live="polite">
        {sort
          ? `Sorted by ${columns.find((c) => c.key === sort.key)?.label || sort.key}, ${
              sort.dir === 'asc' ? 'ascending' : 'descending'
            }`
          : 'Default order'}
      </span>
      <table className="lobby-table" role="grid">
        <thead>
          <tr>
            {columns.map((col) => {
              const active = sort?.key === col.key;
              return (
                <th
                  key={col.key}
                  className={`${col.className || ''}${col.sortable ? ' is-sortable' : ''}${active ? ' is-sorted' : ''}${col.hideOnMobile ? ' hide-on-mobile' : ''}`}
                  aria-sort={
                    active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  /* Sorting was mouse-only: a click handler on a <th> with
                     no role, no tab stop and no key handler, so keyboard and
                     screen-reader users could not sort the lobby at all. */
                  role={col.sortable ? 'columnheader' : undefined}
                  tabIndex={col.sortable ? 0 : undefined}
                  onClick={() => handleHeaderClick(col)}
                  onKeyDown={(e) => {
                    if (!col.sortable) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleHeaderClick(col);
                    }
                  }}
                >
                  <span className="lt-th">
                    {col.label}
                    {col.sortable && (
                      <span className="lt-sortmark" aria-hidden="true">
                        {active ? (sort!.dir === 'asc' ? '▴' : '▾') : '▴▾'}
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {loading &&
            entries.length === 0 &&
            Array.from({ length: 8 }).map((_, i) => (
              <tr key={`skel-${i}`} className="lt-row lt-row--skeleton" aria-hidden="true">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`${c.className || ''} ${c.hideOnMobile ? 'hide-on-mobile' : ''}`}
                  >
                    <span className="lt-skel" />
                  </td>
                ))}
              </tr>
            ))}
          {sorted.map((entry) => {
            const selected = entry.id === selectedId;
            return (
              <tr
                key={entry.id}
                data-id={entry.id}
                className={`lt-row lt-row--${entry.status}${selected ? ' is-selected' : ''}`}
                data-kind={entry.kind}
                aria-selected={selected}
                // Hover / touch / keyboard-focus on a lobby row is the earliest
                // honest signal that this table is where the player is going, so
                // start pulling the TablePage chunk now. TablePage is the single
                // heaviest chunk in the app; fetching it while the player is
                // still reading the row means the click resolves from the module
                // cache instead of stalling on the network.
                //
                // Spread FIRST so the row's own onClick/onDoubleClick below win,
                // and idempotent - repeat hovers over the same row are a no-op
                // (see ChunkPreloader.preloadRoute).
                {...prefetchIntent(`/table/${entry.id}`)}
                onClick={() => onSelect(entry)}
                onDoubleClick={() => onActivate(entry)}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    /* data-label carries the column's own heading down to the
                       cell. On a phone the header row is gone, so the card
                       layout prints it above the value — and it is always the
                       right word, which a class name could not guarantee:
                       Stakes and Buy-In share .lt-col-num. */
                    data-label={col.labelFor ? col.labelFor(entry) : col.label}
                    className={`${col.className || ''} ${col.hideOnMobile ? 'hide-on-mobile' : ''}`}
                  >
                    {col.render(entry, ctx)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

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

import { memo, useMemo, useRef, useState, useEffect, useCallback } from 'react';
import type { LobbyEntry, LobbyStatusKey, LobbyTournamentRow } from './lobbyEntries';
import { tournamentBlinds, tournamentLevel } from './tournamentFigures';
import {
  cashTitleLines,
  levelSpeedLabel,
  mttPhaseText,
  mttTitleLine,
  seatFirstJoinable,
  seatsTakenLabel,
  spinPayoutLabel,
  spinPrizeLabel,
  stackDepthLabel,
} from './lobbyEntries';
import { prefetchIntent } from '../../utils/ChunkPreloader';
import { useSpinTierAvailability } from '../../hooks/useSpinTierAvailability';
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
  /* True only when the Reserve Pool can actually pay the top Spin multiplier
     at this club right now. Undefined means "not known yet", which renders as
     no badge - an absent boast rather than a wrong one. Filled in by
     LobbyTable itself from `v_spin_tier_availability`; callers do not pass it. */
  spinTopTierLive?: boolean;
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

/* Every rule medallion is shown. `hidden` was a hard-coded empty array left
   behind when the truncation was removed, so `extra` was always 0 and the
   "+2" overflow chip below it was unreachable code guarding a tooltip that
   could never be built - along with its .lt-rule--more stylesheet rule. */
function RulesCell({ entry }: { entry: LobbyEntry }) {
  const shown = entry.rules;
  /* Nothing, not a dash. A phone card drops a cell that renders empty
     (`td:empty`), so a Spin with no traits loses the well instead of showing a
     heading called RULES with a hyphen under it. */
  if (shown.length === 0) return null;
  return (
    <span className="lt-rules">
      {shown.map((r) => (
        <abbr key={r.key} title={r.tip} className="lt-rule">
          {r.label}
        </abbr>
      ))}
    </span>
  );
}

/* LiveCountdown lived here and is deleted (2026-08-25). It rendered a coarse
   whole-minutes countdown into the status cell of any non-MTT tournament — in
   practice only Spins and Heads-Ups, which do not start on a clock at all.
   Every clock in the lobby now comes from mttPhaseText through the shared
   one-second tick below, so no two countdowns can disagree again. */

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

/**
 * ── "I AM ALREADY IN THIS GAME" ────────────────────────────────────────────
 * Dan 2026-08-25: "if a player is already at a table it should say that on the
 * lobby card, or it should be outlined or something — needs to show a player
 * is already at that table, spin, mtt or heads up table."
 *
 * It was computed, and then thrown away on exactly the cards where it matters
 * most: this chip lived inside the status cell, and the phone layout hides the
 * status cell outright on every MTT and Heads-Up card. So a player scrolling a
 * lobby on a phone could not tell a tournament they had already entered from
 * one they had not. It renders in the TITLE now — the one cell no breakpoint
 * ever hides — and `playerStateOf` also drives the row's own outline so the
 * card reads at a glance without being parsed.
 */
export type PlayerState = 'seated' | 'waitlisted' | 'registered' | null;

export function playerStateOf(entry: LobbyEntry, ctx: LobbyRowContext): PlayerState {
  if (entry.kind === 'cash') {
    if (ctx.seatedIds.has(entry.id)) return 'seated';
    if (ctx.waitlistedIds.has(entry.id)) return 'waitlisted';
    return null;
  }
  /* A Spin or Heads-Up seat is bought, not registered for, so a player who
     holds one is SEATED — but the id lands in whichever set the page fills,
     and both are true of the same game. Check both rather than pick one. */
  if (ctx.seatedIds.has(entry.id)) return 'seated';
  if (ctx.registeredIds.has(entry.id)) return 'registered';
  if (ctx.waitlistedIds.has(entry.id)) return 'waitlisted';
  return null;
}

const PLAYER_STATE_LABEL: Record<Exclude<PlayerState, null>, string> = {
  seated: 'You Are Seated',
  waitlisted: 'You Are Waitlisted',
  registered: 'You Are Registered',
};

function PlayerStateChip({ entry, ctx }: { entry: LobbyEntry; ctx: LobbyRowContext }) {
  const state = playerStateOf(entry, ctx);
  if (!state) return null;
  return (
    <span className={`lt-mine lt-mine--${state}`}>
      <i className="lt-mine__dot" aria-hidden="true" />
      {PLAYER_STATE_LABEL[state]}
    </span>
  );
}

function StartsCell({ entry }: { entry: LobbyEntry }) {
  /* A cash table has no starting time and never will — it is running now.
     "When Full" was being printed under a Starting Time heading on every cash
     card, which is a well of noise on the densest screen in the app. */
  if (entry.kind === 'cash') return null;
  /* A Spin and a Heads-Up start when the last seat is bought. The recycler
     still stamps a start_time on the row and it is always in the past, so
     printing it announced a clock time that means nothing — the same column
     that produced "Starting Soon" on a sold-out Spin before tournamentStatus
     was taught about seat-first games. */
  if (entry.kind === 'spin' || entry.kind === 'sng')
    return <span className="lt-dim">When Full</span>;
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
/**
 * "The top multiplier is live right now."
 *
 * A Spin's headline prize is the top tier on the wheel, and that tier is NOT
 * eligible to be drawn unless the Reserve Pool can already pay it - the draw
 * gates on it server-side (`eligibleSpinTiers` in config/spinSpec), so a
 * player looking at a Spin row has no way to tell whether the number that
 * sells the game is actually reachable in the next hand or locked away.
 *
 * `v_spin_tier_availability` answers exactly that one question with the same
 * arithmetic the draw uses (balance >= highest_stake * 100 * 1.5), which is
 * the whole reason the badge is allowed to make a claim at all. Unknown
 * renders as nothing: an absent boast, never a wrong one.
 */
const SPIN_TOP_MULTIPLIER = 100;

function SpinTopTierBadge() {
  const label = `${SPIN_TOP_MULTIPLIER.toLocaleString()}x Live`;
  return (
    <span className="lt-spintop" title="The Top Multiplier Is Currently Payable On This Club">
      {label}
    </span>
  );
}

const COL_NAME: ColumnDef = {
  key: 'name',
  label: 'Game',
  className: 'lt-col-name',
  sortable: true,
  sortValue: (e) => (e.name || '').toLowerCase(),
  render: (e, ctx) => {
    if (e.kind === 'mtt') {
      /* Dan 2026-08-23: MTT titles are two lines — name + variation on top,
         guarantee / start clock / live countdown (or late-reg time left)
         underneath. The guarantee lives in the title now, not only in its
         own column. */
      return (
        <span className="lt-name lt-name--mtt" title={mttTitleLine(e)}>
          <span className="lt-name__line1">
            {e.live && <i className="lt-live" aria-hidden="true" title="Live" />}
            {mttTitleLine(e)}
          </span>
          <MttTitleMeta entry={e} />
          <PlayerStateChip entry={e} ctx={ctx} />
        </span>
      );
    }

    if (e.kind === 'cash') {
      /* Dan 2026-08-25: line 1 is the game type and the stakes, line 2 is the
         table's own name — and line 2 must not be cut off by the chips beside
         it. Both lines come from cashTitleLines so the split is one rule. */
      const { headline, subtitle } = cashTitleLines(e);
      return (
        <span className="lt-name lt-name--cash" title={e.name}>
          <span className="lt-name__line1">
            {e.live && <i className="lt-live" aria-hidden="true" title="Live" />}
            {headline}
          </span>
          {subtitle && <span className="lt-name__table">{subtitle}</span>}
          <PlayerStateChip entry={e} ctx={ctx} />
        </span>
      );
    }

    return (
      <span className="lt-name lt-name--seatfirst" title={e.name}>
        <span className="lt-name__line1">
          {e.live && <i className="lt-live" aria-hidden="true" title="Live" />}
          {e.name}
        </span>
        {e.kind === 'spin' && ctx.spinTopTierLive && <SpinTopTierBadge />}
        <PlayerStateChip entry={e} ctx={ctx} />
      </span>
    );
  },
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
/* Dan 2026-08-24: "THERE ARE NO LIMITATIONS ON THE AMOUNT OF PLAYERS THAT CAN
   REGISTER — IT SHOULDN'T DEFAULT TO /500." max_players is a column every
   tournament row carries whether or not the format uses it, and printing it as
   a denominator turned a field with no meaning into a cap the player could
   read off the card. A tournament now shows what is true: how many have
   registered. Cash keeps its meter, where the denominator is a real seat
   count. */
/* ...and a Spin or a Heads-Up is the exception to the exception: it seats 3 or
   2, it STARTS when it fills, and Dan 2026-08-25 asked for the fraction by
   name — "0/3, 1/3, 2/3, 3/3" and "0/2, 1/2, 2/2". There the denominator is
   the whole point, so seatsTakenLabel prints it. */
function TournamentEnrolled({ entry }: { entry: LobbyEntry }) {
  return <span className="lt-seats__num">{seatsTakenLabel(entry)}</span>;
}

const COL_PLAYERS: ColumnDef = {
  key: 'players',
  label: 'Players',
  labelFor: (e) => (e.kind === 'cash' ? 'Players' : 'Registered'),
  className: 'lt-col-players',
  sortable: true,
  sortValue: (e) => e.players,
  render: (e) => (e.kind === 'cash' ? <SeatsMeter entry={e} /> : <TournamentEnrolled entry={e} />),
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
/* COL_SPEED is gone (2026-08-25). It printed `speedLabel`, which is the word
   "Standard" for every MTT whose creator did not type Turbo into the name, and
   "When Full" for every Spin and Heads-Up — a sortable column of one word.
   COL_FORMAT and COL_LEVELTIME answer the same question from the row's real
   starting stack and blind structure, on every tab. */
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
  /* The "you are in this game" chip used to live here and is now rendered in
     the title cell — the phone layout hides this whole cell on tournament
     cards, which is precisely where the chip mattered. See PlayerStateChip. */
  render: (e) => (
    <span className="lt-statuscell">
      {/* No countdown here any more, on any kind. An MTT carries a live
          seconds clock in its own two-line title; a Spin and a Heads-Up start
          on their last bought seat rather than at a time, so "Starts In 29
          Min..." beside a badge reading Filling was two different answers to
          the same question; and a cash game is running now. */}
      <LobbyStatusBadge status={e.status} label={e.statusLabel} />
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
/* Dan 2026-08-24: "ALWAYS KEEP BOTH STARTING STACK AND CURRENT LEVEL UP AT
   ALL TIMES." current_level is only written once a tournament starts running,
   so every card in registration showed one well and a gap. A game that has not
   dealt a hand is on level 1 by definition — that is the level it will open
   at, and it is exactly what a player deciding whether to register wants to
   read. */
/* Dan 2026-08-24: "STARTING STACK SHOULD BE IN THE HEADER AS A TITLE, NOT IN
   THE DESCRIPTION. THE STARTING STACK AMOUNT SHOULD BE CENTERED UNDER IT. NEXT
   TO STARTING STACK SHOULD BE CURRENT LEVEL WITH THE CURRENT LEVEL AND BLINDS
   LISTED CENTERED UNDER IT."

   These were one cell called "Stack" that printed its own labels inside
   itself, so the table had a heading that named neither of the two things
   underneath it and the values ran together as "Starting Stack 12,000 Level 3
   100/200". They are two independent facts a player compares across rows, and
   a column each is what makes that comparison possible: the heading says the
   word once, at the top, and every row answers it in the same place. */
const COL_TSTACK: ColumnDef = {
  key: 'tstack',
  label: 'Starting Stack',
  className: 'lt-col-tstack',
  sortable: true,
  /* Infinity, not -1 or 0. The comparator above parks every non-finite value
     LAST in both directions, which is where a row that has no starting stack
     belongs. -1 is finite, so ascending would have floated every cash game -
     the rows that print nothing in this column - to the top of the ALL tab,
     with stackless tournaments (|| 0) interleaved above them. */
  sortValue: (e) =>
    e.kind === 'cash' ? Infinity : Number((e.raw as LobbyTournamentRow).starting_chips) || Infinity,
  render: (e) => {
    if (e.kind === 'cash') return <span className="lt-dim">-</span>;
    const t = e.raw as LobbyTournamentRow;
    if (!t.starting_chips) return <span className="lt-dim">-</span>;
    return <span className="lt-mono">{Number(t.starting_chips).toLocaleString()}</span>;
  },
};

const COL_TLEVEL: ColumnDef = {
  key: 'tlevel',
  label: 'Current Level',
  className: 'lt-col-tlevel',
  sortable: true,
  sortValue: (e) => (e.kind === 'cash' ? Infinity : tournamentLevel(e.raw as LobbyTournamentRow)),
  render: (e) => {
    if (e.kind === 'cash') return <span className="lt-dim">-</span>;
    const t = e.raw as LobbyTournamentRow;
    const blinds = tournamentBlinds(t);
    /* The number alone. Printing "Level 3" under a heading that reads Current
       Level is the same cell-repeats-its-own-label problem these two columns
       were split up to remove, and on the phone card the ::before prints the
       heading in full again right above it. */
    return (
      <span className="lt-tlevel">
        <span className="lt-tlevel__n">{tournamentLevel(t)}</span>
        {blinds && <span className="lt-tlevel__b">{blinds}</span>}
      </span>
    );
  },
};

/* ── SPIN AND HEADS-UP WELLS (Dan 2026-08-25) ───────────────────────────────
   Every one of these was already true of the row and had never been asked for.
   They are ordinary columns, so the desktop board gets a heading and the phone
   card gets the same heading printed above the value from data-label — the two
   layouts cannot say different things about the same fact. */
const COL_PAYOUT: ColumnDef = {
  key: 'payout',
  label: 'Max Payout',
  className: 'lt-col-payout',
  /* NOT sortable, and the column is never given the raw number to sort by.
     Sorting a board by a multiplier that has not been revealed yet would leak
     the draw through the ORDER of the rows — the one thing utils/spinReveal
     exists to prevent. Every unrevealed Spin prints the same ceiling anyway,
     so a sort here could only ever order them by a secret. */
  render: (e) => {
    const label = spinPayoutLabel(e);
    if (!label) return null;
    /* Two lines: the ratio a player shops by, and the money it comes to at
       THIS buy-in. See spinPrizeLabel for why the second line is safe. */
    const prize = spinPrizeLabel(e);
    return (
      <span className="lt-payout">
        <span className="lt-payout__x">{label}</span>
        {prize && <span className="lt-payout__cash">{prize}</span>}
      </span>
    );
  },
};

const COL_LEVELTIME: ColumnDef = {
  key: 'leveltime',
  label: 'Blind Levels',
  className: 'lt-col-leveltime',
  render: (e) => {
    if (e.kind === 'cash') return null;
    const label = levelSpeedLabel(e.raw as LobbyTournamentRow);
    return label ? <span>{label}</span> : null;
  },
};

const COL_FORMAT: ColumnDef = {
  key: 'format',
  label: 'Format',
  className: 'lt-col-format',
  sortable: true,
  sortValue: (e) => stackDepthLabel(e) || '',
  render: (e) => {
    const label = stackDepthLabel(e);
    return label ? <span className="lt-format">{label}</span> : null;
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
      /* Dan 2026-08-25: "once a spin is running, it must show the status as
         running, where users can click and watch." A seat-first game with no
         seat left cannot be sat down at, so Sit Down there is a button that
         can only ever fail — the same reasoning that gave running MTTs a
         Watch button. A player who already holds a seat gets taken back to it. */
      const mine = playerStateOf(e, ctx) !== null;
      const noSeatLeft =
        e.status === 'running' ||
        e.status === 'completed' ||
        e.status === 'full' ||
        (e.capacity > 0 && e.players >= e.capacity);

      if (mine || noSeatLeft) {
        return (
          <span className="lt-actions">
            {ctx.onViewTable && (
              <button
                type="button"
                className={`lt-act ${mine ? 'lt-act--done' : 'lt-act--primary'}`}
                onClick={stop(ctx.onViewTable)}
              >
                {mine ? 'Return To Game' : 'Watch'}
              </button>
            )}
          </span>
        );
      }

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

    /* A tournament past late registration is still worth opening — Dan
       2026-08-24: "people can click and watch and see the events finish up."
       It cannot be entered, so offering Register would be a button that only
       ever fails. Watch says what the tap actually does. */
    const closedToEntry = e.status === 'running' || e.status === 'completed';

    return (
      <span className="lt-actions">
        {ctx.onViewTable && (
          <button type="button" className="lt-act lt-act--ghost" onClick={stop(ctx.onViewTable)}>
            Details
          </button>
        )}
        {ctx.onRegister && !closedToEntry && (
          <button
            type="button"
            className={`lt-act ${registered ? 'lt-act--done' : 'lt-act--primary'}`}
            onClick={stop(registered ? ctx.onViewTable : ctx.onRegister)}
          >
            {registered ? 'Registered' : 'Register'}
          </button>
        )}
        {closedToEntry && ctx.onViewTable && (
          <button type="button" className="lt-act lt-act--primary" onClick={stop(ctx.onViewTable)}>
            {registered ? 'Return To Game' : 'Watch'}
          </button>
        )}
      </span>
    );
  },
};

/* ── ONE ROW, MEMOISED ──────────────────────────────────────────────────────
   The lobby renders up to 111 rows and re-renders on every realtime tick, every
   filter keystroke and every seat change. Inline in the parent, each row rebuilt
   its own click handlers and re-ran `col.render` for every cell on every one of
   those - so a single seat count changing on one table repainted the whole
   board.

   Memoising only pays if the PROPS are stable, which is why two other things
   had to change with it: `ctx` is now a useMemo in ClubHomePage (it was an
   object literal in the JSX, new on every render), and `prefetchIntent` caches
   its handler set per path (it allocated three closures per call). Without
   either of those this wrapper would skip nothing.

   `onSelect` / `onActivate` are taken as-is and called with the entry, so no
   per-row closure is created here either. */
const LobbyRow = memo(function LobbyRow({
  entry,
  columns,
  ctx,
  selected,
  onSelect,
  onActivate,
}: {
  entry: LobbyEntry;
  columns: ColumnDef[];
  ctx: LobbyRowContext;
  selected: boolean;
  onSelect: (e: LobbyEntry) => void;
  onActivate: (e: LobbyEntry) => void;
}) {
  /* The outline half of Dan's 2026-08-25 request. The chip in the title names
     the state; this makes the card findable in a scroll of thirty without
     reading any of them. It is derived here rather than passed in so the
     memoised row recomputes it exactly when `ctx` changes, which is the same
     moment the chip above it changes. */
  const mine = playerStateOf(entry, ctx);
  return (
    <tr
      data-id={entry.id}
      className={`lt-row lt-row--${entry.status}${selected ? ' is-selected' : ''}${mine ? ' is-mine' : ''}`}
      data-kind={entry.kind}
      data-mine={mine || undefined}
      role="row"
      aria-selected={selected}
      // Hover / touch / keyboard-focus on a lobby row is the earliest honest
      // signal that this table is where the player is going, so start pulling
      // the TablePage chunk now. TablePage is the single heaviest chunk in the
      // app; fetching it while the player is still reading the row means the
      // click resolves from the module cache instead of stalling on the
      // network.
      //
      // Spread FIRST so the row's own onClick/onDoubleClick below win, and
      // idempotent - repeat hovers over the same row are a no-op (see
      // ChunkPreloader.preloadRoute).
      {...prefetchIntent(`/table/${entry.id}`)}
      onClick={() => onSelect(entry)}
      onDoubleClick={() => onActivate(entry)}
    >
      {columns.map((col) => (
        <td
          key={col.key}
          role="gridcell"
          /* data-label carries the column's own heading down to the cell. On a
             phone the header row is gone, so the card layout prints it above
             the value — and it is always the right word, which a class name
             could not guarantee: Stakes and Buy-In share .lt-col-num. */
          data-label={col.labelFor ? col.labelFor(entry) : col.label}
          className={`${col.className || ''} ${col.hideOnMobile ? 'hide-on-mobile' : ''}`}
        >
          {col.render(entry, ctx)}
        </td>
      ))}
    </tr>
  );
});

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
      /* Dan 2026-08-25: "THAT SHOULD BE THE FIRST LINE DISPLAYED." The title
         led no board here - it sat fourth, behind Starting Time, Game Type and
         Buy-In, which are all facts ABOUT a tournament and answer nothing until
         you know which tournament they describe. It leads now, and on every
         other tab the name already sits first behind the favourite star. */
      return [
        COL_TNAME,
        COL_STARTS,
        { ...COL_VARIANT, label: 'Game Type' },
        COL_BUYIN,
        COL_GTD,
        /* COL_SPEED read `speedLabel`, which for an MTT is the word "Standard"
           unless the creator typed Turbo into the name. COL_FORMAT measures
           the same question off the starting stack and the level-1 big blind,
           and COL_LEVELTIME says how long a level actually runs — so the MTT
           card now answers speed the same way the Spin and Heads-Up cards do,
           out of the same two helpers. */
        { ...COL_PLAYERS, label: 'Enrolled', hideOnMobile: true },
        COL_STATUS,
        COL_TSTACK,
        COL_TLEVEL,
        COL_LEVELTIME,
        COL_FORMAT,
        COL_RULES,
        COL_ACTIONS,
      ];
    case 'SPIN':
      /* Dan 2026-08-23: "SPEED SHOULDN'T CHANGE, ONLY THE STARTING STACK.
         BLIND LEVELS WILL ALWAYS BE THE SAME." Every Spin runs the one blind
         structure, so a Speed column is a whole column of the same word — and
         a sortable one at that, inviting a sort that can never reorder
         anything. What actually varies is the buy-in, which is already here.

         Dan 2026-08-25 added the four facts that DO distinguish one Spin from
         another and had never been printed: what it can pay, how deep it
         starts, how fast the clock runs, and how many of the three seats are
         gone. The level clock is still identical across the ladder — it is
         here because a player who has never opened a Spin has no way to know
         that, not because it varies. */
      return [
        COL_NAME,
        COL_VARIANT,
        COL_BUYIN,
        COL_PAYOUT,
        COL_PLAYERS,
        COL_TSTACK,
        COL_LEVELTIME,
        COL_FORMAT,
        COL_STATUS,
        COL_ACTIONS,
      ];
    case 'SNG':
      return [
        COL_NAME,
        COL_VARIANT,
        COL_BUYIN,
        COL_PLAYERS,
        COL_TSTACK,
        COL_LEVELTIME,
        COL_FORMAT,
        COL_STATUS,
        COL_ACTIONS,
      ];
    case 'ALL':
    default:
      /* Dan 2026-08-25: "it looks like we have two different cards, one for
         'all field' and one for 'MTT' field ... optimize this one and use it
         for both fields." A card is only one card if it answers the same
         questions wherever it appears, so the ALL tab now carries every well
         the dedicated tabs carry. A cell with nothing to say renders empty and
         the phone layout drops it (`td:empty`), so a cash row does not grow a
         hollow Max Payout well — the SHAPE is shared, not the emptiness. */
      return [
        COL_FAV,
        COL_NAME,
        COL_KIND,
        COL_VARIANT,
        COL_COST,
        COL_PAYOUT,
        COL_PLAYERS,
        COL_STARTS,
        COL_RULES,
        COL_STATUS,
        COL_TSTACK,
        COL_TLEVEL,
        COL_LEVELTIME,
        COL_FORMAT,
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

  /* One fetch per lobby, shared by every Spin row (the hook is module-cached
     with a 60s TTL). `clubId` here is the resolved club UUID; when the page
     has only the slug the lookup simply misses and no row is badged. */
  const spinTiers = useSpinTierAvailability(clubId);
  const rowCtx = useMemo<LobbyRowContext>(
    () => ({ ...ctx, spinTopTierLive: spinTiers?.can_draw_100x === true }),
    [ctx, spinTiers]
  );

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

  /* Dan 2026-08-25: a Spin or Heads-Up with every seat gone "NEEDS TO BE
     DROPPED TO THE BOTTOM OF THE RESULTS". This is applied AFTER whatever sort
     the player chose and is deliberately not a column: no ordering of buy-in,
     seats or status should ever float a game nobody can enter back up between
     two they can. Array.prototype.sort is stable in every engine we ship to,
     so the chosen order survives inside each partition. */
  const sink = useCallback(
    (rows: LobbyEntry[]) =>
      rows.some((r) => !seatFirstJoinable(r))
        ? [...rows].sort((a, b) => Number(!seatFirstJoinable(a)) - Number(!seatFirstJoinable(b)))
        : rows,
    []
  );

  const sorted = useMemo(() => {
    if (!sort) return sink(entries);
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return sink(entries);
    const sv = col.sortValue;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return sink(
      [...entries].sort((a, b) => {
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
      })
    );
  }, [entries, sort, columns, sink]);

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
          {/* The explicit row/gridcell roles below are not redundant. Under
              640px this table stops being a table - thead/tbody/tr/td all
              become block or flex boxes so each row can be a card - and a
              browser drops the implicit table roles the moment `display` is
              not a table value. role="grid" on the ancestor does not put them
              back, so on every phone the grid contained no rows and the
              aria-selected state below was attached to nothing. */}
          <tr role="row">
            {columns.map((col) => {
              const active = sort?.key === col.key;
              return (
                <th
                  key={col.key}
                  className={`${col.className || ''}${col.sortable ? ' is-sortable' : ''}${active ? ' is-sorted' : ''}${col.hideOnMobile ? ' hide-on-mobile' : ''}`}
                  /* A sortable column that is not the active sort announces
                     "none", which is what tells a screen reader it CAN be
                     sorted. Leaving it undefined named only the one column
                     already sorted, so the other nine looked inert. */
                  aria-sort={
                    active
                      ? sort!.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : col.sortable
                        ? 'none'
                        : undefined
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
              <tr
                key={`skel-${i}`}
                className="lt-row lt-row--skeleton"
                aria-hidden="true"
                role="row"
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    role="gridcell"
                    className={`${c.className || ''} ${c.hideOnMobile ? 'hide-on-mobile' : ''}`}
                  >
                    <span className="lt-skel" />
                  </td>
                ))}
              </tr>
            ))}
          {sorted.map((entry) => (
            <LobbyRow
              key={entry.id}
              entry={entry}
              columns={columns}
              ctx={rowCtx}
              selected={entry.id === selectedId}
              onSelect={onSelect}
              onActivate={onActivate}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

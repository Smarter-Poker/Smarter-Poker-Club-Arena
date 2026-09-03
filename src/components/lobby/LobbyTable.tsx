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
  SPIN_MAX_MULTIPLIER,
  spinPayoutLabel,
  spinPrizeLabel,
  stackDepthLabel,
  stackFormatRank,
} from './lobbyEntries';
import { prefetchIntent } from '../../utils/ChunkPreloader';
import { useSpinTierAvailability } from '../../hooks/useSpinTierAvailability';
import { ArenaLobbyGameCard } from './game-cards';
import {
  lobbyPlayerStateOf as playerStateOf,
  type LobbyPlayerState as PlayerState,
  type LobbyRowContext,
} from './lobbyCardContext';
export type { LobbyRowContext } from './lobbyCardContext';
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
  sortable?: boolean;
  sortValue?: (e: LobbyEntry) => number | string;
  render: (e: LobbyEntry, ctx: LobbyRowContext) => React.ReactNode;
}

// ─── Cell renderers ────────────────────────────────────────────────────────

/* RulesCell lived here and is deleted (2026-08-25). Dan: "FOR RULES, REMOVE IT
   FROM THE MAIN SCREEN BUT MAKE SURE ALL RULES AND TAGS ARE ON THE LOBBY
   SCREEN WHEN YOU CLICK THE GAME." The medallions were a row of abbreviations
   that had to be hovered to mean anything, on the one surface that has no
   hover on half its traffic. GameLobbyPanel already renders every one of them
   with its full sentence - `entry.rules` is unchanged and still computed by
   cashRuleMedallions / tournamentMedallions - so nothing is lost by taking the
   abbreviations off the board, and 168px goes back to the games themselves. */

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
function useSharedSecondTick(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
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
  }, [active]);
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
  /* A completed or cancelled tournament has a STATIC phrase — mttPhaseText
     returns its terminal label — so subscribing it to the 1 Hz tick
     re-rendered one component per such row, every second, forever. */
  const isTicking = entry.status !== 'completed' && entry.status !== 'closed';
  const now = useSharedSecondTick(isTicking);

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
  /* null, not an empty span: a non-empty cell defeats `td:empty` and reserves
     34px on every tournament row. */
  if (entry.kind !== 'cash' || !ctx.onToggleFavorite) return null;
  const isFav = ctx.favoriteIds.has(entry.id);
  return (
    <button
      type="button"
      className={`lt-fav${isFav ? ' is-on' : ''}`}
      aria-label={isFav ? 'Remove From Favorites' : 'Add To Favorites'}
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
/**
 * The literal stays, because the availability view's column is literally named
 * `can_draw_100x` — the badge and the column have to agree, and a value
 * derived from SPIN_TIERS could silently stop matching a hard-coded SQL name.
 *
 * The assertion beside it is what makes that safe: if the ladder's top tier
 * ever moves, this throws at import rather than letting the badge quietly
 * advertise a multiplier the view is not asking about. The 500x retirement is
 * the precedent that this number changes.
 */
const SPIN_TOP_MULTIPLIER = 100;
if (SPIN_TOP_MULTIPLIER !== SPIN_MAX_MULTIPLIER) {
  throw new Error(
    `Spin top tier moved to ${SPIN_MAX_MULTIPLIER}x: update SPIN_TOP_MULTIPLIER and the ` +
      `can_draw_${SPIN_TOP_MULTIPLIER}x column in v_spin_tier_availability together.`
  );
}

function SpinTopTierBadge() {
  const label = `${SPIN_TOP_MULTIPLIER.toLocaleString()}x Live`;
  return (
    <span className="lt-spintop" title="The Top Multiplier Is Currently Payable On This Club">
      {label}
    </span>
  );
}

/**
 * NEW / VIP / FEATURED, from the three flags the table creation page has been
 * writing since it was built and that no reader ever consumed. They ride in
 * the title, beside the game name, because that is where a player looks first
 * and because all three are claims about the GAME rather than about its state
 * (which is what the status pill is for).
 *
 * Order is fixed and not data-driven: FEATURED is the host's choice and reads
 * first, VIP is a door, NEW is the smallest claim of the three.
 */
function LobbyFlagChips({ entry }: { entry: LobbyEntry }) {
  if (!entry.featured && !entry.vipOnly && !entry.isNew && !entry.clubLabel) return null;
  return (
    <span className="lt-flags">
      {/* Only ever set on a union board, for a game belonging to another club,
          and only when that club has not switched `hide_club_name` on. On a
          single-club board this is null and nothing renders. */}
      {entry.clubLabel && (
        <span className="lt-flag lt-flag--club" title={`Hosted By ${entry.clubLabel}`}>
          {entry.clubLabel}
        </span>
      )}
      {entry.featured && (
        <span
          className="lt-flag lt-flag--featured"
          title="Pinned To The Top Of The Board By The Host"
        >
          FEATURED
        </span>
      )}
      {entry.vipOnly && (
        <span
          className="lt-flag lt-flag--vip"
          title="VIP Members Only. A Seat Here Needs VIP Membership"
        >
          VIP
        </span>
      )}
      {entry.isNew && (
        <span className="lt-flag lt-flag--new" title="Recently Opened">
          NEW
        </span>
      )}
    </span>
  );
}

const COL_NAME: ColumnDef = {
  key: 'name',
  label: 'Game',
  className: 'lt-col-name',
  sortable: true,
  /* Sort what the row SHOWS. A cash row's first line is cashTitleLines()'s
     headline ("NLH 1 / 2"); the table's own name is line two. Sorting on
     `name` reordered the board against text the player was not reading. */
  sortValue: (e) => (e.kind === 'cash' ? cashTitleLines(e).headline : e.name || '').toLowerCase(),
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
          <LobbyFlagChips entry={e} />
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
          <LobbyFlagChips entry={e} />
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
        <LobbyFlagChips entry={e} />
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
  render: (e) => (e.stakesLabel ? <span className="lt-mono">{e.stakesLabel}</span> : null),
};
const COL_VARIANT: ColumnDef = {
  key: 'variant',
  label: 'Variant',
  className: 'lt-col-variant',
  sortable: true,
  sortValue: (e) => e.gameLabel,
  render: (e) => (
    /* <abbr title> is a hover affordance and half this traffic has no hover,
       so "PLO5" had no expansion at all on a phone or from a keyboard. The
       long name rides along for assistive tech and for the accessible name. */
    <abbr className="lt-variant" title={e.variantLabel} aria-label={e.variantLabel}>
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
  /* render() returns null for a freezeout with no guarantee, so a raw 0 here
     floated every BLANK cell above every real one on an ascending sort.
     Infinity sinks unknowns in both directions - the convention COL_TSTACK and
     COL_FORMAT already follow, and the comparator is built for it. */
  sortValue: (e) => (e.guaranteeValue > 0 ? e.guaranteeValue : Infinity),
  /* null, not a dash. A non-empty cell defeats `td:empty`, so every freezeout
     without a guarantee grew a labelled GUARANTEE well containing a hyphen. */
  render: (e) =>
    e.guaranteeLabel ? <span className="lt-mono lt-gtd">{e.guaranteeLabel}</span> : null,
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
/* One source for the word, so the sort and the cell can never disagree.
   Sorting on the raw `kind` key ordered cash, mtt, sng, spin and PRINTED
   Cash, MTT, Heads Up, Spin - alphabetical in neither. */
function kindLabel(e: LobbyEntry): string {
  return e.kind === 'cash'
    ? 'Cash'
    : e.kind === 'spin'
      ? 'Spin'
      : e.kind === 'sng'
        ? 'Heads Up'
        : 'MTT';
}
const COL_KIND: ColumnDef = {
  key: 'kind',
  label: 'Type',
  className: 'lt-col-kind',
  sortable: true,
  sortValue: (e) => kindLabel(e),
  render: (e) => (
    <span className="lt-kind">
      {/* COL_KIND is in the ALL set alone, and the ALL list is MTTs and cash
          only today ("SPINS AND HEADS UP ARE NEVER HERE", pinned by
          allTabScope). The Spin and Heads-Up labels stay anyway: collapsing
          them to a bare `: 'MTT'` means the day that scope changes, a Spin
          silently calls itself an MTT rather than failing visibly. A label
          that is merely unused costs nothing; one that is wrong costs trust. */}
      {kindLabel(e)}
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
/* SPINS ONLY (Dan 2026-08-25: "REMOVE THE MAX PAYOUT ON ANY PAGE BESIDES
   SPINS. ITS ONLY FOR THAT CATEGORY."). spinPayoutLabel returns null for
   anything that is not a Spin, so on any other board this is a column of
   nothing - and the multiplier IS the Spin, which is why it stays there.
   Pinned by lobbyTitleColumn.test.ts. */
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
  /* The RANK OF THE RENDERED LABEL, not the raw depth and not the alphabet
     (ITEM E audit, 2026-08-26). Depth-sorting looked broken whenever a
     tournament's NAME carried a speed word: "Sunday Turbo" at 60bb rendered
     Turbo but sorted among the Deepstacks, so the sorted column read
     `Turbo, Deepstack, Standard, Turbo…`. stackFormatRank derives the rank
     from stackDepthLabel itself, so sort order and rendered word cannot
     disagree. Cash rows still rank Infinity and sink in both directions,
     exactly as COL_TSTACK does; named rows short-circuit before any
     blind-structure parse, so the comparator stays cheap where it matters. */
  sortValue: (e) => stackFormatRank(e),
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
    /* One closure, not one per button. `stop` used to be a factory allocating
       a fresh handler for every button on every row on every render, on a
       column the desktop stylesheet hides entirely — 2 to 3 closures x 111
       rows to build DOM that is display:none. The action is carried on the
       button instead and read back from the event. */
    const run = (ev: React.MouseEvent) => {
      ev.stopPropagation();
      const which = (ev.currentTarget as HTMLElement).dataset.act;
      if (which === 'register') ctx.onRegister?.(e);
      else if (which === 'spinjoin') ctx.onSpinJoin?.(e, e.kind === 'sng' ? 'sng' : 'spin');
      else if (which === 'join') ctx.onJoinTable?.(e);
      else if (which === 'view') ctx.onViewTable?.(e);
      else if (which === 'waitlist') ctx.onWaitlistToggle?.(e.id, !ctx.waitlistedIds.has(e.id));
    };

    if (e.kind === 'cash') {
      const seated = ctx.seatedIds.has(e.id);
      const headsUp = e.capacity === 2;
      /* A seat the player already holds beats every other consideration: a
         full table is still THEIR table, and Return To Table has to win over
         the waitlist offer. */
      const full = !seated && e.capacity > 0 && e.players >= e.capacity;
      const waiting = ctx.waitlistedIds.has(e.id);
      return (
        <span className="lt-actions">
          {ctx.onViewTable && (
            <button
              type="button"
              className="lt-act lt-act--ghost"
              data-act="view"
              onClick={run}
              aria-label={`View Table ${e.name}`}
            >
              View Table
            </button>
          )}
          {full && ctx.onWaitlistToggle && (
            <button
              type="button"
              className={`lt-act ${waiting ? 'lt-act--done' : 'lt-act--primary'}`}
              data-act="waitlist"
              onClick={run}
              aria-label={`${waiting ? 'Leave Waitlist For' : 'Join Waitlist For'} ${e.name}`}
            >
              {waiting ? 'Leave Waitlist' : 'Join Waitlist'}
            </button>
          )}
          {!full && ctx.onJoinTable && (
            <button
              type="button"
              className="lt-act lt-act--primary"
              data-act="join"
              onClick={run}
              aria-label={`${seated ? 'Return To' : headsUp ? 'Sit Down At' : 'Join'} ${e.name}`}
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
      /* Through seatFirstJoinable, the ONE list of dead states — status AND
         the capacity check that fires a moment before the status catches up.
         This used to spell its own list and omit 'closed', so a
         just-cancelled row still rendered a Sit Down button that could only
         fail (ITEM E audit, 2026-08-26: reachable in the window before the
         realtime handler drops the row). Two lists that must be edited
         together is how they drift apart. */
      const noSeatLeft = !seatFirstJoinable(e);

      if (mine || noSeatLeft) {
        return (
          <span className="lt-actions">
            {ctx.onViewTable && (
              <button
                type="button"
                className={`lt-act ${mine ? 'lt-act--done' : 'lt-act--primary'}`}
                data-act="view"
                onClick={run}
                aria-label={`${mine ? 'Return To' : 'Watch'} ${e.name}`}
              >
                {mine ? 'Return To Game' : 'Watch'}
              </button>
            )}
          </span>
        );
      }

      /* WHICH FLOW SELLS THIS SEAT. Seat-first (a Spin, or a Heads-Up SNG
         with 2 chairs) opens the TABLE and the player buys the seat they
         tap — fn_take_seat_and_buy_in, money moves only on the seat
         confirm. Every other SNG is a registration game and keeps the Sign
         Up card. This split must agree with fn_take_seat_and_buy_in and the
         engine's isSngOrSpin gate: variant spin, or sng with capacity <= 2.
         Before 2026-08-28 BOTH went to onRegister, so a spin's Sit Down
         charged the buy-in from the lobby with no seat attached. */
      const seatFirst =
        e.kind === 'spin' || (e.kind === 'sng' && e.capacity > 0 && e.capacity <= 2);
      const act = seatFirst && ctx.onSpinJoin ? 'spinjoin' : 'register';
      return (
        <span className="lt-actions">
          {(ctx.onRegister || (seatFirst && ctx.onSpinJoin)) && (
            <button
              type="button"
              className="lt-act lt-act--primary"
              data-act={act}
              onClick={run}
              aria-label={`Sit Down At ${e.name}`}
            >
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
          <button
            type="button"
            className="lt-act lt-act--ghost"
            data-act="view"
            onClick={run}
            aria-label={`Details For ${e.name}`}
          >
            Details
          </button>
        )}
        {ctx.onRegister && !closedToEntry && (
          <button
            type="button"
            className={`lt-act ${registered ? 'lt-act--done' : 'lt-act--primary'}`}
            data-act={registered ? 'view' : 'register'}
            onClick={run}
            aria-label={`${registered ? 'Registered For' : 'Register For'} ${e.name}`}
          >
            {registered ? 'Registered' : 'Register'}
          </button>
        )}
        {closedToEntry && ctx.onViewTable && (
          <button
            type="button"
            className="lt-act lt-act--primary"
            data-act="view"
            onClick={run}
            aria-label={`${registered ? 'Return To' : 'Watch'} ${e.name}`}
          >
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
  cursor,
  onSelect,
  onActivate,
}: {
  entry: LobbyEntry;
  columns: ColumnDef[];
  ctx: LobbyRowContext;
  selected: boolean;
  /** The keyboard cursor is here. Not the same as selected — see handleKeyDown. */
  cursor?: boolean;
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
      className={`lt-row lt-row--${entry.status}${entry.featured ? ' is-featured' : ''}${selected ? ' is-selected' : ''}${cursor ? ' is-cursor' : ''}${mine ? ' is-mine' : ''}`}
      data-kind={entry.kind}
      role="row"
      aria-selected={selected}
      id={`lt-row-${entry.id}`}
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
          className={col.className || ''}
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
        /* `labelFor` came along with the spread and said "Registered" while
           the header said "Enrolled", so the desktop column heading and the
           card's own data-label disagreed about the same number. One word.
           And it is no longer hidden on phones: hideOnMobile meant the MTT tab
           showed no registration count at all on a phone, which is one of the
           two numbers a player is choosing between. */
        { ...COL_PLAYERS, label: 'Registered' },
        COL_STATUS,
        COL_TSTACK,
        COL_TLEVEL,
        COL_LEVELTIME,
        COL_FORMAT,
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
        /* COL_PAYOUT is NOT here. The ALL tab carries MTTs and cash only —
           "SPINS AND HEADS UP ARE NEVER HERE", pinned by allTabScope.test.ts —
           and spinPayoutLabel returns null for everything that is not a Spin,
           so the column was 116px of guaranteed emptiness on every desktop
           ALL tab. */
        COL_PLAYERS,
        COL_STARTS,
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
  /* Only the Spin tabs can render the badge (it requires kind === 'spin', and
     the ALL list never contains a Spin), so every other tab was fetching a
     view whose answer it could not display. */
  const spinTiers = useSpinTierAvailability(category === 'SPIN' ? clubId : undefined);
  const rowCtx = useMemo<LobbyRowContext>(
    () => ({ ...ctx, spinTopTierLive: spinTiers?.can_draw_100x === true }),
    [ctx, spinTiers]
  );

  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(
    () => readSort(clubId, category) ?? defaultSortFor(category)
  );
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  /* Which row the keyboard is on. Deliberately separate from `selectedId`:
     selecting a row opens (and for a running MTT, navigates), and arrowing
     through a list must not do either. */
  const [keyboardFocusId, setKeyboardFocusId] = useState<string | null>(null);

  /* The columns change with the category, so the sort cannot carry across -
     it is restored from what this player last chose on THIS tab instead. A
     remembered key that the new column set does not define is dropped by the
     sort itself (columns.find returns undefined -> original order). */
  /**
   * Restore the remembered sort when the TAB changes.
   *
   * `clubId` was in this dependency list and should not have been: on a slug
   * route it starts as the slug and becomes the UUID a moment later, so the
   * effect fired twice with two different storage keys and threw away any
   * header the player had clicked in between. The tab is the only thing that
   * changes the column set, and the column set is the only reason to re-read.
   */
  const lastCategoryRef = useRef(category);
  useEffect(() => {
    if (lastCategoryRef.current === category) return;
    lastCategoryRef.current = category;
    setSort(readSort(clubId, category) ?? defaultSortFor(category));
  }, [category, clubId]);

  /* Dan 2026-08-25: a Spin or Heads-Up with every seat gone "NEEDS TO BE
     DROPPED TO THE BOTTOM OF THE RESULTS". This is applied AFTER whatever sort
     the player chose and is deliberately not a column: no ordering of buy-in,
     seats or status should ever float a game nobody can enter back up between
     two they can. Array.prototype.sort is stable in every engine we ship to,
     so the chosen order survives inside each partition. */
  const sink = useCallback((rows: LobbyEntry[]) => {
    /* ONE pass. The previous version called seatFirstJoinable once per row for
       `.some` and then ~2 n log n more times inside a comparator, on an array
       that had just been copied — and copied it again. Partitioning is O(n),
       preserves the incoming order inside each half (which is what the stable
       sort was there for), and evaluates the predicate exactly once per row.
       The identical array reference is returned when nothing needs to sink, so
       the memo below still sees no change. */
    const pinned: LobbyEntry[] = [];
    const open: LobbyEntry[] = [];
    const gone: LobbyEntry[] = [];
    for (const r of rows) {
      /* FEATURED floats and a dead seat-first game sinks, in one pass.

         A featured game nobody can enter does NOT float. The host meant "look
         at this game", not "look at this result", and a full table pinned above
         forty joinable ones is worse than not pinning it at all. seatFirstJoinable
         alone is not that test - it returns true for every cash row by design,
         so the status has to be checked here too. */
      const enterable =
        seatFirstJoinable(r) &&
        r.status !== 'full' &&
        r.status !== 'closed' &&
        r.status !== 'completed';
      if (!seatFirstJoinable(r)) gone.push(r);
      else if (r.featured && enterable) pinned.push(r);
      else open.push(r);
    }
    if (pinned.length === 0 && gone.length === 0) return rows;
    return pinned.concat(open, gone);
  }, []);

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
    /* The write happens OUTSIDE the updater. React may invoke an updater more
       than once (StrictMode, bail-out replays), and a side effect in there is
       a correctness hazard the moment it stops being idempotent. */
    /* COMPUTED FROM `sort`, NOT FROM AN UPDATER (2026-08-26). The write used
       to read a variable assigned inside setSort's updater, which React only
       runs synchronously on the eager-bailout path - and this table always has
       other work pending (the 1Hz tick every MTT row subscribes to, plus the
       keyboard cursor), so the updater ran later and the write was skipped.
       The player's chosen sort was silently not remembered. `sort` is the
       state this handler already renders from, so deriving from it is both
       correct and idempotent. */
    const prev = sort;
    {
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
      setSort(next);
      writeSort(clubId, category, next);
    }
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      /* Home/End/PageUp/PageDown are what a keyboard user reaches for in a
         list this dense - 111 rows is a lot of ArrowDown. */
      /* ONLY THE SCROLLER'S OWN KEYS (2026-08-26). preventDefault() in a
         child handler does not stop the event bubbling here, so Enter on a
         sortable column header sorted the board AND navigated the player out
         of the lobby; Enter on the favourite star toggled the star and left;
         Enter on a card's action button fired that action and activated a
         DIFFERENT, cursored row. Every one of those targets is a real element
         inside this region, so the cheapest correct test is whether the event
         started on the scroller itself. */
      if (e.target !== e.currentTarget) return;
      const NAV = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'];
      if (!NAV.includes(e.key) && e.key !== 'Enter') return;
      if (sorted.length === 0) return;
      const cursorId = keyboardFocusId ?? selectedId;
      const idx = sorted.findIndex((r) => r.id === cursorId);
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
      /* onSelect is openEntry, which NAVIGATES for a running MTT. Holding
         ArrowDown through the list therefore routed the player off the lobby
         mid-scroll, and Home/End/PageDown did it in one keystroke. Keyboard
         navigation moves the SELECTION; Enter is what activates. */
      setKeyboardFocusId(sorted[next].id);
      // Keep the focused row in view inside the sticky-header scroller.
      const rowEl = bodyRef.current?.querySelector<HTMLTableRowElement>(
        `tr[data-id="${sorted[next].id}"]`
      );
      rowEl?.scrollIntoView({ block: 'nearest' });
    },
    [sorted, selectedId, keyboardFocusId, onActivate]
  );

  return (
    <>
      <div className="arena-lobby-card-list" aria-label={`Game Cards, ${sorted.length} Games`}>
        {sorted.map((entry) => (
          <ArenaLobbyGameCard
            key={entry.id}
            entry={entry}
            ctx={rowCtx}
            selected={entry.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
      <div
        className="lobby-table-wrap"
        /* WAS role="region" (2026-08-26). aria-activedescendant is only honoured
         on a composite widget role - grid, listbox, combobox, application - and
         a region is a landmark, so the cursor this file moves with the arrow
         keys was announced to nobody. The role belongs on the element that
         actually takes focus and handles the keys, which is this one; the
         table below keeps its own grid semantics for the rows. */
        role="grid"
        aria-label={`Game List, ${sorted.length} Game${sorted.length === 1 ? '' : 's'}`}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        /* Without this the arrow keys moved a selection no screen reader was
         told about: focus stays on this wrapper by design (moving it into the
         row would fight the scroller), so the grid has to name its own active
         descendant. */
        aria-activedescendant={keyboardFocusId ? `lt-row-${keyboardFocusId}` : undefined}
      >
        {/* role=grid: aria-selected on a <tr> is only valid inside a grid, and
          without it a screen reader announces none of the selection state the
          keyboard navigation produces. */}
        {/* Sorting rearranges the whole list with no visible message and, until
          now, no audible one either: a screen-reader user pressed Enter on a
          header and nothing was announced. */}
        <span className="sr-only" role="status" aria-live="polite">
          {sort
            ? `Sorted By ${columns.find((c) => c.key === sort.key)?.label || sort.key}, ${
                sort.dir === 'asc' ? 'Ascending' : 'Descending'
              }`
            : 'Default Order'}
        </span>
        {/* The category is on the table so the stylesheet can shed columns per
          BOARD rather than per page width. The wide breakpoints were written
          for the ALL and MTT boards, which carry eight columns; the SPIN board
          carries five, so dropping its Max Payout at 1340px starved a table
          that had room to spare — and the payout IS the Spin. */}
        <table className={`lobby-table lobby-table--${category.toLowerCase()}`} role="grid">
          <thead role="rowgroup">
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
                    className={`${col.className || ''}${col.sortable ? ' is-sortable' : ''}${active ? ' is-sorted' : ''}`}
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
          <tbody ref={bodyRef} role="rowgroup">
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
                    <td key={c.key} role="gridcell" className={c.className || ''}>
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
                cursor={entry.id === keyboardFocusId}
                onSelect={onSelect}
                onActivate={onActivate}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

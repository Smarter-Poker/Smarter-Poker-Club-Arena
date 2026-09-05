/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MULTI-TABLE PAGE — Premium-Style Multi-Table Container
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Wraps up to 4 concurrent TablePage instances with:
 * - Top tab bar for switching tables
 * - Horizontal swipe navigation between tables
 * - Auto-switch when action timer is urgent
 * - Add/remove table management
 *
 * URL pattern: /tables (manages its own table instances)
 * Legacy URL: /table/:tableId still routes here with a single table
 */

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  Suspense,
} from 'react';
import { matchPath, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { TableTabBar, type TabInfo } from '../components/table/TableTabBar';
import { isSitOutUrgent } from '../lib/sitOutDeadline';
import LiveTablesBar from '../components/table/LiveTablesBar';
import {
  InTabLobbyContext,
  tournamentTargetFromTo,
  type InTabLobbyNav,
  type InTabTournamentTarget,
} from '../context/InTabLobbyContext';
import { useMasterBusSubscription } from '../hooks/useMasterBusSubscription';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { rankQuickJoinTables, bigBlindFromStakesLabel } from '../lib/quickJoinRanking';
import { fetchFavoriteTableIds } from '../components/quickactions/favoriteTables';
import { useUserTableSettings } from '../hooks/useUserTableSettings';
import { formatGameTitle } from '../utils/formatGameTitle';
import { useToast } from '../components/common/Toast';
import { supabase } from '../lib/supabase';
import { gameCode, gameCodeFromName } from '../utils/gameCode';
import { stakesLabel } from '../lib/bettingStructure';
import { swipeTargetIndex } from '../utils/swipeTarget';
import {
  LOBBY_TAB_PREFIX,
  isLobbyLike,
  isTournamentRow,
  pickObserveSlot,
  pruneStaleSeatedTabs,
} from '../utils/tabSlots';
import { soundService, haptic } from '../services/SoundService';
import { setSitOut, submitAction } from '../services/GameServerAPI';
import { sessionStatsService } from '../services/SessionStatsService';
import './MultiTablePage.css';
import { lazyWithRetry } from '../utils/lazyWithRetry';
import { resolveLobbyClubId } from '../utils/clubQuickLink';
import { useUserStore } from '../stores/useUserStore';
import { TableErrorBoundary } from '../components/common/TableErrorBoundary';
import { betSliderStep, sliderUnitFor } from '../components/table/ActionPanel';
import { publishInTabLobbyActive } from '../components/club/inTabLobbySurface';

// Lazy-load TablePage for code splitting
const TablePage = lazyWithRetry(() => import('./TablePage'));
// Dan 2026-08-15: the lobby rendered INSIDE a tab, so the in-table "+" can
// show it without navigating away and unmounting the running games.
const HomePage = lazyWithRetry(() => import('./HomePage'));
/**
 * Dan 2026-08-19: leaving a table must land on the CLUB lobby (the club's game
 * list, BBJ banner and wallet rows), not the pre-lobby landing page with
 * Create/Find/Join. HomePage is the pre-lobby and is now only the fallback for
 * when we genuinely cannot resolve which club the player came from.
 */
const ClubHomePage = lazyWithRetry(() => import('./ClubHomePage'));
/**
 * Dan 2026-08-19: tournament cards in the in-tab lobby link to
 * /tournaments/:id, a route OUTSIDE table/:tableId — following it unmounted
 * this whole container and killed every live game. The lobby tab now renders
 * TournamentDetails IN PLACE instead (see handleLobbyLinkCapture), so
 * registering for a tournament keeps the other tables dealing.
 */
const TournamentDetails = lazyWithRetry(() => import('./tournament/TournamentDetails'));

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TableInstance {
  id: string;
  name: string;
  stakes: string;
  isMyTurn: boolean;
  /** Absolute epoch-ms deadline of the hero's turn on this table. */
  turnDeadlineMs?: number;
  /** Absolute epoch-ms the hero's turn clock started (with the deadline it
   *  drives the depleting timer bar under the tab — PokerBros parity). */
  turnStartMs?: number;
  pot: number;
  /**
   * Hero's hole cards at this table as ONE comma-joined string ("Ah,Qc"; ""
   * when not in a hand or folded). A string, not an array, so
   * updateTableInfo's shallow !== bail-out keeps working (P1-2 fix).
   */
  holeCards?: string;
  /** Hero's last action this street at this table ('fold', 'call', ...). */
  lastAction?: string;
  /** Live Bad Beat Jackpot pool at this table (0/undefined = no BBJ). */
  jackpot?: number;
  /** Hero folded this hand (tab dims). */
  folded?: boolean;
  /** Showdown outcome edge: "win:<hand>" / "loss:<hand>" / "". */
  handResult?: string;
  /** Amount the hero must call right now (0 = check legal); set while it is
   *  the hero's turn. Drives the tile-view action strip. */
  toCall?: number;
  /** Raise-TO bounds for the tile raise slider, "minTo:maxTo:bb" ('' or
   *  undefined = no raise legal). Primitive string so updateTableInfo's
   *  shallow !== bail-out keeps working (P1-2). */
  raiseBounds?: string;
  /** Hero's current stack at this table. */
  heroStack?: number;
  /** Hero is sitting out at this table. */
  sittingOut?: boolean;
  /** Absolute epoch-ms this table's sit-out clock runs out. Cash only. */
  sitOutDeadlineMs?: number;
  /** Tournament tables sit out indefinitely; cash tables are on a clock. */
  isTournament?: boolean;
  /** Dan 2026-08-21: short game code the tab shows when no hand is live
   *  (NLH / PLO5 / SPIN / MTT / HU). Best-effort at first paint, replaced by
   *  TablePage's authoritative value the moment it loads. */
  gameCode?: string;
  /** Timed NON-TURN decision open here: "discard|insurance|rit:deadlineMs". */
  decision?: string;
  /** Time bank burning here: "1:deadlineMs". */
  timeBank?: string;
  /**
   * Dan 2026-08-15: a tab is either a live table or a LOBBY placeholder.
   *
   * The in-table "+" opens a `kind: 'lobby'` tab so the player can browse for
   * a second game while their current table keeps dealing in its own tab.
   * When they sit down, TABLE_SEATED converts this tab in place into a
   * `kind: 'table'` tab rather than appending a new one — otherwise picking a
   * game would strand a dead lobby tab and burn one of the 4 slots.
   *
   * Absent means 'table', so every pre-existing construction site stays valid.
   */
  /**
   * REQUIRED, and that is the fix (Dan 2026-08-31).
   *
   * This was optional, and three separate factories forgot it — the seat
   * rebuild, the balancer-move branch, and the initial state built from the
   * URL. `undefined` is not a harmless default here: a tab with no `kind` was
   * invisible to the stale-seat prune, so a table the server had closed under
   * the player stayed on screen, frozen. Two rounds of fixing individual
   * factories only moved the hole.
   *
   * Required means the COMPILER refuses the next factory that forgets, which
   * is the only guard that cannot itself rot. It is also what found the third
   * site: tsc named it in one run.
   */
  kind: 'table' | 'lobby';
  /**
   * Does the hero hold an ACTIVE SEAT at this table right now?
   *
   * Dan 2026-08-20: "take seat button must never exist if you're not active on
   * a table." An open tab is not a seat. A tab is also created by the route
   * effect from a bare /table/:id URL — a spectator, a deep link, a player who
   * arrived but has not bought in — and none of those give the player a seat to
   * be taken back to. Gating the Take Seat bar on `kind !== 'lobby'` therefore
   * offered to return people to seats they did not hold.
   *
   * Set true by exactly two things, both of which are evidence of a real seat:
   * the TABLE_SEATED event, and the server-truth rebuild, which reads
   * table_seats WHERE left_at IS NULL. Everything else leaves it undefined,
   * which reads as "not seated" — the safe default for a control whose whole
   * job is to claim you have somewhere to sit.
   */
  seated?: boolean;
  /**
   * Dan 2026-08-19: a lobby tab drilled into a tournament. Set when the user
   * taps a tournament card inside the in-tab lobby; the tab then renders
   * TournamentDetails instead of the club lobby so the running tables never
   * unmount. Cleared by the tab's own "back to lobby" affordance, or wholesale
   * when TABLE_SEATED / the route effect converts the lobby tab into a table.
   *
   * Dan 2026-08-28 round 2: this is now the TOP OF `lobbyTournamentStack`,
   * kept as its own field so every existing reader still works unchanged.
   * Treat the stack as the source of truth when pushing or popping.
   */
  lobbyTournamentId?: string;
  /**
   * The drill-in history for this lobby tab, oldest first; the last entry is
   * what is on screen and mirrors `lobbyTournamentId`.
   *
   * WHY A STACK. A tournament page lists its SATELLITES, and tapping one is a
   * drill-in from a page that was itself a drill-in. Round 1 stored one scalar
   * and overwrote it, so the parent event was simply gone: "← Lobby" jumped
   * all the way out to the club lobby, and browser Back was dead too because
   * an in-tab drill-in pushes no history entry. A player comparing a $200 Main
   * with its $10 satellite could not get back to the Main without starting
   * over from the schedule. On the real /tournaments/:id route Back did this
   * correctly, so the in-tab version was a downgrade in exactly the flow it
   * exists to serve.
   */
  lobbyTournamentStack?: InTabTournamentTarget[];
}

/**
 * ─── THE DRILL-IN STACK (Dan 2026-08-28 round 2) ────────────────────────────
 *
 * `lobbyTournamentId` is the TOP of `lobbyTournamentStack`. These three helpers
 * are the only writers, so the pair can never disagree — the round 1 bug was
 * two writers keeping one scalar, and the second one silently winning.
 */

/** Push a tournament onto a lobby tab's drill-in history. */
const pushLobbyTournament = (t: TableInstance, target: InTabTournamentTarget): TableInstance => {
  const stack = t.lobbyTournamentStack ?? [];
  // Re-opening the event already on screen is a no-op, not a second entry.
  // Without this, a double tap on the same row would need two "back" presses
  // to leave one page.
  const top = stack[stack.length - 1];
  if (top && top.tournamentId === target.tournamentId && top.search === target.search) return t;
  const next = [...stack, target];
  return { ...t, lobbyTournamentStack: next, lobbyTournamentId: target.tournamentId };
};

/** Pop one level. Returns the tab showing the club lobby when the stack empties. */
const popLobbyTournament = (t: TableInstance): TableInstance => {
  const stack = t.lobbyTournamentStack ?? [];
  const next = stack.slice(0, -1);
  const top = next[next.length - 1];
  return {
    ...t,
    lobbyTournamentStack: next.length > 0 ? next : undefined,
    lobbyTournamentId: top?.tournamentId,
  };
};

/** Drop the whole drill-in history — the tab shows the club lobby again. */
const clearLobbyTournaments = (t: TableInstance): TableInstance => ({
  ...t,
  lobbyTournamentStack: undefined,
  lobbyTournamentId: undefined,
});

/**
 * The `?name=&stakes=&code=` a /table/:id URL carries, rebuilt from a tab we
 * already hold (Dan 2026-08-28 round 3).
 *
 * The route effect reads those three params to name and label a tab it has not
 * built yet, falling back to `Table <n>` with blank stakes when they are
 * absent. Three places navigated to /table/:id with NO query — the cap
 * correction, the tournament backstop, and every tab switch — so any of them
 * left the address bar carrying less information than the tab strip was
 * already showing. Reload after one and a "PLO4 0.5/1" tab came back as
 * "Table 1" with no stakes under it.
 *
 * Only emits the params it actually has, so a tab that genuinely knows nothing
 * produces "" and behaves exactly as before.
 */
const tableQuery = (t: TableInstance): string => {
  const p = new URLSearchParams();
  if (t.name && !/^Table \d+$/.test(t.name)) p.set('name', t.name);
  if (t.stakes) p.set('stakes', t.stakes);
  if (t.gameCode) p.set('code', t.gameCode);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
};

/**
 * ─── THE DRILL-IN SURVIVES A RELOAD (Dan 2026-08-28 round 3) ────────────────
 *
 * Reloading while reading a tournament in a lobby tab used to drop the player
 * onto a felt with no message: the stack is React state, tabs rebuild from
 * `table_seats`, and a lobby tab is not a seat so nothing brought it back. The
 * address bar could not help either — a lobby tab borrows a table's URL.
 *
 * WHY THIS IS NOT THE PERSISTENCE THAT WAS DELETED. The `multi_table_session`
 * key removed above stored TABLES, and a resurrected table tab is a claim that
 * you hold a seat you may have left — it implies chips. This stores a list of
 * tournament ids somebody was READING. No seat, no stack of chips, no engine
 * socket; the worst case is a lobby tab open on a page they had open a minute
 * ago. Restored through the same `openTournamentTab` path a tap uses, so it
 * cannot invent a state a tap could not reach.
 *
 * TTL, because "what you were reading" goes stale fast: a tab reopened
 * tomorrow morning on last night's tournament is clutter, not continuity.
 */
const DRILL_IN_KEY = 'ca_lobby_drill_in';
const DRILL_IN_TTL_MS = 30 * 60 * 1000;

const saveDrillIn = (stack: InTabTournamentTarget[] | undefined) => {
  try {
    if (!stack || stack.length === 0) {
      sessionStorage.removeItem(DRILL_IN_KEY);
      return;
    }
    sessionStorage.setItem(DRILL_IN_KEY, JSON.stringify({ at: Date.now(), stack }));
  } catch {
    /* private-mode storage throws; the drill-in is a convenience, not a seat */
  }
};

const readDrillIn = (): InTabTournamentTarget[] | null => {
  try {
    const raw = sessionStorage.getItem(DRILL_IN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; stack?: unknown };
    if (typeof parsed?.at !== 'number' || Date.now() - parsed.at > DRILL_IN_TTL_MS) {
      sessionStorage.removeItem(DRILL_IN_KEY);
      return null;
    }
    // Validate every entry rather than trusting the blob: this is parsed JSON
    // from storage, and a half-written or hand-edited value must not reach the
    // renderer as a tournament id.
    const stack = Array.isArray(parsed.stack) ? parsed.stack : [];
    const clean = stack.filter(
      (e): e is InTabTournamentTarget =>
        !!e &&
        typeof (e as InTabTournamentTarget).tournamentId === 'string' &&
        (e as InTabTournamentTarget).tournamentId.length > 0 &&
        typeof (e as InTabTournamentTarget).search === 'string'
    );
    return clean.length > 0 ? clean : null;
  } catch {
    return null;
  }
};

/**
 * Lobby tabs carry a synthetic id so they can share the tabs array.
 *
 * The predicate itself now lives in src/utils/tabSlots.ts alongside the two
 * decisions that turn on it (which slot a new table takes, which tabs a rebuild
 * may close). They had drifted apart once — see `pruneStaleSeatedTabs` — and
 * one definition is what stops that happening again. Aliased to the local name
 * so every existing call site reads unchanged.
 */
const isLobbyTab = isLobbyLike;

/**
 * Dan 2026-08-21: "4-table cap ... Desktop could reasonably run 6-8."
 *
 * Six on a desktop-sized screen, four on a phone - four 2x2 tiles is already
 * the most a 375px screen can show without the felt becoming unreadable, and
 * the strip has to stay tappable. The SERVER is the real rule (migration
 * 2026-08-21 raised atomic_table_buyin's v_max_tables to 6, cash tables only,
 * tournaments still uncapped); this is the client refusing to offer a seat it
 * knows the server would decline, and never the other way round.
 *
 * Read once at module load: a mid-session rotation cannot strand open tables,
 * and the server still has the final say on every buy-in.
 */
/* Dan 2026-08-30: the 4-square (tile view) artwork - brushed-metal icon Dan
   supplied, served from the same buttons bucket as every other table icon.
   One artwork for both button skins: the metal piece is skin-neutral.

   RETIRED 2026-08-31. That render carries a dark rounded PLATE baked into it
   (no alpha channel), which the 40px button painted as a backdrop behind the
   glyph - Dan: "remove the little pill behind the 4 square button." The icon
   is now drawn inline at the button; see the note there. Restore this const
   and the <img> together if the artwork is ever re-cut transparent. */

const MAX_TABLES = typeof window !== 'undefined' && window.innerWidth >= 1024 ? 6 : 4;

/**
 * Dan 2026-08-19 (persistence upgrade): what the GLOBAL dock should show while
 * the container is hidden on a non-/table route. Pure so the logic harness
 * can lift it verbatim.
 * - Some table needs the hero's action -> 'urgent' (most pressing deadline
 *   wins): the player must be pulled back before their hand is folded out.
 * - Tables merely running -> 'return': a quiet re-entry affordance.
 * - On /table/* the container itself is visible -> 'none' (no dock).
 */
const dockStateFor = (
  tabs: TableInstance[],
  hidden: boolean,
  nowMs: number,
  lastActiveId?: string
) => {
  if (!hidden) return { kind: 'none' as const };
  const live = tabs.filter((t) => !isLobbyTab(t));
  if (live.length === 0) return { kind: 'none' as const };
  /**
   * TWO KINDS OF CLOCK CAN RUN OUT WHILE YOU ARE LOOKING SOMEWHERE ELSE.
   *
   * This used to be gated on `isMyTurn` alone, so the dock had a countdown, a
   * document-title flip, a favicon badge and a tick-tock loop for a TURN — and
   * nothing whatsoever for a seat being reclaimed. A player who tapped Sit Out
   * At All Tables started up to six five-minute eviction clocks and no surface
   * outside the hidden tables reported one of them. Losing a turn costs a hand;
   * losing a seat cashes out a stack.
   *
   * The turn still wins when both are running — it is the shorter fuse by an
   * order of magnitude — and the sit-out only competes once it is inside the
   * last minute, which is where `isSitOutUrgent` puts it. Otherwise a sat-out
   * player would sit in a permanently "urgent" dock for five minutes.
   */
  const urgentTurn = live
    .filter((t) => t.isMyTurn)
    .sort((a, b) => (a.turnDeadlineMs ?? Infinity) - (b.turnDeadlineMs ?? Infinity))[0];
  if (urgentTurn) {
    return {
      kind: 'urgent' as const,
      targetId: urgentTurn.id,
      name: urgentTurn.name,
      secondsLeft:
        urgentTurn.turnDeadlineMs !== undefined
          ? Math.max(0, Math.ceil((urgentTurn.turnDeadlineMs - nowMs) / 1000))
          : undefined,
    };
  }
  const urgentSeat = live
    .filter((t) => {
      /* `> 0` as well as urgent. `isSitOutUrgent` is deliberately unbounded
         below — it is the styling predicate, and a badge must stay red AT 0:00
         when the seat is at its most at-risk. The dock is the opposite case: it
         renders a COUNTDOWN, and once the deadline has passed the value only
         gets more negative, so an unbounded test would pin this dock to
         `urgent` with `0s` forever — favicon badge and tick-tock included —
         which is exactly what the note above claims the design avoids. */
      const left = t.sitOutDeadlineMs === undefined ? null : t.sitOutDeadlineMs - nowMs;
      return left !== null && left > 0 && isSitOutUrgent(left);
    })
    .sort((a, b) => (a.sitOutDeadlineMs ?? Infinity) - (b.sitOutDeadlineMs ?? Infinity))[0];
  if (urgentSeat) {
    return {
      kind: 'urgent' as const,
      targetId: urgentSeat.id,
      name: urgentSeat.name,
      secondsLeft: Math.max(0, Math.ceil(((urgentSeat.sitOutDeadlineMs ?? nowMs) - nowMs) / 1000)),
    };
  }
  /**
   * Dan 2026-08-20: the quiet dock used to hand back live[0] — the OLDEST tab —
   * so a player browsing away from table 4 was returned to table 1 and had to
   * find their way back. Prefer the tab they were last looking at.
   */
  const preferred = live.find((t) => t.id === lastActiveId) ?? live[0];
  return { kind: 'return' as const, count: live.length, targetId: preferred.id };
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function MultiTablePage() {
  const { user } = useAuthUser();
  /** Roadmap batch 2: multi-table behavior toggles (auto-switch, action
   *  queue) live with the rest of the user's table settings. */
  const { settings: userSettings } = useUserTableSettings(user?.id);
  /**
   * Dan 2026-08-19 (persistence upgrade): this container no longer lives under
   * the /table/:tableId route — App.tsx mounts it ONCE via
   * PersistentTableLayer, as a sibling of <Routes>, so navigating ANYWHERE
   * keeps every TablePage (and its EngineStateClient socket) mounted. The
   * route param is therefore derived from the location, and `hidden` collapses
   * the whole container to display:none while the player browses other routes.
   */
  const location = useLocation();
  const routeTableId = matchPath('/table/:tableId', location.pathname)?.params.tableId;
  const hidden = routeTableId === undefined;
  /**
   * The club whose lobby the player should return to. Resolved from the tables
   * they actually sat at, so it survives closing every tab. Kept in state (not
   * just a ref) because the in-tab lobby renders from it.
   */
  const [homeClubId, setHomeClubId] = useState<string | null>(null);
  const homeClubIdRef = useRef<string | null>(null);
  const clubLookupCacheRef = useRef<Map<string, string>>(new Map());
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();

  /**
   * Dan 2026-08-20 (E2E audit): the 4-table device cap used to fail SILENTLY in
   * three places — the route effect, TABLE_SEATED and OPEN_LOBBY_TAB each just
   * `return`ed. Tapping "+" at four tables did nothing at all, and (worst case)
   * a TOURNAMENT table the player was already seated at by the engine could not
   * be opened, so they blinded out of a game they had paid to enter.
   *
   * The cap itself is correct and stays: 4 concurrent tables per device, which
   * is exactly what the server enforces for CASH seats (atomic_table_buyin,
   * v_max_tables = 4, tournament_id IS NULL). Tournament REGISTRATIONS are
   * never capped — thousands are fine — so the only thing the client must do
   * when a fifth table shows up is SAY SO, loudly and specifically, instead of
   * swallowing it. Never auto-close a table to make room: that would cash a
   * player out of a live game without consent.
   */
  /**
   * Throttled PER REASON, not globally.
   *
   * The first version kept one timestamp for all three. That meant a player
   * who tapped "+" and was then seated into a tournament by the engine within
   * four seconds got the trivial "+" notice and had the seating one silently
   * dropped — the one case that actually costs money, suppressed by the one
   * that costs nothing. Exactly the swallowing this function exists to stop.
   *
   * 'seated' is also never suppressed by the others: it is rare, it is the
   * only one the player cannot cause themselves, and missing it means blinding
   * out of a paid tournament.
   */
  const capNoticeAtRef = useRef<Record<string, number>>({});
  const notifyCapReached = useCallback(
    (reason: 'add' | 'route' | 'seated', tableId?: string) => {
      // Dan 2026-08-21: a tournament seat that cannot be opened is not a toast
      // - the player is about to be blinded off a game they paid for. Announce
      // the refusal so TournamentAutoSeat can raise the large popup.
      if (reason === 'seated' && tableId) {
        masterBus.emit('TABLE_CAP_BLOCKED', { tableId });
      }
      const now = Date.now();
      // 'route' and 'add' can fire together for one user action — the route
      // effect and a bus event — so they share a window. 'seated' has its own.
      const key = reason === 'seated' ? 'seated' : 'user-action';
      if (now - (capNoticeAtRef.current[key] ?? 0) < 4000) return;
      capNoticeAtRef.current[key] = now;
      const msg =
        reason === 'seated'
          ? `You are already playing ${MAX_TABLES} tables. Close one to open the table you were just seated at.`
          : `You are playing the maximum of ${MAX_TABLES} tables. Close one first.`;
      toast.warning(msg, 6000);
    },
    [toast]
  );

  // ─── State ───────────────────────────────────────────────────────────
  // FIX: sessionStorage persistence removed — it caused "zombie" tabs to resurrect
  // on every page refresh, compounding the rogue-table problem. Tables are now
  // initialized exclusively from the URL param; they are rebuilt naturally when
  // a user sits down (TABLE_SEATED) or follows a /table/:id link.
  const [tables, setTables] = useState<TableInstance[]>(() => {
    // Clean up any leftover zombie session so old data never re-hydrates
    sessionStorage.removeItem('multi_table_session');
    // Initialize with the table from URL
    if (routeTableId) {
      /* Dan 2026-08-31: this is the FIRST tab of any session that lands
         straight on /table/:id — a deep link, a refresh at the table, the dock
         going back — and it was built with neither `kind` nor `gameCode`,
         while the route effect below builds the very same tab WITH both. The
         missing `kind` is what the required type now forbids; the missing
         `gameCode` made the tab strip show a blank chip until TablePage
         reported one. Same derivation as the route effect, so the two paths
         can no longer disagree about a tab they both build. */
      const nameFromUrl = formatGameTitle(searchParams.get('name')) || 'Table 1';
      return [
        {
          id: routeTableId,
          name: nameFromUrl,
          stakes: searchParams.get('stakes') || '',
          gameCode: searchParams.get('code') || gameCodeFromName(nameFromUrl),
          isMyTurn: false,
          pot: 0,
          kind: 'table' as const,
          // `seated` and `isTournament` stay unset on purpose: a URL proves
          // neither. TABLE_SEATED sets the first, TablePage reports the second.
        },
      ];
    }
    return [];
  });

  const [activeIndex, setActiveIndex] = useState(0);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isTileView, setIsTileView] = useState(false);
  // Single-table mode: skip entrance animation entirely (prevents blank screen)
  const [tabEntranceComplete, setTabEntranceComplete] = useState(() => tables.length <= 1);

  // Keep a ref to tables for use in bus handlers that may fire between renders
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  // Same for the active index: the route effect intentionally does not depend
  // on it (re-running on every tab switch would fight the router), so it reads
  // the live value through a ref instead of closing over a stale one.
  const activeIndexRef = useRef(0);
  /* Assigned during render, exactly as `tablesRef` is two lines above.
     Dan 2026-08-31: this used to be written in a passive effect, so between a
     `setActiveIndex` and the following commit the ref still named the PREVIOUS
     tab. Six readers consult it — the rebuild's focus restore, the observe
     slot pick, the tab reorder, both quick-join reads and the route cap
     branch — and every one of them wants the tab the player is on NOW; none
     wants the one they were on a commit ago. A bus event landing in that
     window (a seat, a balancer move) read the stale index and acted on the
     wrong tab. Assigning here closes the window and matches the idiom this
     file already uses for the tables array itself. */
  activeIndexRef.current = activeIndex;

  // Swipe tracking refs
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const lastActiveTableIdRef = useRef<string | undefined>(undefined);
  /**
   * "The next route arrival must focus THIS tab, not the one its URL names."
   *
   * Set only by `handleTabSelect` when it borrows a real table's URL to make a
   * LOBBY tab reachable from off-route (round 3). The route layout effect
   * consumes it exactly once and clears it. A ref rather than state because it
   * must be readable by that effect in the same commit as the navigation — a
   * state write would land a render too late and the lobby tab would flash
   * past on its way to the borrowed table.
   */
  const pendingTabIndexRef = useRef<number | null>(null);

  /**
   * Every `setActiveIndex` in this file was paired with a bare
   * `setTimeout(() => setIsTransitioning(false), 320)` — four of them, none
   * cleared. On an unmount (or a route teardown) inside that window each one
   * calls setState on a dead component; and because the container is mounted
   * for the whole session, a rapid sequence of switches also leaves several of
   * them racing to clear a flag that a later switch has just re-set, which is
   * what makes a fast tab-switch stutter. Tracked here, cleared on unmount.
   */
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const trackedTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      pendingTimersRef.current.delete(id);
      fn();
    }, ms);
    pendingTimersRef.current.add(id);
    return id;
  }, []);
  useEffect(() => {
    const timers = pendingTimersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  // Tab entrance animation — only used for multi-table mode with tab bar
  useEffect(() => {
    if (tables.length >= 1 && !tabEntranceComplete) {
      const timer = setTimeout(() => setTabEntranceComplete(true), 200);
      return () => clearTimeout(timer);
    } else if (tables.length > 0 && !tabEntranceComplete) {
      // Safety: always ensure content becomes visible
      setTabEntranceComplete(true);
    }
  }, [tables.length, tabEntranceComplete]);

  // Listen for table seating events from this user only
  // Type-safe bus handler types (extended beyond base BusPayloadMap)
  interface SeatedPayload {
    tableId: string;
    tableName?: string;
    seat?: number;
    userId?: string; // FIX: added so we can filter to own events only
  }
  interface LeftPayload {
    tableId: string;
  }
  interface HandPayload {
    handId: string;
    tableId: string;
    pot?: number;
  }

  // ─── Rebuild tabs from SERVER TRUTH (2026-08-15 multi-table fix) ─────
  // The add-table flow used to dead-end: the "+" button navigated to the
  // lobby, which unmounted this page and dropped every open tab (the old
  // sessionStorage persistence was removed for causing zombie tabs, and the
  // `returnToMulti` query param it navigated with was read by nothing). The
  // durable source of truth for "which tables am I playing" is the server:
  // every ACTIVE SEAT (table_seats.left_at IS NULL) becomes a tab, additively
  // merged so observer-only tabs (open via URL, not seated) are never
  // removed. Seat at a 2nd/3rd/4th table in the lobby, come back, and every
  // seat is a tab again — the PokerBros flow.
  const droppedRef = useRef(0);
  /** True once the server-truth rebuild has completed (or failed) at least
   *  once. Gates the drill-in restore; see DRILL_IN_KEY. */
  const [tablesReady, setTablesReady] = useState(false);
  /**
   * A TABLE THE SERVER MOVED YOU OFF MUST NOT STAY ON SCREEN
   * (Dan 2026-08-28, bug 1).
   *
   * Reported: "the connection failed (or maybe the server restarted). when it
   * reconnected, it created 2 tables, and was displaying future hands on the
   * table on the left that havent yet been dealt to the table on the right."
   *
   * Reproduced from production. In `Union PKO Afternoon (PLO4)` the balancer
   * moved the hero from Table 1 seat 5 to Table 2 seat 2 at 17:30:21 — the
   * source seat's `left_at` and the destination's `joined_at` are 270ms apart,
   * so the SERVER did this correctly. The client did not follow:
   *
   *   - TABLE_SEATED fired for Table 2, so a second tab appeared;
   *   - nothing fires for the table you were moved OFF (`TABLE_LEFT` is for a
   *     leave the player initiated), so Table 1's tab stayed;
   *   - its TablePage stayed mounted, frozen on hand #3299868 — a hand with no
   *     `hand_history` row at all, because it never completed for him.
   *
   * That is the whole report: two tabs, both drawing the hero's last-delivered
   * hole cards (SeatSlot keeps those alive on purpose), one of them stopped on
   * a hand that was never finished anywhere. Which tab looks "ahead" depends
   * only on which one you are looking at.
   *
   * Two things were missing, and it takes both.
   *
   * (a) THIS REBUILD ONLY EVER ADDED. It merges seats in additively so an
   *     observer tab is never removed — right for observers, wrong for a tab
   *     that says `seated: true` about a seat the server has since closed.
   *     Those are pruned now. Observer and lobby tabs are still untouchable.
   *
   * (b) IT RAN ONCE, ON MOUNT. Its dep array is `[user?.id]`, so the one
   *     moment it most needs to re-read server truth — a reconnect after the
   *     socket dropped, which is when the client's picture is most likely to
   *     be stale — was the one moment it never ran. `seatResyncToken` is
   *     bumped by WS_CONNECTED.
   *
   * A failed read is UNKNOWN and prunes nothing: the early return on `seatErr`
   * below is load-bearing, because an empty list would otherwise read as "you
   * hold no seats" and close every table the player is sitting at.
   */
  const [seatResyncToken, setSeatResyncToken] = useState(0);
  const prunedRef = useRef(0);
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data: seatRows, error: seatErr } = await supabase
        .from('table_seats')
        .select('table_id')
        .eq('user_id', user.id)
        .is('left_at', null);
      if (cancelled || seatErr || !seatRows || seatRows.length === 0) return;
      const ids = seatRows.map((r) => r.table_id as string).filter(Boolean);
      if (ids.length === 0) return;
      const { data: tblRows } = await supabase
        .from('tables')
        // Dan 2026-08-21: game_type + max_players come along so a restored
        // tab wears its game code on the FIRST paint, not a second later.
        .select(
          'id, name, game_variant, game_type, max_players, small_blind, big_blind, tournament_id'
        )
        .in('id', ids);
      if (cancelled) return;
      setTables((prev) => {
        const known = new Set(prev.map((t) => t.id));
        const room = Math.max(0, MAX_TABLES - prev.length);
        const candidates = ids.filter((id) => !known.has(id));
        /**
         * Dan 2026-08-20 (audit): this used to `.slice(0, room)` straight off
         * the raw query order — effectively an arbitrary four when a player had
         * more live seats than the device can show, which is entirely possible
         * because the server caps CASH seats at four but never caps tournament
         * seats (registrations are uncapped by design).
         *
         * Arbitrary was the wrong four. A tournament seat cannot be walked away
         * from — miss it and you blind out of something you paid to enter —
         * while a cash seat can be left at any time with the stack refunded. So
         * tournaments are restored first, and if anything still does not fit,
         * the player is told rather than left to discover it.
         */
        const isTourney = (id: string) => !!tblRows?.find((r) => r.id === id)?.tournament_id;
        const ordered = [...candidates].sort((a, b) => {
          const ta = isTourney(a) ? 0 : 1;
          const tb = isTourney(b) ? 0 : 1;
          return ta - tb;
        });
        if (ordered.length > room) droppedRef.current = ordered.length - room;
        const additions = ordered.slice(0, room).map((id, i) => {
          const row = tblRows?.find((r) => r.id === id);
          const stakes =
            row && row.small_blind != null && row.big_blind != null
              ? `${row.small_blind}/${row.big_blind}`
              : '';
          /* Dan 2026-08-30, second pass: this row already KNOWS whether it is a
             tournament — it computed the flag for `gameCode` on the next line
             and then threw it away. Four readers depend on the tab carrying it,
             and `undefined` reads as "cash" at every one of them:

               - the sit-out toast promises a tournament player "Your Seat Is
                 Held For Up To 5 Minutes", which is not true of a seat that is
                 blinded off;
               - Sit Out All counts the tournament as a cash seat on an
                 eviction clock;
               - the profit chip aggregates it, against Dan 2026-08-30: "THE
                 PROFIT COUNTER ... SHOULD NEVER WORK OR ENGAGE OR TRACK
                 ANYTHING FOR TOURNAMENTS, THIS IS A 'CASHGAME ONLY FEATURE'";
               - the tile raise slider steps in cash increments.

             TablePage reports the flag up once its engine state loads, so each
             of those self-corrects — but only AFTER a window that starts on
             every reload, and the profit aggregation's first `compute()` runs
             inside it (then every 5s). Carrying the flag the row already has
             closes the window instead of racing it. */
          const rowIsTournament = isTournamentRow(row);
          return {
            id,
            name: formatGameTitle(row?.name as string) || `Table ${prev.length + i + 1}`,
            stakes,
            gameCode: gameCode({
              variant: row?.game_variant as string | undefined,
              isTournament: rowIsTournament,
              maxPlayers: row?.max_players as number | undefined,
            }),
            isTournament: rowIsTournament,
            isMyTurn: false,
            pot: 0,
            // Dan 2026-08-30: `kind` was omitted here, and the prune below
            // asked for it. Every other tab factory in this file sets it; this
            // one now does too, so the tabs a reload restores are
            // indistinguishable from the ones a live seat makes.
            kind: 'table' as const,
            // These ids came from table_seats WHERE left_at IS NULL, which is
            // the definition of an active seat. Nothing else in this file has
            // stronger evidence than that.
            seated: true,
          };
        });
        /**
         * PRUNE (Dan 2026-08-28, bug 1). A tab claiming `seated: true` for a
         * table that is NOT in the live seat set is a table the server moved
         * the player off, or closed under them. Its TablePage is frozen on
         * whatever it last saw.
         *
         * Only `seated` tabs. An observer tab has no seat by definition, and a
         * lobby tab is not a table — pruning either would delete something the
         * player deliberately opened.
         *
         * DAN 2026-08-30 — THIS PRUNE WAS INERT WHERE IT MATTERED MOST.
         * It used to ask `t.kind === 'table' && t.seated === true`, and the
         * `additions` built a few lines above carried NO `kind` field at all.
         * So every tab this rebuild created was exempt from the rebuild's own
         * prune — and after a page reload, rebuild-created tabs are the only
         * tabs a player has. The 2026-08-28 fix therefore did nothing in the
         * exact case it was written for: reload, reconnect, get moved, keep
         * staring at a dead felt captioned "Connection Lost, Trying To Get You
         * Back". `pruneStaleSeatedTabs` asks `!isLobbyLike` instead, which
         * needs no field to be remembered by the next tab factory, and both
         * halves are pinned behaviourally in tests/unit/tabSlots.test.ts.
         */
        const liveSeatIds = new Set(ids);
        const survivors = pruneStaleSeatedTabs(prev, liveSeatIds);
        prunedRef.current = prev.length - survivors.length;

        if (prunedRef.current === 0 && additions.length === 0) return prev;
        return [...survivors, ...additions];
      });

      /**
       * KEEP THE PLAYER ON THE TABLE THEY WERE LOOKING AT (Dan 2026-08-28,
       * section 10.6: "YOU CAN NEVER EVER AUTO CHANGE TABLES FOR A USER").
       *
       * `activeIndex` is a POSITION, and a prune above it shifts every
       * position after it down one. Leaving the index alone would therefore
       * land the player on a DIFFERENT table without them touching anything —
       * which is the auto-switch the law forbids, arriving by accident rather
       * than by design. The existing clamp only catches an index past the end,
       * not one that silently now means something else.
       *
       * So the identity is what is preserved, not the number. If the table
       * they were watching survived, follow it to its new position; that is an
       * index correction and moves nobody. If it is the one that was pruned,
       * the clamp puts them somewhere valid — there is nothing else to honour.
       *
       * Deferred a tick for the same reason the focus restore below is:
       * `tablesRef` reflects the committed array, and the setTables above has
       * not committed at this line.
       */
      if (!cancelled) {
        const watchedId = tablesRef.current[activeIndexRef.current]?.id;
        setTimeout(() => {
          if (cancelled || !watchedId) return;
          const idx = tablesRef.current.findIndex((t) => t.id === watchedId);
          if (idx !== -1 && idx !== activeIndexRef.current) setActiveIndex(idx);
        }, 0);
      }
      // Audit round 3: after a reload the rebuild used to land the player on
      // whichever seat sorted first. If the table they were LOOKING AT before
      // the reload came back, focus it. The id lives in sessionStorage; a
      // table that did not come back simply fails the lookup.
      if (!cancelled) {
        // Deferred one tick: tablesRef reflects the committed array, and the
        // setTables above has not committed yet at this line.
        setTimeout(() => {
          if (cancelled) return;
          try {
            const lastId = sessionStorage.getItem('ca_last_active_table');
            if (lastId) {
              const idx = tablesRef.current.findIndex((t) => t.id === lastId);
              if (idx > 0) setActiveIndex(idx);
            }
          } catch {
            /* private-mode storage may throw */
          }
        }, 250);
      }
      // Tell the player OUTSIDE the updater. A setTables callback must stay
      // pure — React may run it twice under StrictMode, and this file has been
      // bitten by side effects in updaters twice already (see TABLE_LEFT and
      // CLOSE_TABLE_TAB above).
      if (!cancelled && prunedRef.current > 0) {
        const n = prunedRef.current;
        prunedRef.current = 0;
        // Silently closing a table someone was playing is worse than saying
        // so. Toast layer applies the house capitalisation; no em dashes.
        toast.info(
          n === 1
            ? 'You were moved to a new table. The old one has been closed.'
            : `You were moved from ${n} tables. They have been closed.`,
          6000
        );
      }
      if (!cancelled && droppedRef.current > 0) {
        const n = droppedRef.current;
        droppedRef.current = 0;
        toast.info(
          `You have ${n} more live ${n === 1 ? 'seat' : 'seats'} than this device can show ` +
            `(${MAX_TABLES} at a time). Close a table to bring ${n === 1 ? 'it' : 'them'} in.`,
          7000
        );
      }
      /* Server truth has landed (round 3). The drill-in restore waits on this
         so a restored lobby tab is placed BESIDE the player's real seats
         rather than racing them for the last slot — and so it never wins that
         race, because a seat is worth more than a page you were reading. Set
         even when the read failed: "we tried" is the signal, and a restore
         blocked forever by a bad network is just the old bug again. */
      if (!cancelled) setTablesReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // seatResyncToken: bumped by WS_CONNECTED so a reconnect re-reads server
    // truth. See the block comment above (b).
  }, [user?.id, seatResyncToken]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ═══ THE BALANCER MOVED YOU: THE TAB FOLLOWS, IN PLACE, INSTANTLY ═══════
     Dan 2026-08-30, from the first live auto table break: the move opened the
     new table as ANOTHER tab ("that can never ever happen"), the old tab sat
     frozen on "Reconnecting To The Table" with action pointed at him and no
     buttons, the heartbeat toasted "This Table Is No Longer Running", and the
     removal notice was the CASH one ("your chips are back in your wallet").

     The server does the move right - old seat closed and new seat opened
     within ~300ms (see movedTableTabIsClosed.test.ts's production trace). The
     client just had no LIVE ear for it: the server-truth rebuild that would
     have caught it runs only on mount and reconnect. This subscription is
     that ear. On an INSERT of a hero seat row:

       - same tournament as an existing tab  -> that tab is REPLACED in place
         (same slot, active state preserved by position), so the new table
         mounts inside the very game the player is looking at, and the toast
         says what actually happened: "You Were Moved To <table>".
       - anything else -> bump the server-truth rebuild, which appends or
         prunes with all of its existing guards.

     The dead old TablePage unmounts with the swap, which is also what ends
     the frozen "Reconnecting" state and the ghost action prompts it showed. */
  const heroSeatMoveBusyRef = useRef(false);
  useEffect(() => {
    if (!user?.id) return;
    const chanKey = `hero-seat-moves-${user.id}`;
    const channel = masterBus.getOrCreateChannel(chanKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'table_seats',
          filter: `user_id=eq.${user.id}`,
        },
        (payload: { new?: { table_id?: string; left_at?: string | null } }) => {
          const row = payload.new;
          const newId = row?.table_id;
          if (!newId || row?.left_at) return;
          if (tablesRef.current.some((t) => t.id === newId)) return;
          if (heroSeatMoveBusyRef.current) return;
          heroSeatMoveBusyRef.current = true;
          void (async () => {
            try {
              const tabIds = tablesRef.current.filter((t) => !isLobbyTab(t)).map((t) => t.id);
              const { data: rows, error: rowsErr } = await supabase
                .from('tables')
                .select(
                  'id, name, game_variant, game_type, max_players, small_blind, big_blind, tournament_id'
                )
                .in('id', [newId, ...tabIds]);
              if (rowsErr) {
                /* Cannot identify the move - the rebuild path re-reads server
                   truth with its own guards rather than guessing here. */
                setSeatResyncToken((n) => n + 1);
                return;
              }
              const newRow = rows?.find((r) => r.id === newId);
              const tourId = newRow?.tournament_id as string | null | undefined;
              const oldTab = tourId
                ? tablesRef.current.find(
                    (t) =>
                      t.id !== newId &&
                      !isLobbyTab(t) &&
                      rows?.some((r) => r.id === t.id && r.tournament_id === tourId)
                  )
                : undefined;
              if (!newRow || !oldTab) {
                // Not a recognisable balancer move - let the rebuild sort it out.
                setSeatResyncToken((n) => n + 1);
                return;
              }
              const name = formatGameTitle(newRow.name as string) || 'Your New Table';
              const stakes =
                newRow.small_blind != null && newRow.big_blind != null
                  ? `${newRow.small_blind}/${newRow.big_blind}`
                  : '';
              setTables((prev) =>
                prev.map((t) =>
                  t.id === oldTab.id
                    ? {
                        id: newId,
                        name,
                        stakes,
                        gameCode: gameCode({
                          variant: newRow.game_variant as string | undefined,
                          isTournament: true,
                          maxPlayers: newRow.max_players as number | undefined,
                        }),
                        /* This branch only runs for a balancer move, which is
                           tournament-only by definition (`tourId` is required
                           above) — the same reason `gameCode` hardcodes it.
                           Carried on the tab too, so the table a player is
                           MOVED to does not spend its first seconds being
                           treated as a cash game by the sit-out toast, the
                           profit chip and the raise slider. */
                        isTournament: true,
                        isMyTurn: false,
                        pot: 0,
                        kind: 'table' as const,
                        seated: true,
                      }
                    : t
                )
              );
              toast.info(`You Were Moved To ${name}`, 6000);
            } catch {
              setSeatResyncToken((n) => n + 1);
            } finally {
              heroSeatMoveBusyRef.current = false;
            }
          })();
        }
      )
      .subscribe();
    return () => {
      try {
        masterBus.removeRegisteredChannel(chanKey);
      } catch {
        /* channel cleanup is best-effort */
      }
    };
  }, [user?.id]);

  useMasterBusSubscription('TABLE_SEATED', (payload: SeatedPayload) => {
    const e = payload;
    if (!e.tableId) return;

    // FIX: Only open a new tab if THIS user is the one being seated.
    // Without this guard, any other player joining any table on the platform
    // would spawn a rogue tab on the current user's screen.
    if (e.userId && user?.id && e.userId !== user.id) return;

    // Functional updater handles dedup check via prev.find — no closure dep needed
    setTables((prev) => {
      /* Dan 2026-08-20: an existing tab used to be returned UNCHANGED. That is
         right for the tab itself, but it means a tab the route effect created
         from a bare /table/:id URL (seated: undefined) stayed marked unseated
         even after this very event proved the hero had taken a seat there.
         Mark it and keep everything else as-is. */
      const existing = prev.find((t) => t.id === e.tableId);
      if (existing) {
        return existing.seated
          ? prev
          : prev.map((t) => (t.id === e.tableId ? { ...t, seated: true } : t));
      }

      const seatedTab: TableInstance = {
        id: e.tableId,
        name: formatGameTitle(e.tableName) || `Table ${prev.length + 1}`,
        stakes: '',
        isMyTurn: false,
        pot: 0,
        kind: 'table',
        seated: true,
      };

      // Dan 2026-08-15: if the player reached this table from a lobby tab
      // opened by the in-table "+", replace that lobby tab IN PLACE. Appending
      // instead would leave a dead lobby tab behind and consume one of the
      // four slots. Oldest lobby tab wins, which is the one they just used.
      const lobbyIdx = prev.findIndex(isLobbyTab);
      if (lobbyIdx !== -1) {
        const next = [...prev];
        next[lobbyIdx] = { ...seatedTab, name: seatedTab.name };
        return next;
      }

      if (prev.length >= MAX_TABLES) {
        // Engine seated us (tournament start, waitlist promotion) but the
        // device is full. Say so — silently dropping this used to leave the
        // player blinding out of a table they could not see.
        notifyCapReached('seated', seatedTab.id);
        return prev;
      }
      return [...prev, seatedTab];
    });
  });

  // ─── Dan 2026-08-15: in-table "+" → open a lobby tab ──────────────────
  // The old handleAddTable did `navigate('/?returnToMulti=true')`, and nothing
  // in the app ever read `returnToMulti`, so the whole multi-table container
  // unmounted and every open game was torn down. Instead we add a lobby tab
  // beside the running tables and switch to it; the other TablePage instances
  // stay mounted (hidden, not unmounted) and keep their engine sockets alive.
  // A lobby tab has no TablePage behind it, so the tab bar's X — which emits
  // TABLE_MENU_ACTION/FORCE_LEAVE_TABLE for the secure cashout path — has
  // nobody listening and the tab would be unclosable. There are no chips on a
  // lobby tab, so close it directly.
  /**
   * Dan 2026-08-19: leaving a table must CLOSE that table's tab and drop the
   * player back to the lobby — previously the tab stayed open showing the
   * table they had just left. Emitted by the session-summary close handler.
   */
  useMasterBusSubscription(
    'TABLE_MENU_ACTION',
    (payload: { tableId?: string; action?: string }) => {
      if (payload?.action !== 'CLOSE_TABLE_TAB' || !payload.tableId) return;
      // Dan 2026-08-19: this used to call setActiveIndex INSIDE the setTables
      // updater (impure updater — double-fires under StrictMode/concurrent
      // re-basing), and its index math sent anyone LEFT of the closed tab to
      // tab 0 (cur < idx fell through to the `: 0` branch). Compute from the
      // ref, update each piece of state once, keep the math exact.
      const prev = tablesRef.current;
      const idx = prev.findIndex((t) => t.id === payload.tableId);
      if (idx === -1) return;
      const next = prev.filter((t) => t.id !== payload.tableId);
      if (next.length === 0) {
        // Nothing left to play — surface the lobby so there is always
        // somewhere to go next.
        setTables([
          {
            // Dan 2026-08-20: this literal was `as TableInstance` with three
            // required fields missing, so `pot`/`stakes`/`isMyTurn` arrived at
            // TableTabBar as undefined. Construct it whole and drop the cast —
            // the cast was the only reason the compiler stayed quiet.
            id: `${LOBBY_TAB_PREFIX}${Date.now()}`,
            kind: 'lobby',
            name: 'Lobby',
            stakes: '',
            isMyTurn: false,
            pot: 0,
          },
        ]);
        setActiveIndex(0);
        return;
      }
      setTables(next);
      setActiveIndex((cur) => (cur > idx ? cur - 1 : cur === idx ? Math.max(0, cur - 1) : cur));
    }
  );

  useMasterBusSubscription(
    'TABLE_MENU_ACTION',
    (payload: { tableId?: string; action?: string }) => {
      if (!payload?.tableId || !payload.tableId.startsWith(LOBBY_TAB_PREFIX)) return;
      if (payload.action !== 'FORCE_LEAVE_TABLE' && payload.action !== 'LEAVE_TABLE') return;
      const prev = tablesRef.current;
      const idx = prev.findIndex((t) => t.id === payload.tableId);
      if (idx === -1) return;
      setTables(prev.filter((t) => t.id !== payload.tableId));
      setActiveIndex((cur) => (cur > idx ? cur - 1 : cur === idx ? Math.max(0, cur - 1) : cur));
    }
  );

  useMasterBusSubscription('OPEN_LOBBY_TAB', () => {
    const prev = tablesRef.current;
    const existingLobby = prev.findIndex(isLobbyTab);
    if (existingLobby !== -1) {
      /**
       * Already have one — focus it rather than stacking duplicates, AND put
       * it back on the lobby (Dan 2026-08-28 round 2).
       *
       * It used to focus the tab and leave `lobbyTournamentId` alone, so "+"
       * — a button whose entire meaning is "show me the games" — reopened
       * whatever tournament page the tab happened to be parked on. If that tab
       * was already active it did nothing visible at all, which reads as the
       * button being broken. Pressing "+" is a request for the lobby; give
       * them the lobby.
       */
      setTables((cur) => cur.map((t) => (isLobbyTab(t) ? clearLobbyTournaments(t) : t)));
      setActiveIndex(existingLobby);
      return;
    }
    if (prev.length >= MAX_TABLES) {
      notifyCapReached('add');
      return;
    }
    setTables([
      ...prev,
      {
        id: `${LOBBY_TAB_PREFIX}${Date.now()}`,
        name: 'Lobby',
        stakes: '',
        isMyTurn: false,
        pot: 0,
        kind: 'lobby',
      },
    ]);
    setActiveIndex(prev.length);
  });

  /**
   * Dan 2026-08-25 — OBSERVE A TABLE IN A NEW SCREEN.
   *
   * The tournament lobby's Ranking and Tables tabs let a player watch any
   * table in the event. "Watch" must never cost them a SEATED screen (chips,
   * live engine socket) — those keep dealing behind it. A free screen (lobby
   * tab, unseated observer) is a different story: see case 2.
   *
   * The ORDER of cases, and the reasoning for each, is documented on
   * `pickObserveSlot` in src/utils/tabSlots.ts, which decides it. In short:
   * focus a table already open, else take the ACTIVE tab's slot when that tab
   * is free (Dan 2026-08-30 — changing tables from the lobby must change the
   * screen you are ON), else any parked lobby tab, else append, else refuse
   * out loud. Silently doing nothing is how "the button is broken" bugs are
   * born (see the route effect below).
   */
  useMasterBusSubscription(
    'OPEN_OBSERVE_TABLE',
    (payload: { tableId: string; tableName?: string; stakes?: string }) => {
      if (!payload?.tableId) return;
      const prev = tablesRef.current;

      /* Dan 2026-08-30: "WHEN I WENT INTO THE LOBBY TO CHANGE A TABLE, IT
         DIDN'T CHANGE THE TABLE FOR THE PAGE I WAS IN, IT CREATED A NEW
         ACTION BAR AND ADDED IT IN THE FIRST SLOT."

         The choice of slot is `pickObserveSlot` (src/utils/tabSlots.ts): pure,
         and pinned by tests/unit/tabSlots.test.ts. It lived inline here until
         the missing 'active' case shipped as a bug that could only be caught
         by opening four tables by hand — the same reason swipeTargetIndex was
         lifted out of the touch handler. */
      const slot = pickObserveSlot(prev, activeIndexRef.current, payload.tableId, MAX_TABLES);

      if (slot.action === 'focus') {
        setActiveIndex(slot.index);
        return;
      }

      if (slot.action === 'full') {
        notifyCapReached('add');
        return;
      }

      const observerTab: TableInstance = {
        id: payload.tableId,
        name: formatGameTitle(payload.tableName) || `Table ${prev.length + 1}`,
        stakes: payload.stakes || '',
        isMyTurn: false,
        pot: 0,
        kind: 'table',
        // `seated` stays undefined on purpose: that is what marks this tab an
        // observer. TABLE_SEATED flips it if the player later takes a seat.
      };

      /* 'active' and 'lobby' both REPLACE a free slot; 'append' grows the
         strip. Writing by index covers all three without a branch, because
         'append' returns exactly `prev.length`. Focusing that slot is the
         response to a user gesture, so it does not violate the no-auto-switch
         law (10.6.2) — nothing here moves on its own. */
      const next = [...prev];
      next[slot.index] = observerTab;
      setTables(next);
      setActiveIndex(slot.index);
    }
  );

  useMasterBusSubscription('TABLE_LEFT', (payload: LeftPayload) => {
    const e = payload;
    if (e.tableId) {
      // Dan 2026-08-19: goToLobby() (a navigate call) used to run INSIDE the
      // setTables updater — a side effect in a function React may invoke
      // during render, and twice under StrictMode. Compute outside, then
      // apply each state change once.
      const prev = tablesRef.current;
      const closedIdx = prev.findIndex((t) => t.id === e.tableId);
      if (closedIdx === -1) return;
      const newTables = prev.filter((t) => t.id !== e.tableId);
      setTables(newTables);
      setActiveIndex((prevIdx) => {
        if (closedIdx < prevIdx) return prevIdx - 1;
        if (closedIdx === prevIdx && prevIdx > 0) return prevIdx - 1;
        return prevIdx;
      });
      // If all tables closed, return to the club lobby they came from.
      if (newTables.length === 0) goToLobby();
    }
  });

  useMasterBusSubscription(
    'HAND_COMPLETED',
    (payload: HandPayload) => {
      const e = payload;
      if (e.tableId && typeof e.pot === 'number') {
        setTables((prev) => prev.map((t) => (t.id === e.tableId ? { ...t, pot: e.pot! } : t)));
      }
    },
    { debounce: 300 }
  );

  /**
   * Dan 2026-08-20 (audit): these two handlers used to do
   * `setTables((prev) => [...prev])` with the comment "force re-render to show
   * disconnection indicator". There was no such indicator — TabInfo carries no
   * connection field and TableTabBar rendered none — so the only effect was a
   * brand-new tables array on every realtime blip, re-rendering up to four
   * mounted poker tables for no visual change and defeating the
   * same-reference optimisation in updateTableInfo (the P1-2 fix above).
   *
   * The indicator now actually exists. WS_* describes the SUPABASE REALTIME
   * link (see supabaseConnectionWatchdog — the payload is a url, not a
   * tableId), so it is surfaced honestly as ONE global chip rather than faked
   * per-tab.
   */
  const [realtimeDown, setRealtimeDown] = useState(false);
  useMasterBusSubscription('WS_DISCONNECTED', () => setRealtimeDown(true));
  useMasterBusSubscription('WS_RECONNECTING', () => setRealtimeDown(true));
  useMasterBusSubscription('WS_CONNECTED', () => {
    setRealtimeDown(false);
    // Dan 2026-08-28 bug 1: a reconnect is exactly when this client's picture
    // of "which tables am I at" is most likely to be stale — the balancer may
    // have moved the player while the socket was down. Re-read server truth.
    setSeatResyncToken((n) => n + 1);
  });

  // ─── Derived state ───────────────────────────────────────────────────
  const activeTableId = tables[activeIndex]?.id || '';

  // 2026-08-15 multi-table fix: the tab countdown ticks off the server
  // deadline. One 1s clock runs only while some table has a live turn.
  const [nowMs, setNowMs] = useState(() => Date.now());
  /**
   * Dan 2026-08-21: "ALL CLOCKS, COUNTDOWNS AND WARNINGS NEED TO STILL BE
   * WORKING ALL AT THE SAME TIME." The 1s clock used to run only while some
   * table had a TURN. A background table's discard / insurance / RIT offer or
   * a burning time bank left it stopped, so nothing counted down anywhere.
   */
  /* 2026-08-29: a SIT-OUT clock is the fourth thing that has to keep counting.
     It was not in this list, so the tab's SEAT countdown and the dock's
     sit-out urgency would both have frozen at whatever second the last turn
     ended — which is precisely when a sat-out player has nothing else running.
     The most important clock on the page was the one that stopped. */
  const anyTurnLive = tables.some(
    (t) =>
      (t.isMyTurn && t.turnDeadlineMs !== undefined) ||
      // An expired decision is not a live clock (2026-09-04 second sweep).
      (parseTimed(t.decision)?.at ?? 0) > nowMs ||
      !!t.timeBank ||
      t.sitOutDeadlineMs !== undefined
  );
  useEffect(() => {
    if (!anyTurnLive) return;
    const iv = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [anyTurnLive]);
  const secondsLeft = useCallback(
    (t: TableInstance): number | undefined =>
      t.isMyTurn && t.turnDeadlineMs !== undefined
        ? Math.max(0, Math.ceil((t.turnDeadlineMs - nowMs) / 1000))
        : undefined,
    [nowMs]
  );

  /** Parse a reported "kind:deadlineMs" channel into its parts. */
  const parseTimed = (v?: string): { kind: string; at: number } | null => {
    if (!v) return null;
    const i = v.lastIndexOf(':');
    if (i <= 0) return null;
    const at = Number(v.slice(i + 1));
    return Number.isFinite(at) && at > 0 ? { kind: v.slice(0, i), at } : null;
  };

  const tabInfos: TabInfo[] = useMemo(
    () =>
      tables.map((t) => {
        /**
         * PokerBros parity (Dan 2026-08-20): fraction of the turn clock left,
         * 0..1, driving the depleting bar under the tab. nowMs ticks at 1s
         * while any turn is live; a CSS linear width transition smooths the
         * steps. undefined when it is not the hero's turn at that table.
         */
        let turnProgress: number | undefined;
        if (t.isMyTurn && t.turnDeadlineMs !== undefined && t.turnStartMs !== undefined) {
          const total = t.turnDeadlineMs - t.turnStartMs;
          if (total > 0) {
            turnProgress = Math.max(0, Math.min(1, (t.turnDeadlineMs - nowMs) / total));
          }
        }
        return {
          id: t.id,
          name: t.name,
          stakes: t.stakes,
          isMyTurn: t.isMyTurn,
          timeRemaining: secondsLeft(t),
          turnProgress,
          pot: t.pot,
          holeCards: t.holeCards,
          lastAction: t.lastAction,
          folded: t.folded,
          handResult: t.handResult,
          sittingOut: t.sittingOut,
          /* Precomputed here, like every other countdown this bar renders. */
          sitOutSecondsLeft:
            t.sitOutDeadlineMs === undefined
              ? undefined
              : Math.max(0, Math.ceil((t.sitOutDeadlineMs - nowMs) / 1000)),
          /* OBSERVING vs PLAYING. The bar goes quiet on a table the hero holds
             no seat at (Dan 2026-08-26). `seated` is the only server-truth
             answer to that question -- it is set by TABLE_SEATED and by the
             rebuild that reads table_seats WHERE left_at IS NULL, and by
             nothing else. */
          seated: t.seated,
          // TablePage's value is authoritative; until it lands, recover what
          // the table NAME says so the box is never unlabeled.
          gameCode: t.gameCode || gameCodeFromName(t.name),
          ...(() => {
            // A non-turn decision (discard / insurance / RIT) and a burning
            // time bank each get their own countdown, computed from the same
            // 1s clock as the turn timer so all tables tick together.
            const raw = parseTimed(t.decision);
            // A DECISION THAT HAS EXPIRED IS NOT A DECISION (Dan 2026-09-04):
            // a leaked RIT deadline read as "RUN IT / 0s Left", red, on that
            // tab for the rest of the session. The clamp below turned a past
            // instant into a permanent zero. Past is gone; the tab shows
            // nothing. (The leak itself is closed in TablePage; this is the
            // strip refusing to display a clock that has already run out.)
            const d = raw && raw.at > nowMs ? raw : null;
            const tb = parseTimed(t.timeBank);
            const secs = (at: number) => Math.max(0, Math.ceil((at - nowMs) / 1000));
            return {
              decisionKind: d ? (d.kind as TabInfo['decisionKind']) : undefined,
              decisionSecondsLeft: d ? secs(d.at) : undefined,
              timeBankSecondsLeft: tb ? secs(tb.at) : undefined,
            };
          })(),
        };
      }),
    [tables, secondsLeft, nowMs]
  );

  /**
   * ─── Background-table urgency alert (audit 2026-08-20) ─────────────────
   * The bell (playTurnAlert) rings when a turn STARTS on any table, and the
   * tick-tock warning loop is deliberately owned by the ACTIVE TablePage only
   * (four instances sharing the singleton loop used to fight over it — see
   * the AUDIT-2 note in TablePage). That left one hole: a background table's
   * clock entering its final seconds made no sound at all. One-shot per turn,
   * on the rising edge of the <=6s window, for non-active tabs only — the
   * active tab's own warning loop covers itself. (2026-08-28: this bell is
   * now the player's cue to switch BY THEMSELF — the auto-switch that used
   * to yank focus at <5s is deleted under the NO AUTO TABLE SWITCHING law
   * below.) Keyed by the turn's deadline so the same turn never re-alerts,
   * even across re-renders.
   */
  /**
   * Dan 2026-08-21: "THE TABLE BOX AT THE TOP OF A PAGE SHOULD START FLASHING
   * AND HAPTICS KICK IN WHEN A USER ONLY HAS 5 SECONDS LEFT TO MAKE A
   * DECISION."
   *
   * Two changes from the first version, both of which were real holes:
   *   - it only alarmed a table the player was NOT looking at. The clock on
   *     the focused table can run out just as easily while they read another
   *     one, so every table alarms now.
   *   - it only knew about TURNS. A discard / insurance / RIT clock is just as
   *     expensive to miss, so any timed decision alarms.
   * Keyed by deadline, so one alarm per decision, never a repeat.
   */
  const urgentAlertedRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const t of tables) {
      if (isLobbyTab(t)) continue;
      const raw = parseTimed(t.decision);
      // Expired decisions do not alarm (2026-09-04 second sweep): the old
      // `left < 0` guard let `Math.ceil` of a value in (-1, 0) - which is -0,
      // and -0 < 0 is false - through, so every RIT offer that timed out
      // buzzed the player the second it stopped mattering.
      const d = raw && raw.at > nowMs ? raw : null;
      const deadline =
        d?.at ?? (t.isMyTurn && t.turnDeadlineMs !== undefined ? t.turnDeadlineMs : undefined);
      if (deadline === undefined) continue;
      const left = Math.ceil((deadline - nowMs) / 1000);
      if (left > 5 || left <= 0) continue;
      if (urgentAlertedRef.current.get(t.id) === deadline) continue;
      urgentAlertedRef.current.set(t.id, deadline);
      if (soundService.isEnabled()) soundService.playTimerWarning();
      haptic.strong();
    }
    const live = new Set(tables.map((t) => t.id));
    for (const id of urgentAlertedRef.current.keys()) {
      if (!live.has(id)) urgentAlertedRef.current.delete(id);
    }
  }, [tables, nowMs]);

  // ─── Soft ping when a turn STARTS on a background table (batch 2) ─────
  // Three alert tiers now exist: soft ping (background turn start, here),
  // bell (active-table turn start, TablePage), tick-tock + one-shot warning
  // (final seconds). Rising edge per table; pruned with the tabs.
  const prevTurnMapRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      const was = prevTurnMapRef.current.get(t.id) ?? false;
      // Audit round 3: while the container is hidden (cashier, lobby, any
      // other route) the ACTIVE table's bell is muted by its isActive gate,
      // which left that one table's turn start completely silent. Hidden
      // means no tab is really "in front", so ping for all of them.
      if (t.isMyTurn && !was && (hidden || i !== activeIndex)) {
        if (soundService.isEnabled()) soundService.playChatMessage();
        haptic.light();
      }
      prevTurnMapRef.current.set(t.id, t.isMyTurn);
    }
    const live = new Set(tables.map((t) => t.id));
    for (const id of prevTurnMapRef.current.keys()) {
      if (!live.has(id)) prevTurnMapRef.current.delete(id);
    }
  }, [tables, activeIndex, hidden]);

  /* ═══════════════════════════════════════════════════════════════════════
     NO AUTO TABLE SWITCHING — LAW (Dan 2026-08-28, binding, NO EXCEPTIONS)

     Verbatim: "YOU CAN NEVER EVER AUTO CHANGE TABLES FOR A USER, THEY MUST
     CHANGE IT BY THEM SELF."

     TWO features used to move `activeIndex` without a user gesture, and both
     are deleted under this law:

       1. The URGENCY AUTO-SWITCH (setting key multi underscore auto_switch):
          when any background table's turn clock fell under 5 seconds, the
          view yanked itself to that table. This is the behaviour Dan
          reported: "IT AUTO CHANGES TABLES, OR AUTO SWIPES TO THE TABLE
          RUNNING OUT OF TIME... THAT CAN NOT HAPPEN."
       2. The ACTION QUEUE (setting key multi underscore action_queue): the
          moment the hero's turn ended on the focused table, the view
          advanced itself to the next table waiting on them.

     Both settings' DB columns still exist but are DEAD; the toggles are gone
     from the settings panel and their keys are tombstoned in
     useUserTableSettings. DO NOT WIRE THEM BACK. Every SIGNAL survives — the
     background-urgency bell, the tab flash + haptics at 5s, the browser-tab
     retitle. Only the MOVE is forbidden: `setActiveIndex` may only ever run
     from the player's own gesture (tab tap, swipe, Take Seat, opening or
     closing a tab, restoring their own last-active tab at mount) or the
     index-bounds repair when the tables array shrinks.

     tests/no-auto-table-switch.law.test.ts pins this file to the rule.
     ═══════════════════════════════════════════════════════════════════════ */

  // ─── Backgrounded-browser alerts (batch 2) ────────────────────────────
  // Everything above assumes the app is visible. When the BROWSER tab is
  // hidden and a table needs the hero, flip the page title, badge the
  // favicon, and (when permission is already granted - never prompt from
  // here) post one Notification per turn. All restored on visibility.
  const notifiedDeadlineRef = useRef<Map<string, number>>(new Map());
  // 2026-08-21: Notifications now ride the multi_desktop_alerts setting (the
  // settings toggle is also the permission-request gesture). Ref, because the
  // alerts effect below is deliberately mount-once.
  const desktopAlertsRef = useRef(false);
  useEffect(() => {
    desktopAlertsRef.current = userSettings.multi_desktop_alerts;
  }, [userSettings.multi_desktop_alerts]);
  useEffect(() => {
    const iconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    let originalTitle = document.title;
    let originalIcon = iconLink?.href ?? null;
    const BADGE_ICON =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
          '<text y=".9em" font-size="90">♠</text>' +
          '<circle cx="78" cy="24" r="20" fill="#ef4444"/></svg>'
      );

    /**
     * AUDIT 2026-08-25 — THIS OWNED THE PAGE TITLE FOR THE WHOLE SESSION.
     *
     * The `else` branch ran once a second and assigned
     * `document.title = originalTitle` unconditionally, where `originalTitle`
     * is whatever the title happened to be when this component mounted. This
     * container is mounted ONCE at the app root by PersistentTableLayer and
     * never unmounts, so from that moment on every other page's title (and the
     * favicon) was overwritten every second, everywhere in the app. Any route
     * or component that sets a title was silently reverted within 1000ms.
     *
     * The restore now only happens when THIS effect is the one that changed
     * them, which is what "restore" was supposed to mean.
     */
    let badged = false;

    const apply = () => {
      const live = tablesRef.current.filter((t) => !isLobbyTab(t));
      const urgent = live
        .filter((t) => t.isMyTurn)
        .sort((a, b) => (a.turnDeadlineMs ?? Infinity) - (b.turnDeadlineMs ?? Infinity))[0];
      if (document.visibilityState === 'hidden' && urgent) {
        // Remember what the page was called just before WE renamed it, so the
        // restore hands back the CURRENT title rather than a mount-time one.
        if (!badged) {
          originalTitle = document.title;
          originalIcon = iconLink?.href ?? originalIcon;
          badged = true;
        }
        document.title = `YOUR TURN - ${urgent.name}`;
        if (iconLink) iconLink.href = BADGE_ICON;
        if (
          desktopAlertsRef.current &&
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted' &&
          urgent.turnDeadlineMs !== undefined &&
          notifiedDeadlineRef.current.get(urgent.id) !== urgent.turnDeadlineMs
        ) {
          notifiedDeadlineRef.current.set(urgent.id, urgent.turnDeadlineMs);
          try {
            const n = new Notification('Your Turn', {
              body: urgent.name,
              tag: `ca-turn-${urgent.id}`,
            });
            n.onclick = () => {
              window.focus();
              n.close();
            };
          } catch {
            /* notification construction can throw on some platforms */
          }
        }
      } else if (badged) {
        badged = false;
        document.title = originalTitle;
        if (iconLink && originalIcon) iconLink.href = originalIcon;
      }
    };

    const iv = setInterval(apply, 1000);
    document.addEventListener('visibilitychange', apply);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', apply);
      if (badged) {
        document.title = originalTitle;
        if (iconLink && originalIcon) iconLink.href = originalIcon;
      }
    };
  }, []);

  // ─── Batch 3: per-table mute ──────────────────────────────────────────
  // An audio decision only: the muted table stays fully live and visible.
  const [mutedIds, setMutedIds] = useState<string[]>([]);

  // ─── Batch 3: tab quick actions (long-press menu in the tab bar) ──────
  const handleQuickAction = useCallback(
    async (tabId: string, action: 'sitout' | 'back' | 'leave' | 'mute') => {
      switch (action) {
        case 'mute':
          setMutedIds((prev) =>
            prev.includes(tabId) ? prev.filter((id) => id !== tabId) : [...prev, tabId]
          );
          break;
        case 'leave':
          // The secure cashout path - the owning TablePage handles teardown.
          masterBus.emit('TABLE_MENU_ACTION', { tableId: tabId, action: 'FORCE_LEAVE_TABLE' });
          break;
        case 'sitout': {
          const res = await setSitOut(tabId, true);
          if (res?.success) {
            /* SAY WHAT WAS JUST STARTED. "Sitting Out" alone omits the only
               part with a consequence: on a cash table this begins a
               five-minute clock that ends with the seat gone and the stack
               cashed out. The tab now carries the countdown, but the toast is
               what the player is looking at in the moment they tap. */
            toast.info(sitOutStartedMessage(tablesRef.current, tabId), 3500);
          } else {
            toast.error(res?.error || 'Could Not Sit Out', 4000);
          }
          break;
        }
        case 'back': {
          const res = await setSitOut(tabId, false);
          if (res?.success) {
            toast.info('Back In The Game', 2500);
          } else {
            toast.error(res?.error || 'Could Not Return', 4000);
          }
          break;
        }
      }
    },
    [toast]
  );

  // ─── Batch 3: sit out everywhere / back everywhere ────────────────────
  // One tap instead of four trips through per-table menus. Direct engine
  // calls, never the per-table SIT_OUT bus action - that opens each table's
  // modal, which is exactly the ceremony this shortcut exists to skip.
  /**
   * What a single Sit Out just committed the player to, in one sentence.
   *
   * A tournament seat is held indefinitely and blinded off; a cash seat is on a
   * five-minute clock and is cashed out at the end of it. Those are different
   * enough decisions that one toast cannot describe both.
   */
  const sitOutStartedMessage = (list: TableInstance[], tabId: string): string => {
    const t = list.find((x) => x.id === tabId);
    if (t && t.isTournament) return 'Sitting Out. You Will Be Blinded Off.';
    return 'Sitting Out. Your Seat Is Held For Up To 5 Minutes.';
  };

  const handleSitOutAll = useCallback(async () => {
    const live = tablesRef.current.filter((t) => !isLobbyTab(t) && t.seated);
    if (live.length === 0) return;
    const results = await Promise.all(live.map((t) => setSitOut(t.id, true)));
    const ok = results.filter((r) => r?.success).length;
    if (ok > 0) {
      /* One tap can start SIX five-minute eviction clocks. Saying only how many
         tables were sat out leaves out the half that costs money. */
      const cashCount = live.filter((t, i) => results[i]?.success && !t.isTournament).length;
      toast.info(
        cashCount > 0
          ? `Sitting Out At ${ok} ${ok === 1 ? 'Table' : 'Tables'}. ${cashCount} Cash ${
              cashCount === 1 ? 'Seat Is' : 'Seats Are'
            } Held For Up To 5 Minutes.`
          : `Sitting Out At ${ok} ${ok === 1 ? 'Table' : 'Tables'}`,
        4500
      );
    }
    if (ok < live.length) toast.error('Some Tables Could Not Sit Out', 4000);
  }, [toast]);

  const handleBackAll = useCallback(async () => {
    const live = tablesRef.current.filter((t) => !isLobbyTab(t) && t.seated);
    if (live.length === 0) return;
    const results = await Promise.all(live.map((t) => setSitOut(t.id, false)));
    const ok = results.filter((r) => r?.success).length;
    if (ok > 0) toast.info(`Back At ${ok} ${ok === 1 ? 'Table' : 'Tables'}`, 3000);
    if (ok < live.length) toast.error('Some Tables Could Not Return', 4000);
  }, [toast]);

  // ─── Batch 5: aggregated session stats ────────────────────────────────
  // SessionStatsService already tracks per-table P&L / hands client-side;
  // this simply reads every live table's stats and presents the multi-table
  // whole: total net, total hands, combined hands/hour (total hands over the
  // LONGEST-running session - summing rates would double-count time).
  interface AggRow {
    id: string;
    name: string;
    hands: number;
    net: number;
    tracked: boolean;
  }
  const [sessionAgg, setSessionAgg] = useState<{
    rows: AggRow[];
    net: number;
    hands: number;
    handsPerHour: number;
  } | null>(null);
  const [showSessionAgg, setShowSessionAgg] = useState(false);

  /* Dan 2026-08-30: "MULTI TABLE PROFIT TRACKING" is a switch the player owns.
     OFF kills the chip and the aggregation loop entirely; ON restores it.
     Persisted per device - a preference, not account data. Also togglable by
     right-click / long-press on the chip itself. */
  const [profitTracking, setProfitTracking] = useState<boolean>(() => {
    try {
      return localStorage.getItem('ca-multi-table-profit-tracking') !== 'off';
    } catch {
      return true;
    }
  });
  const toggleProfitTracking = useCallback(() => {
    setProfitTracking((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('ca-multi-table-profit-tracking', next ? 'on' : 'off');
      } catch {
        /* preference only */
      }
      return next;
    });
    setShowSessionAgg(false);
  }, []);
  /* Long-press (mobile) support for turning the chip off. */
  const pnlPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    /* Dan 2026-08-28: the P&L tracker "should only appear once a user is
       playing MULTIPLE tables. It should never engage while playing 1 table."
       The old gate counted `tables.length`, which includes LOBBY tabs — one
       real table plus the lobby tab read as 2 and the chip appeared during
       single-table play. Count actual game tables only, here AND inside
       compute() (a tab closing between ticks must retire the chip too). */
    const liveTableCount = tables.filter((t) => !isLobbyTab(t)).length;
    /* Dan 2026-08-30: "THE PROFIT COUNTER NUMBER SHOULD NEVER WORK OR ENGAGE
       OR TRACK ANYTHING FOR TOURNAMENTS, THIS IS A 'CASHGAME ONLY FEATURE'."
       Tournament tables are excluded from the aggregation entirely - a
       tournament stack is not a cash result, and mixing the two printed a
       meaningless number. The chip therefore renders only when at least one
       CASH table is being tracked, and the whole feature obeys the
       Multi Table Profit Tracking switch. */
    if (hidden || liveTableCount < 2 || !profitTracking) {
      setSessionAgg(null);
      return;
    }
    const compute = () => {
      const live = tablesRef.current.filter((t) => !isLobbyTab(t) && !t.isTournament);
      if (live.length < 1 || tablesRef.current.filter((t) => !isLobbyTab(t)).length < 2) {
        setSessionAgg(null);
        return;
      }
      let net = 0;
      let hands = 0;
      let earliestStart = Infinity;
      const rows: AggRow[] = live.map((t) => {
        const st = sessionStatsService.getStats(t.id);
        if (!st) return { id: t.id, name: t.name, hands: 0, net: 0, tracked: false };
        net += st.profitLoss;
        hands += st.handsPlayed;
        if (st.sessionStartTime < earliestStart) earliestStart = st.sessionStartTime;
        return {
          id: t.id,
          name: t.name,
          hands: st.handsPlayed,
          net: st.profitLoss,
          tracked: true,
        };
      });
      const hours = earliestStart === Infinity ? 0 : (Date.now() - earliestStart) / 3_600_000;
      setSessionAgg({
        rows,
        net,
        hands,
        handsPerHour: hours > 0.01 ? Math.round(hands / hours) : 0,
      });
    };
    compute();
    const iv = setInterval(compute, 5000);
    return () => clearInterval(iv);
    // `tables`, not `tables.length`: a lobby tab converting into a game table
    // keeps the length constant while the live-table count changes.
  }, [hidden, tables, profitTracking]);

  // ─── Batch 4: playable tile view ──────────────────────────────────────
  // Fold / Check / Call directly from a 2x2 tile - true simultaneous play on
  // desktop. Server-authoritative exactly like the in-table buttons (the
  // engine validates turn ownership; check/call carry no client amount).
  // Raise still means focusing the table - sizing needs the full panel.
  // Fold-protect parity: when checking is free the strip offers ONLY Check,
  // so a misclick can never throw away a free hand.
  const tileActionLockRef = useRef<Map<string, number>>(new Map());
  const [tilePending, setTilePending] = useState<Record<string, boolean>>({});
  /**
   * Variant A (Dan 2026-08-30): per-tile raise slider draft. A key present =
   * the slider row is open on that tile, value = the raise-TO amount being
   * dragged. Opened by the Raise key, closed by Confirm/any action/turn end.
   */
  const [tileRaiseDraft, setTileRaiseDraft] = useState<Record<string, number>>({});
  const closeTileRaise = useCallback((tblId: string) => {
    setTileRaiseDraft((p) => {
      if (!(tblId in p)) return p;
      const n = { ...p };
      delete n[tblId];
      return n;
    });
  }, []);
  const handleTileAction = useCallback(
    async (tblId: string, action: 'fold' | 'check' | 'call' | 'raise', amount?: number) => {
      const now = Date.now();
      if (now - (tileActionLockRef.current.get(tblId) ?? 0) < 400) return;
      tileActionLockRef.current.set(tblId, now);
      setTilePending((p) => ({ ...p, [tblId]: true }));
      try {
        const res = await submitAction(tblId, user?.id || '', action, amount);
        if (!res?.success) {
          toast.error(res?.error || 'Action Failed', 3500);
        } else if (soundService.isEnabled()) {
          if (action === 'check') soundService.playCheck();
          else if (action === 'call') soundService.playChips();
          else if (action === 'raise') soundService.playRaise();
          else soundService.playFold();
        }
      } finally {
        setTilePending((p) => {
          const n = { ...p };
          delete n[tblId];
          return n;
        });
        closeTileRaise(tblId);
      }
    },
    [user?.id, toast, closeTileRaise]
  );

  // Close any open tile raise slider the moment that table's turn ends —
  // the hand moved on, so a stale draft must not linger over the next turn.
  useEffect(() => {
    setTileRaiseDraft((p) => {
      const openIds = Object.keys(p);
      if (openIds.length === 0) return p;
      let changed = false;
      const n = { ...p };
      for (const id of openIds) {
        const t = tables.find((x) => x.id === id);
        if (!t || !t.isMyTurn) {
          delete n[id];
          changed = true;
        }
      }
      return changed ? n : p;
    });
  }, [tables]);

  // ─── Batch 3: drag-to-reorder tabs ────────────────────────────────────
  // The active TABLE follows the reorder (identity, not index).
  const handleReorder = useCallback((fromId: string, toIndex: number) => {
    const prev = tablesRef.current;
    const fromIdx = prev.findIndex((t) => t.id === fromId);
    if (fromIdx === -1) return;
    const activeId = prev[activeIndexRef.current]?.id;
    const next = [...prev];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved);
    setTables(next);
    const newActive = next.findIndex((t) => t.id === activeId);
    if (newActive !== -1) setActiveIndex(newActive);
  }, []);

  // ─── Table Management ────────────────────────────────────────────────
  const handleTabSelect = useCallback(
    (tabId: string) => {
      const idx = tables.findIndex((t) => t.id === tabId);
      if (idx === -1) return;
      /**
       * `idx !== activeIndex` USED TO GATE THIS WHOLE BODY, and that was wrong
       * once the bar could be tapped from off-route (round 3).
       *
       * Off-route the container is display:none, so tapping the tab that is
       * ALREADY `activeIndex` is not a no-op from the player's point of view —
       * it is "take me back to my table", and the gate made that one tab dead.
       * The tab a player is most likely to press is the one they were last on.
       * So: only the transition animation is skipped for a same-tab press; the
       * navigation still happens.
       */
      if (idx !== activeIndex) {
        setIsTransitioning(true);
        setActiveIndex(idx);
        trackedTimeout(() => setIsTransitioning(false), 320);
      }

      // Keep the address bar on the table the player is looking at (Dan
      // 2026-08-28). A tab switch used to leave the URL naming the OLD
      // table, so the next route arrival at that stale URL painted the
      // wrong table first, and browser Back yanked the player to a tab
      // they had already left. `replace` so switching tabs does not pile
      // history entries.
      const target = tables[idx];
      if (!target) return;

      if (!isLobbyTab(target)) {
        navigate(`/table/${target.id}${tableQuery(target)}`, { replace: true });
        return;
      }

      /**
       * A LOBBY TAB HAS NO /table ROUTE OF ITS OWN, and on-route it does not
       * need one — the container is already visible, so switching to it is
       * pure state.
       *
       * OFF-ROUTE it needs one, or the tab is unreachable: the container only
       * un-hides for a /table/:tableId URL. Round 3 borrows the URL of a real
       * open table and then overrides the index the route effect derives from
       * it, via `pendingTabIndexRef`. Without that override the layout effect
       * would immediately snap `activeIndex` to the borrowed table and the
       * lobby tab would flash past. Nothing is minted: the id in the URL
       * belongs to a table the player genuinely has open, so a reload lands
       * them on that table rather than on a phantom.
       */
      if (!hidden) return;
      const host =
        tables.find((t) => t.id === lastActiveTableIdRef.current && !isLobbyTab(t)) ??
        tables.find((t) => !isLobbyTab(t));
      if (!host) return; // lobby tabs only: nothing to borrow, nothing to do
      pendingTabIndexRef.current = idx;
      navigate(`/table/${host.id}${tableQuery(host)}`, { replace: true });
    },
    [tables, activeIndex, trackedTimeout, navigate, hidden]
  );

  // ─── Batch 3: quick-join sheet on "+" ─────────────────────────────────
  // Two taps to a new seat: "+" now offers up to five joinable cash tables
  // in the player's club (same stakes as the active table first, then
  // fullest), with the full lobby one tap further. No club context yet =
  // straight to the lobby tab, exactly as before.
  interface QuickJoinRow {
    id: string;
    name: string;
    stakes: string;
    players: number;
    max: number;
    /** Short game code, shown on the row and carried onto the new tab. */
    code: string;
    /**
     * Why this row is where it is ("Favourite", "Similar Game" ...). Rendered on
     * the row so the ORDER explains itself - a ranked list whose reasoning is
     * invisible just looks like a random list.
     */
    reason?: string;
    /** Ranking tier, used to flag favourites in the UI. */
    tier?: string;
  }
  const [quickJoin, setQuickJoin] = useState<{
    open: boolean;
    loading: boolean;
    rows: QuickJoinRow[];
  }>({ open: false, loading: false, rows: [] });
  const closeQuickJoin = useCallback(
    () => setQuickJoin((q) => (q.open ? { ...q, open: false } : q)),
    []
  );

  /**
   * Escape closes the two sheets this page owns. Both already had a backdrop,
   * so they were dismissible by tap and by nothing else — and the keyboard
   * handler further down deliberately swallows 1-9 and Tab while the container
   * is visible, so a keyboard user with the quick-join sheet open had no key
   * that closed it and every number key switched the table behind it instead.
   * Registered in capture so it runs before the table-switching handler.
   */
  useEffect(() => {
    if (!quickJoin.open && !showSessionAgg) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeQuickJoin();
      setShowSessionAgg(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [quickJoin.open, showSessionAgg, closeQuickJoin]);

  /**
   * How long "Finding Games…" is allowed to sit there before we give up and
   * send the player to the lobby tab instead.
   *
   * 2026-08-23, measured on production: the two lookups below occasionally
   * never settle AND never reach the network — no `/rest/v1/tables` request is
   * issued at all, so this is not a slow query, it is the client's token path
   * stalling before a request is built. Whatever the cause, an await that
   * neither resolves nor rejects leaves the sheet spinning forever, and a
   * permanent "Finding Games…" is indistinguishable from the "+" being broken.
   * That is precisely how this was reported.
   *
   * Every other failure mode here already falls back to the lobby tab. A stall
   * now does the same, so the button always takes you somewhere. 6s is well
   * clear of the honest worst case: after the partial index landed the real
   * query returns in 139-232ms.
   */
  const QUICK_JOIN_TIMEOUT_MS = 6000;

  /**
   * How many of the club's open cash tables Quick Join reads before ranking.
   *
   * Was 30, with no ORDER BY — see the note at the query. The lobby fetches 200
   * for the same board; this matches it so the sheet and the lobby cannot
   * disagree about what exists, and it is still one indexed read
   * (idx_tables_open_by_club, 0.38ms).
   */
  const QUICK_JOIN_CANDIDATE_LIMIT = 200;

  /**
   * Resolve to `null` rather than hanging. Deliberately does not reject: the
   * callers treat null as "no data", which is the same path a failed query
   * already takes.
   */
  /* PromiseLike, not Promise: a PostgrestFilterBuilder is a thenable that only
     issues the request when it is awaited, and it has no .catch/.finally. */
  const withTimeout = useCallback(async <T,>(work: PromiseLike<T>): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), QUICK_JOIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, []);

  /**
   * UNION LAW (Dan 2026-08-23) — "if I'm playing inside a club, SHARK CLUB or
   * MIDWAY CLUB, and I click the + button and go to the lobby, it should never
   * ever ever take me to the MIDWAY UNION lobby."
   *
   * It did. `homeClubId` was `tables.club_id` verbatim, and a union's games
   * hang off the union's own HUB CLUB — so every union table reported the UNION
   * as its club. The lobby tab then rendered <ClubHomePage> for the union,
   * complete with Union Bank / rake treasury / clubs wallet, to players, agents
   * and super agents who have no business seeing any of it.
   *
   * Every write to homeClubId now goes through here. `currentClubId` is the
   * club the player ENTERED THROUGH (ClubHomePage stamps it on mount) — the
   * club their chips and rake belong to — and it wins over the table's own
   * club_id precisely so a union table cannot drag them into the union.
   */
  const commitHomeClub = useCallback(async (tableClubId: string | null) => {
    const resolved = await resolveLobbyClubId({
      viewerClubId: useUserStore.getState().currentClubId,
      tableClubId,
    });
    // null means "nothing survived the union filter" — the lobby tab falls back
    // to <HomePage>, which is a correct destination. Never store the union.
    //
    // But never DOWNGRADE either: once a real club is known, a later call with
    // a cold cache must not blank it back to null. Both call sites can fire
    // before the table lookup lands, and "no answer yet" is not "no club".
    if (resolved === null && homeClubIdRef.current !== null) return homeClubIdRef.current;
    if (homeClubIdRef.current !== resolved) {
      homeClubIdRef.current = resolved;
      setHomeClubId(resolved);
    }
    return resolved;
  }, []);

  const handleAddTable = useCallback(async () => {
    if (tables.length >= MAX_TABLES) {
      notifyCapReached('add');
      return;
    }
    /**
     * `homeClubIdRef` is filled by an ASYNC lookup of the open tables' club_id
     * (see the effect below). Press "+" before that round trip lands - which is
     * exactly what happens if you sit down and immediately add a second table -
     * and this used to fall straight through to a lobby tab. No picker, no
     * message, a tab you did not ask for: indistinguishable from the button
     * being broken.
     *
     * The club id is knowable right here without waiting: the table you are
     * looking at has one. Resolve it on demand, cache it the same way the
     * effect does, and only fall back to the lobby when there genuinely is no
     * club to pick from.
     */
    let club = homeClubIdRef.current;
    let tableClubId: string | null = null;
    {
      const active = tablesRef.current.filter((t) => !isLobbyTab(t));
      const cached = active.map((t) => clubLookupCacheRef.current.get(t.id)).find(Boolean);
      if (cached) {
        tableClubId = cached;
      } else if (active.length > 0) {
        setQuickJoin({ open: true, loading: true, rows: [] });
        try {
          const res = await withTimeout(
            supabase
              .from('tables')
              .select('id, club_id')
              .in(
                'id',
                active.map((t) => t.id)
              )
          );
          const data = res?.data;
          for (const row of (data ?? []) as { id: string; club_id: string | null }[]) {
            if (row.club_id) clubLookupCacheRef.current.set(row.id, row.club_id);
          }
          tableClubId =
            active.map((t) => clubLookupCacheRef.current.get(t.id)).find(Boolean) ?? null;
        } catch {
          tableClubId = null;
        }
      }
      // UNION LAW: the table's club_id is the UNION on any union game, so it is
      // a candidate here, never the answer. See commitHomeClub.
      if (!club) club = await commitHomeClub(tableClubId);
    }
    if (!club && !tableClubId) {
      // Genuinely nothing to pick from — no club behind any open table.
      // Dan 2026-08-15: was `navigate('/?returnToMulti=true')` (dead param,
      // container unmounted). The lobby TAB keeps every game mounted.
      setQuickJoin({ open: false, loading: false, rows: [] });
      masterBus.emit('OPEN_LOBBY_TAB', {});
      return;
    }
    setQuickJoin({ open: true, loading: true, rows: [] });
    try {
      const openIds = new Set(tablesRef.current.map((t) => t.id));
      const activeStakes = tablesRef.current[activeIndexRef.current]?.stakes || '';
      const activeTableId = tablesRef.current[activeIndexRef.current]?.id || null;
      /* Dan 2026-08-23: "quick join should be users favorite games, or similar
         games to the one they are playing."

         The favourites read runs ALONGSIDE the table list, not before it, and
         through the same withTimeout. Ordering these would put a second network
         round trip in front of the sheet, and a favourites table that is slow or
         empty must only cost you the ORDER - never leave you looking at
         "Finding Games..." forever, which is the failure this sheet already had
         once (#526). A null here degrades to an unfavourited ranking. */
      /* ── THE SCOPE BUG THAT EMPTIED THIS SHEET (Dan 2026-08-26) ───────────
         "WHEN YOU CLICK THE + BUTTON ON THE GAME PAGE, AND GET THE QUICK JOIN
          POP UP, THATS NOT WORKING."

         It said "No Open Seats Right Now" while the club had 44 open cash
         tables and 25 of them had a free seat, including three other 1/2 PLO5
         games — the exact match the player was asking for.

         The cause is that this query scoped to `club`, which is
         `commitHomeClub`'s answer: deliberately NEVER a union, because sending
         a player into the union hub's lobby would show them the union treasury
         (UNION LAW, above). That rule is right for NAVIGATION and wrong as a
         DATA SCOPE. Every one of Midway's tables carries
         `club_id = <Midway Union>`, so filtering on the player's entry club
         matched nothing at all, every time, for every union player. An empty
         result and "there are no seats" are not the same sentence, and this
         sheet has been saying the second one on behalf of the first.

         Scoping to BOTH ids fixes it without touching UNION LAW: the union hub
         (from `tables.club_id`) is where the games live, the entry club is
         where a standalone club's games live, and RLS still decides what this
         viewer may see either way. `club` continues to be the navigation
         answer and is not used for scoping any more. */
      const scopeClubIds = Array.from(new Set([tableClubId, club].filter(Boolean) as string[]));

      const [res, favIds] = await Promise.all([
        withTimeout(
          supabase
            .from('tables')
            .select(
              'id, name, game_variant, game_type, small_blind, big_blind, max_players, current_players, status'
            )
            .in('club_id', scopeClubIds)
            .is('tournament_id', null)
            .neq('status', 'closed')
            // Audit round 3: soft-deleted tables kept their status and listed as
            // joinable. NULL must count as not-deleted, hence NOT IS TRUE.
            .not('is_deleted', 'is', true)
            /* ORDERED, AND NOT THIRTY. `.limit(30)` with no `.order()` is a
               lottery: PostgREST returns whatever rows the scan reaches first,
               so on this 44-table club fourteen tables were invisible to Quick
               Join at random — and if the ones it missed were the player's own
               stakes, the sheet reported them as not existing. It also lost the
               ACTIVE table's row often enough to matter, and without that row
               `currentTable.variant` is null, which files every candidate under
               'other' and quietly disables the entire same-game ranking.
               Ordering by seats free first, then by table id for determinism,
               and lifting the cap to the lobby's own 200 makes the fetch cover
               a real club instead of sampling it. */
            .order('current_players', { ascending: false })
            .order('id', { ascending: true })
            .limit(QUICK_JOIN_CANDIDATE_LIMIT)
        ),
        withTimeout(fetchFavoriteTableIds(user?.id)).catch(() => null),
      ]);
      if (res === null) {
        // Stalled, not empty. "No Open Seats Right Now" would be a lie and a
        // spinner would be worse: take the same exit as a failed query.
        setQuickJoin({ open: false, loading: false, rows: [] });
        masterBus.emit('OPEN_LOBBY_TAB', {});
        return;
      }
      const all = res.data ?? [];
      /* The table you are AT, read from this same result set rather than from
         the open tab. TableInstance carries only a stakes label, so the variant -
         the thing that decides whether another game is "similar" - is not on it.
         Guessing it from the label is how a PLO player got offered Hold'em. */
      type CandidateRow = (typeof all)[number];
      let activeRow: CandidateRow | undefined = activeTableId
        ? all.find((r) => r.id === activeTableId)
        : undefined;

      /* THE ACTIVE ROW IS LOAD-BEARING, SO ASK FOR IT DIRECTLY IF IT IS MISSING.
         Everything below measures candidates AGAINST this row: without its
         `game_variant` every table falls into the 'other' tier and the entire
         same-game / same-stakes ranking silently switches itself off. The
         200-row fetch above will contain it in any ordinary club, but a union
         hub running more than 200 open tables is exactly the shape this
         platform has, and "usually present" is not a basis for a ranking.
         One indexed lookup by primary key, on the rare miss only, and a failure
         here still degrades to the label parse rather than breaking the sheet. */
      if (activeTableId && !activeRow) {
        const one = await withTimeout(
          supabase
            .from('tables')
            .select(
              'id, name, game_variant, game_type, small_blind, big_blind, max_players, current_players, status'
            )
            .eq('id', activeTableId)
            .maybeSingle()
        ).catch(() => null);
        if (one?.data) activeRow = one.data as CandidateRow;
      }

      const activeVariant = (activeRow?.game_variant as string | undefined) ?? null;
      const currentTable = {
        id: activeTableId,
        variant: activeVariant,
        bigBlind:
          activeRow?.big_blind != null
            ? Number(activeRow.big_blind)
            : bigBlindFromStakesLabel(activeStakes, activeVariant),
      };

      /* A MISSING SEAT CAP IS NOT A FULL TABLE. This read
         `current_players < (max_players || 0)`, so any row whose `max_players`
         was null or 0 evaluated `0 < 0` and was dropped as though it were
         full — a data gap presenting as "no seats". Unknown capacity now keeps
         the row: the seat is validated on join anyway, and offering a table
         that turns out to be full is recoverable in one tap, while hiding a
         table that has seats is the bug being fixed here. */
      const hasRoom = (r: { current_players?: unknown; max_players?: unknown }) => {
        const cap = Number(r.max_players);
        if (!Number.isFinite(cap) || cap <= 0) return true;
        return (Number(r.current_players) || 0) < cap;
      };

      const ranked = rankQuickJoinTables(
        all.filter(hasRoom).map((r) => ({
          id: r.id as string,
          name: formatGameTitle(r.name as string) || 'Table',
          variant: (r.game_variant as string | undefined) ?? null,
          smallBlind: r.small_blind != null ? Number(r.small_blind) : null,
          bigBlind: r.big_blind != null ? Number(r.big_blind) : null,
          players: Number(r.current_players) || 0,
          maxPlayers: Number(r.max_players) || 0,
        })),
        {
          favoriteTableIds: favIds ?? [],
          currentTable,
          // Tables already open in a tab are not an offer to open a tab.
          excludeIds: Array.from(openIds),
          limit: 5,
        }
      );

      const byId = new Map(all.map((r) => [r.id as string, r]));
      const rows: QuickJoinRow[] = ranked.map((t) => {
        const r = byId.get(t.id);
        return {
          id: t.id,
          name: t.name,
          /* THE SAME TABLE MUST NOT READ TWO WAYS. This interpolated the raw
             columns, so a table the lobby lists as "0.50/1" appeared here as
             "0.5/1", and a FIXED LIMIT table -- whose stakes ARE its bet sizes,
             not its blinds -- was labelled with its blinds and so read as half
             the game it is. `stakesLabel` is the formatter the lobby already
             uses (lobbyEntries.ts:19); this is now the same call. The string
             also travels onto the new tab as `?stakes=`, so a wrong label here
             became a wrong label on the table itself. */
          stakes:
            t.smallBlind != null && t.bigBlind != null
              ? stakesLabel(
                  Number(t.smallBlind),
                  Number(t.bigBlind),
                  (r?.game_variant as string | undefined) ?? null
                )
              : '',
          players: Number(t.players) || 0,
          max: Number(t.maxPlayers) || 0,
          code: gameCode({
            variant: (r?.game_variant as string | undefined) ?? undefined,
            isTournament: r?.game_type === 'tournament',
            maxPlayers: Number(t.maxPlayers) || undefined,
          }),
          reason: t.reason,
          tier: t.tier,
        };
      });
      setQuickJoin((q) => (q.open ? { open: true, loading: false, rows } : q));
    } catch {
      // Query failed - fall back to the lobby tab rather than a dead sheet.
      setQuickJoin({ open: false, loading: false, rows: [] });
      masterBus.emit('OPEN_LOBBY_TAB', {});
    }
  }, [tables.length, notifyCapReached, withTimeout, commitHomeClub, user?.id]);

  const handleQuickJoinPick = useCallback(
    (row: QuickJoinRow) => {
      closeQuickJoin();
      navigate(
        `/table/${row.id}?name=${encodeURIComponent(row.name)}` +
          `&stakes=${encodeURIComponent(row.stakes)}` +
          (row.code ? `&code=${encodeURIComponent(row.code)}` : '')
      );
    },
    [closeQuickJoin, navigate]
  );

  const handleQuickJoinLobby = useCallback(() => {
    closeQuickJoin();
    masterBus.emit('OPEN_LOBBY_TAB', {});
  }, [closeQuickJoin]);

  // ─── Update table info (called by child TablePage instances) ─────────
  // P1-2 FIX: bail out when nothing actually changed so setTables returns the
  // SAME array reference — React then skips the re-render, which breaks the
  // parent-render → new-callback-prop → child-effect → setTables feedback loop
  // that was pegging a CPU core for as long as any table was open.
  const updateTableInfo = useCallback((tableId: string, updates: Partial<TableInstance>) => {
    setTables((prev) => {
      const idx = prev.findIndex((t) => t.id === tableId);
      if (idx === -1) return prev;
      const current = prev[idx];
      let changed = false;
      for (const key of Object.keys(updates) as (keyof TableInstance)[]) {
        if (current[key] !== updates[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev; // no-op → same reference → no re-render
      const next = prev.slice();
      next[idx] = { ...current, ...updates };
      return next;
    });
  }, []);

  // P1-2 FIX: hand each child a STABLE callback (cached per table id) rather than
  // a fresh arrow on every render. A new prop identity was re-triggering the
  // child's reporting effect on every parent render — the other half of the loop.
  const tableInfoCbRef = useRef<Map<string, (info: Partial<TableInstance>) => void>>(new Map());
  /**
   * Resolve which club the open tables belong to, so leaving lands the player
   * in that club's lobby. Cached per table id; the value is sticky so closing
   * the last tab still knows where "home" was.
   *
   * UNION LAW (Dan 2026-08-23): this used to store `tables.club_id` RAW, and a
   * union game's club_id is the union's hub club — so a SHARK CLUB player at a
   * Midway Union table got the MIDWAY UNION lobby, union skins and all. The
   * table's club is now only a candidate; commitHomeClub decides.
   */
  useEffect(() => {
    const unresolved = tables
      .filter((t) => !isLobbyTab(t))
      .map((t) => t.id)
      .filter((id) => !clubLookupCacheRef.current.has(id));
    if (unresolved.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.from('tables').select('id, club_id').in('id', unresolved);
        if (cancelled || !data) return;
        for (const row of data as { id: string; club_id: string | null }[]) {
          if (row.club_id) clubLookupCacheRef.current.set(row.id, row.club_id);
        }
        const firstKnown =
          tables
            .filter((t) => !isLobbyTab(t))
            .map((t) => clubLookupCacheRef.current.get(t.id))
            .find(Boolean) ?? null;
        if (cancelled) return;
        await commitHomeClub(firstKnown);
      } catch {
        /* lobby routing falls back to the pre-lobby */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tables, commitHomeClub]);

  /** Where to send a player who has no tables left open. */
  const goToLobby = useCallback(() => {
    const club = homeClubIdRef.current;
    navigate(club ? `/clubs/${club}` : '/');
  }, [navigate]);

  const getTableInfoCb = useCallback(
    (tableId: string) => {
      let cb = tableInfoCbRef.current.get(tableId);
      if (!cb) {
        cb = (info: Partial<TableInstance>) => updateTableInfo(tableId, info);
        tableInfoCbRef.current.set(tableId, cb);
      }
      return cb;
    },
    [updateTableInfo]
  );

  /**
   * ─── PRUNE THE PER-TABLE CACHES WHEN A TAB CLOSES (audit 2026-08-25) ──────
   *
   * `urgentAlertedRef` and `prevTurnMapRef` are already pruned on every change
   * (their effects do it inline). Four more maps keyed by table id were not,
   * and this container never unmounts, so they only ever grew: every table the
   * player opened and closed in the session left a closure, a timestamp, a
   * deadline and a club id behind for the rest of that session.
   *
   * Small individually. The one that matters is `tableInfoCbRef`, because it
   * retains a callback closing over `updateTableInfo` for a table that is gone,
   * and `notifiedDeadlineRef`, which is consulted on a 1s interval forever.
   */
  useEffect(() => {
    const liveIds = new Set(tables.map((t) => t.id));
    for (const id of tableInfoCbRef.current.keys()) {
      if (!liveIds.has(id)) tableInfoCbRef.current.delete(id);
    }
    for (const id of notifiedDeadlineRef.current.keys()) {
      if (!liveIds.has(id)) notifiedDeadlineRef.current.delete(id);
    }
    for (const id of tileActionLockRef.current.keys()) {
      if (!liveIds.has(id)) tileActionLockRef.current.delete(id);
    }
    for (const id of clubLookupCacheRef.current.keys()) {
      if (!liveIds.has(id)) clubLookupCacheRef.current.delete(id);
    }
    // Batch 3 mute list: a muted table that is closed and later reopened came
    // back silently muted with no marker anyone had set in this session.
    setMutedIds((prev) => {
      const next = prev.filter((id) => liveIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [tables]);

  /**
   * Drill into a tournament INSIDE this container, never by navigating to
   * /tournaments/:id — that route lives outside /table/:tableId, and following
   * it collapses this whole container to display:none, taking the action bar,
   * the tab strip and the Take Seat button with it while the player's other
   * tables are still dealing.
   *
   * Three cases, same as OPEN_LOBBY_TAB: reuse a parked lobby tab, else append
   * one, else say the cap is reached out loud. Returns whether it took the
   * tournament — false means the caller must fall through to a real
   * navigation rather than swallowing the tap.
   */
  const openTournamentTab = useCallback(
    (target: InTabTournamentTarget): boolean => {
      const prev = tablesRef.current;
      const lobbyIdx = prev.findIndex(isLobbyTab);
      if (lobbyIdx !== -1) {
        /* FUNCTIONAL UPDATER, not `prev.map` (round 2). `prev` is a snapshot
           read at call time, so two drill-ins landing in the same tick — a
           double tap, or the click-capture and the route backstop both firing
           for one navigation — meant the second overwrote the first's result
           with stale data. `setActiveIndex` below is already an index into an
           array whose identity cannot change here, so it stays direct. */
        setTables((cur) => cur.map((t) => (isLobbyTab(t) ? pushLobbyTournament(t, target) : t)));
        setActiveIndex(lobbyIdx);
        return true;
      }
      if (prev.length >= MAX_TABLES) {
        notifyCapReached('add');
        /* Dan 2026-08-28: returning false is not a failure to handle the tap,
           it is the honest answer. useAppNavigate falls through to a real
           navigation so the player still reaches the tournament rather than
           tapping a row that does nothing; the cap toast has already said
           why no tab opened. */
        return false;
      }
      setTables((cur) => [
        ...cur,
        {
          id: `${LOBBY_TAB_PREFIX}${Date.now()}`,
          name: 'Lobby',
          stakes: '',
          isMyTurn: false,
          pot: 0,
          kind: 'lobby',
          lobbyTournamentId: target.tournamentId,
          lobbyTournamentStack: [target],
        },
      ]);
      setActiveIndex(prev.length);
      return true;
    },
    [notifyCapReached]
  );

  /**
   * ─── THE CONTEXT THE EMBEDDED LOBBY NAVIGATES THROUGH ────────────────────
   *
   * Provided around BOTH lobby-tab branches (the club lobby and the drilled-in
   * tournament), so a satellite card inside TournamentDetails is intercepted
   * exactly like a schedule row in ClubHomePage. See InTabLobbyContext.tsx for
   * why a DOM click-capture could never do this job.
   */
  const inTabLobbyNav = useMemo<InTabLobbyNav>(
    () => ({ openTournament: openTournamentTab }),
    [openTournamentTab]
  );

  // ─── In-tab lobby rendering (Dan 2026-08-19) ─────────────────────────
  // The lobby tab shows the club's real lobby. Its cash-game cards are
  // <Link to="/table/:id"> — safe, the route effect above converts this tab
  // in place. Its TOURNAMENT cards are <Link to="/tournaments/:id">, a route
  // outside table/:tableId that would unmount this container and kill every
  // live game. Capture those clicks and drill into the tournament INSIDE the
  // tab instead. Everything else (bottom nav, cashier, ...) passes through:
  // leaving is then an explicit user choice, and the server-truth rebuild
  // restores every seat as a tab on the way back.
  const handleLobbyLinkCapture = useCallback(
    (e: React.MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      /* Round 2: parse through the SAME function useAppNavigate uses, so an
         anchor and an imperative navigate cannot disagree about a destination.
         It carries the query string too — this handler used to take `match[1]`
         and drop everything after it, which is how href="/tournaments/x?watch=1"
         arrived as a bare id and the Watch button stopped watching. */
      const target = tournamentTargetFromTo(href);
      if (!target) return;
      /* Dan 2026-08-28: this used to inline its own setTables and never touch
         activeIndex, so it and openTournamentTab could drift apart — two ways
         to do one thing, and only one of them focused the tab it filled. One
         implementation now. Only swallow the click if the container actually
         took it; at the table cap the anchor is left to navigate for real. */
      if (!openTournamentTab(target)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [openTournamentTab]
  );

  /**
   * The tab's back affordance: ONE level, not all the way out (round 2).
   *
   * This used to blank `lobbyTournamentId` outright, so a player who went
   * Main -> Satellite and pressed back landed in the club schedule rather than
   * on the Main, with no way to the Main except finding it again. Browser Back
   * could not help either: an in-tab drill-in pushes no history entry.
   */
  const popLobbyTournamentTab = useCallback((tabId: string) => {
    setTables((prev) => prev.map((t) => (t.id === tabId ? popLobbyTournament(t) : t)));
  }, []);

  /**
   * ─── TAKE SEAT (Dan 2026-08-20) ─────────────────────────────────────────
   * "when you are already sitting at a table but hit the + button to add
   *  another game and you are inside the lobby, there needs to be a 'take
   *  seat' button at the top of the page."
   *
   * The global LiveTablesBar dock covers the case where the player NAVIGATES
   * AWAY from the table container — but dockStateFor returns 'none' whenever
   * the container is visible (`if (!hidden) return { kind: 'none' }`), and the
   * in-tab lobby IS the container, visible, on /table/*. So the one route into
   * the lobby that a seated player takes most often — the in-table "+" — was
   * exactly the route with no way back to their seat except finding the right
   * tab in the tab bar. Their hand can be running while they look.
   *
   * Rendered only when a live table tab actually exists; on a lobby tab that
   * is the player's only tab there is no seat to take and no bar.
   */
  const takeSeatTarget = (() => {
    /* Dan 2026-08-20: "take seat button must never exist if you're not active
       on a table." This filtered on `!isLobbyTab(t)` — i.e. any tab that is not
       the lobby — which counts spectator tabs and bare /table/:id deep links as
       seats. `seated` is set only by TABLE_SEATED and by the table_seats
       rebuild, so an undefined value means "no evidence of a seat" and the bar
       correctly does not render. */
    const live = tables.filter((t) => !isLobbyTab(t) && t.seated === true);
    if (live.length === 0) return null;
    // Same preference order as the global dock, for one reason: a player who
    // has learnt what "return" does at the dock must not find it means
    // something different here. Turn first (a fold-out clock is running),
    // then the tab they were last on, then the oldest.
    const urgent = live
      .filter((t) => t.isMyTurn)
      .sort((a, b) => (a.turnDeadlineMs ?? Infinity) - (b.turnDeadlineMs ?? Infinity))[0];
    const target = urgent ?? live.find((t) => t.id === lastActiveTableIdRef.current) ?? live[0];
    return {
      target,
      isUrgent: Boolean(urgent),
      seconds: urgent ? secondsLeft(urgent) : undefined,
      liveCount: live.length,
    };
  })();

  const renderTakeSeatBar = () => {
    if (!takeSeatTarget) return null;
    const { target, isUrgent, seconds, liveCount } = takeSeatTarget;
    return (
      <div
        className={`multi-table-page__take-seat${isUrgent ? ' multi-table-page__take-seat--urgent' : ''}`}
      >
        <div className="multi-table-page__take-seat-info">
          <span className="multi-table-page__take-seat-label">
            {isUrgent ? 'Your Turn' : liveCount > 1 ? `${liveCount} Games Running` : 'Game Running'}
          </span>
          <span className="multi-table-page__take-seat-name">{target.name}</span>
        </div>
        <button
          type="button"
          className="multi-table-page__take-seat-btn"
          onClick={() => {
            const idx = tables.findIndex((t) => t.id === target.id);
            if (idx !== -1) setActiveIndex(idx);
          }}
        >
          Take Seat
          {isUrgent && seconds !== undefined && (
            <span className="multi-table-page__take-seat-clock">{seconds}s</span>
          )}
        </button>
      </div>
    );
  };

  /**
   * ─── ONE BAD TABLE MUST NOT TAKE THE OTHER THREE (audit 2026-08-25) ───────
   *
   * Every TablePage instance rendered here was inside a <Suspense> and inside
   * NOTHING ELSE. The only error boundary anywhere above them is the single one
   * in PersistentTableLayer, which wraps this WHOLE container — so one render
   * throw in one table unmounted all four at once, closing four live engine
   * sockets and replacing the screen with a generic error page, mid-hand.
   *
   * A boundary per slot contains it: the table that threw shows this card, and
   * the tables beside it keep dealing. Reload is a full page reload on purpose
   * — the crashed subtree's state is exactly what is not trustworthy, and the
   * server-truth rebuild (table_seats WHERE left_at IS NULL) restores every
   * seat as a tab on the way back in. The seat itself is never at risk: it
   * lives on the server, and this component crashing does not vacate it.
   */
  const tableCrashFallback = (name: string) => (
    <div className="multi-table-page__crashed" role="alert">
      <span className="multi-table-page__crashed-title">This Table Could Not Be Displayed</span>
      <span className="multi-table-page__crashed-body">
        Your Seat And Your Chips Are Safe On The Server. Your Other Tables Are Still Running.
      </span>
      <span className="multi-table-page__crashed-name">{formatGameTitle(name)}</span>
      <button
        type="button"
        className="multi-table-page__crashed-btn"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );

  /**
   * Dan 2026-08-28: BOTH branches are wrapped in InTabLobbyContext, and both
   * keep `handleLobbyLinkCapture`.
   *
   * The context is the real guard — it catches the imperative `navigate()`
   * calls that are how the lobby actually moves (see InTabLobbyContext.tsx).
   * The click-capture stays as a second net for the handful of genuine
   * `<Link to="/tournaments/:id">` anchors that still exist (GameLobbyPanel's
   * "Open Full Tournament Lobby" and its "Return To Tournament" plaque CTA),
   * which no navigate hook can see because react-router handles them itself.
   * Neither one alone covers the screen; together they cover all of it.
   *
   * The TOURNAMENT branch used to have NO capture handler at all, which is why
   * a satellite card inside the details page — TournamentLobbyCard, three
   * separate navigate calls — dumped the player off the route every time.
   */
  const renderLobbyTab = (table: TableInstance) => {
    const stack = table.lobbyTournamentStack ?? [];
    const top = stack[stack.length - 1];
    /* The back pill says where it actually goes. At depth 1 that is the club
       lobby; deeper, it is the event you drilled in FROM, and calling that
       "Lobby" was a lie that cost the player the page they wanted. */
    const backLabel = stack.length > 1 ? '← Back' : '← Lobby';
    /* No provider here any more — the whole container is inside one now (see
       the top-level return). A second, identical provider nested inside the
       first only invites the two to drift apart later. */
    return (
      <>
        {top ? (
          // Drilling into a tournament from the in-tab lobby strands the player
          // exactly as the lobby itself did, so the bar rides along. It renders in
          // normal flow above the details page; the back-pill is absolute at
          // top:10px and would otherwise sit on top of it, so that branch offsets
          // the pill (see .multi-table-page__lobby-tab--tournament in the CSS).
          <div
            className="multi-table-page__lobby-tab multi-table-page__lobby-tab--tournament"
            onClickCapture={handleLobbyLinkCapture}
          >
            {renderTakeSeatBar()}
            <button
              className="multi-table-page__lobby-back"
              onClick={() => popLobbyTournamentTab(table.id)}
              aria-label={
                stack.length > 1 ? 'Back To The Previous Tournament' : 'Back To The Lobby'
              }
            >
              {backLabel}
            </button>
            {/* `key` on the id so switching events REMOUNTS the details page.
                Without it React reuses the instance and TournamentDetails'
                load effect (keyed on the id) races its own previous fetch —
                the old event's data can land last and paint over the new one.
                `searchOverride` carries ?watch=1 in, which is the whole reason
                the WATCH button works in the tab again. */}
            <TournamentDetails
              key={top.tournamentId}
              tournamentIdOverride={top.tournamentId}
              searchOverride={top.search}
            />
          </div>
        ) : (
          <div className="multi-table-page__lobby-tab" onClickCapture={handleLobbyLinkCapture}>
            {renderTakeSeatBar()}
            {homeClubId ? <ClubHomePage clubIdOverride={homeClubId} /> : <HomePage />}
          </div>
        )}
      </>
    );
  };

  /* The urgency auto-switch that lived here is DELETED — see the NO AUTO
     TABLE SWITCHING law above. The urgency ALERT (bell, tab flash, haptics,
     browser-tab title) lives on; the focus yank does not. */

  /**
   * KEEP `activeIndex` INSIDE THE ARRAY (audit 2026-08-25).
   *
   * Six places move `activeIndex` and five places shorten `tables`, each with
   * its own index arithmetic; two of them landing in the same commit phase can
   * leave the index past the end. When that happens `tables[activeIndex]` is
   * undefined, `activeTableId` is '', NO slot matches `idx === activeIndex`, so
   * every slot takes the `display: none` branch — a completely black screen
   * with a working tab bar above it and no error anywhere. Nothing else in the
   * file would ever recover from it, because nothing else reads the pair
   * together. One clamp, after the fact, costs nothing and makes that state
   * unreachable.
   */
  useEffect(() => {
    if (tables.length === 0) return;
    if (activeIndex > tables.length - 1 || activeIndex < 0) {
      setActiveIndex(Math.max(0, Math.min(activeIndex, tables.length - 1)));
    }
  }, [tables.length, activeIndex]);

  /**
   * Tile view is only reachable at 2+ tables (the toggle is gated on it), but
   * `isTileView` was never reset when the count fell back to one. The flag then
   * sat true and invisible — no toggle rendered to turn it off — and opening a
   * second table later snapped straight into a grid the player had not asked
   * for.
   */
  useEffect(() => {
    if (tables.length <= 1 && isTileView) setIsTileView(false);
  }, [tables.length, isTileView]);

  /**
   * The aggregated-session popover is gated on `sessionAgg &&`, so when the
   * aggregate goes away (down to one table, or off /table/*) the popover
   * vanished while `showSessionAgg` stayed true — and it reappeared unbidden
   * the moment a second table was opened again.
   */
  useEffect(() => {
    if (!sessionAgg && showSessionAgg) setShowSessionAgg(false);
  }, [sessionAgg, showSessionAgg]);

  // ─── Keyboard shortcuts for table switching ───────────────────────────
  useEffect(() => {
    // Dan 2026-08-19: the container is now ALWAYS mounted; while hidden on
    // another route these shortcuts must not hijack Tab/1-4 from that page.
    if (hidden) return;
    /* Audit 2026-08-25: these shortcuts also fired THROUGH the page's own
       modal sheets. With Quick Join open, pressing 2 switched the table behind
       it and Tab cycled tabs the player could not see — a dialog whose backdrop
       stops the mouse and not the keyboard. */
    if (quickJoin.open || showSessionAgg) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // P1-5 FIX: never hijack keystrokes while the user is typing in an input,
      // textarea, select, or contenteditable (table chat, raise amount, modals),
      // and ignore shortcuts pressed with Ctrl/Meta/Alt. Shift stays allowed for
      // Shift+Tab table cycling.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      // Audit round 3 (a11y): Alt+Arrow moves the ACTIVE tab - the keyboard
      // path to reorder, matching the quick menu's Move Left/Right.
      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        e.preventDefault();
        const cur = activeIndexRef.current;
        const t = tablesRef.current[cur];
        if (t) {
          const to =
            e.key === 'ArrowLeft'
              ? Math.max(0, cur - 1)
              : Math.min(tablesRef.current.length - 1, cur + 1);
          handleReorder(t.id, to);
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Number keys 1..MAX_TABLES to switch tables. Derived from the constant
      // rather than a hardcoded '4' so the cap has exactly one definition.
      if (e.key >= '1' && e.key <= String(MAX_TABLES)) {
        const idx = parseInt(e.key) - 1;
        if (idx < tables.length) {
          setActiveIndex(idx);
        }
        return;
      }
      // Tab / Shift+Tab to cycle
      if (e.key === 'Tab') {
        e.preventDefault();
        setActiveIndex((prev) => {
          if (e.shiftKey) {
            return prev <= 0 ? tables.length - 1 : prev - 1;
          }
          return prev >= tables.length - 1 ? 0 : prev + 1;
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tables.length, hidden, handleReorder, quickJoin.open, showSessionAgg]);

  // ─── Swipe Gesture Handling ──────────────────────────────────────────
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (tables.length <= 1) return;
      const touch = e.touches[0];
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      };
    },
    [tables.length]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartRef.current || tables.length <= 1) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchStartRef.current.x;
      const dy = touch.clientY - touchStartRef.current.y;

      // Only swipe horizontally if horizontal movement > vertical
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
        /**
         * Dan 2026-08-21: "you should be able to keep swiping in one
         * direction as well - when you get to the end it should just restart
         * at the first table."
         *
         * The ends are no longer dead ends, so they no longer rubber-band at
         * 60px. They DO travel less than a mid-strip drag: there is no
         * neighbouring slot rendered past the end to slide in, so a full 40%
         * pull would drag blank felt into view. The wrap happens on release.
         */
        // The ends are no longer special: the wrap target is rendered
        // alongside them (see the slot renderer), so an edge drag has real
        // content to pull in and gets the same travel as any other.
        const travel = window.innerWidth * 0.4;
        const clamped = Math.max(-travel, Math.min(travel, dx));
        setSwipeOffset(clamped);
      }
    },
    [tables.length, activeIndex]
  );

  const handleTouchEnd = useCallback(() => {
    if (!touchStartRef.current || tables.length <= 1) {
      touchStartRef.current = null;
      return;
    }

    // Dan 2026-08-21: both directions WRAP - swiping past the last table
    // restarts at the first, and past the first lands on the last, so a
    // player can keep flicking one way and cycle their tables. The decision
    // lives in a pure helper (src/utils/swipeTarget.ts) so the wrap is unit
    // tested rather than only ever testable by thumb.
    const newIndex = swipeTargetIndex({
      activeIndex,
      count: tables.length,
      offset: swipeOffset,
      elapsedMs: Date.now() - touchStartRef.current.time,
    });

    if (newIndex !== activeIndex) {
      setIsTransitioning(true);
      setActiveIndex(newIndex);
      trackedTimeout(() => setIsTransitioning(false), 320);
      // Same URL agreement as handleTabSelect: a swipe is a tab switch by
      // thumb, and the address bar must follow the felt (Dan 2026-08-28).
      const target = tables[newIndex];
      if (target && !isLobbyTab(target)) {
        navigate(`/table/${target.id}${tableQuery(target)}`, { replace: true });
      }
    }

    setSwipeOffset(0);
    touchStartRef.current = null;
  }, [swipeOffset, activeIndex, tables, trackedTimeout, navigate]);

  // ─── Handle route-based table ID changes ─────────────────────────────
  // Dan 2026-08-19: the cash-game cards in the in-tab lobby are plain
  // <Link to="/table/:id"> elements, so "sit at a second table" arrives HERE
  // as a route change — not (yet) as TABLE_SEATED. This effect used to blindly
  // append, which stranded the lobby tab the player had just used: it sat
  // there as a dead "Lobby" tab burning one of the four slots. Convert the
  // lobby tab in place, exactly like the TABLE_SEATED handler does.
  //
  // LAYOUT effect, not a passive one (Dan 2026-08-28, "it shows the previous
  // table for a split second"). `hidden` is derived SYNCHRONOUSLY from the URL
  // (line ~224), but `tables`/`activeIndex` used to catch up in a passive
  // effect — so on the commit where the URL became /table/B, the container
  // un-hid and PAINTED the previously active, fully-populated table (real
  // seats, real pot, real cards) for one frame before this effect switched to
  // B. With two tables open and B focused, arriving at /table/A painted B
  // first — literally "a different table for a split second". A layout effect
  // runs before the browser paints, so the tab sync and the visibility flip
  // now land in the same frame and the stale table can never reach the
  // screen. The same window also flashed the "No Tables Open" empty state
  // when the first table of a session arrived by route; that is gone too.
  useLayoutEffect(() => {
    if (!routeTableId) return;
    const prev = tablesRef.current;
    /**
     * A BORROWED URL DOES NOT MEAN "FOCUS THAT TABLE" (round 3).
     *
     * `handleTabSelect` navigates to a real table's URL in order to un-hide
     * this container when the player taps a LOBBY tab from off-route. Without
     * this override the branch below would immediately focus the borrowed
     * table and the lobby tab the player actually pressed would flash past.
     * Consumed once, cleared always — including on the paths that return
     * early, so a stale intent can never redirect a later, unrelated arrival.
     */
    const pending = pendingTabIndexRef.current;
    pendingTabIndexRef.current = null;
    if (pending !== null && pending >= 0 && pending < prev.length) {
      setActiveIndex(pending);
      return;
    }
    const existingIdx = prev.findIndex((t) => t.id === routeTableId);
    if (existingIdx !== -1) {
      // Dan 2026-08-19: navigating to a table that is ALREADY mounted (dock
      // click, lobby resume link, browser back) must focus its tab — the
      // container persists now, so "arriving" is a tab switch, not a mount.
      setActiveIndex(existingIdx);
      return;
    }
    const nameFromUrl = searchParams.get('name') || `Table ${prev.length + 1}`;
    const fromUrl: TableInstance = {
      id: routeTableId,
      name: nameFromUrl,
      stakes: searchParams.get('stakes') || '',
      gameCode: searchParams.get('code') || gameCodeFromName(nameFromUrl),
      isMyTurn: false,
      pot: 0,
      kind: 'table',
    };
    const lobbyIdx = prev.findIndex(isLobbyTab);
    if (lobbyIdx !== -1) {
      const next = [...prev];
      next[lobbyIdx] = fromUrl;
      setTables(next);
      setActiveIndex(lobbyIdx); // focus the table they just picked
    } else if (prev.length < MAX_TABLES) {
      setTables([...prev, fromUrl]);
      setActiveIndex(prev.length); // Switch to new table
    } else {
      /**
       * Dan 2026-08-20 (E2E audit) — THE worst silent failure in this file.
       * At four open tables this branch did not exist: the effect just ended.
       * The URL had already changed to /table/<new>, `hidden` was therefore
       * false, and the container kept rendering whatever tab was active. The
       * player saw a different table than the address bar claimed, with no
       * error and no explanation.
       *
       * It bit tournaments hardest: TournamentDetails sends a player to their
       * seat with navigate(`/table/${myEntry.table_id}`), and the engine seats
       * tournament players without any cap (correct — registrations are
       * uncapped by design). A player at four cash tables therefore could not
       * reach the tournament they had paid to enter, and blinded out.
       *
       * Now: say exactly what is wrong, and put the URL back on the table the
       * player is actually looking at so the two can never disagree.
       */
      notifyCapReached('route');
      const current = prev[activeIndexRef.current] ?? prev[0];
      if (current && !isLobbyTab(current))
        navigate(`/table/${current.id}${tableQuery(current)}`, { replace: true });
    }
  }, [routeTableId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * ─── THE BACKSTOP: A TOURNAMENT ROUTE CANNOT STRAND OPEN TABLES ──────────
   *
   * Dan 2026-08-28: "YOUR ACTION BAR STAYS AT THE TOP 100% OF THE TIME."
   *
   * `useAppNavigate` stops this at the source, which is where it should be
   * stopped — no flash, no history entry, no unmount. But "100%" is a promise
   * about every call site that exists today AND every one somebody adds next
   * month, and an inventory of call sites is exactly the kind of thing that
   * silently goes stale (this bug IS a stale inventory: the click-capture
   * guard was written against lobby rows that were anchors, and they stopped
   * being anchors). So the route itself is the last line: land on
   * /tournaments/:id with tables open, and the container claims it back.
   *
   * Deliberately narrow, three ways:
   * - Only when tabs are actually open. With nothing running, /tournaments/:id
   *   is an ordinary page and is left completely alone.
   * - Only when `openTournamentTab` says it took it. At the table cap it
   *   returns false and the route stands, so a player can always still READ a
   *   tournament page.
   * - `replace`, and to the table the player was last looking at, so Back goes
   *   where they came from rather than bouncing between the two URLs.
   */
  useEffect(() => {
    const match = matchPath('/tournaments/:tournamentId', location.pathname);
    const tournamentId = match?.params.tournamentId;
    if (!tournamentId) return;
    const open = tablesRef.current;
    if (open.length === 0) return;
    const returnTo =
      open.find((t) => t.id === lastActiveTableIdRef.current && !isLobbyTab(t)) ??
      open.find((t) => !isLobbyTab(t));
    // Nothing but lobby tabs open: there is no /table URL to put back, and the
    // container would hide itself again the moment we redirected. Leave it.
    if (!returnTo) return;
    /* Carry the query across the recovery too (round 2). Arriving here from a
       "/tournaments/:id?watch=1" link that escaped the hook — the ticker, a
       deep link, anything outside the provider — must still watch, or the
       backstop would "rescue" the player by quietly discarding their intent. */
    if (!openTournamentTab({ tournamentId, search: location.search })) return;
    navigate(`/table/${returnTo.id}${tableQuery(returnTo)}`, { replace: true });
  }, [location.pathname, location.search, openTournamentTab, navigate]);

  /**
   * ─── THE SAME BACKSTOP FOR THE TOURNAMENT *LIST* (round 2) ───────────────
   *
   * `matchPath('/tournaments/:tournamentId')` does not match a bare
   * `/tournaments`, and TournamentStartingTicker — a marquee mounted at the app
   * root, on screen over every table — falls back to exactly that when it
   * cannot resolve an id: `if (targetId) navigate('/tournaments/'+targetId);
   * else navigate('/tournaments')`. It uses plain `useNavigate` and lives
   * outside the provider, so the else branch was a full-size, always-present
   * tap target that dropped a seated player straight off /table/*.
   *
   * The list has no in-tab renderer of its own, so the honest recovery is the
   * lobby tab, which is where a player looking for a tournament wanted to be.
   * Same three narrowings as above: only with tables open, only when there is
   * a real table to put back in the URL, and never when a lobby tab is already
   * showing (that would fight OPEN_LOBBY_TAB).
   */
  useEffect(() => {
    if (!matchPath('/tournaments', location.pathname)) return;
    const open = tablesRef.current;
    if (open.length === 0) return;
    const returnTo =
      open.find((t) => t.id === lastActiveTableIdRef.current && !isLobbyTab(t)) ??
      open.find((t) => !isLobbyTab(t));
    if (!returnTo) return;
    masterBus.emit('OPEN_LOBBY_TAB', {});
    navigate(`/table/${returnTo.id}${tableQuery(returnTo)}`, { replace: true });
  }, [location.pathname, navigate]);

  /**
   * ─── MAKE ROOM FOR THE PINNED BAR (round 3) ──────────────────────────────
   *
   * The pinned strip is `position: fixed`, so it is out of flow and would
   * otherwise sit ON TOP of the first thing on every page — a heading, a back
   * button, the cashier's balance — unreadable and untappable.
   *
   * One attribute on <body> drives the padding (see MultiTablePage.css), so
   * there is a single number to change and any page that needs to know can ask
   * the DOM rather than this component. Cleared whenever the bar is not
   * showing, and on unmount, so a stale 48px gap can never outlive it.
   */
  /**
   * Mirror the lobby tab's drill-in to storage on every change, and restore it
   * once on mount. See DRILL_IN_KEY for why this persistence is safe where the
   * deleted table persistence was not.
   */
  useEffect(() => {
    const lobby = tables.find(isLobbyTab);
    saveDrillIn(lobby?.lobbyTournamentStack);
  }, [tables]);

  const drillInRestoredRef = useRef(false);
  useEffect(() => {
    if (drillInRestoredRef.current) return;
    // Wait until the server-truth rebuild has had its say, so the restored
    // lobby tab lands BESIDE the player's real seats rather than racing them
    // for the last slot.
    if (!tablesReady) return;
    drillInRestoredRef.current = true;
    const saved = readDrillIn();
    if (!saved) return;
    // Already showing a tournament (a deep link, a fast tap): the live state
    // is newer than anything on disk and wins.
    if (tablesRef.current.some((t) => isLobbyTab(t) && t.lobbyTournamentId)) return;
    // Replay through the ordinary path so the restored tab is identical to a
    // tapped one, then re-seat the parent levels underneath the top.
    if (!openTournamentTab(saved[saved.length - 1])) return;
    if (saved.length > 1) {
      setTables((cur) =>
        cur.map((t) => (isLobbyTab(t) ? { ...t, lobbyTournamentStack: saved } : t))
      );
    }
  }, [tablesReady, openTournamentTab]);

  const pinnedBarVisible = hidden && tables.length >= 1;
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const { body } = document;
    if (!body) return;
    if (pinnedBarVisible) body.setAttribute('data-ca-pinned-bar', '1');
    else body.removeAttribute('data-ca-pinned-bar');
    return () => body.removeAttribute('data-ca-pinned-bar');
  }, [pinnedBarVisible]);

  // THE FOOTER FOLLOWS THE LOBBY (Dan 2026-09-04). The "+" lobby is a tab on
  // /table/<id>, a route the global footer is (rightly) denied on. Tell the
  // app root when the tab on screen is a lobby, so the footer shows there and
  // ONLY there - never over a live felt, never for a lobby tab parked behind
  // one, and never after this container unmounts. See inTabLobbySurface.ts.
  useEffect(() => {
    const cur = tables[activeIndex];
    publishInTabLobbyActive(!hidden && !!cur && isLobbyTab(cur));
  }, [hidden, tables, activeIndex]);
  useEffect(() => () => publishInTabLobbyActive(false), []);

  // Remember the last REAL table the player had on screen, so the dock can
  // send them back to it rather than to whichever tab happens to be oldest.
  useEffect(() => {
    if (hidden) return;
    const cur = tables[activeIndex];
    if (cur && !isLobbyTab(cur)) {
      lastActiveTableIdRef.current = cur.id;
      // Audit round 3: survive a reload. Only the ID is stored - the tab
      // itself is always rebuilt from server truth (table_seats), so a stale
      // id can never resurrect a zombie tab; it just fails the lookup.
      try {
        sessionStorage.setItem('ca_last_active_table', cur.id);
      } catch {
        /* private-mode storage may throw */
      }
    }
  }, [hidden, tables, activeIndex]);

  // ─── Global dock (Dan 2026-08-19) ────────────────────────────────────
  // While hidden on another route, the LiveTablesBar dock is the ONE global
  // affordance: "Return to game" when tables are quietly running, "Action
  // needed" (with the live countdown — nowMs already ticks whenever any
  // turn clock runs) when a hidden table waits on the hero.
  const dock = dockStateFor(tables, hidden, nowMs, lastActiveTableIdRef.current);
  const handleDockReturn = useCallback(
    (tableId: string) => {
      const idx = tablesRef.current.findIndex((t) => t.id === tableId);
      if (idx !== -1) setActiveIndex(idx);
      /* Carry the tab's own name/stakes/code (round 3). The dock knows the id
         and nothing else, but this container holds the whole tab — sending a
         bare /table/:id would drop a labelled tab back to "Table 1". */
      const t = idx !== -1 ? tablesRef.current[idx] : undefined;
      navigate(`/table/${tableId}${t ? tableQuery(t) : ''}`);
    },
    [navigate]
  );

  // ─── Render ──────────────────────────────────────────────────────────
  if (tables.length === 0) {
    // Hidden with nothing mounted: render nothing at all.
    if (hidden) return null;
    return (
      <div className="multi-table-page multi-table-page--empty">
        <p>No Tables Open</p>
        <button onClick={goToLobby}>Go To Lobby</button>
      </div>
    );
  }

  // FIX-214: CSS transforms create a new containing block for position:fixed
  // descendants, which breaks TablePage's fixed positioning (HUD, menus, overlays).
  // Only use translateX during active swipe gestures (brief/transient).
  // At rest, hide inactive slots with display:none instead.
  const isActivelySwiping = swipeOffset !== 0;
  const containerTransform = isActivelySwiping
    ? `translateX(calc(${-activeIndex * 100}% + ${swipeOffset}px))`
    : 'none';

  return (
    /**
     * THE PROVIDER WRAPS THE WHOLE CONTAINER, not just the lobby tab
     * (Dan 2026-08-28 round 2).
     *
     * Round 1 wrapped only `renderLobbyTab`, which left the felt itself
     * outside it — and the felt has its own tournament surface:
     * `TournamentLobbyModal`, opened from the upper-right button on a
     * tournament table (TablePage), which renders TournamentDetails with its
     * SatellitesTab. A satellite tap there went through plain `useNavigate`
     * and did a real route change, so the container hid, the action bar went
     * with it, and only the route backstop dragged the player back — after the
     * flash, and by yanking them off the felt they were sitting at.
     *
     * Inside the provider the same tap is handled in place, with no route
     * change at all. Nothing else changes: `useAppNavigate` is only consulted
     * by components that opted into it, and it still rewrites nothing but
     * /tournaments/:id.
     */
    <InTabLobbyContext.Provider value={inTabLobbyNav}>
      {/**
       * ─── THE BAR IS PINNED OFF-ROUTE (Dan 2026-08-28 round 3) ─────────────
       *
       * Dan, verbatim: "IF YOU ARE ON A PAGE THROUGH THE + BUTTON, THAT YOUR
       * ACTION BAR STAYS AT THE TOP 100% OF THE TIME."
       *
       * Rounds 1 and 2 delivered that by never LEAVING /table/* — they
       * intercept tournament destinations and render them in the tab. That is
       * the right answer for a destination the tab can render. It is no answer
       * at all for the ones it cannot: the club bottom nav's six links
       * (Profile, Players, Cashier, Market, Data, Stats), the create-table and
       * buy-diamonds buttons, a house ad pointing at /marketplace. Those have
       * no in-tab renderer, so interception would mean building one — and
       * REFUSING to navigate would be worse than the bug, because the player
       * asked to go to the cashier.
       *
       * So the bar stops depending on the route. Off-route the container is
       * still display:none — the felt must not paint over the cashier — but
       * the strip itself is hoisted out and fixed to the top of the viewport,
       * above whatever page the player went to. Every table stays one tap
       * away, urgency still flashes on the tab that owns it, and "100% of the
       * time" becomes literally true rather than true-for-the-destinations-we
       * -enumerated.
       *
       * This is also what makes the enumeration stop mattering. A destination
       * added next month keeps the bar without anyone remembering to add it to
       * a list — which is the failure mode that produced this whole body of
       * work (a guard written against anchors that quietly stopped matching).
       */}
      {hidden && tables.length >= 1 && (
        <div className="multi-table-page__tab-bar-wrapper multi-table-page__tab-bar-wrapper--pinned">
          <TableTabBar
            tabs={tabInfos}
            activeTabId={activeTableId}
            onTabSelect={handleTabSelect}
            onAddTable={handleAddTable}
            maxTables={MAX_TABLES}
            realtimeDown={realtimeDown}
            onReorder={handleReorder}
            mutedIds={mutedIds}
            onQuickAction={handleQuickAction}
            onSitOutAll={handleSitOutAll}
            onBackAll={handleBackAll}
            profitTrackingEnabled={profitTracking}
            onToggleProfitTracking={toggleProfitTracking}
          />
        </div>
      )}
      {/**
       * The dock stays for URGENCY ONLY now.
       *
       * It used to be the only thing a player had off-route, so it carried
       * both jobs: "return to your game" and "a clock is running". The pinned
       * strip above does the first one better — every table, not just one, and
       * in the place the player already knows. Rendering both for a quiet
       * table would be two controls saying the same thing in one screen.
       *
       * Urgency is different in kind: it is a countdown the player is about to
       * lose money to, it wants to be loud, and the dock sits at the BOTTOM,
       * within thumb reach, while the strip is at the top. Keeping it for that
       * case only is why `dock.kind === 'urgent'` replaced `!== 'none'`.
       */}
      {hidden && dock.kind === 'urgent' && (
        <LiveTablesBar
          tables={tables.filter((t) => !isLobbyTab(t)).map((t) => ({ id: t.id, name: t.name }))}
          urgent={{ tableId: dock.targetId, name: dock.name, secondsLeft: dock.secondsLeft }}
          onReturn={handleDockReturn}
        />
      )}
      <div className="multi-table-page" style={hidden ? { display: 'none' } : undefined}>
        {/* Tab Bar — Dan 2026-08-21: "that box should stay there regardless".
            It renders from the FIRST table on, not from the second: the box
            is the player's home for switching, adding and reading a table,
            and a control that appears and disappears is not a home. It also
            means opening table 2 no longer shoves the felt down by 48px
            mid-hand, which is what the old >1 condition did. */}
        {tables.length >= 1 && (
          <div className="multi-table-page__tab-bar-wrapper">
            <TableTabBar
              tabs={tabInfos}
              activeTabId={activeTableId}
              onTabSelect={handleTabSelect}
              onAddTable={handleAddTable}
              maxTables={MAX_TABLES}
              realtimeDown={realtimeDown}
              /* jackpotAmount removed 2026-08-23 with TableTabBar's JACKPOT
                 badge: the BBJ banner below the bar already shows the active
                 table's pool, and the header copy was a duplicate of it. */
              onReorder={handleReorder}
              mutedIds={mutedIds}
              onQuickAction={handleQuickAction}
              onSitOutAll={handleSitOutAll}
              onBackAll={handleBackAll}
              profitTrackingEnabled={profitTracking}
              onToggleProfitTracking={toggleProfitTracking}
            />
            {/* Batch 5: live multi-table P&L chip -> session breakdown */}
            {sessionAgg && sessionAgg.rows.some((r) => r.tracked) && (
              <button
                type="button"
                className={`multi-table-page__pnl-chip${
                  sessionAgg.net > 0
                    ? ' multi-table-page__pnl-chip--up'
                    : sessionAgg.net < 0
                      ? ' multi-table-page__pnl-chip--down'
                      : ''
                }`}
                onClick={() => setShowSessionAgg((v) => !v)}
                /* Dan 2026-08-30: "IF YOU RIGHT CLICK OR HOLD DOWN AND MOBILE,
                   YOU SHOULD BE ABLE TO TURN IT OFF." Right-click and a 600ms
                   long-press both flip the same switch the hamburger owns. */
                onContextMenu={(e) => {
                  e.preventDefault();
                  toggleProfitTracking();
                }}
                onTouchStart={() => {
                  pnlPressTimerRef.current = setTimeout(() => {
                    pnlPressTimerRef.current = null;
                    toggleProfitTracking();
                  }, 600);
                }}
                onTouchEnd={() => {
                  if (pnlPressTimerRef.current) {
                    clearTimeout(pnlPressTimerRef.current);
                    pnlPressTimerRef.current = null;
                  }
                }}
                onTouchMove={() => {
                  if (pnlPressTimerRef.current) {
                    clearTimeout(pnlPressTimerRef.current);
                    pnlPressTimerRef.current = null;
                  }
                }}
                title="Session Across Cash Tables (Right-Click Or Hold To Turn Off)"
                aria-label="Session Across Cash Tables"
              >
                {sessionAgg.net > 0 ? '+' : ''}
                {sessionAgg.net.toLocaleString('en-US')}
              </button>
            )}
            {/* Dan 2026-08-30: the 4-square multi-table button. FIXED on the
                right edge - the opposite side from the hamburger - the same
                40px size as the hamburger trigger, wearing Dan's brushed-metal
                four-screen artwork. Rendered always so the position is stable,
                but it only ENGAGES with 2+ tables open (4 max); with one
                table it is inert and dimmed. Positioning lives in
                MultiTablePage.css (.tile-toggle-btn). */}
            <button
              className={`tile-toggle-btn${tables.length > 1 ? '' : ' tile-toggle-btn--inert'}`}
              onClick={() => {
                if (tables.length > 1) setIsTileView((prev) => !prev);
              }}
              aria-disabled={tables.length <= 1}
              title={
                tables.length > 1
                  ? isTileView
                    ? 'Single View'
                    : 'Tile View'
                  : 'Open A Second Table To Use Tile View'
              }
              aria-label={isTileView ? 'Single View' : 'Tile View'}
            >
              {/* ═══ NO PLATE BEHIND THE GLYPH (Dan 2026-08-31) ══════════════
                  "Remove the little pill behind the 4 square button."

                  It was not CSS - `.tile-toggle-btn` has painted
                  `background: transparent` all along. The plate is inside the
                  ARTWORK: the source render (1254x1254, RGB, no alpha channel)
                  is a dark rounded rectangle with the four screens sitting in
                  the middle at roughly 46% of its width, so `object-fit:
                  contain` in the 40px button faithfully painted the plate too.
                  Its sibling assets (hamburger, add-screen) are transparent
                  cutouts, which is why this was the only button wearing one.

                  Drawn inline instead, so the button is the glyph and nothing
                  else - the same approach TableTabBar already uses for its "+".
                  If the artwork is ever re-exported with a transparent
                  background, this can go back to being an <img> in one line. */}
              <svg
                className="tile-toggle-btn__img"
                viewBox="0 0 48 48"
                aria-hidden="true"
                focusable="false"
              >
                <defs>
                  <linearGradient id="tileToggleMetal" x1="0" y1="0" x2="0.9" y2="1">
                    <stop offset="0%" stopColor="#fdfdfd" />
                    <stop offset="28%" stopColor="#cdd2d8" />
                    <stop offset="55%" stopColor="#8d949d" />
                    <stop offset="78%" stopColor="#b6bcc4" />
                    <stop offset="100%" stopColor="#6b727b" />
                  </linearGradient>
                </defs>
                <g fill="url(#tileToggleMetal)">
                  <rect x="5" y="5" width="17" height="17" rx="3.6" />
                  <rect x="26" y="5" width="17" height="17" rx="3.6" />
                  <rect x="5" y="26" width="17" height="17" rx="3.6" />
                  <rect x="26" y="26" width="17" height="17" rx="3.6" />
                </g>
              </svg>
            </button>
          </div>
        )}

        {/* Batch 5: aggregated session popover */}
        {showSessionAgg && sessionAgg && (
          <>
            <div
              className="multi-table-page__quickjoin-backdrop"
              onClick={() => setShowSessionAgg(false)}
            />
            <div className="multi-table-page__session-agg" role="dialog" aria-label="Session">
              <div className="multi-table-page__quickjoin-title">Session - All Tables</div>
              {sessionAgg.rows.map((r) => (
                <div key={r.id} className="multi-table-page__session-row">
                  <span className="multi-table-page__session-name">{r.name}</span>
                  <span className="multi-table-page__session-hands">
                    {r.tracked ? `${r.hands} Hands` : 'Observing'}
                  </span>
                  <span
                    className={`multi-table-page__session-net${
                      r.net > 0
                        ? ' multi-table-page__session-net--up'
                        : r.net < 0
                          ? ' multi-table-page__session-net--down'
                          : ''
                    }`}
                  >
                    {r.tracked ? `${r.net > 0 ? '+' : ''}${r.net.toLocaleString('en-US')}` : ''}
                  </span>
                </div>
              ))}
              <div className="multi-table-page__session-row multi-table-page__session-row--total">
                <span className="multi-table-page__session-name">
                  {sessionAgg.rows.length} {sessionAgg.rows.length === 1 ? 'Table' : 'Tables'}
                </span>
                <span className="multi-table-page__session-hands">
                  {sessionAgg.hands} Hands
                  {sessionAgg.handsPerHour > 0 ? ` - ${sessionAgg.handsPerHour}/Hr` : ''}
                </span>
                <span
                  className={`multi-table-page__session-net${
                    sessionAgg.net > 0
                      ? ' multi-table-page__session-net--up'
                      : sessionAgg.net < 0
                        ? ' multi-table-page__session-net--down'
                        : ''
                  }`}
                >
                  {sessionAgg.net > 0 ? '+' : ''}
                  {sessionAgg.net.toLocaleString('en-US')}
                </span>
              </div>
            </div>
          </>
        )}

        {/* Batch 3: quick-join sheet (anchored under the tab bar) */}
        {quickJoin.open && (
          <>
            <div className="multi-table-page__quickjoin-backdrop" onClick={closeQuickJoin} />
            <div className="multi-table-page__quickjoin" role="dialog" aria-label="Quick Join">
              <div className="multi-table-page__quickjoin-title">Quick Join</div>
              {quickJoin.loading ? (
                <div className="multi-table-page__quickjoin-empty">Finding Games…</div>
              ) : quickJoin.rows.length === 0 ? (
                <div className="multi-table-page__quickjoin-empty">No Open Seats Right Now</div>
              ) : (
                quickJoin.rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className="multi-table-page__quickjoin-row"
                    onClick={() => handleQuickJoinPick(row)}
                  >
                    <span className="multi-table-page__quickjoin-name">
                      {row.name}
                      {row.reason && (
                        <span
                          className={`multi-table-page__quickjoin-tag${
                            row.tier === 'favorite' ? ' multi-table-page__quickjoin-tag--fav' : ''
                          }`}
                        >
                          {row.reason}
                        </span>
                      )}
                    </span>
                    <span className="multi-table-page__quickjoin-meta">
                      {row.code && <span>{row.code}</span>}
                      {row.stakes && <span>{row.stakes}</span>}
                      <span>
                        {row.players}/{row.max}
                      </span>
                    </span>
                    <span className="multi-table-page__quickjoin-cta">Join</span>
                  </button>
                ))
              )}
              <button
                type="button"
                className="multi-table-page__quickjoin-lobby"
                onClick={handleQuickJoinLobby}
              >
                Browse Full Lobby
              </button>
            </div>
          </>
        )}

        {/* Tile View Grid or Swipe Container */}
        {isTileView && tables.length > 1 ? (
          <div
            className="multi-table-grid"
            style={{
              opacity: tabEntranceComplete ? 1 : 0,
              transform: tabEntranceComplete ? 'translateY(0)' : 'translateY(12px)',
              transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            {tables.map((table, idx) => (
              <div
                key={table.id}
                className={`multi-table-grid__cell ${idx === activeIndex ? 'multi-table-grid__cell--active' : ''}`}
                onClick={() => {
                  setActiveIndex(idx);
                  setIsTileView(false);
                }}
                style={{
                  boxShadow: idx === activeIndex ? '0 0 20px rgba(0, 212, 255, 0.3)' : 'none',
                  transition: 'box-shadow 0.3s ease',
                }}
              >
                {/* Variant A (Dan 2026-08-30): the stage is the table's OWN
                    flex row — when the band below is up, the stage shrinks and
                    the felt rescales into it, so the hero's cards (their normal
                    size, on the felt) are never covered by action chrome. */}
                <div className="multi-table-grid__stage">
                  <Suspense fallback={<div className="multi-table-loading">Loading...</div>}>
                    {isLobbyTab(table) ? (
                      renderLobbyTab(table)
                    ) : (
                      <TableErrorBoundary
                        componentName={`TablePage(tile ${table.id})`}
                        fallback={tableCrashFallback(table.name)}
                      >
                        <TablePage
                          key={table.id}
                          embeddedTableId={table.id}
                          onTableInfoUpdate={getTableInfoCb(table.id)}
                          isMultiTable={true}
                          isActive={idx === activeIndex && !hidden}
                          muted={mutedIds.includes(table.id)}
                        />
                      </TableErrorBoundary>
                    )}
                  </Suspense>
                </div>
                {/* Batch 4 strip, rebuilt as a RESERVED in-flow band (Variant A)
                    instead of an overlay: presets + Raise + slider on top,
                    Fold / Check / Call + clock underneath. Every amount is
                    still server re-validated exactly as before. */}
                {!isLobbyTab(table) &&
                  table.isMyTurn &&
                  (() => {
                    const pending = !!tilePending[table.id];
                    const toCall = table.toCall ?? 0;
                    const parts = (table.raiseBounds || '').split(':').map(Number);
                    const hasBounds =
                      parts.length === 3 &&
                      parts.every((n) => Number.isFinite(n)) &&
                      parts[1] >= parts[0] &&
                      parts[0] > 0;
                    const [minTo, maxTo, bb] = hasBounds ? parts : [0, 0, 1];
                    const draft = tileRaiseDraft[table.id];
                    const sliderOpen = hasBounds && draft !== undefined;
                    const unit = sliderUnitFor(!!table.isTournament, bb, bb / 2 || 0.01);
                    const step = betSliderStep(minTo, maxTo, unit);
                    const fmt = (n: number) =>
                      Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2);
                    return (
                      <div className="multi-table-grid__band" onClick={(e) => e.stopPropagation()}>
                        {sliderOpen && (
                          <div className="multi-table-grid__slider-row">
                            <input
                              type="range"
                              className="multi-table-grid__slider"
                              min={minTo}
                              max={maxTo}
                              step={step}
                              value={draft}
                              aria-label="Raise Amount"
                              onChange={(e) =>
                                setTileRaiseDraft((p) => ({
                                  ...p,
                                  [table.id]: Math.min(
                                    maxTo,
                                    Math.max(minTo, Number(e.target.value))
                                  ),
                                }))
                              }
                            />
                            <span className="multi-table-grid__slider-amount">
                              {fmt(draft ?? minTo)}
                            </span>
                            <button
                              type="button"
                              className="multi-table-grid__raise multi-table-grid__raise--confirm"
                              disabled={pending}
                              onClick={() => handleTileAction(table.id, 'raise', draft)}
                            >
                              Raise {fmt(draft ?? minTo)}
                            </button>
                          </div>
                        )}
                        <div className="multi-table-grid__raises">
                          {(
                            [
                              ['½ Pot', 0.5],
                              ['Pot', 1],
                            ] as const
                          ).map(([label, frac]) => {
                            const pot = table.pot ?? 0;
                            // Standard pot-raise size: call first, then raise
                            // the pot that call creates (server re-validates).
                            const size = Math.round(toCall + (pot + toCall * 2) * frac);
                            const stack = table.heroStack ?? 0;
                            const capped = stack > 0 ? Math.min(size, stack) : size;
                            if (capped <= 0) return null;
                            return (
                              <button
                                key={label}
                                type="button"
                                className="multi-table-grid__raise"
                                disabled={pending}
                                onClick={() => handleTileAction(table.id, 'raise', capped)}
                              >
                                {label}
                              </button>
                            );
                          })}
                          {hasBounds && (
                            <button
                              type="button"
                              className={`multi-table-grid__raise${sliderOpen ? ' multi-table-grid__raise--open' : ''}`}
                              disabled={pending}
                              onClick={() =>
                                sliderOpen
                                  ? closeTileRaise(table.id)
                                  : setTileRaiseDraft((p) => ({ ...p, [table.id]: minTo }))
                              }
                            >
                              Raise
                            </button>
                          )}
                          {(table.heroStack ?? 0) > 0 && (
                            <button
                              type="button"
                              className="multi-table-grid__raise multi-table-grid__raise--allin"
                              disabled={pending}
                              onClick={() => handleTileAction(table.id, 'raise', table.heroStack)}
                            >
                              All In
                            </button>
                          )}
                        </div>
                        <div className="multi-table-grid__actions">
                          {toCall > 0 ? (
                            <>
                              <button
                                type="button"
                                className="multi-table-grid__action multi-table-grid__action--fold"
                                disabled={pending}
                                onClick={() => handleTileAction(table.id, 'fold')}
                              >
                                Fold
                              </button>
                              <button
                                type="button"
                                className="multi-table-grid__action multi-table-grid__action--call"
                                disabled={pending}
                                onClick={() => handleTileAction(table.id, 'call')}
                              >
                                Call {toCall.toLocaleString('en-US')}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="multi-table-grid__action multi-table-grid__action--check"
                              disabled={pending}
                              onClick={() => handleTileAction(table.id, 'check')}
                            >
                              Check
                            </button>
                          )}
                          {secondsLeft(table) !== undefined && (
                            <span className="multi-table-grid__action-clock">
                              {secondsLeft(table)}s
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })()}
              </div>
            ))}
          </div>
        ) : (
          <div
            ref={containerRef}
            className={`multi-table-page__container ${isTransitioning ? 'multi-table-page__container--transitioning' : ''}`}
            style={{
              transform: containerTransform,
              // Single-table: always visible. Multi-table: fade in after tab bar renders.
              opacity: tabEntranceComplete ? 1 : tables.length <= 1 ? 1 : 0,
              transition:
                tabEntranceComplete && !isTransitioning && tables.length > 1
                  ? 'opacity 0.4s ease'
                  : 'none',
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            {tables.map((table, idx) => {
              // FIX-214: When not swiping, only render the active slot.
              // During swipe, render adjacent slots for the swipe animation.
              const isActive = idx === activeIndex;
              const isAdjacent = Math.abs(idx - activeIndex) <= 1;
              /**
               * Dan 2026-08-21: the wrap SLIDES now, it does not snap.
               *
               * The strip is laid out left-to-right and translated by
               * -activeIndex*100%, so at either end the slot the wrap will
               * land on is at the far side of the strip - nothing is next to
               * you and a drag past the end showed blank felt. When the drag
               * is at an end, the wrap target is rendered and pulled around by
               * exactly one strip-width, so it sits alongside the edge slot
               * and slides in like any other neighbour.
               */
              const count = tables.length;
              const atStart = activeIndex === 0;
              const atEnd = activeIndex === count - 1;
              const isWrapTarget =
                count > 1 &&
                isActivelySwiping &&
                ((atEnd && swipeOffset < 0 && idx === 0) ||
                  (atStart && swipeOffset > 0 && idx === count - 1));
              const shouldRender = isActivelySwiping ? isAdjacent || isWrapTarget : isActive;
              // One strip-width, in the direction the wrap comes from.
              const wrapShift = isWrapTarget ? (idx === 0 ? count : -count) * 100 : 0;

              return (
                <div
                  key={table.id}
                  className={`multi-table-page__table-slot ${isActive ? 'multi-table-page__table-slot--active' : ''}`}
                  style={
                    shouldRender
                      ? isWrapTarget
                        ? { transform: `translateX(${wrapShift}%)` }
                        : undefined
                      : { display: 'none' }
                  }
                >
                  <Suspense
                    fallback={
                      <div className="multi-table-page__loading">
                        <div className="multi-table-page__spinner" />
                        <span
                          style={{
                            color: 'rgba(255,255,255,0.5)',
                            fontSize: '0.85rem',
                            marginTop: 12,
                          }}
                        >
                          Loading Table…
                        </span>
                      </div>
                    }
                  >
                    {isLobbyTab(table) ? (
                      renderLobbyTab(table)
                    ) : (
                      <TableErrorBoundary
                        componentName={`TablePage(${table.id})`}
                        fallback={tableCrashFallback(table.name)}
                      >
                        <TablePage
                          key={table.id}
                          embeddedTableId={table.id}
                          onTableInfoUpdate={getTableInfoCb(table.id)}
                          muted={mutedIds.includes(table.id)}
                          // Dan 2026-08-19: while hidden on another route no tab is
                          // "active" — ambient table sounds must not follow the
                          // player into the cashier (isMultiTable true when hidden
                          // so single-table mode is muted too).
                          isMultiTable={tables.length > 1 || hidden}
                          isActive={idx === activeIndex && !hidden}
                        />
                      </TableErrorBoundary>
                    )}
                  </Suspense>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </InTabLobbyContext.Provider>
  );
}

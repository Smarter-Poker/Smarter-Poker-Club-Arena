/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA - Tournament Lobby (PLAY CHIPS ONLY)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file is the SHELL. It loads the event, keeps it live, owns registration
 * and owns the footer. It draws no tab content of its own: the seven tabs are
 * seven components under `components/tournament/details/`, and each one takes
 * exactly the `TournamentTabProps` contract built once by `tabProps` below.
 *
 * WHAT USED TO BE HERE. Seven inline tab blocks, roughly 1,100 lines of them,
 * plus a duplicated title band that printed the same rule badges the Detail tab
 * already draws. The blocks are gone; every behaviour they carried moved into
 * the tab that owns the question it answers, and nothing was dropped:
 *
 *   the countdown numeral + TournamentClock  -> DetailOverviewTab hero band
 *   the quick-stats grid                     -> DetailOverviewTab stat grid
 *   the game-info label/value list           -> DetailOverviewTab info grid
 *   the final-table deal vote + its poll     -> DetailOverviewTab (one poll now)
 *   RegistrationApprovalsPanel               -> DetailOverviewTab
 *   HandForHandBanner                        -> DetailOverviewTab
 *   the completed-event podium               -> DetailOverviewTab
 *   BlindLevelProgress                       -> BlindsTab
 *   LiveChipCounts + TournamentStandings     -> RankingTab (one tab, was two)
 *   the entry list                           -> EntriesTab
 *   the union sentence                       -> UnionsTab
 *   the table card grid                      -> TablesTab
 *   the payout table + bounty pool           -> RewardsTab
 *   the mystery bounty ladder                -> RewardsTab (MysteryBountyPanel)
 *
 * THE SHELL DOES NOT SCROLL. Dan 2026-08-25: the Detail tab shows everything on
 * one overview with no scrolling. `.tournament-details` is a fixed-height flex
 * column - [header][tabs][title][content][footer] - and only `.details-content`
 * grows. Each tab scrolls inside itself. The height is MEASURED, not `100dvh`;
 * see the measurement effect for why a viewport unit and a token constant are
 * both wrong here.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useLocation, useSearchParams, Link } from 'react-router-dom';
/* Dan 2026-08-28: this page renders BOTH as the /tournaments/:id route and
   inside a MultiTablePage lobby tab (tournamentIdOverride). In the tab, a hop
   to another tournament must stay in the tab. Its /table/:id navigations are
   untouched - useAppNavigate deliberately only rewrites /tournaments/:id.
   See InTabLobbyContext.tsx. */
import { useAppNavigate } from '../../context/InTabLobbyContext';
import {
  tournamentService,
  tournamentUnregisterSuccessText,
} from '../../services/TournamentService';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import type { Tournament } from '../../types/database.types';
import { useAuthUser } from '../../hooks/useAuthUser';
import './TournamentDetails.css';
import { useToast } from '../../components/common/Toast';
import PageErrorBoundary from '../../components/common/PageErrorBoundary';
import { FinalTableOverlay } from '../../components/tournament/FinalTableOverlay';
import MysteryBountyCelebration from '../../components/tournament/MysteryBountyCelebration';
import DetailOverviewTab from '../../components/tournament/details/DetailOverviewTab';
import BlindsTab from '../../components/tournament/details/BlindsTab';
import RankingTab from '../../components/tournament/details/RankingTab';
import EntriesTab from '../../components/tournament/details/EntriesTab';
import UnionsTab from '../../components/tournament/details/UnionsTab';
import TablesTab from '../../components/tournament/details/TablesTab';
import RewardsTab from '../../components/tournament/details/RewardsTab';
import SatellitesTab from '../../components/tournament/details/SatellitesTab';
import { chipsCompact } from '../../components/tournament/details/types';
import type {
  NormalisedBlindLevel,
  TabId,
  TournamentEntry,
  TournamentTable,
  TournamentTabProps,
} from '../../components/tournament/details/types';
import { TABS, normaliseTabId } from '../../components/tournament/details/types';
import { blindLevelMinutes } from '../../components/lobby/tournamentFigures';
import { reportError } from '../../utils/errorReporter';
import { relayTournamentEvent } from '../../services/tournamentEventBridge';
import { formatBuyIn } from '../../utils/buyIn';
import { useTournamentRegistration, isLateStatus } from '../../hooks/useTournamentRegistration';
import { useMysteryBounty } from '../../hooks/useMysteryBounty';
import { openTableAsObserver } from '../../utils/observeTable';
import './PremiumTournamentConsole.css';
import { publicOrigin } from '../../lib/appBase';

interface TournamentSnapshotOwner {
  tournamentId: string | undefined;
  userId: string | undefined;
  active: boolean;
  pending: boolean;
  inFlight: Promise<void> | null;
  hasSnapshot: boolean;
  tournamentPatches: Array<(previous: Tournament | null) => Tournament | null> | null;
  entryPatches: Array<(previous: TournamentEntry[]) => TournamentEntry[]> | null;
  tablePatches: Array<(previous: TournamentTable[]) => TournamentTable[]> | null;
}

/** Ordinal suffix helper (1st, 2nd, 3rd...) */
function getOrdinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * Dan 2026-08-19: `tournamentIdOverride` lets this page render OUTSIDE its own
 * route - MultiTablePage embeds it in a lobby tab so a seated player can
 * browse and register for a tournament while their other tables keep dealing.
 * Route usage is unchanged: without the prop the id comes from useParams.
 */
export default function TournamentDetails({
  tournamentIdOverride,
  suppressAutoOpenTable = false,
  searchOverride,
}: {
  tournamentIdOverride?: string;
  suppressAutoOpenTable?: boolean;
  /**
   * Dan 2026-08-28 round 2: the query string that came with an EMBEDDED
   * destination, "?watch=1" and all.
   *
   * On the real route the query lives in `location.search`. In a lobby tab it
   * cannot: the URL there belongs to /table/:tableId, so `location.search` is
   * the TABLE's query (name / stakes / code) and has nothing to do with this
   * tournament. Round 1 therefore lost `?watch=1` entirely and the WATCH
   * button on a running MTT opened the details page and stopped — the one
   * control whose whole job is to open the table.
   *
   * Passing it in keeps one rule for both mounts: `search` below is "the query
   * that addressed THIS page", wherever the page is rendered.
   */
  searchOverride?: string;
} = {}) {
  const { register: registerMtt, isRegistering: isRegisteringMtt } = useTournamentRegistration();

  const { tournamentId: routeTournamentId } = useParams<{ tournamentId: string }>();
  const [searchParams] = useSearchParams();
  const tournamentId = tournamentIdOverride || routeTournamentId;
  const navigate = useAppNavigate();
  const location = useLocation();
  /**
   * THE query for this page. Embedded: whatever drilled us in. Routed: the
   * URL's own. Never mix the two — reading the table's `?name=` as if it were
   * a tournament parameter is how the two mounts drift apart.
   */
  const search = searchOverride !== undefined ? searchOverride : location.search;
  const { user } = useAuthUser();
  const toast = useToast();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  /**
   * A `?tab=` deep link is read once, through the normaliser, so a stale
   * `?tab=chips` opens Ranking instead of rendering nothing at all. Nothing in
   * the app persists a tab id today; the normaliser is what makes it safe for
   * anything to start.
   */
  const [activeTab, setActiveTab] = useState<TabId>(() => normaliseTabId(searchParams.get('tab')));
  /** One element per tab, so the roving-focus arrow keys can move focus. */
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [entries, setEntries] = useState<TournamentEntry[]>([]);
  const [isRegistered, setIsRegistered] = useState(false);
  /** Fires the auto-open-my-table navigation exactly once per tournament. */
  const autoOpenedTableRef = useRef(false);
  const [tables, setTables] = useState<TournamentTable[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const snapshotOwnerRef = useRef<TournamentSnapshotOwner | null>(null);
  /* `showSignUpModal` deleted 2026-08-25 - this page no longer owns a buy-in
     modal. See handleRegister. */

  /* `walletBalance` deleted 2026-08-25. It existed only to fill the Your
     Balance row and the insufficient-funds gate on this page's own Sign Up
     modal, and that modal is gone (see handleRegister). SignUpHost reads the
     balance itself, when the dialog opens, so the figure a player is shown is
     never one this page happened to fetch minutes earlier. */
  const [lateRegCountdown, setLateRegCountdown] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);

  const lateRegTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  /** Distinguishes this mount's realtime channel from any other mount of the
      same tournament — see the subscription effect for why that matters. */
  const channelInstanceRef = useRef<string>(
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  );

  /**
   * MYSTERY BOUNTY (sections 10, 31 to 36, 67, 68, 73).
   *
   * One hook for the whole page: DetailOverviewTab advertises the top chest and
   * the activation status off it, and RewardsTab renders the full ladder from
   * the same fetch. `enabled` is false for every other format, so a freezeout
   * makes no RPC calls at all.
   */
  const isMysteryBountyEvent = Boolean(
    (tournament as unknown as { is_mystery_bounty?: boolean } | null)?.is_mystery_bounty
  );
  const mysteryBounty = useMysteryBounty(tournamentId ?? null, isMysteryBountyEvent);

  /**
   * MEASURE THE SPACE, DO NOT GUESS IT.
   *
   * The shell has to be exactly as tall as what is left after the chrome
   * around it, or the "no scroll" layout is a lie. That chrome is not a
   * constant: AppLayout puts GlobalHeader above this route, may put a club
   * announcement banner and an offline banner under it, and `<main>` adds its
   * own padding - and `--header-height` disagrees with itself across the three
   * token files (44px in one, 56px in two) before you even get to a header
   * that wraps onto a second line.
   *
   * So take the number from the DOM: the distance from the top of the document
   * to the top of this element is everything above it, and the container's
   * bottom padding is everything below. `scrollY` is added back because a
   * viewport-relative `top` shrinks the moment anything scrolls, and this must
   * converge rather than feed back on itself.
   *
   * This is also what makes the MultiTablePage embed right, where the space is
   * a tab panel and not the viewport at all.
   */
  /** True when this page is rendered inside a container rather than as its own
      route — see the measurement effect and the auto-open effect below. */
  const isEmbedded = Boolean(tournamentIdOverride);

  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof window === 'undefined') return;

    const measure = () => {
      const above = el.getBoundingClientRect().top + window.scrollY;
      const parent = el.parentElement;
      const below = parent ? parseFloat(getComputedStyle(parent).paddingBottom || '0') || 0 : 0;
      /**
       * FLUSH MEANS FLUSH (Dan 2026-08-25: "actually attach it to the bottom,
       * there is a gap below it"). Subtracting `below` left the footer
       * floating exactly the parent's bottom padding above the screen edge —
       * measured in production Chromium on 2026-08-26 at BOTH 375×812 and
       * 430×932: footer bottom 800/920 against viewports of 812/932, a 12px
       * band of `<main>` padding showing under the buttons. The checklist
       * row this page was built against says "footer flush to the bottom,
       * no gap", so the shell now claims that band: full remaining height,
       * plus a negative bottom margin that cancels the parent's own gutter.
       * Converges the same way --details-h does — the guarded writes stop
       * the ResizeObserver loop after one pass.
       */
      /**
       * MEASURE AGAINST THE BOX WE ARE ACTUALLY IN (Dan 2026-08-30).
       *
       * `window.innerHeight - above` is right for the ROUTE, where the shell
       * really does run to the bottom of the viewport. It is wrong for the
       * TournamentLobbyModal embed, where the container is a `75dvh` sheet
       * anchored to the bottom of the screen: `dvh` and `innerHeight` disagree
       * by the browser toolbar on iOS and Android, so the shell was measured
       * TALLER than the sheet holding it. `.tlm-body` is `overflow: hidden`, so
       * the excess was not merely unreachable — the content area's box was
       * bigger than anything visible, which is a second, independent way for a
       * tab to have nothing to scroll while its content is cut off.
       *
       * THE EMBEDDER SAYS SO, we do not infer it — the same rule the auto-open
       * effect follows with `suppressAutoOpenTable`. That distinction is not
       * fussiness: on the route the parent is `<main>`, which is CONTENT-sized,
       * so its height is a readback of the height we just wrote and measuring
       * against it would be a feedback loop rather than a measurement.
       * `.tlm-body` is `flex: 1 1 auto` inside a fixed-height panel, so its
       * height is genuinely independent of ours and safe to read.
       */
      const parentBox = isEmbedded && parent ? parent.getBoundingClientRect() : null;
      const parentAvail =
        parentBox && parentBox.height > 0
          ? parentBox.height - (el.getBoundingClientRect().top - parentBox.top)
          : 0;
      const avail = Math.max(320, parentAvail > 0 ? parentAvail : window.innerHeight - above);
      const nextMargin = below > 0 ? `${-Math.round(below)}px` : '';
      if (el.style.marginBottom !== nextMargin) {
        el.style.marginBottom = nextMargin;
      }
      const next = `${Math.round(avail)}px`;
      // Write only on a real change. The ResizeObserver below watches the
      // parent, and this write changes the parent's height, so an
      // unconditional write is a resize loop waiting for a browser that does
      // not de-duplicate it. `above` does not depend on our own height, so the
      // value converges after one pass and this guard ends the cycle there.
      if (el.style.getPropertyValue('--details-h') !== next) {
        el.style.setProperty('--details-h', next);
      }
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;
    if (ro && el.parentElement) ro.observe(el.parentElement);

    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      ro?.disconnect();
    };
  }, [isLoading, tournament?.id, isEmbedded]);

  useEffect(() => {
    const owner: TournamentSnapshotOwner = {
      tournamentId,
      userId: user?.id,
      active: true,
      pending: false,
      inFlight: null,
      hasSnapshot: false,
      tournamentPatches: null,
      entryPatches: null,
      tablePatches: null,
    };
    snapshotOwnerRef.current = owner;
    autoOpenedTableRef.current = false;
    setTournament(null);
    setEntries([]);
    setTables([]);
    setIsRegistered(false);
    setIsProcessing(false);
    setLoadError(null);
    setSnapshotReady(false);
    setIsLoading(Boolean(tournamentId));
    if (tournamentId) void loadTournament();
    return () => {
      owner.active = false;
      owner.pending = false;
      if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
    };
  }, [tournamentId, user?.id]);

  /**
   * ── Late-reg countdown. Drives the footer's Late Register button. ──
   *
   * LEVELS AND MINUTES ARE DIFFERENT UNITS (fixed 2026-08-26).
   *
   * This read `late_reg_levels || late_reg_mins` into one variable called
   * `lateRegLevels` and then subtracted `current_level` from it. For a
   * minutes-configured event (no `late_reg_levels`, `late_reg_mins: 30`) the
   * footer therefore announced **"Late Register (30 levels remaining)"** — a
   * sentence that is simply false — and because `current_level` will never
   * climb to 30, the button never retired: it kept offering late registration
   * long after the server had closed the window, and the buy-in it offered
   * would be rejected.
   *
   * The rest of the codebase keeps these apart. DetailOverviewTab renders them
   * separately (`Lv ${levels}` vs `${mins}m`), the engine's level cutoff reads
   * only `late_reg_levels ?? rebuy_levels ?? 0`, and the server's minutes
   * window is an interval measured from the start:
   * `make_interval(mins => v_t.late_reg_mins)`. Mirror that here.
   */
  useEffect(() => {
    if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
    const t = tournament as unknown as {
      late_reg_levels?: number;
      late_reg_mins?: number;
      current_level?: number;
      started_at?: string | null;
    } | null;
    const lateRegLevels = Number(t?.late_reg_levels) || 0;
    const lateRegMins = Number(t?.late_reg_mins) || 0;
    if (!isLateStatus(tournament?.status) || (!lateRegLevels && !lateRegMins)) return;

    const stop = () => {
      setLateRegCountdown('');
      if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
    };

    const tick = () => {
      if (!lateRegLevels) {
        // Minutes window, measured from started_at — the same span the server
        // closes on.
        const startedMs = Date.parse(String(t?.started_at ?? ''));
        if (!Number.isFinite(startedMs)) return setLateRegCountdown('');
        const minsLeft = Math.ceil((startedMs + lateRegMins * 60_000 - Date.now()) / 60_000);
        if (minsLeft <= 0) return stop();
        setLateRegCountdown(`${minsLeft} min${minsLeft !== 1 ? 's' : ''} remaining`);
        return;
      }
      /* `current_level` is a 0-BASED INDEX; so is the level cutoff the engine
         compares it against (`current_level >= late_reg_levels`), so these two
         are in the same unit and subtract cleanly. Do not "helpfully" add one
         to either — see tests/unit/currentLevelIsAnIndex.test.ts. */
      const currentLevel = Math.max(0, Number(t?.current_level) || 0);
      if (currentLevel >= lateRegLevels) return stop();
      const levelsRemaining = lateRegLevels - currentLevel;
      setLateRegCountdown(`${levelsRemaining} level${levelsRemaining !== 1 ? 's' : ''} remaining`);
    };
    tick();
    // Every 10 seconds: fast enough for a level flip, cheap enough to ignore.
    lateRegTimerRef.current = setInterval(tick, 10000);
    return () => {
      if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
    };
  }, [
    tournament?.status,
    (tournament as unknown as { current_level?: number } | null)?.current_level,
    (tournament as unknown as { late_reg_levels?: number } | null)?.late_reg_levels,
    (tournament as unknown as { late_reg_mins?: number } | null)?.late_reg_mins,
    (tournament as unknown as { started_at?: string | null } | null)?.started_at,
  ]);

  /**
   * Dan 2026-08-19: registering for a tournament must TAKE YOU TO IT the moment
   * it starts. Until now the page only rendered a manual "go to table" link
   * once the entry flipped to 'playing' - a registered player watching the
   * countdown was left sitting on the details screen while their table dealt
   * without them, blinding off.
   *
   * The realtime subscription below already streams both the tournament status
   * and this player's tournament_players row, so the moment the engine seats
   * them (a table_id appears) we open that table. Guarded by a ref so it fires
   * exactly once per tournament - re-navigating on every realtime tick would
   * trap the player on the table route and break the back button.
   */
  useEffect(() => {
    /* NOT WHEN WE ARE ALREADY AT THE TABLE (2026-08-28).
     *
     * The tournament lobby now also opens as a 3/4 popup ON the felt
     * (TournamentLobbyModal), reached from the upper-right button. In that
     * context this effect is not a service, it is a hazard: the player is
     * already seated at the table it wants to send them to, and firing
     * `navigate` from inside an overlay at a live table is at best a redundant
     * route change and at worst yanks a multi-tabling player off the table they
     * were watching. The embedder says so explicitly rather than this effect
     * trying to infer where it is being rendered. */
    if (suppressAutoOpenTable) return;
    if (tournament?.status !== 'RUNNING') return;
    if (!user?.id) return;
    if (autoOpenedTableRef.current) return;

    if (tournament.id !== tournamentId || !snapshotReady) return;
    const myEntry = entries.find((e) => e.user_id === user.id);
    if (!myEntry?.table_id) return;
    // Only seat-bound states: an eliminated or finished player must never be
    // yanked into a table they are no longer sitting at.
    if (myEntry.status !== 'playing' && myEntry.status !== 'registered') return;

    autoOpenedTableRef.current = true;
    navigate(`/table/${myEntry.table_id}`);
  }, [
    tournamentId,
    tournament?.status,
    entries,
    user?.id,
    navigate,
    suppressAutoOpenTable,
    snapshotReady,
  ]);

  // ── Realtime subscription: live tournament updates ──
  useEffect(() => {
    if (!tournamentId) return;
    const owner = snapshotOwnerRef.current;
    const isCurrent = () => owner?.active && snapshotOwnerRef.current === owner;
    // Keep changes that arrive during a snapshot read and replay them on its
    // result. A busy table must not trigger a second full-field query per patch.
    const patchTournament = (patch: (previous: Tournament | null) => Tournament | null) => {
      if (!isCurrent()) return;
      owner?.tournamentPatches?.push(patch);
      setTournament(patch);
    };
    const patchEntries = (patch: (previous: TournamentEntry[]) => TournamentEntry[]) => {
      if (!isCurrent()) return;
      owner?.entryPatches?.push(patch);
      setEntries(patch);
    };
    const patchTables = (patch: (previous: TournamentTable[]) => TournamentTable[]) => {
      if (!isCurrent()) return;
      owner?.tablePatches?.push(patch);
      setTables(patch);
    };

    /**
     * ONE CHANNEL PER MOUNT, NOT PER TOURNAMENT (2026-08-30).
     *
     * This was `tournament-${tournamentId}`, and `getOrCreateChannel` hands the
     * SAME Supabase channel to every consumer of a key. That is right for a key
     * several different components subscribe to; it is a trap for this one,
     * because the two consumers are two mounts of THIS page — the
     * /tournaments/:id route and the TournamentLobbyModal embed, which can be
     * open on the same event at the same time.
     *
     * The second mount then adds its `.on('postgres_changes', ...)` bindings to
     * a channel that has already joined. supabase-js sends postgres_changes
     * bindings in the join payload and ignores every one added afterwards: the
     * second mount receives NOTHING, its `.subscribe()` resolves against the
     * existing join, and no error is raised anywhere. That is a card frozen on
     * its mount-time snapshot with a realtime channel reporting itself healthy
     * — the exact failure the watchdog above exists to survive, and this is the
     * cause of it rather than the floor under it.
     *
     * A per-mount suffix makes the bindings always land pre-join. The refcount
     * in MasterBus is untouched and still correct; this key simply never has
     * more than one holder.
     */
    const channelKey = `tournament-${tournamentId}-${channelInstanceRef.current}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournaments',
          filter: `id=eq.${tournamentId}`,
        },
        (payload) => {
          if (!isCurrent()) return;
          if (payload.eventType === 'UPDATE' && payload.new) {
            patchTournament((prev) => (prev ? { ...prev, ...payload.new } : null));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_players',
          filter: `tournament_id=eq.${tournamentId}`,
        },
        (payload) => {
          if (!isCurrent()) return;
          if (payload.eventType === 'INSERT' && payload.new) {
            // New player registered.
            //
            // The realtime row carries every COLUMN of tournament_players, so
            // registered_at / rebuys / add_on ride along and the contract
            // fields stay populated. It cannot carry the profiles embed, so
            // `avatar_url` and `player_code` are null until the next full
            // load - EntriesTab fetches those itself, and RankingTab falls
            // back to initials rather than a broken image.
            const newPlayer = payload.new as {
              id: string;
              user_id: string;
              username?: string | null;
              chips?: number;
              status: string;
              position?: number | null;
              prize?: number | null;
              table_id?: string | null;
              registered_at?: string | null;
              rebuys?: number | null;
              add_on?: boolean | null;
              is_satellite_qualifier?: boolean | null;
            };
            patchEntries((prev) => {
              /**
               * DE-DUP (added 2026-08-26).
               *
               * The register path reloads entries at +50ms and again on
               * TOURNAMENT_UPDATED (500ms debounce), and this Postgres INSERT
               * commonly lands AFTER one of those has already put the row in
               * state. Appending unconditionally put the same `id` in twice,
               * and downstream that is not merely cosmetic:
               *   - EntriesTab and RankingTab both key on `entry.id`, so React
               *     logs "two children with the same key";
               *   - EntriesTab derives `reentryIds` by spotting a second row
               *     for one player, so the duplicate drew an **RE** badge on
               *     somebody who had entered exactly once;
               *   - the Entries count and the unique-players stat read high
               *     until the next full load.
               */
              if (prev.some((e) => e.id === newPlayer.id)) return prev;
              return [
                ...prev,
                {
                  id: newPlayer.id,
                  user_id: newPlayer.user_id,
                  username: newPlayer.username || 'Player',
                  avatar_url: null,
                  player_code: null,
                  // BUG FIX: do NOT read tournament.starting_chips here - this
                  // handler is in a closure that captured `tournament` when the
                  // effect ran (tournamentId dep), which may be null if the
                  // subscription was set up before loadTournament completed.
                  // Use newPlayer.chips if present; the next loadTournament()
                  // call (triggered by TOURNAMENT_UPDATED) hydrates the rest.
                  chips: newPlayer.chips || 0,
                  position: newPlayer.position || undefined,
                  prize:
                    newPlayer.prize !== null &&
                    newPlayer.prize !== undefined &&
                    Number.isFinite(Number(newPlayer.prize))
                      ? Number(newPlayer.prize)
                      : undefined,
                  status: newPlayer.status as TournamentEntry['status'],
                  table_id: newPlayer.table_id || null,
                  created_at: newPlayer.registered_at ?? null,
                  rebuys: Number(newPlayer.rebuys) || 0,
                  add_ons: newPlayer.add_on ? 1 : 0,
                  is_satellite_qualifier: Boolean(newPlayer.is_satellite_qualifier),
                },
              ];
            });
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            // Player status, chips, rebuy or add-on updated. A rebuy IS an
            // UPDATE on this row, so carrying the two counters here is what
            // keeps the Entries tab honest between full loads.
            const updatedPlayer = payload.new as {
              id: string;
              user_id: string;
              username?: string | null;
              chips?: number;
              status: string;
              position?: number | null;
              prize?: number | null;
              table_id?: string | null;
              rebuys?: number | null;
              add_on?: boolean | null;
              is_satellite_qualifier?: boolean | null;
            };
            patchEntries((prev) =>
              prev.map((e) =>
                e.id === updatedPlayer.id
                  ? {
                      ...e,
                      chips: updatedPlayer.chips,
                      status: updatedPlayer.status as TournamentEntry['status'],
                      position: updatedPlayer.position || undefined,
                      prize:
                        updatedPlayer.prize !== undefined && updatedPlayer.prize !== null
                          ? Number(updatedPlayer.prize)
                          : e.prize,
                      table_id:
                        updatedPlayer.table_id !== undefined ? updatedPlayer.table_id : e.table_id,
                      rebuys:
                        updatedPlayer.rebuys !== undefined && updatedPlayer.rebuys !== null
                          ? Number(updatedPlayer.rebuys) || 0
                          : e.rebuys,
                      is_satellite_qualifier:
                        updatedPlayer.is_satellite_qualifier !== undefined &&
                        updatedPlayer.is_satellite_qualifier !== null
                          ? Boolean(updatedPlayer.is_satellite_qualifier)
                          : e.is_satellite_qualifier,
                      add_ons:
                        updatedPlayer.add_on !== undefined && updatedPlayer.add_on !== null
                          ? updatedPlayer.add_on
                            ? 1
                            : 0
                          : e.add_ons,
                    }
                  : e
              )
            );
          } else if (payload.eventType === 'DELETE' && payload.old) {
            // Player unregistered or eliminated
            patchEntries((prev) => prev.filter((e) => e.id !== (payload.old as { id: string }).id));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tables',
          filter: `tournament_id=eq.${tournamentId}`,
        },
        (payload) => {
          if (!isCurrent()) return;
          if (payload.eventType === 'INSERT' && payload.new) {
            const t = payload.new as TournamentTable & {
              name?: string | null;
              is_deleted?: boolean | null;
            };
            if (t.is_deleted === true) return;
            patchTables((prev) => {
              // The load path may already carry this row — `loadTournament`
              // runs again on TOURNAMENT_UPDATED — and appending blind would
              // duplicate the React key the Tables list renders on.
              if (prev.some((tbl) => tbl.id === t.id)) return prev;
              return [
                ...prev,
                {
                  id: t.id,
                  name: t.name || `Table ${prev.length + 1}`,
                  status: t.status,
                  max_players: t.max_players,
                  current_players: t.current_players || 0,
                  small_blind: t.small_blind,
                  big_blind: t.big_blind,
                },
              ];
            });
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            const t = payload.new as TournamentTable & { is_deleted?: boolean | null };
            /* A soft delete arrives as an ordinary UPDATE — the row stays in
               `tables` — so merging it would keep a dead felt in the list and
               eligible to be featured. Drop it the way a hard DELETE is
               dropped. */
            if (t.is_deleted === true) {
              patchTables((prev) => prev.filter((tbl) => tbl.id !== t.id));
              return;
            }
            patchTables((prev) =>
              prev.map((tbl) =>
                tbl.id === t.id
                  ? {
                      ...tbl,
                      current_players: t.current_players,
                      small_blind: t.small_blind,
                      big_blind: t.big_blind,
                      status: t.status,
                    }
                  : tbl
              )
            );
          } else if (payload.eventType === 'DELETE' && payload.old) {
            patchTables((prev) =>
              prev.filter((tbl) => tbl.id !== (payload.old as { id: string }).id)
            );
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (!isCurrent()) return;
        if (status === 'SUBSCRIBED') void loadTournament(undefined, { quiet: true });
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'TournamentDetails._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[TournamentDetails] Realtime channel timed out');
        }
      });

    // ── Bus event subscriptions for faster local updates ──
    const unsubElim = masterBus.subscribeDebounced(
      'PLAYER_ELIMINATED',
      (event) => {
        if (event.payload.tournamentId !== tournamentId || !isCurrent()) return;
        // Immediately update entries list when a player is eliminated
        patchEntries((prev) =>
          prev.map((e) =>
            e.user_id === event.payload.userId
              ? { ...e, status: 'eliminated' as const, position: event.payload.position }
              : e
          )
        );
        // BUG FIX: guard against undefined position - getOrdinal(undefined) would
        // produce "undefinedth" which reads as a broken toast message.
        const pos = event.payload.position;
        const posText = pos != null ? `${pos}${getOrdinal(pos)} place` : 'eliminated';
        toast.info(`${event.payload.username} ${posText}`);
      },
      300
    );

    // TABLE_MERGED listener removed 2026-08-28: nothing emits it on the
    // client bus — merges happen in the server's TableBalancer and were never
    // relayed, so the "table merged" toast and list update never once fired.
    // Revive through tournamentEventBridge (the t-break pattern) if wanted;
    // the tables list already refreshes from server truth on poll/visibility.

    // ── Blind level changes: update tournament state immediately ──
    const unsubBlind = masterBus.subscribeDebounced(
      'BLIND_LEVEL_CHANGE',
      (event) => {
        if (event.payload.tournamentId !== tournamentId || !isCurrent()) return;
        /**
         * `- 1`: THE PAYLOAD IS THE DISPLAY LEVEL, THE COLUMN IS AN INDEX.
         *
         * This wrote the 1-based payload straight into `current_level`, which
         * is contractually the 0-based index the engine uses on
         * `blindStructure[]`. It is the worst of the three places that had this
         * wrong, because it does not merely mis-render one component: it
         * corrupts the shared `tournament` object that EVERY tab reads off this
         * page, so between an advance and the next poll the Detail hero, the
         * Blinds tab and anything else reading the row were all one level
         * ahead, consistently, from a single bad write. See MasterBus's
         * BLIND_LEVEL_CHANGE for the contract.
         */
        const displayLevel = Number(event.payload.level);
        if (!Number.isFinite(displayLevel) || displayLevel < 1) return;
        patchTournament((prev) =>
          prev ? ({ ...prev, current_level: displayLevel - 1 } as Tournament) : prev
        );
      },
      300
    );

    /**
     * ── THE BREAK CHANNEL, WHICH THIS PAGE NEVER JOINED (2026-09-09) ─────────
     *
     * The two subscriptions below have been here since the bridge was written,
     * and neither had ever fired on this page. `TOURNAMENT_BREAK` and
     * `TOURNAMENT_BREAK_END` reach MasterBus only through
     * `relayTournamentEvent`, and only a page that has JOINED the engine's
     * `t-break-<id>` broadcast channel can call it. TournamentPage and
     * TournamentLobbyPage both do; this page - the one a registered player sits
     * on to watch their event - did not, so it heard nothing and the two toasts
     * were unreachable code. tournamentEventBridge's own header names
     * TournamentDetails as one of the two handlers it exists to make run, and
     * says "Every consumer of the channel calls it"; the missing half was that
     * this page was not a consumer of the channel at all.
     *
     * A SECOND channel object, deliberately. The postgres_changes channel above
     * carries a per-mount suffix because those bindings must land pre-join; a
     * BROADCAST binding has no such constraint, so this one uses the shared
     * `t-break-<id>` key that every other consumer uses and MasterBus refcounts.
     * Released with `removeRegisteredChannel`, never `unsubscribe()`, or the
     * table in the same event goes deaf (MasterBus.ts:1325-1340).
     */
    const breakChannelKey = `t-break-${tournamentId}`;
    const breakChannel = masterBus.getOrCreateChannel(breakChannelKey);
    breakChannel
      .on('broadcast', { event: 'tournament_event' }, (payload) => {
        relayTournamentEvent(tournamentId, payload.payload);
      })
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR' && err) {
          reportError(err?.message || err, 'TournamentDetails.break_channel_error');
        }
      });

    // ── Tournament break notifications ──
    const unsubBreak = masterBus.subscribeDebounced(
      'TOURNAMENT_BREAK',
      (event) => {
        if (event.payload.tournamentId !== tournamentId || !isCurrent()) return;
        toast.info('Tournament break - play resumes shortly');
      },
      300
    );

    const unsubBreakEnd = masterBus.subscribeDebounced(
      'TOURNAMENT_BREAK_END',
      (event) => {
        if (event.payload.tournamentId !== tournamentId || !isCurrent()) return;
        toast.info('Break over - play resuming');
      },
      300
    );

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      masterBus.removeRegisteredChannel(breakChannelKey);
      unsubElim();
      unsubBlind();
      unsubBreak();
      unsubBreakEnd();
    };
  }, [tournamentId, user?.id]);

  /* A BALANCE_UPDATED subscription used to live here. It refreshed a
     `walletBalance` this page no longer holds - see the note at its old
     declaration. SignUpHost fetches the balance when the buy-in dialog opens,
     so there is nothing on this page left to keep fresh, and an empty effect
     that subscribes to nothing is worse than no effect. */

  // ── Refresh tournament data when tournament is updated ──
  useMasterBusSubscription(
    'TOURNAMENT_UPDATED',
    (payload) => {
      if (tournamentId && payload.tournamentId === tournamentId) {
        void loadTournament(undefined, { quiet: true });
      }
    },
    { debounce: 500 }
  );

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  THE WATCHDOG — a lobby card may never freeze (Dan 2026-08-30, binding)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Dan: "the 20k gtd did not start, or launch. currently froze instead of auto
   * launching."
   *
   * The engine had launched it — 13 tables, 111 players seated, 79 hands dealt.
   * What froze was THIS PAGE, which had loaded once at mount and then never
   * looked again: it showed STARTS IN 0:00, TABLES 0, LEVEL 1, ELIMINATED 0 —
   * the REGISTERING snapshot — while the player's seat was already dealt in
   * behind it. To the player there is no difference between a tournament that
   * did not start and a card that never noticed, and there was no control on
   * screen to disprove it.
   *
   * THE PAGE HAD NO SECOND SOURCE OF TRUTH. Every live update arrived through
   * one realtime channel: one dropped socket, one silent CHANNEL_ERROR, one
   * `.on()` binding added to a channel some other mount had already subscribed
   * (postgres_changes bindings are sent in the join and IGNORED afterwards, so
   * the second mount gets no events and no error — fixed separately below), and
   * the card is frozen for as long as it is open, with realtime reporting
   * itself perfectly healthy.
   *
   * So the truth is re-read on a timer as well. Realtime stays exactly as it
   * was and is still what makes the page feel live — this is the floor under
   * it, not a replacement for it. The cadence follows how much a wrong answer
   * would cost right now:
   *
   *   THE START WINDOW — from a minute before `start_time` (which is when the
   *   engine now pre-seats the field) until the row leaves REGISTERING: every
   *   3 seconds. This is the only window in which a stale card can strand a
   *   player who has paid a buy-in, so it is the one worth spending requests
   *   on. It is bounded by the transition it is waiting for.
   *
   *   A LIVE EVENT — 20 seconds. Chip counts and eliminations still arrive over
   *   realtime; this only has to catch up a page whose socket has gone quiet.
   *
   *   EVERYTHING ELSE — 60 seconds, and nothing at all once the event is
   *   COMPLETED or CANCELLED, because those rows do not change again.
   *
   * A hidden tab polls nothing (`document.hidden`) and refreshes once the
   * moment it is looked at again, so a lobby left open in a background tab
   * costs nothing and is never the stale one.
   */
  useEffect(() => {
    if (!tournamentId) return;
    if (typeof document === 'undefined') return;

    const status = String(tournament?.status ?? '');
    if (status === 'COMPLETED' || status === 'CANCELLED') return;

    const refresh = () => {
      if (document.hidden) return;
      void loadTournament(undefined, { quiet: true });
    };

    const intervalMs = (() => {
      const startMs = Date.parse(String(tournament?.start_time ?? ''));
      const preStart = status === 'REGISTERING' || status === 'ANNOUNCED' || status === '';
      /* 60s of lead, because that is when the engine seats the field
         (TOURNAMENT_PRESEAT_LEAD_MS), plus 15s of slack so a clock skewed by a
         few seconds still opens the window before anything happens. */
      const inStartWindow = Number.isFinite(startMs) && preStart && Date.now() >= startMs - 75_000;
      if (inStartWindow) return 3_000;
      if (isLateStatus(status)) return 20_000;
      return 60_000;
    })();

    const timer = setInterval(refresh, intervalMs);
    /* Coming back to the tab is the single most likely moment for the card to
       be wrong, and the cheapest moment to fix it. */
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
    // `start_time` is in the deps because it decides the cadence: an event
    // rescheduled while the card is open must re-arm against its new clock.
  }, [tournamentId, user?.id, tournament?.status, tournament?.start_time]);

  /**
   * Registration status, recomputed whenever the entry list moves.
   *
   * The `entries.length > 0` guard is gone (2026-08-26). It meant this could
   * only ever set the flag TRUE: when the player's row was removed — an
   * unregistration made from another device, or the realtime DELETE branch
   * firing — `entries` emptied and `isRegistered` kept its stale `true`. The
   * footer then offered **Unregister** for an entry that no longer existed,
   * and pressing it called `fn_unregister_from_tournament` and surfaced an
   * error toast for a state the player had not caused.
   *
   * `tournament` was also missing from the dependency list, so the flag never
   * re-evaluated when the event itself finished loading.
   */
  useEffect(() => {
    if (!user || !tournament) return;
    setIsRegistered(entries.some((e) => e.user_id === user.id));
  }, [user, tournament, entries]);

  /**
   * `quiet` is for the watchdog below: a background refresh must not throw the
   * page back to its full-screen "Loading tournament..." state every few
   * seconds, which is what an unconditional `setIsLoading(true)` would do.
   */
  const loadTournament = async (getIsMounted?: () => boolean, opts?: { quiet?: boolean }) => {
    const owner = snapshotOwnerRef.current;
    if (
      !tournamentId ||
      !owner?.active ||
      owner.tournamentId !== tournamentId ||
      owner.userId !== user?.id ||
      (getIsMounted && !getIsMounted())
    )
      return;
    const isOwner = () => owner.active && snapshotOwnerRef.current === owner;
    if (owner.inFlight) {
      owner.pending = true;
      return owner.inFlight;
    }
    const callerIsMounted = getIsMounted;
    getIsMounted = () => isOwner() && !owner.pending && (!callerIsMounted || callerIsMounted());
    const readSnapshot = async () => {
      let complete = true;
      owner.tournamentPatches = [];
      owner.entryPatches = null;
      owner.tablePatches = null;
      if (!opts?.quiet && (!getIsMounted || getIsMounted())) setIsLoading(true);
      try {
        const result = await tournamentService.getTournament(tournamentId, { throwOnError: true });
        if (getIsMounted && !getIsMounted()) return;
        const data = owner.tournamentPatches.reduce((previous, patch) => patch(previous), result);
        owner.tournamentPatches = null;
        setTournament(data);

        if (data) {
          /**
           * THE ENTRY QUERY IS THE TAB CONTRACT.
           *
           * It used to select `id, user_id, username, chips, status, position,
           * table_id` and hardcode `avatar_url: null`. RankingTab reads
           * `entry.avatar_url` straight from props with no query of its own, so
           * that null drew initials for the entire field; and EntriesTab got
           * neither a registration time nor a rebuy count from props. The three
           * added columns are on the row already (no join), and the profiles
           * embed rides `fk_tournament_players_user_id_profiles` - one join for
           * the whole list, not one request per player.
           *
           * `add_on` is a BOOLEAN in production, not a count; the contract field
           * is `add_ons: number`, so it collapses to 0 or 1 here rather than
           * pretending the database records how many.
           */
          owner.entryPatches = [];
          const { data: playersData, error } = await supabase
            .from('tournament_players')
            .select(
              'id, user_id, username, chips, status, position, prize, table_id, registered_at, rebuys, add_on, is_satellite_qualifier, profile:profiles!user_id(player_number, avatar_url:arena_avatar_url)'
            )
            .eq('tournament_id', data.id)
            .order('registered_at', { ascending: true });

          if (getIsMounted && !getIsMounted()) return;

          if (!error && playersData) {
            const recoveredEntries = playersData.map(
              (e: Record<string, unknown>): TournamentEntry => {
                // PostgREST returns an embedded row as an object, but types it as
                // an array in some shapes. Accept both rather than guess - this
                // exact shape caused bugs in the past.
                const rawProfile = e.profile as
                  | { player_number?: string | null; avatar_url?: string | null }
                  | { player_number?: string | null; avatar_url?: string | null }[]
                  | null
                  | undefined;
                const profile = Array.isArray(rawProfile) ? rawProfile[0] : rawProfile;
                return {
                  id: String(e.id),
                  user_id: String(e.user_id),
                  username: (e.username as string) || 'Player',
                  avatar_url: profile?.avatar_url || null,
                  player_code: profile?.player_number ? String(profile.player_number) : null,
                  chips:
                    e.chips != null && Number.isFinite(Number(e.chips))
                      ? Number(e.chips)
                      : data.starting_chips,
                  position: (e.position as number) || undefined,
                  prize:
                    e.prize !== null && e.prize !== undefined && Number.isFinite(Number(e.prize))
                      ? Number(e.prize)
                      : undefined,
                  status: e.status as TournamentEntry['status'],
                  /* `club_id` was selected here and mapped onto the entry solely
                   so the old inline Unions block could count
                   `new Set(entries.map(e => e.club_id))`. UnionsTab selects it
                   itself, for the whole field, and then falls back to
                   club_members for the ~40% of history that predates the
                   column - so carrying it here now would be a second, weaker
                   copy of a resolution that tab already does properly. */
                  table_id: (e.table_id as string | null) || null,
                  created_at: (e.registered_at as string | null) ?? null,
                  rebuys: Number(e.rebuys) || 0,
                  add_ons: e.add_on ? 1 : 0,
                  is_satellite_qualifier: Boolean(e.is_satellite_qualifier),
                };
              }
            );
            const currentEntries = owner.entryPatches.reduce(
              (previous, patch) => patch(previous),
              recoveredEntries
            );
            owner.entryPatches = null;
            setEntries(currentEntries);

            // Check if current user is registered against the patched field.
            if (user) {
              const isUserRegistered = currentEntries.some(
                (e: { user_id: string }) => e.user_id === user.id
              );
              setIsRegistered(isUserRegistered);
            }
          } else {
            complete = false;
            reportError(
              error ?? new Error('Missing Tournament Entries'),
              'TournamentDetails.Entries_load_failed'
            );
          }

          /* Fetch tournament tables.
           `isLateStatus` as well as RUNNING (2026-08-30): a LATE_REG event has
           players at tables, and reading only RUNNING left `tables` empty for
           it — which meant no featured table, so no WATCH button, and an empty
           Tables tab on an event that is visibly dealing. The footer already
           uses `isWatchable` for exactly this reason; the query it depends on
           did not. */
          if (data.status === 'RUNNING' || isLateStatus(data.status)) {
            owner.tablePatches = [];
            const { data: tablesData, error: tablesErr } = await supabase
              .from('tables')
              .select('id, name, status, max_players, current_players, small_blind, big_blind')
              .eq('tournament_id', data.id)
              /**
               * SOFT-DELETED TABLES ARE NOT WATCHABLE (added 2026-08-26).
               *
               * This query feeds BOTH `featuredTableId` and TablesTab, so a
               * deleted row could win the busiest-table sort and the WATCH button
               * — and the `?watch=1` intent — would open a felt that no longer
               * exists. `featuredTableId`'s `status !== 'closed'` guard does not
               * exclude it: a soft-deleted table very often still reads
               * `status = 'running'`. TournamentPage was fixed for exactly this
               * on 2026-08-25; the details page, which is where Dan's WATCH
               * button actually lives, was not.
               *
               * `.not(..., 'is', true)` rather than `.eq(..., false)` because the
               * column is NULLABLE — verified against production, where the split
               * is 81,352 false / 43 true / 0 null but the schema still permits
               * null, and `.eq(false)` would silently drop any row that acquires
               * one.
               */
              .not('is_deleted', 'is', true);
            // A failed read used to be indistinguishable from "no tables": the
            // error was destructured away, `tablesData` came back null, and the
            // page showed an empty Tables tab and no WATCH button as though the
            // event had no felt. Keep whatever we already had instead.
            if (!getIsMounted()) return;
            if (tablesErr) {
              complete = false;
              reportError(tablesErr, 'TournamentDetails.Tables_load_failed');
            }
            if (!tablesErr && (!getIsMounted || getIsMounted())) {
              setTables(
                owner.tablePatches.reduce(
                  (previous, patch) => patch(previous),
                  (tablesData || []) as TournamentTable[]
                )
              );
              owner.tablePatches = null;
            }
          }

          /* The union-name lookup that used to live here is gone. UnionsTab
           resolves the union AND every participating club itself, in two
           queries, which is strictly more than the one name this page fetched
           and then rendered in a tab it no longer owns. */
        } else {
          setEntries([]);
          setTables([]);
          setIsRegistered(false);
        }
        if (!getIsMounted()) return;
        if (complete) {
          owner.hasSnapshot = true;
          setSnapshotReady(true);
          setLoadError(null);
        } else {
          setLoadError(
            owner.hasSnapshot
              ? 'Tournament Details Could Not Be Refreshed. Showing The Last Confirmed Data.'
              : 'Tournament Details Could Not Be Loaded.'
          );
        }
      } catch (error) {
        if (!getIsMounted()) return;
        setLoadError(
          owner.hasSnapshot
            ? 'Tournament Details Could Not Be Refreshed. Showing The Last Confirmed Data.'
            : 'Tournament Details Could Not Be Loaded.'
        );
        reportError(error, 'TournamentDetails.Failed_to_load_tournament');
        /* A quiet refresh that fails is a retry next tick, not a toast. Toasting
         it would put an error on screen every few seconds for the whole of a
         network wobble, on a page that is otherwise still perfectly readable. */
        if (!opts?.quiet && (!getIsMounted || getIsMounted()))
          toast.error('Failed To Load Tournament Details');
      }
      if (!opts?.quiet && (!getIsMounted || getIsMounted())) setIsLoading(false);
    };
    owner.inFlight = (async () => {
      try {
        do {
          owner.pending = false;
          await readSnapshot();
          owner.tournamentPatches = null;
          owner.entryPatches = null;
          owner.tablePatches = null;
        } while (owner.pending && isOwner());
      } finally {
        owner.inFlight = null;
      }
    })();
    return owner.inFlight;
  };

  /**
   * Dan 2026-08-25 (binding): "you don't need a secondary confirmation for buy
   * ins."
   *
   * This page used to open its OWN Sign Up card (local `showSignUpModal`
   * state), and then, on Confirm, call `registerMtt` - which opened a SECOND,
   * generic "Confirm Buy In" dialog inside the hook. Two dialogs, one buy-in.
   *
   * The card itself was the good one, so it moved into
   * `components/tournament/signUpDialog` and the hook now shows it. This page
   * therefore just registers: the hook asks, once, with the same card the
   * player saw before. `isLate` only changes its heading.
   */
  const handleRegister = (isLate = false) => {
    if (!tournament) return;
    const t = tournament as unknown as {
      is_bounty?: boolean;
      bounty_amount?: number;
      is_pko?: boolean;
      is_mystery_bounty?: boolean;
      club_id?: string | null;
    };
    const owner = snapshotOwnerRef.current;
    registerMtt(
      {
        id: tournament.id,
        name: tournament.name,
        buy_in_amount: tournament.buy_in_amount,
        buy_in_fee: tournament.buy_in_fee,
        bounty_amount: t.is_bounty ? t.bounty_amount || 0 : 0,
        is_pko: !!t.is_pko,
        is_mystery_bounty: !!t.is_mystery_bounty,
        start_time: tournament.start_time,
        // main's typed `t` cast is cleaner than the `as any` this branch had.
        club_id: t.club_id ?? null,
        // The hook derives late-registration from status, so LATE_REG is not
        // missed the way five hand-rolled `=== 'RUNNING'` copies missed it.
        status: tournament.status,
        /* `undefined`, not `false`. The hook does
           `t.is_late_registration ?? isLateStatus(t.status)`, and `false ?? x`
           is `false`, so passing the boolean from a pre-start Register button
           overrode the derivation and gave a late entrant pre-start guidance.
           Only ever force it to TRUE. */
        is_late_registration: isLate || undefined,
      },
      () => {
        if (!owner?.active || snapshotOwnerRef.current !== owner) return;
        setIsRegistered(true);
        void loadTournament(undefined, { quiet: true });
      }
    );
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  THE FEATURED TABLE - Dan 2026-08-25 (binding)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * "In MTT, when I click on a tournament that's RUNNING I should be able to
   *  click a button and watch the tournament. It should take you directly to
   *  the FEATURED TABLE of the tournament automatically."
   *
   * There was no way to watch a running tournament you were not in. Every
   * surface either sent you to this page (`onViewTable` in ClubHomePage sends a
   * running MTT to `/tournaments/:id`, not to a felt), disabled its own button
   * unless you were registered (TournamentPage, TournamentLobbyCard), or showed
   * an inert "In Progress" badge (the footer below).
   *
   * WHAT MAKES A TABLE "FEATURED". The chip leader's table, which is what a
   * televised final table is and what a player means by "the featured table" -
   * the action that decides the tournament. Falling back, in order:
   *
   *   1. the table of the highest-stacked player who is still PLAYING;
   *   2. the fullest ACTIVE table, when no entry carries a table id yet (an
   *      early running tournament whose roster rows have not been stamped);
   *   3. any LIVE table, so the button still works rather than disappearing;
   *   4. null - and then no button is offered, rather than one that errors.
   *
   * Deliberately derived on the client from data this page already holds and
   * already keeps live over realtime (`entries` and `tables` both have their
   * own subscriptions), rather than a `featured_table_id` column that would
   * need writing, backfilling and keeping correct as the chip lead changes
   * hands every few hands.
   */
  const featuredTableId = useMemo(() => {
    const activeTableIds = new Set(
      tables.filter((t) => (t.status || '').toLowerCase() !== 'closed').map((t) => t.id)
    );

    /* 2026-08-25, second audit: this filter used to disable ITSELF when the
       live-table set was empty (`activeTableIds.size === 0 || ...`), which is
       exactly the state during the first render before the tables query
       resolves, and also the state when every table is closed. The leader's
       possibly-stale `table_id` was then returned before the live-only
       fallback below was ever reached — so the very bug this guard was added
       to prevent survived it. No live tables now means no leader: the button
       is simply not offered until we know of one. */
    const leader = entries
      .filter((e) => e.status === 'playing' && e.table_id)
      .filter((e) => activeTableIds.has(e.table_id as string))
      .sort((a, b) => (b.chips || 0) - (a.chips || 0))[0];
    if (leader?.table_id) return leader.table_id;

    const live = tables.filter((t) => (t.status || '').toLowerCase() !== 'closed');

    const fullest = [...live].sort(
      (a, b) => (b.current_players || 0) - (a.current_players || 0)
    )[0];
    if (fullest?.id) return fullest.id;

    /* 2026-08-25 audit: this used to be `tables[0]?.id`, with a comment saying
       "any table at all, so the button still works rather than disappearing".
       That is backwards - `tables[0]` can be a CLOSED table, and a WATCH button
       that opens a dead felt is worse than no button. If nothing is live there
       is nothing to watch, and returning null hides the button, which is the
       honest outcome. */
    return live[0]?.id ?? null;
  }, [entries, tables]);

  /**
   * Open a table as a spectator. Used by the footer's WATCH button and handed
   * to the tabs as `onWatchPlayer`, so an Entries row leads to the same place.
   *
   * 2026-08-25 audit: this used to be a bare `navigate('/table/'+id)`, which is
   * the weaker half of a helper written for exactly this job.
   * `utils/observeTable` emits OPEN_OBSERVE_TABLE *and* navigates, and its
   * docstring explains why both are required: emitting alone is a dead button
   * on a cold load (MultiTablePage is lazy and may have no subscriber yet),
   * while navigating alone CONVERTS a parked lobby tab instead of adding a
   * screen - the wrong shape for "watch this too". Both are keyed on the table
   * id and de-duplicated, so running both can only ever produce one screen.
   */
  const watchTable = useCallback(
    (tableId: string) => {
      if (!openTableAsObserver(navigate, { tableId })) {
        toast.error('That Table Is Not Available To Watch');
      }
    },
    [navigate, toast]
  );

  /**
   * IS THIS EVENT LIVE ENOUGH TO WATCH?
   *
   * 2026-08-26, third audit: every watch surface gated on `=== 'RUNNING'`, so
   * during LATE_REG — an event that is dealing, with players at tables — the
   * WATCH button vanished, the `?watch=1` intent silently did nothing, and the
   * Entries and Ranking rows went inert. That is the same blind spot
   * `isLateStatus` was written to fix on the registration side, reproduced on
   * the watching side. A tournament is watchable whenever it has started;
   * `isLateStatus` already means exactly that. */
  const isWatchable = isLateStatus(tournament?.status);

  /**
   * `?watch=1` — a Watch button somewhere else asked us to open the featured
   * table as soon as we know which one it is.
   *
   * 2026-08-25, second audit. A surface that only holds a tournament id cannot
   * resolve the featured table without a query of its own, so it passes the
   * INTENT instead and this page, which already computes `featuredTableId` from
   * data it keeps live, acts on it.
   *
   * 2026-08-26, third audit — TWO defects, both in the four lines below.
   *
   *  - `watchIntentDoneRef` is COMPONENT-scoped, and acting on the intent
   *    navigates away, which UNMOUNTS this page. Pressing Back remounts it at
   *    the same `?watch=1` url with a fresh ref, so the intent fired again and
   *    dragged the player straight back onto the felt they had just left. The
   *    docstring claimed Back was covered; it was not. The url is now rewritten
   *    with `replace`, so the intent is CONSUMED — Back returns to the lobby,
   *    and even a forced remount finds no `watch` param to act on.
   *  - it required `status === 'RUNNING'`, so a LATE_REG event — dealing, with
   *    players seated — ignored the intent entirely. See `isWatchable`.
   */
  const watchIntentDoneRef = useRef(false);
  useEffect(() => {
    if (!snapshotReady || tournament?.id !== tournamentId || watchIntentDoneRef.current) return;
    const params = new URLSearchParams(search);
    if (params.get('watch') !== '1') return;
    if (!isWatchable) return;
    if (!featuredTableId) return; // still resolving; try again when it lands
    watchIntentDoneRef.current = true;
    /**
     * Consume the intent BEFORE acting on it, so the history entry we leave
     * behind can never re-trigger it.
     *
     * ONLY ON THE REAL ROUTE (round 2). Embedded, the URL is /table/:tableId
     * and this `navigate({ search })` would resolve its missing pathname from
     * the CURRENT location — rewriting the TABLE's url and wiping the
     * `?name=&stakes=&code=` that MultiTablePage reads to name a tab it has
     * not built yet. That would trade a working Watch button for a tab
     * labelled "Table 1" with blank stakes after a reload.
     *
     * Nothing is lost by skipping it: `watchIntentDoneRef` already blocks a
     * second fire, and `watchTable` sends the player to /table/:id, which
     * converts this very lobby tab into that table and unmounts this page.
     */
    if (searchOverride === undefined) {
      params.delete('watch');
      const qs = params.toString();
      navigate({ search: qs ? `?${qs}` : '' }, { replace: true });
    }
    watchTable(featuredTableId);
  }, [
    featuredTableId,
    isWatchable,
    search,
    searchOverride,
    watchTable,
    navigate,
    snapshotReady,
    tournament?.id,
    tournamentId,
  ]);

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  "?seat=1" - TAKE THE OPEN SEAT AT A SEAT-FIRST GAME (2026-09-03)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * A Spin or a heads-up is not registered for, it is SAT AT: the buy-in is
   * taken when the seat is taken, and fn_register_for_tournament refuses the
   * registration path outright ('seat_first_variant'). The satellite heads-ups
   * added today appear on a target's Satellites tab, where the card used to
   * offer a Register button that could never succeed; it now sends the intent
   * here instead, exactly as the WATCH button above does.
   *
   * Deliberately NOT gated on `isWatchable`: the whole point is that the game
   * is still REGISTERING, which is the one status the watch intent refuses.
   * It IS gated on the table having resolved, so the effect simply waits for
   * the tables query rather than dropping the intent.
   */
  const seatIntentDoneRef = useRef(false);
  const isSeatFirstTournament = useMemo(() => {
    const v = String(tournament?.variant ?? '').toLowerCase();
    const seats = Number(tournament?.max_players ?? 0);
    return v === 'spin' || (seats > 0 && seats <= 2);
  }, [tournament?.variant, tournament?.max_players]);

  useEffect(() => {
    if (!snapshotReady || tournament?.id !== tournamentId || seatIntentDoneRef.current) return;
    const params = new URLSearchParams(search);
    if (params.get('seat') !== '1') return;
    if (!isSeatFirstTournament) return;
    if (!featuredTableId) return; // still resolving; try again when it lands
    seatIntentDoneRef.current = true;
    if (searchOverride === undefined) {
      params.delete('seat');
      const qs = params.toString();
      navigate({ search: qs ? `?${qs}` : '' }, { replace: true });
    }
    navigate(`/table/${featuredTableId}`);
  }, [
    featuredTableId,
    isSeatFirstTournament,
    search,
    searchOverride,
    navigate,
    snapshotReady,
    tournament?.id,
    tournamentId,
  ]);

  const handleUnregister = async () => {
    if (isProcessing || !tournament) return;
    if (!user) {
      toast.error('Loading your profile... please try again in a moment');
      return;
    }
    const owner = snapshotOwnerRef.current;
    setIsProcessing(true);

    try {
      const result = await tournamentService.unregisterPlayer(tournament.id, user.id);
      if (!owner?.active || snapshotOwnerRef.current !== owner) return;
      setIsRegistered(false);
      toast.success(tournamentUnregisterSuccessText(result));
      void loadTournament(undefined, { quiet: true });
    } catch (error) {
      if (!owner?.active || snapshotOwnerRef.current !== owner) return;
      reportError(error, 'TournamentDetails.Unregistration_failed');
      const msg = (error as Error).message || 'Unknown error';
      toast.error(`Unregister failed: ${msg}`);
    } finally {
      if (owner?.active && snapshotOwnerRef.current === owner) setIsProcessing(false);
    }
  };

  /**
   * Share this tournament. 2026-08-20: both the ID chip's share control and the
   * footer "Share" rendered with NO onClick at all - visible, enabled, and
   * inert on a live routed page. Web Share where available, clipboard
   * everywhere else; `navigator.share?.()` on its own silently does nothing on
   * desktop Chrome and Firefox, which is most of the people looking at a
   * tournament page.
   */
  const shareTournament = useCallback(async () => {
    const url = `${publicOrigin()}/hub/club-arena/tournaments/${tournament?.id ?? ''}`;
    const title = tournament?.name || 'Tournament';
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast?.success?.('Tournament link copied');
    } catch (err) {
      // AbortError just means the player dismissed the share sheet.
      if (err instanceof Error && err.name === 'AbortError') return;
      toast?.error?.('Could not share this tournament');
    }
  }, [tournament?.id, tournament?.name, toast]);

  /**
   * The stored structure spells the level length three ways, and one of them is
   * a TRAP: `duration` holds SECONDS (every Spin stores `duration: 180`), while
   * `durationMinutes` / `duration_minutes` hold minutes. Reading `duration`
   * first - which this mapper used to do - drew a three minute Spin level as
   * three HOURS. `NormalisedBlindLevel.duration` is contractually minutes, and
   * `blindLevelMinutes` is the one reader that gets the precedence right.
   */
  const blindLevels = useMemo<NormalisedBlindLevel[]>(() => {
    const raw =
      typeof tournament?.blind_structure === 'string'
        ? (() => {
            try {
              return JSON.parse(tournament.blind_structure as string);
            } catch {
              return [];
            }
          })()
        : tournament?.blind_structure || [];
    if (!Array.isArray(raw)) return [];
    const rows = raw as Parameters<typeof blindLevelMinutes>[0];
    return raw.map((row: Record<string, unknown>, i: number) => {
      const level = Number(row.level ?? i + 1);
      return {
        level,
        smallBlind: Number(row.smallBlind ?? row.small_blind ?? 0),
        bigBlind: Number(row.bigBlind ?? row.big_blind ?? 0),
        ante: Number(row.ante ?? 0),
        duration: blindLevelMinutes(rows, level),
        isBreak: Boolean(row.isBreak ?? row.is_break ?? false),
      };
    });
  }, [tournament?.blind_structure]);

  /**
   * The tab contract, built once. Every tab takes exactly this and nothing
   * else, so switching tabs is a render, not a refetch.
   *
   * `onWatchPlayer` is handed over only while the event is RUNNING (Dan
   * 2026-08-25: "you can go to Tables or Ranking and see any player and be
   * redirected to that table directly") - a finished event's table ids point at
   * closed felts, and a tab that receives no handler renders no link.
   */
  const tabProps = useMemo<TournamentTabProps | null>(
    () =>
      tournament
        ? {
            tournament,
            entries,
            tables,
            blindLevels,
            currentUserId: user?.id,
            isRegistered,
            /* `isWatchable`, not `isRunning`: during LATE_REG the event is
               dealing and every one of these rows points at a live table, but
               the old gate made them inert (2026-08-26 audit). */
            onWatchPlayer: isWatchable ? watchTable : undefined,
            mysteryBounty: isMysteryBountyEvent ? mysteryBounty : null,
            onOpenTab: setActiveTab,
          }
        : null,
    [
      tournament,
      entries,
      tables,
      blindLevels,
      user?.id,
      isRegistered,
      /* `isWatchable`, not `isRunning`: the BODY reads isWatchable (LATE_REG
         counts as watchable, RUNNING alone does not cover it), so listing the
         other one here is a stale-closure waiting to happen. Not currently
         exploitable only because the `tournament` object identity changes on
         any status transition and re-runs this anyway - which is luck, not a
         guarantee. Depend on what you read. */
      isWatchable,
      watchTable,
      isMysteryBountyEvent,
      mysteryBounty,
    ]
  );

  const recoveryNotice = loadError ? (
    <div role="alert" className="tournament-recovery-notice">
      <p>{loadError}</p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void loadTournament(undefined, { quiet: true })}
      >
        Try Again
      </button>
    </div>
  ) : null;

  if (isLoading) {
    return (
      <div className="tournament-details loading">
        <div className="loader-spinner" />
        <p>Loading Tournament...</p>
      </div>
    );
  }

  if (loadError && !snapshotOwnerRef.current?.hasSnapshot) {
    return <div className="tournament-details error">{recoveryNotice}</div>;
  }

  // tabProps is null exactly when `tournament` is null, so this one guard
  // covers both and TypeScript keeps its narrowing all the way down.
  if (!tournament || !tabProps) {
    return (
      <div className="tournament-details error">
        <h2>Tournament Not Found</h2>
        {/* Dan 2026-08-28: "Back To Clubs" is a real anchor to a route OUTSIDE
            /table/*, so in the in-tab lobby it did the exact thing this whole
            change exists to stop - one 404 satellite and the action bar, the
            tab strip and every running game's container were gone. In the tab
            the way back is MultiTablePage's own "Lobby" pill, rendered
            directly above this; offering a second, destructive one is worse
            than offering none. On the real route the link is unchanged. */}
        {!tournamentIdOverride && (
          <Link to="/clubs" className="btn btn-primary">
            Back To Clubs
          </Link>
        )}
      </div>
    );
  }

  const shortDescription = (tournament as unknown as { short_description?: string | null })
    .short_description;

  return (
    <PageErrorBoundary pageName="TournamentDetails">
      <div className="tournament-details" ref={shellRef} data-active-tab={activeTab}>
        {recoveryNotice}
        {/* Header */}
        <div className="details-header">
          <h1>Game Details</h1>
        </div>

        {/* Tabs */}
        {/* A tablist is a ROVING focus widget, not seven tab stops. Declaring
            role="tablist" without implementing that is worse than plain
            buttons: a screen reader announces "tab, 3 of 7" and then the arrow
            keys the announcement just promised do nothing. So: exactly one tab
            is tabbable, Left/Right move (wrapping), Home/End jump, and each
            tab owns the panel by id. */}
        <div className="details-tabs" role="tablist" aria-label="Tournament Sections">
          {TABS.map((tab, i, visibleTabs) => (
            <button
              key={tab.id}
              id={`tl-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls="tl-tabpanel"
              tabIndex={activeTab === tab.id ? 0 : -1}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              className={`tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => {
                const last = visibleTabs.length - 1;
                let next = -1;
                if (e.key === 'ArrowRight') next = i === last ? 0 : i + 1;
                else if (e.key === 'ArrowLeft') next = i === 0 ? last : i - 1;
                else if (e.key === 'Home') next = 0;
                else if (e.key === 'End') next = last;
                if (next === -1) return;
                e.preventDefault();
                setActiveTab(visibleTabs[next].id);
                tabRefs.current[next]?.focus();
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Title strip. The name, the short id, the share button, the price and
            the owner's own blurb. Everything else that used to sit here -
            FREEZEOUT / REBUY / ADD-ON, the bounty line, MULTI-DAY, XMTT, SPIN,
            the parity tag row and EARLY BIRD - is rendered as badges by
            DetailOverviewTab. Printing both said the same thing twice and cost
            about 120px of the one screen this page is supposed to fit in. */}
        <div className="details-title">
          <div className="tournament-title">
            <h2>
              {tournament.guaranteed_prize && tournament.guaranteed_prize > 0
                ? `${chipsCompact(tournament.guaranteed_prize)} GTD `
                : ''}
              {tournament.name}
            </h2>
            <span className="tournament-id">ID:{tournament.id.slice(0, 8)}</span>
            <button
              className="qr-btn"
              type="button"
              onClick={() => void shareTournament()}
              aria-label="Share This Tournament"
            >
              ⊞
            </button>
          </div>
          <div className="tournament-desc">
            {/* Whole chips only (Dan 2026-08-20) - formatBuyIn leads with the
                total the player actually pays and never prints a decimal. */}
            <p className="tournament-buyin">
              {formatBuyIn(tournament.buy_in_amount, tournament.buy_in_fee)} CHIPS BUY-IN
            </p>
            {/* Owner-written short description (2026-08-22). No tab renders it:
                it is the event's own identity copy, not a figure, so it belongs
                beside the name on every tab rather than inside one. */}
            {shortDescription && <p className="tournament-blurb">{shortDescription}</p>}
          </div>
        </div>

        {/* The only part of the shell that grows. Each tab scrolls inside
            itself via the shared `.tl-scroll`, so the page keeps exactly one
            scrollbar and the footer never moves. */}
        <div
          className="details-content"
          role="tabpanel"
          id="tl-tabpanel"
          /* Named by whichever tab is selected, so the panel announces what it
             is instead of "tab panel". Focusable at -1 so the arrow-key move
             above has somewhere to send focus next. */
          aria-labelledby={`tl-tab-${activeTab}`}
          tabIndex={-1}
        >
          {activeTab === 'detail' && <DetailOverviewTab {...tabProps} />}
          {activeTab === 'blinds' && <BlindsTab {...tabProps} />}
          {activeTab === 'ranking' && <RankingTab {...tabProps} />}
          {activeTab === 'entries' && <EntriesTab {...tabProps} />}
          {activeTab === 'unions' && <UnionsTab {...tabProps} />}
          {activeTab === 'tables' && <TablesTab {...tabProps} />}
          {activeTab === 'rewards' && <RewardsTab {...tabProps} />}
          {activeTab === 'satellites' && <SatellitesTab {...tabProps} />}
        </div>

        {/* Footer Actions. A flex child of the shell, NOT `position: fixed`:
            the fixed version offset itself by `--bottom-nav-clearance` to clear
            a bottom nav this page does not render, which is the dead 74px gap
            Dan reported under it. As a flex child there is no offset left to be
            wrong. */}
        <div className="details-footer">
          <button className="btn btn-share" type="button" onClick={() => void shareTournament()}>
            Share
          </button>
          {(() => {
            const myEntry = entries.find((e) => e.user_id === user?.id);

            /* `isWatchable` covers LATE_REG as well as RUNNING. A late-reg
               event has players at tables — refusing to show WATCH for it was
               the same blind spot the registration side already fixed. */
            /**
             * ═════════════════════════════════════════════════════════════════
             *  TAKE SEAT (Dan 2026-08-30, binding: "there needs to be a take
             *  seat button, there isn't")
             * ═════════════════════════════════════════════════════════════════
             *
             * There was one control here that took a player to their own seat,
             * it was labelled ENTER TABLE, and it was gated on
             * `status === 'playing'`. Three things were wrong with that.
             *
             * IT SAID THE WRONG THING. "Enter table" is what a spectator does.
             * The player has paid a buy-in and has a seat with their stack in
             * it; the action is taking it. Now that the engine seats the field
             * a minute before the cards (TOURNAMENT_PRESEAT_LEAD_MS), that
             * minute is exactly when a player wants a button that says so.
             *
             * IT WAS NOT OFFERED TO A SEATED 'registered' PLAYER. Late
             * registration seats you at the moment you register
             * (fn_seat_late_registrant) while your row can still read
             * 'registered' for a beat — so a player who had just paid, and
             * whose seat existed, was shown the passive badge WAITING FOR
             * SEAT... over the top of a seat they already had. The test is a
             * table id, which is the thing that is true when there is a seat to
             * take, not a status enum that is true slightly later.
             *
             * IT WAS THE ONLY WAY IN, AND IT WAS AUTOMATIC. The auto-open
             * effect above navigates once per tournament; if a player dismisses
             * that, opens the lobby from the felt (where auto-open is
             * deliberately suppressed), or is looking at the card on a second
             * device, there was nothing on screen to press. A button that is
             * always there costs nothing and removes a whole class of "it
             * froze" — which is what a card with no control on it looks like,
             * whatever the server is doing.
             */
            if (isWatchable) {
              if (
                myEntry?.table_id &&
                (myEntry.status === 'playing' || myEntry.status === 'registered')
              ) {
                return (
                  <Link
                    to={`/table/${myEntry.table_id}`}
                    className="btn btn-enter-table btn-take-seat"
                  >
                    TAKE SEAT
                  </Link>
                );
              }
              /* Dan 2026-08-25: every branch below used to END the footer - a
                 badge, a countdown, or nothing. So a running tournament you
                 were not playing in offered no way onto its felt at all. WATCH
                 rides alongside whatever else the branch says, because "I am
                 waiting for a seat" and "I want to see the action" are not
                 mutually exclusive, and a busted player still wants to watch
                 the rest of it out. See featuredTableId. */
              const watchBtn = featuredTableId ? (
                <button
                  className="btn btn-watch"
                  type="button"
                  onClick={() => watchTable(featuredTableId)}
                  title="Watch The Featured Table"
                >
                  WATCH
                </button>
              ) : null;

              if (myEntry?.status === 'registered') {
                return (
                  <>
                    <span className="tournament-status-badge running">WAITING FOR SEAT...</span>
                    {watchBtn}
                  </>
                );
              }
              if (myEntry?.status === 'eliminated') {
                return (
                  <>
                    <span className="tournament-status-badge cancelled">ELIMINATED</span>
                    {watchBtn}
                  </>
                );
              }
              if (!isRegistered && lateRegCountdown) {
                return (
                  <>
                    <button
                      className="btn btn-register late-reg"
                      type="button"
                      onClick={() => handleRegister(true)}
                      disabled={isRegisteringMtt}
                    >
                      Late Register ({lateRegCountdown})
                    </button>
                    {watchBtn}
                  </>
                );
              }
              return (
                <>
                  <span className="tournament-status-badge running">In Progress</span>
                  {watchBtn}
                </>
              );
            }

            if (tournament.status === 'COMPLETED') {
              return <span className="tournament-status-badge completed">Completed</span>;
            }
            if (tournament.status === 'CANCELLED') {
              return <span className="tournament-status-badge cancelled">Cancelled</span>;
            }

            if (isRegistered) {
              return (
                <button
                  className="btn btn-unregister"
                  type="button"
                  onClick={handleUnregister}
                  disabled={isProcessing}
                >
                  {isProcessing ? 'Processing...' : 'Unregister'}
                </button>
              );
            }

            return (
              <button
                className="btn btn-register"
                type="button"
                onClick={() => handleRegister(false)}
                disabled={isRegisteringMtt}
              >
                {isRegisteringMtt ? 'Processing...' : 'Register'}
              </button>
            );
          })()}
        </div>

        {/* The Sign Up card that used to live here is now
            `components/tournament/signUpDialog`, shown by
            useTournamentRegistration for EVERY register button in the app.
            Dan 2026-08-25: "you don't need a secondary confirmation for buy
            ins" - this local copy plus the hook's own prompt was the pair that
            asked twice. Do not re-add a page-local buy-in modal. */}
      </div>

      {/* Mystery bounty celebration. Mounted on the SURFACE rather than inside a
          tab: it is `position: fixed`, it listens to the engine's own broadcast
          channel so an observer holding no entry still hears it, and a reveal
          can land while the player is looking at any tab at all. It renders
          nothing until a top-three chest is pulled. */}
      {tournamentId && <MysteryBountyCelebration tournamentId={tournamentId} />}

      {/* Final Table Overlay */}
      {tournament.status === 'RUNNING' && tournamentId && (
        <FinalTableOverlay
          tournamentId={tournamentId}
          tournamentName={tournament.name || 'Tournament'}
          prizePool={tournament.prize_pool || 0}
        />
      )}
    </PageErrorBoundary>
  );
}

export { TournamentDetails };

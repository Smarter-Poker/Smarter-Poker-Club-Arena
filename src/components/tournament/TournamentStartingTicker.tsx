/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT STARTING TICKER - the 5-minute call (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "When a scheduled MTT is about to start... 5 minutes left. there should
 * be a scrolling announcement across all active club/union cash games and
 * tournaments."
 *
 * A scheduled MTT with nobody registered is a dead tournament, and the players
 * who would fill it are already sitting at cash tables in the same club, seeing
 * nothing. This is the last call, and it has to reach them WHERE THEY ARE -
 * which is why it mounts at the app root, outside <Routes>, next to the other
 * global hosts.
 *
 * SCOPE
 *   Tournaments in a club the player is a member of.
 *
 *   THIS HEADER USED TO SAY "or in a union one of those clubs belongs to" AND
 *   THE CODE HAS NEVER DONE THAT (corrected 2026-09-05). It cannot, from here:
 *   `tournaments_select` is `is_club_member(club_id, auth.uid())`, so a sibling
 *   club's rows come back empty however many ids the query passes. Widening the
 *   `.in()` list would have looked like coverage and delivered none. Reaching a
 *   union sibling's event needs either a membership-widening RLS change or a
 *   SECURITY DEFINER feed function, and which of those is right is a product
 *   and security decision rather than an implementation detail. The contract
 *   and the code agree now, which is the part that was actually broken.
 *
 * WHAT THIS BAR IS ALLOWED TO SAY (Dan 2026-09-01, verbatim: "the ticker needs
 * to be adjusted to only announce when a MTT Is starting, and only if an
 * overlay alert is in the last level of late registration, and has less then
 * 50% of the prize pool of the guarantee yet registered")
 *
 *   1. AN MTT IS STARTING, inside the five-minute window below.
 *   2. AN OVERLAY ALERT, and only when BOTH of Dan's conditions hold. Both
 *      gates are enforced in utils/overlayAnnouncements.
 *   ...plus the six operator-controlled sources in TickerManagementPanel, each
 *   of which a club can switch off.
 *
 * ── WHAT THIS FILE STOPPED DOING (audit 2026-09-05) ─────────────────────────
 *
 * It was 951 lines doing eight jobs, and the eighth - the render - was the one
 * nothing tested and every visible defect lived in. The parts that can be
 * asserted without a browser now live beside it and are:
 *
 *   tickerTheme.ts        the colour rules, including the derived flag ink
 *   tickerMessages.ts     what each source says, its severity and its expiry
 *   tickerDismissals.ts   one dismissal store, every source, with a TTL
 *   marqueeMetrics.ts     how many copies and how fast
 *   useTopChromeOffset.ts where the rail starts
 *   useTickerMarquee.ts   the measuring half of the marquee
 *   TickerRail.tsx        the strip itself
 *
 * What is left here is the part that genuinely needs the network: who this
 * player is, what their clubs are running, and what their club has configured.
 *
 * TIMING
 *   Polls every 30s and counts down locally every second, so every number on
 *   screen is honest between polls - all of them now, not just the first one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { reportError, reportWarning } from '../../utils/errorReporter';
import { busToast, type BusPayloadMap } from '../../core/MasterBus';
import { useTableSettings } from '../../hooks/useTableSettings';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import {
  DEFAULT_TICKER_SETTINGS,
  resetTickerSettingsCache,
  tickerManagementService,
  type ManagedTickerSettings,
} from '../../services/TickerManagementService';
import { isUUID, resolveClubUUID } from '../../utils/clubIdResolver';
import { rankOverlayAnnouncements, type OverlayCandidate } from '../../utils/overlayAnnouncements';
/* The value comes from the small extracted module and the row shape is a
   type-only import, so this root-mounted ticker does not pull the whole
   lobby view-model into the entry bundle every player downloads. */
import { lateRegEndMs } from '../lobby/lateRegWindow';
import { isInsideLastCall, MAX_LEAD_MS } from './tickerLeadWindow';
import type { LobbyTournamentRow } from '../lobby/lobbyEntries';
import {
  guaranteeItem,
  operatorItem,
  overlayItem,
  registrationClosingItem,
  startingSoonItem,
  tableOpeningItem,
  tickerLaneFor,
  winnerResultsItem,
  type TickerItem,
  type UpcomingTournament,
} from './tickerMessages';
import { dismissItem, onDismissedElsewhere, readDismissed } from './tickerDismissals';
import { tickerTelemetry } from '../../services/TickerTelemetry';
import { fetchTickerFeed } from '../../services/TickerFeed';
import { announce as announceToChime } from './tickerChime';
import { useTopChromeOffset } from './useTopChromeOffset';
import { useRailSilence } from './useRailSilence';
import { TickerRail } from './TickerRail';

/* `LEAD_MS = 5 minutes` used to live here and was the ONE horizon for every
   event on the rail. It has been `leadMsFor(totalBuyIn)` since 2026-09-13 - a
   $200 major is announced fifteen minutes out, a $2 turbo five - and the
   constant survived the change unreferenced. Removed 2026-09-14 rather than
   left next to its replacement, where it reads like a second opinion. */
/** How often we ask the database. The countdown itself ticks locally. */
const POLL_MS = 30_000;
/** How long a cached club-membership list is trusted. */
const SCOPE_TTL_MS = 5 * 60_000;
/**
 * How often the HOST re-evaluates - expiry and the spoken line, not the digits.
 *
 * The visible countdown is TickerClock's own interval. This used to be 1000ms
 * and it re-ran the lane memo and rebuilt every announcement on every tick.
 */
const CONTAINER_TICK_MS = 5_000;
/** How long the exit animation runs before the strip is unmounted. */
const LEAVE_MS = 240;

interface Scope {
  clubIds: string[];
  /**
   * club id -> club name, for the clubs this player belongs to.
   *
   * Read once per scope (five-minute TTL) rather than per poll: the feed is
   * scoped to every club the player is in, so an announcement can be about a
   * club other than the one whose rail is being painted, and the player has no
   * way to tell which. Names are what tells them.
   */
  fetchedAt: number;
  userId: string | null;
}

/**
 * ── THE HOST: EVERYTHING THAT COSTS SOMETHING ─────────────────────────────
 *
 * Mounted only by the gate at the foot of this file, and only on a route where
 * the bar can actually appear. That sentence was not true until 2026-09-13.
 *
 * THE POLL HAD NO ROUTE GUARD. `onTickerRoute` gated the settings read and the
 * render; the FEED effect - four to five Supabase queries every thirty seconds
 * - was never gated by it at all. A player sitting on the cashier, the
 * leaderboard, their profile or the club list had a browser fetching
 * tournaments, registrations, overlay candidates and table openings twice a
 * minute, for a strip that cannot render on any of those routes. It predates
 * this programme and it survived the load pass, because that pass gated each
 * query on its SOURCE and never asked whether the component should be running
 * at all.
 *
 * A hook cannot be called conditionally, so the only way to not pay for one is
 * to not mount the thing that calls it. That is why this file has two
 * components now.
 */
function TickerHost() {
  const navigate = useNavigate();
  const location = useLocation();
  /* Dan 2026-08-28: "add a toggle in the table settings, and in the Club
     Arena settings, to turn the ticker on or off." useTableSettings is the
     shared store both settings surfaces write (localStorage +
     SETTINGS_CHANGED bus), so flipping the toggle anywhere kills or revives
     this bar live, no reload. Hook called unconditionally, above every
     early return - hook order must stay stable. */
  const [managedTicker, setManagedTicker] =
    useState<ManagedTickerSettings>(DEFAULT_TICKER_SETTINGS);
  const [tickerScopeRevision, setTickerScopeRevision] = useState(0);
  const [viewerRevision, setViewerRevision] = useState(0);
  const scopeEpochRef = useRef(0);
  /**
   * The club whose rail this is - the one whose colours and source switches
   * are painting the strip. An announcement about any OTHER club is named.
   */
  const railClubIdRef = useRef<string | null>(null);
  /** (reason, scope) pairs already reported this mount. See warnOnce below. */
  const warnedScopesRef = useRef<Set<string>>(new Set());

  /* The live ticker belongs on active tables and inside a club's live lobby.
     The club route matters: its desktop reference reserves this exact strip
     below the global header, and suppressing it there left no ticker band at
     all. Other Club Arena pages remain quiet. The drawer is additionally
     stacked above this strip in HamburgerMenu.module.css. */
  const atLiveTable = location.pathname.startsWith('/table');
  const atClubLobby = /^\/clubs\/[^/]+(?:\/lobby)?\/?$/.test(location.pathname);
  const onTickerRoute = atLiveTable || atClubLobby;

  useMasterBusSubscription('TICKER_SETTINGS_CHANGED', () => {
    setTickerScopeRevision((value) => value + 1);
  });

  /* ── AN OPERATOR'S CHANGE HAS TO REACH A SEATED PLAYER ────────────────────
     TICKER_SETTINGS_CHANGED is emitted from realtime on GameManagementPage -
     the OPERATOR'S own tab - and `game_management_events` is readable only by
     operators, so a player can never be subscribed to it. Until this pass a
     player refetched managed settings when `location.pathname` changed, and a
     seated player does not change route for hours: publishing an urgent
     SERVICE NOTICE reached nobody who was currently playing, which is the
     entire purpose of the maintenance and custom sources.

     The settings RPC is member-gated, cheap, and already authorised for every
     player in the club, so it simply rides the existing 30-second tick. A
     club's change now reaches every seated player inside half a minute with no
     DDL, no new read surface and no new RLS policy to get wrong. The bus event
     above still gives the operator's own tab an instant update. */
  useEffect(() => {
    if (!onTickerRoute) return undefined;
    let cancelled = false;
    let inFlight = false;
    let pending = false;
    const epoch = scopeEpochRef.current;

    /* OBSERVABLE ONCE, NOT ONCE EVERY THIRTY SECONDS. This effect re-polls on
       a 30s tick, so anything it reports on a scope it cannot resolve repeats
       for as long as the player sits there - which is precisely how the rail's
       last reporting bug turned one wrong route into 243 database rows. Each
       distinct (scope, reason) speaks once per mount. console.warn is the
       right level and the right channel: HorseBugReporter patches
       console.error only, so a warning can never be persisted as a bug. */
    const warnOnce = (scope: string, reason: string, segment: string) => {
      const key = `${reason}:${scope}`;
      if (warnedScopesRef.current.has(key)) return;
      warnedScopesRef.current.add(key);
      const what =
        reason === 'unresolvedSegment'
          ? `Route segment "${segment}" is not an id, so the ticker is using platform defaults.`
          : `No readable row for "${segment}", so the ticker is using platform defaults.`;
      reportWarning(what, 'TournamentStartingTicker.unscopedTicker', { scope, reason });
    };

    const loadManaged = async () => {
      if (cancelled || document.hidden || epoch !== scopeEpochRef.current) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      pending = false;
      try {
        let clubUuid: string | null = null;
        let unionUuid: string | null = null;
        const clubMatch = location.pathname.match(/^\/clubs\/([^/]+)/);
        const tableMatch = location.pathname.match(/^\/table\/([^/]+)/);
        if (clubMatch) {
          /* A ROUTE SEGMENT IS NOT AN ID UNTIL SOMETHING SAYS IT IS.
             resolveClubUUID's documented contract is that it returns its INPUT
             when it cannot resolve one ("Fallback: return as-is (will fail
             downstream, but that's the existing behavior)"), so a slug nobody
             owns arrives here as a slug. Feeding that to .eq('id', ...) is the
             same 22P02 the table branch below used to raise, from the branch
             that looks guarded. Check the value that is about to be used, not
             the function that produced it. */
          const resolved = await resolveClubUUID(clubMatch[1]);
          if (isUUID(resolved)) {
            clubUuid = resolved;
            const { data, error } = await supabase
              .from('clubs')
              .select('union_id')
              .eq('id', clubUuid)
              .maybeSingle();
            if (error) throw error;
            if (!data) warnOnce(`club:${clubUuid}`, 'noSuchClub', clubMatch[1]);
            unionUuid = data?.union_id || null;
          } else {
            warnOnce(`club:${clubMatch[1]}`, 'unresolvedSegment', clubMatch[1]);
          }
        } else if (tableMatch) {
          /* THE ASYMMETRY THAT COST 243 ROWS (fixed 2026-09-12). This branch
             put the raw path segment straight into a uuid column, so every
             /table/<not-a-uuid> raised Postgres 22P02, the catch below called
             reportError, HorseBugReporter's console.error hook filed it as a
             tournament_bug (the CONTEXT LABEL contains "Tournament"), and the
             production E2E route specs re-ran it on every deploy for ten days.
             A segment that cannot be a uuid is not a table: fall to defaults
             without the round trip and without filing anything. Fail at the
             boundary once, not once per poll in Postgres. */
          if (isUUID(tableMatch[1])) {
            const { data, error } = await supabase
              .from('tables')
              .select('club_id,union_id')
              .eq('id', tableMatch[1])
              .maybeSingle();
            if (error) throw error;
            /* .maybeSingle() answers {data: null, error: null} for a well-formed
               uuid with no row a viewer may read - no row, no error, no report,
               and the rail silently served platform defaults instead of the
               club's own settings. That is a DIFFERENT defect from the 22P02
               flood and it was found beside it; it is a warning rather than an
               error because RLS makes it reachable without anything being
               broken. warnOnce keeps it from becoming the next flood. */
            if (!data) warnOnce(`table:${tableMatch[1]}`, 'noSuchTable', tableMatch[1]);
            clubUuid = data?.club_id || null;
            unionUuid = data?.union_id || null;
          } else {
            warnOnce(`table:${tableMatch[1]}`, 'unresolvedSegment', tableMatch[1]);
          }
        }
        /* Whatever the route resolved to is the club this rail belongs to.
           Recorded before the settings call so the feed can tell an
           announcement about HERE from one about somewhere else. */
        railClubIdRef.current = clubUuid;
        const next = await tickerManagementService.get(unionUuid ? null : clubUuid, unionUuid);
        if (!cancelled && epoch === scopeEpochRef.current) setManagedTicker(next);
      } catch (error) {
        reportError(error, 'TournamentStartingTicker.loadManagedSettings');
        /* NOT a reset to defaults. `tickerManagementService.get` already holds
           the last authoritative answer and hands it back on a failed read, so
           a club that switched the rail OFF stays off through a transient
           error instead of being switched back on with a different set of
           sources. See TickerManagementService. */
      } finally {
        inFlight = false;
        if (pending && !cancelled && !document.hidden) void loadManaged();
      }
    };

    void loadManaged();
    const poll = setInterval(() => {
      if (!document.hidden) void loadManaged();
    }, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) void loadManaged();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [location.pathname, onTickerRoute, tickerScopeRevision, viewerRevision]);

  const [items, setItems] = useState<TickerItem[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed());
  const scopeRef = useRef<Scope | null>(null);
  const notifiedRef = useRef<Record<string, { fiveMin: boolean; ninetySec: boolean }>>({});
  const itemsRef = useRef(items);

  const headerBottom = useTopChromeOffset(location.pathname);
  /* The two states in which this bar must say nothing: a player who asked to be
     stopped, and a house that is closed. See useRailSilence - both were
     invisible to this component until 2026-09-13, and the first one needed a
     database policy before it could even be asked honestly. */
  const silence = useRailSilence();
  const tickerRef = useRef<HTMLDivElement | null>(null);

  /* ── WHOSE CLUBS, AND FOR HOW LONG ────────────────────────────────────────
     This was a bare ref populated once and never invalidated: join a club and
     its events stayed silent until a hard reload, and switching accounts left
     the rail scoped to the previous user's clubs. It carries the user it was
     built for and a five-minute floor now, and the two bus events that can
     make it wrong clear it immediately. */
  const invalidateScope = useCallback(
    (
      payload:
        | BusPayloadMap['AUTH_STATE_CHANGED']
        | BusPayloadMap['CLUB_JOINED']
        | BusPayloadMap['CLUB_LEFT']
    ) => {
      if ('isAuthenticated' in payload) {
        // Token rotation re-emits auth for the same viewer. Keep the confirmed
        // rail and its toast history; there is no account transition to replay.
        if (scopeRef.current?.userId === payload.userId) return;
        resetTickerSettingsCache();
      }
      // Retire requests synchronously, before React runs effect cleanup. A slow
      // response must not repopulate either the scope or the previous viewer's rail.
      scopeEpochRef.current += 1;
      scopeRef.current = null;
      itemsRef.current = [];
      notifiedRef.current = {};
      setItems([]);
      setManagedTicker((previous) => ({
        ...previous,
        enabled: false,
        customMessages: [],
        serviceMessages: [],
      }));
      setViewerRevision((value) => value + 1);
    },
    []
  );
  useMasterBusSubscription('AUTH_STATE_CHANGED', invalidateScope);
  useMasterBusSubscription('CLUB_JOINED', invalidateScope);
  useMasterBusSubscription('CLUB_LEFT', invalidateScope);

  const loadScope = useCallback(async (): Promise<Scope | null> => {
    const epoch = scopeEpochRef.current;
    const { readLocalSession } = await import('../../lib/authUtils');
    const auth = readLocalSession();
    const uid = auth?.userId || null;
    const cached = scopeRef.current;
    if (cached && cached.userId === uid && Date.now() - cached.fetchedAt < SCOPE_TTL_MS) {
      return cached;
    }
    if (!uid) {
      scopeRef.current = { clubIds: [], fetchedAt: Date.now(), userId: null };
      return scopeRef.current;
    }
    try {
      const { data, error } = await supabase
        .from('club_members')
        .select('club_id')
        .eq('user_id', uid)
        .in('status', ['active', 'approved']);
      if (error) throw error;
      if (epoch !== scopeEpochRef.current || (readLocalSession()?.userId || null) !== uid) {
        return null;
      }
      const ids = (data || []).map((r: { club_id: string }) => r.club_id).filter(Boolean);

      /* THE NAMES CAME OFF THIS PATH (2026-09-14). The scope used to follow
         its membership read with a second query against `clubs`, purely so a
         cross-club announcement could say WHERE. fn_get_ticker_feed resolves
         `foreign_club_name` itself, against the club whose rail is being
         painted, so the name arrives with the row that needs it and this read
         - and the map it filled, and the chance of the two disagreeing - is
         gone. */
      scopeRef.current = { clubIds: ids, fetchedAt: Date.now(), userId: uid };
      return scopeRef.current;
    } catch (e) {
      reportError(e, 'TournamentStartingTicker.loadScope');
      // An error is not an authoritative empty membership list. Retry on the
      // next tick without poisoning the five-minute cache or borrowing a user.
      return null;
    }
  }, []);

  const sources = managedTicker.sources;

  // ── Poll for everything the enabled sources need ──
  useEffect(() => {
    /* A player the rail must not speak to does not need their browser fetching
       what it would have said. Silence stops the work, not only the paint. */
    if (silence.silent) return undefined;
    let cancelled = false;
    let inFlight = false;
    let pending = false;
    const epoch = scopeEpochRef.current;

    const fetchFeed = async () => {
      if (cancelled || document.hidden || epoch !== scopeEpochRef.current) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      pending = false;
      try {
        const scope = await loadScope();
        if (cancelled || epoch !== scopeEpochRef.current || !scope) return;
        const { clubIds } = scope;
        if (clubIds.length === 0) {
          setItems([]);
          return;
        }
        /* ── ONE CALL (2026-09-14) ─────────────────────────────────────────
           This used to be five queries in parallel - registrations, upcoming,
           overlays, an operational sweep of `tournaments` and new tables -
           every thirty seconds, for every seated player, to render ONE line.

           The sweep was both the expensive part and the broken part. For a
           real three-club member it MATCHED 1,322 rows and took the eighty
           most recently `updated_at`, a column with no trigger maintaining it,
           and the browser then filtered that slice down to the two or three
           that could actually speak. Three sources sharing one budget of
           eighty, ordered by a proxy for recency that is not reliably
           recency - the same defect as #4601, where a major was crowded off
           the rail by turbos, except silent, because a bar with nothing on it
           looks exactly like a bar with nothing to say.

           fn_get_ticker_feed filters where the rows are, with a budget PER
           source, and derives the club scope from auth.uid() inside itself, so
           the club-id list no longer travels in either direction and
           `is_registered` arrives already resolved. Registration closing went
           from 1,028 candidates to 2. */
        const feed = await fetchTickerFeed(
          {
            starting_soon: sources.starting_soon,
            overlays: sources.overlays,
            registration_closing: sources.registration_closing,
            guarantees: sources.guarantees,
            winner_results: sources.winner_results,
            table_openings: sources.table_openings,
          },
          MAX_LEAD_MS,
          railClubIdRef.current
        );

        const auth = await import('../../lib/authUtils').then((m) => m.readLocalSession());
        if (cancelled || epoch !== scopeEpochRef.current || (auth?.userId || null) !== scope.userId)
          return;

        const current = Date.now();
        const next: TickerItem[] = [];
        const failedKinds = new Set<TickerItem['kind']>();

        /* One read, so one failure. Every source keeps whatever it last
           confirmed until that announcement's own deadline retires it - which
           is what the old per-query `failedKinds` bookkeeping bought, for five
           queries that could fail independently. */
        if (feed === null) {
          for (const kind of [
            'starting_soon',
            'overlays',
            'registration_closing',
            'guarantees',
            'winner_results',
            'table_openings',
          ] as const) {
            failedKinds.add(kind);
          }
        }

        for (const row of feed?.upcoming ?? []) {
          const upcoming: UpcomingTournament = {
            id: String(row.id),
            name: String(row.name || 'Tournament'),
            startsAt: new Date(String(row.start_time)).getTime(),
            clubId: row.club_id ?? null,
            buyIn: Number(row.buy_in_amount) || 0,
            buyInFee: Number(row.buy_in_fee) || 0,
            registered: Number(row.current_players) || 0,
            isRegistered: row.is_registered === true,
            /* Resolved by the feed, which knows which club's rail this is and
               names an event only when it is somewhere else. Naming the room
               the player is standing in would be noise on every line. */
            foreignClubName: row.foreign_club_name ?? null,
          };
          if (!Number.isFinite(upcoming.startsAt)) continue;
          /* The server horizon is the LONGEST rung on the ladder so one read
             serves every stake; each event is then held to its own last call,
             so a 2-chip turbo is still a five-minute event. */
          if (!isInsideLastCall(upcoming.startsAt, upcoming.buyIn + upcoming.buyInFee, current))
            continue;
          next.push(startingSoonItem(upcoming));
        }

        for (const announcement of rankOverlayAnnouncements(
          (feed?.overlays ?? []) as OverlayCandidate[]
        )) {
          // An overlay has no fixed closing timestamp. Let a confirmed
          // snapshot survive one failed poll, never an indefinite outage.
          next.push({ ...overlayItem(announcement), expiresAt: current + 2 * POLL_MS });
        }

        /* Each of these arrives already filtered to rows that can speak. The
           arithmetic that the database cannot do without forking a second
           implementation of it - lateRegEndMs parses the blind structure and
           sums level durations - is still done here, on a handful of rows
           rather than eighty. */
        for (const row of feed?.reg_closing ?? []) {
          const closes = lateRegEndMs(row as unknown as LobbyTournamentRow);
          if (closes && closes > current && closes - current <= 5 * 60_000) {
            next.push(
              registrationClosingItem(String(row.id), String(row.name || 'Tournament'), closes)
            );
          }
        }

        for (const row of feed?.guarantees ?? []) {
          const starts = new Date(String(row.start_time || 0)).getTime();
          if (!Number.isFinite(starts) || starts <= current) continue;
          next.push(
            guaranteeItem(
              String(row.id),
              String(row.name || 'Tournament'),
              Number(row.guaranteed_prize) || 0,
              Number(row.current_players) || 0,
              starts
            )
          );
        }

        for (const row of feed?.results ?? []) {
          const ended = new Date(String(row.ended_at || 0)).getTime();
          if (!Number.isFinite(ended)) continue;
          next.push(
            winnerResultsItem(
              String(row.id),
              String(row.name || 'Tournament'),
              Number(row.prize_pool) || 0,
              ended
            )
          );
        }

        for (const row of feed?.table_openings ?? []) {
          const created = new Date(String(row.created_at || 0)).getTime();
          next.push(
            tableOpeningItem(
              String(row.id),
              String(row.name || 'Table'),
              String(row.game_variant || 'poker'),
              Number.isFinite(created) ? created : current
            )
          );
        }

        // A failed source keeps its last confirmed announcements only until
        // their existing deadlines. A successful empty result still clears it.
        setItems((previous) => [
          ...next,
          ...previous.filter((entry) => failedKinds.has(entry.kind)),
        ]);
      } catch (e) {
        reportError(e, 'TournamentStartingTicker.fetchFeed');
      } finally {
        inFlight = false;
        if (pending && !cancelled && !document.hidden) void fetchFeed();
      }
    };

    /* DB LOAD PASS 2026-08-24: the poll used to run forever, including in
       background tabs. Nobody can read a countdown they cannot see, so the
       interval is suspended while the tab is hidden and the data is refreshed
       the moment it comes back. */
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPoll = () => {
      if (poll !== null) return;
      poll = setInterval(fetchFeed, POLL_MS);
    };
    const stopPoll = () => {
      if (poll === null) return;
      clearInterval(poll);
      poll = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stopPoll();
      } else {
        void fetchFeed();
        startPoll();
      }
    };

    if (!document.hidden) {
      void fetchFeed();
      startPoll();
    }
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      stopPoll();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [
    loadScope,
    viewerRevision,
    silence.silent,
    sources.starting_soon,
    sources.overlays,
    sources.registration_closing,
    sources.guarantees,
    sources.table_openings,
    sources.winner_results,
  ]);

  /* The operator's own lines are settings, not rows, so they are composed
     rather than fetched. */
  const operatorItems = useMemo(() => {
    const out: TickerItem[] = [];
    if (sources.maintenance) {
      managedTicker.serviceMessages.forEach((message, index) => {
        out.push(operatorItem('maintenance', index, message));
      });
    }
    if (sources.custom_messages) {
      managedTicker.customMessages.forEach((message, index) => {
        out.push(operatorItem('custom_messages', index, message));
      });
    }
    return out;
  }, [
    managedTicker.serviceMessages,
    managedTicker.customMessages,
    sources.maintenance,
    sources.custom_messages,
  ]);

  const lane = useMemo(
    () =>
      tickerLaneFor(
        [...items, ...operatorItems].filter(
          (entry) => sources[entry.kind] && !dismissed.has(entry.id)
        ),
        now
      ),
    [items, operatorItems, dismissed, now, sources]
  );

  /* ── THE ONE-SECOND TICK ──────────────────────────────────────────────────
     Only runs while something with a clock is actually on the bar. */
  const hasClock = lane.some((entry) => typeof entry.deadlineMs === 'number');
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  /* ── THE CONTAINER NO LONGER KEEPS A CLOCK ────────────────────────────────
     `now` here does two jobs and neither of them is the countdown: it expires
     announcements whose window has closed, and it feeds the spoken line, which
     is rounded to the MINUTE precisely so a screen reader is not told the news
     sixty times a minute.
     The visible digits moved into TickerClock, which owns its own second, so
     this no longer has to run at 1Hz to keep four characters current - it was
     re-running the lane memo and rebuilding every field of every announcement
     on a thread that is also running a live poker table. Five seconds is ample
     for an expiry whose shortest window is thirty seconds of grace. */
  useEffect(() => {
    if (!hasClock && lane.length === 0) return undefined;
    const tick = setInterval(() => {
      setNow(Date.now());
    }, CONTAINER_TICK_MS);
    return () => clearInterval(tick);
  }, [hasClock, lane.length]);

  /* The two toasts a REGISTERED player gets, which are separate from the bar:
     the bar is for the room, these are for the person who already paid. */
  const upcomingForToasts = useMemo(
    () =>
      items.filter(
        (entry) =>
          sources.starting_soon &&
          entry.kind === 'starting_soon' &&
          typeof entry.deadlineMs === 'number'
      ),
    [items, sources.starting_soon]
  );
  /* AND THE SECOND 1Hz LOOP (2026-09-14). This one renders nothing, which is
     why it survived the first pass - it just walked every announcement once a
     second, for every registered player, to catch two thresholds.

     Five seconds is enough for both, because neither threshold is exact and
     both already know it: the five minute toast fires on the first reading at
     or under 300s and is suppressed below 120s, the ninety second toast fires
     at or under 90s and is suppressed below 10s. Those suppression guards were
     written for a tab that came back from the background having missed the
     moment entirely, and a four second late reading is well inside what they
     already tolerate. The player is told "starts in 5 minutes" at 4:56, which
     is what "5 minutes" meant anyway. */
  useEffect(() => {
    if (upcomingForToasts.length === 0) return undefined;
    const tick = setInterval(() => {
      const currentNow = Date.now();
      itemsRef.current.forEach((entry) => {
        if (entry.kind !== 'starting_soon' || typeof entry.deadlineMs !== 'number') return;
        if (!entry.registeredByViewer) return;
        const sLeft = Math.round((entry.deadlineMs - currentNow) / 1000);
        if (sLeft > 300 || sLeft < 0) return;
        const state = notifiedRef.current[entry.id] || { fiveMin: false, ninetySec: false };
        let changed = false;
        if (!state.fiveMin) {
          state.fiveMin = true;
          changed = true;
          if (sLeft > 120) {
            busToast(`MTT "${entry.subject}" starts in 5 minutes!`, 'clock', 8000);
          }
        }
        if (!state.ninetySec && sLeft <= 90) {
          state.ninetySec = true;
          changed = true;
          if (sLeft > 10) {
            busToast(`MTT "${entry.subject}" starts in 90 seconds!`, 'clock', 8000);
          }
        }
        if (changed) notifiedRef.current[entry.id] = state;
      });
    }, CONTAINER_TICK_MS);
    return () => clearInterval(tick);
  }, [upcomingForToasts.length]);

  /* A dismissal in another tab lands here too. Players multi-table on this
     platform, and closing an announcement on one felt used to leave it on
     every other one. */
  useEffect(() => onDismissedElsewhere(setDismissed), []);

  const dismiss = useCallback((entry: TickerItem) => {
    tickerTelemetry.dismissed(entry.kind);
    setDismissed(dismissItem(entry.id, entry.kind));
  }, []);

  const open = useCallback(
    (entry: TickerItem) => {
      /* Dan 2026-08-23: "if you click the ticker for the tournament running, it
         should take you directly to the tournament registration page."

         It went to a CLUB TOURNAMENT LIST - one step away from the event being
         announced - built from the tournament's club id. Worse, on a union game
         that id is the union's own hub club, so a player was shown the union
         list with "+ CREATE TOURNAMENT" on it. `/tournaments/:id` is
         TournamentDetails, which owns the Register button, and no club id is
         involved, so there is no union surface left to leak. */
      tickerTelemetry.opened(entry.kind);
      if (entry.tournamentId) navigate(`/tournaments/${entry.tournamentId}`);
      else if (entry.tableId) navigate(`/table/${entry.tableId}`);
      else navigate('/tournaments');
    },
    [navigate]
  );

  /* ── IS THE BAR ACTUALLY ON SCREEN? ───────────────────────────────────────
     One boolean, computed above every early return, because two things need
     the same answer: the render, and the effect that publishes this strip's
     height for the table tab bar to start under. */
  const barVisible = lane.length > 0 && onTickerRoute && managedTicker.enabled && !silence.silent;

  /* The strip retracts rather than vanishing. `leaving` keeps it mounted for
     one animation, and nothing can be clicked while it plays. */
  const [leaving, setLeaving] = useState(false);
  const wasVisible = useRef(false);
  useEffect(() => {
    if (barVisible) {
      wasVisible.current = true;
      setLeaving(false);
      return undefined;
    }
    if (!wasVisible.current) return undefined;
    wasVisible.current = false;
    setLeaving(true);
    const t = setTimeout(() => setLeaving(false), LEAVE_MS);
    return () => clearTimeout(t);
  }, [barVisible]);

  const mounted = barVisible || leaving;

  /* ── PUBLISH THE HEIGHT SO THE ACTION TAB CAN START BELOW IT ──────────────
     Dan 2026-08-30: "THE TICKER MUST ALWAYS BE AT THE VERY TOP OF THE PAGE,
     DIRECTLY UNDER THE GLOBAL HEADER, THE 'ACTION TAB' SHOULD NEVER BE ABOVE
     IT."

     This strip is `position: fixed`, so nothing below it moves on its own. It
     measures itself and writes the number to the document element;
     MultiTablePage.css and TableTabBar.css read `--mtt-ticker-h` and start
     there. The property is REMOVED, not set to 0, when no bar is up.

     `--sp-tabbar-inset` is the notch. Whichever strip actually touches y = 0
     pays `env(safe-area-inset-top)`, and only that one: when this bar is
     topmost (no global header, i.e. /table/*) it has paid, so the tab bar's
     own inset is zeroed. Paying it twice is the ~47px band that was fixed on
     notched iPhones once already, in this same relationship. */
  useEffect(() => {
    const root = document.documentElement;
    const clear = () => {
      root.style.removeProperty('--mtt-ticker-h');
      root.style.removeProperty('--sp-tabbar-inset');
    };

    if (!barVisible) {
      clear();
      return clear;
    }

    const publish = () => {
      const h = tickerRef.current?.offsetHeight ?? 0;
      root.style.setProperty('--mtt-ticker-h', `${h}px`);
      if (headerBottom > 0) root.style.removeProperty('--sp-tabbar-inset');
      else root.style.setProperty('--sp-tabbar-inset', '0px');
    };
    publish();

    /* The strip's height is not a constant: the flag wraps at narrow widths and
       the notch inset changes on rotation. Observe it rather than trusting the
       first frame. */
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && tickerRef.current) {
      ro = new ResizeObserver(publish);
      ro.observe(tickerRef.current);
    }
    window.addEventListener('resize', publish);

    return () => {
      window.removeEventListener('resize', publish);
      ro?.disconnect();
      clear();
    };
  }, [barVisible, headerBottom]);

  /* ── AN IMPRESSION IS THE ITEM THAT OWNED THE BAR ────────────────────────
     Counted once per tab, from an EFFECT rather than the render body: the
     strip repaints every second while a clock is running, and a side effect in
     a render is double-invoked under StrictMode. The seen-set inside
     tickerTelemetry makes it idempotent either way, but "idempotent so it does
     not matter where it lives" is how a render body collects side effects.

     Keyed on the id, so a lane that keeps the same top announcement across a
     poll counts once and a handover counts the new one. */
  const speakingId = barVisible && lane.length > 0 ? lane[0].id : null;
  const speakingKind = barVisible && lane.length > 0 ? lane[0].kind : null;
  useEffect(() => {
    if (!speakingId || !speakingKind) return;
    tickerTelemetry.shown(speakingKind, speakingId);
    /* Same effect, same key, deliberately: both of these care about exactly
       one thing - a NEW announcement is now the one being made. The chime is
       far stricter about what it does with that than telemetry is; see
       tickerChime.ts, which stays silent for everything except an overlay
       guarantee arriving after the tab has already shown something else. */
    announceToChime(speakingKind, speakingId);
  }, [speakingId, speakingKind]);

  if (!mounted || lane.length === 0) return null;

  return (
    <TickerRail
      items={lane}
      now={now}
      top={headerBottom}
      leaving={leaving && !barVisible}
      appearance={{
        backgroundColor: managedTicker.backgroundColor,
        textColor: managedTicker.textColor,
        accentColor: managedTicker.accentColor,
        fontFamily: managedTicker.fontFamily,
        speedSeconds: managedTicker.speedSeconds,
      }}
      onOpen={open}
      onDismiss={dismiss}
      containerRef={(node) => {
        tickerRef.current = node;
      }}
    />
  );
}

export default TournamentStartingTicker;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE GATE - the only part of this that runs on every route
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two cheap questions, both answered from memory: is this a route the bar can
 * appear on, and has the player switched it off? Neither touches the network.
 *
 * Everything else - the membership scope, the feed poll, the managed settings,
 * the responsible-gaming read, the maintenance-break state, the one-second tick
 * and the chrome measurement - lives in the host above and is not mounted until
 * both answers are yes.
 *
 * Dan 2026-08-28: "add a toggle in the table settings, and in the Club Arena
 * settings, to turn the ticker on or off." useTableSettings is the shared store
 * both surfaces write (localStorage + SETTINGS_CHANGED bus), so flipping the
 * toggle anywhere unmounts or remounts the whole host live, with no reload -
 * and it stops the polling now, which it never used to.
 */
export function TournamentStartingTicker() {
  const location = useLocation();
  const { settings: tickerSettings } = useTableSettings();

  /* The live ticker belongs on active tables and inside a club's live lobby.
     The club route matters: its desktop reference reserves this exact strip
     below the global header, and suppressing it there left no ticker band at
     all. Other Club Arena pages remain quiet. */
  const atLiveTable = location.pathname.startsWith('/table');
  const atClubLobby = /^\/clubs\/[^/]+(?:\/lobby)?\/?$/.test(location.pathname);
  if (!(atLiveTable || atClubLobby)) return null;
  if (tickerSettings.showTicker === false) return null;

  return <TickerHost />;
}

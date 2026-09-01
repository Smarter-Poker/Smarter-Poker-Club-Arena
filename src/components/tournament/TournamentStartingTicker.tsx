/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT STARTING TICKER — the 5-minute call (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "When a scheduled MTT is about to start... 5 minutes left. there should
 * be a scrolling announcement across all active club/union cash games and
 * tournaments."
 *
 * A scheduled MTT with nobody registered is a dead tournament, and the players
 * who would fill it are already sitting at cash tables in the same club, seeing
 * nothing. This is the last call, and it has to reach them WHERE THEY ARE —
 * which is why it mounts at the app root, outside <Routes>, next to the other
 * global hosts. It rides over the cash table, the club lobby, the tournament
 * list and everything else, because "across all active club/union cash games
 * and tournaments" means all of them.
 *
 * SCOPE
 *   Tournaments in a club the player is a member of, or in a union one of
 *   those clubs belongs to. A player is never told about an event they cannot
 *   enter.
 *
 * TIMING
 *   Polls every 30s for events with a start time inside the next 5 minutes and
 *   a pre-start status (ANNOUNCED / REGISTERING), then counts down locally
 *   every second, so the number on screen is honest between polls without
 *   asking the database sixty times a minute.
 *
 * DISMISSAL
 *   Per tournament, in sessionStorage. Closing the ticker for "Sunday Slam"
 *   does not silence the next event, and it does not follow you into tomorrow.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { formatGameTitle } from '../../utils/formatGameTitle';
import { formatPopupText } from '../../utils/popupStyle';
import { reportError } from '../../utils/errorReporter';
import { busToast } from '../../core/MasterBus';
import { measureTopChromeBottom, TOP_CHROME_SELECTORS } from './topChrome';
import { useTableSettings } from '../../hooks/useTableSettings';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import {
  DEFAULT_TICKER_SETTINGS,
  tickerManagementService,
} from '../../services/TickerManagementService';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import {
  rankOverlayAnnouncements,
  overlayMessage,
  type OverlayAnnouncement,
  type OverlayCandidate,
} from '../../utils/overlayAnnouncements';
import { lateRegEndMs, type LobbyTournamentRow } from '../lobby/lobbyEntries';
import './TournamentStartingTicker.css';

/** How far ahead an event counts as "about to start". */
const LEAD_MS = 5 * 60 * 1000;
/** How often we ask the database. The countdown itself ticks locally. */
const POLL_MS = 30_000;
const DISMISS_KEY = 'ca_mtt_ticker_dismissed';
/* Overlay announcements are dismissed SEPARATELY from starting-soon ones.
   They are a different claim about a different event and a player who closed
   "starts in 2:14" has not said anything about "8,400 overlay". */
const OVERLAY_DISMISS_KEY = 'ca_overlay_ticker_dismissed';

interface UpcomingTournament {
  id: string;
  name: string;
  startsAt: number;
  clubId: string | null;
  buyIn: number;
  registered: number;
  isRegistered: boolean;
}

interface OperationalTickerMessage {
  id: string;
  source: 'registration_closing' | 'guarantees' | 'table_openings' | 'winner_results';
  message: string;
  tournamentId?: string;
  tableId?: string;
}

function readDismissed(): Set<string> {
  try {
    return new Set<string>(JSON.parse(sessionStorage.getItem(DISMISS_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function writeDismissed(ids: Set<string>): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...ids]));
  } catch {
    /* a full or disabled sessionStorage must not break the announcement */
  }
}

/** "4:07" / "0:12". Never negative — at zero the event is starting. */
function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function TournamentStartingTicker() {
  const navigate = useNavigate();
  const location = useLocation();
  /* Dan 2026-08-28: "add a toggle in the table settings, and in the Club
     Arena settings, to turn the ticker on or off." useTableSettings is the
     shared store both settings surfaces write (localStorage +
     SETTINGS_CHANGED bus), so flipping the toggle anywhere kills or revives
     this bar live, no reload. Hook called unconditionally, above every
     early return — hook order must stay stable (same rule as atLiveTable
     below). */
  const { settings: tickerSettings } = useTableSettings();
  const [managedTicker, setManagedTicker] = useState(DEFAULT_TICKER_SETTINGS);
  const [tickerScopeRevision, setTickerScopeRevision] = useState(0);
  const [customDismissed, setCustomDismissed] = useState(false);
  const [serviceDismissed, setServiceDismissed] = useState(false);
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

  useEffect(() => {
    if (!onTickerRoute) return;
    let cancelled = false;
    void (async () => {
      try {
        let clubUuid: string | null = null;
        let unionUuid: string | null = null;
        const clubMatch = location.pathname.match(/^\/clubs\/([^/]+)/);
        const tableMatch = location.pathname.match(/^\/table\/([^/]+)/);
        if (clubMatch) {
          clubUuid = await resolveClubUUID(clubMatch[1]);
          const { data, error } = await supabase
            .from('clubs')
            .select('union_id')
            .eq('id', clubUuid)
            .maybeSingle();
          if (error) throw error;
          unionUuid = data?.union_id || null;
        } else if (tableMatch) {
          const { data, error } = await supabase
            .from('tables')
            .select('club_id,union_id')
            .eq('id', tableMatch[1])
            .maybeSingle();
          if (error) throw error;
          clubUuid = data?.club_id || null;
          unionUuid = data?.union_id || null;
        }
        const next = await tickerManagementService.get(unionUuid ? null : clubUuid, unionUuid);
        if (!cancelled) setManagedTicker(next);
      } catch (error) {
        reportError(error, 'TournamentStartingTicker.loadManagedSettings');
        if (!cancelled) setManagedTicker(DEFAULT_TICKER_SETTINGS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname, onTickerRoute, tickerScopeRevision]);
  const [upcoming, setUpcoming] = useState<UpcomingTournament[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const [overlays, setOverlays] = useState<OverlayAnnouncement[]>([]);
  const [operationalMessages, setOperationalMessages] = useState<OperationalTickerMessage[]>([]);
  const [overlayDismissed, setOverlayDismissed] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(sessionStorage.getItem(OVERLAY_DISMISS_KEY) || '[]'));
    } catch {
      return new Set();
    }
  });
  const clubIdsRef = useRef<string[] | null>(null);

  /* Dan 2026-08-21: "it should play UNDER the global header, not through it."

     The header is position: sticky, top 0, z-index 100, and lives inside the
     page; this bar is an app-root sibling, so it cannot simply flow after it.
     Measuring beats hard-coding 56px: three stylesheets declare a
     --header-height (44px in one, 56px in two), the real header grows when its
     content wraps, and a wrong constant shows either a gap or the overlap we
     are here to remove. Read the rendered header's bottom edge, start there.

     2026-08-23 — MEASURING ONLY THE HEADER BROKE THE "+" ON EVERY TOURNAMENT
     TABLE. Inside /table/* there is no #global-header: <TablePage> is fixed to
     the whole viewport and its top chrome is the multi-table tab bar. So the
     lookup found nothing, headerBottom fell to 0, and this strip — fixed, 34px
     tall, z-index 9400 — landed exactly on top of a tab bar whose own stacking
     tops out at z-index 200. The "+" that opens a second table sits 24-30px
     down, squarely inside that band, so every tap on it hit the ticker's
     marquee button instead and opened the tournament lobby. Measured on
     production: elementFromPoint at the button's centre returned
     .mtt-ticker__track, and Playwright refused the click with
     "<button class=mtt-ticker__track> ... intercepts pointer events".

     The rule was never "sit under the header", it is "sit under whatever top
     chrome this route actually has". So measure every candidate and start
     below the lowest one. A hidden or absent element contributes nothing, so
     the home page still gets top: 0.

     2026-08-30 — AND THEN IT WENT BACK. Dan, with a screenshot of the lobby:
     "THE TICKER MUST ALWAYS BE AT THE VERY TOP OF THE PAGE, DIRECTLY UNDER THE
     GLOBAL HEADER, THE 'ACTION TAB' SHOULD NEVER BE ABOVE IT." Measuring the
     tab bar protected the "+" by moving the TICKER; it moves the BAR now.
     `.table-tab-bar` is out of TOP_CHROME_SELECTORS and this strip publishes
     `--mtt-ticker-h` instead, which the bar starts below. The "+" is safer for
     it: the two never occupy the same pixels on any route now, rather than
     depending on a measurement catching a bar that mounts late. */
  const [headerBottom, setHeaderBottom] = useState(0);
  const tickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const measure = () => {
      setHeaderBottom(measureTopChromeBottom((sel) => document.querySelector(sel)));
    };
    measure();
    window.addEventListener('resize', measure);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
    }

    /* Observe every candidate, not just the first one found. The tab bar is
       not a fixture: it appears when the multi-table layer mounts, grows a row
       when you add a table, and collapses off /table/*. Observing only the
       element that happened to exist first is how the ticker ends up measured
       against chrome that is no longer the lowest thing on screen.

       observe() is idempotent per element, so re-attaching on each tick is
       free and picks up nodes that mount late (the ticker itself only appears
       when an MTT comes inside the five-minute window, which is usually long
       after the route did). */
    let attempts = 0;
    const attach = () => {
      measure();
      if (!ro) return;
      for (const sel of TOP_CHROME_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) ro.observe(el);
      }
    };
    attach();
    const poll = setInterval(() => {
      attach();
      if (++attempts > 20) clearInterval(poll); // 2s of settling, then observers carry it
    }, 100);

    return () => {
      window.removeEventListener('resize', measure);
      clearInterval(poll);
      ro?.disconnect();
    };
  }, [location.pathname]);

  // ── Which clubs (and unions) does this player belong to? ──
  const loadScope = useCallback(async (): Promise<string[]> => {
    if (clubIdsRef.current) return clubIdsRef.current;
    try {
      const auth = await import('../../lib/authUtils').then((m) => m.readLocalSession());
      const uid = auth?.userId;
      if (!uid) return [];
      const { data } = await supabase
        .from('club_members')
        .select('club_id')
        .eq('user_id', uid)
        .in('status', ['active', 'approved']);
      const ids = (data || []).map((r: { club_id: string }) => r.club_id).filter(Boolean);
      clubIdsRef.current = ids;
      return ids;
    } catch (e) {
      reportError(e, 'TournamentStartingTicker.loadScope');
      return [];
    }
  }, []);

  // ── Poll for events inside the window ──
  useEffect(() => {
    let cancelled = false;

    const fetchUpcoming = async () => {
      const clubIds = await loadScope();
      if (cancelled || clubIds.length === 0) return;
      try {
        const nowIso = new Date().toISOString();
        const horizonIso = new Date(Date.now() + LEAD_MS).toISOString();

        /* DB LOAD PASS 2026-08-24: the player's own registrations used to be
           fetched AFTER the upcoming-events query, filtered by the ids it
           returned — three round trips in strict series on every poll tick.
           There is no real dependency between them: the upcoming events are
           scoped by CLUB and the registrations are scoped by USER, so both can
           be in flight at once and intersected here. A player's REGISTERED row
           count is small and `user_id` is indexed, so dropping the id filter
           costs nothing. `loadScope()` caches after the first tick, so the
           steady state is now one round trip instead of three. */
        const registrationsPromise = (async () => {
          const auth = await import('../../lib/authUtils').then((m) => m.readLocalSession());
          if (!auth?.userId) return new Set<string>();
          const { data: regData } = await supabase
            .from('tournament_players')
            .select('tournament_id')
            .eq('user_id', auth.userId)
            // DEAD PREDICATE, FIXED 2026-08-25. This asked for 'REGISTERED' in
            // capitals. The column is written by TournamentService in LOWER
            // case ('registered' on entry, flipped to 'playing' at start), so
            // the filter matched zero rows and the ticker's "you are
            // registered" badge could never render for anybody.
            //
            // Verified against production before changing it, not guessed:
            //   eliminated 80,928 | winner 15,238 | playing 1,314 |
            //   registered 20
            // The earlier note here read that same distribution as "there is no
            // REGISTERED" and concluded the badge needed a product decision.
            // There is one, it is lower case, and the pending rows are simply
            // rare because the engine promotes them to 'playing' at start.
            //
            // Both live values are kept: this list is only ever intersected
            // with pre-start MTTs (status ANNOUNCED or REGISTERING below), so
            // 'playing' cannot leak a running event into the bar, and keeping
            // it means a re-entry row mid-flip still reads as entered.
            .in('status', ['registered', 'playing'])
            // ORDER BY is required, not cosmetic: a bare LIMIT in Postgres
            // returns ARBITRARY rows, so if the predicate above is ever
            // corrected and a player exceeds 200 matches, the 200 kept would be
            // random and the badge would be wrong. Newest registrations first.
            .order('registered_at', { ascending: false })
            .limit(200);
          return new Set((regData || []).map((r: { tournament_id: string }) => r.tournament_id));
        })();

        const upcomingPromise = supabase
          .from('tournaments')
          .select(
            'id, name, start_time, club_id, buy_in_amount, current_players, status, tournament_type'
          )
          .in('club_id', clubIds)
          /* Dan 2026-08-21: "WE DON'T ANNOUNCE SPINS OR HEADS UP,
             ONLY MTT EVENTS." Spins and heads-up games fire the moment their seats fill, so a
             five-minute warning is meaningless for them and they would drown
             the bar: the platform holds 7,306 spins and 2,809 heads-up games against
             1,040 MTTs. A scheduled MTT is the only event a player needs to
             be walked to the door for. */
          .eq('tournament_type', 'MTT')
          // Pre-start states only. A RUNNING event is not "about to start", and
          // late registration has its own surfaces.
          .in('status', ['ANNOUNCED', 'REGISTERING'])
          .gte('start_time', nowIso)
          .lte('start_time', horizonIso)
          .order('start_time', { ascending: true })
          .limit(5);

        /* ── OVERLAY ANNOUNCEMENTS (Dan 2026-08-26) ────────────────────────
           "alerting players if there is an overlay or potential overlay to
           jump in and play."

           A SEPARATE query, not a widening of the one above, because the two
           announcements answer different questions on different clocks. The
           starting-soon strip looks five MINUTES ahead at events that have not
           started; an overlay speaks only about an event that is already
           running with late registration still open - a state the query above
           excludes on purpose. Widening it would have dragged running events
           into the "starts in 0:00" copy.

           Scoped to the same clubs and the same MTT-only rule: a player is
           never told about money they cannot go and win. */
        /* Dan 2026-08-26: overlays are announced ONLY for events currently
           running — a future event's shortfall is a field that has not
           arrived, not an overlay. ANNOUNCED/REGISTERING are gone from the
           status list, and the row now carries blind_structure +
           level_started_at so overlayFor can place the 75%-of-late-reg
           gate exactly (it fails closed without them). */
        const overlayPromise = supabase
          .from('tournaments')
          .select(
            'id, name, status, start_time, guaranteed_prize, prize_pool, current_players, buy_in_amount, late_reg_levels, late_reg_mins, started_at, current_level, max_players, blind_structure, level_started_at'
          )
          .in('club_id', clubIds)
          .eq('tournament_type', 'MTT')
          .gt('guaranteed_prize', 0)
          .in('status', ['RUNNING', 'IN_PROGRESS', 'LATE_REG', 'LATE_REGISTRATION'])
          .order('guaranteed_prize', { ascending: false })
          .limit(25);

        const operationsPromise = Promise.all([
          supabase
            .from('tournaments')
            .select(
              'id,name,status,start_time,started_at,ended_at,updated_at,guaranteed_prize,prize_pool,current_players,late_reg_levels,late_reg_mins,current_level,blind_structure,level_started_at,max_players'
            )
            .in('club_id', clubIds)
            .in('status', [
              'ANNOUNCED',
              'REGISTERING',
              'RUNNING',
              'LATE_REG',
              'LATE_REGISTRATION',
              'COMPLETED',
            ])
            .order('updated_at', { ascending: false })
            .limit(80),
          supabase
            .from('tables')
            .select('id,name,status,game_variant,created_at')
            .in('club_id', clubIds)
            .is('tournament_id', null)
            .eq('is_deleted', false)
            .in('status', ['waiting', 'running'])
            .gte('created_at', new Date(Date.now() - 10 * 60_000).toISOString())
            .order('created_at', { ascending: false })
            .limit(10),
        ]);

        const [{ data, error }, myRegs, overlayRes, [opsTournamentRes, opsTableRes]] =
          await Promise.all([
            upcomingPromise,
            registrationsPromise,
            overlayPromise,
            operationsPromise,
          ]);

        if (!cancelled) {
          const current = Date.now();
          const messages: OperationalTickerMessage[] = [];
          for (const row of opsTournamentRes.data || []) {
            const status = String(row.status || '').toUpperCase();
            const starts = new Date(row.start_time || 0).getTime();
            if (
              managedTicker.sources.registration_closing &&
              ['RUNNING', 'LATE_REG', 'LATE_REGISTRATION'].includes(status)
            ) {
              const closes = lateRegEndMs(row as unknown as LobbyTournamentRow);
              if (closes && closes > current && closes - current <= 5 * 60_000) {
                messages.push({
                  id: `reg-${row.id}`,
                  source: 'registration_closing',
                  tournamentId: row.id,
                  message: `${row.name} Registration Closes In ${countdown(closes - current)}`,
                });
              }
            }
            if (
              managedTicker.sources.guarantees &&
              ['ANNOUNCED', 'REGISTERING'].includes(status) &&
              Number(row.guaranteed_prize || 0) > 0 &&
              starts > current &&
              starts - current <= 2 * 60 * 60_000
            ) {
              messages.push({
                id: `gtd-${row.id}`,
                source: 'guarantees',
                tournamentId: row.id,
                message: `${Number(row.guaranteed_prize).toLocaleString()} Guaranteed · ${row.name} · ${Number(row.current_players || 0).toLocaleString()} Entered`,
              });
            }
            const ended = new Date(row.ended_at || 0).getTime();
            if (
              managedTicker.sources.winner_results &&
              status === 'COMPLETED' &&
              ended > current - 10 * 60_000
            ) {
              messages.push({
                id: `result-${row.id}`,
                source: 'winner_results',
                tournamentId: row.id,
                message: `${row.name} Is Complete · ${Number(row.prize_pool || 0).toLocaleString()} Prize Pool · Results Available`,
              });
            }
          }
          if (managedTicker.sources.table_openings) {
            for (const row of opsTableRes.data || [])
              messages.push({
                id: `table-${row.id}`,
                source: 'table_openings',
                tableId: row.id,
                message: `New ${String(row.game_variant || 'Poker').toUpperCase()} Table Open · ${row.name} · Seats Available`,
              });
          }
          setOperationalMessages(messages.slice(0, 8));
        }

        if (!cancelled) {
          if (overlayRes.error) {
            // Same rule as the query above: report it rather than let a
            // permanently broken query look like a quiet schedule.
            reportError(overlayRes.error, 'TournamentStartingTicker.fetchOverlays');
          } else {
            setOverlays(rankOverlayAnnouncements((overlayRes.data ?? []) as OverlayCandidate[]));
          }
        }

        if (error) {
          // Reported, not swallowed. The bar correctly renders NOTHING on a
          // failed poll (it never claims "no tournaments"), but a silent
          // return also meant a permanently broken query looked identical to a
          // quiet schedule.
          reportError(error, 'TournamentStartingTicker.fetchUpcoming');
          return;
        }
        if (cancelled || !data) return;

        setUpcoming(
          data.map((t: Record<string, unknown>) => ({
            id: String(t.id),
            name: String(t.name || 'Tournament'),
            startsAt: new Date(String(t.start_time)).getTime(),
            clubId: (t.club_id as string) || null,
            buyIn: Number(t.buy_in_amount) || 0,
            registered: Number(t.current_players) || 0,
            isRegistered: myRegs.has(String(t.id)),
          }))
        );
      } catch (e) {
        reportError(e, 'TournamentStartingTicker.fetchUpcoming');
      }
    };

    /* DB LOAD PASS 2026-08-24: the poll used to run forever, including in
       background tabs. Nobody can read a countdown they cannot see, so the
       interval is suspended while the tab is hidden and the data is refreshed
       the moment it comes back — which also means a returning player sees a
       current countdown rather than one that drifted while they were away. */
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPoll = () => {
      if (poll !== null) return;
      poll = setInterval(fetchUpcoming, POLL_MS);
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
        void fetchUpcoming();
        startPoll();
      }
    };

    if (!document.hidden) {
      void fetchUpcoming();
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
    managedTicker.sources.guarantees,
    managedTicker.sources.registration_closing,
    managedTicker.sources.table_openings,
    managedTicker.sources.winner_results,
  ]);

  // ── Local 1s countdown. Only runs while something is actually showing. ──
  const live = useMemo(
    () =>
      (managedTicker.sources.starting_soon ? upcoming : []).filter(
        (t) => !dismissed.has(t.id) && t.startsAt - now <= LEAD_MS && t.startsAt - now > -30_000
      ),
    [upcoming, dismissed, now, managedTicker.sources.starting_soon]
  );

  const liveOverlays = useMemo(
    () =>
      (managedTicker.sources.overlays ? overlays : []).filter((o) => !overlayDismissed.has(o.id)),
    [overlays, overlayDismissed, managedTicker.sources.overlays]
  );
  const customMessages =
    managedTicker.sources.custom_messages && !customDismissed ? managedTicker.customMessages : [];
  const serviceMessages =
    managedTicker.sources.maintenance && !serviceDismissed ? managedTicker.serviceMessages : [];
  useEffect(() => {
    setCustomDismissed(false);
  }, [managedTicker.customMessages]);
  useEffect(() => {
    setServiceDismissed(false);
  }, [managedTicker.serviceMessages]);

  const notifiedRef = useRef<Record<string, { fiveMin: boolean; ninetySec: boolean }>>({});
  const upcomingRef = useRef(upcoming);
  useEffect(() => {
    upcomingRef.current = upcoming;
  }, [upcoming]);

  useEffect(() => {
    if (upcoming.length === 0) return undefined;
    const tick = setInterval(() => {
      const currentNow = Date.now();
      setNow(currentNow);

      upcomingRef.current.forEach((t) => {
        const msLeft = t.startsAt - currentNow;
        const sLeft = Math.round(msLeft / 1000);

        if (sLeft <= 300 && sLeft >= 0) {
          const state = notifiedRef.current[t.id] || { fiveMin: false, ninetySec: false };
          let changed = false;

          // 5-minute mark (300 seconds)
          if (!state.fiveMin && sLeft <= 300) {
            state.fiveMin = true;
            changed = true;
            // If the event starts in more than 2 minutes, give them the 5 minute warning
            if (sLeft > 120 && t.isRegistered) {
              busToast(`MTT "${t.name}" starts in 5 minutes!`, 'clock', 8000);
            }
          }

          // 90-second mark
          if (!state.ninetySec && sLeft <= 90) {
            state.ninetySec = true;
            changed = true;
            // If it starts in more than 10 seconds, give the 90s warning
            if (sLeft > 10 && t.isRegistered) {
              busToast(`MTT "${t.name}" starts in 90 seconds!`, 'clock', 8000);
            }
          }

          if (changed) {
            notifiedRef.current[t.id] = state;
          }
        }
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [upcoming.length]);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      writeDismissed(next);
      return next;
    });
  }, []);

  /* Dismissed separately from starting-soon. Closing "starts in 2:14" says
     nothing about whether you want to hear that an event is 8,400 light. */
  const dismissOverlay = useCallback((id: string) => {
    setOverlayDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        sessionStorage.setItem(OVERLAY_DISMISS_KEY, JSON.stringify([...next]));
      } catch {
        /* a full or disabled sessionStorage must not break the announcement */
      }
      return next;
    });
  }, []);

  /* ── IS THE BAR ACTUALLY ON SCREEN? ────────────────────────────────────────
     One boolean, computed above every early return, because two things now
     need the same answer: the render below, and the effect that publishes this
     strip's height for the table tab bar to start under. Three separate
     `return null`s used to answer it, which is fine for a render and useless
     to a hook — a hook cannot live after a conditional return.

       - nothing to announce;
       - not live at a table: /table/* only (Dan 2026-08-30: the ticker
         "should ever only appear while live at a table, not anywhere
         else");
       - the player turned the ticker off in table or Club Arena settings
         (Dan 2026-08-28, one shared store). */
  const barVisible =
    (live.length > 0 ||
      liveOverlays.length > 0 ||
      operationalMessages.length > 0 ||
      serviceMessages.length > 0 ||
      customMessages.length > 0) &&
    onTickerRoute &&
    tickerSettings.showTicker !== false &&
    managedTicker.enabled;

  /* ── PUBLISH THE HEIGHT SO THE ACTION TAB CAN START BELOW IT ───────────────
     Dan 2026-08-30: "THE TICKER MUST ALWAYS BE AT THE VERY TOP OF THE PAGE,
     DIRECTLY UNDER THE GLOBAL HEADER, THE 'ACTION TAB' SHOULD NEVER BE ABOVE
     IT."

     This strip is `position: fixed`, so nothing below it moves on its own. It
     measures itself and writes the number to the document element;
     MultiTablePage.css and TableTabBar.css read `--mtt-ticker-h` and start
     there. The property is REMOVED, not set to 0, when no bar is up — so the
     `var(--mtt-ticker-h, 0px)` fallback in those files is what applies on a
     quiet schedule and nothing moves for a ticker that is not there.

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

    /* The strip's height is not a constant: the flag wraps at narrow widths
       and the notch inset changes on rotation. Observe it rather than trusting
       the first frame. */
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

  if (!barVisible) return null;

  /* ONE BAR, AND THE OVERLAY WINS IT.
     Dan 2026-08-26 asked for overlay announcements "to jump in and play", and
     an overlay is a strictly stronger reason to act than a countdown: the
     countdown says an event is about to start, the overlay says there is money
     on the table that nobody has paid for. Stacking a second strip over the
     felt was already rejected for starting-soon (see below), and the reasoning
     has not changed - so when both have something to say, the overlay takes
     the bar and the countdown waits for the next poll. */
  const showingOverlay = liveOverlays.length > 0;
  const showingOperational = !showingOverlay && live.length === 0 && operationalMessages.length > 0;
  const showingService =
    !showingOverlay && live.length === 0 && !showingOperational && serviceMessages.length > 0;
  const showingCustom =
    !showingOverlay &&
    !showingOperational &&
    !showingService &&
    live.length === 0 &&
    customMessages.length > 0;

  // One bar. If two events land in the same window the marquee carries both
  // rather than stacking bars over the felt.
  const primary = showingOverlay ? null : live[0];
  const primaryOverlay = showingOverlay ? liveOverlays[0] : null;
  const primaryOperational = showingOperational ? operationalMessages[0] : null;

  /* Whichever source owns the bar, the click target, the title and the close
     button all have to point at THAT event. Resolving them once here keeps the
     JSX below from having to branch in five places - and keeps the union rule
     intact: `/tournaments/:id`, never a club id. */
  const targetId = primaryOverlay
    ? primaryOverlay.id
    : primary?.id || primaryOperational?.tournamentId;
  const targetName = primaryOverlay
    ? primaryOverlay.name
    : primary?.name || primaryOperational?.message || serviceMessages[0] || 'Club Update';

  // Dan 2026-08-21: house popup rule applies here too - First Letter Of
  // Every Word Capitalized, hyphenated words included ("Buy-In 22").
  const message = showingOverlay
    ? liveOverlays.map((o) => formatPopupText(overlayMessage(o))).join('        •        ')
    : showingOperational
      ? operationalMessages.map((item) => formatPopupText(item.message)).join('        •        ')
      : showingCustom
        ? customMessages.map(formatPopupText).join('        •        ')
        : showingService
          ? serviceMessages.map(formatPopupText).join('        •        ')
          : live
              .map((t) =>
                formatPopupText(
                  `${formatGameTitle(t.name)} starts in ${countdown(t.startsAt - now)}` +
                    (t.buyIn > 0 ? ` · buy-in ${t.buyIn.toLocaleString()}` : ' · freeroll') +
                    // "entered", not "registered": this is tournaments.current_players,
                    // a registration COUNTER that is incremented on entry and never
                    // decremented, so it is an entry total and not a live head count.
                    ` · ${t.registered.toLocaleString()} entered`
                )
              )
              .join('        •        ');

  return (
    <div
      ref={tickerRef}
      className="mtt-ticker"
      role="status"
      aria-live="polite"
      /* Dan 2026-08-23: "the ticker is way too thick on mobile." The strip
         pays `padding-top: env(safe-area-inset-top)` so it clears the notch
         when it is the topmost element — but when it sits BELOW the header
         (headerBottom > 0) the header has already paid that inset, and paying
         it twice turned a 34px strip into a ~90px band on notched iPhones.
         Only the strip that actually touches top: 0 owes the inset. */
      style={
        {
          top: headerBottom,
          paddingTop: headerBottom > 0 ? 0 : undefined,
          background: managedTicker.backgroundColor,
          color: managedTicker.textColor,
          borderBottomColor: managedTicker.accentColor,
          fontFamily:
            managedTicker.fontFamily === 'System' ? 'system-ui' : managedTicker.fontFamily,
          '--ticker-speed': `${managedTicker.speedSeconds}s`,
          '--ticker-text': managedTicker.textColor,
          '--ticker-accent': managedTicker.accentColor,
        } as CSSProperties
      }
    >
      <span
        className={
          primaryOverlay
            ? `mtt-ticker__flag mtt-ticker__flag--overlay${
                primaryOverlay.tier === 'live' ? ' mtt-ticker__flag--overlay-live' : ''
              }`
            : 'mtt-ticker__flag'
        }
        style={{ color: managedTicker.accentColor }}
      >
        {primaryOverlay
          ? primaryOverlay.tier === 'live'
            ? 'OVERLAY'
            : 'POTENTIAL OVERLAY'
          : showingCustom
            ? 'CLUB UPDATE'
            : showingService
              ? 'SERVICE NOTICE'
              : showingOperational
                ? primaryOperational?.source === 'registration_closing'
                  ? 'REG CLOSING'
                  : primaryOperational?.source === 'guarantees'
                    ? 'GUARANTEED'
                    : primaryOperational?.source === 'table_openings'
                      ? 'TABLE OPEN'
                      : 'RESULTS'
                : 'STARTING SOON'}
      </span>

      {/* Dan 2026-08-23: "if you click the ticker for the tournament running,
          it should take you directly to the tournament registration page...
          idk what this page even is that it took me to when clicked."

          It went to a CLUB TOURNAMENT LIST — one step away from the event being
          announced — built from the tournament's club id. Worse, on a union game
          that id is the union's own hub club: the screenshot was the MIDWAY
          UNION list with "+ CREATE TOURNAMENT" on it, shown to a player.

          The ticker names ONE event and `primary.id` IS that event, so it now
          opens that event. `/tournaments/:tournamentId` is TournamentDetails —
          the registration page, which owns the Register button through
          useTournamentRegistration. No club id is involved, so there is no
          union surface left to leak. The '/tournaments' fallback is the GLOBAL
          lobby, never club- or union-scoped. */}
      <button
        className="mtt-ticker__track"
        onClick={() => {
          if (targetId) navigate(`/tournaments/${targetId}`);
          else if (primaryOperational?.tableId) navigate(`/table/${primaryOperational.tableId}`);
          else if (!showingCustom && !showingService) navigate('/tournaments');
        }}
        title={`Register For ${formatGameTitle(targetName)}`}
      >
        {/* Duplicated so the marquee wraps seamlessly rather than snapping
            back to an empty bar. aria-hidden on the copy keeps a screen reader
            from reading the same announcement twice. */}
        <span className="mtt-ticker__scroll">
          <span className="mtt-ticker__msg">{message}</span>
          <span className="mtt-ticker__msg" aria-hidden="true">
            {message}
          </span>
        </span>
      </button>

      <button
        className="mtt-ticker__close"
        onClick={() => {
          if (primaryOverlay) dismissOverlay(primaryOverlay.id);
          else if (primary) dismiss(primary.id);
          else if (primaryOperational)
            setOperationalMessages((items) =>
              items.filter((item) => item.id !== primaryOperational.id)
            );
          else if (showingService) setServiceDismissed(true);
          else if (showingCustom) setCustomDismissed(true);
        }}
        aria-label={`Dismiss The Announcement For ${targetName}`}
      >
        ×
      </button>
    </div>
  );
}

export default TournamentStartingTicker;

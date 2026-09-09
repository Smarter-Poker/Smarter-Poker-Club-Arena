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
import { reportError } from '../../utils/errorReporter';
import { busToast } from '../../core/MasterBus';
import { useTableSettings } from '../../hooks/useTableSettings';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import {
  DEFAULT_TICKER_SETTINGS,
  tickerManagementService,
  type ManagedTickerSettings,
} from '../../services/TickerManagementService';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { rankOverlayAnnouncements, type OverlayCandidate } from '../../utils/overlayAnnouncements';
/* The value comes from the small extracted module and the row shape is a
   type-only import, so this root-mounted ticker does not pull the whole
   lobby view-model into the entry bundle every player downloads. */
import { lateRegEndMs } from '../lobby/lateRegWindow';
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
import { dismissItem, readDismissed } from './tickerDismissals';
import { useTopChromeOffset } from './useTopChromeOffset';
import { TickerRail } from './TickerRail';

/** How far ahead an event counts as "about to start". */
const LEAD_MS = 5 * 60 * 1000;
/** How often we ask the database. The countdown itself ticks locally. */
const POLL_MS = 30_000;
/** How long a cached club-membership list is trusted. */
const SCOPE_TTL_MS = 5 * 60_000;
/** How long the exit animation runs before the strip is unmounted. */
const LEAVE_MS = 240;

interface Scope {
  clubIds: string[];
  fetchedAt: number;
  userId: string | null;
}

export function TournamentStartingTicker() {
  const navigate = useNavigate();
  const location = useLocation();
  /* Dan 2026-08-28: "add a toggle in the table settings, and in the Club
     Arena settings, to turn the ticker on or off." useTableSettings is the
     shared store both settings surfaces write (localStorage +
     SETTINGS_CHANGED bus), so flipping the toggle anywhere kills or revives
     this bar live, no reload. Hook called unconditionally, above every
     early return - hook order must stay stable. */
  const { settings: tickerSettings } = useTableSettings();
  const [managedTicker, setManagedTicker] =
    useState<ManagedTickerSettings>(DEFAULT_TICKER_SETTINGS);
  const [tickerScopeRevision, setTickerScopeRevision] = useState(0);

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

    const loadManaged = async () => {
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
        /* NOT a reset to defaults. `tickerManagementService.get` already holds
           the last authoritative answer and hands it back on a failed read, so
           a club that switched the rail OFF stays off through a transient
           error instead of being switched back on with a different set of
           sources. See TickerManagementService. */
      }
    };

    void loadManaged();
    const poll = setInterval(() => {
      if (!document.hidden) void loadManaged();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [location.pathname, onTickerRoute, tickerScopeRevision]);

  const [items, setItems] = useState<TickerItem[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed());
  const scopeRef = useRef<Scope | null>(null);

  const headerBottom = useTopChromeOffset(location.pathname);
  const tickerRef = useRef<HTMLDivElement | null>(null);

  /* ── WHOSE CLUBS, AND FOR HOW LONG ────────────────────────────────────────
     This was a bare ref populated once and never invalidated: join a club and
     its events stayed silent until a hard reload, and switching accounts left
     the rail scoped to the previous user's clubs. It carries the user it was
     built for and a five-minute floor now, and the two bus events that can
     make it wrong clear it immediately. */
  const invalidateScope = useCallback(() => {
    scopeRef.current = null;
  }, []);
  useMasterBusSubscription('AUTH_STATE_CHANGED', invalidateScope);
  useMasterBusSubscription('CLUB_JOINED', invalidateScope);

  const loadScope = useCallback(async (): Promise<string[]> => {
    const auth = await import('../../lib/authUtils').then((m) => m.readLocalSession());
    const uid = auth?.userId || null;
    const cached = scopeRef.current;
    if (cached && cached.userId === uid && Date.now() - cached.fetchedAt < SCOPE_TTL_MS) {
      return cached.clubIds;
    }
    if (!uid) {
      scopeRef.current = { clubIds: [], fetchedAt: Date.now(), userId: null };
      return [];
    }
    try {
      const { data } = await supabase
        .from('club_members')
        .select('club_id')
        .eq('user_id', uid)
        .in('status', ['active', 'approved']);
      const ids = (data || []).map((r: { club_id: string }) => r.club_id).filter(Boolean);
      scopeRef.current = { clubIds: ids, fetchedAt: Date.now(), userId: uid };
      return ids;
    } catch (e) {
      reportError(e, 'TournamentStartingTicker.loadScope');
      return cached?.clubIds || [];
    }
  }, []);

  const sources = managedTicker.sources;

  // ── Poll for everything the enabled sources need ──
  useEffect(() => {
    let cancelled = false;

    const fetchFeed = async () => {
      const clubIds = await loadScope();
      if (cancelled || clubIds.length === 0) return;
      try {
        const nowIso = new Date().toISOString();
        const horizonIso = new Date(Date.now() + LEAD_MS).toISOString();

        /* DB LOAD PASS 2026-08-24: the player's own registrations used to be
           fetched AFTER the upcoming-events query, filtered by the ids it
           returned - three round trips in strict series on every poll tick.
           There is no real dependency between them, so both are in flight at
           once and intersected here. */
        const registrationsPromise = sources.starting_soon
          ? (async () => {
              const auth = await import('../../lib/authUtils').then((m) => m.readLocalSession());
              if (!auth?.userId) return new Set<string>();
              const { data: regData } = await supabase
                .from('tournament_players')
                .select('tournament_id')
                // The column is written by TournamentService in LOWER case
                // ('registered' on entry, flipped to 'playing' at start). Both
                // live values are kept: this list is only ever intersected with
                // pre-start MTTs, so 'playing' cannot leak a running event onto
                // the bar, and keeping it means a re-entry row mid-flip still
                // reads as entered.
                .eq('user_id', auth.userId)
                .in('status', ['registered', 'playing'])
                // ORDER BY is required, not cosmetic: a bare LIMIT in Postgres
                // returns ARBITRARY rows.
                .order('registered_at', { ascending: false })
                .limit(200);
              return new Set(
                (regData || []).map((r: { tournament_id: string }) => r.tournament_id)
              );
            })()
          : Promise.resolve(new Set<string>());

        const upcomingPromise = sources.starting_soon
          ? supabase
              .from('tournaments')
              .select(
                'id, name, start_time, club_id, buy_in_amount, buy_in_fee, current_players, status, tournament_type'
              )
              .in('club_id', clubIds)
              /* Dan 2026-08-21: "WE DON'T ANNOUNCE SPINS OR HEADS UP, ONLY MTT
                 EVENTS." Spins and heads-up games fire the moment their seats
                 fill, so a five-minute warning is meaningless for them and they
                 would drown the bar: the platform holds 7,306 spins and 2,809
                 heads-up games against 1,040 MTTs. */
              .eq('tournament_type', 'MTT')
              // Pre-start states only. A RUNNING event is not "about to start".
              .in('status', ['ANNOUNCED', 'REGISTERING'])
              .gte('start_time', nowIso)
              .lte('start_time', horizonIso)
              .order('start_time', { ascending: true })
              .limit(5)
          : Promise.resolve({ data: [], error: null } as const);

        /* ── OVERLAY ANNOUNCEMENTS (Dan 2026-08-26) ──────────────────────────
           A SEPARATE query, not a widening of the one above, because the two
           announcements answer different questions on different clocks. The
           starting-soon strip looks five MINUTES ahead at events that have not
           started; an overlay speaks only about an event that is already
           running with late registration still open. */
        const overlayPromise = sources.overlays
          ? supabase
              .from('tournaments')
              .select(
                'id, name, status, start_time, guaranteed_prize, prize_pool, current_players, buy_in_amount, late_reg_levels, late_reg_mins, started_at, current_level, max_players'
              )
              .in('club_id', clubIds)
              .eq('tournament_type', 'MTT')
              .gt('guaranteed_prize', 0)
              .in('status', ['RUNNING', 'IN_PROGRESS', 'LATE_REG', 'LATE_REGISTRATION'])
              .order('guaranteed_prize', { ascending: false })
              .limit(25)
          : Promise.resolve({ data: [], error: null } as const);

        /* ── THE OPERATIONAL SOURCES, EACH BEHIND ITS OWN SWITCH ─────────────
           These two queries used to fire on every tick for every seated player
           whatever the club had configured - a wide 80-row read of
           `tournaments` and a 10-row read of `tables` - even though three of
           the four sources they feed are OFF by default. A club that wants
           none of them now pays for none of them. */
        const wantsTournamentOps =
          sources.registration_closing || sources.guarantees || sources.winner_results;
        const opsTournamentPromise = wantsTournamentOps
          ? supabase
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
              .limit(80)
          : Promise.resolve({ data: [], error: null } as const);

        const opsTablePromise = sources.table_openings
          ? supabase
              .from('tables')
              .select('id,name,status,game_variant,created_at')
              .in('club_id', clubIds)
              .is('tournament_id', null)
              .eq('is_deleted', false)
              .in('status', ['waiting', 'running'])
              .gte('created_at', new Date(Date.now() - 10 * 60_000).toISOString())
              .order('created_at', { ascending: false })
              .limit(10)
          : Promise.resolve({ data: [], error: null } as const);

        const [upcomingRes, myRegs, overlayRes, opsTournamentRes, opsTableRes] = await Promise.all([
          upcomingPromise,
          registrationsPromise,
          overlayPromise,
          opsTournamentPromise,
          opsTablePromise,
        ]);

        if (cancelled) return;

        const current = Date.now();
        const next: TickerItem[] = [];

        if (upcomingRes.error) {
          // Reported, not swallowed. The bar correctly renders NOTHING on a
          // failed poll (it never claims "no tournaments"), but a silent return
          // also meant a permanently broken query looked identical to a quiet
          // schedule.
          reportError(upcomingRes.error, 'TournamentStartingTicker.fetchUpcoming');
        } else {
          for (const t of (upcomingRes.data || []) as Record<string, unknown>[]) {
            const upcoming: UpcomingTournament = {
              id: String(t.id),
              name: String(t.name || 'Tournament'),
              startsAt: new Date(String(t.start_time)).getTime(),
              clubId: (t.club_id as string) || null,
              buyIn: Number(t.buy_in_amount) || 0,
              buyInFee: Number(t.buy_in_fee) || 0,
              registered: Number(t.current_players) || 0,
              isRegistered: myRegs.has(String(t.id)),
            };
            if (!Number.isFinite(upcoming.startsAt)) continue;
            next.push(startingSoonItem(upcoming));
          }
        }

        if (overlayRes.error) {
          reportError(overlayRes.error, 'TournamentStartingTicker.fetchOverlays');
        } else {
          for (const announcement of rankOverlayAnnouncements(
            (overlayRes.data ?? []) as OverlayCandidate[]
          )) {
            next.push(overlayItem(announcement));
          }
        }

        for (const row of (opsTournamentRes.data || []) as Record<string, unknown>[]) {
          const status = String(row.status || '').toUpperCase();
          const starts = new Date(String(row.start_time || 0)).getTime();
          const id = String(row.id);
          const name = String(row.name || 'Tournament');
          if (
            sources.registration_closing &&
            ['RUNNING', 'LATE_REG', 'LATE_REGISTRATION'].includes(status)
          ) {
            const closes = lateRegEndMs(row as unknown as LobbyTournamentRow);
            if (closes && closes > current && closes - current <= 5 * 60_000) {
              next.push(registrationClosingItem(id, name, closes));
            }
          }
          if (
            sources.guarantees &&
            ['ANNOUNCED', 'REGISTERING'].includes(status) &&
            Number(row.guaranteed_prize || 0) > 0 &&
            Number.isFinite(starts) &&
            starts > current &&
            starts - current <= 2 * 60 * 60_000
          ) {
            next.push(
              guaranteeItem(
                id,
                name,
                Number(row.guaranteed_prize) || 0,
                Number(row.current_players) || 0,
                starts
              )
            );
          }
          const ended = new Date(String(row.ended_at || 0)).getTime();
          if (
            sources.winner_results &&
            status === 'COMPLETED' &&
            Number.isFinite(ended) &&
            ended > current - 10 * 60_000
          ) {
            next.push(winnerResultsItem(id, name, Number(row.prize_pool) || 0, ended));
          }
        }

        for (const row of (opsTableRes.data || []) as Record<string, unknown>[]) {
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

        setItems(next);
      } catch (e) {
        reportError(e, 'TournamentStartingTicker.fetchFeed');
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
        [...items, ...operatorItems].filter((entry) => !dismissed.has(entry.id)),
        now
      ),
    [items, operatorItems, dismissed, now]
  );

  /* ── THE ONE-SECOND TICK ──────────────────────────────────────────────────
     Only runs while something with a clock is actually on the bar. */
  const hasClock = lane.some((entry) => typeof entry.deadlineMs === 'number');
  const notifiedRef = useRef<Record<string, { fiveMin: boolean; ninetySec: boolean }>>({});
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!hasClock && lane.length === 0) return undefined;
    const tick = setInterval(() => {
      const currentNow = Date.now();
      setNow(currentNow);
    }, 1000);
    return () => clearInterval(tick);
  }, [hasClock, lane.length]);

  /* The two toasts a REGISTERED player gets, which are separate from the bar:
     the bar is for the room, these are for the person who already paid. */
  const upcomingForToasts = useMemo(
    () =>
      items.filter(
        (entry) => entry.kind === 'starting_soon' && typeof entry.deadlineMs === 'number'
      ),
    [items]
  );
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
    }, 1000);
    return () => clearInterval(tick);
  }, [upcomingForToasts.length]);

  const dismiss = useCallback((entry: TickerItem) => {
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
  const barVisible =
    lane.length > 0 &&
    onTickerRoute &&
    tickerSettings.showTicker !== false &&
    managedTicker.enabled;

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

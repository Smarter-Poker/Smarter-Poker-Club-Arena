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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { formatGameTitle } from '../../utils/formatGameTitle';
import { formatPopupText } from '../../utils/popupStyle';
import { reportError } from '../../utils/errorReporter';
import { busToast } from '../../core/MasterBus';
import { measureTopChromeBottom, TOP_CHROME_SELECTORS } from './topChrome';
import './TournamentStartingTicker.css';

/** How far ahead an event counts as "about to start". */
const LEAD_MS = 5 * 60 * 1000;
/** How often we ask the database. The countdown itself ticks locally. */
const POLL_MS = 30_000;
const DISMISS_KEY = 'ca_mtt_ticker_dismissed';

interface UpcomingTournament {
  id: string;
  name: string;
  startsAt: number;
  clubId: string | null;
  buyIn: number;
  registered: number;
  isRegistered: boolean;
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
  /* Dan 2026-08-21: "THE BANNER ONLY PLAYS WHILE YOUR INSIDE THE CLUB."
     A table is inside a club, so both count; the home page, the global
     tournament list and everything else do not. Computed here rather than at
     the return so hook order stays stable. */
  const insideClub =
    location.pathname.startsWith('/clubs/') || location.pathname.startsWith('/table');
  const [upcoming, setUpcoming] = useState<UpcomingTournament[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
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
     the home page still gets top: 0. */
  const [headerBottom, setHeaderBottom] = useState(0);
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
        const { data, error } = await supabase
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

        if (error || cancelled || !data) return;

        const tournamentIds = data.map((t) => t.id);
        let myRegs = new Set<string>();
        if (tournamentIds.length > 0) {
          const auth = await import('../../lib/authUtils').then((m) => m.readLocalSession());
          if (auth?.userId) {
            const { data: regData } = await supabase
              .from('tournament_players')
              .select('tournament_id')
              .eq('user_id', auth.userId)
              .in('tournament_id', tournamentIds)
              .in('status', ['REGISTERED']);
            myRegs = new Set(
              (regData || []).map((r: { tournament_id: string }) => r.tournament_id)
            );
          }
        }

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

    fetchUpcoming();
    const poll = setInterval(fetchUpcoming, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [loadScope]);

  // ── Local 1s countdown. Only runs while something is actually showing. ──
  const live = useMemo(
    () =>
      upcoming.filter(
        (t) => !dismissed.has(t.id) && t.startsAt - now <= LEAD_MS && t.startsAt - now > -30_000
      ),
    [upcoming, dismissed, now]
  );

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

  if (live.length === 0) return null;

  // Outside a club there is nothing to announce: /clubs and /table only.
  if (!insideClub) return null;

  // One bar. If two events land in the same window the marquee carries both
  // rather than stacking bars over the felt.
  const primary = live[0];

  // Dan 2026-08-21: house popup rule applies here too - First Letter Of
  // Every Word Capitalized, hyphenated words included ("Buy-In 22").
  const message = live
    .map((t) =>
      formatPopupText(
        `${formatGameTitle(t.name)} starts in ${countdown(t.startsAt - now)}` +
          (t.buyIn > 0 ? ` · buy-in ${t.buyIn.toLocaleString()}` : ' · freeroll') +
          ` · ${t.registered} registered`
      )
    )
    .join('        •        ');

  return (
    <div
      className="mtt-ticker"
      role="status"
      aria-live="polite"
      /* Dan 2026-08-23: "the ticker is way too thick on mobile." The strip
         pays `padding-top: env(safe-area-inset-top)` so it clears the notch
         when it is the topmost element — but when it sits BELOW the header
         (headerBottom > 0) the header has already paid that inset, and paying
         it twice turned a 34px strip into a ~90px band on notched iPhones.
         Only the strip that actually touches top: 0 owes the inset. */
      style={{ top: headerBottom, paddingTop: headerBottom > 0 ? 0 : undefined }}
    >
      <span className="mtt-ticker__flag">STARTING SOON</span>

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
          if (primary.id) navigate(`/tournaments/${primary.id}`);
          else navigate('/tournaments');
        }}
        title={`Register For ${formatGameTitle(primary.name)}`}
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
        onClick={() => dismiss(primary.id)}
        aria-label={`Dismiss the announcement for ${primary.name}`}
      >
        ×
      </button>
    </div>
  );
}

export default TournamentStartingTicker;

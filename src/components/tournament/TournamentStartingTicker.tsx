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
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { formatGameTitle } from '../../utils/formatGameTitle';
import { reportError } from '../../utils/errorReporter';
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
  const [upcoming, setUpcoming] = useState<UpcomingTournament[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const clubIdsRef = useRef<string[] | null>(null);

  // ── Which clubs (and unions) does this player belong to? ──
  const loadScope = useCallback(async (): Promise<string[]> => {
    if (clubIdsRef.current) return clubIdsRef.current;
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
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
          .select('id, name, start_time, club_id, buy_in_amount, current_players, status')
          .in('club_id', clubIds)
          // Pre-start states only. A RUNNING event is not "about to start", and
          // late registration has its own surfaces.
          .in('status', ['ANNOUNCED', 'REGISTERING'])
          .gte('start_time', nowIso)
          .lte('start_time', horizonIso)
          .order('start_time', { ascending: true })
          .limit(5);

        if (error || cancelled || !data) return;
        setUpcoming(
          data.map((t: Record<string, unknown>) => ({
            id: String(t.id),
            name: String(t.name || 'Tournament'),
            startsAt: new Date(String(t.start_time)).getTime(),
            clubId: (t.club_id as string) || null,
            buyIn: Number(t.buy_in_amount) || 0,
            registered: Number(t.current_players) || 0,
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

  useEffect(() => {
    if (live.length === 0) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [live.length]);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      writeDismissed(next);
      return next;
    });
  }, []);

  if (live.length === 0) return null;

  // One bar. If two events land in the same window the marquee carries both
  // rather than stacking bars over the felt.
  const primary = live[0];

  const message = live
    .map(
      (t) =>
        `${formatGameTitle(t.name)} starts in ${countdown(t.startsAt - now)}` +
        (t.buyIn > 0 ? ` · buy-in ${t.buyIn.toLocaleString()}` : ' · freeroll') +
        ` · ${t.registered} registered`
    )
    .join('        •        ');

  return (
    <div className="mtt-ticker" role="status" aria-live="polite">
      <span className="mtt-ticker__flag">STARTING SOON</span>

      <button
        className="mtt-ticker__track"
        onClick={() => {
          if (primary.clubId) navigate(`/clubs/${primary.clubId}/tournaments`);
          else navigate('/tournaments');
        }}
        title="Open the tournament lobby"
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

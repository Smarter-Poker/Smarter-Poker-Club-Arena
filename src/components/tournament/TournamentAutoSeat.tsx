import { warmTable } from '../../services/tableWarmup';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT AUTO-SEAT — Dan 2026-08-21, BINDING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "WHEN A PLAYER IS REGISTERED FOR AN MTT, WHEN THE TOURNAMENT STARTS IT MUST
 *  AUTO OPEN A NEW TABLE AND SEAT THE PLAYER DIRECTLY. THIS NEEDS TO BE A 100%
 *  AUTOMATED PROCESS. IF THE USER ALREADY HAS 4 GAMES RUNNING, IT MUST SEND A
 *  LARGE POP UP..."
 *
 * The engine already creates the tournament tables and writes the seats
 * (TournamentManager). What was missing was the last hop: nothing on the
 * player's screen noticed. A registered player sat in the lobby while their
 * tournament dealt without them until they happened to look.
 *
 * This watcher closes that hop. It polls the player's OWN tournament seats
 * (cheap: one indexed query on table_seats every 12s, only while signed
 * in AND only while the tab is visible),
 * and the first time a seat appears at a table it has not already announced:
 *   • emits TABLE_SEATED, which MultiTablePage turns into an open table tab;
 *   • if the player is already at the 4-table cap, MultiTablePage answers with
 *     TABLE_CAP_BLOCKED and this renders the large popup Dan asked for.
 *
 * Deliberately poll-based rather than realtime: seats are written by the
 * engine's service-role connection, and a missed socket frame here means a
 * player misses a tournament they paid for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { reportError } from '../../utils/errorReporter';
import './TournamentAutoSeat.css';

/**
 * DB LOAD PASS 2026-08-24: was 12s. This component is mounted app-wide for
 * every signed-in user, so that was five joined `table_seats` -> `tables`
 * queries per minute per open tab, forever, whether or not the player has ever
 * registered for a tournament. 45s is still well inside the window that
 * matters — a tournament seat waits minutes, not seconds — and the interval is
 * now torn down entirely while the tab is hidden rather than ticking and
 * returning early.
 */
// 12s, NOT LONGER. Reverted from 45s on 2026-08-24: that change was made as a
// database-load optimisation without weighing it against the binding guarantee
// in this file's header. This poll is the ONLY detection path for auto-seating,
// and the blinding-off alarm rides it too, so stretching it directly stretches
// how long a player sits unseated in a tournament they paid for, and how late
// they are told their chips are leaving. The visibility gate below is where the
// load saving comes from instead: hidden tabs poll not at all, and check
// immediately on return.
const POLL_MS = 12_000;
/** Seats older than this were not "just started" — do not yank the player. */
const FRESH_MS = 10 * 60 * 1000;
const SEEN_KEY = 'ca_tourney_autoseat_seen';
/**
 * Dan 2026-08-21 (item 4): tables we have already warned the player they are
 * being blinded off at. Separate from SEEN_KEY — that one is "we opened this
 * table for you once", this one is "we told you your chips are draining".
 * Re-armed as soon as the seat stops being away, so a player who sits back
 * down and leaves again is warned again.
 */
const BLIND_WARNED_KEY = 'ca_tourney_blindoff_warned';

function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]') as string[]);
  } catch {
    return new Set();
  }
}
function writeSeen(s: Set<string>) {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-40)));
  } catch {
    /* storage full or unavailable — the in-memory copy still guards this tab */
  }
}

function readWarned(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(BLIND_WARNED_KEY) || '[]') as string[]);
  } catch {
    return new Set();
  }
}
function writeWarned(s: Set<string>) {
  try {
    sessionStorage.setItem(BLIND_WARNED_KEY, JSON.stringify([...s].slice(-40)));
  } catch {
    /* see writeSeen */
  }
}

/**
 * Dan 2026-08-23: "make the top line two lines. 'Prime Time Main Event (NLH)'
 * line one. 'Table 4' line two."
 *
 * The server hands this popup ONE string - "Prime Time Main Event (NLH) - Table
 * 4" - and at 1.35rem in a 460px panel it wrapped wherever it ran out of room,
 * which put the break after "Table" and left a lone "4" on the second line.
 *
 * Split on the LAST " - " so an event name carrying its own dash ("Sunday Deep
 * - Turbo") keeps it and only the table suffix moves down. No suffix - a cash
 * table, or a rename - falls through to a single line rather than inventing one.
 */
function renderTwoLineTitle(raw: string): ReactNode {
  const name = (raw || '').trim();
  const cut = name.lastIndexOf(' - ');
  if (cut <= 0) return name;
  const event = name.slice(0, cut).trim();
  const table = name.slice(cut + 3).trim();
  if (!event || !table) return name;
  return (
    <>
      <span className="tas-title__event">{event}</span>
      <span className="tas-title__table">{table}</span>
    </>
  );
}

export default function TournamentAutoSeat() {
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const seenRef = useRef<Set<string>>(readSeen());
  const warnedRef = useRef<Set<string>>(readWarned());
  const [blocked, setBlocked] = useState<{ tableId: string; name: string } | null>(null);
  /** Dan 2026-08-21, item 4: the "you are being blinded off" alert. */
  const [blindingOff, setBlindingOff] = useState<{
    tableId: string;
    name: string;
    chips: number;
  } | null>(null);
  const pendingRef = useRef<Map<string, string>>(new Map()); // tableId -> tournament name

  // MultiTablePage answers with this when the player is already at the cap.
  useMasterBusSubscription('TABLE_CAP_BLOCKED', (payload: { tableId?: string }) => {
    const tableId = payload?.tableId;
    if (!tableId) return;
    const name = pendingRef.current.get(tableId);
    if (!name) return; // not one of ours — a cash seat hit the cap, not a tournament
    setBlocked({ tableId, name });
  });

  const check = useCallback(async () => {
    if (!user?.id || document.visibilityState !== 'visible') return;
    try {
      /**
       * One query serves both jobs. The auto-seat half only cares about FRESH
       * seats (a tournament that just started); the blinding-off half
       * (Dan 2026-08-21, item 4) cares about seats of ANY age — a player is
       * usually an hour into a tournament by the time they get blinded off —
       * so the `joined_at` floor moved out of the query and into the auto-seat
       * branch that actually needs it.
       */
      const { data, error } = await supabase
        .from('table_seats')
        .select(
          'table_id, joined_at, stack, is_sitting_out, is_away, tables:table_id (id, name, tournament_id, status)'
        )
        .eq('user_id', user.id)
        .is('left_at', null)
        .limit(12);
      if (error) throw error;

      const freshFloor = Date.now() - FRESH_MS;

      for (const row of data || []) {
        const t = (Array.isArray(row.tables) ? row.tables[0] : row.tables) as {
          id?: string;
          name?: string;
          tournament_id?: string | null;
          status?: string;
        } | null;
        if (!t?.tournament_id) continue; // cash seat — not our business
        const tableId = (row.table_id as string) || t.id || '';
        if (!tableId) continue;
        if (t.status && ['closed', 'completed', 'cancelled', 'finished'].includes(t.status))
          continue;

        const name = t.name || 'Your Tournament';

        /**
         * ── BLINDING OFF (item 4) ────────────────────────────────────────
         * The engine flags a seat `is_sitting_out` after consecutive timeouts
         * and `is_away` on a disconnect, and it keeps taking that player's
         * blinds and antes either way. That flag on a TOURNAMENT seat is the
         * server's own statement that this player is paying to not be there,
         * which is exactly the condition Dan described — no client-side
         * guessing about stack deltas required.
         *
         * Warn once per table, and re-arm the moment they are back in, so a
         * player who sits down and wanders off again is told again.
         */
        const away = Boolean(row.is_sitting_out) || Boolean(row.is_away);
        if (away) {
          if (!warnedRef.current.has(tableId)) {
            warnedRef.current.add(tableId);
            writeWarned(warnedRef.current);
            const chips = Number(row.stack) || 0;
            setBlindingOff({ tableId, name, chips });
            // The phone half is NOT sent from here any more (#1498,
            // 2026-08-30). It used to call pushNotificationService, whose
            // transport OneSignal's retirement killed on 2026-08-19, so it had
            // delivered nothing for eleven days.
            //
            // The engine's own flag is the trigger now: trg_notify_blinding_off
            // fires on table_seats when is_sitting_out or is_away goes true on
            // a live TOURNAMENT seat, raises the notification server-side, and
            // the mirror sends the push. That reaches the player whether or not
            // this component is mounted -- which is the whole point, because
            // somebody being blinded off is by definition not looking at the
            // app. This banner is only the half for when they are.
          }
        } else if (warnedRef.current.has(tableId)) {
          warnedRef.current.delete(tableId);
          writeWarned(warnedRef.current);
          setBlindingOff((prev) => (prev?.tableId === tableId ? null : prev));
        }

        // ── AUTO-SEAT (batch 10) — fresh seats only ──────────────────────
        if (seenRef.current.has(tableId)) continue;
        const joinedAt = row.joined_at ? new Date(row.joined_at as string).getTime() : 0;
        if (!joinedAt || joinedAt < freshFloor) continue;

        seenRef.current.add(tableId);
        writeSeen(seenRef.current);
        pendingRef.current.set(tableId, name);

        // Hand it to the multi-table layer: it opens a tab when there is room
        // and replies TABLE_CAP_BLOCKED when there is not.
        warmTable(tableId);
        masterBus.emit('TABLE_SEATED', { tableId, seat: 0 });
      }
    } catch (e) {
      reportError(e, 'TournamentAutoSeat.check');
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return undefined;

    /* The interval is created only while the tab is visible and destroyed when
       it is hidden. Previously it ran forever and `check()` returned early on a
       hidden tab, which spared the query but still woke the tab on a timer.
       Becoming visible again checks immediately, so nothing is missed. */
    let id: ReturnType<typeof setInterval> | null = null;
    const startPoll = () => {
      if (id !== null) return;
      id = setInterval(() => void check(), POLL_MS);
    };
    const stopPoll = () => {
      if (id === null) return;
      clearInterval(id);
      id = null;
    };

    const onVis = () => {
      if (document.hidden) {
        stopPoll();
      } else {
        void check();
        startPoll();
      }
    };

    if (!document.hidden) {
      void check();
      startPoll();
    }
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopPoll();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [user?.id, check]);

  /**
   * Blinding off takes precedence over the cap popup: one is "your tournament
   * started", the other is "your chips are leaving right now."
   */
  if (blindingOff) {
    return (
      <div className="tas-overlay" role="dialog" aria-label="You Are Being Blinded Off">
        <div className="tas-panel tas-panel--urgent">
          <div className="tas-flag tas-flag--urgent">You Are Being Blinded Off</div>
          <div className="tas-title">{renderTwoLineTitle(blindingOff.name)}</div>
          <p className="tas-body">
            Your Seat Is Posting Blinds Without You
            {blindingOff.chips > 0
              ? ` And You Have ${Math.round(blindingOff.chips).toLocaleString()} Chips Left`
              : ''}
            . Take Your Seat Now To Stop Losing Chips.
          </p>
          <div className="tas-actions">
            <button className="tas-later" onClick={() => setBlindingOff(null)}>
              Dismiss
            </button>
            <button
              className="tas-go"
              onClick={() => {
                const id = blindingOff.tableId;
                setBlindingOff(null);
                // Open it as a table tab as well as navigating, so the
                // multi-table layer knows about it — same hop the auto-seat
                // path uses.
                warmTable(id);
                masterBus.emit('TABLE_SEATED', { tableId: id, seat: 0 });
                navigate(`/table/${id}`);
              }}
            >
              Take My Seat
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!blocked) return null;

  return (
    <div className="tas-overlay" role="dialog" aria-label="Tournament Started">
      <div className="tas-panel">
        <div className="tas-flag">TOURNAMENT STARTED</div>
        <div className="tas-title">{renderTwoLineTitle(blocked.name)}</div>
        <p className="tas-body">
          Has Just Started And Your Seat Is Waiting. Your Cash Tables Are Full - Please Leave A Cash
          Game Or Close A Table To Sit Down.
        </p>
        <div className="tas-actions">
          <button className="tas-later" onClick={() => setBlocked(null)}>
            Not Now
          </button>
          <button
            className="tas-go"
            onClick={() => {
              const id = blocked.tableId;
              setBlocked(null);
              navigate(`/table/${id}`);
            }}
          >
            Take My Seat
          </button>
        </div>
      </div>
    </div>
  );
}

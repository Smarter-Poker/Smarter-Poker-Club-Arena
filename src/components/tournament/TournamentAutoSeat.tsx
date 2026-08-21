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
 * (cheap: one indexed query on table_seats every 12s, only while signed in),
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
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { reportError } from '../../utils/errorReporter';
import './TournamentAutoSeat.css';

const POLL_MS = 12_000;
/** Seats older than this were not "just started" — do not yank the player. */
const FRESH_MS = 10 * 60 * 1000;
const SEEN_KEY = 'ca_tourney_autoseat_seen';

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

export default function TournamentAutoSeat() {
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const seenRef = useRef<Set<string>>(readSeen());
  const [blocked, setBlocked] = useState<{ tableId: string; name: string } | null>(null);
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
      const since = new Date(Date.now() - FRESH_MS).toISOString();
      const { data, error } = await supabase
        .from('table_seats')
        .select('table_id, joined_at, tables:table_id (id, name, tournament_id, status)')
        .eq('user_id', user.id)
        .is('left_at', null)
        .gte('joined_at', since)
        .limit(10);
      if (error) throw error;

      for (const row of data || []) {
        const t = (Array.isArray(row.tables) ? row.tables[0] : row.tables) as {
          id?: string;
          name?: string;
          tournament_id?: string | null;
          status?: string;
        } | null;
        if (!t?.tournament_id) continue; // cash seat — not our business
        const tableId = (row.table_id as string) || t.id || '';
        if (!tableId || seenRef.current.has(tableId)) continue;
        if (t.status && ['closed', 'completed', 'cancelled', 'finished'].includes(t.status))
          continue;

        seenRef.current.add(tableId);
        writeSeen(seenRef.current);
        const name = t.name || 'Your Tournament';
        pendingRef.current.set(tableId, name);

        // Hand it to the multi-table layer: it opens a tab when there is room
        // and replies TABLE_CAP_BLOCKED when there is not.
        masterBus.emit('TABLE_SEATED', { tableId, seat: 0 });
      }
    } catch (e) {
      reportError(e, 'TournamentAutoSeat.check');
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return undefined;
    void check();
    const id = setInterval(() => void check(), POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [user?.id, check]);

  if (!blocked) return null;

  return (
    <div className="tas-overlay" role="dialog" aria-label="Tournament started">
      <div className="tas-panel">
        <div className="tas-flag">TOURNAMENT STARTED</div>
        <div className="tas-title">{blocked.name}</div>
        <p className="tas-body">
          Has Just Started And Your Seat Is Waiting. You Are Already Playing 4 Tables — Please
          Leave A Cash Game Or Close A Table To Sit Down.
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

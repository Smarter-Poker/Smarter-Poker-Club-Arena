/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BREAK HAS TO SURVIVE THE THING IT IS COVERING
 *  Dan, 2026-09-01
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The engine announces a five-minute maintenance break, then dies in the
 * middle of it. That is the point of it. So this state cannot be driven by the
 * socket: for roughly two of those five minutes there IS no socket, every
 * table answers 4404 while engines rehydrate, and the one moment a player most
 * needs to be told "this is a break, your seat is fine, play resumes at the
 * top of the hour" is the moment nothing can tell them.
 *
 * Three sources, in order of authority, and the whole design is that any ONE
 * of them is enough:
 *
 *   1. THE ENGINE EVENT, while a socket exists. Carries an absolute end time.
 *   2. THE LOCAL CLOCK, once seeded. `breakEndsAtMs` is an instant, not a
 *      duration, so the countdown keeps running correctly across the outage
 *      with nothing to ask. This is what makes the restart invisible.
 *   3. THE DATABASE, for a browser that loaded DURING the outage and so never
 *      saw the announcement. Without it that player gets a dead felt and
 *      "This Table Is No Longer Running" for a table that is fine.
 *
 * AND IT EXPIRES ITSELF. A break that ends while the client is disconnected
 * would otherwise leave the overlay up forever, because the `ended` event is
 * sent by an engine this browser cannot currently reach. The end time is
 * absolute, so the overlay lifts on time whether or not anybody says so.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface MaintenanceBreakState {
  active: boolean;
  phase: 'last_hand' | 'counting_down';
  /** Absolute instant, epoch ms. Null during last_hand: no clock has started. */
  breakEndsAtMs: number | null;
  reason: string;
}

const IDLE: MaintenanceBreakState = {
  active: false,
  phase: 'counting_down',
  breakEndsAtMs: null,
  reason: '',
};

/**
 * A `last_hand` phase has no end time to expire against, so it is bounded by
 * how long it can legitimately last: two minutes by design, and this is the
 * ceiling before we stop believing it. Mirrors the 4-minute window in
 * fn_maintenance_break_state so the two cannot disagree.
 */
const LAST_HAND_MAX_MS = 4 * 60 * 1000;

// ───────────────────────────────────────────────────────────────────────────
// Shared fetch. MultiTablePage mounts up to four TablePages, each with its own
// socket and its own copy of this hook, and they would otherwise fire four
// identical RPCs at the same instant on every mount and every 4404.
// ───────────────────────────────────────────────────────────────────────────

let inFlight: Promise<MaintenanceBreakState> | null = null;
let lastFetchedAt = 0;
let lastResult: MaintenanceBreakState = IDLE;
const FETCH_TTL_MS = 5000;

async function fetchBreakState(): Promise<MaintenanceBreakState> {
  const now = Date.now();
  if (now - lastFetchedAt < FETCH_TTL_MS) return lastResult;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const { data, error } = await supabase.rpc('fn_maintenance_break_state');
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) {
        lastResult = IDLE;
      } else {
        const phase = (row.phase as MaintenanceBreakState['phase']) ?? 'counting_down';
        lastResult = {
          active: true,
          phase,
          // Prefer the absolute instant the server sent. remaining_ms is a
          // fallback for a clock we do not trust to agree with the server's.
          breakEndsAtMs:
            phase === 'counting_down'
              ? row.break_ends_at
                ? Date.parse(row.break_ends_at as string)
                : Date.now() + Number(row.remaining_ms ?? 0)
              : null,
          reason: (row.reason as string) || 'Scheduled Engine Maintenance',
        };
      }
    } catch {
      // Fail QUIET and fail OPEN. This runs on every 4404, including the
      // ordinary "this table really is gone" one, so a noisy failure here
      // would log on a completely healthy path. No break state simply means
      // the client behaves exactly as it did before this feature existed.
      lastResult = IDLE;
    }
    lastFetchedAt = Date.now();
    inFlight = null;
    return lastResult;
  })();

  return inFlight;
}

// ───────────────────────────────────────────────────────────────────────────

export function useMaintenanceBreak() {
  const [state, setState] = useState<MaintenanceBreakState>(IDLE);
  // Read by callbacks that must not re-subscribe every time the break ticks.
  const stateRef = useRef(state);
  stateRef.current = state;

  /** Feed an engine EVENT frame in. Safe to call with anything. */
  const ingestEvent = useCallback((type: string, data: Record<string, unknown>) => {
    if (type === 'MAINTENANCE_BREAK_ENDED') {
      setState(IDLE);
      // Drop the shared cache too, or a sibling table mounting a second later
      // re-reads a break that has just ended.
      lastResult = IDLE;
      lastFetchedAt = Date.now();
      return;
    }
    if (type !== 'MAINTENANCE_BREAK') return;

    const phase = data.phase === 'last_hand' ? ('last_hand' as const) : ('counting_down' as const);
    const endsAtRaw = data.break_ends_at ?? (data as Record<string, unknown>).breakEndsAt;
    setState({
      active: true,
      phase,
      breakEndsAtMs: typeof endsAtRaw === 'number' ? endsAtRaw : null,
      reason: (data.reason as string) || 'Scheduled Engine Maintenance',
    });
  }, []);

  /**
   * Ask the database whether a break is running. Called on mount and again
   * whenever the table refuses a connection, which is the case this exists
   * for: a 4404 during the restart is a break, and a 4404 at any other time
   * is a table that has genuinely closed.
   */
  const refreshFromDb = useCallback(async () => {
    const fetched = await fetchBreakState();
    // Never let a slower database read overwrite a live engine event. The
    // socket is more current by definition, and the RPC is cached for 5s.
    if (stateRef.current.active && !fetched.active) return;
    setState(fetched);
  }, []);

  useEffect(() => {
    void refreshFromDb();
  }, [refreshFromDb]);

  /**
   * Self-expiry. Runs once a second only while a break is up, so it costs
   * nothing the rest of the time.
   */
  useEffect(() => {
    if (!state.active) return;
    const tick = () => {
      const s = stateRef.current;
      if (!s.active) return;
      if (s.phase === 'counting_down' && s.breakEndsAtMs && Date.now() >= s.breakEndsAtMs) {
        setState(IDLE);
        return;
      }
      if (s.phase === 'last_hand' && !s.breakEndsAtMs) {
        // Bounded even though it has no clock: a last_hand that never became a
        // countdown means the engine died between :53 and :55, and the player
        // must not be held on an announcement nothing will ever resolve.
        // Tracked from when we first saw it, which is close enough.
        return;
      }
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state.active, state.phase, state.breakEndsAtMs]);

  /**
   * The last_hand safety fuse, as its own effect so the timer is re-armed from
   * the moment the phase was entered rather than on every render.
   */
  useEffect(() => {
    if (!state.active || state.phase !== 'last_hand') return;
    const t = setTimeout(() => {
      if (stateRef.current.phase === 'last_hand') setState(IDLE);
    }, LAST_HAND_MAX_MS);
    return () => clearTimeout(t);
  }, [state.active, state.phase]);

  return { maintenanceBreak: state, ingestMaintenanceEvent: ingestEvent, refreshFromDb };
}

export default useMaintenanceBreak;

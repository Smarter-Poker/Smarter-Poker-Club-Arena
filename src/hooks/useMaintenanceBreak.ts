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
 * AND IT DOES NOT LIE AT ZERO. A break that reaches its promised end while the
 * durable row remains becomes `recovering`: the countdown disappears, but the
 * protection does not. Only an engine-ended frame or an authoritative null-row
 * database receipt may lift it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { serverNow } from '../utils/serverClock';

export interface MaintenanceBreakState {
  active: boolean;
  phase: 'last_hand' | 'counting_down' | 'recovering';
  /** The promised, player-visible resume instant. Null once recovery runs late. */
  breakEndsAtMs: number | null;
  /**
   * Transport-only protection window.
   *
   * During recovery there is deliberately no second countdown promise, but a
   * durable break row still proves that a dead table socket is expected. Keep
   * the reconnect ladder in scheduled-restart mode while that proof remains,
   * without painting an invented time on screen.
   */
  connectionProtectedUntilMs: number | null;
  reason: string;
}

const IDLE: MaintenanceBreakState = {
  active: false,
  phase: 'counting_down',
  breakEndsAtMs: null,
  connectionProtectedUntilMs: null,
  reason: '',
};

/**
 * The complete persisted window is announcement lead (two minutes) plus the
 * five-minute break. This is only a compatibility fallback for an older event
 * that lacks resume_expected_at; current engine events and the database both
 * carry the exact announcement-anchored instant.
 */
const MAINTENANCE_WINDOW_MS = 7 * 60 * 1000;
const RECOVERY_REFRESH_MS = 5_000;
const RECOVERY_CONNECTION_PROTECTION_MS = 15_000;

// ───────────────────────────────────────────────────────────────────────────
// Shared fetch. MultiTablePage mounts up to four TablePages, each with its own
// socket and its own copy of this hook, and they would otherwise fire four
// identical RPCs at the same instant on every mount and every 4404.
// ───────────────────────────────────────────────────────────────────────────

let inFlight: Promise<MaintenanceBreakState | null> | null = null;
let lastFetchedAt = 0;
let lastResult: MaintenanceBreakState = IDLE;
let cacheRevision = 0;
const FETCH_TTL_MS = 5000;

async function fetchBreakState(force = false): Promise<MaintenanceBreakState | null> {
  const now = Date.now();
  if (!force && now - lastFetchedAt < FETCH_TTL_MS) return lastResult;
  if (inFlight) return inFlight;

  const requestRevision = cacheRevision;
  inFlight = (async () => {
    try {
      const { data, error } = await supabase.rpc('fn_maintenance_break_state');
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      let fetched: MaintenanceBreakState;
      if (!row) {
        fetched = IDLE;
      } else {
        const phase: MaintenanceBreakState['phase'] =
          row.phase === 'last_hand'
            ? 'last_hand'
            : row.phase === 'recovering'
              ? 'recovering'
              : 'counting_down';
        const visibleEnd = row.break_ends_at ? Date.parse(row.break_ends_at as string) : null;
        const fallbackEnd = serverNow() + Number(row.remaining_ms ?? 0);
        const breakEndsAtMs =
          phase === 'recovering'
            ? null
            : visibleEnd !== null && Number.isFinite(visibleEnd)
              ? visibleEnd
              : Number.isFinite(fallbackEnd)
                ? fallbackEnd
                : null;
        fetched = {
          active: true,
          phase,
          // Prefer the absolute instant the server sent. The RPC derives it
          // from announced_at for last_hand, so a browser loaded at :59 still
          // expires at :00. remaining_ms is only a clock-skew fallback.
          breakEndsAtMs,
          connectionProtectedUntilMs:
            phase === 'recovering'
              ? serverNow() + RECOVERY_CONNECTION_PROTECTION_MS
              : breakEndsAtMs,
          reason: (row.reason as string) || 'Scheduled Engine Maintenance',
        };
      }
      // A socket event (especially ENDED) that arrived while this RPC was in
      // flight is newer than its snapshot. Never let the late response put an
      // already released break back on screen.
      if (cacheRevision !== requestRevision) return lastResult;
      lastResult = fetched;
      lastFetchedAt = Date.now();
      return fetched;
    } catch {
      // Unknown is not the same as idle. During a proven break, replacing the
      // state with IDLE on one failed read would lift the overlay and reconnect
      // protection while the durable gate may still be closed. Before any
      // break is known, null still leaves the caller on the ordinary path.
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

// ───────────────────────────────────────────────────────────────────────────

export function useMaintenanceBreak() {
  const [state, setState] = useState<MaintenanceBreakState>(IDLE);
  // Read by callbacks that must not re-subscribe every time the break ticks.
  const stateRef = useRef(state);
  stateRef.current = state;
  const localRevision = useRef(0);
  const mountedRef = useRef(true);

  const commitState = useCallback((next: MaintenanceBreakState) => {
    if (!mountedRef.current) return;
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Fence every database response owned by this retired hook instance.
      localRevision.current += 1;
    };
  }, []);

  /** Feed an engine EVENT frame in. Safe to call with anything. */
  const ingestEvent = useCallback(
    (type: string, data: Record<string, unknown>) => {
      if (!mountedRef.current) return;
      if (type === 'MAINTENANCE_BREAK_ENDED') {
        localRevision.current += 1;
        commitState(IDLE);
        // Drop the shared cache too, or a sibling table mounting a second later
        // re-reads a break that has just ended.
        cacheRevision += 1;
        lastResult = IDLE;
        lastFetchedAt = Date.now();
        return;
      }
      if (type !== 'MAINTENANCE_BREAK') return;

      const phase: MaintenanceBreakState['phase'] =
        data.phase === 'last_hand'
          ? 'last_hand'
          : data.phase === 'recovering'
            ? 'recovering'
            : 'counting_down';
      const endsAtRaw =
        data.break_ends_at ??
        (data as Record<string, unknown>).breakEndsAt ??
        data.resume_expected_at;
      const eventAt = typeof data.timestamp === 'number' ? data.timestamp : serverNow();
      const breakEndsAtMs =
        typeof endsAtRaw === 'number'
          ? endsAtRaw
          : typeof endsAtRaw === 'string'
            ? Date.parse(endsAtRaw)
            : phase === 'last_hand'
              ? eventAt + MAINTENANCE_WINDOW_MS
              : null;
      const next: MaintenanceBreakState = {
        active: true,
        phase,
        breakEndsAtMs:
          typeof breakEndsAtMs === 'number' && Number.isFinite(breakEndsAtMs)
            ? breakEndsAtMs
            : null,
        connectionProtectedUntilMs:
          phase === 'recovering'
            ? serverNow() + RECOVERY_CONNECTION_PROTECTION_MS
            : typeof breakEndsAtMs === 'number' && Number.isFinite(breakEndsAtMs)
              ? breakEndsAtMs
              : null,
        reason: (data.reason as string) || 'Scheduled Engine Maintenance',
      };
      localRevision.current += 1;
      commitState(next);
      cacheRevision += 1;
      lastResult = next;
      lastFetchedAt = Date.now();
    },
    [commitState]
  );

  /**
   * Ask the database whether a break is running. Called on mount and again
   * whenever the table refuses a connection, which is the case this exists
   * for: a 4404 during the restart is a break, and a 4404 at any other time
   * is a table that has genuinely closed.
   */
  const refreshFromDb = useCallback(
    async (force = false) => {
      const requestRevision = localRevision.current;
      const fetched = await fetchBreakState(force);
      if (!fetched || !mountedRef.current || requestRevision !== localRevision.current) {
        return null;
      }

      const current = stateRef.current;
      // A live frame is authoritative until its promised end. After that, only
      // an authoritative null-row receipt may end recovery.
      if (!fetched.active && current.active) {
        const visibleEndPassed =
          current.breakEndsAtMs !== null && serverNow() >= current.breakEndsAtMs;
        if (current.phase !== 'recovering' && !visibleEndPassed) return current;
      }
      // Do not regress a local countdown/recovery to an older last-hand phase
      // from a request that was cached just before the engine advanced.
      const rank = { last_hand: 0, counting_down: 1, recovering: 2 } as const;
      if (fetched.active && current.active && rank[fetched.phase] < rank[current.phase]) {
        return current;
      }
      commitState(fetched);
      return fetched;
    },
    [commitState]
  );

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
      if (s.phase !== 'recovering' && s.breakEndsAtMs && serverNow() >= s.breakEndsAtMs) {
        const recovering: MaintenanceBreakState = {
          ...s,
          phase: 'recovering',
          // The visible promise has ended. Give the socket its own short,
          // renewable protection instead of painting a second fake countdown.
          breakEndsAtMs: null,
          connectionProtectedUntilMs: serverNow() + RECOVERY_CONNECTION_PROTECTION_MS,
        };
        localRevision.current += 1;
        commitState(recovering);
        cacheRevision += 1;
        lastResult = recovering;
        lastFetchedAt = 0;
      }
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [commitState, state.active, state.phase, state.breakEndsAtMs]);

  // Once the visible clock has expired, the durable row is the authority. Poll
  // only in this exceptional phase: a present row renews transport protection;
  // an exact absent result ends the overlay; a failed read changes nothing.
  useEffect(() => {
    if (!state.active || state.phase !== 'recovering') return;
    void refreshFromDb(true);
    const timer = setInterval(() => void refreshFromDb(true), RECOVERY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshFromDb, state.active, state.phase]);

  return { maintenanceBreak: state, ingestMaintenanceEvent: ingestEvent, refreshFromDb };
}

export default useMaintenanceBreak;

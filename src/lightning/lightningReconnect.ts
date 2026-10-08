/**
 * LIGHTNING PHASE 9: WHAT A RETURNING PLAYER IS TOLD WHEN THEIR ROOM IS GONE.
 *
 * A Lightning room that answers 4404 is gone from the engine, and three very
 * different truths can sit behind that one close:
 *
 *   - the pool session is STILL OPEN (an engine restart adopting its fleet,
 *     a blip): the room exists again moments later, so the right move is to
 *     keep the reconnect ladder running at the SAME pool_session_id;
 *   - the session ENDED while the player was away - the DB reaper timed the
 *     disconnect out (`expired`), or a queued leave / cash-out finished: the
 *     room will never deal again, and the player is owed the session summary
 *     and their way back (their seat when one remains, else the Cluster's
 *     entry);
 *   - the Cluster went back to MUST MOVE: Lightning Phase 7's notice already
 *     owns that ending (useLightningReversion), and it wins over this one.
 *
 * The close itself cannot be trusted to say which (the mux replaces the
 * reason with a code), so each close asks the database:
 * `fn_lightning_reconnect_state(p_cluster_id)` -> { pool_session_id, state,
 * in_hand, hand_id, disconnected_at, seat_table_id, seat_number, stack,
 * joinable }. A database that does not have the function yet (deploy window)
 * answers nothing, and this hook quietly does nothing: Phase 7's
 * fn_lightning_my_session path keeps working exactly as before.
 */
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';

/** The timeout ending's words. Popup rules: Title Case, no em dashes. */
export const LIGHTNING_TIMED_OUT_TITLE = 'Your Lightning Session Timed Out';
/** Any other ending that is not the MUST MOVE reversion. */
export const LIGHTNING_SESSION_OVER_TEXT = 'Your Lightning Session Has Ended';
/**
 * LIGHTNING PHASE 10: the ending the player asked for. The database records
 * `exit_reason` 'stop_playing' when fn_lightning_stop_playing ended the
 * session; a database that does not send the field yet keeps the ordinary
 * words.
 */
export const LIGHTNING_STOPPED_TITLE = 'You Stopped Playing';
export const LIGHTNING_STOP_PLAYING_EXIT_REASON = 'stop_playing';

/** The ended notice's line: how it ended, and where the player's seat is. */
export function lightningSessionEndText(end: {
  timedOut: boolean;
  seatTableId: string | null;
  /** The player stopped on purpose (exit_reason stop_playing). */
  stopped?: boolean;
}): string {
  const lead = end.stopped
    ? `${LIGHTNING_STOPPED_TITLE}.`
    : end.timedOut
      ? `${LIGHTNING_TIMED_OUT_TITLE}.`
      : `${LIGHTNING_SESSION_OVER_TEXT}.`;
  return end.seatTableId ? `${lead} Your Seat Is Ready At Your Table.` : lead;
}

/** fn_lightning_reconnect_state, as the client reads it. */
export interface LightningReconnectState {
  poolSessionId: string | null;
  state: string | null;
  inHand: boolean;
  handId: string | null;
  disconnectedAt: string | null;
  seatTableId: string | null;
  seatNumber: number | null;
  stack: number | null;
  joinable: boolean;
  /**
   * LIGHTNING PHASE 10: why the session ended ('stop_playing' when the
   * player used STOP PLAYING). Null while open, and on a database that does
   * not send the field yet.
   */
  exitReason: string | null;
}

/** Pool session states that mean the session is over (lightningSession.ts agrees). */
const ENDED_STATES = new Set(['closed', 'ended', 'left', 'cashed_out', 'expired']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Read the RPC's answer defensively: a malformed field is "not known", never a guess. */
export function parseLightningReconnectState(raw: unknown): LightningReconnectState {
  const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== 'object') {
    return {
      poolSessionId: null,
      state: null,
      inHand: false,
      handId: null,
      disconnectedAt: null,
      seatTableId: null,
      seatNumber: null,
      stack: null,
      joinable: false,
      exitReason: null,
    };
  }
  const id = text(row.pool_session_id);
  const seatTable = text(row.seat_table_id);
  const seat = num(row.seat_number);
  return {
    poolSessionId: id && isUUID(id) ? id : null,
    state: text(row.state),
    inHand: row.in_hand === true,
    handId: text(row.hand_id),
    disconnectedAt: text(row.disconnected_at),
    seatTableId: seatTable && isUUID(seatTable) ? seatTable : null,
    seatNumber: seat !== null && Number.isInteger(seat) && seat >= 1 ? seat : null,
    stack: num(row.stack),
    joinable: row.joinable === true,
    exitReason: text(row.exit_reason),
  };
}

/** PostgREST's "no such function": the migration has not landed yet. Not a fault. */
export function isMissingRpcError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.code === 'PGRST202' || e.code === '42883') return true;
  const m = typeof e.message === 'string' ? e.message : '';
  return /could not find the function|does not exist/i.test(m) && /fn_lightning_reconnect/i.test(m);
}

/**
 * Ask the database. `null` means the function is not deployed yet (the
 * caller does nothing and Phase 7's path stands); a read failure throws.
 */
export async function fetchLightningReconnectState(
  clusterId: string
): Promise<LightningReconnectState | null> {
  const { data, error } = await supabase.rpc('fn_lightning_reconnect_state', {
    p_cluster_id: clusterId,
  });
  if (error) {
    if (isMissingRpcError(error)) return null;
    throw error;
  }
  return parseLightningReconnectState(data);
}

export type LightningReconnectVerdict =
  /** The pool session lives: keep reconnecting to the SAME room. */
  | { kind: 'open'; poolSessionId: string }
  /**
   * It is over. `timedOut` when the disconnect reaper exited it; `stopped`
   * when the player's own STOP PLAYING did (exit_reason, Lightning Phase 10).
   */
  | { kind: 'ended'; timedOut: boolean; stopped: boolean; seatTableId: string | null }
  /** Nothing to say (another room's session, or nothing readable). */
  | { kind: 'unknown' };

/** What one answer means for ONE room. Never a guess: unknown stays unknown. */
export function lightningReconnectVerdict(
  roomId: string,
  state: LightningReconnectState | null | undefined
): LightningReconnectVerdict {
  if (!state) return { kind: 'unknown' };
  const ended = ENDED_STATES.has(String(state.state ?? '').toLowerCase());
  if (state.poolSessionId && !ended) {
    // An open session that is NOT this room says nothing about this room.
    return state.poolSessionId === roomId
      ? { kind: 'open', poolSessionId: state.poolSessionId }
      : { kind: 'unknown' };
  }
  if (!state.state && !state.poolSessionId && !state.seatTableId) {
    // The database knows nothing of a session here: the ordinary ended case
    // (the row is gone entirely once reaped and cleaned).
    return { kind: 'ended', timedOut: false, stopped: false, seatTableId: null };
  }
  return {
    kind: 'ended',
    timedOut: String(state.state ?? '').toLowerCase() === 'expired',
    stopped: String(state.exitReason ?? '').toLowerCase() === LIGHTNING_STOP_PLAYING_EXIT_REASON,
    seatTableId: state.seatTableId,
  };
}

export interface LightningSessionEnd {
  /** The reaper timed the disconnect out: the title is the timeout's. */
  timedOut: boolean;
  /** The player's own STOP PLAYING ended it: the title is theirs. */
  stopped: boolean;
  /** The seat the player still holds, when one remains. */
  seatTableId: string | null;
}

/**
 * The room's Phase 9 answer to a 4404 close. Still open -> `onStillOpen` (the
 * caller nudges the reconnect ladder; the room id never changes). Over ->
 * `ended`, once, for the notice with the summary. The MUST MOVE reversion
 * (useLightningReversion) runs beside this and takes precedence in the view.
 */
export function useLightningSessionEnd(input: {
  clusterId: string | null;
  roomId: string | null;
  /** The latest "this room is gone" signal (a 4404 close), or null. */
  roomClosed: unknown;
  onStillOpen?: () => void;
}): { ended: LightningSessionEnd | null } {
  const { clusterId, roomId, roomClosed, onStillOpen } = input;
  const [ended, setEnded] = useState<LightningSessionEnd | null>(null);
  const concludedRef = useRef(false);
  const askingRef = useRef(false);
  const unavailableRef = useRef(false);
  const roomRef = useRef(roomId);
  roomRef.current = roomId;
  const stillOpenRef = useRef(onStillOpen);
  stillOpenRef.current = onStillOpen;

  // A different room starts from nothing.
  useEffect(() => {
    concludedRef.current = false;
    setEnded(null);
  }, [clusterId, roomId]);

  useEffect(() => {
    if (!clusterId || !roomId || roomClosed === null || roomClosed === undefined) return;
    if (concludedRef.current || askingRef.current || unavailableRef.current) return;
    askingRef.current = true;
    void (async () => {
      try {
        const state = await fetchLightningReconnectState(clusterId);
        if (roomRef.current !== roomId) return;
        if (state === null) {
          // Deploy window: the RPC is not there. Phase 7's path stands alone.
          unavailableRef.current = true;
          return;
        }
        const verdict = lightningReconnectVerdict(roomId, state);
        if (verdict.kind === 'open') {
          // The session lives: the room comes back under the same id, so the
          // ladder should try again now rather than at its slow end.
          stillOpenRef.current?.();
          return;
        }
        if (verdict.kind === 'ended' && !concludedRef.current) {
          concludedRef.current = true;
          setEnded({
            timedOut: verdict.timedOut,
            stopped: verdict.stopped,
            seatTableId: verdict.seatTableId,
          });
        }
      } catch (err) {
        reportError(err, 'lightning.reconnect_state_read_failed', { clusterId });
      } finally {
        askingRef.current = false;
      }
    })();
  }, [clusterId, roomId, roomClosed]);

  return { ended };
}

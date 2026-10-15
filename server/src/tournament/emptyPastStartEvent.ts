/**
 * AN EVENT NOBODY ENTERED IS CANCELLED, NOT WAITED ON FOR EVER (2026-10-15).
 *
 * A registration-first event (an MTT and its variants) starts on its clock
 * once it has its minimum field. Short of that field past its start, the
 * discovery loop tops it up with horses and starts it on a later pass: Dan's
 * "TOURNAMENTS RUN. THEY DO NOT CANCEL" (2026-08-19), which exists so a player
 * who paid gets the game he paid for.
 *
 * That loop had no end for an event that NOBODY entered and that the horse
 * pool cannot fill. Measured on production 2026-10-15: three "Daily 25 Chip
 * Freezeout" events of a one-member pilot club with no horse in it sat
 * REGISTERING 7 to 55 hours past their start with zero entrants, a new one is
 * spawned every day, and TournamentNeverStarted paged on them every hour. The
 * same shape is what HorseTournamentsOverdue paged on 2026-10-05: zero-entrant
 * MTTs of a club under an operator hold, whose top-up is refused while the
 * club is held, cancelled by hand afterwards.
 *
 * Nothing is at stake in such an event: no entrant, so nothing to refund and
 * nobody denied a game. The rule for it is cancel and refund nothing, through
 * the platform's one cancellation authority (atomic_cancel_tournament), which
 * writes the immutable cancellation receipt and closes every bank at exact
 * zero. This predicate is the whole decision, so it is tested without a
 * database and the call site cannot drift from it.
 *
 * Every condition is required:
 *   - registration-first, never a seat-first Spin/SNG (those have their own
 *     unfilled-seat expiry and their start is bought seats, not a clock);
 *   - the prize pool is not finalized (a finalized pool has left
 *     registration; it needs the finish path, never a cancellation);
 *   - the roster read for this event SUCCEEDED and found no registered or
 *     playing entrant, and the denormalised counter agrees (an unreadable
 *     roster is not an empty one);
 *   - it is at least EMPTY_PAST_START_CANCEL_AFTER_MS past its start;
 *   - the past-start top-up has been asked at least once and added nobody,
 *     so a club whose horses CAN fill it is filled and played instead.
 */
export const EMPTY_PAST_START_CANCEL_AFTER_MS = 30 * 60 * 1000;
/** A refused cancellation is a stable answer; ask again at most this often. */
export const EMPTY_PAST_START_CANCEL_RETRY_MS = 30 * 60 * 1000;

export interface EmptyPastStartEvent {
  seatFirst: boolean;
  poolFinalized: boolean;
  /** Registered or playing entrants from a COMPLETE roster read; undefined if unread. */
  rosterCount: number | undefined;
  currentPlayers: number | null | undefined;
  startTimeMs: number;
  nowMs: number;
  /** Past-start top-ups that added nobody (the discovery loop's backoff counter). */
  emptyTopUps: number;
}

export function shouldCancelEmptyPastStartEvent(event: EmptyPastStartEvent): boolean {
  if (event.seatFirst || event.poolFinalized) return false;
  if (event.rosterCount !== 0) return false;
  if ((event.currentPlayers ?? 0) !== 0) return false;
  if (!Number.isFinite(event.startTimeMs) || !Number.isFinite(event.nowMs)) return false;
  if (event.nowMs - event.startTimeMs < EMPTY_PAST_START_CANCEL_AFTER_MS) return false;
  return event.emptyTopUps >= 1;
}

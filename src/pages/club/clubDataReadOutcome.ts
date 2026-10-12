/**
 * COULD NOT LOAD IS NOT EMPTY (2026-10-01).
 *
 * The Club Data page keeps the last verified ledger on screen when a
 * background refresh fails - that is correct, and the header says "Live
 * Refresh Delayed" beside rows that are still true. But the same branch also
 * ran when NO verified data was held yet: it cleared the error, marked the
 * ledger degraded, and left the Games list with nothing in it and nothing to
 * say. An operator saw an empty ledger with no message and no Try Again, which
 * reads exactly like "this club played no games" (CLAUDE.md 10.86 rule 1: a
 * read that could not complete was presented as an empty result).
 *
 * Two pure decisions live here so a test can pin them without a browser:
 *
 *  - clubDataReadFailure: what a failed read does to the page. Keeping the
 *    last snapshot is only allowed when a verified snapshot is actually held.
 *  - clubDataListState: what a list renders. "empty" requires a verified
 *    payload with zero rows; no payload and no request in flight is
 *    "unavailable", never "empty".
 */

export interface ClubDataReadFailureInput {
  /** The caller asked to keep the last verified data if this read fails. */
  preserveOnError: boolean;
  /** A verified payload (even one with zero rows) is currently held. */
  holdingVerifiedData: boolean;
  /** Title Case copy shown when there is nothing verified to fall back on. */
  message: string;
}

export interface ClubDataReadFailureOutcome {
  /** null keeps the held data on screen; a string is the honest message. */
  error: string | null;
  /** true when the held data stays and the ledger is marked delayed. */
  degraded: boolean;
  /** true when the (absent or unusable) payload must be cleared. */
  clearData: boolean;
}

export function clubDataReadFailure({
  preserveOnError,
  holdingVerifiedData,
  message,
}: ClubDataReadFailureInput): ClubDataReadFailureOutcome {
  if (preserveOnError && holdingVerifiedData) {
    return { error: null, degraded: true, clearData: false };
  }
  return { error: message, degraded: false, clearData: true };
}

export type ClubDataListState = 'loading' | 'unavailable' | 'empty' | 'rows';

export interface ClubDataListStateInput {
  loading: boolean;
  error: string | null;
  /** The verified payload's row count, or null when no payload is held. */
  rowCount: number | null;
}

export function clubDataListState({
  loading,
  error,
  rowCount,
}: ClubDataListStateInput): ClubDataListState {
  if (error) return 'unavailable';
  if (rowCount === null) return loading ? 'loading' : 'unavailable';
  // A held verified payload stays as it is while a refresh is in flight: its
  // rows (possibly none) remain on screen, and "No Games" appears once settled.
  if (rowCount === 0 && !loading) return 'empty';
  return 'rows';
}

/** What an unavailable list says when no more specific message was set. */
export const CLUB_GAMES_UNAVAILABLE_COPY = 'Could Not Load Club Data.';
export const CLUB_PLAYERS_UNAVAILABLE_COPY = 'Could Not Load Player Data.';

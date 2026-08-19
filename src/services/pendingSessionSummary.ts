/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  pendingSessionSummary — carry the session result across the route change
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-18: "when you leave table, it should always auto take you to the
 * lobby, your Session Complete should show up as a pop up in the lobby page."
 *
 * THE PROBLEM THIS SOLVES
 *
 * Every number in that modal lived in `useRef`s inside TablePage
 * (useTableSession.ts: sessionStartRef, handsPlayedRef, handsWonRef,
 * biggestPotRef, peakStackRef, sessionPLRef, totalRebuysRef) and was passed
 * straight into the modal as props. Nothing else held them: no store, no
 * localStorage, no DB row - the notification written on leave carries only P/L
 * and hand count, not duration, biggest pot, peak stack or rebuys.
 *
 * So the modal could only render while TablePage was still mounted, which is
 * exactly why it appeared ON the table. Navigate to the lobby first and the
 * refs die with the component, taking the summary with them.
 *
 * This is the handoff: TablePage publishes the finished payload the moment it
 * knows the result, then navigates. The host at the app root picks it up and
 * shows it wherever the player has landed.
 *
 * WHY A MODULE, NOT A STORE OR ROUTER STATE
 *
 *  - Router state (`navigate('/', { state })`) is lost on refresh and is
 *    awkward for the multi-table path, which does not always navigate.
 *  - A Zustand slice would work, but this is a one-shot value with a single
 *    producer and a single consumer; a small subscribe-able module keeps it
 *    obvious. Same shape as confirmDialog's module-level bridge.
 *
 * Deliberately in-memory: a session summary is not worth restoring after a hard
 * refresh, and persisting it risks showing a stale one days later.
 */

export interface SessionSummaryPayload {
  /** Elapsed session time in SECONDS (not a timestamp). */
  duration: number;
  handsPlayed: number;
  handsWon: number;
  totalRebuys: number;
  /** Net chips: what you left with minus everything you bought in for. */
  profitLoss: number;
  biggestPot: number;
  peakStack: number;
  /** Shown in the header when known, e.g. "NLH 1/2". */
  tableName?: string;
}

type Listener = (payload: SessionSummaryPayload | null) => void;

let pending: SessionSummaryPayload | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) {
    try {
      l(pending);
    } catch {
      /* one broken listener must never block the others */
    }
  }
}

/** Publish a finished session. Called by TablePage immediately before it navigates. */
export function publishSessionSummary(payload: SessionSummaryPayload): void {
  pending = payload;
  emit();
}

/** Read without consuming (used for the host's initial state). */
export function peekSessionSummary(): SessionSummaryPayload | null {
  return pending;
}

/** Clear it. Called when the player dismisses the popup. */
export function clearSessionSummary(): void {
  if (pending === null) return;
  pending = null;
  emit();
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeSessionSummary(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

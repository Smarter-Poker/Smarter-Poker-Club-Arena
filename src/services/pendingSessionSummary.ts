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

/**
 * A tournament result. Present ONLY for tournament sessions.
 *
 * Dan 2026-08-20: "tournaments are never displayed by chips, only what place
 * you finished and how much you made."
 *
 * Chip counts are meaningless once a tournament is over — tournament chips have
 * no cash value, you cannot leave the table with them, and a player who min-
 * cashed with a huge stack earlier still finished where they finished. The cash
 * summary's whole vocabulary (profit/loss, biggest pot, peak stack) is the wrong
 * language for that, so when this block is present the summary renders a
 * different modal entirely rather than filling chip tiles with zeroes.
 */
export interface TournamentResult {
  /** Tournament name for the header, e.g. "Early Bird Freeroll". */
  name?: string;
  /** Finishing position. null while still in play or if the row is unreadable. */
  finishPlace: number | null;
  /** Field size, for the "3rd of 128" line. null when unknown. */
  entrants: number | null;
  /** Prize money awarded for the finish. 0 for a non-cashing finish. */
  prize: number;
  /** Bounty/PKO winnings, separate from the finish prize. */
  bountyWinnings: number;
  /** Bounties collected — knockouts. */
  knockouts: number;
  rebuys: number;
  addOns: number;
  /**
   * Is this a Spin?
   *
   * Only the card's BRANDING turns on this — a Spin is still a tournament and
   * every number above means exactly the same thing. It exists because the
   * ranking card hard-coded the word SPIN into its banner for every event, so
   * a 128-runner MTT finished under a Spin badge.
   *
   * Resolved by `isSpinTournament` from the tournament row (it checks both
   * `variant` and `tournament_type`), never guessed from the event name.
   *
   * Optional, defaulting to false: an older payload simply is not a Spin, and
   * that is the safe direction — a real Spin missing its badge is a cosmetic
   * loss, an MTT wearing one is a lie.
   */
  isSpin?: boolean;
}

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
  /**
   * Set for tournament sessions. Its presence — not a boolean flag — is what
   * switches the modal, so a tournament can never render half a cash summary
   * because someone forgot to set the flag.
   */
  tournament?: TournamentResult;
  vpipPercent?: number;
  totalBuyIn?: number;
  sessionStart?: number;
  sessionEnd?: number;
  /**
   * True when the cashout was DEFERRED (mid-hand leave): `profitLoss` is an
   * estimate built from the live stack at the moment of leaving, not the
   * settled number — the true cashout lands at settlement, after this popup
   * is already on screen. The card annotates the money line so the estimate
   * is never mistaken for the settled figure. Cash sessions only; a
   * tournament payload never sets it.
   */
  plPending?: boolean;
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

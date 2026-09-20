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
import type { Card } from '../components/table/CardImage';

export interface TournamentResult {
  /** Tournament name for the header, e.g. "Early Bird Freeroll". */
  name?: string;
  /** Finishing position. null while still in play or if the row is unreadable. */
  finishPlace: number | null;
  /** Immutable v3 satellite outcome; equal qualifiers have no finishing rank. */
  satelliteQualification?: {
    targetId: string;
    deliveryKind: 'seat' | 'ticket' | 'cash';
    amount: number;
  };
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
   * MYSTERY BOUNTY (Dan sections 43 and 44), the chest half broken out.
   *
   * `bountyWinnings` above is every bounty this player collected, which in a
   * mystery event includes the flat bounties paid before the chests opened.
   * These three say how much of it came out of a chest, how many chests, and
   * the biggest single one - the number a player actually tells people about.
   *
   * IN CENTS, like everything the mystery engine emits, and divided by 100
   * exactly once at the render boundary. `bountyWinnings` is in whole chips
   * because it comes off `tournament_players.bounty_winnings`, which is a
   * numeric column; mixing the two units silently would report a 5,000 chest
   * as 500,000.
   *
   * Optional: an older payload, or any non-mystery event, simply has none.
   */
  mysteryBounties?: number;
  mysteryBountyCents?: number;
  largestMysteryBountyCents?: number;
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
  /** The hole cards the hero held when they won the tournament. */
  winningCards?: Card[];
  /**
   * The finished tournament's id (2026-08-29, round 12). What Play Again
   * needs to be a real button: with the id, the ranking card can read the
   * origin game's club, stake and variant and seat the player straight into
   * the open sibling game - the supply audit proved one always exists for
   * every seat-first stake. Without it (an older payload), Play Again keeps
   * its list-navigation fallback.
   */
  tournamentId?: string;
}

export interface SessionSummaryPayload {
  arenaAsset?: 'chips' | 'diamonds';
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
  /**
   * Set alongside `plPending`: everything the app-root host needs to find the
   * settlement on its own. The engine's processLeavePending credits the true
   * post-hand stack via atomic_credit_wallet_and_log, which writes ONE
   * wallet_transactions row (category 'cashout', this table, this user) —
   * that row IS the settled number, and RLS already lets a user read their
   * own rows. TablePage cannot watch for it (it navigates away and unmounts
   * immediately after publishing), so the host polls while the card is open
   * and swaps the estimate for the settled figure when the row lands.
   */
  pendingCashout?: {
    tableId: string;
    userId: string;
    /** Epoch ms of the leave — bounds the ledger query so a cashout row from
     *  an earlier session at the same table can never be mistaken for this
     *  settlement. */
    sinceMs: number;
    /** Exact seat generation required for a Diamond cash-out receipt. */
    occupancyId?: string;
  };
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

/**
 * Later publishes must not swallow an unacknowledged TOURNAMENT card
 * (Dan 2026-08-30: "IT SHOULD NEVER 'AUTO CLOSE', USER MUST CLICK THE 'X'").
 * A second table's exit used to overwrite `pending` outright, so the ranking
 * card - place, medal, prize - vanished mid-read, which from the felt reads
 * as the card auto-closing. Held publishes wait here and surface when the X
 * clears the card in front of them.
 */
let heldQueue: SessionSummaryPayload[] = [];

/** Publish a finished session. Called by TablePage immediately before it navigates. */
export function publishSessionSummary(payload: SessionSummaryPayload): void {
  if (pending?.tournament) {
    if (payload.tournament?.tournamentId === pending.tournament.tournamentId) {
      /* Same event re-publishing (the bust path fires once early, once with
         the settled row): MERGE, never downgrade - a place or prize already
         on screen must not be replaced with a null. */
      pending = {
        ...payload,
        tournament: {
          ...payload.tournament!,
          finishPlace: payload.tournament!.finishPlace ?? pending.tournament.finishPlace,
          prize: payload.tournament!.prize || pending.tournament.prize,
        },
      };
      emit();
      return;
    }
    /* A different session finished while the ranking card is up: hold it. */
    heldQueue = [...heldQueue.filter((q) => q.tableName !== payload.tableName), payload];
    return;
  }
  pending = payload;
  emit();
}

/** Read without consuming (used for the host's initial state). */
export function peekSessionSummary(): SessionSummaryPayload | null {
  return pending;
}

/**
 * The settlement landed: replace the estimated P/L with the settled figure
 * and drop the "Pending Settlement" annotation. No-op if the popup was
 * already dismissed (the one-shot value is gone — there is nothing to
 * correct) or if the payload is not the pending one it was found for.
 */
export function settlePendingSummary(settledProfitLoss: number): void {
  if (pending === null || !pending.plPending) return;
  pending = {
    ...pending,
    profitLoss: settledProfitLoss,
    plPending: false,
    pendingCashout: undefined,
  };
  emit();
}

/** Clear it. Called when the player dismisses the popup. A publish that was
 *  held behind an unacknowledged tournament card surfaces now. */
export function clearSessionSummary(): void {
  if (pending === null) return;
  pending = heldQueue.shift() ?? null;
  emit();
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeSessionSummary(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * PRESENCE FOLLOWS THE PLAYER ACROSS A MOVE (2026-09-05).
 *
 * `docs/changelog/2026-09-05-the-must-move-lobby.md` closed with this owed:
 * "presence is not transferred across a move (the client re-subscribes)".
 * What that meant in practice is that the destination engine met every
 * arriving player as a stranger. `DisconnectEngine.registerPlayer` seeds
 * `isConnected: true, consecutiveTimeouts: 0, isSittingOut: false,
 * awayBlindSbCharged: false, awayBlindBbCharged: false, pageLeftAt: null` -
 * so a must-move handed a player whose phone had died a fully present seat
 * with a clean record:
 *
 *   - AWAY BECAME PRESENT. `isAway()` is derived from exactly those three
 *     fields, so an absent player arrived "here", was dealt in, and burned the
 *     table's whole action clock every orbit until the heartbeat checker
 *     re-noticed them - the same defect B10 fixed for a restart, re-opened by
 *     a move.
 *   - THE AWAY-BLIND BUDGET WAS REFUNDED. Dan's cap is one SB and one BB per
 *     absence. A player one blind from eviction arrived with both slots free,
 *     so a game that moved its players often could never spend the budget.
 *   - THE STRIKES WERE FORGIVEN. Three timeouts force a sit-out; a move
 *     reset the count to zero mid-ladder.
 *   - THE SIT-OUT CLOCK RESTARTED. `sit_out_at` is now carried on the seat row
 *     (migration 20260905064237), and the FSM's own `sitOutSince` is carried
 *     here, so the five-minute eviction is the same five minutes it was.
 *
 * This is the handoff. The engine at the FROM table DEPOSITS the player's
 * `DisconnectFsmEntry` - the identical shape a restart persists to
 * `engine_presence_parked` - and the engine at the TO table CLAIMS it the
 * first time it sees the new chair. One process holds every table, so the
 * handoff is a Map rather than a round trip; a deposit nobody claims expires
 * on its own.
 *
 * THE TIME BANK RIDES ALONG, and it is the one piece that could not be done
 * from the seat row. `time_bank_remaining` is carried by the SQL, but
 * ServerTableEngineDealing deliberately does NOT read it back - see the long
 * "REVERTED 2026-08-25" note there: the column is `DEFAULT 30` and never null,
 * so nothing can tell "never seeded" from "30 seconds left", and reading it
 * charged every VIP's monthly quota at every seat. A handoff has no such
 * ambiguity: a deposit exists only when the source engine genuinely held a
 * bank for that player, so claiming it is unambiguous where reading the column
 * is not. Nothing about the reverted seat-row path changes.
 *
 * DEPOSIT EARLY AND OFTEN. The source stamps a fresh entry every time it
 * announces a pending move (once per hand) and again as the move executes, so
 * the claimed entry is the freshest one the source ever saw. That also covers
 * a SWAP, where the second table's transaction lands BOTH chairs: the partner
 * never runs an executor of its own, and its presence is already on deposit
 * from its own table's announce.
 */

import type { DisconnectFsmEntry } from './DisconnectEngine.js';

/** What a player's time bank was worth at the table they are leaving. */
export interface CarriedTimeBank {
  remainingSeconds: number;
  usesRemaining: number;
  /** ServerTableEngineBase.timeBankMeta, so VIP quota accounting continues. */
  initialSeconds: number;
  baseSeconds: number;
  dbConsumedSeconds: number;
}

export interface MovedPresence {
  fsm: DisconnectFsmEntry;
  timeBank: CarriedTimeBank | null;
  depositedAtMs: number;
  /** The table the player left, for the log line at the other end. */
  fromTableId: string;
}

/**
 * How long a deposit is worth claiming.
 *
 * A planned move expires after three minutes and the destination engine sees
 * the new chair on its next seat sweep (three seconds while dealing, five
 * while idle), so a claim that has not happened inside ten minutes describes a
 * table that has since dealt many hands without the player - at which point
 * the live observation is the true one and a stale entry would be a lie about
 * a player who may well be sitting there happily. Ten minutes is the same
 * order as PARKED_PRESENCE_FRESH_MS (20 min) for the restart path, shorter
 * because a move is not a restart: nothing is down in between.
 */
export const MOVED_PRESENCE_FRESH_MS = 10 * 60_000;

/**
 * A ceiling, so a destination engine that never comes back cannot grow this
 * without bound. Far above any plausible in-flight population: the whole
 * fleet is a few hundred seats and a move is claimed within seconds.
 */
export const MOVED_PRESENCE_MAX = 2_000;

const inTransit = new Map<string, MovedPresence>();

function key(playerId: string, toTableId: string): string {
  return `${playerId}:${toTableId}`;
}

/** Drop every deposit older than MOVED_PRESENCE_FRESH_MS. */
export function pruneMovedPresence(nowMs: number = Date.now()): number {
  let dropped = 0;
  for (const [k, v] of inTransit) {
    if (nowMs - v.depositedAtMs > MOVED_PRESENCE_FRESH_MS) {
      inTransit.delete(k);
      dropped++;
    }
  }
  return dropped;
}

/**
 * The source engine hands this player's presence to the table they are moving
 * to. Overwrites any earlier deposit for the same destination on purpose: the
 * latest observation is the one worth carrying.
 */
export function depositMovedPresence(
  playerId: string,
  toTableId: string,
  presence: Omit<MovedPresence, 'depositedAtMs'>,
  nowMs: number = Date.now()
): void {
  if (!playerId || !toTableId) return;
  pruneMovedPresence(nowMs);
  if (inTransit.size >= MOVED_PRESENCE_MAX && !inTransit.has(key(playerId, toTableId))) {
    // Oldest first: Map preserves insertion order, and a deposit that has sat
    // here longest is the one least likely to still be claimed.
    const oldest = inTransit.keys().next();
    if (!oldest.done) inTransit.delete(oldest.value);
  }
  inTransit.set(key(playerId, toTableId), { ...presence, depositedAtMs: nowMs });
}

/**
 * The destination engine takes the presence left for this player, once. Null
 * when there is none, or when it is older than MOVED_PRESENCE_FRESH_MS - in
 * both cases the destination registers the player the ordinary way, which is
 * exactly what happened before this file existed.
 */
export function claimMovedPresence(
  playerId: string,
  toTableId: string,
  nowMs: number = Date.now()
): MovedPresence | null {
  const k = key(playerId, toTableId);
  const found = inTransit.get(k);
  if (!found) return null;
  inTransit.delete(k);
  if (nowMs - found.depositedAtMs > MOVED_PRESENCE_FRESH_MS) return null;
  return found;
}

/** Test/ops hook: how many deposits are waiting to be claimed. */
export function movedPresenceCount(): number {
  return inTransit.size;
}

/** Test hook only. Never called from the engine. */
export function resetMovedPresence(): void {
  inTransit.clear();
}

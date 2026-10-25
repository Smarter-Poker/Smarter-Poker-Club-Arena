/**
 * LIGHTNING: THE HERO BETWEEN HANDS (Dan 2026-10-24).
 *
 * Dan, verbatim: "IN LIGHTNING GAMES, WHEN YOU MOVE TO A NEW TABLE AFTER
 * FOLDING... IT SHOUDN'T SAY SITTING OUT... AND IT SHOULD 100% ALWAYS SHOW
 * YOUR BALANCE AT ALL TIMES, IT SHOULD NEVER SAY 0.00"
 *
 * The engine answers a Lightning fold with the idle shape: stage 'waiting' and
 * `players: []` (LightningHandHost.idleShape). The player is not in any hand,
 * so the roster has no hero, and the table view draws its placeholder chair.
 * That placeholder was written for a cash seat being bought: it reads its
 * balance from the seat row or the buy-in (a pool session has neither, so it
 * printed 0.00) and calls the chair `sitting_out` (so it wore the SITTING OUT
 * badge). Neither is true of a Lightning player between hands. They are in
 * the pool, about to be dealt, holding the stack they folded with.
 *
 * This module decides what that chair shows. It is pure so the rule can be
 * pinned without mounting the table.
 */

/** What the waiting chair is drawn with. */
export interface LightningWaitingHero {
  /** `sitting_out` only when the player actually asked to sit out. */
  status: 'active' | 'sitting_out';
  /** The player's balance, or null when nothing has told us yet. Never a made-up 0. */
  stack: number | null;
}

export interface LightningWaitingHeroInput {
  /** The player's own Sit Out, as the Lightning sit-out state reports it. */
  sittingOut: boolean;
  /**
   * The hero's stack the last time this room's roster carried them: the
   * engine's own number for the chips behind them at the moment they folded,
   * which is exactly what they hold now. First, because it is live.
   */
  lastSeenStack: number | null | undefined;
  /**
   * The pool session's balance from the database (fn_lightning_my_session:
   * the anchor stack less the chips held in hands they folded out of), read
   * for THIS room. Used when the roster has not carried the hero since this
   * room opened: a fresh join, a reload, a second device.
   */
  sessionStack: number | null | undefined;
}

function chips(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function lightningWaitingHero(input: LightningWaitingHeroInput): LightningWaitingHero {
  const seen = chips(input.lastSeenStack);
  /* A last-seen zero is the one roster number that may not be the balance: an
     all-in hero reads 0 behind until the pot is paid. The database knows
     better there, so a seen 0 yields to it and is used only when nothing else
     is known. */
  const stack = seen !== null && seen > 0 ? seen : (chips(input.sessionStack) ?? seen);
  return {
    status: input.sittingOut ? 'sitting_out' : 'active',
    stack,
  };
}

/**
 * The balance a session read may stand for. The read is only adopted for the
 * room it was made for, and only from a session that still has that room.
 */
export function lightningSessionStackFor(
  roomId: string | null | undefined,
  session: { poolSessionId: string | null; stack: number | null } | null | undefined
): number | null {
  if (!roomId || !session || session.poolSessionId !== roomId) return null;
  return chips(session.stack);
}

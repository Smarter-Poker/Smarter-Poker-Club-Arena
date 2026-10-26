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
   * The engine's own answer: `lightning.player_balance` on the idle snapshot
   * of this room, for this player (lightningIdleBalanceFor). The chips behind
   * them as the hand left them. Top precedence when present. An engine that
   * predates the field sends nothing, and the two fallbacks below decide.
   */
  engineStack?: number | null | undefined;
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
  const engine = chips(input.engineStack);
  if (engine !== null) {
    return { status: input.sittingOut ? 'sitting_out' : 'active', stack: engine };
  }
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

/** The part of an idle engine snapshot that carries the room owner's balance. */
export interface LightningIdleBalanceSnapshot {
  table_id?: unknown;
  stage?: unknown;
  lightning?: { player_balance?: { user_id?: unknown; stack?: unknown } | null } | null;
}

/**
 * The balance the engine put on this room's idle snapshot, adopted only when
 * it names THIS player and the snapshot is THIS room's (or names no room).
 * Null on an older engine, which sends no `player_balance`.
 */
export function lightningIdleBalanceFor(
  roomId: string | null | undefined,
  userId: string | null | undefined,
  snapshot: LightningIdleBalanceSnapshot | null | undefined
): number | null {
  if (!roomId || !userId || !snapshot) return null;
  const balance = snapshot.lightning?.player_balance;
  if (!balance || balance.user_id !== userId) return null;
  if (snapshot.table_id != null && snapshot.table_id !== roomId) return null;
  const stack = typeof balance.stack === 'string' ? Number(balance.stack) : balance.stack;
  return chips(typeof stack === 'number' ? stack : null);
}

// ─── The hero is at the table between hands (Lightning transition, phase 1) ──

/**
 * Is the hero at this table, for every decision that changes the felt's
 * shape: the phone spectator layout (`data-hero`), the seat taper, and what
 * DealerButton and useProtectedCardLayout read off `data-hero`.
 *
 * At a Classic table the answer is the roster and nothing else, exactly as
 * before. In a Lightning room the roster is empty between hands (the idle
 * snapshot after a fold carries no players), and reading it alone switched
 * the phone to the spectator layout on every fold and back on every deal: the
 * table grew about 26px taller and lost its taper, then shrank again. A
 * Lightning player between hands still holds their chair (`heroSeat`), so in
 * a Lightning room that chair counts.
 */
export function heroIsAtTable(input: {
  /** The roster carries a row flagged as the hero. */
  heroInRoster: boolean;
  /** This room is a Lightning pool session. */
  lightningRoom: boolean;
  /** The chair the table holds for the hero (0 for none). */
  heroSeat: number;
}): boolean {
  return input.heroInRoster || (input.lightningRoom && input.heroSeat > 0);
}

/** The part of the hero's last roster row the waiting chair carries on. */
export interface LightningHeroRowIdentity {
  name?: string | null;
  avatar?: string | null;
  frame?: string | null;
  aura?: string | null;
}

export interface LightningStandInIdentity {
  name: string;
  avatar: string;
  frame?: string;
  aura?: string;
}

function text(v: string | null | undefined): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Who the hero's waiting chair shows between Lightning hands. In a hand the
 * chair wears the hero's table alias (or their poker name), their equipped
 * frame and their aura. The stand-in chair used to fall back to the bare
 * username with no frame and no aura, so the player's own seat changed face
 * on every fold. It now wears what the hand last showed: the same name rule
 * as the seat in a hand (alias, then poker name, then the row's name), and the
 * frame and aura from the hero's last roster row.
 */
export function lightningStandInIdentity(input: {
  /** The table alias, only when the player turned "use alias" on. */
  tableAlias: string | null | undefined;
  /** The player's poker name from their profile, when it has loaded. */
  profileName: string | null | undefined;
  /** The hero's row the last time this room's roster carried it. */
  lastRow: LightningHeroRowIdentity | null | undefined;
  /** The signed-in username (the Classic stand-in's own fallback). */
  username: string | null | undefined;
  /** The hero's current avatar. */
  avatarUrl: string | null | undefined;
}): LightningStandInIdentity {
  const last = input.lastRow ?? null;
  const name =
    text(input.tableAlias) ??
    text(input.profileName) ??
    text(last?.name) ??
    text(input.username) ??
    'You';
  const avatar = text(input.avatarUrl) ?? text(last?.avatar) ?? '';
  const out: LightningStandInIdentity = { name, avatar };
  const frame = text(last?.frame);
  const aura = text(last?.aura);
  if (frame) out.frame = frame;
  if (aura) out.aura = aura;
  return out;
}

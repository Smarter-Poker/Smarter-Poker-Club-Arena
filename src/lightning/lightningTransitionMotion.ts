/**
 * LIGHTNING TRANSITION, PHASE 3: SMOOTHER MOTION BETWEEN HANDS.
 *
 * Pure rules the table view applies so the moment between two Lightning hands
 * plays its animations instead of cutting them off. Every rule answers "no
 * change" outside a Lightning pool-session room, so a Classic table never
 * takes a new branch.
 *
 *   - `lightningExitHoldMs`: how long the felt keeps the folded hand on screen
 *     after the engine's idle snapshot, so the hero's cards finish flying to
 *     the muck and the opponents and board fade out rather than vanish.
 *   - `lightningHeroSeatFromRoster`: the chair the hero holds in the incoming
 *     roster, adopted in the same update as the roster, so the hero never sits
 *     in the wrong chair for a frame.
 *   - `lightningParkedDealerSeat`: the dealer button stays where it was between
 *     hands, so the next hand's button beat glides it to its new seat.
 *   - `lightningHoldsHeroDealSound`: the hero's card-slide cue waits for the
 *     deal to reach the seats, so the cues play shuffle, chime, deal, slide.
 *   - `lightningEarlyHeroCards*`: hole cards that arrive a moment before the
 *     hero's roster row are kept and applied when the row arrives.
 */

/**
 * The fold window SeatSlot gives a seat's cards to reach the muck (380 ms
 * flight + 55 ms second-card delay, rounded up), at Animation Speed 1.
 * SeatSlot.tsx uses the same 500.
 */
export const LIGHTNING_EXIT_HOLD_BASE_MS = 500;

/**
 * How long the felt keeps the hand the hero just left on screen after the
 * engine's idle snapshot arrives. Zero means apply it at once.
 *
 * The engine answers a Lightning fold with the fold, then the table, then the
 * idle snapshot (stage 'waiting', no players) one macrotask later. Applied
 * verbatim, it removed the hero's cards one frame into their 435 ms flight to
 * the muck and took every opponent off the felt in the same frame. The hold is
 * one fold window, scaled by Animation Speed. A snapshot carrying a hand ends
 * the hold at once, so a fast next deal is never delayed.
 */
export function lightningExitHoldMs(input: {
  lightningRoom: boolean;
  observer: boolean;
  snapshotIdle: boolean;
  /** Occupied chairs on the felt right now. */
  feltPlayers: number;
  /** The player's Animation Speed multiplier. */
  speed: number;
}): number {
  if (!input.lightningRoom || input.observer || !input.snapshotIdle) return 0;
  if (input.feltPlayers <= 0) return 0;
  const speed = Number.isFinite(input.speed) && input.speed > 0 ? input.speed : 1;
  return Math.round(LIGHTNING_EXIT_HOLD_BASE_MS * speed);
}

/**
 * The hero's chair in the incoming roster, or 0 when it should not be adopted
 * here. In a Lightning room the hero changes chair every hand. The chair
 * layout follows `heroSeat`, which the seat invariant used to adopt only after
 * the new roster had painted, so for one frame an opponent sat in the hero's
 * spot with hero styling and the dealer button set off across the table.
 */
export function lightningHeroSeatFromRoster(input: {
  lightningRoom: boolean;
  observer: boolean;
  /** The player has asked to leave this seat; never re-adopt it. */
  leaving: boolean;
  userId: string | null | undefined;
  players: ReadonlyArray<{ id: string } | null | undefined>;
}): number {
  if (!input.lightningRoom || input.observer || input.leaving) return 0;
  if (!input.userId || input.userId === 'guest') return 0;
  const idx = input.players.findIndex((p) => !!p && p.id === input.userId);
  return idx >= 0 ? idx + 1 : 0;
}

/**
 * Where the dealer button sits. The idle snapshot carries dealer seat 0, which
 * hid the button for the whole wait; the next hand then popped it in at its
 * seat, and the 700 ms button beat that opens every deal showed nothing
 * moving. In a Lightning room an idle snapshot keeps the button parked where
 * it was, so the next hand's beat glides it across.
 */
export function lightningParkedDealerSeat(input: {
  lightningRoom: boolean;
  snapshotIdle: boolean;
  incoming: number;
  previous: number;
}): number {
  if (input.lightningRoom && input.snapshotIdle && !(input.incoming > 0) && input.previous > 0) {
    return input.previous;
  }
  return input.incoming;
}

/**
 * Whether the hero's card-slide cue waits for the deal. The hero's hole cards
 * reach the client before the 700 ms button beat ends, so the cue played
 * first, then the shuffle, then the chime, then the deal: the cards were
 * announced before anyone dealt them. In a Lightning room, when the deal of
 * this hand has been scheduled and has not yet landed, the cue is held and
 * played when it lands (it is never dropped; CLAUDE.md 10.6).
 */
export function lightningHoldsHeroDealSound(input: {
  lightningRoom: boolean;
  hand: number;
  /** The last hand whose deal presentation was scheduled. */
  presentedHand: number;
  /** The last hand whose deal animation landed. */
  settledHand: number;
}): boolean {
  if (!input.lightningRoom || !(input.hand > 0)) return false;
  return input.presentedHand === input.hand && input.settledHand !== input.hand;
}

// Compatibility for existing Lightning callers; the delivery buffer is shared
// table presentation, independent of Lightning movement or session rules.
export { earlyHeroCardsReady as lightningEarlyHeroCardsReady } from '../utils/earlyHeroCards';
export type { EarlyHeroCards as LightningEarlyHeroCards } from '../utils/earlyHeroCards';

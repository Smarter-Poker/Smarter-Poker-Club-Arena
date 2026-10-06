/**
 * ═══ A TURN HANDED BACK IS A TURN (2026-10-04) ═══════════════════════════════
 *
 * Dan, 2026-10-04, after a human-versus-human match: "MY HUMAN OPPONENT [WAS]
 * CONSTANTLY BEING TIMED OUT OR DISCONNECTED."
 *
 * WHAT THE FENCE IS FOR. When the hero acts, the page hides the action bar at
 * once (optimistically). The engine then publishes a snapshot that STILL names
 * the hero as the actor: it broadcasts from inside the PLAYER_ACTION handler,
 * before HandController has advanced the turn, and again when it deals the
 * next street. Applied verbatim, those frames put the bar back for a moment
 * after every action (Dan 2026-08-27). The fence withholds them.
 *
 * WHAT IT GOT WRONG. It judged a frame by two facts only: "names the seat that
 * just acted" and "arrived within 1500ms". That is also an exact description
 * of the engine legitimately handing the SAME seat the next decision: the
 * player who closes a street (the big blind calling a raise, anybody calling a
 * bet out of position) and is first to act on the next one. Since 2026-09-07
 * the engine arms that turn 500ms after the street is dealt (streetSettleMs),
 * so its snapshot and its turn_change both land inside the window and both
 * were withheld. Nothing else is published until the clock runs out, so the
 * player sat with no action bar, no clock and no way to act, and was timed out.
 *
 * Captured from the real engine code (seat 2 calls the flop bet at +2624ms):
 *
 *   +2625  SNAPSHOT  flop  actor=seat 2  context flop:5:2:10  clock 2423
 *   +2626  SNAPSHOT  turn  actor=seat 2  context turn:5:2:0   clock 2423
 *   +3126  SNAPSHOT  turn  actor=seat 2  context turn:5:2:0   clock 3126  <- the turn
 *   +3126  EVENT turn_change seat 2      context turn:5:2:0
 *
 * Production, week of 2026-09-28, every human decision taken by a seat that
 * had just closed the previous street: 27 turns, median 37.7s, 85% past 14s,
 * 67% force-resolved by the engine. The same seats, first to act on a new
 * street after SOMEBODY ELSE closed it: 48 turns, median 3.8s, 2% past 14s,
 * none forced. The match that prompted this: eight such turns for the
 * opponent's seat, every one of them 15.9s or longer, three forced; and one
 * for the owner's own seat at a second table, also forced.
 *
 * WHAT IT JUDGES NOW. The decision, not the seat and the clock:
 *
 *   - a frame carrying the decision the hero ALREADY ANSWERED (the engine's
 *     own action_context, which changes with every accepted action) is stale,
 *     and is withheld exactly as before;
 *   - the engine's discrete turn_change for this seat with a DIFFERENT
 *     decision is a new turn, and is handed over at once. The engine emits
 *     that event only after it has armed the turn;
 *   - a snapshot is a new turn when it carries a different decision AND a turn
 *     clock newer than one already seen on a withheld frame. The frames the
 *     engine publishes while it is still between turns keep the previous
 *     turn's clock; the armed turn stamps a new one. Compared engine clock to
 *     engine clock, so no device time is involved;
 *   - whatever is still withheld when the window closes is delivered then
 *     (releaseExpiredFence), unless the engine's last word was that there is
 *     no betting decision at all (a showdown) or only the answered one;
 *   - a folded seat is offered nothing: not by a frame that shows it folded,
 *     and not by the release onto a page that does (shouldHandBackTurn).
 *
 * Pure, so the rule can be exercised against the engine's real frame order
 * without mounting a table: tests/unit/heroActedFence.test.ts.
 */

/** How long a frame may be withheld from the seat that just acted. */
export const HERO_ACTED_FENCE_MS = 1500;

/**
 * Margin added to the release timer so it never fires before `until`. A
 * browser timer can fire late, never early, but the two instants are read on
 * the same clock a few statements apart and this keeps the order certain.
 */
export const HERO_ACTED_FENCE_RELEASE_MARGIN_MS = 30;

export interface HeroActedFence {
  /** Hand the answered decision belongs to. A new hand ends the fence. */
  hand: number;
  /** The seat that acted. */
  seat: number;
  /** Wall-clock ms. At or past this instant the fence withholds nothing. */
  until: number;
  /**
   * The engine's action_context for the decision the hero answered, or null
   * when the page held none (an engine build that does not publish it).
   */
  decision: string | null;
  /**
   * turn_start_time_ms the hero's own panel was running on (engine clock), or
   * 0 when unknown. Read only when the window closes.
   */
  clockAtAct: number;
  /** Highest engine turn clock seen on a withheld frame; null until one is. */
  seenClock: number | null;
  /**
   * Set while the LATEST withheld frame offered this seat a betting decision
   * other than the answered one. `clock` is that frame's turn clock, or null
   * when the frame carried none.
   */
  pending: { clock: number | null } | null;
}

/** A snapshot, reduced to what the fence reads. */
export interface FenceSnapshotFrame {
  /** Hand number the frame belongs to (the page's own when the frame has none). */
  hand: number | undefined;
  /** Seat the engine names as the actor; 0 when it names nobody. */
  actorSeat: number;
  /** The frame's action_context. Absent or null: no betting decision. */
  decision?: string | null;
  /** The frame's turn_start_time_ms (engine clock). */
  clock?: number | null;
  /**
   * The frame itself shows the named seat as folded. The engine goes on
   * naming a seat whose fold ended the hand, with a betting context, until it
   * deals the next one; a folded seat has no decision whatever that says.
   */
  actorFolded?: boolean;
}

/** A discrete turn_change event, reduced to what the fence reads. */
export interface FenceTurnChange {
  hand: number | undefined;
  /** Seat the engine put on the clock. */
  seat: number;
  /** The hero's seat on this page. */
  heroSeat: number;
  /** The event's action_context. */
  decision?: string | null;
}

function knownDecision(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function knownClock(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The hero acted while holding the turn: start withholding stale frames. */
export function armHeroActedFence(args: {
  hand: number;
  seat: number;
  /** action_context of the decision being answered. */
  decision?: string | null;
  /** turn_start_time_ms the panel was running on. */
  clockAtAct?: number | null;
  /** Wall-clock ms the hero acted. */
  now: number;
}): HeroActedFence {
  return {
    hand: args.hand,
    seat: args.seat,
    until: args.now + HERO_ACTED_FENCE_MS,
    decision: knownDecision(args.decision),
    clockAtAct: knownClock(args.clockAtAct) ?? 0,
    seenClock: null,
    pending: null,
  };
}

/**
 * Judge an authoritative snapshot.
 *
 * Returns the seat the page should show as the actor (0 = withheld) and the
 * fence as it stands afterwards. Applying the same frame twice gives the same
 * answer, which a React state updater requires.
 */
export function judgeSnapshotAgainstFence(
  fence: HeroActedFence | null,
  frame: FenceSnapshotFrame,
  now: number
): { currentPlayerSeat: number; fence: HeroActedFence | null } {
  if (!fence) return { currentPlayerSeat: frame.actorSeat, fence: null };
  // A new hand, or the window has closed: never sticky.
  if (fence.hand !== frame.hand || now >= fence.until) {
    return { currentPlayerSeat: frame.actorSeat, fence: null };
  }
  // The engine names somebody else, or nobody: it has moved on. Job done.
  if (frame.actorSeat !== fence.seat) {
    return { currentPlayerSeat: frame.actorSeat, fence: null };
  }

  // A seat the frame shows as folded is offered nothing, whatever it carries.
  const decision = frame.actorFolded ? null : knownDecision(frame.decision);
  const clock = knownClock(frame.clock);
  const otherDecision = decision !== null && decision !== fence.decision;

  // A different decision on a clock the engine stamped AFTER a frame already
  // withheld: the engine has armed a new turn for this seat. Hand it over.
  if (otherDecision && fence.seenClock !== null && clock !== null && clock > fence.seenClock) {
    return { currentPlayerSeat: frame.actorSeat, fence: null };
  }

  const seenClock = clock === null ? fence.seenClock : Math.max(fence.seenClock ?? clock, clock);
  return {
    currentPlayerSeat: 0,
    fence: { ...fence, seenClock, pending: otherDecision ? { clock } : null },
  };
}

/**
 * Judge the engine's discrete turn_change.
 *
 * `accept` false means the event describes the decision the hero already
 * answered (or cannot say which decision it describes) and must not put the
 * bar back.
 */
export function judgeTurnChangeAgainstFence(
  fence: HeroActedFence | null,
  evt: FenceTurnChange,
  now: number
): { accept: boolean; fence: HeroActedFence | null } {
  if (!fence) return { accept: true, fence: null };
  const guarded =
    fence.seat === evt.seat &&
    evt.seat === evt.heroSeat &&
    fence.hand === evt.hand &&
    now < fence.until;
  if (!guarded) return { accept: true, fence };

  const decision = knownDecision(evt.decision);
  // The engine emits turn_change only after arming the turn, and a decision
  // other than the answered one cannot be the answered one arriving late.
  if (decision !== null && decision !== fence.decision) return { accept: true, fence: null };
  if (decision === null) {
    // An event that cannot say which decision it is: withheld, and delivered
    // when the window closes rather than lost.
    return { accept: false, fence: { ...fence, pending: fence.pending ?? { clock: null } } };
  }
  return { accept: false, fence };
}

/**
 * The window has closed. Say whether a withheld turn must be delivered now.
 *
 * `handBackSeat` is the seat to put on the clock, or null when there is
 * nothing to deliver. A fence that has not yet reached `until` is returned
 * untouched: it belongs to a later action and has a timer of its own.
 */
export function releaseExpiredFence(
  fence: HeroActedFence | null,
  now: number
): { handBackSeat: number | null; hand: number | null; fence: HeroActedFence | null } {
  if (!fence) return { handBackSeat: null, hand: null, fence: null };
  if (now < fence.until) return { handBackSeat: null, hand: null, fence };
  const pending = fence.pending;
  // Deliver a withheld decision that is on a newer clock than the one the hero
  // acted on, or whose clock the frame did not say. A frame still on the old
  // clock is the engine between turns: its next frame arrives unfenced.
  if (pending && (pending.clock === null || pending.clock > fence.clockAtAct)) {
    return { handBackSeat: fence.seat, hand: fence.hand, fence: null };
  }
  return { handBackSeat: null, hand: null, fence: null };
}

/** The page's own state at the instant a withheld turn would be delivered. */
export interface HandBackPageState {
  /** Seat the page shows on the clock; 0 when it shows nobody. */
  currentPlayerSeat: number;
  heroSeat: number;
  hand: number | undefined;
  /** The page's view of the hero's seat. A folded seat has no decision left. */
  heroFolded: boolean;
}

/**
 * May the turn `releaseExpiredFence` wants delivered be put on the clock?
 *
 * Only onto a table that is still waiting for it: the same hand, the same
 * hero seat, nobody shown as the actor, and a hero who is still in the hand.
 * The last clause matters when a FOLD ends the hand: the engine keeps naming
 * the folder, with a betting context, until it starts the next hand (captured
 * 2026-10-04: `preflop:2:2:15` published twice after seat 2 folded heads-up),
 * and a clock the page never saw must not turn that into an action bar for a
 * player who has folded.
 */
export function shouldHandBackTurn(
  release: { handBackSeat: number | null; hand: number | null },
  page: HandBackPageState
): boolean {
  return (
    release.handBackSeat !== null &&
    page.currentPlayerSeat === 0 &&
    page.heroSeat === release.handBackSeat &&
    (page.hand ?? 0) === release.hand &&
    !page.heroFolded
  );
}

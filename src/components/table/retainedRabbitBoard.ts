/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RABBIT REVEAL PAINTS ON A RETAINED BOARD, NOT A FROZEN TABLE (P1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-05. Until today a Rabbit Hunt reveal did this in TablePage:
 *
 *     setRabbitHuntFreezeEnd(Date.now() + 3000);
 *
 * and every engine snapshot and event for the next three seconds was parked
 * in a queue and replayed afterwards, 50ms apart. The point was to keep the
 * finished board (and the ghost cards painted over it) on screen for three
 * seconds even if the next hand started underneath. The cost was that the
 * WHOLE table stopped: seats, blinds, the deal, the hero's own action prompt
 * and its clock. The engine's turn timer does not wait for a client, so a
 * player who rabbit-hunted late into the inter-hand rest could be on the
 * clock for up to three seconds before their screen said so, and the replay
 * afterwards fired events in a burst nobody had designed for.
 *
 * Now the reveal keeps its own copy of the board it was bought against - the
 * cards, the stage, the ghost cards - and the felt renders THAT copy in the
 * community-card area while the live hand has nothing to put there. Nothing
 * is frozen: seats, action, timers and events flow as they always did. The
 * copy yields the instant a newer hand exists (2026-09-07: it used to wait
 * for that hand's flop - see retainedBoardShows), and expires on its own
 * after RABBIT_REVEAL_MIN_VISIBLE_MS regardless.
 *
 * A pure module, so the rule that decides which board the felt shows can be
 * pinned without rendering the 24,000-line page.
 */
import type { Card } from './CardImage';
import type { BoardStage } from './CommunityCards';

/**
 * How long a reveal is guaranteed on screen from the moment it lands, across
 * a hand boundary if one arrives. The same three seconds the freeze used to
 * buy; the difference is what else those seconds cost.
 */
export const RABBIT_REVEAL_MIN_VISIBLE_MS = 3000;

export interface RetainedRabbitBoard {
  /** The hand the reveal was bought for. */
  readonly handNumber: number;
  /** The board as it stood when that hand ended (empty on a preflop fold). */
  readonly cards: readonly Card[];
  readonly stage: BoardStage;
  /** The cards the server sold, painted into the undealt slots after `cards`. */
  readonly rabbitCards: readonly Card[];
}

export interface LiveBoardFacts {
  readonly handNumber: number;
  readonly cardCount: number;
}

/**
 * Does the felt show the retained copy instead of the live board?
 *
 *   - No retained copy: the live board, obviously.
 *   - A NEWER hand, whatever it holds: the live board, immediately. The
 *     middle of the felt belongs to the hand being played.
 *   - On the finished hand itself, once its board has been cleared: the
 *     retained copy - the cards the reveal was bought against, with the
 *     ghost cards on them. With the board still up, live and retained are the
 *     same picture and the live path (which already paints the ghost cards)
 *     is used so the switch never re-mounts a card.
 *
 * DISPLAY AND MOVE ON (Dan 2026-09-07). Until today this also answered
 * "yes" for a newer hand at preflop, so a reveal that landed late painted
 * the PREVIOUS hand's whole board over the next hand's first street for up
 * to RABBIT_REVEAL_MIN_VISIBLE_MS. With the new hand's hole cards already
 * dealt around it, that read as the next hand not starting - "IF YOU USE
 * RABBIT HUNT ... IT FORCES A DELAY IN THE NEXT HAND, INSTEAD OF IT JUST
 * DISPLAYING AND MOVING ON." The finished board now yields to the next hand
 * the moment that hand exists. What survives across the boundary is only
 * the ghost cards themselves (retainedGhostsShow): drawn in the new hand's
 * empty preflop slots, so a paid reveal that arrived late is still readable,
 * and gone at the flop.
 */
export function retainedBoardShows(
  retained: RetainedRabbitBoard | null,
  live: LiveBoardFacts
): boolean {
  if (!retained) return false;
  if (live.handNumber !== retained.handNumber) return false;
  return live.cardCount === 0;
}

/**
 * Do the retained reveal's ghost cards ride the NEXT hand's empty board?
 * Only while that hand is preflop - a newer hand with cards of its own owns
 * every slot. The retained copy's own expiry timer bounds this as it always
 * did.
 */
export function retainedGhostsShow(
  retained: RetainedRabbitBoard | null,
  live: LiveBoardFacts
): boolean {
  if (!retained) return false;
  if (live.handNumber === retained.handNumber) return false;
  return live.cardCount === 0;
}

export function boardForRabbitReveal(
  lastBoard: { handNumber: number; cards: readonly Card[]; stage: BoardStage } | null,
  rabbitHandNumber: number | null,
  rabbitCards: readonly Card[]
): RetainedRabbitBoard {
  if (lastBoard && (rabbitHandNumber === null || lastBoard.handNumber === rabbitHandNumber)) {
    return {
      handNumber: lastBoard.handNumber,
      cards: lastBoard.cards,
      stage: lastBoard.stage,
      rabbitCards,
    };
  }
  return {
    handNumber: rabbitHandNumber ?? lastBoard?.handNumber ?? 0,
    cards: [],
    stage: 'preflop',
    rabbitCards,
  };
}

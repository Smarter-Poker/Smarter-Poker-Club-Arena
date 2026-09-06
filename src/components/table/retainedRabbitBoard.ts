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
 * copy yields the instant a newer hand has cards of its own, and expires on
 * its own after RABBIT_REVEAL_MIN_VISIBLE_MS regardless.
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
 *   - A NEWER hand already has community cards: the live board, immediately.
 *     The middle of the felt belongs to the hand being played.
 *   - Otherwise, whenever the live board has nothing to show (the next hand
 *     is preflop, or the finished hand's board has been cleared) or the hand
 *     number has moved on: the retained copy. On the finished hand itself,
 *     with its board still up, live and retained are the same picture and
 *     the live path (which already paints the ghost cards) is used so the
 *     switch never re-mounts a card.
 */
export function retainedBoardShows(
  retained: RetainedRabbitBoard | null,
  live: LiveBoardFacts
): boolean {
  if (!retained) return false;
  const newerHand = live.handNumber !== retained.handNumber;
  if (newerHand && live.cardCount > 0) return false;
  return newerHand || live.cardCount === 0;
}

/**
 * The board a reveal is painted against. The felt remembers the last board
 * it showed for each hand; a reveal bought for that hand paints on it. A
 * reveal for a hand whose board was never non-empty (a preflop fold) paints
 * on an empty board at preflop, which is exactly what that hand looked like.
 */
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

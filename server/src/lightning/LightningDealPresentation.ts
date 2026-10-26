/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LIGHTNING TURN CLOCK STARTS WHEN THE DEAL HAS BEEN SHOWN (2026-10-26)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23: "before any single hand is started there MUST BE a deal
 * animation ... Only after all cards are dealt out does the action start."
 * The client keeps that promise by holding the action panel from HAND_STARTED
 * until its deal has played (TablePage beginDealHold -> DealAnimation
 * onComplete, with a 2600 ms ceiling): first the dealer button's glide
 * (HAND_COMPLETION.BUTTON_MOVE_MS), then two cards to every dealt seat.
 *
 * The Lightning host started the first actor's clock 400 ms after the deal
 * (the physical turn settle), so the first player to act lost the rest of
 * that presentation - about 1.5 s of a 15 s clock - to buttons they could not
 * press. By the client's own arithmetic a 6-max hand is 700 ms of button and
 * 1300 ms of deal (12 cards, 80 ms apart, a 320 ms flight, 100 ms rest).
 *
 * This is the presentation's length on the ENGINE clock, computed from the
 * same numbers the client uses (DealAnimation.tsx at animation speed 1,
 * desktop flight; a phone's flight is shorter, so this never cuts one short),
 * and bounded by the client's own ceiling. A law test reads the client source
 * and fails if either side moves without the other.
 *
 * Every dealt seat counts, horse or human, and every player's clock waits the
 * same: a horse's decision is scheduled from its turn, so it waits too
 * (CLAUDE.md 10.5: timing is part of the treatment).
 */
import { HAND_COMPLETION } from '../config/handCompletionSpec.js';

/** DealAnimation.tsx CARD_STAGGER_MS: the gap between two dealt cards. */
export const LIGHTNING_DEAL_CARD_STAGGER_MS = 80;
/** DealAnimation.tsx MIN_CARD_STAGGER_MS: the stagger never compresses below this. */
export const LIGHTNING_DEAL_MIN_CARD_STAGGER_MS = 60;
/** DealAnimation.tsx flightDurationMs() desktop base: one card's flight. */
export const LIGHTNING_DEAL_FLIGHT_MS = 320;
/** DealAnimation.tsx SETTLE_BUFFER_MS: the rest after the last card lands. */
export const LIGHTNING_DEAL_SETTLE_MS = 100;
/** DealAnimation.tsx MAX_DEAL_MS: the deal is compressed to fit inside this. */
export const LIGHTNING_DEAL_MAX_MS = 1500;
/** TablePage beginDealHold: the action panel is released by this at the latest. */
export const LIGHTNING_DEAL_HOLD_CEILING_MS = 2600;
/** DealAnimation deals two cards to every dealt seat, whatever the variant. */
export const LIGHTNING_DEAL_CARDS_PER_SEAT = 2;

/**
 * How long after HAND_STARTED the client's action panel stays held for the
 * deal: the button's glide, then the deal, at animation speed 1, never past
 * the client's ceiling.
 */
export function lightningDealPresentationMs(dealtSeats: number): number {
  const seats = Math.max(1, Math.floor(Number(dealtSeats) || 0));
  const cards = seats * LIGHTNING_DEAL_CARDS_PER_SEAT;
  const room = Math.max(
    0,
    LIGHTNING_DEAL_MAX_MS - LIGHTNING_DEAL_FLIGHT_MS - LIGHTNING_DEAL_SETTLE_MS
  );
  const fit = cards > 1 ? Math.floor(room / (cards - 1)) : LIGHTNING_DEAL_CARD_STAGGER_MS;
  const stagger = Math.max(
    LIGHTNING_DEAL_MIN_CARD_STAGGER_MS,
    Math.min(LIGHTNING_DEAL_CARD_STAGGER_MS, fit)
  );
  const deal = (cards - 1) * stagger + LIGHTNING_DEAL_FLIGHT_MS + LIGHTNING_DEAL_SETTLE_MS;
  return Math.min(LIGHTNING_DEAL_HOLD_CEILING_MS, HAND_COMPLETION.BUTTON_MOVE_MS + deal);
}

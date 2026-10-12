import type { HorseGameStateV2 } from '../HorseLogic.js';
import { plo4BlindSeatsStatus } from '../plo4/Plo4LivePolicy.js';

/**
 * P13.1: the seat the controller asks first in a preflop betting round, read
 * the way HandController.setNextPlayer reads it.
 *
 * Heads-up the button posts the small blind and acts first. Otherwise the
 * first actor is the next dealt seat after the BIG BLIND the engine posted
 * (`blindSeats`, recorded by HandController.postBlinds), and with the table's
 * single UTG straddle the next dealt seat after the straddler. The big blind
 * is never inferred from the button: under the tournament dead-button rule
 * (TDA Rule 30, deadButton.ts) the small blind can be DEAD, so the first
 * dealt seat after the button is the big blind itself, and a dealer offset of
 * two seats lands one seat late (the P12.1 defect 2 class).
 *
 * A table the engine was not told blinds for (every cash table) has them
 * walked by the controller from the button: the next dealt seat is the small
 * blind and the one after it the big blind. A tournament hand is always told
 * its blinds, so a tournament state without them is refused rather than
 * walked, and blind seats the engine could not have posted with this button
 * and census are refused as malformed.
 */
export function jointPreflopFirstSeat(state: HorseGameStateV2, dealtSeats: number[]): number {
  const ids = [...dealtSeats].sort((a, b) => a - b);
  const dealer = state.dealerSeat;
  if (!Number.isInteger(dealer) || dealer! < 1 || dealer! > 10)
    throw new Error('joint_action_missing_button');
  const after = (seat: number) => ids.find((s) => s > seat) ?? ids[0];
  if (ids.length === 2) {
    if (!ids.includes(dealer!)) throw new Error('joint_action_heads_up_button_not_dealt');
    return dealer!;
  }
  const tournament = state.gameMode === 'tournament';
  let bigBlind: number;
  const status = plo4BlindSeatsStatus(dealer, ids, state.blindSeats, tournament);
  if (status === 'valid') bigBlind = state.blindSeats!.bigBlind;
  else if (status === 'invalid') throw new Error('joint_action_blind_seats_invalid');
  else if (tournament) throw new Error('joint_action_blind_seats_unavailable');
  else {
    if (!ids.includes(dealer!)) throw new Error('joint_action_blind_seats_invalid');
    bigBlind = after(after(dealer!));
  }
  const first = after(bigBlind);
  return state.straddleActive ? after(first) : first;
}

/** The dealt seats in the controller's action order for the current street:
 * preflop from `jointPreflopFirstSeat`, every later street (and a bomb hand,
 * which has no preflop round) from the first dealt seat clockwise of the
 * button, an empty dead-button seat included. Folded and all-in seats keep
 * their place; they simply owe nothing. */
export function jointStreetOrder(state: HorseGameStateV2, dealtSeats: number[]): number[] {
  const ids = [...dealtSeats].sort((a, b) => a - b);
  const dealer = state.dealerSeat;
  if (!Number.isInteger(dealer) || dealer! < 1 || dealer! > 10)
    throw new Error('joint_action_missing_button');
  const clockwise = [...ids.filter((s) => s > dealer!), ...ids.filter((s) => s <= dealer!)];
  const first =
    state.stage === 'preflop' && !state.bombPot
      ? clockwise.indexOf(jointPreflopFirstSeat(state, ids))
      : 0;
  return [...clockwise.slice(first), ...clockwise.slice(0, first)];
}

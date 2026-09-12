/**
 * A shallow, declared opponent-policy rollout, not an equilibrium solution.
 * Each later street permits one opening wager and fold/call responses. Every
 * actor uses only its own sampled hand strength on that street's public board;
 * showdown scores are never an input to an action. The caller owns all copies.
 */
import type { HandStage, SeatPlayer } from '../types.js';
import { calculateContestablePot } from './PokerEngine.js';

export interface TournamentContinuationStreet {
  street: 'flop' | 'turn' | 'river';
  heroStrength: number;
  opponentStrength: number[];
}
export interface TournamentContinuationConfig {
  heroId: string;
  dealerSeat: number;
  bigBlind: number;
  currentStreet: HandStage;
  heroChecked: boolean;
  opponentIds: string[];
  sampleIndex: number;
  streets: TournamentContinuationStreet[];
}
export const CONTINUATION_POLICY = {
  version: 'one-wager-per-street-v1',
  maxStreets: 3,
  maxSeats: 10,
  maxOutcomeSamples: 32,
  valueStrength: 0.6,
  wagerPotFraction: 0.5,
  strengthModel: 'own-board-contact-v1',
  noContactCeiling: 0.2,
  pairFloor: 0.45,
  pairPreflopWeight: 0.15,
  twoPairFloor: 0.6,
  categoryStep: 0.06,
  strengthCeiling: 0.98,
} as const;

/** Stated rollout population, not an equity estimator or solver reference. */
export function continuationStrength(contactCategory: number, preflopStrength: number): number {
  if (
    !Number.isInteger(contactCategory) ||
    contactCategory < 1 ||
    contactCategory > 10 ||
    !Number.isFinite(preflopStrength) ||
    preflopStrength < 0 ||
    preflopStrength > 1
  )
    return NaN;
  if (contactCategory === 1) return preflopStrength * CONTINUATION_POLICY.noContactCeiling;
  if (contactCategory === 2)
    return CONTINUATION_POLICY.pairFloor + preflopStrength * CONTINUATION_POLICY.pairPreflopWeight;
  return Math.min(
    CONTINUATION_POLICY.strengthCeiling,
    CONTINUATION_POLICY.twoPairFloor + (contactCategory - 3) * CONTINUATION_POLICY.categoryStep
  );
}

export function simulateTournamentContinuation(
  players: SeatPlayer[],
  config: TournamentContinuationConfig,
  commit: (player: SeatPlayer, amount: number) => void
): boolean {
  if (
    players.length > CONTINUATION_POLICY.maxSeats ||
    config.streets.length > CONTINUATION_POLICY.maxStreets ||
    !(config.bigBlind > 0) ||
    !Number.isFinite(config.bigBlind)
  )
    return false;
  const ordered = players
    .filter((p) => !p.is_sitting_out)
    .slice()
    .sort((a, b) => a.seat - b.seat);
  const button = ordered.findIndex((p) => p.seat === config.dealerSeat);
  const hero = ordered.find((p) => p.user_id === config.heroId);
  if (button < 0 || !hero) return false;
  const streetOrder = ['flop', 'turn', 'river'];
  let previous = streetOrder.indexOf(config.currentStreet) - 1;
  for (const street of config.streets) {
    const index = streetOrder.indexOf(street.street);
    if (index <= previous || index < streetOrder.indexOf(config.currentStreet)) return false;
    previous = index;
  }
  const order = ordered.slice(button + 1).concat(ordered.slice(0, button + 1));
  for (const street of config.streets) {
    const isCurrent = street.street === config.currentStreet;
    if (isCurrent && !config.heroChecked) continue;
    if (
      ![street.heroStrength, ...street.opponentStrength].every(
        (v) => Number.isFinite(v) && v >= 0 && v <= 1
      ) ||
      street.opponentStrength.length !== config.opponentIds.length
    )
      return false;
    const live = order.filter((p) => !p.is_folded);
    if (live.length <= 1 || live.filter((p) => !p.is_all_in).length <= 1) break;
    if (!isCurrent) for (const player of players) player.bet = 0;
    const strength = (player: SeatPlayer): number =>
      player.user_id === config.heroId
        ? street.heroStrength
        : (street.opponentStrength[config.opponentIds.indexOf(player.user_id)] ?? 0);
    // The checked-to continuation starts strictly after hero. A future street
    // starts after the dealer. Never grant hero a second opening action.
    const actors = isCurrent ? live.slice(live.indexOf(hero) + 1) : live;
    const bettor = actors.find(
      (p) => !p.is_all_in && strength(p) >= CONTINUATION_POLICY.valueStrength
    );
    if (!bettor) continue;
    const pot = players.reduce((sum, p) => sum + p.totalInvested, 0);
    const wager = Math.min(
      bettor.stack,
      Math.max(config.bigBlind, Math.round(pot * CONTINUATION_POLICY.wagerPotFraction))
    );
    commit(bettor, wager);
    const target = bettor.bet;
    const bettorIndex = live.indexOf(bettor);
    const responders = live.slice(bettorIndex + 1).concat(live.slice(0, bettorIndex));
    for (const player of responders) {
      if (player.is_all_in || player.is_folded) continue;
      const call = Math.min(player.stack, Math.max(0, target - player.bet));
      if (call <= 0) continue;
      const facingPot = calculateContestablePot(players, player.user_id, call);
      // This is the rollout population's stated response rule, not a claim
      // that a category score is calibrated range equity.
      const required = call / (facingPot + call);
      if (strength(player) < required) player.is_folded = true;
      else commit(player, call);
    }
  }
  return true;
}

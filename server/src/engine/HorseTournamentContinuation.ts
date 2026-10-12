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
  version: 'one-wager-per-street-v2',
  sittingOut: 'check-free-fold-facing-wager',
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

const STREET_ORDER: readonly string[] = ['flop', 'turn', 'river'];
const streetIndex = (street: string): number => STREET_ORDER.indexOf(street);
const validStrength = (v: number): boolean => Number.isFinite(v) && v >= 0 && v <= 1;

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
  // A sitting-out dealer still determines order. Such seats never make a
  // voluntary wager, but a forced all-in keeps its showdown eligibility.
  // Seat order is a stable sort; a caller copy already in seat order (every
  // future hand) is that order, so it is read in place rather than copied.
  let ordered = players;
  for (let i = 1; i < players.length; i++)
    if (players[i - 1].seat > players[i].seat) {
      ordered = players.slice().sort((a, b) => a.seat - b.seat);
      break;
    }
  const button = ordered.findIndex((p) => p.seat === config.dealerSeat);
  const hero = ordered.find((p) => p.user_id === config.heroId);
  if (button < 0 || !hero) return false;
  const current = streetIndex(config.currentStreet);
  let previous = current - 1;
  for (const street of config.streets) {
    const index = streetIndex(street.street);
    if (index <= previous || index < current) return false;
    previous = index;
  }
  // Action order starts after the button: one rotated copy, same sequence as
  // ordered.slice(button + 1).concat(ordered.slice(0, button + 1)).
  const seats = ordered.length;
  const order: SeatPlayer[] = new Array(seats);
  for (let k = 0; k < seats; k++) order[k] = ordered[(button + 1 + k) % seats];
  // Per-street live seats in action order, with each seat's own strength on
  // that street (sitting out 0, hero's, or its opponent entry, absent 0).
  const live: SeatPlayer[] = new Array(seats);
  const liveStrength: number[] = new Array(seats);
  for (const street of config.streets) {
    const isCurrent = street.street === config.currentStreet;
    if (isCurrent && !config.heroChecked) continue;
    if (!validStrength(street.heroStrength)) return false;
    for (let i = 0; i < street.opponentStrength.length; i++)
      if (!validStrength(street.opponentStrength[i])) return false;
    if (street.opponentStrength.length !== config.opponentIds.length) return false;
    let liveCount = 0;
    let liveFunded = 0;
    let heroLive = -1;
    for (let k = 0; k < seats; k++) {
      const p = order[k];
      if (p.is_folded) continue;
      if (p === hero) heroLive = liveCount;
      live[liveCount] = p;
      liveStrength[liveCount] = p.is_sitting_out
        ? 0
        : p.user_id === config.heroId
          ? street.heroStrength
          : (street.opponentStrength[config.opponentIds.indexOf(p.user_id)] ?? 0);
      liveCount++;
      if (!p.is_all_in) liveFunded++;
    }
    if (liveCount <= 1 || liveFunded <= 1) break;
    if (!isCurrent) for (const player of players) player.bet = 0;
    // The checked-to continuation starts strictly after hero. A future street
    // starts after the dealer. Never grant hero a second opening action.
    let bettorIndex = -1;
    for (let k = isCurrent ? heroLive + 1 : 0; k < liveCount; k++) {
      if (!live[k].is_all_in && liveStrength[k] >= CONTINUATION_POLICY.valueStrength) {
        bettorIndex = k;
        break;
      }
    }
    if (bettorIndex < 0) continue;
    const bettor = live[bettorIndex];
    let pot = 0;
    for (const p of players) pot += p.totalInvested;
    const wager = Math.min(
      bettor.stack,
      Math.max(config.bigBlind, Math.round(pot * CONTINUATION_POLICY.wagerPotFraction))
    );
    commit(bettor, wager);
    const target = bettor.bet;
    // Responders follow the bettor clockwise: live[bettor + 1 ...], live[... bettor - 1].
    for (let k = 1; k < liveCount; k++) {
      const responder = (bettorIndex + k) % liveCount;
      const player = live[responder];
      if (player.is_all_in || player.is_folded) continue;
      const call = Math.min(player.stack, Math.max(0, target - player.bet));
      if (call <= 0) continue;
      const facingPot = calculateContestablePot(players, player.user_id, call);
      // This is the rollout population's stated response rule, not a claim
      // that a category score is calibrated range equity.
      const required = call / (facingPot + call);
      if (liveStrength[responder] < required) player.is_folded = true;
      else commit(player, call);
    }
  }
  return true;
}

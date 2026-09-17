/** Bounded public-state projections. These do not pretend to solve future betting. */
import type { HorseGameStateV2 } from './HorseLogic.js';
import type { SeatPlayer } from '../types.js';
import { buildTournamentMState } from './HorseTournamentPreflop.js';

export const FUTURE_GAME_MAX_SEATS = 10;
export const FUTURE_GAME_MAX_HANDS = 2;

export interface TournamentFutureGame {
  model: 'forced-orbit-envelope-v2';
  available: boolean;
  unavailableReason: string | null;
  /** No recorded hand duration means level timing has two explicit bounds. */
  levelTiming: 'current_and_next_level_envelope' | 'current_level_only';
  tableBreak: 'unavailable';
  handsUntilBigBlind: number | null;
  currentOrbitCost: number | null;
  nextOrbitCost: number | null;
  projectedM: number | null;
  velocityMPerMinute: number | null;
  minimumRetainedStack: number | null;
  maximumRetainedStack: number | null;
  retainedReshoveBb: [number, number] | null;
  /** Blind timing uncertainty is an envelope, not an invented transition probability. */
  nextLevelInMinutes: number | null;
  shortStacksBehind: number;
  coveredStacks: number;
  coveringStacks: number;
  /** Number of public stack/forced-bet transitions, never a solver sample count. */
  transitions: number;
  resolvesPostflopContinuation: false;
}

export function projectTournamentFutureGame(
  hero: SeatPlayer,
  gs: HorseGameStateV2,
  investment: number
): TournamentFutureGame {
  const result: TournamentFutureGame = {
    model: 'forced-orbit-envelope-v2',
    available: false,
    unavailableReason: null,
    levelTiming: 'current_level_only',
    tableBreak: 'unavailable',
    handsUntilBigBlind: null,
    currentOrbitCost: null,
    nextOrbitCost: null,
    projectedM: null,
    velocityMPerMinute: null,
    minimumRetainedStack: null,
    maximumRetainedStack: null,
    shortStacksBehind: 0,
    coveredStacks: 0,
    retainedReshoveBb: null,
    nextLevelInMinutes: null,
    coveringStacks: 0,
    transitions: 0,
    resolvesPostflopContinuation: false,
  };
  const fail = (reason: string): TournamentFutureGame => ({ ...result, unavailableReason: reason });
  const t = gs.tournament;
  if (t?.schemaVersion !== 1 || t.contextStatus !== 'complete') return fail('context_incomplete');
  // Tournament sit-outs are still dealt in and pay forced money. Preserve
  // their place in the ring, just as the Phase 6 M owner does.
  const seats = gs.players.slice().sort((a, b) => a.seat - b.seat);
  if (
    seats.length < 2 ||
    seats.length > FUTURE_GAME_MAX_SEATS ||
    new Set(seats.map((p) => p.seat)).size !== seats.length ||
    seats.some((p) => !Number.isFinite(p.stack) || p.stack < 0)
  )
    return fail('invalid_seats');
  const heroIndex = seats.findIndex((p) => p.user_id === hero.user_id);
  const button = seats.findIndex((p) => p.seat === gs.dealerSeat);
  if (heroIndex < 0 || button < 0) return fail('position_unavailable');
  if (
    ![hero.stack, investment, t.currentSmallBlind, t.currentBigBlind, t.currentAnte].every(
      (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
    ) ||
    investment > hero.stack ||
    !(t.currentBigBlind! > 0)
  )
    return fail('invalid_geometry');
  if (!['none', 'per_player', 'big_blind'].includes(t.anteType ?? ''))
    return fail('ante_unavailable');
  const remaining = hero.stack - investment;
  const m = buildTournamentMState({
    stackChips: remaining,
    smallBlind: t.currentSmallBlind!,
    bigBlind: t.currentBigBlind!,
    ante: t.currentAnte!,
    anteType: t.anteType!,
    playersAtTable: seats.length,
    nextSmallBlind: t.nextSmallBlind,
    nextBigBlind: t.nextBigBlind,
    nextAnte: t.nextAnte,
    minutesToNextLevel: t.nextBlindInMin,
  });
  result.currentOrbitCost = m.orbitCostChips;
  result.nextOrbitCost = m.projectedOrbitCostChips;
  result.projectedM = m.projectedM;
  result.nextLevelInMinutes =
    typeof t.nextBlindInMin === 'number' &&
    Number.isFinite(t.nextBlindInMin) &&
    t.nextBlindInMin >= 0
      ? t.nextBlindInMin
      : null;
  const nextKnown =
    [t.nextSmallBlind, t.nextBigBlind, t.nextAnte].every(
      (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
    ) && t.nextBigBlind! > 0;
  result.levelTiming = nextKnown ? 'current_and_next_level_envelope' : 'current_level_only';
  result.velocityMPerMinute =
    nextKnown && result.nextLevelInMinutes !== null && result.nextLevelInMinutes > 0
      ? m.velocityMPerMinute
      : null;
  const horizons = nextKnown
    ? [
        [t.currentSmallBlind!, t.currentBigBlind!, t.currentAnte!],
        [t.nextSmallBlind!, t.nextBigBlind!, t.nextAnte!],
      ]
    : [[t.currentSmallBlind!, t.currentBigBlind!, t.currentAnte!]];
  const retained: number[] = [];
  for (const [sb, bb, ante] of horizons) {
    let stack = remaining;
    for (let hand = 1; hand <= FUTURE_GAME_MAX_HANDS; hand++) {
      const nextButton = (button + hand) % seats.length;
      const sbIndex = seats.length === 2 ? nextButton : (nextButton + 1) % seats.length;
      const bbIndex = (sbIndex + 1) % seats.length;
      const anteDue =
        t.anteType === 'per_player'
          ? ante
          : t.anteType === 'big_blind' && heroIndex === bbIndex
            ? m.orbitCostChips - t.currentSmallBlind! - t.currentBigBlind!
            : 0;
      // Scale BBA through the same M engine for each explicit level.
      const costM = buildTournamentMState({
        stackChips: stack,
        smallBlind: sb,
        bigBlind: bb,
        ante,
        anteType: t.anteType!,
        playersAtTable: seats.length,
      });
      const forcedAnte =
        t.anteType === 'big_blind' && heroIndex === bbIndex
          ? costM.orbitCostChips - sb - bb
          : anteDue;
      stack = Math.max(
        0,
        stack - forcedAnte - (heroIndex === sbIndex ? sb : 0) - (heroIndex === bbIndex ? bb : 0)
      );
      result.transitions++;
    }
    retained.push(stack);
  }
  for (let hand = 1; hand <= seats.length; hand++) {
    const nextButton = (button + hand) % seats.length;
    const bbIndex = (nextButton + (seats.length === 2 ? 1 : 2)) % seats.length;
    if (bbIndex === heroIndex) {
      result.handsUntilBigBlind = hand;
      break;
    }
  }
  result.minimumRetainedStack = Math.min(...retained);
  result.maximumRetainedStack = Math.max(...retained);
  result.retainedReshoveBb = [
    result.minimumRetainedStack /
      (nextKnown ? Math.max(t.currentBigBlind!, t.nextBigBlind!) : t.currentBigBlind!),
    result.maximumRetainedStack / t.currentBigBlind!,
  ];
  for (const opponent of seats) {
    if (opponent.user_id === hero.user_id) continue;
    if (opponent.stack >= remaining) result.coveringStacks++;
    else result.coveredStacks++;
    // A stack unable to pay one projected orbit is a public collision risk.
    const first = (button + 1) % seats.length;
    const actorOffset = (seats.indexOf(opponent) - first + seats.length) % seats.length;
    const heroOffset = (heroIndex - first + seats.length) % seats.length;
    if (
      actorOffset > heroOffset &&
      !opponent.is_folded &&
      opponent.stack > 0 &&
      opponent.stack <= m.projectedOrbitCostChips
    )
      result.shortStacksBehind++;
  }
  result.available = true;
  return result;
}

import type { Card, HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from '../engine/HorseLogic.js';
import type { OmahaRange } from './OmahaEquityOracle.js';

interface OfflineOmahaPolicyInput {
  hero: SeatPlayer;
  state: HorseGameStateV2;
  baseline: HorseDecision;
  mode?: 'off' | 'shadow' | 'candidate';
  seed: number;
  samples?: number;
  straddleBB?: number;
  opponentRanges?: Record<string, OmahaRange>;
}

const publicSeat = (player: SeatPlayer): SeatPlayer => ({
  seat: player.seat,
  user_id: player.user_id,
  username: player.username,
  stack: player.stack,
  bet: player.bet,
  totalInvested: player.totalInvested,
  returnedUncalled: player.returnedUncalled,
  deadInvested: player.deadInvested,
  individualAnteInvested: player.individualAnteInvested,
  is_folded: player.is_folded,
  is_all_in: player.is_all_in,
  is_sitting_out: player.is_sitting_out,
  // Never spread a seat and then replace cards: spread already reads private
  // accessors, including another player's cards and known discarded card.
  cards: [],
});
// Preserve malformed values for the policy's existing off/refusal path; this
// ownership projection is not a second, more permissive strategy validator.
const cards = (values: Card[]): Card[] =>
  !Array.isArray(values)
    ? values
    : values.map((card) =>
        card && typeof card === 'object' ? { rank: card.rank, suit: card.suit } : card
      );

/** Explicit strategy input projection for the PLO4 and PLO5/6/8 offline
 * adapters. Capture before invoking a callback or awaiting the oracle. Public
 * state, hero cards, baseline action and controls are then owned together.
 *
 * Deliberately excludes execution witnesses, policy receipts, tournament
 * utility, opaque functions and unrelated player/card metadata. These offline
 * adapters cannot authorize tournament execution and do not consume those
 * fields. New strategy inputs must be added here with their ownership law. */
export function captureOfflineOmahaPolicyInput(
  input: OfflineOmahaPolicyInput
): OfflineOmahaPolicyInput {
  const s = input.state;
  const rake = s.rakeConfig;
  const state: HorseGameStateV2 = {
    players: s.players.map(publicSeat),
    communityCards: cards(s.communityCards),
    communityCards2: s.communityCards2 === undefined ? undefined : cards(s.communityCards2),
    communityCards3: s.communityCards3 === undefined ? undefined : cards(s.communityCards3),
    stateSchemaVersion: s.stateSchemaVersion,
    dealtSeatIds: s.dealtSeatIds,
    pot: s.pot,
    currentBet: s.currentBet,
    minRaise: s.minRaise,
    stage: s.stage,
    gameVariant: s.gameVariant,
    bigBlind: s.bigBlind,
    gameMode: s.gameMode,
    dealerSeat: s.dealerSeat,
    heroSeat: s.heroSeat,
    currentPlayerSeat: s.currentPlayerSeat,
    bettingStructure: s.bettingStructure,
    legalActions: s.legalActions,
    toCall: s.toCall,
    minRaiseTo: s.minRaiseTo,
    maxRaiseTo: s.maxRaiseTo,
    ante: s.ante,
    straddleActive: s.straddleActive,
    bombPot: s.bombPot,
    boardCount: s.boardCount,
    actionHistory: s.actionHistory?.map((action) => ({
      seat: action.seat,
      userId: action.userId,
      action: action.action,
      amount: action.amount,
      timestamp: action.timestamp,
      stage: action.stage,
      isFullRaise: action.isFullRaise,
    })),
    rakeConfig:
      rake == null
        ? rake
        : {
            percent: rake.percent,
            cap: rake.cap,
            noFlopNoDrop: rake.noFlopNoDrop,
            playerCountCaps: rake.playerCountCaps?.map(({ players, cap }) => ({ players, cap })),
            timedRake:
              rake.timedRake == null
                ? rake.timedRake
                : { amountPerMinute: rake.timedRake.amountPerMinute },
          },
  };
  return structuredClone({
    hero: { ...publicSeat(input.hero), cards: cards(input.hero.cards) },
    state,
    baseline: {
      action: input.baseline.action,
      ...(input.baseline.amount !== undefined ? { amount: input.baseline.amount } : {}),
      thinkTime: input.baseline.thinkTime,
    },
    mode: input.mode,
    seed: input.seed,
    samples: input.samples,
    straddleBB: input.straddleBB,
    opponentRanges: input.opponentRanges,
  });
}

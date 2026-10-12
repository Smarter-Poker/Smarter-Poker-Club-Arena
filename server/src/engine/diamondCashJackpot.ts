import { detectBBJHit, detectMiniBBJHit } from '../config/RakeConfig.js';
import type {
  DiamondCashJackpotSchedule,
  DiamondJackpotHandFacts,
} from '../domain/diamondCashJackpotSchedule.js';

export interface DiamondJackpotVerdict {
  version: 1;
  kind: 'none' | 'main' | 'mini';
  pot: number;
  dealt: number;
  saw_flop: boolean;
  double_board: boolean;
  variant: string;
  big_blind: number;
  dealt_user_ids: string[];
  loser_user_id?: string;
  winner_user_id?: string;
  loser_hand?: string;
  winner_hand?: string;
}

/** The existing card detectors, with independently published Diamond money gates. */
export function diamondCashJackpotVerdict(input: {
  schedule?: DiamondCashJackpotSchedule | null;
  facts: DiamondJackpotHandFacts;
  bigBlind: number;
  showdown: Parameters<typeof detectBBJHit>[0];
  winnerIds: string[];
  dealtUserIds: string[];
  communityCards: string[];
}): DiamondJackpotVerdict {
  const { schedule, facts } = input;
  const base: DiamondJackpotVerdict = {
    version: 1,
    kind: 'none',
    pot: facts.pot,
    dealt: facts.dealtIn,
    saw_flop: facts.sawFlop,
    double_board: facts.doubleBoard,
    variant: facts.variant,
    big_blind: input.bigBlind,
    dealt_user_ids: input.dealtUserIds,
  };
  if (
    !schedule?.enabled ||
    schedule.drop <= 0 ||
    !facts.sawFlop ||
    facts.doubleBoard ||
    facts.dealtIn < schedule.minDealtIn ||
    facts.pot <= schedule.minPot ||
    !schedule.qualifyingHands[facts.variant] ||
    schedule.excludedVariants.includes(facts.variant)
  )
    return base;
  // A fold ending the hand has no showdown, even after an eligible flop.
  if (input.showdown.length < 2 || input.communityCards.length < 5) return base;
  const board = input.communityCards
    .map((card) => {
      const match = /^(10|[2-9]|[TJQKA])(hearts|diamonds|clubs|spades)$/.exec(card);
      return match ? { rank: match[1], suit: match[2] } : null;
    })
    .filter((card): card is { rank: string; suit: string } => card !== null);
  if (board.length !== 5) throw new Error('diamond_jackpot_showdown_board_unavailable');
  const context = {
    doubleBoard: facts.doubleBoard,
    minimumPot: schedule.minPot,
    minimumDealtIn: schedule.minDealtIn,
  };
  const main = detectBBJHit(
    input.showdown,
    input.winnerIds,
    facts.variant,
    facts.pot,
    input.bigBlind,
    facts.dealtIn,
    input.dealtUserIds,
    board,
    context
  );
  const hit = main.hit
    ? main
    : schedule.miniEnabled
      ? detectMiniBBJHit(
          input.showdown,
          input.winnerIds,
          facts.variant,
          facts.pot,
          input.bigBlind,
          facts.dealtIn,
          input.dealtUserIds,
          { ...context, board }
        )
      : null;
  if (!hit?.hit) return base;
  return {
    ...base,
    kind: main.hit ? 'main' : 'mini',
    loser_user_id: hit.loserUserId,
    winner_user_id: hit.winnerUserId,
    loser_hand: hit.loserHand?.name,
    winner_hand: hit.winnerHand?.name,
  };
}

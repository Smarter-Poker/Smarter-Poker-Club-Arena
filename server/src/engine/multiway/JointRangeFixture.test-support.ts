import type { GameVariant, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import { remainingReferenceDeck } from '../../benchmark/RemainingVariantReference.js';
export function jointFixture(
  variant: GameVariant = 'nlh',
  stage: 'preflop' | 'flop' | 'turn' | 'river' = 'flop',
  boardCount = 2,
  seats = 4
) {
  const rules = horseVariantRulesFor(variant);
  const deck = remainingReferenceDeck(variant === 'short_deck');
  let stream = 13007101;
  for (let i = deck.length - 1; i > 0; i--) {
    stream = (Math.imul(stream, 1664525) + 1013904223) >>> 0;
    const j = stream % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const heroCards = deck.splice(0, rules.holeCardsDealt);
  const dead = variant === 'pineapple' && stage !== 'preflop' ? heroCards.splice(2) : [];
  const size = { preflop: 0, flop: 3, turn: 4, river: 5 }[stage];
  const boards = Array.from({ length: boardCount }, () => deck.splice(0, size));
  const players: SeatPlayer[] = Array.from({ length: seats }, (_, i) => ({
    seat: i + 1,
    user_id: 'p' + i,
    username: 'p' + i,
    cards: [],
    stack: 100,
    bet: 0,
    totalInvested: 5,
    is_folded: i === seats - 1 && seats > 2,
    is_sitting_out: i === seats - 1 && seats > 2,
    is_all_in: false,
  }));
  const hero: SeatPlayer = { ...players[0], cards: heroCards, knownDeadCards: dead };
  const state: HorseGameStateV2 = {
    players,
    dealtSeatIds: players.map((p) => p.seat),
    chipUnit: 0.01,
    asset: 'chips',
    gameVariant: variant,
    stage,
    communityCards: boards[0],
    communityCards2: boards[1] ?? [],
    communityCards3: boards[2] ?? [],
    boardCount,
    bombPot: boardCount > 1,
    pot: seats * 5,
    currentBet: 0,
    minRaise: 2,
    bigBlind: 2,
    gameMode: 'cash',
    actionHistory: [],
    dealerSeat: seats,
  };
  return { hero, state };
}

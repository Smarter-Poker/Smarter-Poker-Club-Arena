import type { GameVariant, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import { remainingReferenceDeck } from '../../benchmark/RemainingVariantReference.js';
import { remainingVariantSpot } from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { bettingStructureFor } from '../BettingStructure.js';
import { calculatePots, calculateContestablePot } from '../PokerEngine.js';
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

export function jointPolicyFixture(
  variant: GameVariant = 'nlh',
  boards = 2,
  mode: 'cash' | 'tournament' = 'cash',
  street: 'preflop' | 'flop' | 'turn' | 'river' = 'flop'
) {
  const { hero, state } = jointFixture(variant, street, boards, 4);
  Object.assign(state, {
    stateSchemaVersion: 1,
    heroSeat: hero.seat,
    currentPlayerSeat: hero.seat,
    toCall: 0,
    legalActions: ['check', 'bet', 'all_in'],
    minRaiseTo: 2,
    maxRaiseTo: 100,
    bettingStructure: bettingStructureFor(variant),
    gameMode: mode,
    format: mode === 'cash' ? 'cash' : 'mtt',
    chipUnit: mode === 'cash' ? 0.01 : 1,
    asset: 'chips',
    rakeConfig: { percent: mode === 'cash' ? 10 : 0, cap: 2, noFlopNoDrop: true },
    bbjConfig: null,
    pots: calculatePots(state.players),
    contestablePot: calculateContestablePot(state.players, hero.user_id, 0),
    variantRules: horseVariantRulesFor(variant),
    fixedBetSize: null,
    wagersCapped: false,
    commitmentCapRemaining: null,
  });
  if (state.bettingStructure === 'pot_limit') {
    state.legalActions = ['check', 'bet'];
    state.maxRaiseTo = 20;
  }
  if (state.bettingStructure === 'fixed_limit') {
    const size = street === 'turn' || street === 'river' ? 4 : 2;
    state.legalActions = ['check', 'bet'];
    state.minRaiseTo = size;
    state.maxRaiseTo = size;
    state.fixedBetSize = size;
  }
  if (mode === 'tournament') {
    state.tournament = {
      ...remainingVariantSpot('flh', street, 4, 'tournament').state.tournament,
      gameVariant: variant,
      playersLeft: 4,
      spotsPaid: 2,
      payoutPct: [65, 35],
      stacks: state.players.map((p) => p.stack + p.totalInvested),
      stackByUser: Object.fromEntries(
        state.players.map((p) => [p.user_id, p.stack + p.totalInvested])
      ),
    };
  }
  state.legalActions!.unshift('fold');
  if (variant === 'pineapple' && street !== 'preflop')
    state.actionHistory!.push({
      userId: hero.user_id,
      seat: hero.seat,
      action: 'discard',
      amount: 0,
      stage: 'pineapple_discard',
      timestamp: 0,
    });
  return { hero, state, baseline: { action: 'check' as const, thinkTime: 1 } };
}
